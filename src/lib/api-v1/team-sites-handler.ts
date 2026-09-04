import { parseApiV1FilterDsl } from "@/lib/api-v1/analytics-overview";
import {
  type TeamSitesQueryDto,
  TeamSitesQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { createApiV1QueryApplicationAdapter } from "@/lib/api-v1/query-application";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { resolveApiV1TimeRange } from "@/lib/api-v1/time-range";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import {
  type FilterDocument,
  isReportingTimeZone,
  parseApiV1FilterDocument,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import type { TeamSitesQueryResult } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const MAX_BODY_BYTES = 64 * 1024;

export interface TeamSitesReaderInput {
  readonly teamId: string;
  readonly allowedSiteIds?: readonly string[];
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly timeZone: string;
  readonly interval?: TeamSitesQueryDto["interval"];
  readonly filters: FilterDocument;
  readonly signal?: AbortSignal;
}

export type TeamSitesReader = (
  input: TeamSitesReaderInput,
) => Promise<TeamSitesQueryResult>;

function response(
  status: number,
  body: unknown,
  requestId = crypto.randomUUID(),
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Request-Id": requestId,
    },
  });
}

function errorResponse(code: keyof typeof apiV1ErrorRegistry) {
  const requestId = crypto.randomUUID();
  const definition = apiV1ErrorRegistry[code];
  return response(
    definition.status,
    {
      error: {
        code,
        message: definition.message,
        retryable: definition.retryable,
      },
      meta: { requestId },
    },
    requestId,
  );
}

function cancelledResponse() {
  const requestId = crypto.randomUUID();
  return response(
    499,
    {
      error: {
        code: "request_cancelled",
        message: "The request was cancelled by the client.",
        retryable: false,
      },
      meta: { requestId },
    },
    requestId,
  );
}

function acceptsJson(request: Request) {
  const accept = request.headers.get("accept");
  if (!accept) return true;
  return accept.split(",").some((part) => {
    const mediaType = part.split(";", 1)[0]?.trim().toLowerCase();
    return (
      mediaType === "application/json" ||
      mediaType === "application/*" ||
      mediaType === "*/*"
    );
  });
}

async function readBody(request: Request): Promise<unknown> {
  return readBoundedJson(request, MAX_BODY_BYTES);
}

function filter(input: TeamSitesQueryDto): FilterDocument | null {
  if (!input.filter) return { version: 1, root: null };
  if (input.filter.type === "dsl") {
    try {
      return parseApiV1FilterDsl(input.filter.expression);
    } catch {
      return null;
    }
  }
  try {
    return parseApiV1FilterDocument({
      version: 1,
      root: input.filter.expression,
    });
  } catch {
    return null;
  }
}

