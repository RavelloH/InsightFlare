import type {
  AnalyticsResult,
  BreakdownResult,
  ChannelsResult,
  CrossBreakdownResult,
  FilterValuesResult,
  FunnelAnalysis,
  FunnelDefinition,
  OverviewResult,
  PagesResult,
  ReferrersResult,
  RetentionResult,
  TrendResult,
} from "@/lib/edge/analytics/contract";
import {
  ANALYTICS_DIMENSIONS,
  ANALYTICS_METRICS,
} from "@/lib/edge/analytics/contract/catalog";
export interface TeamSitesResult {
  readonly sites: readonly unknown[];
}

export type AnalyticsSubjectKind = "site" | "team";
export type AnalyticsAudience = "api-v1" | "private-dashboard" | "public-share";

export interface AnalyticsOperationDescriptor<Id extends string, Result> {
  readonly id: Id;
  readonly subjectKinds: readonly AnalyticsSubjectKind[];
  readonly audiences: readonly AnalyticsAudience[];
  readonly cache: "aggregate" | "bypass";
  readonly operationRevision: string;
  readonly schema: {
    readonly metrics: readonly string[];
    readonly dimensions: readonly string[];
  };
  readonly result: (_result: AnalyticsResult<Result>) => void;
}

function operation<Id extends string, Result>(
  descriptor: AnalyticsOperationDescriptor<Id, Result>,
): AnalyticsOperationDescriptor<Id, Result> {
  return descriptor;
}

