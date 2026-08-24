import type { SimpleDimensionKey } from "@/lib/edge/analytics/composition/protocol/dimensions-contract-adapter";
import type { OverviewTab } from "@/lib/edge/analytics/composition/protocol/overview-tabs-contract-adapter";
import {
  badRequest,
  getRequestId,
  jsonResponseWith,
  parseInterval,
  parseWindow,
  PRIVATE_CACHE_HEADERS,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/composition/query-protocol";
import { notFound } from "@/lib/edge/analytics/composition/query-protocol";
import {
  analyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
} from "@/lib/edge/analytics/composition/query-protocol";
import { operationForQueryRoute } from "@/lib/edge/analytics/composition/query-protocol";
import {
  createTeamDashboardQueryRuntime,
  type SsrTeamDashboardData,
} from "@/lib/edge/analytics/composition/ssr-query-runtime";
import {
  createQueryTime,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";

const isDemoBuild = import.meta.env.VITE_DEMO_MODE === "1";

export interface PrivateQueryAdapterInput {
  readonly env: Env;
  readonly siteId: string;
  readonly pathname: string;
  readonly url: URL;
  readonly request?: Request;
  readonly dashboardMode?: boolean;
  readonly deferJsonSerialization?: boolean;
}

export interface PrivateTeamDashboardAdapterInput {
  readonly env: Env;
  readonly teamId: string;
  readonly allowedSiteIds?: readonly string[];
  readonly url: URL;
  readonly request?: Request;
  readonly deferJsonSerialization?: boolean;
}

const SIMPLE_DIMENSIONS: Readonly<Record<string, SimpleDimensionKey>> = {
  countries: "country",
  "page-query": "page.query",
  "page-hash": "page.hash",
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
  "overview-source-link": "source.link",
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

function responseContext(
  input: PrivateQueryAdapterInput,
): ResponseContext | undefined {
  return input.request
    ? {
        requestId: getRequestId(input.request),
        deferJsonSerialization: input.deferJsonSerialization,
      }
    : undefined;
}

/** Private dashboard protocol adapter. Authentication and cache ownership stay
 * at the Hono boundary; this module owns only private query protocol options. */
export function executePrivateQuery(
  input: PrivateQueryAdapterInput,
): Promise<Response> {
  const ctx = responseContext(input);
  const queryContext = siteQueryContext(input.siteId, "private-dashboard");
  if (isDemoBuild) {
    const operation = operationForQueryRoute(input.pathname);
    return import("@/lib/edge/analytics/adapters/mock").then(
      ({ executeMockQuery }) =>
        executeMockQuery({
          operation,
          request: input.request ?? new Request(input.url, { method: "GET" }),
          url: input.url,
          siteId: input.siteId,
          queryContext,
          context: ctx,
        }),
    );
  }
  if (input.pathname === "overview") {
    return import("../composition/protocol/overview-contract-adapter").then(
      ({ handleOverviewContract }) =>
        handleOverviewContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "trend") {
    return import("../composition/protocol/overview-contract-adapter").then(
      ({ handleTrendContract }) =>
        handleTrendContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "pages") {
    return import("../composition/protocol/pages-contract-adapter").then(
      ({ handlePagesContract }) =>
        handlePagesContract(
          input.env,
          input.siteId,
          input.url,
          true,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "referrers") {
    return import("../composition/protocol/pages-contract-adapter").then(
      ({ handleReferrersContract }) =>
        handleReferrersContract(
          input.env,
          input.siteId,
          input.url,
          20,
          true,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "pages-dashboard") {
    return import("../composition/protocol/pages-contract-adapter").then(
      ({ handlePagesDashboardContract }) =>
        handlePagesDashboardContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "retention") {
    return import("../composition/protocol/analysis-contract-adapter").then(
      ({ handleRetentionContract }) =>
        handleRetentionContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "performance") {
    return import("../composition/protocol/analysis-contract-adapter").then(
      ({ handlePerformanceContract }) =>
        handlePerformanceContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "event-types") {
    return import("../composition/protocol/events-contract-adapter").then(
      ({ handleEventTypesContract }) =>
        handleEventTypesContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "events-summary") {
    return import("../composition/protocol/events-contract-adapter").then(
      ({ handleEventsSummaryContract }) =>
        handleEventsSummaryContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "events-trend") {
    return import("../composition/protocol/events-contract-adapter").then(
      ({ handleEventsTrendContract }) =>
        handleEventsTrendContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "events-records") {
    return import("../composition/protocol/events-contract-adapter").then(
      ({ handleEventRecordsContract }) =>
        handleEventRecordsContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "event-type-field-values") {
    return import("../composition/protocol/events-contract-adapter").then(
      ({ handleEventFieldValuesContract }) =>
        handleEventFieldValuesContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "event-type-fields") {
    return import("../composition/protocol/events-contract-adapter").then(
      ({ handleEventTypeFieldsContract }) =>
        handleEventTypeFieldsContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "event-type-context") {
    return import("../composition/protocol/events-contract-adapter").then(
      ({ handleEventTypeContextContract }) =>
        handleEventTypeContextContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "event-type-detail") {
    return import("../composition/protocol/events-contract-adapter").then(
      ({ handleEventTypeDetailContract }) =>
        handleEventTypeDetailContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
          input.dashboardMode
            ? {
                includeContext:
                  input.url.searchParams.get("includeContext") !== "false",
                includeBreakdowns:
                  input.url.searchParams.get("includeBreakdowns") !== "false",
                includeFields:
                  input.url.searchParams.get("includeFields") !== "false",
              }
            : undefined,
        ),
    );
  }
  if (input.pathname === "event-record-detail") {
    return import("../composition/protocol/events-contract-adapter").then(
      ({ handleEventRecordDetailContract }) =>
        handleEventRecordDetailContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "visitors") {
    return import("../composition/protocol/journeys-contract-adapter").then(
      ({ handleVisitorsContract }) =>
        handleVisitorsContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "sessions") {
    return import("../composition/protocol/journeys-contract-adapter").then(
      ({ handleSessionsContract }) =>
        handleSessionsContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "visitor-detail") {
    return import("../composition/protocol/journeys-contract-adapter").then(
      ({ handleVisitorDetailContract }) =>
        handleVisitorDetailContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "session-detail") {
    return import("../composition/protocol/journeys-contract-adapter").then(
      ({ handleSessionDetailContract }) =>
        handleSessionDetailContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "filter-values") {
    return import("../composition/protocol/filter-values-contract-adapter").then(
      ({ handleFilterValuesContract }) =>
        handleFilterValuesContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "overview-geo-points") {
    return import("../composition/protocol/overview-extras-contract-adapter").then(
      ({ handleOverviewGeoPointsContract }) =>
        handleOverviewGeoPointsContract(
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  if (input.pathname === "funnels") {
    if ((input.request?.method ?? "GET") === "GET") {
      return import("../composition/protocol/funnels-contract-adapter").then(
        ({ handleFunnelAnalysisContract }) =>
          handleFunnelAnalysisContract(
            input.env,
            input.siteId,
            input.url,
            ctx,
            queryContext,
          ),
      );
    }
    return import("../composition/protocol/funnels-contract-adapter").then(
      ({ handleFunnel }) =>
        handleFunnel(input.env, input.siteId, input.url, ctx, input.request),
    );
  }
  const dimension = SIMPLE_DIMENSIONS[input.pathname];
  if (dimension) {
    return import("../composition/protocol/dimensions-contract-adapter").then(
      ({ handleSimpleDimensionContract }) =>
        handleSimpleDimensionContract(
          input.env,
          input.siteId,
          input.url,
          dimension,
          ctx,
          queryContext,
        ),
    );
  }
  const technologyHandler = TECHNOLOGY_HANDLERS[input.pathname];
  if (technologyHandler) {
    return import("../composition/protocol/technology-contract-adapter").then(
      (module) =>
        module[technologyHandler](
          input.env,
          input.siteId,
          input.url,
          ctx,
          queryContext,
        ),
    );
  }
  const overviewTab = OVERVIEW_TABS[input.pathname];
  if (overviewTab) {
    return import("../composition/protocol/overview-tabs-contract-adapter").then(
      ({ handleOverviewTabContract }) =>
        handleOverviewTabContract(
          input.env,
          input.siteId,
          input.url,
          overviewTab,
          ctx,
          queryContext,
        ),
    );
  }
  return Promise.resolve(notFound());
}

function teamResponseContext(
  input: PrivateTeamDashboardAdapterInput,
): ResponseContext | undefined {
  return input.request
    ? {
        requestId: getRequestId(input.request),
        deferJsonSerialization: input.deferJsonSerialization,
      }
    : undefined;
}

/** Private team-dashboard adapter after authentication has resolved its team
 * scope. Caching remains at the Hono boundary. */
export async function executePrivateTeamDashboard(
  input: PrivateTeamDashboardAdapterInput,
): Promise<Response> {
  const window = parseWindow(input.url);
  if (!window) return badRequest("Invalid time window");
  const diagnostics = createD1ReadDiagnostics();
  const result = await createTeamDashboardQueryRuntime({
    env: input.env,
    teamId: input.teamId,
    window,
    interval: parseInterval(input.url),
    allowedSiteIds: input.allowedSiteIds,
    diagnostics,
  }).execute<SsrTeamDashboardData>("team-dashboard", {
    context: teamQueryContext(
      input.teamId,
      "private-dashboard",
      input.allowedSiteIds,
    ),
    time: createQueryTime(
      window.startMs,
      window.endExclusiveMs,
      window.timeZone,
      window.nowMs,
    ),
  });
  if (!result.ok) {
    return queryErrorResponse(result.error);
  }
  return jsonResponseWith(
    teamResponseContext(input)!,
    { ok: true, data: result.data },
    200,
    {
      ...PRIVATE_CACHE_HEADERS,
      ...analyticsDiagnosticHeaders(result.meta.source, diagnostics),
    },
  );
}
