import {
  type TeamBreakdownQueryDto,
  TeamBreakdownQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { createApiV1QueryApplicationAdapter } from "@/lib/api-v1/query-application";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { resolveApiV1TimeRange } from "@/lib/api-v1/time-range";
import type { TypedApplicationProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import {
  type BreakdownResult,
  type FilterDocument,
  isReportingTimeZone,
  parseApiV1FilterDocument,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/contract/catalog";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";

const MAX_BODY_BYTES = 64 * 1024;
const DIMENSIONS = new Set<string>(ANALYTICS_DIMENSIONS);

export interface TeamBreakdownReaderInput {
  readonly teamId: string;
  readonly allowedSiteIds?: readonly string[];
  readonly dimension: string;
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly timeZone: string;
  readonly limit: number;
  readonly filters: FilterDocument;
  readonly signal?: AbortSignal;
}

export type TeamBreakdownReader = (
  input: TeamBreakdownReaderInput,
) => Promise<BreakdownResult>;

function response(
  status: number,
  body: unknown,
  requestId = crypto.randomUUID(),
) {
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

function acceptsJson(request: Request): boolean {
  const accept = request.headers.get("accept");
  return (
    !accept ||
    accept.split(",").some((part) => {
      const mediaType = part.split(";", 1)[0]?.trim().toLowerCase();
      return (
        mediaType === "application/json" ||
        mediaType === "application/*" ||
        mediaType === "*/*"
      );
    })
  );
}

function parseFilter(input: TeamBreakdownQueryDto): FilterDocument | null {
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

/** Typed HTTP adapter for team dimension aggregation. */
export async function handleTeamBreakdown(
  request: Request,
  principal: ApiKeyPrincipal,
  dimension: string,
  providerRegistry: TypedApplicationProviderRegistry,
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
  if (request.headers.has("content-encoding"))
    return errorResponse("unsupported_media_type");
  if (
    !principal.scopes.includes("analytics:read") ||
    (principal.status ?? "active") !== "active"
  )
    return errorResponse("missing_scope");
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    return errorResponse("unsupported_media_type");
  if (!acceptsJson(request)) return errorResponse("not_acceptable");
  if (!DIMENSIONS.has(dimension)) return errorResponse("validation_failed");

  let input: TeamBreakdownQueryDto;
  try {
    input = TeamBreakdownQueryDtoSchema.parse(
      await readBoundedJson(request, MAX_BODY_BYTES),
    );
  } catch {
    return errorResponse("validation_failed");
  }
  const range = resolveApiV1TimeRange(
    input.timeRange,
    executionContext.capturedAtMs ?? Date.now(),
  );
  const startMs = range ? Date.parse(range.from) : NaN;
  const endExclusiveMs = range ? Date.parse(range.to) : NaN;
  const timeZone = range?.timeZone ?? "UTC";
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endExclusiveMs) ||
    endExclusiveMs <= startMs ||
    !isReportingTimeZone(timeZone)
  )
    return errorResponse("validation_failed");
  const filters = parseFilter(input);
  if (!filters) return errorResponse("validation_failed");

  try {
    const query = {
      teamId: principal.teamId,
      allowedSiteIds:
        principal.siteIds.length > 0 ? principal.siteIds : undefined,
      dimension,
      startMs,
      endExclusiveMs,
      timeZone,
      limit: input.limit,
      filters,
    };
    const serviceResult = await createApiV1QueryApplicationAdapter().execute<
      TeamBreakdownReaderInput,
      BreakdownResult
    >(
      {
        operation: "team.analytics.breakdown",
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
          metricCount: 3,
          dimensionCardinality: input.limit,
          pageLimit: input.limit,
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
    if (executionContext.signal?.aborted) return cancelledResponse();
    if (
      typeof executionContext.deadlineMs === "number" &&
      (executionContext.now?.() ?? Date.now()) >= executionContext.deadlineMs
    )
      return errorResponse("deadline_exceeded");
    const requestId = crypto.randomUUID();
    return response(
      200,
      {
        data: { dimension, items: serviceResult.value.items },
        meta: {
          requestId,
          generatedAt: new Date().toISOString(),
          timeRange: {
            from: new Date(startMs).toISOString(),
            to: new Date(endExclusiveMs).toISOString(),
            timeZone,
          },
          source: "raw",
          accuracy: "exact",
        },
      },
      requestId,
    );
  } catch {
    if (executionContext.signal?.aborted) return cancelledResponse();
    return errorResponse("internal_error");
  }
}
