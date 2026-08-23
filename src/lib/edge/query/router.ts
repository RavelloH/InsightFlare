import type { QueryOperation } from "@/lib/edge/query-contract";

/** Protocol route exposure. Query execution belongs to the three adapters. */
export const PUBLIC_QUERY_PATHS = [
  "overview",
  "trend",
  "pages",
  "pages-dashboard",
  "referrers",
  "retention",
  "performance",
  "countries",
  "filter-values",
  "event-types",
  "overview-page-path",
  "overview-page-title",
  "overview-page-hostname",
  "overview-page-entry",
  "overview-page-exit",
  "overview-source-domain",
  "overview-source-channel",
  "overview-client-browser",
  "overview-client-os-version",
  "overview-client-device-type",
  "overview-client-language",
  "overview-client-screen-size",
  "overview-geo-country",
  "overview-geo-region",
  "overview-geo-city",
  "overview-geo-continent",
  "overview-geo-timezone",
  "overview-geo-organization",
  "overview-geo-points",
  "browser-trend",
  "browser-engine-trend",
  "browser-version-breakdown",
  "browser-cross-breakdown",
  "client-cross-breakdown",
  "browser-radar",
  "referrer-radar",
  "referrer-dimension-trend",
  "referrer-channel-dimension-trend",
  "client-dimension-trend",
  "utm-dimension-trend",
  "utm-source",
  "utm-medium",
  "utm-campaign",
  "utm-term",
  "utm-content",
] as const;

export const DASHBOARD_QUERY_PATHS = [
  ...PUBLIC_QUERY_PATHS,
  "events-summary",
  "events-trend",
  "events-records",
  "event-type-fields",
  "event-type-field-values",
  "event-type-context",
  "event-type-detail",
  "event-record-detail",
  "sessions",
  "session-detail",
  "visitor-detail",
  "visitors",
  "funnels",
  "team-dashboard",
] as const;

const PUBLIC_HIDDEN_FILTER_PARAMS = new Set(["query", "sourceLink"]);
const PUBLIC_HIDDEN_FILTER_OPTION_KEYS = new Set(["sourceLink"]);
const PUBLIC_HIDDEN_CROSS_DIMENSIONS = new Set([
  "page.query",
  "page.hash",
  "referrer.url",
  "query_string",
  "hash_fragment",
  "referrer_url",
]);

export interface PublicQueryPolicyDecision {
  readonly allowed: boolean;
  readonly url: URL;
}

/**
 * Public sharing policy runs in the public protocol adapter before any source
 * reader is selected. Detailed filter semantics remain a future concern.
 */
export function applyPublicQueryPolicy(url: URL): PublicQueryPolicyDecision {
  const filterKey = url.searchParams.get("filterKey")?.trim();
  const dimensions = [
    url.searchParams.get("primaryDimension"),
    url.searchParams.get("secondaryDimension"),
  ];
  const requestsHiddenFilter = [...PUBLIC_HIDDEN_FILTER_PARAMS].some((key) =>
    url.searchParams.has(key),
  );
  const requestsHiddenDimension = dimensions.some(
    (dimension) =>
      dimension !== null &&
      PUBLIC_HIDDEN_CROSS_DIMENSIONS.has(dimension.trim().toLowerCase()),
  );
  if (
    requestsHiddenFilter ||
    (filterKey !== undefined &&
      PUBLIC_HIDDEN_FILTER_OPTION_KEYS.has(filterKey)) ||
    requestsHiddenDimension
  ) {
    return { allowed: false, url };
  }
  if (!url.searchParams.has("details") && !url.searchParams.has("fullUrl")) {
    return { allowed: true, url };
  }
  const sanitizedUrl = new URL(url);
  sanitizedUrl.searchParams.delete("details");
  sanitizedUrl.searchParams.delete("fullUrl");
  return { allowed: true, url: sanitizedUrl };
}

export function operationForQueryRoute(pathname: string): QueryOperation {
  if (pathname === "overview") return "overview";
  if (pathname === "trend") return "trend";
  if (pathname === "pages") return "pages";
  if (pathname === "pages-dashboard") return "pages-dashboard";
  if (pathname === "referrers") return "referrers";
  if (pathname === "filter-values") return "filter-values";
  if (pathname === "overview-geo-points") return "geo-points";
  if (pathname === "retention") return "retention";
  if (pathname === "performance") return "performance";
  if (pathname === "funnels") return "funnel-analysis";
  if (pathname === "team-dashboard") return "team-dashboard";
  if (pathname === "events-summary") return "event-summary";
  if (pathname === "events-trend") return "event-trend";
  if (pathname === "event-types") return "event-types";
  if (pathname === "event-type-detail") return "event-type-detail";
  if (pathname === "event-type-fields") return "event-fields";
  if (pathname === "event-type-field-values") return "event-field-values";
  if (pathname === "event-type-context") return "event-context";
  if (pathname === "events-records") return "event-records";
  if (pathname === "event-record-detail") return "event-record-detail";
  if (pathname === "visitors") return "visitors";
  if (pathname === "visitor-detail") return "visitor-detail";
  if (pathname === "sessions") return "sessions";
  if (pathname === "session-detail") return "session-detail";
  if (pathname.includes("radar") || pathname === "browser-version-breakdown")
    return "radar";
  if (pathname.includes("cross-breakdown")) return "cross-dimension";
  if (pathname.includes("trend")) return "share-trend";
  if (pathname === "overview-source-channel") return "channels";
  if (pathname.startsWith("overview-source-")) return "referrers";
  return "dimension";
}
