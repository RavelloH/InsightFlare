import type { PageRequest, PaginationMeta } from "@/lib/pagination";

import type { JourneyAnalysisContext } from "./journey-analysis";
import type {
  CanonicalEventContextResult,
  CanonicalEventFieldsResult,
  CanonicalEventFieldValuesResult,
  CanonicalEventRecordDetailResult,
  CanonicalEventRecordPageResult,
  CanonicalEventSummaryResult,
  CanonicalEventTrendResult,
  CanonicalEventTypeDetailResult,
  CanonicalEventTypeResult,
  CanonicalGoalSummaryResult,
  CanonicalGoalTimeseriesResult,
  CanonicalJourneyEventDetailResult,
  CanonicalJourneyEventPage,
  CanonicalJourneySessionPage,
  CanonicalJourneyVisitorPage,
  CanonicalSessionDetailResult,
  CanonicalVisitorDetailResult,
} from "./operation-results";
import type { PagesDashboardResult } from "./pages-dashboard";
import type { TeamSitesQueryResult } from "./team-results";
import type { TeamDashboardData } from "./team-results";
import type {
  BaseQuery,
  BreakdownResult,
  CalendarGranularity,
  ChannelsResult,
  ClientDimensionKey,
  ComparisonBreakdownQuery,
  ComparisonBreakdownResult,
  ComparisonDatasetQuery,
  ComparisonMetricKey,
  ComparisonQuery,
  ComparisonResult,
  ComparisonTrendQuery,
  ComparisonTrendResult,
  CrossBreakdownQuery,
  CrossBreakdownResult,
  EventRecordSortKey,
  FilterValuesQuery,
  FilterValuesResult,
  FunnelAnalysis,
  FunnelDefinition,
  GeoPointsResult,
  Interval,
  ListSort,
  OverviewQuery,
  OverviewResult,
  OverviewTableComparisonQuery,
  PageQuery,
  PageResult,
  PagesDashboardQuery,
  PagesQuery,
  PagesResult,
  PerformanceQuery,
  PerformanceQueryResult,
  QueryOperation,
  RealtimeQuery,
  RealtimeQueryResult,
  ReferrersQuery,
  ReferrersResult,
  ReferrerSummaryResult,
  RetentionResult,
  SessionListSortKey,
  Sort,
  TrendQuery,
  TrendResult,
  UtmDimensionKey,
  VisitorListSortKey,
} from "./types";

/**
 * Query/result contracts at the canonical operation boundary.
 *
 * The catch-all entries below are individually named legacy contracts. New
 * providers should add a concrete query/result pair instead of extending
 * BaseQuery or CanonicalObject at their boundary.
 */
export interface DimensionOverviewTabQuery extends BaseQuery {
  readonly mode: "overview-tab";
  readonly tab: string;
  readonly teamId?: string;
  readonly allowedSiteIds?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
  readonly search?: string;
  readonly comparison?: OverviewTableComparisonQuery;
  readonly current?: ComparisonDatasetQuery;
  readonly reference?: ComparisonDatasetQuery;
}

export interface OverviewTabResult {
  readonly data: {
    readonly items: readonly OverviewTabItem[];
    readonly pagination: PaginationMeta;
  };
}

export interface OverviewTabItem {
  readonly key?: string;
  readonly value?: string;
  readonly label?: string;
  readonly views?: number;
  readonly sessions?: number;
  readonly visitors?: number;
  readonly occurrences?: number;
  readonly reference?: object;
  readonly change?: object;
}

export interface DimensionBreakdownQuery extends BaseQuery {
  readonly mode: "breakdown";
  readonly dimension: string;
  readonly teamId?: string;
  readonly allowedSiteIds?: readonly string[];
  readonly limit?: number;
  readonly page?: PageRequest;
  readonly sort?: Sort;
  readonly search?: string;
  readonly comparison?: object;
}

export type CanonicalDimensionQuery =
  DimensionBreakdownQuery | DimensionOverviewTabQuery;
export type CanonicalDimensionResult = BreakdownResult | OverviewTabResult;

export interface ChannelListQuery extends BaseQuery {
  readonly mode: "list";
  readonly limit: number;
}

export interface ChannelOverviewTabQuery extends BaseQuery {
  readonly mode: "overview-tab";
  readonly tab: "source.channel";
  readonly limit?: number;
  readonly cursor?: string;
  readonly direction?: "asc" | "desc";
  readonly search?: string;
  readonly sort?: string;
  readonly comparison?: OverviewTableComparisonQuery;
  readonly current?: ComparisonDatasetQuery;
  readonly reference?: ComparisonDatasetQuery;
}

