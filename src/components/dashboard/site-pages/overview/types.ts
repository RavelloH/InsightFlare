import { type MetricAreaPoint } from "@/components/dashboard/charts/metric-area-chart";
import { type TrafficChannelId } from "@/lib/analytics/traffic-channel-rules";
import { type OverviewTabRows } from "@/lib/dashboard/client/data/index";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { OverviewTabData } from "@/lib/dashboard-api/client/edge";
import { type FilterScope } from "@/lib/filter-contract/index";
import { type FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

export interface OverviewClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
  showSourceLinkTab?: boolean;
}

export type PageCardTab =
  "path" | "query" | "title" | "hostname" | "entry" | "exit";

export type OverviewComparisonMetric = "views" | "visitors";

export type PageCardSortKey =
  "views" | "visitors" | "current" | "reference" | "change";

export type PageCardNavigableTab =
  "path" | "query" | "hostname" | "entry" | "exit";

export type PageCardDetailTab = "path" | "entry" | "exit";

export type SourceCardTab = "domain" | "link" | "channel";

export type OverviewPagesSectionCardKind = "page" | "source" | "client" | "geo";

export type ClientDimensionCardTab =
  "browser" | "osVersion" | "deviceType" | "language" | "screenSize";

export type GeoDimensionCardTab =
  "country" | "region" | "city" | "continent" | "timezone" | "organization";

export type GeoLocationTab = Extract<
  GeoDimensionCardTab,
  "country" | "region" | "city"
>;

export interface OverviewPagesSectionCardData {
  page: {
    path: OverviewTabRows;
    query: OverviewTabRows;
    title: OverviewTabRows;
    hostname: OverviewTabRows;
    entry: OverviewTabRows;
    exit: OverviewTabRows;
  };
  source: {
    domain: OverviewTabRows;
    link: OverviewTabRows;
    channel?: OverviewTabRows;
  };
  client: {
    browser: OverviewTabRows;
    osVersion: OverviewTabRows;
    deviceType: OverviewTabRows;
    language: OverviewTabRows;
    screenSize: OverviewTabRows;
  };
  geo: {
    country: OverviewTabRows;
    region: OverviewTabRows;
    city: OverviewTabRows;
    continent: OverviewTabRows;
    timezone: OverviewTabRows;
    organization: OverviewTabRows;
  };
}

export interface PageCardTabMeta {
  label: string;
  columnLabel: string;
  primaryMetricLabel?: string;
  mono: boolean;
  showIcon: boolean;
}

type PageCardTabFetcher = (
  siteId: string,
  window: TimeWindow,
  filters: FilterDocument,
  resolvedScope?: FilterScope,
  options?: {
    limit?: number;
    cursor?: string | null;
    search?: string;
    sort?: "views" | "visitors" | "sessions";
    direction?: "asc" | "desc";
    comparisonMetric?: "views" | "visitors";
    comparisonSortBy?: "current" | "reference" | "change";
    comparison?: {
      mode: "same" | "previous";
      window: TimeWindow;
      filters: FilterDocument;
    } | null;
    signal?: AbortSignal;
  },
) => Promise<OverviewTabRows | OverviewTabData["data"]>;

type PageCardTargetUrlResolver = (params: {
  tab: PageCardTab;
  value: string;
  unknownLabel: string;
  fallbackHostname: string;
}) => string | null;

type PageCardDetailPathResolver = (params: {
  tab: PageCardDetailTab;
  value: string;
  unknownLabel: string;
  basePath: string;
}) => string | null;

export type PageCardDetailClickResolver = (params: {
  tab: PageCardDetailTab;
  value: string;
  unknownLabel: string;
  basePath: string;
}) => void;

export interface PageCardRow {
  key: string;
  label: string;
  displayLabel?: string;
  rawLabel?: string;
  views: number;
  visitors: number;
  reference?: {
    views: number;
    sessions: number;
    visitors: number;
  };
  change?: {
    views: { absolute: number; relative: number | null };
    sessions: { absolute: number; relative: number | null };
    visitors: { absolute: number; relative: number | null };
  };
  mono: boolean;
  iconName?: string | null;
  filterValue?: string;
  regionBreadcrumb?: {
    countryLabel: string;
    countryIconName: string | null;
    regionLabel: string;
    countryCode: string;
    stateCode: string;
    hideRegion: boolean;
  };
  cityBreadcrumb?: {
    countryLabel: string;
    countryIconName: string | null;
    regionLabel: string;
    cityLabel: string;
    countryCode: string;
    stateCode: string;
    cityNameDefault: string;
    hideRegion: boolean;
    hideCity: boolean;
  };
}

export interface SourceCardRow {
  key: string;
  label: string;
  displayLabel?: string;
  filterValue: string;
  targetUrl: string | null;
  views: number;
  visitors: number;
  reference?: PageCardRow["reference"];
  change?: PageCardRow["change"];
  mono: boolean;
  channelId?: TrafficChannelId;
}

export interface OverviewPagesSectionProps extends OverviewClientPageProps {
  filters: FilterDocument;
  resolvedScope?: FilterScope;
  loading?: boolean;
  cardDataOverride?: OverviewPagesSectionCardData | null;
  comparisonEnabled?: boolean;
  tableContentTransitionKey?: string | number;
  visibleCards?: readonly OverviewPagesSectionCardKind[];
  pageCardTabs?: readonly PageCardTab[];
  pageCardTabMetaOverride?: Partial<
    Record<PageCardTab, Partial<PageCardTabMeta>>
  >;
  pageCardFilterEnabledOverride?: Partial<Record<PageCardTab, boolean>>;
  pageCardNavigableTabs?: readonly PageCardNavigableTab[];
  pageCardDetailTabs?: readonly PageCardDetailTab[];
  pageCardFetchers?: Partial<Record<PageCardTab, PageCardTabFetcher>>;
  sourceCardFetchers?: Partial<Record<SourceCardTab, PageCardTabFetcher>>;
  clientCardFetchers?: Partial<
    Record<ClientDimensionCardTab, PageCardTabFetcher>
  >;
  geoCardFetchers?: Partial<Record<GeoDimensionCardTab, PageCardTabFetcher>>;
  pageCardTargetUrlResolvers?: Partial<
    Record<PageCardTab, PageCardTargetUrlResolver>
  >;
  pageCardDetailPathResolvers?: Partial<
    Record<PageCardDetailTab, PageCardDetailPathResolver>
  >;
  pageCardDetailClickResolvers?: Partial<
    Record<PageCardDetailTab, PageCardDetailClickResolver>
  >;
  pageCardShowVisitors?: boolean;
  primaryMetricLabel?: string;
  geoPageBasePathname?: string;
  sectionClassName?: string;
}

export interface OverviewDataSectionProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

type OverviewMetricKey =
  | "views"
  | "visitors"
  | "sessions"
  | "bounceRate"
  | "pagesPerSession"
  | "avgDuration";

export type OverviewMetricSeries = Record<
  OverviewMetricKey,
  ReadonlyArray<MetricAreaPoint>
>;
