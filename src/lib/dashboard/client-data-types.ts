import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  DashboardFilterOption,
  OverviewClientDimensionTabsData as OverviewClientDimensionTabsResponse,
  OverviewGeoDimensionTabsData as OverviewGeoDimensionTabsResponse,
  OverviewTabData,
  PagesDashboardData,
  PagesData,
} from "@/lib/edge-client";
import type { AnalyticsFilterFieldId } from "@/lib/filter-contract";

export type DashboardFilterOptionData = DashboardFilterOption;

export type PageCardTabsData = NonNullable<PagesData["tabs"]>;
export type OverviewClientDimensionTabsData =
  OverviewClientDimensionTabsResponse["tabs"];
export type OverviewGeoDimensionTabsData =
  OverviewGeoDimensionTabsResponse["tabs"];
export type OverviewTabRows = OverviewTabData["data"]["items"];
export type OverviewTabCollection = OverviewTabData["data"];
export type OverviewGeoTabRows = Array<{
  value: string;
  label: string;
  views: number;
  sessions: number;
  visitors: number;
}>;
export type PagesDashboardRows = PagesDashboardData["data"]["items"];
export type PagesDashboardRow = PagesDashboardRows[number];

export type SortDirection = "asc" | "desc";
export type VisitorListSortKey =
  | "firstSeenAt"
  | "lastSeenAt"
  | "sessions"
  | "views";
export type SessionListSortKey = "startedAt" | "durationMs" | "views";
export type EventRecordSortKey = "occurredAt" | "eventName" | "pathname";
export type RetentionGranularity = TimeWindow["interval"];

export type PrivateRequestParams = Record<string, string | number>;
export type DashboardListRequestOptions = {
  limit?: number;
  cursor?: string | null;
  signal?: AbortSignal;
};
export type FetchPrivateJsonOptions = {
  signal?: AbortSignal;
  dedupe?: boolean;
};

export type OverviewPageCardTab =
  | "path"
  | "query"
  | "title"
  | "hostname"
  | "entry"
  | "exit";

export type OverviewSourceCardTab = "domain" | "link" | "channel";

export type OverviewClientDimensionTab =
  | "browser"
  | "osVersion"
  | "deviceType"
  | "language"
  | "screenSize";

export type OverviewGeoDimensionTab =
  | "country"
  | "region"
  | "city"
  | "continent"
  | "timezone"
  | "organization";

export type DashboardFilterOptionKey = Exclude<
  AnalyticsFilterFieldId,
  "event.payload"
>;

export type UtmDimensionTab =
  | "source"
  | "medium"
  | "campaign"
  | "term"
  | "content";