export type CanonicalChannelsQuery = ChannelListQuery | ChannelOverviewTabQuery;
export type CanonicalChannelsResult = ChannelsResult | OverviewTabResult;

export type CanonicalPagesQuery = Omit<PagesQuery, "limit"> & {
  readonly variant?: "list" | "tabs";
  readonly includeTabs?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
};
export interface CanonicalPageTabs {
  readonly path: readonly CanonicalPageTabItem[];
  readonly title: readonly CanonicalPageTabItem[];
  readonly hostname: readonly CanonicalPageTabItem[];
  readonly entry: readonly CanonicalPageTabItem[];
  readonly exit: readonly CanonicalPageTabItem[];
}
export interface CanonicalPageTabItem {
  readonly value: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}
export type CanonicalPagesWithTabsResult = {
  readonly pages: PagesResult;
  readonly tabs: CanonicalPageTabs;
};
export type CanonicalPageTabsResult = CanonicalPageTabs;
export type CanonicalPagesResult =
  PagesResult | CanonicalPagesWithTabsResult | CanonicalPageTabsResult;
export type CanonicalFunnelAnalysisResult =
  | PageResult<FunnelDefinition>
  | {
      readonly funnel: FunnelDefinition | null;
      readonly analysis: FunnelAnalysis | null;
    };

export interface CanonicalPagesDashboardResult {
  readonly items: PagesResult["items"];
  readonly pagination: PagesResult["pagination"];
  readonly interval: CalendarGranularity;
}

export type CanonicalReferrersQuery = ReferrersQuery & {
  readonly mode?: "list" | "summary";
};
export type CanonicalReferrersResult = ReferrersResult | ReferrerSummaryResult;

export interface RetentionQuery extends BaseQuery {
  readonly granularity?: Interval;
}

export type LegacyEventQuery = BaseQuery & {
  readonly page?: PageRequest;
  readonly eventId?: string;
  readonly eventName?: string;
  readonly fieldPath?: string;
  readonly fieldValueType?: string;
  readonly eventKind?: "pageview" | "session_start" | "leave";
  readonly visitorId?: string;
  readonly sessionId?: string;
  readonly siteId?: string;
  readonly search?: string;
  readonly cursor?: string;
  readonly selectedKeys?: readonly string[];
  readonly includeContext?: boolean;
  readonly includeBreakdowns?: boolean;
  readonly timeZone?: string;
  readonly limit?: number;
  readonly interval?: CalendarGranularity;
  readonly tab?: string;
  readonly sort?: ListSort<EventRecordSortKey>;
  readonly direction?: "asc" | "desc";
  readonly comparison?: object;
  readonly current?: object;
  readonly reference?: object;
};
export type LegacyJourneyQuery = BaseQuery & {
  readonly page?: PageRequest;
  readonly visitorId?: string;
  readonly sessionId?: string;
  readonly goalId?: string;
  readonly funnelId?: string;
  readonly analysis?: object;
  readonly analysisContext?: JourneyAnalysisContext;
  readonly limit?: number;
  readonly cursor?: string;
  readonly search?: string;
  readonly timeZone?: string;
  readonly sort?: ListSort<VisitorListSortKey | SessionListSortKey>;
};
export type LegacyAnalysisQuery = BaseQuery & {
  readonly goalId?: string;
  readonly funnelId?: string;
  readonly interval?: Interval;
  readonly page?: PageRequest;
};
export type LegacyTeamDashboardQuery = BaseQuery & {
  readonly teamId?: string;
  readonly allowedSiteIds?: readonly string[];
  readonly interval?: Interval;
};
export type CanonicalShareTrendQuery =
  | (BaseQuery & {
      readonly variant:
        "browser" | "browser-engine" | "referrer" | "referrer-channel";
      readonly interval: Interval;
      readonly limit?: number;
    })
  | (BaseQuery & {
      readonly variant: "client";
      readonly interval: Interval;
      readonly dimension: ClientDimensionKey;
      readonly limit?: number;
    })
  | (BaseQuery & {
      readonly variant: "utm";
      readonly interval: Interval;
      readonly dimension: UtmDimensionKey;
      readonly limit?: number;
    });
