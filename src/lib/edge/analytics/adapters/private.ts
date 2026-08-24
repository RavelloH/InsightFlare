import { createTypedQueryProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type { SimpleDimensionKey } from "@/lib/edge/analytics/composition/d1-contract-adapters";
import type { OverviewTab } from "@/lib/edge/analytics/composition/d1-contract-adapters";
import {
  badRequest,
  getRequestId,
  jsonResponseWith,
  parseInterval,
  parseWindow,
  PRIVATE_CACHE_HEADERS,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/composition/d1-contract-adapters";
import { notFound } from "@/lib/edge/analytics/composition/d1-contract-adapters";
import {
  analyticsDiagnosticHeaders,
  createD1ReadDiagnostics,
} from "@/lib/edge/analytics/composition/d1-contract-adapters";
import { operationForQueryRoute } from "@/lib/edge/analytics/composition/d1-contract-adapters";
import type { TeamDashboardQueryResult } from "@/lib/edge/analytics/composition/d1-provider";
import { readTeamDashboard } from "@/lib/edge/analytics/composition/d1-provider";
import {
  createQueryTime,
  executeTypedApplicationOperation,
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
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
      return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then(
      ({ handleFunnel }) =>
        handleFunnel(input.env, input.siteId, input.url, ctx, input.request),
    );
  }
  const dimension = SIMPLE_DIMENSIONS[input.pathname];
  if (dimension) {
    return import("../composition/d1-contract-adapters").then(
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
    return import("../composition/d1-contract-adapters").then((module) =>
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
    return import("../composition/d1-contract-adapters").then(
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
  const result = await executeTypedApplicationOperation<
    TeamDashboardQueryResult["data"]
  >(
    "team-dashboard",
    {
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
    },
    createTypedQueryProviderRegistry("team-dashboard", async () => {
      const dashboard = await readTeamDashboard({
        env: input.env,
        teamId: input.teamId,
        window,
        interval: parseInterval(input.url),
        allowedSiteIds: input.allowedSiteIds,
        diagnostics,
      });
      return { value: dashboard.data, source: dashboard.source };
    }),
  );
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
