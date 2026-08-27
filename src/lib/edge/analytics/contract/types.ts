import type { ZonedInterval } from "@/lib/dashboard/time-zone";

import type { FilterDocument } from "./filters";

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
  readonly reportingTimeZone: ReportingTimeZone;
  readonly capturedAtMs: EpochMs;
}

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

export type QueryAudience = "private-dashboard" | "public-share" | "api-v1";

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
  | "event-record-detail"
  | "journey-event-detail"
  | "visitors"
  | "visitor-detail"
  | "sessions"
  | "session-detail"
  | "funnel-analysis"
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
  readonly maxOffset?: number;
  readonly maxFilterClauses?: number;
  readonly maxCursorBytes?: number;
}

export type PaginationKind = "none" | "offset" | "keyset";

export interface QueryPolicy {
  readonly revision: string;
  readonly audience: QueryAudience;
  readonly allowedOperations: ReadonlySet<QueryOperation>;
  readonly allowedDimensions: ReadonlySet<AnalyticsDimension>;
  readonly allowedFilters: ReadonlySet<string>;
  readonly allowedDetails: ReadonlySet<DetailCapability>;
  readonly limits: QueryLimits;
  readonly allowedPagination: ReadonlySet<PaginationKind>;
}

export interface QueryContext {
  readonly subject: QuerySubject;
  readonly policy: QueryPolicy;
}

/** Minimum shape required by the application service for every query. */
export interface QueryInput {
  readonly context: QueryContext;
  readonly filters?: FilterDocument;
}

export type SortDirection = "asc" | "desc";

export interface Sort<Key extends string = string> {
  readonly key: Key;
  readonly direction: SortDirection;
}

export interface OffsetPageRequest {
  readonly kind: "offset";
  readonly offset: number;
  readonly limit: number;
}

export interface KeysetPageRequest<Cursor> {
  readonly kind: "keyset";
  readonly limit: number;
  readonly after: Cursor | null;
}

export interface OffsetPage<T> {
  readonly items: readonly T[];
  readonly page: {
    readonly kind: "offset";
    readonly offset: number;
    readonly limit: number;
    readonly total: number;
  };
}

export interface KeysetPage<T, Cursor> {
  readonly items: readonly T[];
  readonly page: {
    readonly kind: "keyset";
    readonly limit: number;
    readonly next: Cursor | null;
    readonly hasMore: boolean;
  };
}

export type QuerySource = "raw" | "rollup" | "mixed" | "mock";

export interface QueryResultMeta {
  readonly time: QueryTime;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
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
}

export interface ComparisonQuery {
  readonly context: QueryContext;
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
  readonly sort?: Sort;
}

export interface PageQuery extends BaseQuery {
  readonly pagination?: OffsetPageRequest | KeysetPageRequest<CanonicalObject>;
  readonly sort?: Sort;
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
  readonly limit: number;
}
export interface EventFieldValuesQuery extends BaseQuery {
  readonly eventName: string;
  readonly fieldPath: string;
  readonly fieldValueType: string;
  readonly search?: string;
  readonly limit: number;
}
export type GeoPointsQuery = BaseQuery;
export type TopPagesQuery = PagesQuery;
export type PagesDashboardQuery = PageQuery;
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
}

export interface ReferrersQuery extends BaseQuery {
  readonly limit: number;
  readonly includeFullUrl: boolean;
}

export interface ChannelsQuery extends BaseQuery {
  readonly limit: number;
}

export interface PagesResult {
  readonly items: readonly PageItem[];
}

export interface ReferrersResult {
  readonly items: readonly ReferrerItem[];
}

export interface ChannelsResult {
  readonly items: readonly ChannelItem[];
}

export interface FunnelStepConfig {
  readonly type: "pageview" | "event";
  readonly value: string;
}

export interface FunnelDefinition {
  readonly id: string;
  readonly siteId: string;
  readonly name: string;
  readonly steps: FunnelStepConfig[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface FunnelAnalysisStep {
  readonly index: number;
  readonly label: string;
  readonly type: FunnelStepConfig["type"];
  readonly sessions: number;
  readonly visitors: number;
  readonly conversionRate: number;
  readonly stepConversionRate: number;
  readonly dropOffSessions: number;
  readonly dropOffRate: number;
}

export interface FunnelAnalysis {
  readonly steps: FunnelAnalysisStep[];
  readonly summary: {
    readonly totalSessions: number;
    readonly convertedSessions: number;
    readonly totalVisitors: number;
    readonly convertedVisitors: number;
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
  readonly data: readonly FilterValueOption[];
}
export type GeoPointsResult = CanonicalObject;
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
  ): Promise<AnalyticsResult<KeysetPage<CanonicalObject, CanonicalObject>>>;
}

export interface JourneyQueryOperations {
  list(
    input: PageQuery,
  ): Promise<AnalyticsResult<KeysetPage<CanonicalObject, CanonicalObject>>>;
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
    ): Promise<AnalyticsResult<OffsetPage<DashboardPage>>>;
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