export type CanonicalRadarQuery =
  | (BaseQuery & { readonly variant?: "browser" })
  | (BaseQuery & { readonly variant: "referrer"; readonly limit?: number })
  | (BaseQuery & {
      readonly variant: "version";
      readonly browserLimit?: number;
      readonly versionLimit?: number;
    });
export type CanonicalRadarResult =
  | readonly {
      readonly browser: string;
      readonly sessions: number;
      readonly bounces: number;
      readonly avgDurationMs: number;
      readonly avgDepth: number;
      readonly visitors: number;
      readonly returningVisitors: number;
      readonly avgFrequency: number;
      readonly trafficShare: number;
    }[]
  | readonly {
      readonly referrer: string;
      readonly sessions: number;
      readonly bounces: number;
      readonly avgDurationMs: number;
      readonly avgDepth: number;
      readonly visitors: number;
      readonly returningVisitors: number;
      readonly avgFrequency: number;
      readonly trafficShare: number;
    }[]
  | readonly {
      readonly browser: string;
      readonly versions: readonly {
        readonly key: string;
        readonly label: string;
        readonly views: number;
        readonly visitors: number;
        readonly sessions: number;
        readonly isOther?: boolean;
        readonly isUnknown?: boolean;
      }[];
      readonly views: number;
      readonly visitors: number;
      readonly sessions: number;
    }[];
export interface CanonicalShareTrendSeriesItem {
  readonly key: string;
  readonly label: string;
  readonly views: number;
  readonly visitors: number;
  readonly sessions: number;
  readonly isOther?: boolean;
}
export interface CanonicalShareTrendPoint {
  readonly bucket: number;
  readonly timestampMs: number;
  readonly totalVisitors: number;
  readonly visitorsBySeries: Readonly<Record<string, number>>;
}
export interface CanonicalShareTrendResult {
  readonly series: readonly CanonicalShareTrendSeriesItem[];
  readonly data: readonly CanonicalShareTrendPoint[];
}
export interface CanonicalReferrerAndChannelTrendResult {
  readonly source: CanonicalShareTrendResult;
  readonly channel: CanonicalShareTrendResult;
}
export interface CanonicalCrossBreakdownQuery extends CrossBreakdownQuery {
  readonly variant?: "generic";
}
export interface CanonicalBrowserCrossBreakdownQuery extends BaseQuery {
  readonly variant: "browser";
  readonly browserLimit?: number;
  readonly osLimit?: number;
  readonly deviceTypeLimit?: number;
}
export interface CanonicalBrowserCrossBreakdownResult {
  readonly operatingSystem: CrossBreakdownResult;
  readonly deviceType: CrossBreakdownResult;
}
export type CanonicalOverviewQuery = OverviewQuery & {
  readonly teamId?: string;
  readonly allowedSiteIds?: readonly string[];
};
export type CanonicalTrendQuery = TrendQuery & {
  readonly teamId?: string;
  readonly allowedSiteIds?: readonly string[];
};
export type CanonicalTeamSitesQuery = PageQuery & {
  readonly teamId?: string;
  readonly allowedSiteIds?: readonly string[];
  readonly interval?: Interval;
};
export type CanonicalComparisonResult = ComparisonResult & {
  readonly trend?: ComparisonTrendResult;
};
export interface CanonicalComparisonQuery extends ComparisonQuery {
  readonly interval?: ComparisonTrendQuery["interval"];
  readonly trendMetrics?: readonly ComparisonMetricKey[];
}

