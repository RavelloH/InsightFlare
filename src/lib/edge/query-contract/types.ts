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
  | "dimension"
  | "cross-dimension"
  | "share-trend"
  | "radar"
  | "pages"
  | "pages-dashboard"
  | "referrers"
  | "filter-options"
  | "geo-points"
  | "retention"
  | "performance"
  | "event-summary"
  | "event-trend"
  | "event-types"
  | "event-type-detail"
  | "event-fields"
  | "event-context"
  | "event-records"
  | "event-record-detail"
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

export type QuerySource = "raw" | "rollup" | "mixed";

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
  | { readonly kind: "data-unavailable"; readonly retryable: boolean }
  | { readonly kind: "internal"; readonly operation: QueryOperation };

export type AnalyticsResult<T> =
  | { readonly ok: true; readonly data: T; readonly meta: QueryResultMeta }
  | { readonly ok: false; readonly error: AnalyticsDomainError };

export type CanonicalObject = Readonly<Record<string, unknown>>;

export interface BaseQuery {
  readonly context: QueryContext;
  readonly time: QueryTime;
  readonly filters?: FilterDocument;
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
export type BreakdownQuery = DimensionQuery;
export type CrossBreakdownQuery = DimensionQuery;
export type ShareTrendQuery = TrendQuery;
export type RadarQuery = DimensionQuery;
export type FilterOptionsQuery = DimensionQuery;
export type GeoPointsQuery = BaseQuery;
export type TopPagesQuery = PagesQuery;
export type PagesDashboardQuery = PageQuery;
export type ReferrerQuery = ReferrersQuery;

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

export interface PagesQuery extends BaseQuery {
  readonly limit: number;
  readonly includeDetails: boolean;
}

export interface ReferrersQuery extends BaseQuery {
  readonly limit: number;
  readonly includeFullUrl: boolean;
}

export interface PagesResult {
  readonly items: readonly PageItem[];
}

export interface ReferrersResult {
  readonly items: readonly ReferrerItem[];
}
export type BreakdownResult = CanonicalObject;
export type CrossBreakdownResult = CanonicalObject;
export type ShareTrendResult = CanonicalObject;
export type RadarResult = CanonicalObject;
export type FilterOptionsResult = CanonicalObject;
export type GeoPointsResult = CanonicalObject;
export type TopPagesResult = PagesResult;
export type DashboardPage = CanonicalObject;
export type ReferrerResult = ReferrersResult;

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

export interface AnalyticsQueryService {
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
  readonly events: EventQueryOperations;
  readonly journeys: JourneyQueryOperations;
  readonly analysis: AnalysisQueryOperations;
  readonly team: TeamQueryOperations;
}
