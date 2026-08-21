import {
  type TeamOverviewQueryDto,
  TeamOverviewQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { exceedsQueryCost } from "@/lib/api-v1/query-cost";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { resolveApiV1TimeRange } from "@/lib/api-v1/time-range";
import { AnalyticsQueryService } from "@/lib/edge/analytics/service";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type { FilterDocument } from "@/lib/edge/query-contract";
import {
  isReportingTimeZone,
  parseApiV1FilterDocument,
  teamQueryContext,
} from "@/lib/edge/query-contract";
import type { TeamOverviewQueryResult } from "@/lib/edge/query-runtime/team-overview";

const MAX_BODY_BYTES = 64 * 1024;

export interface TeamOverviewReaderInput {
  readonly teamId: string;
  readonly allowedSiteIds?: readonly string[];
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly timeZone: string;
  readonly filters: FilterDocument;
  readonly signal?: AbortSignal;
}

export type TeamOverviewReader = (
  input: TeamOverviewReaderInput,
) => Promise<TeamOverviewQueryResult>;

function envelope(requestId: string, data: unknown, meta: object) {
  return { data, meta: { requestId, ...(meta as object) } };
}

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
  const definition = apiV1ErrorRegistry[code];
  const requestId = crypto.randomUUID();
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

function filter(input: TeamOverviewQueryDto): FilterDocument | null {
  if (!input.filter) return { version: 1, root: null };
  try {
    return parseApiV1FilterDocument({
      version: 1,
      root: input.filter.expression,
    });
  } catch {
    return null;
  }
}

export async function handlePlannedTeamOverview(
  request: Request,
  principal: ApiKeyPrincipal,
  reader: TeamOverviewReader,
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
  if (!principal.scopes.includes("analytics:read"))
    return errorResponse("missing_scope");
  if ((principal.status ?? "active") !== "active")
    return errorResponse("missing_scope");
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

  let input: TeamOverviewQueryDto;
  try {
    input = TeamOverviewQueryDtoSchema.parse(await readBody(request));
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
  if (
    exceedsQueryCost({
      rangeMs: endExclusiveMs - startMs,
      siteCount: principal.siteIds.length || 1,
      metricCount: input.metrics?.length ?? 3,
      dimensionCardinality: 1,
      projectionFields: input.metrics?.length ?? 3,
      provider: "d1",
    })
  ) {
    return errorResponse("unsupported_query");
  }
  try {
    const query = {
      teamId: principal.teamId,
      allowedSiteIds:
        principal.siteIds.length > 0 ? principal.siteIds : undefined,
      startMs,
      endExclusiveMs,
      timeZone,
      filters,
    };
    const serviceResult = await new AnalyticsQueryService().execute(
      {
        operation: "team.analytics.overview",
        context: teamQueryContext(
          principal.teamId,
          "api-v1",
          principal.siteIds,
        ),
        query,
        provider: {
          execute: ({ query: providerQuery, execution: providerExecution }) =>
            reader({ ...providerQuery, signal: providerExecution.signal }),
        },
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
    const value = result.data;
    const requestId = crypto.randomUUID();
    return response(
      200,
      envelope(
        requestId,
        {
          views: value.views,
          sessions: value.sessions,
          visitors: value.visitors,
          bounces: value.bounces,
          totalDurationMs: value.totalDurationMs,
          avgDurationMs:
            value.sessions > 0
              ? Math.round(value.totalDurationMs / value.sessions)
              : 0,
          bounceRate: value.sessions > 0 ? value.bounces / value.sessions : 0,
          approximateVisitors: result.approximateVisitors,
        },
        {
          generatedAt: new Date().toISOString(),
          timeRange: {
            from: new Date(startMs).toISOString(),
            to: new Date(endExclusiveMs).toISOString(),
            timeZone,
          },
          source: result.source,
          accuracy: result.approximateVisitors ? "approximate" : "exact",
        },
      ),
      requestId,
    );
  } catch {
    if (executionContext.signal?.aborted) return cancelledResponse();
    return errorResponse("internal_error");
  }
}
