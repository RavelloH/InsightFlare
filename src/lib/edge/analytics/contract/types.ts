import type { ZonedInterval } from "@/lib/analytics/time-zone";
import type { FilterDocument } from "@/lib/filter-contract/filters";
import type {
  FilterScope,
  FilterScopePreference,
} from "@/lib/filter-contract/scope-preference";
import type { FilterAudience } from "@/lib/filter-contract/types";
import type { PageRequest, PageResult, PaginationMeta } from "@/lib/pagination";
import type { RealtimeEvent, RealtimeVisit } from "@/schemas/realtime";

import type { FunnelProgressionScope, FunnelStepV2 } from "./funnel-config";
import type { ScopedFilterPlan } from "./scoped-filter";
/** Branded primitives keep protocol strings and unvalidated numbers out of the domain layer. */
export type Brand<T, Name extends string> = T & {
  readonly __brand: Name;
};
export type EpochMs = Brand<number, "EpochMs">;
export type ReportingTimeZone = Brand<string, "ReportingTimeZone">;
export type SiteId = Brand<string, "SiteId">;
export type TeamId = Brand<string, "TeamId">;
export type CalendarGranularity = ZonedInterval;
export interface TimeRange {
  readonly startMs: EpochMs;
  readonly endExclusiveMs: EpochMs;
}
export interface QueryTime {
  readonly range: TimeRange;
  /** Derived by Filter History Analysis; never authored by the UI or DSL. */
  readonly evaluationRange?: TimeRange;
  /** Derived by Filter History Analysis when complete retained history is needed. */
  readonly fullHistory?: boolean;
  readonly reportingTimeZone: ReportingTimeZone;
  readonly capturedAtMs: EpochMs;
  /** API v1 raw-request identity used to keep preset cursors stable. */
  readonly paginationBinding?: string;
}
/**
 * Unbranded query window used at HTTP and provider boundaries before it is
 * normalized into the canonical QueryTime contract.
 */
export interface QueryWindow {
  /** Inclusive epoch-millisecond query boundary. */
  startMs: number;
  /** Exclusive epoch-millisecond query boundary. */
  endExclusiveMs: number;
  nowMs: number;
  timeZone: string;
  /** Optional API v1 request binding; private/public use parsed semantics. */
  paginationBinding?: string;
}
export type Interval = "minute" | "hour" | "day" | "week" | "month";
export type VisitorListSortKey =
  "firstSeenAt" | "lastSeenAt" | "sessions" | "views";
export type SessionListSortKey = "startedAt" | "durationMs" | "views";
export type EventRecordSortKey = "occurredAt" | "eventName" | "pathname";
export type ClientDimensionKey =
  | "browser"
  | "operatingSystem"
  | "osVersion"
  | "deviceType"
  | "language"
  | "screenSize";
export type UtmDimensionKey =
  "source" | "medium" | "campaign" | "term" | "content";
export interface ListSort<Key extends string> {
  readonly key: Key;
  readonly direction: SortDirection;
}
export const DEFAULT_VISITOR_LIST_SORT: ListSort<VisitorListSortKey> = {
  key: "lastSeenAt",
  direction: "desc",
};
export const DEFAULT_SESSION_LIST_SORT: ListSort<SessionListSortKey> = {
  key: "startedAt",
  direction: "desc",
};
export const DEFAULT_EVENT_RECORD_SORT: ListSort<EventRecordSortKey> = {
  key: "occurredAt",
  direction: "desc",
};
export interface CalendarBucket {
  readonly index: number;
  readonly startMs: EpochMs;
  readonly endExclusiveMs: EpochMs;
}
export interface CalendarBucketPlan {
  readonly granularity: CalendarGranularity;
  readonly reportingTimeZone: ReportingTimeZone;
  readonly buckets: readonly CalendarBucket[];
  readonly hourAligned: boolean;
  readonly truncated: boolean;
}
export type QueryAudience = FilterAudience;
export type QuerySubject =
  | { readonly kind: "site"; readonly siteId: SiteId; readonly teamId?: TeamId }
  | {
      readonly kind: "team";
      readonly teamId: TeamId;
      readonly authorizedSiteIds: readonly SiteId[];
    };
