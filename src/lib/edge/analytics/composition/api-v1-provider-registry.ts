import type { AnalyticsOperationId } from "@/lib/edge/analytics/application/operation-registry";
import {
  AnalyticsProviderRegistry,
  type TypedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import { canonicalQueryOperationFor } from "@/lib/edge/analytics/application/query-operation-map";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1-site-query-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  type QueryInput,
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
  readSiteEventsSummary,
  readSiteEventsTimeseries,
  readSiteEventTypeDetail,
  readSiteEventTypes,
} from "@/lib/edge/analytics/providers/d1/operations/site-events";
import { readSiteFilterValues } from "@/lib/edge/analytics/providers/d1/operations/site-filter-values";
import { readSiteFunnelAnalysis } from "@/lib/edge/analytics/providers/d1/operations/site-funnel-analysis";
import {
  readSiteSessionDetail,
  readSiteSessionEvents,
  readSiteSessions,
  readSiteVisitorDetail,
  readSiteVisitorEvents,
  readSiteVisitors,
  readSiteVisitorSessions,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import {
  readSitePages,
  readSiteReferrers,
} from "@/lib/edge/analytics/providers/d1/operations/site-pages";
import {
  readSitePerformanceBreakdown,
  readSitePerformanceSummary,
  readSitePerformanceTimeseries,
} from "@/lib/edge/analytics/providers/d1/operations/site-performance";
import { readSiteRetention } from "@/lib/edge/analytics/providers/d1/operations/site-retention";
import { readTeamBreakdown } from "@/lib/edge/analytics/providers/d1/operations/team-breakdown";
import { readTeamOverview } from "@/lib/edge/analytics/providers/d1/operations/team-overview";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import { readTeamTimeseries } from "@/lib/edge/analytics/providers/d1/operations/team-timeseries";
import {
  readSiteRealtimeActiveVisitors,
  readSiteRealtimeEvents,
  readSiteRealtimeSessions,
  readSiteRealtimeSnapshot,
} from "@/lib/edge/analytics/providers/realtime/operations/site-realtime";
import type { Env } from "@/lib/edge/types";

type RuntimeQuery = QueryInput & {
  readonly time: QueryTime;
  readonly [key: string]: unknown;
};

export interface QueryRuntimeOptions {
  readonly env: Env;
  readonly siteId?: string;
  readonly teamId?: string;
  readonly operation: AnalyticsOperationId;
  readonly performanceDimension?: string;
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

function teamId(input: RuntimeQuery, fallback: string): string {
  return stringField(input, "teamId", fallback);
}

function allowedSiteIds(input: RuntimeQuery): readonly string[] | undefined {
  const value = input.allowedSiteIds;
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function registerSiteOperation(
  registry: AnalyticsProviderRegistry,
  options: QueryRuntimeOptions,
): void {
  const operation = canonicalQueryOperationFor(options.operation);
  const { env, siteId: configuredSiteId = "" } = options;

  switch (options.operation) {
    case "site.analytics.overview":
      registry.register(
        operation,
        createD1SiteQueryRuntime({
          env,
          siteId: configuredSiteId,
        }).providerRegistry.resolve("overview")!,
      );
      return;
    case "site.analytics.timeseries":
      registry.register(
        operation,
        createD1SiteQueryRuntime({
          env,
          siteId: configuredSiteId,
        }).providerRegistry.resolve("trend")!,
      );
      return;
    case "site.analytics.breakdown":
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
    case "site.analytics.crossBreakdown":
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
    case "site.analytics.pages":
      registry.register(
        operation,
        provider((input) =>
          readSitePages({
            env,
            siteId: siteId(input, configuredSiteId),
            limit: limitField(input),
            includeDetails: input.includeDetails === true,
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "site.analytics.referrers":
      registry.register(
        operation,
        provider((input) =>
          readSiteReferrers({
            env,
            siteId: siteId(input, configuredSiteId),
            limit: limitField(input),
            includeFullUrl: input.includeFullUrl === true,
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "site.analytics.channels":
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
    case "site.analytics.filterValues":
      registry.register(
        operation,
        provider((input) =>
          readSiteFilterValues({
            env,
            siteId: siteId(input, configuredSiteId),
            field: stringField(input, "field"),
            search: typeof input.search === "string" ? input.search : undefined,
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "site.analytics.retentionCohorts":
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
    case "site.analytics.funnelAnalysis":
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
          if (!result) throw new Error("resource-not-found");
          return result;
        }),
      );
      return;
    case "site.analytics.performanceSummary":
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
    case "site.analytics.performanceTimeseries":
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
    case "site.analytics.performanceBreakdown":
      registry.register(
        operation,
        provider((input) =>
          readSitePerformanceBreakdown({
            env,
            siteId: siteId(input, configuredSiteId),
            dimension:
              options.performanceDimension ?? stringField(input, "dimension"),
            metric: stringField(input, "metric") as never,
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "site.analytics.eventsSummary":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventsSummary({
            env,
            siteId: siteId(input, configuredSiteId),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "site.analytics.eventsTimeseries":
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
    case "site.analytics.eventTypes":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventTypes({
            env,
            siteId: siteId(input, configuredSiteId),
            search: typeof input.search === "string" ? input.search : undefined,
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "site.analytics.eventTypeDetail":
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
    case "site.analytics.eventFields":
      registry.register(
        operation,
        provider((input) =>
          readSiteEventFields({
            env,
            siteId: siteId(input, configuredSiteId),
            eventName: stringField(input, "eventName"),
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "site.analytics.eventFieldValues":
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
            limit: limitField(input),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    case "site.analytics.eventsSearch":
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
          }),
        ),
      );
      return;
    case "site.analytics.eventDetail":
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
    case "site.analytics.visitorDetail":
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
    case "site.analytics.sessionDetail":
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
    case "site.analytics.visitorsSearch":
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
          }),
        ),
      );
      return;
    case "site.analytics.sessionsSearch":
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
          }),
        ),
      );
      return;
    case "site.analytics.visitorEvents":
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
          }),
        ),
      );
      return;
    case "site.analytics.visitorSessions":
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
          }),
        ),
      );
      return;
    case "site.analytics.sessionEvents":
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
          }),
        ),
      );
      return;
    case "site.analytics.realtimeSnapshot":
      registry.register(
        operation,
        provider((input, signal) =>
          readSiteRealtimeSnapshot({
            env,
            siteId: siteId(input, configuredSiteId),
            startMs: input.time.range.startMs,
            endExclusiveMs: input.time.range.endExclusiveMs,
            limit: limitField(input),
            signal,
          }),
        ),
      );
      return;
    case "site.analytics.realtimeActiveVisitors":
      registry.register(
        operation,
        provider((input, signal) =>
          readSiteRealtimeActiveVisitors({
            env,
            siteId: siteId(input, configuredSiteId),
            startMs: input.time.range.startMs,
            endExclusiveMs: input.time.range.endExclusiveMs,
            signal,
          }),
        ),
      );
      return;
    case "site.analytics.realtimeEvents":
      registry.register(
        operation,
        provider((input, signal) =>
          readSiteRealtimeEvents({
            env,
            siteId: siteId(input, configuredSiteId),
            startMs: input.time.range.startMs,
            endExclusiveMs: input.time.range.endExclusiveMs,
            limit: limitField(input),
            signal,
          }),
        ),
      );
      return;
    case "site.analytics.realtimeSessions":
      registry.register(
        operation,
        provider((input, signal) =>
          readSiteRealtimeSessions({
            env,
            siteId: siteId(input, configuredSiteId),
            startMs: input.time.range.startMs,
            endExclusiveMs: input.time.range.endExclusiveMs,
            limit: numberField(input, "limit", 20),
            signal,
          }),
        ),
      );
      return;
    default:
      return;
  }
}