export const analyticsOperationRegistry = [
  operation({
    id: "site.analytics.overview",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard", "public-share"],
    cache: "aggregate",
    operationRevision: "1",
    schema: {
      metrics: ANALYTICS_METRICS,
      dimensions: ANALYTICS_DIMENSIONS,
    },
    result: (_result: AnalyticsResult<OverviewResult>) => undefined,
  }),
  operation({
    id: "site.analytics.comparison",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "2",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<unknown>) => undefined,
  }),
  operation({
    id: "site.analytics.comparisonBreakdown",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "2",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<BreakdownResult>) => undefined,
  }),
  operation({
    id: "team.analytics.comparison",
    subjectKinds: ["team"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "2",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<unknown>) => undefined,
  }),
  operation({
    id: "team.analytics.comparisonBreakdown",
    subjectKinds: ["team"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "2",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<BreakdownResult>) => undefined,
  }),
  operation({
    id: "team.analytics.overview",
    subjectKinds: ["team"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: {
      metrics: ANALYTICS_METRICS,
      dimensions: ANALYTICS_DIMENSIONS,
    },
    result: (_result: AnalyticsResult<OverviewResult>) => undefined,
  }),
  operation({
    id: "site.analytics.timeseries",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard", "public-share"],
    cache: "aggregate",
    operationRevision: "1",
    schema: {
      metrics: ANALYTICS_METRICS,
      dimensions: ANALYTICS_DIMENSIONS,
    },
    result: (_result: AnalyticsResult<TrendResult>) => undefined,
  }),
  operation({
    id: "team.analytics.timeseries",
    subjectKinds: ["team"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: {
      metrics: ANALYTICS_METRICS,
      dimensions: ANALYTICS_DIMENSIONS,
    },
    result: (_result: AnalyticsResult<TrendResult>) => undefined,
  }),
  operation({
    id: "team.analytics.sites",
    subjectKinds: ["team"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: {
      metrics: ANALYTICS_METRICS,
      dimensions: ANALYTICS_DIMENSIONS,
    },
    result: (_result: AnalyticsResult<TeamSitesResult>) => undefined,
  }),
  operation({
    id: "team.analytics.breakdown",
    subjectKinds: ["team"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<BreakdownResult>) => undefined,
  }),
  operation({
    id: "site.analytics.breakdown",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard", "public-share"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<BreakdownResult>) => undefined,
  }),
  operation({
    id: "site.analytics.crossBreakdown",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<CrossBreakdownResult>) => undefined,
  }),
  operation({
    id: "site.analytics.pages",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<PagesResult>) => undefined,
  }),
  operation({
    id: "site.analytics.referrers",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<ReferrersResult>) => undefined,
  }),
  operation({
    id: "site.analytics.channels",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<ChannelsResult>) => undefined,
  }),
  operation({
    id: "site.analytics.filterValues",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<FilterValuesResult>) => undefined,
  }),
  operation({
    id: "site.analytics.retentionCohorts",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<RetentionResult>) => undefined,
  }),
  operation({
    id: "site.analytics.funnelAnalysis",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        funnel: FunnelDefinition;
        analysis: FunnelAnalysis;
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.performanceSummary",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<{ metrics: unknown }>) => undefined,
  }),
  operation({
    id: "site.analytics.performanceTimeseries",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<{ interval: string; series: unknown }>) =>
      undefined,
  }),
  operation({
    id: "site.analytics.performanceBreakdown",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        dimension: string;
        metric: string;
        items: unknown[];
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.eventsSummary",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<{ summary: unknown; cards: unknown }>) =>
      undefined,
  }),
  operation({
    id: "site.analytics.eventsTimeseries",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        interval: string;
        series: readonly unknown[];
        data: readonly unknown[];
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.eventsSearch",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{ items: readonly unknown[]; page: unknown }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.eventDetail",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        event: unknown;
        context: unknown;
        eventData: unknown;
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.journeyEventDetail",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        event: unknown;
        context: unknown;
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.eventTypes",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{ items: readonly unknown[]; page: unknown }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.eventTypeDetail",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        eventName: string;
        summary: unknown;
        trend: unknown;
        breakdowns: unknown;
        cards: unknown;
        fields: readonly unknown[];
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.eventFields",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        eventName: string;
        fields: readonly unknown[];
        page: unknown;
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.eventFieldValues",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "aggregate",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        eventName: string;
        fieldPath: string;
        fieldValueType: string;
        items: readonly unknown[];
        page: unknown;
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.visitorDetail",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        visitor: unknown;
        metrics: unknown;
        sessions: readonly unknown[];
        events: readonly unknown[];
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.sessionDetail",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        session: unknown;
        locationPoints: readonly unknown[];
        events: readonly unknown[];
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.visitorsSearch",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{ items: readonly unknown[]; page: unknown }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.sessionsSearch",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{ items: readonly unknown[]; page: unknown }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.visitorEvents",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<{ items: readonly unknown[] }>) =>
      undefined,
  }),
  operation({
    id: "site.analytics.visitorSessions",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<{ items: readonly unknown[] }>) =>
      undefined,
  }),
  operation({
    id: "site.analytics.sessionEvents",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<{ items: readonly unknown[] }>) =>
      undefined,
  }),
  operation({
    id: "site.analytics.realtimeSnapshot",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (
      _result: AnalyticsResult<{
        activeNow: number;
        events: readonly unknown[];
        visits: readonly unknown[];
      }>,
    ) => undefined,
  }),
  operation({
    id: "site.analytics.realtimeActiveVisitors",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<{ activeNow: number }>) => undefined,
  }),
  operation({
    id: "site.analytics.realtimeEvents",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<{ items: readonly unknown[] }>) =>
      undefined,
  }),
  operation({
    id: "site.analytics.realtimeSessions",
    subjectKinds: ["site"],
    audiences: ["api-v1", "private-dashboard"],
    cache: "bypass",
    operationRevision: "1",
    schema: { metrics: ANALYTICS_METRICS, dimensions: ANALYTICS_DIMENSIONS },
    result: (_result: AnalyticsResult<{ items: readonly unknown[] }>) =>
      undefined,
  }),
] as const;

export type AnalyticsOperationId =
  (typeof analyticsOperationRegistry)[number]["id"];

export function analyticsOperationById(
  id: string,
): (typeof analyticsOperationRegistry)[number] | undefined {
  return analyticsOperationRegistry.find((operation) => operation.id === id);
}