export type QueryOperation =
  | "overview"
  | "trend"
  | "team-sites"
  | "comparison"
  | "comparison-breakdown"
  | "dimension"
  | "cross-dimension"
  | "share-trend"
  | "radar"
  | "pages"
  | "pages-dashboard"
  | "referrers"
  | "channels"
  | "filter-values"
  | "retention"
  | "geo-points"
  | "performance"
  | "realtime"
  | "event-summary"
  | "event-trend"
  | "event-types"
  | "event-type-detail"
  | "event-fields"
  | "event-field-values"
  | "event-context"
  | "event-records"
  | "visitor-events"
  | "visitor-sessions"
  | "session-events"
  | "event-record-detail"
  | "journey-event-detail"
  | "visitors"
  | "visitor-detail"
  | "sessions"
  | "session-detail"
  | "funnel-analysis"
  | "goal-summary"
  | "goal-timeseries"
  | "team-dashboard"
  | "explore";
export type AnalyticsDimension = string;
export type DetailCapability =
  | "page.query"
  | "page.hash"
  | "referrer.url"
  | "precise-location"
  | "event.payload"
  | "event.context"
  | "event.breakdowns"
  | "event.fields"
  | "visitor.trajectory"
  | "session.trajectory";
export interface QueryLimits {
  readonly maxRangeMs?: number;
  readonly maxBuckets?: number;
  readonly maxLimit?: number;
  readonly maxFilterClauses?: number;
  readonly maxCursorBytes?: number;
}
export interface QueryPolicy {
  readonly revision: string;
  readonly audience: QueryAudience;
  readonly allowedOperations: ReadonlySet<QueryOperation>;
  readonly allowedDimensions: ReadonlySet<AnalyticsDimension>;
  readonly allowedFilters: ReadonlySet<string>;
  readonly allowedDetails: ReadonlySet<DetailCapability>;
  readonly limits: QueryLimits;
  /** Whether this operation exposes a cursor-bounded collection. */
  readonly cursorPagination: boolean;
}
export interface QueryContext {
  readonly subject: QuerySubject;
  readonly policy: QueryPolicy;
}
/** Minimum shape required by the application service for every query. */
export interface QueryInput {
  readonly context: QueryContext;
  readonly filters?: FilterDocument;
  /** Missing scope is normalized to Auto at the application boundary. */
  readonly scopePreference?: FilterScopePreference;
  /** Internal compiled plan attached before a provider is invoked. */
  readonly scopePlan?: ScopedFilterPlan;
}
export type SortDirection = "asc" | "desc";
export interface Sort<Key extends string = string> {
  readonly key: Key;
  readonly direction: SortDirection;
}
export type QuerySource = "raw" | "rollup" | "mixed" | "mock";
export interface QueryResultMeta {
  readonly time: QueryTime;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
  readonly filterScope?: {
    readonly requested: FilterScopePreference;
    readonly resolved: FilterScope;
  };
}
export interface InputIssue {
  readonly path: string;
  readonly code: string;
  readonly message?: string;
}
export type AnalyticsDomainError =
  | { readonly kind: "request-cancelled" }
  | { readonly kind: "deadline-exceeded" }
  | { readonly kind: "query-cost-exceeded"; readonly cost: number }
  | { readonly kind: "invalid-input"; readonly issues: readonly InputIssue[] }
  | { readonly kind: "invalid-cursor"; readonly cursorKind: string }
  | {
      readonly kind: "unsupported-operation";
      readonly operation: QueryOperation;
    }
  | { readonly kind: "capability-denied"; readonly capability: string }
  | {
      readonly kind: "not-found";
      readonly resource: "site" | "visitor" | "session" | "event" | "funnel";
    }
  | {
      readonly kind: "range-not-supported";
      readonly reason: "too-wide" | "too-many-buckets";
    }
  | { readonly kind: "comparison-alignment-mismatch" }
  | { readonly kind: "dimension-not-supported"; readonly dimension: string }
  | { readonly kind: "data-unavailable"; readonly retryable: boolean }
  | { readonly kind: "internal"; readonly operation: QueryOperation };
