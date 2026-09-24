import type {
  OverviewMetrics,
  PageResult,
  QuerySource,
  TrendResult,
} from "./types";
export interface TeamSiteRow {
  readonly id: string;
  readonly teamId: string;
  readonly name: string;
  readonly domain: string;
  readonly publicEnabled: number;
  readonly publicSlug: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface TeamDashboardOverview {
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
  readonly bounces: number;
  readonly totalDurationMs: number;
  readonly avgDurationMs: number;
  readonly bounceRate: number;
  readonly approximateVisitors: boolean;
}
export interface TeamDashboardSite extends TeamSiteRow {
  readonly overview: TeamDashboardOverview;
  readonly changeRates: Readonly<
    Record<
      | "views"
      | "visitors"
      | "sessions"
      | "bounceRate"
      | "avgDurationMs"
      | "pagesPerSession",
      number | null
    >
  >;
}
export interface TeamDashboardTrendBucket {
  readonly bucket: number;
  readonly timestampMs: number;
  readonly sites: readonly {
    readonly siteId: string;
    readonly views: number;
    readonly visitors: number;
  }[];
}
export interface TeamDashboardData {
  readonly sites: readonly TeamDashboardSite[];
  readonly trend: readonly TeamDashboardTrendBucket[];
}
export interface TeamOverviewQueryResult {
  readonly data: OverviewMetrics;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}
export interface TeamSiteAnalyticsResult {
  readonly siteId: string;
  readonly name: string;
  readonly domain: string;
  readonly publicEnabled: boolean;
  readonly publicSlug: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metrics: OverviewMetrics;
  readonly trend?: TrendResult["points"];
  readonly lastEventAtMs: number | null;
}
export interface TeamSitesQueryResult {
  readonly data: PageResult<TeamSiteAnalyticsResult>;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}
export interface TeamTimeseriesQueryResult {
  readonly data: TrendResult;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}