export async function handlePlannedTeamSites(
  request: Request,
  principal: ApiKeyPrincipal,
  providerRegistry: AnalyticsProviderRegistry,
  executionContext: {
    readonly signal?: AbortSignal;
    readonly deadlineMs?: number;
    readonly capturedAtMs?: number;
    readonly now?: () => number;
  } = {},
): Promise<Response> {
  if (request.method !== "POST") {
    const result = errorResponse("method_not_allowed");
    result.headers.set("Allow", "POST");
    return result;
  }
  if (request.headers.has("content-encoding")) {
    return errorResponse("unsupported_media_type");
  }
  if (!principal.scopes.includes("analytics:read")) {
    return errorResponse("missing_scope");
  }
  if ((principal.status ?? "active") !== "active") {
    return errorResponse("missing_scope");
  }
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  ) {
    return errorResponse("unsupported_media_type");
  }
  if (!acceptsJson(request)) return errorResponse("not_acceptable");

  let input: TeamSitesQueryDto;
  try {
    input = TeamSitesQueryDtoSchema.parse(await readBody(request));
  } catch {
    return errorResponse("validation_failed");
  }
  const resolvedTimeRange = resolveApiV1TimeRange(
    input.timeRange,
    executionContext.capturedAtMs ?? Date.now(),
  );
  const startMs = resolvedTimeRange ? Date.parse(resolvedTimeRange.from) : NaN;
  const endExclusiveMs = resolvedTimeRange
    ? Date.parse(resolvedTimeRange.to)
    : NaN;
  const timeZone = resolvedTimeRange?.timeZone ?? "UTC";
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endExclusiveMs) ||
    endExclusiveMs <= startMs ||
    !isReportingTimeZone(timeZone)
  ) {
    return errorResponse("validation_failed");
  }
  const filters = filter(input);
  if (!filters) return errorResponse("validation_failed");
  try {
    const query = {
      teamId: principal.teamId,
      allowedSiteIds:
        principal.siteIds.length > 0 ? principal.siteIds : undefined,
      startMs,
      endExclusiveMs,
      timeZone,
      interval: input.interval,
      filters,
      scopePreference: input.scope ?? "auto",
    };
    const serviceResult = await createApiV1QueryApplicationAdapter().execute<
      TeamSitesReaderInput,
      TeamSitesQueryResult
    >(
      {
        operation: "team.analytics.sites",
        context: teamQueryContext(
          principal.teamId,
          "api-v1",
          principal.siteIds,
        ),
        query,
        providerRegistry,
      },
      {
        signal: executionContext.signal,
        deadlineMs: executionContext.deadlineMs,
        capturedAtMs: executionContext.capturedAtMs,
        now: executionContext.now,
        cost: {
          rangeMs: endExclusiveMs - startMs,
          siteCount: principal.siteIds.length || 1,
          metricCount: 1,
          dimensionCardinality: principal.siteIds.length || 1,
          provider: "d1",
        },
      },
    );
    if (!serviceResult.ok) {
      if (serviceResult.error.kind === "request-cancelled")
        return cancelledResponse();
      if (serviceResult.error.kind === "deadline-exceeded")
        return errorResponse("deadline_exceeded");
      return errorResponse("unsupported_query");
    }
    const result = serviceResult.value;
    if (executionContext.signal?.aborted) return cancelledResponse();
    if (
      typeof executionContext.deadlineMs === "number" &&
      (executionContext.now?.() ?? Date.now()) >= executionContext.deadlineMs
    ) {
      return errorResponse("deadline_exceeded");
    }
    const requestId = crypto.randomUUID();
    return response(
      200,
      {
        data: {
          sites: result.data.sites.map((site) => ({
            siteId: site.siteId,
            name: site.name,
            domain: site.domain,
            publicEnabled: site.publicEnabled,
            publicSlug: site.publicSlug,
            createdAt: site.createdAt,
            updatedAt: site.updatedAt,
            metrics: {
              views: site.metrics.views,
              sessions: site.metrics.sessions,
              visitors: site.metrics.visitors,
              bounces: site.metrics.bounces,
              totalDurationMs: site.metrics.totalDurationMs,
              avgDurationMs:
                site.metrics.sessions > 0
                  ? Math.round(
                      site.metrics.totalDurationMs / site.metrics.sessions,
                    )
                  : 0,
              bounceRate:
                site.metrics.sessions > 0
                  ? site.metrics.bounces / site.metrics.sessions
                  : 0,
              approximateVisitors: result.approximateVisitors,
            },
            ...(site.trend
              ? {
                  trend: site.trend.map((point) => ({
                    timestamp: new Date(point.timestampMs).toISOString(),
                    views: point.views,
                    sessions: point.sessions,
                    visitors: point.visitors,
                    bounces: point.bounces,
                    totalDurationMs: point.totalDurationMs,
                    avgDurationMs:
                      point.sessions > 0
                        ? Math.round(point.totalDurationMs / point.sessions)
                        : 0,
                    bounceRate:
                      point.sessions > 0 ? point.bounces / point.sessions : 0,
                  })),
                }
              : {}),
            lastEventAt:
              site.lastEventAtMs === null
                ? null
                : new Date(site.lastEventAtMs).toISOString(),
          })),
        },
        meta: {
          requestId,
          generatedAt: new Date().toISOString(),
          timeRange: {
            from: new Date(startMs).toISOString(),
            to: new Date(endExclusiveMs).toISOString(),
            timeZone,
          },
          source: result.source,
          accuracy: result.approximateVisitors ? "approximate" : "exact",
          ...(serviceResult.meta?.filterScope
            ? { filterScope: serviceResult.meta.filterScope }
            : {}),
        },
      },
      requestId,
    );
  } catch {
    if (executionContext.signal?.aborted) return cancelledResponse();
    return errorResponse("internal_error");
  }
}
