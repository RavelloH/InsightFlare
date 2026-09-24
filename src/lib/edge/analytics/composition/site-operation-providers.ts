import {
  AnalyticsProviderRegistry,
  type TypedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import type { AnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  type QueryInput,
  type QueryOperation,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { readSiteBreakdown } from "@/lib/edge/analytics/providers/d1/operations/site-breakdown";
import { readSiteChannels } from "@/lib/edge/analytics/providers/d1/operations/site-channels";
import { readSiteCrossBreakdown } from "@/lib/edge/analytics/providers/d1/operations/site-cross-breakdown";
import {
  readSiteEventDetail,
  readSiteEventRecords,
} from "@/lib/edge/analytics/providers/d1/operations/site-event-records";
import {
  readSiteEventFields,
  readSiteEventFieldValues,
  readSiteEventsTimeseries,
  readSiteEventTypeDetail,
  readSiteEventTypes,
} from "@/lib/edge/analytics/providers/d1/operations/site-events";
import { readSiteFilterValues } from "@/lib/edge/analytics/providers/d1/operations/site-filter-values";
import { readSiteFunnelAnalysis } from "@/lib/edge/analytics/providers/d1/operations/site-funnel-analysis";
import { readSiteGoalSummary } from "@/lib/edge/analytics/providers/d1/operations/site-goal-summary";
import { readSiteGoalTimeseries } from "@/lib/edge/analytics/providers/d1/operations/site-goal-timeseries";
import {
  readSiteJourneyEventDetail,
  readSiteSessionDetail,
  readSiteSessionEvents,
  readSiteSessions,
  readSiteVisitorDetail,
  readSiteVisitorEvents,
  readSiteVisitors,
  readSiteVisitorSessions,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import {
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-performance";
import { readSiteRetention } from "@/lib/edge/analytics/providers/d1/operations/site-retention";
import type { Env } from "@/lib/edge/types";

type RuntimeQuery = QueryInput & {
  readonly time: QueryTime;
  readonly [key: string]: unknown;
};

type SiteQueryProviderKind =
  | "overview"
  | "timeseries"
  | "pages"
  | "referrers"
  | "events-summary"
  | "breakdown"
  | "cross-breakdown"
  | "channels"
  | "filter-values"
  | "retention"
  | "funnel-analysis"
  | "goal-summary"
  | "goal-timeseries"
  | "performance-summary"
  | "performance-timeseries"
  | "performance-breakdown"
  | "events-timeseries"
  | "event-types"
  | "event-type-detail"
  | "event-fields"
  | "event-field-values"
  | "events-search"
  | "event-detail"
  | "visitor-detail"
  | "session-detail"
  | "journey-event-detail"
  | "visitors-search"
  | "sessions-search"
  | "visitor-events"
  | "visitor-sessions"
  | "session-events";

const SITE_QUERY_OPERATION_BY_KIND = {
  overview: "overview",
  timeseries: "trend",
  pages: "pages",
  referrers: "referrers",
  "events-summary": "event-summary",
  breakdown: "dimension",
  "cross-breakdown": "cross-dimension",
  channels: "channels",
  "filter-values": "filter-values",
  retention: "retention",
  "funnel-analysis": "funnel-analysis",
  "goal-summary": "goal-summary",
  "goal-timeseries": "goal-timeseries",
  "performance-summary": "performance",
  "performance-timeseries": "performance",
  "performance-breakdown": "performance",
  "events-timeseries": "event-trend",
  "event-types": "event-types",
  "event-type-detail": "event-type-detail",
  "event-fields": "event-fields",
  "event-field-values": "event-field-values",
  "events-search": "event-records",
  "event-detail": "event-record-detail",
  "visitor-detail": "visitor-detail",
  "session-detail": "session-detail",
  "journey-event-detail": "journey-event-detail",
  "visitors-search": "visitors",
  "sessions-search": "sessions",
  "visitor-events": "visitor-events",
  "visitor-sessions": "visitor-sessions",
  "session-events": "session-events",
} as const satisfies Record<SiteQueryProviderKind, QueryOperation>;

const SITE_QUERY_PROVIDER_KINDS = Object.keys(
  SITE_QUERY_OPERATION_BY_KIND,
) as SiteQueryProviderKind[];

const SITE_QUERY_VARIANT_BY_KIND: Partial<
  Record<SiteQueryProviderKind, string>
> = {
  "performance-summary": "summary",
  "performance-timeseries": "timeseries",
  "performance-breakdown": "breakdown",
};

interface SiteQueryProviderOptions {
  readonly env: Env;
  readonly siteId: string;
  readonly queryKind: SiteQueryProviderKind;
}

function query(input: QueryInput): RuntimeQuery {
  return input as RuntimeQuery;
}

function stringField(input: RuntimeQuery, name: string, fallback = ""): string {
  const value = input[name];
  return typeof value === "string" ? value : fallback;
}

function numberField(
  input: RuntimeQuery,
  name: string,
  fallback: number,
): number {
  const value = input[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function filters(input: RuntimeQuery) {
  return input.filters ?? EMPTY_FILTER_DOCUMENT;
}

function timeWindow(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
    ...(time.paginationBinding
      ? { paginationBinding: time.paginationBinding }
      : {}),
  };
}

function page(input: RuntimeQuery) {
  const raw = input.page;
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    limit: numberField(value as RuntimeQuery, "limit", 20),
    cursor: typeof value.cursor === "string" ? value.cursor : null,
  };
}

function limitField(input: RuntimeQuery, fallback = 20): number {
  return numberField(input, "limit", page(input).limit || fallback);
}

function sort(input: RuntimeQuery) {
  const raw = input.sort;
  return raw && typeof raw === "object"
    ? (raw as { readonly field: string; readonly direction: "asc" | "desc" })
    : { field: "occurredAt", direction: "desc" as const };
}

function provider<Result>(
  run: (input: RuntimeQuery, signal?: AbortSignal) => Promise<Result>,
): TypedQueryProvider<Result> {
  return {
    execute: async (input, execution) => ({
      value: await run(query(input), execution?.signal),
    }),
  };
}

function siteId(input: RuntimeQuery, fallback: string): string {
  return stringField(input, "siteId", fallback);
}

function registerSiteOperation(
  registry: AnalyticsProviderRegistry,
  options: SiteQueryProviderOptions,
  canonicalRuntime: AnalyticsQueryRuntime,
): void {
  const operation = SITE_QUERY_OPERATION_BY_KIND[options.queryKind];
  const { env, siteId: configuredSiteId = "" } = options;

  if (
    options.queryKind === "overview" ||
    options.queryKind === "timeseries" ||
    options.queryKind === "pages" ||
    options.queryKind === "referrers" ||
    options.queryKind === "events-summary"
  ) {
    const canonicalProvider =
      canonicalRuntime.providerRegistry.resolve(operation);
    if (canonicalProvider) {
      registry.register(operation, canonicalProvider);
      return;
    }
  }

  switch (options.queryKind) {
    case "breakdown":
      registry.register(
        operation,
        provider((input) =>
          readSiteBreakdown({
            env,
            siteId: siteId(input, configuredSiteId),
            dimension: stringField(input, "dimension"),
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "cross-breakdown":
      registry.register(
        operation,
        provider((input) =>
          readSiteCrossBreakdown({
            env,
            siteId: siteId(input, configuredSiteId),
            primaryDimension: stringField(input, "primaryDimension"),
            secondaryDimension: stringField(input, "secondaryDimension"),
            primaryLimit: numberField(input, "primaryLimit", 20),
            secondaryLimit: numberField(input, "secondaryLimit", 20),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "channels":
      registry.register(
        operation,
        provider((input) =>
          readSiteChannels({
            env,
            siteId: siteId(input, configuredSiteId),
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "filter-values":
      registry.register(
        operation,
        provider((input) =>
          readSiteFilterValues({
            env,
            siteId: siteId(input, configuredSiteId),
            field: stringField(input, "field"),
            search: typeof input.search === "string" ? input.search : undefined,
            page: page(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "retention":
      registry.register(
        operation,
        provider((input) =>
          readSiteRetention({
            env,
            siteId: siteId(input, configuredSiteId),
            granularity: stringField(input, "granularity", "day"),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "funnel-analysis":
      registry.register(
        operation,
        provider(async (input) => {
          const result = await readSiteFunnelAnalysis({
            env,
            siteId: siteId(input, configuredSiteId),
            funnelId: stringField(input, "funnelId"),
            window: timeWindow(input.time),
            filters: filters(input),
          });
          return result;
        }),
      );
      return;
    case "goal-summary":
      registry.register(
        operation,
        provider((input) =>
          readSiteGoalSummary({
            env,
            siteId: siteId(input, configuredSiteId),
            goalId: stringField(input, "goalId"),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "goal-timeseries":
      registry.register(
        operation,
        provider((input) =>
          readSiteGoalTimeseries({
            env,
            siteId: siteId(input, configuredSiteId),
            goalId: stringField(input, "goalId"),
            interval: input.interval as never,
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "performance-summary":
      registry.register(
        operation,
        provider((input) =>
          readSitePerformanceSummary({
            env,
            siteId: siteId(input, configuredSiteId),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "performance-timeseries":
      registry.register(
        operation,
        provider((input) =>
          readSitePerformanceTimeseries({
            env,
            siteId: siteId(input, configuredSiteId),
            interval: input.interval as never,
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "performance-breakdown":
      registry.register(
        operation,
        provider((input) =>
          readSitePerformanceBreakdown({
            env,
            siteId: siteId(input, configuredSiteId),
            dimension: stringField(input, "dimension"),
            metric: stringField(input, "metric") as never,
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "events-timeseries":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventsTimeseries({
            env,
            siteId: siteId(input, configuredSiteId),
            interval: input.interval as never,
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "event-types":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventTypes({
            env,
            siteId: siteId(input, configuredSiteId),
            search: typeof input.search === "string" ? input.search : undefined,
            page: page(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "event-type-detail":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventTypeDetail({
            env,
            siteId: siteId(input, configuredSiteId),
            eventName: stringField(input, "eventName"),
            interval: input.interval as never,
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "event-fields":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventFields({
            env,
            siteId: siteId(input, configuredSiteId),
            eventName: stringField(input, "eventName"),
            page: page(input),
            window: timeWindow(input.time),
            filters: filters(input),
            audience: input.context.policy.audience,
          }),
        ),
      );
      return;
    case "event-field-values":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventFieldValues({
            env,
            siteId: siteId(input, configuredSiteId),
            eventName: stringField(input, "eventName"),
            fieldPath: stringField(input, "fieldPath"),
            fieldValueType: stringField(input, "fieldValueType"),
            search: typeof input.search === "string" ? input.search : undefined,
            page: page(input),
            window: timeWindow(input.time),
            filters: filters(input),
            audience: input.context.policy.audience,
          }),
        ),
      );
      return;
    case "events-search":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventRecords({
            env,
            siteId: siteId(input, configuredSiteId),
            search: typeof input.search === "string" ? input.search : undefined,
            eventName:
              typeof input.eventName === "string" ? input.eventName : undefined,
            sort: sort(input) as never,
            page: page(input),
            window: timeWindow(input.time),
            filters: filters(input),
            audience: input.context.policy.audience,
          }),
        ),
      );
      return;
    case "event-detail":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventDetail({
            env,
            siteId: siteId(input, configuredSiteId),
            eventId: stringField(input, "eventId"),
            window: timeWindow(input.time),
          }),
        ),
      );
      return;
    case "visitor-detail":
      registry.register(
        operation,
        provider((input) =>
          readSiteVisitorDetail({
            env,
            siteId: siteId(input, configuredSiteId),
            visitorId: stringField(input, "visitorId"),
            window: timeWindow(input.time),
          }),
        ),
      );
      return;
    case "session-detail":
      registry.register(
        operation,
        provider((input) =>
          readSiteSessionDetail({
            env,
            siteId: siteId(input, configuredSiteId),
            sessionId: stringField(input, "sessionId"),
            window: timeWindow(input.time),
          }),
        ),
      );
      return;
    case "journey-event-detail":
      registry.register(
        operation,
        provider((input) =>
          readSiteJourneyEventDetail({
            env,
            siteId: siteId(input, configuredSiteId),
            eventId: stringField(input, "eventId"),
            eventKind: stringField(input, "eventKind") as
              "pageview" | "session_start" | "leave" | undefined,
            window: timeWindow(input.time),
          }),
        ),
      );
      return;
    case "visitors-search":
      registry.register(
        operation,
        provider((input) =>
          readSiteVisitors({
            env,
            siteId: siteId(input, configuredSiteId),
            search: typeof input.search === "string" ? input.search : undefined,
            sort: sort(input) as never,
            page: page(input),
            window: timeWindow(input.time),
            filters: filters(input),
            audience: input.context.policy.audience,
          }),
        ),
      );
      return;
    case "sessions-search":
      registry.register(
        operation,
        provider((input) =>
          readSiteSessions({
            env,
            siteId: siteId(input, configuredSiteId),
            search: typeof input.search === "string" ? input.search : undefined,
            sort: sort(input) as never,
            page: page(input),
            window: timeWindow(input.time),
            filters: filters(input),
            audience: input.context.policy.audience,
          }),
        ),
      );
      return;
    case "visitor-events":
      registry.register(
        operation,
        provider((input) =>
          readSiteVisitorEvents({
            env,
            siteId: siteId(input, configuredSiteId),
            visitorId: stringField(input, "visitorId"),
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
            page: page(input),
            audience: input.context.policy.audience,
          }),
        ),
      );
      return;
    case "visitor-sessions":
      registry.register(
        operation,
        provider((input) =>
          readSiteVisitorSessions({
            env,
            siteId: siteId(input, configuredSiteId),
            visitorId: stringField(input, "visitorId"),
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
            page: page(input),
            audience: input.context.policy.audience,
          }),
        ),
      );
      return;
    case "session-events":
      registry.register(
        operation,
        provider((input) =>
          readSiteSessionEvents({
            env,
            siteId: siteId(input, configuredSiteId),
            sessionId: stringField(input, "sessionId"),
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
            page: page(input),
            audience: input.context.policy.audience,
          }),
        ),
      );
      return;
  }
}

export function registerSiteAnalyticsOperations(
  runtime: AnalyticsQueryRuntime,
  options: Omit<SiteQueryProviderOptions, "queryKind">,
): AnalyticsQueryRuntime {
  const registry = runtime.providerRegistry;
  const variants = new Map<
    QueryOperation,
    Map<string, TypedQueryProvider<unknown>>
  >();

  for (const queryKind of SITE_QUERY_PROVIDER_KINDS) {
    const operation = SITE_QUERY_OPERATION_BY_KIND[queryKind];

    const operationRegistry = new AnalyticsProviderRegistry();
    registerSiteOperation(
      operationRegistry,
      { ...options, queryKind },
      runtime,
    );
    const operationProvider = operationRegistry.resolve(operation);
    if (!operationProvider) continue;

    const queryVariant = SITE_QUERY_VARIANT_BY_KIND[queryKind];
    if (queryVariant) {
      const operationVariants = variants.get(operation) ?? new Map();
      operationVariants.set(queryVariant, operationProvider);
      variants.set(operation, operationVariants);
      continue;
    }

    const fallback = registry.resolve(operation);
    registry.register(operation, {
      execute: async (input, execution) => {
        if (input.context.policy.audience === "api-v1" || !fallback) {
          return operationProvider.execute(input, execution);
        }
        return fallback.execute(input, execution);
      },
    });
  }

  for (const [operation, operationVariants] of variants) {
    const fallback = registry.resolve(operation);
    registry.register(operation, {
      execute: async (input, execution) => {
        if (input.context.policy.audience === "api-v1") {
          const query = input as QueryInput & {
            readonly queryMode?: unknown;
          };
          const queryMode =
            typeof query.queryMode === "string" ? query.queryMode : "";
          const operationProvider = operationVariants.get(queryMode);
          if (operationProvider) {
            return operationProvider.execute(input, execution);
          }
        }
        if (fallback) return fallback.execute(input, execution);
        throw new Error(`unsupported-query-operation:${operation}`);
      },
    });
  }

  return runtime;
}
