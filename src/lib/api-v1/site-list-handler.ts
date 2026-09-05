import type { z } from "zod";

import {
  AnalysisDefinitionIntegrityError,
  AnalysisDefinitionReadCancelledError,
  type AnalysisDefinitionReader,
} from "@/lib/api-v1/analysis-definition-reader";
import { parseApiV1FilterDsl } from "@/lib/api-v1/analytics-overview";
import {
  type SiteAnalyticsQueryBaseDto,
  type SiteChannelsQueryDto,
  SiteChannelsQueryDtoSchema,
  type SiteEventDetailQueryDto,
  SiteEventDetailQueryDtoSchema,
  type SiteEventFieldsQueryDto,
  SiteEventFieldsQueryDtoSchema,
  type SiteEventFieldValuesQueryDto,
  SiteEventFieldValuesQueryDtoSchema,
  type SiteEventsSearchQueryDto,
  SiteEventsSearchQueryDtoSchema,
  type SiteEventsSummaryQueryDto,
  SiteEventsSummaryQueryDtoSchema,
  type SiteEventsTimeseriesQueryDto,
  SiteEventsTimeseriesQueryDtoSchema,
  type SiteEventTypeDetailQueryDto,
  SiteEventTypeDetailQueryDtoSchema,
  type SiteEventTypesQueryDto,
  SiteEventTypesQueryDtoSchema,
  type SiteFilterValuesQueryDto,
  SiteFilterValuesQueryDtoSchema,
  type SiteJourneyEventDetailQueryDto,
  SiteJourneyEventDetailQueryDtoSchema,
  type SitePagesQueryDto,
  SitePagesQueryDtoSchema,
  type SitePerformanceBreakdownQueryDto,
  SitePerformanceBreakdownQueryDtoSchema,
  type SitePerformanceSummaryQueryDto,
  SitePerformanceSummaryQueryDtoSchema,
  type SitePerformanceTimeseriesQueryDto,
  SitePerformanceTimeseriesQueryDtoSchema,
  type SiteRealtimeActiveVisitorsQueryDto,
  SiteRealtimeActiveVisitorsQueryDtoSchema,
  type SiteRealtimeEventsQueryDto,
  SiteRealtimeEventsQueryDtoSchema,
  type SiteRealtimeSessionsQueryDto,
  SiteRealtimeSessionsQueryDtoSchema,
  type SiteRealtimeSnapshotQueryDto,
  SiteRealtimeSnapshotQueryDtoSchema,
  type SiteReferrersQueryDto,
  SiteReferrersQueryDtoSchema,
  type SiteRetentionCohortsQueryDto,
  SiteRetentionCohortsQueryDtoSchema,
  type SiteSessionDetailQueryDto,
  SiteSessionDetailQueryDtoSchema,
  type SiteSessionEventsQueryDto,
  SiteSessionEventsQueryDtoSchema,
  type SiteSessionsSearchQueryDto,
  SiteSessionsSearchQueryDtoSchema,
  type SiteVisitorDetailQueryDto,
  SiteVisitorDetailQueryDtoSchema,
  type SiteVisitorEventsQueryDto,
  SiteVisitorEventsQueryDtoSchema,
  type SiteVisitorSessionsQueryDto,
  SiteVisitorSessionsQueryDtoSchema,
  type SiteVisitorsSearchQueryDto,
  SiteVisitorsSearchQueryDtoSchema,
} from "@/lib/api-v1/dto/analytics";
import { apiV1ErrorRegistry } from "@/lib/api-v1/errors";
import { createApiV1QueryApplicationAdapter } from "@/lib/api-v1/query-application";
import { readBoundedJson } from "@/lib/api-v1/request-budget";
import { resolveApiV1TimeRange } from "@/lib/api-v1/time-range";
import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import {
  attachSavedFilterScopePreference,
  type FilterDocument,
  isReportingTimeZone,
  parseApiV1FilterDocument,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { type ApiKeyPrincipal, canAccessSiteId } from "@/lib/edge/api-key-auth";

const MAX_BODY_BYTES = 64 * 1024;

export interface SiteListReaderInput {
  readonly siteId: string;
  readonly startMs: number;
  readonly endExclusiveMs: number;
  readonly timeZone: string;
  readonly filters: FilterDocument;
  readonly signal?: AbortSignal;
}

export type SiteListReader<
  Input extends {
    readonly timeRange: SiteAnalyticsQueryBaseDto["timeRange"];
    readonly filter?: SiteAnalyticsQueryBaseDto["filter"];
    readonly scope?: SiteAnalyticsQueryBaseDto["scope"];
  },
  Result,
> = (input: SiteListReaderInput & Input) => Promise<Result>;

export type SitePagesReader = SiteListReader<
  SitePagesQueryDto,
  {
    readonly items: readonly unknown[];
    readonly pagination: unknown;
  }
>;
export type SiteChannelsReader = SiteListReader<
  SiteChannelsQueryDto,
  { readonly items: readonly unknown[] }
>;
export type SiteReferrersReader = SiteListReader<
  SiteReferrersQueryDto,
  {
    readonly items: readonly unknown[];
    readonly pagination: unknown;
  }
>;
export type SiteFilterValuesReader = SiteListReader<
  SiteFilterValuesQueryDto,
  {
    readonly field: string;
    readonly items: readonly unknown[];
    readonly pagination: unknown;
  }
>;
export type SiteRetentionReader = SiteListReader<
  SiteRetentionCohortsQueryDto,
  {
    readonly granularity: string;
    readonly cohorts: readonly unknown[];
  }
>;
export type SitePerformanceSummaryReader = SiteListReader<
  SitePerformanceSummaryQueryDto,
  { readonly metrics: unknown }
>;
export type SitePerformanceTimeseriesReader = SiteListReader<
  SitePerformanceTimeseriesQueryDto,
  { readonly interval: string; readonly series: unknown }
>;
export type SitePerformanceBreakdownReader = SiteListReader<
  SitePerformanceBreakdownQueryDto,
  {
    readonly dimension: string;
    readonly metric: string;
    readonly items: readonly unknown[];
  }
>;
export type SiteEventsSummaryReader = SiteListReader<
  SiteEventsSummaryQueryDto,
  { readonly summary: unknown; readonly cards: unknown }
>;
export type SiteEventsTimeseriesReader = SiteListReader<
  SiteEventsTimeseriesQueryDto,
  {
    readonly interval: string;
    readonly series: readonly unknown[];
    readonly points: readonly unknown[];
  }
>;
export type SiteEventsSearchReader = SiteListReader<
  SiteEventsSearchQueryDto,
  { readonly items: readonly unknown[]; readonly pagination: unknown }
>;
export type SiteEventDetailReader = SiteListReader<
  SiteEventDetailQueryDto,
  {
    readonly event: unknown;
    readonly context: unknown;
    readonly eventData: unknown;
  }
>;
export type SiteJourneyEventDetailReader = SiteListReader<
  SiteJourneyEventDetailQueryDto,
  {
    readonly event: unknown;
    readonly context: unknown;
  }
>;
export type SiteEventTypesReader = SiteListReader<
  SiteEventTypesQueryDto,
  {
    readonly items: readonly unknown[];
    readonly pagination: unknown;
  }
>;
export type SiteEventTypeDetailReader = SiteListReader<
  SiteEventTypeDetailQueryDto,
  {
    readonly eventName: string;
    readonly summary: unknown;
    readonly trend: unknown;
    readonly breakdowns: unknown;
    readonly cards: unknown;
    readonly fields: readonly unknown[];
  }
>;
export type SiteEventFieldsReader = SiteListReader<
  SiteEventFieldsQueryDto,
  {
    readonly eventName: string;
    readonly items: readonly unknown[];
    readonly pagination: unknown;
  }
>;
export type SiteEventFieldValuesReader = SiteListReader<
  SiteEventFieldValuesQueryDto,
  {
    readonly eventName: string;
    readonly fieldPath: string;
    readonly fieldValueType: string;
    readonly items: readonly unknown[];
    readonly pagination: unknown;
  }
>;
export type SiteVisitorDetailReader = SiteListReader<
  SiteVisitorDetailQueryDto,
  {
    readonly visitor: unknown;
    readonly metrics: unknown;
    readonly visitedPages: readonly unknown[];
    readonly eventDistribution: readonly unknown[];
    readonly activity: readonly unknown[];
    readonly performance: unknown;
  }
>;
export type SiteSessionDetailReader = SiteListReader<
  SiteSessionDetailQueryDto,
  {
    readonly session: unknown;
    readonly locationPoints: readonly unknown[];
    readonly visitedPages: readonly unknown[];
    readonly eventDistribution: readonly unknown[];
    readonly performance: unknown;
  }
>;
export type SiteVisitorsSearchReader = SiteListReader<
  SiteVisitorsSearchQueryDto,
  { readonly items: readonly unknown[]; readonly pagination: unknown }
>;
export type SiteSessionsSearchReader = SiteListReader<
  SiteSessionsSearchQueryDto,
  { readonly items: readonly unknown[]; readonly pagination: unknown }
>;
export type SiteVisitorEventsReader = SiteListReader<
  SiteVisitorEventsQueryDto,
  { readonly items: readonly unknown[]; readonly pagination: unknown }
>;
export type SiteVisitorSessionsReader = SiteListReader<
  SiteVisitorSessionsQueryDto,
  { readonly items: readonly unknown[]; readonly pagination: unknown }
>;
export type SiteSessionEventsReader = SiteListReader<
  SiteSessionEventsQueryDto,
  { readonly items: readonly unknown[]; readonly pagination: unknown }
>;
export type SiteRealtimeSnapshotReader = SiteListReader<
  SiteRealtimeSnapshotQueryDto,
  {
    readonly activeNow: number;
    readonly events: readonly unknown[];
    readonly visits: readonly unknown[];
  }
>;
export type SiteRealtimeActiveVisitorsReader = SiteListReader<
  SiteRealtimeActiveVisitorsQueryDto,
  { readonly activeNow: number }
>;
export type SiteRealtimeEventsReader = SiteListReader<
  SiteRealtimeEventsQueryDto,
  { readonly items: readonly unknown[] }
>;
export type SiteRealtimeSessionsReader = SiteListReader<
  SiteRealtimeSessionsQueryDto,
  { readonly items: readonly unknown[] }
>;

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

function errorResponse(code: keyof typeof apiV1ErrorRegistry): Response {
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

function cancelledResponse(): Response {
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

async function resolveFilter(
  input: SiteAnalyticsQueryBaseDto,
  siteId: string,
  definitions: AnalysisDefinitionReader | undefined,
  signal: AbortSignal | undefined,
): Promise<FilterDocument | null> {
  if (!input.filter) return { version: 1, root: null };
  if (input.filter.type === "saved") {
    if (!definitions) return null;
    return definitions
      .resolveTeamVisibleSavedFilter({ siteId, id: input.filter.id, signal })
      .then((resolved) =>
        resolved
          ? attachSavedFilterScopePreference(
              resolved.document,
              resolved.scopePreference ?? "auto",
            )
          : null,
      );
  }
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

interface ExecutionContext {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
  readonly capturedAtMs?: number;
  readonly now?: () => number;
}

interface ResponseMetaOptions {
  readonly source?: "raw" | "rollup" | "realtime" | "mixed" | "mock";
  readonly accuracy?: "exact" | "approximate";
}

async function handlePlannedSiteList<
  Input extends {
    readonly timeRange: SiteAnalyticsQueryBaseDto["timeRange"];
    readonly filter?: SiteAnalyticsQueryBaseDto["filter"];
    readonly scope?: SiteAnalyticsQueryBaseDto["scope"];
  },
  Result,
>(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  schema: z.ZodType<Input>,
  operation: AnalyticsOperationId,
  providerRegistry: AnalyticsProviderRegistry,
  execution: ExecutionContext = {},
  definitions?: AnalysisDefinitionReader,
  responseMeta: ResponseMetaOptions = {},
): Promise<Response> {
  if (request.method !== "POST") {
    const method = errorResponse("method_not_allowed");
    method.headers.set("Allow", "POST");
    return method;
  }
  if (request.headers.has("content-encoding")) {
    return errorResponse("unsupported_media_type");
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

  let input: Input;
  try {
    input = schema.parse(await readBody(request));
  } catch {
    return errorResponse("validation_failed");
  }
  if (!principal.scopes.includes("analytics:read")) {
    return errorResponse("missing_scope");
  }
  if ((principal.status ?? "active") !== "active") {
    return errorResponse("missing_scope");
  }
  if (!canAccessSiteId(principal, siteId)) {
    return errorResponse("resource_not_found");
  }
  if (
    input.filter?.type === "saved" &&
    !principal.scopes.includes("analysis:read")
  ) {
    return errorResponse("missing_scope");
  }

  const resolvedTimeRange = resolveApiV1TimeRange(
    input.timeRange,
    execution.capturedAtMs ?? Date.now(),
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
  let filters: FilterDocument | null;
  try {
    filters = await resolveFilter(input, siteId, definitions, execution.signal);
  } catch (error) {
    if (error instanceof AnalysisDefinitionReadCancelledError) {
      return cancelledResponse();
    }
    if (error instanceof AnalysisDefinitionIntegrityError) {
      return errorResponse("internal_error");
    }
    return errorResponse("internal_error");
  }
  if (!filters) {
    return errorResponse(
      input.filter?.type === "saved"
        ? "resource_not_found"
        : "validation_failed",
    );
  }
  if (execution.signal?.aborted) return cancelledResponse();
  if (
    typeof execution.deadlineMs === "number" &&
    (execution.now?.() ?? Date.now()) >= execution.deadlineMs
  ) {
    return errorResponse("deadline_exceeded");
  }
  try {
    const queryShape = input as unknown as {
      readonly metrics?: readonly unknown[];
      readonly page?: { readonly limit?: number };
    };
    const metricCount = Math.max(1, queryShape.metrics?.length ?? 1);
    const query = {
      ...input,
      siteId,
      startMs,
      endExclusiveMs,
      timeZone,
      filters,
      scopePreference: input.scope ?? "auto",
    };
    const serviceResult = await createApiV1QueryApplicationAdapter().execute<
      typeof query,
      Result
    >(
      {
        operation,
        context: siteQueryContext(siteId, "api-v1"),
        query,
        providerRegistry,
      },
      {
        signal: execution.signal,
        deadlineMs: execution.deadlineMs,
        capturedAtMs: execution.capturedAtMs,
        now: execution.now,
        cost: {
          rangeMs: endExclusiveMs - startMs,
          siteCount: 1,
          metricCount,
          dimensionCardinality: 1,
          projectionFields: metricCount,
          pageLimit: Math.max(1, queryShape.page?.limit ?? 1),
          provider: "d1",
          batchFanout: 1,
        },
      },
    );
    if (!serviceResult.ok) {
      if (serviceResult.error.kind === "request-cancelled") {
        return cancelledResponse();
      }
      if (serviceResult.error.kind === "deadline-exceeded") {
        return errorResponse("deadline_exceeded");
      }
      if (serviceResult.error.kind === "invalid-input") {
        return errorResponse("validation_failed");
      }
      if (serviceResult.error.kind === "invalid-cursor") {
        return errorResponse("invalid_cursor");
      }
      return errorResponse("unsupported_query");
    }
    const data = serviceResult.value;
    const requestId = crypto.randomUUID();
    return response(
      200,
      {
        data,
        meta: {
          requestId,
          generatedAt: new Date().toISOString(),
          timeRange: {
            from: new Date(startMs).toISOString(),
            to: new Date(endExclusiveMs).toISOString(),
            timeZone,
          },
          source: responseMeta.source ?? "raw",
          accuracy: responseMeta.accuracy ?? "exact",
          ...(serviceResult.meta?.filterScope
            ? { filterScope: serviceResult.meta.filterScope }
            : {}),
        },
      },
      requestId,
    );
  } catch (error) {
    if (execution.signal?.aborted) return cancelledResponse();
    if (error instanceof Error && error.message === "invalid-cursor") {
      return errorResponse("invalid_cursor");
    }
    if (error instanceof Error && error.message === "data-unavailable") {
      return errorResponse("data_unavailable");
    }
    if (error instanceof Error && error.message === "resource-not-found") {
      return errorResponse("resource_not_found");
    }
    return errorResponse("internal_error");
  }
}

/** Planned pages adapter; Hono registration remains rollout-gated. */
export function handlePlannedSitePages(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SitePagesQueryDtoSchema,
    "site.analytics.pages",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned referrers adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteReferrers(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteReferrersQueryDtoSchema,
    "site.analytics.referrers",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned channels adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteChannels(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteChannelsQueryDtoSchema,
    "site.analytics.channels",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned filter-values adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteFilterValues(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteFilterValuesQueryDtoSchema,
    "site.analytics.filterValues",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned retention cohorts adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteRetention(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteRetentionCohortsQueryDtoSchema,
    "site.analytics.retentionCohorts",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned performance summary adapter; Hono registration remains rollout-gated. */
export function handlePlannedSitePerformanceSummary(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SitePerformanceSummaryQueryDtoSchema,
    "site.analytics.performanceSummary",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned performance timeseries adapter; Hono registration remains rollout-gated. */
export function handlePlannedSitePerformanceTimeseries(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SitePerformanceTimeseriesQueryDtoSchema,
    "site.analytics.performanceTimeseries",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned performance breakdown adapter; Hono registration remains rollout-gated. */
export function handlePlannedSitePerformanceBreakdown(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SitePerformanceBreakdownQueryDtoSchema,
    "site.analytics.performanceBreakdown",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned event summary adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteEventsSummary(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteEventsSummaryQueryDtoSchema,
    "site.analytics.eventsSummary",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned event timeseries adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteEventsTimeseries(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteEventsTimeseriesQueryDtoSchema,
    "site.analytics.eventsTimeseries",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned event-record search adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteEventsSearch(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteEventsSearchQueryDtoSchema,
    "site.analytics.eventsSearch",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned event-record detail adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteEventDetail(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteEventDetailQueryDtoSchema,
    "site.analytics.eventDetail",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned JourneyEvent detail adapter; custom events use eventDetail above. */
export function handlePlannedSiteJourneyEventDetail(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteJourneyEventDetailQueryDtoSchema,
    "site.analytics.journeyEventDetail",
    providerRegistry,
    execution,
  );
}

/** Planned event-type list adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteEventTypes(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteEventTypesQueryDtoSchema,
    "site.analytics.eventTypes",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned event-type detail adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteEventTypeDetail(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteEventTypeDetailQueryDtoSchema,
    "site.analytics.eventTypeDetail",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned event-type fields adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteEventFields(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteEventFieldsQueryDtoSchema,
    "site.analytics.eventFields",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned event-type field-values adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteEventFieldValues(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteEventFieldValuesQueryDtoSchema,
    "site.analytics.eventFieldValues",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned visitor detail adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteVisitorDetail(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteVisitorDetailQueryDtoSchema,
    "site.analytics.visitorDetail",
    providerRegistry,
    execution,
  );
}

/** Planned session detail adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteSessionDetail(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteSessionDetailQueryDtoSchema,
    "site.analytics.sessionDetail",
    providerRegistry,
    execution,
  );
}

/** Planned visitor search adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteVisitorsSearch(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteVisitorsSearchQueryDtoSchema,
    "site.analytics.visitorsSearch",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned session search adapter; Hono registration remains rollout-gated. */
export function handlePlannedSiteSessionsSearch(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteSessionsSearchQueryDtoSchema,
    "site.analytics.sessionsSearch",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned visitor event trajectory; Hono registration remains rollout-gated. */
export function handlePlannedSiteVisitorEvents(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteVisitorEventsQueryDtoSchema,
    "site.analytics.visitorEvents",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned visitor session trajectory; Hono registration remains rollout-gated. */
export function handlePlannedSiteVisitorSessions(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteVisitorSessionsQueryDtoSchema,
    "site.analytics.visitorSessions",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned session event trajectory; Hono registration remains rollout-gated. */
export function handlePlannedSiteSessionEvents(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
  definitions?: AnalysisDefinitionReader,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteSessionEventsQueryDtoSchema,
    "site.analytics.sessionEvents",
    providerRegistry,
    execution,
    definitions,
  );
}

/** Planned realtime adapters; Hono registration remains rollout-gated. */
export function handlePlannedSiteRealtimeSnapshot(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteRealtimeSnapshotQueryDtoSchema,
    "site.analytics.realtimeSnapshot",
    providerRegistry,
    execution,
    undefined,
    { source: "realtime" },
  );
}
export function handlePlannedSiteRealtimeActiveVisitors(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteRealtimeActiveVisitorsQueryDtoSchema,
    "site.analytics.realtimeActiveVisitors",
    providerRegistry,
    execution,
    undefined,
    { source: "realtime" },
  );
}
export function handlePlannedSiteRealtimeEvents(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteRealtimeEventsQueryDtoSchema,
    "site.analytics.realtimeEvents",
    providerRegistry,
    execution,
    undefined,
    { source: "realtime" },
  );
}
export function handlePlannedSiteRealtimeSessions(
  request: Request,
  principal: ApiKeyPrincipal,
  siteId: string,
  providerRegistry: AnalyticsProviderRegistry,
  execution?: ExecutionContext,
): Promise<Response> {
  return handlePlannedSiteList(
    request,
    principal,
    siteId,
    SiteRealtimeSessionsQueryDtoSchema,
    "site.analytics.realtimeSessions",
    providerRegistry,
    execution,
    undefined,
    { source: "realtime" },
  );
}
