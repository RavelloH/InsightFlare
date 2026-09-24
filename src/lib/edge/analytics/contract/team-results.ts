import type {
  OverviewMetrics,
  PageResult,
  QuerySource,
  TrendResult,
} from "./types";
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