export type AnalyticsResult<T> =
  | { readonly ok: true; readonly data: T; readonly meta: QueryResultMeta }
  | { readonly ok: false; readonly error: AnalyticsDomainError };
export type CanonicalObject = Readonly<Record<string, unknown>>;
export interface BaseQuery extends QueryInput {
  readonly time: QueryTime;
}
export type RealtimeQueryMode =
  "snapshot" | "active-visitors" | "events" | "sessions";
export interface RealtimeQuery extends BaseQuery {
  readonly mode: RealtimeQueryMode;
  readonly siteId?: string;
  readonly limit?: number;
}
export type RealtimeQueryResult =
  | {
      readonly activeNow: number;
      readonly events: readonly RealtimeEvent[];
      readonly visits: readonly RealtimeVisit[];
    }
  | { readonly activeNow: number }
  | { readonly items: readonly RealtimeEvent[] }
  | { readonly items: readonly RealtimeVisit[] };
export type { PageRequest, PageResult, PaginationMeta } from "@/lib/pagination";
export const COMPARISON_METRIC_KEYS = [
  "views",
  "sessions",
  "visitors",
  "bounces",
  "totalDurationMs",
  "durationViews",
  "avgDurationMs",
  "bounceRate",
  "viewsPerSession",
  "events",
] as const;
export type ComparisonMetricKey = (typeof COMPARISON_METRIC_KEYS)[number];
export interface ComparisonDatasetQuery {
  readonly time: QueryTime;
  readonly filters?: FilterDocument;
  readonly scopePreference?: FilterScopePreference;
}
/**
 * The table comparison contract is intentionally smaller than the public
 * comparison-breakdown API.  Overview table endpoints keep their existing
 * route and receive both concrete datasets in one request.
 */
export type OverviewTableMetric = "views" | "visitors" | "sessions";
export type OverviewTableSortBy = "current" | "reference" | "change";
export interface OverviewTableComparisonQuery {
  readonly current: ComparisonDatasetQuery;
  readonly reference: ComparisonDatasetQuery;
  readonly metric: OverviewTableMetric;
  readonly sortBy: OverviewTableSortBy;
  readonly direction: SortDirection;
}
export interface ComparisonQuery {
  readonly context: QueryContext;
  readonly scopePreference?: FilterScopePreference;
  readonly current: ComparisonDatasetQuery;
  readonly reference: ComparisonDatasetQuery;
  readonly metrics: readonly ComparisonMetricKey[];
}
export interface ComparisonTrendQuery extends ComparisonQuery {
  readonly interval: CalendarGranularity;
  readonly trendMetrics: readonly ComparisonMetricKey[];
}
export type ComparisonBreakdownSortBy =
  | "current.views"
  | "current.sessions"
  | "current.visitors"
  | "reference.views"
  | "reference.sessions"
  | "reference.visitors"
  | "change.views.absolute"
  | "change.views.relative"
  | "change.sessions.absolute"
  | "change.sessions.relative"
  | "change.visitors.absolute"
  | "change.visitors.relative"
  | "key";
export interface ComparisonBreakdownQuery extends ComparisonQuery {
  readonly dimension: AnalyticsDimension;
  readonly limit: number;
  readonly sort: {
    readonly by: ComparisonBreakdownSortBy;
    readonly direction: SortDirection;
  };
}
export type ComparisonMetricValue = number | null;
export interface ComparisonMetricDelta {
  readonly absolute: ComparisonMetricValue;
  readonly relative: ComparisonMetricValue;
}
export type ComparisonMetricProjection = Readonly<
  Partial<Record<ComparisonMetricKey, ComparisonMetricValue>>
