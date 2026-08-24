import {
  getRequestId,
  notFound,
  type ResponseContext,
} from "@/lib/edge/query/core";
import type { SimpleDimensionKey } from "@/lib/edge/query/dimensions-contract-adapter";
import type { OverviewTab } from "@/lib/edge/query/overview-tabs-contract-adapter";
import {
  applyPublicQueryPolicy,
  operationForQueryRoute,
} from "@/lib/edge/query/router";
import {
  assertOperationAllowed,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";

export interface PublicQueryAdapterInput {
  readonly env: Env;
  readonly siteId: string;
  readonly pathname: string;
  readonly url: URL;
  readonly request?: Request;
}

const SIMPLE_DIMENSIONS: Readonly<Record<string, SimpleDimensionKey>> = {
  countries: "country",
  "utm-source": "utm.source",
  "utm-medium": "utm.medium",
  "utm-campaign": "utm.campaign",
  "utm-term": "utm.term",
  "utm-content": "utm.content",
};

type TechnologyHandlerName =
  | "handleBrowserTrendContract"
  | "handleBrowserEngineTrendContract"
  | "handleBrowserVersionBreakdownContract"
  | "handleBrowserCrossBreakdownContract"
  | "handleBrowserRadarContract"
  | "handleReferrerRadarContract"
  | "handleReferrerDimensionTrendContract"
  | "handleReferrerChannelTrendContract"
  | "handleClientDimensionTrendContract"
  | "handleUtmDimensionTrendContract"
  | "handleCrossBreakdownContract";

const TECHNOLOGY_HANDLERS: Readonly<Record<string, TechnologyHandlerName>> = {
  "browser-trend": "handleBrowserTrendContract",
  "browser-engine-trend": "handleBrowserEngineTrendContract",
  "browser-version-breakdown": "handleBrowserVersionBreakdownContract",
  "browser-cross-breakdown": "handleBrowserCrossBreakdownContract",
  "browser-radar": "handleBrowserRadarContract",
  "referrer-radar": "handleReferrerRadarContract",
  "referrer-dimension-trend": "handleReferrerDimensionTrendContract",
  "referrer-channel-dimension-trend": "handleReferrerChannelTrendContract",
  "client-dimension-trend": "handleClientDimensionTrendContract",
  "utm-dimension-trend": "handleUtmDimensionTrendContract",
  "client-cross-breakdown": "handleCrossBreakdownContract",
};

const OVERVIEW_TABS: Readonly<Record<string, OverviewTab>> = {
  "overview-page-path": "page.path",
  "overview-page-title": "page.title",
  "overview-page-hostname": "page.hostname",
  "overview-page-entry": "page.entry",
  "overview-page-exit": "page.exit",
  "overview-source-domain": "source.domain",
  "overview-source-channel": "source.channel",
  "overview-client-browser": "client.browser",
  "overview-client-os-version": "client.osVersion",
  "overview-client-device-type": "client.deviceType",
  "overview-client-language": "client.language",
  "overview-client-screen-size": "client.screenSize",
  "overview-geo-country": "geo.country",
  "overview-geo-region": "geo.region",
  "overview-geo-city": "geo.city",
  "overview-geo-continent": "geo.continent",
  "overview-geo-timezone": "geo.timezone",
  "overview-geo-organization": "geo.organization",
};

const PUBLIC_QUERY_PATHS = new Set([
  "overview",
  "trend",
  "pages",
  "referrers",
  "pages-dashboard",
  "retention",
  "performance",
  "event-types",
  "filter-values",
  "overview-geo-points",
  ...Object.keys(SIMPLE_DIMENSIONS),
  ...Object.keys(TECHNOLOGY_HANDLERS),
  ...Object.keys(OVERVIEW_TABS),
]);

function responseContext(
  input: PublicQueryAdapterInput,
): ResponseContext | undefined {
  return input.request ? { requestId: getRequestId(input.request) } : undefined;
}

/** Public-share protocol adapter. The router applies public capability and
 * privacy policy before any query handler can read source data. */
export function executePublicQuery(
  input: PublicQueryAdapterInput,
): Promise<Response> {
  if (!PUBLIC_QUERY_PATHS.has(input.pathname)) {
    return Promise.resolve(notFound());
  }
  const policy = applyPublicQueryPolicy(input.url);
  if (!policy.allowed) return Promise.resolve(notFound());
  const url = policy.url;
  const ctx = responseContext(input);
  const queryContext = siteQueryContext(input.siteId, "public-share");
  if (
    assertOperationAllowed(queryContext, operationForQueryRoute(input.pathname))
  ) {
    return Promise.resolve(notFound());
  }
  if (isDemoBuild) {
    const operation = operationForQueryRoute(input.pathname);
    return import("../query-runtime/mock-provider").then(
      ({ executeMockQuery }) =>
        executeMockQuery({
          operation,
          request: input.request ?? new Request(url, { method: "GET" }),
          url,
          siteId: input.siteId,
          queryContext,
          publicQuery: true,
          context: ctx,
        }),
    );
  }
  if (input.pathname === "overview") {
    return import("../query/overview-contract-adapter").then(
      ({ handleOverviewContract }) =>
        handleOverviewContract(input.env, input.siteId, url, ctx, queryContext),
    );
  }
  if (input.pathname === "trend") {
    return import("../query/overview-contract-adapter").then(
      ({ handleTrendContract }) =>
        handleTrendContract(input.env, input.siteId, url, ctx, queryContext),
    );
  }
  if (input.pathname === "pages") {
    return import("../query/pages-contract-adapter").then(
      ({ handlePagesContract }) =>
        handlePagesContract(
          input.env,
          input.siteId,
          url,
          false,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "referrers") {
    return import("../query/pages-contract-adapter").then(
      ({ handleReferrersContract }) =>
        handleReferrersContract(
          input.env,
          input.siteId,
          url,
          8,
          false,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "pages-dashboard") {
    return import("../query/pages-contract-adapter").then(
      ({ handlePagesDashboardContract }) =>
        handlePagesDashboardContract(
          input.env,
          input.siteId,
          url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "retention") {
    return import("../query/analysis-contract-adapter").then(
      ({ handleRetentionContract }) =>
        handleRetentionContract(
          input.env,
          input.siteId,
          url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "performance") {
    return import("../query/analysis-contract-adapter").then(
      ({ handlePerformanceContract }) =>
        handlePerformanceContract(
          input.env,
          input.siteId,
          url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "event-types") {
    return import("../query/events-contract-adapter").then(
      ({ handleEventTypesContract }) =>
        handleEventTypesContract(
          input.env,
          input.siteId,
          url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "filter-values") {
    return import("../query/filter-values-contract-adapter").then(
      ({ handleFilterValuesContract }) =>
        handleFilterValuesContract(
          input.env,
          input.siteId,
          url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "overview-geo-points") {
    return import("../query/overview-extras-contract-adapter").then(
      ({ handleOverviewGeoPointsContract }) =>
        handleOverviewGeoPointsContract(
          input.env,
          input.siteId,
          url,
          ctx,
          queryContext,
        ),
    );
  }
  const dimension = SIMPLE_DIMENSIONS[input.pathname];
  if (dimension) {
    return import("../query/dimensions-contract-adapter").then(
      ({ handleSimpleDimensionContract }) =>
        handleSimpleDimensionContract(
          input.env,
          input.siteId,
          url,
          dimension,
          ctx,
          queryContext,
        ),
    );
  }
  const technologyHandler = TECHNOLOGY_HANDLERS[input.pathname];
  if (technologyHandler) {
    return import("../query/technology-contract-adapter").then((module) =>
      module[technologyHandler](
        input.env,
        input.siteId,
        url,
        ctx,
        queryContext,
      ),
    );
  }
  const overviewTab = OVERVIEW_TABS[input.pathname];
  if (overviewTab) {
    return import("../query/overview-tabs-contract-adapter").then(
      ({ handleOverviewTabContract }) =>
        handleOverviewTabContract(
          input.env,
          input.siteId,
          url,
          overviewTab,
          ctx,
          queryContext,
        ),
    );
  }
  return Promise.resolve(notFound());
}
