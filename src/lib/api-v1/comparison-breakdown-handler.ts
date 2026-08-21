import {
  type AnalysisDefinitionReader,
  resolveApiV1Filter,
} from "@/lib/api-v1/analytics-overview";
import {
  type SiteComparisonBreakdownQueryDto,
  SiteComparisonBreakdownQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { createApiV1SiteQueryContext } from "@/lib/api-v1/query-context";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { resolveApiV1ComparisonDatasetTimeRange } from "@/lib/api-v1/time-range";
import { ANALYTICS_DIMENSIONS } from "@/lib/edge/analytics/catalog";
import {
  AnalyticsQueryService,
  type QueryExecutionContext,
} from "@/lib/edge/analytics/service";
import type { ApiKeyPrincipal } from "@/lib/edge/api-key-auth";
import type {
  BreakdownItem,
  BreakdownResult,
  FilterDocument,
} from "@/lib/edge/query-contract";

const MAX_BODY_BYTES = 64 * 1024;
const DIMENSIONS = new Set<string>(ANALYTICS_DIMENSIONS);

export interface ComparisonBreakdownReaderInput {
  readonly siteId: string;
  readonly dimension: string;
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly timeZone: string;
  readonly limit: number;
  readonly filters: FilterDocument;
  readonly signal?: AbortSignal;
}

export type ComparisonBreakdownReader = (
  input: ComparisonBreakdownReaderInput,
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

function errorResponse(code: keyof typeof apiV1ErrorRegistry): Response {
  const requestId = crypto.randomUUID();
  const error = apiV1ErrorRegistry[code];
  return response(
    error.status,
    {
      error: { code, message: error.message, retryable: error.retryable },
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
      const value = part.split(";", 1)[0]?.trim().toLowerCase();
      return (
        value === "application/json" ||
        value === "application/*" ||
        value === "*/*"
      );
    })
  );
}

function relative(a: number, b: number): number | null {
  if (b === 0) return a === 0 ? 0 : null;
  return (a - b) / b;
}

function emptyItem(key: string, label: string): BreakdownItem {
  return { key, label, views: 0, sessions: 0, visitors: 0 };
}

function mergeBreakdown(
  a: BreakdownResult,
  b: BreakdownResult,
  limit: number,
  sort: SiteComparisonBreakdownQueryDto["query"]["sort"],
) {
  const aByKey = new Map(a.items.map((item) => [item.key, item]));
  const bByKey = new Map(b.items.map((item) => [item.key, item]));
  return [...new Set([...aByKey.keys(), ...bByKey.keys()])]
    .map((key) => {
      const aItem = aByKey.get(key);
      const bItem = bByKey.get(key);
      const left = aItem ?? emptyItem(key, bItem!.label);
      const right = bItem ?? emptyItem(key, aItem!.label);
      return {
        key,
        label: aItem?.label ?? bItem!.label,
        a: left,
        b: right,
        delta: {
          views: {
            absolute: left.views - right.views,
            relative: relative(left.views, right.views),
          },
          sessions: {
            absolute: left.sessions - right.sessions,
            relative: relative(left.sessions, right.sessions),
          },
          visitors: {
            absolute: left.visitors - right.visitors,
            relative: relative(left.visitors, right.visitors),
          },
        },
      };
    })
    .sort((left, right) => {
      const direction = sort.direction === "desc" ? -1 : 1;
      const difference =
        (left[sort.side][sort.metric] - right[sort.side][sort.metric]) *
        direction;
      return difference || left.key.localeCompare(right.key);
    })
    .slice(0, limit);
}

function mapError(kind: string): keyof typeof apiV1ErrorRegistry {
  if (kind === "missing_scope" || kind === "token_inactive")
    return "missing_scope";
  if (kind === "site_not_found" || kind === "saved_filter_not_available")
    return "resource_not_found";
  if (kind === "invalid_input") return "validation_failed";
  if (kind === "deadline_exceeded" || kind === "deadline-exceeded")
    return "deadline_exceeded";
  if (kind === "request_cancelled" || kind === "request-cancelled")
    return "request_cancelled";
  if (kind === "query-cost-exceeded") return "unsupported_query";
  return "internal_error";
}

/** Executes an explicit site comparison with a full A/B key union before page limiting. */
export async function handleSiteComparisonBreakdown(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  dimension: string,
  reader: ComparisonBreakdownReader,
  executionContext: QueryExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  if (request.method !== "POST") {
    const result = errorResponse("method_not_allowed");
    result.headers.set("Allow", "POST");
    return result;
  }
  if (request.headers.has("content-encoding"))
    return errorResponse("unsupported_media_type");
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    return errorResponse("unsupported_media_type");
  if (!acceptsJson(request)) return errorResponse("not_acceptable");
  if (
    !principal.scopes.includes("analytics:read") ||
    (principal.status ?? "active") !== "active"
  )
    return errorResponse("missing_scope");
  if (!DIMENSIONS.has(dimension)) return errorResponse("validation_failed");

  let input: SiteComparisonBreakdownQueryDto;
  try {
    input = SiteComparisonBreakdownQueryDtoSchema.parse(
      await readBoundedJson(request, MAX_BODY_BYTES),
    );
  } catch {
    return errorResponse("validation_failed");
  }
  const context = createApiV1SiteQueryContext(principal, siteId);
  if (!context.ok) return errorResponse(mapError(context.error));
  if (
    (input.a.filter?.type === "saved" || input.b.filter?.type === "saved") &&
    !principal.scopes.includes("analysis:read")
  )
    return errorResponse("missing_scope");
  const capturedAtMs =
    executionContext.capturedAtMs ?? executionContext.now?.() ?? Date.now();
  const aRange = resolveApiV1ComparisonDatasetTimeRange(
    input.a.timeRange,
    input.timeZone,
    capturedAtMs,
  );
  const bRange = resolveApiV1ComparisonDatasetTimeRange(
    input.b.timeRange,
    input.timeZone,
    capturedAtMs,
  );
  if (!aRange || !bRange) return errorResponse("validation_failed");
  const [aFilter, bFilter] = await Promise.all([
    resolveApiV1Filter(
      siteId,
      input.a.filter,
      definitions,
      executionContext.signal,
    ),
    resolveApiV1Filter(
      siteId,
      input.b.filter,
      definitions,
      executionContext.signal,
    ),
  ]);
  if (!aFilter.ok) return errorResponse(mapError(aFilter.error.kind));
  if (!bFilter.ok) return errorResponse(mapError(bFilter.error.kind));
  const startA = Date.parse(aRange.from);
  const endA = Date.parse(aRange.to);
  const startB = Date.parse(bRange.from);
  const endB = Date.parse(bRange.to);
  const service = new AnalyticsQueryService();
  try {
    const result = await service.execute(
      {
        operation: "site.analytics.comparisonBreakdown",
        context: context.context,
        query: {
          a: {
            siteId,
            dimension,
            startMs: startA,
            endExclusiveMs: endA,
            timeZone: input.timeZone,
            limit: 200,
            filters: aFilter.value,
          },
          b: {
            siteId,
            dimension,
            startMs: startB,
            endExclusiveMs: endB,
            timeZone: input.timeZone,
            limit: 200,
            filters: bFilter.value,
          },
        },
        provider: {
          execute: ({ query: { a, b }, execution: providerExecution }) =>
            Promise.all([
              reader({ ...a, signal: providerExecution.signal }),
              reader({ ...b, signal: providerExecution.signal }),
            ]),
        },
      },
      {
        ...executionContext,
        operation: "site.analytics.comparisonBreakdown",
        cost: {
          rangeMs: endA - startA + (endB - startB),
          siteCount: 1,
          metricCount: 3,
          dimensionCardinality: 400,
          projectionFields: 3,
          pageLimit: input.query.limit,
          provider: "d1",
          batchFanout: 2,
        },
      },
    );
    if (!result.ok) return errorResponse(mapError(result.error.kind));
    const requestId = crypto.randomUUID();
    return response(
      200,
      {
        data: {
          dimension,
          items: mergeBreakdown(
            result.value[0],
            result.value[1],
            input.query.limit,
            input.query.sort,
          ),
        },
        meta: {
          requestId,
          generatedAt: new Date().toISOString(),
          aTimeRange: {
            from: aRange.from,
            to: aRange.to,
            timeZone: input.timeZone,
          },
          bTimeRange: {
            from: bRange.from,
            to: bRange.to,
            timeZone: input.timeZone,
          },
          source: "raw",
          accuracy: "exact",
        },
      },
      requestId,
    );
  } catch {
    return errorResponse(
      executionContext.signal?.aborted ? "request_cancelled" : "internal_error",
    );
  }
}