>;
export type ComparisonDelta = Readonly<
  Partial<Record<ComparisonMetricKey, ComparisonMetricDelta>>
>;
export interface ComparisonRawMetrics extends OverviewMetrics {
  readonly events: number;
}
export interface ComparisonRawTrendPoint extends ComparisonRawMetrics {
  readonly bucket: number;
  readonly timestampMs: EpochMs;
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
}
export interface ComparisonRawTrendResult {
  readonly interval: CalendarGranularity;
  readonly points: readonly ComparisonRawTrendPoint[];
}
export interface ComparisonRawBreakdownItem extends ComparisonRawMetrics {
  readonly key: string;
  readonly label: string;
}
export interface ComparisonRawBreakdownResult {
  readonly items: readonly ComparisonRawBreakdownItem[];
  readonly complete: boolean;
}
export interface ComparisonResult {
  readonly current: ComparisonMetricProjection;
  readonly reference: ComparisonMetricProjection;
  readonly change: ComparisonDelta;
}
export interface ComparisonTrendPoint {
  readonly index: number;
  readonly current: {
    readonly fromMs: EpochMs;
    readonly toMs: EpochMs;
    readonly metrics: ComparisonMetricProjection;
  };
  readonly reference: {
    readonly fromMs: EpochMs;
    readonly toMs: EpochMs;
    readonly metrics: ComparisonMetricProjection;
  };
  readonly change: ComparisonDelta;
}
export interface ComparisonTrendResult {
  readonly interval: CalendarGranularity;
  readonly points: readonly ComparisonTrendPoint[];
}
export interface ComparisonBreakdownItem {
  readonly key: string;
  readonly label: string;
  readonly current: ComparisonMetricProjection;
  readonly reference: ComparisonMetricProjection;
  readonly change: ComparisonDelta;
}
export interface ComparisonBreakdownResult {
  readonly items: readonly ComparisonBreakdownItem[];
  readonly complete: boolean;
  readonly dimension?: AnalyticsDimension;
}
export interface DimensionQuery extends BaseQuery {
  readonly dimension?: AnalyticsDimension;
  readonly limit?: number;
  readonly page?: PageRequest;
  readonly sort?: Sort;
  readonly search?: string;
  readonly comparison?: OverviewTableComparisonQuery;
}
export interface PageQuery extends BaseQuery {
  readonly page?: PageRequest;
  readonly sort?: Sort;
}
export type PagesDashboardMetric =
  | "views"
  | "visitors"
  | "sessions"
  | "bounceRate"
  | "pagesPerSession"
  | "avgDurationMs";
export type PagesDashboardSortBy = "current" | "reference" | "change";
export interface PagesDashboardComparisonQuery {
  readonly current: ComparisonDatasetQuery;
  readonly reference: ComparisonDatasetQuery;
  readonly metric: PagesDashboardMetric;
  readonly sortBy: PagesDashboardSortBy;
  readonly direction: SortDirection;
}
/**
 * The pages dashboard has its own list contract.  Keep the API v1 `PagesQuery`
 * above unchanged while allowing the dashboard list to grow comparison-aware
 * search and sorting independently.
 */