function registerTeamOperation(
  registry: AnalyticsProviderRegistry,
  options: QueryRuntimeOptions,
): void {
  const operation = canonicalQueryOperationFor(options.operation);
  const { env, teamId: configuredTeamId = "" } = options;
  switch (options.operation) {
    case "team.analytics.overview":
      registry.register(
        operation,
        provider(async (input) => {
          const result = await readTeamOverview({
            env,
            teamId: teamId(input, configuredTeamId),
            allowedSiteIds: allowedSiteIds(input),
            window: timeWindow(input.time),
            filters: filters(input),
          });
          return result;
        }),
      );
      return;
    case "team.analytics.timeseries":
      registry.register(
        operation,
        provider(async (input) => {
          const result = await readTeamTimeseries({
            env,
            teamId: teamId(input, configuredTeamId),
            allowedSiteIds: allowedSiteIds(input),
            interval: input.interval as never,
            window: timeWindow(input.time),
            filters: filters(input),
          });
          return result;
        }),
      );
      return;
    case "team.analytics.sites":
      registry.register(
        operation,
        provider(async (input) => {
          const result = await readTeamSites({
            env,
            teamId: teamId(input, configuredTeamId),
            allowedSiteIds: allowedSiteIds(input),
            interval: input.interval as never,
            window: timeWindow(input.time),
            filters: filters(input),
          });
          return result;
        }),
      );
      return;
    case "team.analytics.breakdown":
      registry.register(
        operation,
        provider((input) =>
          readTeamBreakdown({
            env,
            teamId: teamId(input, configuredTeamId),
            allowedSiteIds: allowedSiteIds(input),
            dimension: stringField(input, "dimension"),
            limit: numberField(input, "limit", 20),
            window: timeWindow(input.time),
            filters: filters(input),
          }),
        ),
      );
      return;
    default:
      return;
  }
}

export function createApiV1ProviderRegistry(
  options: QueryRuntimeOptions,
): AnalyticsProviderRegistry {
  const registry = new AnalyticsProviderRegistry();
  if (options.operation.startsWith("site.")) {
    registerSiteOperation(registry, options);
  } else {
    registerTeamOperation(registry, options);
  }
  return registry;
}
