export const PRIVATE_CACHE_HEADERS = {
  "cache-control": "private, no-store",
  vary: "authorization, cookie",
};
export const PUBLIC_CACHE_HEADERS = {
  "cache-control": "public, max-age=300, s-maxage=300",
  "access-control-allow-origin": "*",
};
export const PUBLIC_PRIVACY = {
  queryHashDetails: "hidden",
  visitorTrajectories: "hidden",
  detailedReferrerUrl: "hidden",
} as const;

export type Interval = "minute" | "hour" | "day" | "week" | "month";

export interface QueryWindow {
  fromMs: number;
  toMs: number;
  nowMs: number;
  timeZone: string;
}

export interface SiteRow {
  id: string;
  name: string;
  domain: string;
}

export interface TeamSiteRow {
  id: string;
  teamId: string;
  name: string;
  domain: string;
  publicEnabled: number;
  publicSlug: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardFilters {
  country?: string;
  device?: string;
  browser?: string;
  path?: string;
  query?: string;
  title?: string;
  hostname?: string;
  entry?: string;
  exit?: string;
  sourceDomain?: string;
  sourceLink?: string;
  clientBrowser?: string;
  clientOsVersion?: string;
  clientDeviceType?: string;
  clientLanguage?: string;
  clientScreenSize?: string;
  geo?: string;
  geoContinent?: string;
  geoTimezone?: string;
  geoOrganization?: string;
  eventPayloadFilters?: EventPayloadFilterRule[];
}

export type EventPayloadFilterValue = string | number | boolean | null;

export interface EventPayloadFilterRule {
  path: string;
  operator: "eq" | "ne";
  value: EventPayloadFilterValue;
}

export type SortDirection = "asc" | "desc";
export type VisitorListSortKey =
  | "firstSeenAt"
  | "lastSeenAt"
  | "sessions"
  | "views";
export type SessionListSortKey = "startedAt" | "durationMs" | "views";
export type EventRecordSortKey = "occurredAt" | "eventName" | "pathname";

export interface ListSort<Key extends string> {
  key: Key;
  direction: SortDirection;
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

export interface OverviewAggregateRow {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  totalDuration: number;
  durationViews: number;
}

export interface TrendAggregateRow extends OverviewAggregateRow {
  bucket: number;
  timestampMs: number;
}

export interface BrowserTrendSeriesRow {
  key: string;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
  isOther?: boolean;
}

export interface BrowserTrendBucketRow {
  bucket: number;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
}

export interface BrowserTrendPointRow {
  bucket: number;
  timestampMs: number;
  totalVisitors: number;
  visitorsBySeries: Record<string, number>;
}

export type PerformanceMetricKey = "ttfb" | "fcp" | "lcp" | "cls" | "inp";

export interface VisitPerformanceMetricsRow {
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  inp: number | null;
}

export interface JourneyPerformanceMetricSummaryRow {
  avg: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  samples: number;
}

export type JourneyPerformanceSummaryRow = Record<
  PerformanceMetricKey,
  JourneyPerformanceMetricSummaryRow
>;

export interface PerformanceSummaryRow {
  avg: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  samples: number;
}

export interface PerformanceTrendPointRow {
  bucket: number;
  timestampMs: number;
  avg: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  samples: number;
}

export interface PerformanceRouteMetricRow {
  avg: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  samples: number;
}

export interface PerformanceRouteRow {
  pathname: string;
  views: number;
  metrics: Record<PerformanceMetricKey, PerformanceRouteMetricRow>;
}

export interface PerformanceCountryRow {
  country: string;
  views: number;
  metrics: Record<PerformanceMetricKey, PerformanceRouteMetricRow>;
}

export interface BrowserVersionAggregateRow {
  browser: string;
  version: string;
  views: number;
  visitors: number;
  sessions: number;
}

export interface BrowserVersionSliceRow {
  key: string;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
  isOther?: boolean;
  isUnknown?: boolean;
}

export interface BrowserVersionBreakdownRow {
  browser: string;
  views: number;
  visitors: number;
  sessions: number;
  versions: BrowserVersionSliceRow[];
}

export interface BrowserCrossBreakdownItemRow {
  key: string;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
  isOther?: boolean;
  isUnknown?: boolean;
}

export interface BrowserCrossBreakdownDimensionRow extends BrowserCrossBreakdownItemRow {
  cells: BrowserCrossBreakdownItemRow[];
}

export interface BrowserCrossBreakdownDimensionDataRow {
  columns: BrowserCrossBreakdownItemRow[];
  rows: BrowserCrossBreakdownDimensionRow[];
  totalVisitors: number;
}

export interface BrowserCrossAggregateRow {
  browser: string;
  dimension: string;
  views: number;
  visitors: number;
  sessions: number;
}

export interface ClientCrossAggregateRow {
  primary: string;
  secondary: string;
  views: number;
  visitors: number;
  sessions: number;
}

export interface DimensionRow {
  value: string;
  views: number;
  sessions: number;
  visitors: number;
}

export interface GeoTabRow {
  value: string;
  label: string;
  views: number;
  sessions: number;
  visitors: number;
}

export interface EventAnalyticsContextCards {
  page: {
    path: DimensionRow[];
    query: DimensionRow[];
    title: DimensionRow[];
    hostname: DimensionRow[];
    entry: DimensionRow[];
    exit: DimensionRow[];
  };
  source: {
    domain: DimensionRow[];
    link: DimensionRow[];
  };
  client: ClientDimensionTabs;
  geo: GeoDimensionTabs;
}

export interface EventSummaryCards {
  event: {
    name: DimensionRow[];
  };
  page: {
    path: DimensionRow[];
    title: DimensionRow[];
    hostname: DimensionRow[];
  };
}

export interface PageRow {
  pathname: string;
  query: string;
  hash: string;
  views: number;
  sessions: number;
}

export interface PageCardAggregateRow extends OverviewAggregateRow {
  pathname: string;
}

export interface PageCardTitleRow {
  pathname: string;
  title: string;
  views: number;
}

export interface PageCardTrendRow {
  pathname: string;
  bucket: number;
  timestampMs: number;
  views: number;
  visitors: number;
}

export interface ReferrerRow {
  referrer: string;
  views: number;
  sessions: number;
  visitors: number;
}

export interface ReferrerRadarRow {
  referrer: string;
  sessions: number;
  bounces: number;
  avgDurationMs: number;
  avgDepth: number;
  visitors: number;
  returningVisitors: number;
  avgFrequency: number;
  trafficShare: number;
}

export interface VisitorRow {
  visitorId: string;
  sessionId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  views: number;
  sessions: number;
  events?: number;
  country?: string;
  region?: string;
  regionCode?: string;
  city?: string;
  referrerHost?: string;
  referrerUrl?: string;
  browser?: string;
  browserVersion?: string;
  os?: string;
  osVersion?: string;
  deviceType?: string;
  screenWidth?: number | null;
  screenHeight?: number | null;
}

export interface SessionRow {
  sessionId: string;
  visitorId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  active: boolean;
  views: number;
  events: number;
  bounce: boolean;
  entryPath: string;
  exitPath: string;
  referrerHost: string;
  referrerUrl: string;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  screenWidth: number | null;
  screenHeight: number | null;
  performance: VisitPerformanceMetricsRow;
}

export interface JourneyEventRow {
  id: string;
  kind: "session_start" | "pageview" | "leave" | "custom";
  eventType: string;
  occurredAt: number;
  visitId: string;
  sessionId: string;
  visitorId: string;
  pathname: string;
  hash: string;
  title: string;
  hostname: string;
  referrerHost: string;
  referrerUrl: string;
  country: string;
  region: string;
  city: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  screenWidth: number | null;
  screenHeight: number | null;
  durationMs: number;
  performance: VisitPerformanceMetricsRow;
}

export interface JourneyPageCountRow {
  pathname: string;
  views: number;
}

export interface JourneyEventCountRow {
  eventType: string;
  count: number;
}

export interface EventSummaryRow {
  events: number;
  eventTypes: number;
  sessions: number;
  visitors: number;
}

export interface EventRecordRow {
  eventId: string;
  eventName: string;
  occurredAt: number;
  receivedAt: number;
  sequence: number;
  visitId: string;
  sessionId: string;
  visitorId: string;
  pathname: string;
  title: string;
  hostname: string;
  referrerHost: string;
  country: string;
  region: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  nodeCount: number;
  valueCount: number;
}

export interface EventTrendSeriesRow {
  eventName: string;
  events: number;
  sessions: number;
  visitors: number;
}

export interface EventTrendPointRow {
  bucket: number;
  seriesKey: string;
  events: number;
}

export interface EventTypeTrendPointRow {
  bucket: number;
  events: number;
  visitors: number;
}

export interface EventFieldRow {
  path: string;
  valueType: number;
  events: number;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  stringValue: string | null;
  numberValue: number | null;
  booleanValue: number | null;
}

export interface EventFieldValueRow {
  valueType: number;
  events: number;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  stringValue: string | null;
  numberValue: number | null;
  booleanValue: number | null;
}

export interface VisitorActivityRow {
  date: string;
  count: number;
}

export interface GeoPointRow {
  latitude: number;
  longitude: number;
  timestampMs: number;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  pointCount: number;
}

export interface GeoCountryCountRow {
  country: string;
  views: number;
  sessions: number;
  visitors: number;
}

export interface GeoDimensionCountRow {
  value: string;
  label: string;
  views: number;
  sessions: number;
  visitors: number;
}

export interface GeoPointAggregate {
  points: GeoPointRow[];
  countryCounts: GeoCountryCountRow[];
  regionCounts: GeoDimensionCountRow[];
  cityCounts: GeoDimensionCountRow[];
}

export type ClientDimensionKey =
  | "browser"
  | "operatingSystem"
  | "osVersion"
  | "deviceType"
  | "language"
  | "screenSize";

export type UtmDimensionKey =
  | "source"
  | "medium"
  | "campaign"
  | "term"
  | "content";
export type OverviewGeoTabKey =
  | "country"
  | "region"
  | "city"
  | "continent"
  | "timezone"
  | "organization";

export interface ClientDimensionTabs {
  browser: DimensionRow[];
  osVersion: DimensionRow[];
  deviceType: DimensionRow[];
  language: DimensionRow[];
  screenSize: DimensionRow[];
}

export interface GeoDimensionTabs {
  country: GeoTabRow[];
  region: GeoTabRow[];
  city: GeoTabRow[];
  continent: GeoTabRow[];
  timezone: GeoTabRow[];
  organization: GeoTabRow[];
}

export interface PublicSiteEnvelope {
  slug: string;
  name: string;
  domain: string;
}

export interface PreferredSourceResult<T> {
  value: T;
  source: "ae" | "d1";
  approximateVisitors?: boolean;
}

export interface SiteQueryResponseOptions {
  publicSite?: PublicSiteEnvelope;
}

export type FilterOptionKey = Exclude<
  keyof DashboardFilters,
  "eventPayloadFilters"
>;

export interface DashboardFilterOption {
  value: string;
  label: string;
  group?: "country" | "region" | "city";
}

export const SHARE_TREND_OTHER_KEY = "other";
export const SHARE_TREND_OTHER_LABEL = "Other";
export const SHARE_TREND_OTHER_TOKEN = "__share_trend_other__";
export const BROWSER_VERSION_UNKNOWN_TOKEN = "__browser_version_unknown__";
export const BROWSER_CROSS_UNKNOWN_TOKEN = "__browser_cross_unknown__";
export const BROWSER_CROSS_OTHER_BROWSER_TOKEN =
  "__browser_cross_other_browser__";
export const BROWSER_CROSS_OTHER_DIMENSION_TOKEN =
  "__browser_cross_other_dimension__";
export const CLIENT_CROSS_UNKNOWN_TOKEN = "__client_cross_unknown__";
export const CLIENT_CROSS_OTHER_PRIMARY_TOKEN =
  "__client_cross_other_primary__";
export const CLIENT_CROSS_OTHER_SECONDARY_TOKEN =
  "__client_cross_other_secondary__";
export const DIRECT_REFERRER_FILTER_VALUE = "__direct__";

export const PERFORMANCE_METRIC_COLUMNS: Record<PerformanceMetricKey, string> =
  {
    ttfb: "perf_ttfb_ms",
    fcp: "perf_fcp_ms",
    lcp: "perf_lcp_ms",
    cls: "perf_cls",
    inp: "perf_inp_ms",
  };
export const PERFORMANCE_METRIC_KEYS = Object.keys(
  PERFORMANCE_METRIC_COLUMNS,
) as PerformanceMetricKey[];