export interface PagesDashboardQuery extends BaseQuery {
  readonly interval: Interval;
  readonly page?: PageRequest;
  readonly search?: string;
  readonly sort?: Sort<PagesDashboardMetric>;
  readonly comparison?: PagesDashboardComparisonQuery;
  readonly audience?: QueryAudience;
}
export interface OverviewQuery extends BaseQuery {
  readonly previousTime?: QueryTime;
  readonly detailInterval?: CalendarGranularity;
}
export interface TrendQuery extends BaseQuery {
  readonly interval: CalendarGranularity;
}
export interface BreakdownQuery extends BaseQuery {
  readonly dimension: AnalyticsDimension;
  readonly limit: number;
  readonly sort?: Sort<"views" | "sessions" | "visitors" | "key">;
}
export interface CrossBreakdownQuery extends BaseQuery {
  readonly primaryDimension: AnalyticsDimension;
  readonly secondaryDimension: AnalyticsDimension;
  readonly primaryLimit: number;
  readonly secondaryLimit: number;
}
export type ShareTrendQuery = TrendQuery;
export type RadarQuery = DimensionQuery;
export type FilterOptionsQuery = DimensionQuery;
export interface FilterValuesQuery extends BaseQuery {
  readonly field: string;
  readonly search?: string;
  readonly limit?: number;
  readonly page?: PageRequest;
}
export interface EventFieldValuesQuery extends BaseQuery {
  readonly eventName: string;
  readonly fieldPath: string;
  readonly fieldValueType: string;
  readonly search?: string;
  readonly limit?: number;
  readonly page?: PageRequest;
}
export type GeoPointsQuery = BaseQuery;
export type TopPagesQuery = PagesQuery;
export type ReferrerQuery = ReferrersQuery;
export type ChannelQuery = ChannelsQuery;
export interface OverviewMetrics {
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
  readonly bounces: number;
  readonly totalDurationMs: number;
  readonly durationViews: number;
}
export interface OverviewResult {
  readonly current: OverviewMetrics;
  readonly previous?: OverviewMetrics;
  readonly detail?: TrendResult;
}
export interface TrendPoint extends OverviewMetrics {
  readonly bucket: number;
  readonly timestampMs: EpochMs;
}
export interface TrendResult {
  readonly interval: CalendarGranularity;
  readonly points: readonly TrendPoint[];
}
export interface PageItem {
  readonly pathname: string;
  readonly query: string;
  readonly hash: string;
  readonly views: number;
  readonly sessions: number;
}
export interface ReferrerItem {
  readonly referrer: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}
export interface ChannelItem {
  readonly channel: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}