/** Every QueryOperation must have exactly one canonical query/result pair. */
export interface CanonicalOperationMap {
  readonly overview: {
    readonly query: CanonicalOverviewQuery;
    readonly result: OverviewResult;
  };
  readonly trend: {
    readonly query: CanonicalTrendQuery;
    readonly result: TrendResult;
  };
  readonly "team-sites": {
    readonly query: CanonicalTeamSitesQuery;
    readonly result: TeamSitesQueryResult["data"];
  };
  readonly comparison: {
    readonly query: CanonicalComparisonQuery;
    readonly result: CanonicalComparisonResult;
  };
  readonly "comparison-breakdown": {
    readonly query: ComparisonBreakdownQuery;
    readonly result: ComparisonBreakdownResult;
  };
  readonly dimension: {
    readonly query: CanonicalDimensionQuery;
    readonly result: CanonicalDimensionResult;
  };
  readonly "cross-dimension": {
    readonly query:
      CanonicalCrossBreakdownQuery | CanonicalBrowserCrossBreakdownQuery;
    readonly result:
      CrossBreakdownResult | CanonicalBrowserCrossBreakdownResult;
  };
  readonly "share-trend": {
    readonly query: CanonicalShareTrendQuery;
    readonly result:
      CanonicalShareTrendResult | CanonicalReferrerAndChannelTrendResult;
  };
  readonly radar: {
    readonly query: CanonicalRadarQuery;
    readonly result: CanonicalRadarResult;
  };
  readonly pages: {
    readonly query: CanonicalPagesQuery;
    readonly result: CanonicalPagesResult;
  };
  readonly "pages-dashboard": {
    readonly query: PagesDashboardQuery;
    readonly result: PagesDashboardResult;
  };
  readonly referrers: {
    readonly query: CanonicalReferrersQuery;
    readonly result: CanonicalReferrersResult;
  };
  readonly channels: {
    readonly query: CanonicalChannelsQuery;
    readonly result: CanonicalChannelsResult;
  };
  readonly "filter-values": {
    readonly query: FilterValuesQuery;
    readonly result: FilterValuesResult;
  };
  readonly retention: {
    readonly query: RetentionQuery;
    readonly result: RetentionResult;
  };
  readonly "geo-points": {
    readonly query: BaseQuery & { readonly limit?: number };
    readonly result: GeoPointsResult;
  };
  readonly performance: {
    readonly query: PerformanceQuery;
    readonly result: PerformanceQueryResult;
  };
  readonly realtime: {
    readonly query: RealtimeQuery;
    readonly result: RealtimeQueryResult;
  };
  readonly "event-summary": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalEventSummaryResult;
  };
  readonly "event-trend": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalEventTrendResult;
  };
  readonly "event-types": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalEventTypeResult;
  };
  readonly "event-type-detail": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalEventTypeDetailResult;
  };
  readonly "event-fields": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalEventFieldsResult;
  };
  readonly "event-field-values": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalEventFieldValuesResult;
  };
  readonly "event-context": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalEventContextResult;
  };
  readonly "event-records": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalEventRecordPageResult;
  };
  readonly "visitor-events": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalJourneyEventPage;
  };
  readonly "visitor-sessions": {
    readonly query: LegacyJourneyQuery;
    readonly result: CanonicalJourneySessionPage;
  };
  readonly "session-events": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalJourneyEventPage;
  };
  readonly "event-record-detail": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalEventRecordDetailResult;
  };
  readonly "journey-event-detail": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalJourneyEventDetailResult;
  };
  readonly visitors: {
    readonly query: LegacyJourneyQuery;
    readonly result: CanonicalJourneyVisitorPage;
  };
  readonly "visitor-detail": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalVisitorDetailResult | null;
  };
  readonly sessions: {
    readonly query: LegacyJourneyQuery;
    readonly result: CanonicalJourneySessionPage;
  };
  readonly "session-detail": {
    readonly query: LegacyEventQuery;
    readonly result: CanonicalSessionDetailResult | null;
  };
  readonly "funnel-analysis": {
    readonly query: LegacyAnalysisQuery;
    readonly result: CanonicalFunnelAnalysisResult;
  };
  readonly "goal-summary": {
    readonly query: LegacyAnalysisQuery;
    readonly result: CanonicalGoalSummaryResult | null;
  };
  readonly "goal-timeseries": {
    readonly query: LegacyAnalysisQuery;
    readonly result: CanonicalGoalTimeseriesResult | null;
  };
  readonly "team-dashboard": {
    readonly query: LegacyTeamDashboardQuery;
    readonly result: TeamDashboardData;
  };
  readonly explore: { readonly query: BaseQuery; readonly result: never };
}

type MissingCanonicalOperations = Exclude<
  QueryOperation,
  keyof CanonicalOperationMap
>;
type ExtraCanonicalOperations = Exclude<
  keyof CanonicalOperationMap,
  QueryOperation
>;
type AssertNever<Value extends never> = Value;
type _AllQueryOperationsAreMapped = AssertNever<MissingCanonicalOperations>;
type _NoUnknownCanonicalOperationKeys = AssertNever<ExtraCanonicalOperations>;

export type CanonicalQuery<Operation extends QueryOperation> =
  CanonicalOperationMap[Operation]["query"];
export type CanonicalResult<Operation extends QueryOperation> =
  CanonicalOperationMap[Operation]["result"];