export interface PagesQuery extends BaseQuery {
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly page?: PageRequest;
}
export interface ReferrersQuery extends BaseQuery {
  readonly limit: number;
  readonly includeFullUrl: boolean;
  readonly search?: string;
  readonly page?: PageRequest;
  readonly sort?: "views" | "visitors";
  readonly direction?: SortDirection;
  readonly variant?: "list" | "summary";
  readonly topN?: number;
}
export interface ChannelsQuery extends BaseQuery {
  readonly limit: number;
}
export interface PagesResult {
  readonly items: readonly PageItem[];
  readonly pagination: PaginationMeta;
}
export interface ReferrersResult {
  readonly items: readonly ReferrerItem[];
  readonly pagination: PaginationMeta;
}
export interface ReferrerSummaryResult {
  readonly totalViews: number;
  readonly directViews: number;
  readonly externalViews: number;
  readonly uniqueDomains: number;
  readonly uniqueLinks: number;
  readonly truncated: boolean;
  readonly topSources: readonly {
    readonly referrer: string;
    readonly views: number;
  }[];
}
export interface ChannelsResult {
  readonly items: readonly ChannelItem[];
}
export type FunnelStepConfig = FunnelStepV2;
export interface FunnelDefinition {
  readonly id: string;
  readonly siteId: string;
  readonly name: string;
  readonly filterDslVersion: 1;
  readonly progressionScope: FunnelProgressionScope;
  readonly conversionWindowMs: number | null;
  readonly steps: FunnelStepV2[];
  readonly semanticFingerprint: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface FunnelAnalysisStep {
  readonly stepId: string;
  readonly index: number;
  readonly sessions: number;
  readonly visitors: number;
  readonly progression: {
    readonly count: number;
    readonly conversionRate: number;
    readonly stepConversionRate: number;
    readonly dropOffCount: number;
    readonly dropOffRate: number;
  };
}
export interface FunnelAnalysis {
  readonly progressionScope: FunnelProgressionScope;
  readonly steps: FunnelAnalysisStep[];
  readonly summary: {
    readonly totalProgressions: number;
    readonly convertedProgressions: number;
    readonly overallConversionRate: number;
    readonly largestDropOffStepIndex: number | null;
  };
}
export interface RetentionResult {
  readonly granularity: CalendarGranularity;
  readonly cohorts: readonly {
    readonly bucket: number;
    readonly size: number;
    readonly periods: readonly {
      readonly index: number;
      readonly visitors: number;
      readonly rate: number;
    }[];
  }[];
}
export type PerformanceMetricKey = "ttfb" | "fcp" | "lcp" | "cls" | "inp";
export interface PerformanceSummaryRow {
  readonly avg: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p95: number | null;
  readonly samples: number;
}
export interface PerformanceTrendPointRow {
  readonly bucket: number;
  readonly timestampMs: number;
  readonly avg: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p95: number | null;
  readonly samples: number;
}
export interface PerformanceRouteMetricRow {
  readonly avg: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p95: number | null;
  readonly samples: number;
}
export interface PerformanceRouteRow {
  readonly pathname: string;
  readonly views: number;
  readonly metrics: Record<PerformanceMetricKey, PerformanceRouteMetricRow>;
}
export interface PerformanceCountryRow {
  readonly country: string;
  readonly views: number;
  readonly metrics: Record<PerformanceMetricKey, PerformanceRouteMetricRow>;
}
export interface PerformanceDashboardResult {
  readonly summaries: Record<PerformanceMetricKey, PerformanceSummaryRow>;
  readonly trends: Record<
    PerformanceMetricKey,
    readonly PerformanceTrendPointRow[]
  >;
  readonly routes: readonly PerformanceRouteRow[];
  readonly countries: readonly PerformanceCountryRow[];
}
export type PerformanceQueryMode =
  "dashboard" | "summary" | "timeseries" | "breakdown";
export type PerformanceQuery =
  | (BaseQuery & {
      readonly mode: "dashboard";
      readonly interval: Interval;
      readonly limit?: number;
    })
  | (BaseQuery & { readonly mode: "summary" })
  | (BaseQuery & {
      readonly mode: "timeseries";
      readonly interval: Interval;
    })
  | (BaseQuery & {
      readonly mode: "breakdown";
      readonly dimension: string;
      readonly metric: PerformanceMetricKey;
      readonly limit?: number;
    });
export interface PerformanceSummaryResult {
  readonly metrics: Record<PerformanceMetricKey, PerformanceSummaryRow>;
}
export interface PerformanceTimeseriesResult {
  readonly interval: Interval;
  readonly series: Record<
    PerformanceMetricKey,
    readonly (PerformanceSummaryRow & { readonly timestamp: string })[]
  >;
}
export interface PerformanceBreakdownResult {
  readonly dimension: string;
  readonly metric: PerformanceMetricKey;
  readonly items: readonly (PerformanceRouteMetricRow & {
    readonly key: string;
    readonly label: string;
    readonly views: number;
  })[];
}
export type PerformanceQueryResult =
  | PerformanceDashboardResult
  | PerformanceSummaryResult
  | PerformanceTimeseriesResult
  | PerformanceBreakdownResult;
export interface BreakdownItem {
  readonly key: string;
  readonly label: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}
export interface BreakdownResult {
  readonly items: readonly BreakdownItem[];
}
export interface CrossBreakdownRow extends BreakdownItem {
  readonly cells: readonly BreakdownItem[];
}
export interface CrossBreakdownResult {
  readonly columns: readonly BreakdownItem[];
  readonly rows: readonly CrossBreakdownRow[];
  readonly totalVisitors: number;
}
export type ShareTrendResult = CanonicalObject;
export type RadarResult = CanonicalObject;
export type FilterOptionsResult = CanonicalObject;
export interface FilterValueOption {
  readonly value: string | number | boolean | null;
  readonly label: string;
  readonly occurrences: number;
}
export interface FilterValuesResult {
  readonly field: string;
  readonly data: {
    readonly items: readonly FilterValueOption[];
    readonly pagination: PaginationMeta;
  };
}
export interface GeoPointsResult {
  readonly points: readonly {
    readonly latitude: number;
    readonly longitude: number;
    readonly timestampMs: number;
    readonly country: string;
    readonly region: string;
    readonly regionCode: string;
    readonly city: string;
    readonly pointCount: number;
  }[];
  readonly countryCounts: readonly {
    readonly country: string;
    readonly views: number;
    readonly sessions: number;
    readonly visitors: number;
  }[];
  readonly regionCounts: readonly {
    readonly value: string;
    readonly views: number;
    readonly sessions: number;
    readonly visitors: number;
  }[];
  readonly cityCounts: readonly {
    readonly value: string;
    readonly views: number;
    readonly sessions: number;
    readonly visitors: number;
  }[];
}
export type TopPagesResult = PagesResult;
export type DashboardPage = CanonicalObject;
export type ReferrerResult = ReferrersResult;
export type ChannelResult = ChannelsResult;
export type EventQuery = BaseQuery;
export type JourneyQuery = BaseQuery;
export type AnalysisQuery = BaseQuery;
export type TeamQuery = BaseQuery;
export interface EventQueryOperations {
  summary(input: EventQuery): Promise<AnalyticsResult<CanonicalObject>>;
  trend(input: EventQuery): Promise<AnalyticsResult<CanonicalObject>>;
  records(
    input: PageQuery,
  ): Promise<AnalyticsResult<PageResult<CanonicalObject>>>;
}
export interface JourneyQueryOperations {
  list(input: PageQuery): Promise<AnalyticsResult<PageResult<CanonicalObject>>>;
  detail(input: JourneyQuery): Promise<AnalyticsResult<CanonicalObject>>;
}
export interface AnalysisQueryOperations {
  retention(input: AnalysisQuery): Promise<AnalyticsResult<CanonicalObject>>;
  funnel(input: AnalysisQuery): Promise<AnalyticsResult<CanonicalObject>>;
}
export interface TeamQueryOperations {
  dashboard(input: TeamQuery): Promise<AnalyticsResult<CanonicalObject>>;
}
export interface TypedQueryOperations {
  readonly overview: {
    get(input: OverviewQuery): Promise<AnalyticsResult<OverviewResult>>;
    trend(input: TrendQuery): Promise<AnalyticsResult<TrendResult>>;
  };
  readonly dimensions: {
    breakdown(input: BreakdownQuery): Promise<AnalyticsResult<BreakdownResult>>;
    crossBreakdown(
      input: CrossBreakdownQuery,
    ): Promise<AnalyticsResult<CrossBreakdownResult>>;
    shareTrend(
      input: ShareTrendQuery,
    ): Promise<AnalyticsResult<ShareTrendResult>>;
    radar(input: RadarQuery): Promise<AnalyticsResult<RadarResult>>;
    filterOptions(
      input: FilterOptionsQuery,
    ): Promise<AnalyticsResult<FilterOptionsResult>>;
    geoPoints(input: GeoPointsQuery): Promise<AnalyticsResult<GeoPointsResult>>;
  };
  readonly pages: {
    top(input: TopPagesQuery): Promise<AnalyticsResult<TopPagesResult>>;
    dashboard(
      input: PagesDashboardQuery,
    ): Promise<AnalyticsResult<PageResult<DashboardPage>>>;
    referrers(input: ReferrerQuery): Promise<AnalyticsResult<ReferrerResult>>;
  };
  readonly channels: {
    list(input: ChannelsQuery): Promise<AnalyticsResult<ChannelsResult>>;
  };
  readonly events: EventQueryOperations;
  readonly journeys: JourneyQueryOperations;
  readonly analysis: AnalysisQueryOperations;
  readonly team: TeamQueryOperations;
}
