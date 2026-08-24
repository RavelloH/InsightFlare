import { parseFilterUrlForAudience } from "@/lib/edge/query-contract";
import {
  executePages,
  executeReferrers,
  executeTypedApplicationOperation,
  executeTypedApplicationResult,
  type PageItem,
  type PagesReader,
  type ReferrerItem,
  siteQueryContext,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

import type { QueryWindow } from "./core";
import {
  badRequest,
  jsonResponseWith,
  mapPages,
  mapReferrers,
  mapTabs,
  paginationOffset,
  parseBooleanFlag,
  parseInterval,
  parseLimit,
  parseQueryLimit,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
} from "./core";
import { toQueryTime } from "./overview-contract-adapter";
import {
  queryPagesAggregate,
  queryPagesDashboard,
  queryPageTabsAggregate,
  queryReferrerAggregate,
} from "./pages";

function windowFor(time: ReturnType<typeof toQueryTime>): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function createReader(env: Env, siteId: string): PagesReader {
  return {
    async readPages(input) {
      const rows = await queryPagesAggregate(
        env,
        siteId,
        windowFor(input.time),
        input.filters,
        input.limit,
        input.includeDetails,
      );
      return {
        value: rows.map(
          (row): PageItem => ({
            pathname: row.pathname,
            query: row.query,
            hash: row.hash,
            views: row.views,
            sessions: row.sessions,
          }),
        ),
        source: "raw",
      };
    },
    async readReferrers(input) {
      const rows = await queryReferrerAggregate(
        env,
        siteId,
        windowFor(input.time),
        input.filters,
        input.limit,
        input.includeFullUrl,
      );
      return {
        value: rows.map(
          (row): ReferrerItem => ({
            referrer: row.referrer,
            views: row.views,
            sessions: row.sessions,
            visitors: row.visitors,
          }),
        ),
        source: "raw",
      };
    },
  };
}

export async function handlePagesContract(
  env: Env,
  siteId: string,
  url: URL,
  includeTabs: boolean,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(
    siteId,
    includeTabs ? "private-dashboard" : "public-share",
  ),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const limit = parseLimit(url, 20, 200);
  const time = toQueryTime(window);
  const includeDetails = parseBooleanFlag(url, "details");
  const result = await executeTypedApplicationResult(
    "pages",
    { context: queryContext, time, filters },
    () =>
      executePages(createReader(env, siteId), {
        context: queryContext,
        time,
        filters,
        limit,
        includeDetails,
      }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  const payload: Record<string, unknown> = {
    ok: true,
    data: mapPages([...result.data.items]),
  };
  if (includeTabs) {
    const tabsResult = await executeTypedApplicationOperation(
      "pages",
      {
        context: queryContext,
        time: toQueryTime(window),
        filters,
      },
      async () => ({
        value: await queryPageTabsAggregate(
          env,
          siteId,
          window,
          filters,
          limit,
        ),
      }),
    );
    if (!tabsResult.ok) return queryErrorResponse(tabsResult.error);
    payload.tabs = {
      path: mapTabs(tabsResult.data.path),
      title: mapTabs(tabsResult.data.title),
      hostname: mapTabs(tabsResult.data.hostname),
      entry: mapTabs(tabsResult.data.entry),
      exit: mapTabs(tabsResult.data.exit),
    };
  }
  return jsonResponseWith(ctx!, payload);
}

export async function handleReferrersContract(
  env: Env,
  siteId: string,
  url: URL,
  fallbackLimit = 20,
  allowFullUrlParam = true,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(
    siteId,
    allowFullUrlParam ? "private-dashboard" : "public-share",
  ),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const time = toQueryTime(window);
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const limit = parseLimit(url, fallbackLimit, 200);
  const includeFullUrl = allowFullUrlParam && parseBooleanFlag(url, "fullUrl");
  const result = await executeTypedApplicationResult(
    "referrers",
    { context: queryContext, time, filters },
    () =>
      executeReferrers(createReader(env, siteId), {
        context: queryContext,
        time,
        filters,
        limit,
        includeFullUrl,
      }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, {
    ok: true,
    data: mapReferrers([...result.data.items]),
  });
}

export async function handlePagesDashboardContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const page = parseQueryLimit(url, "page", 1, 1, 10_000);
  const pageSize = parseQueryLimit(url, "pageSize", 12, 1, 24);
  const offset = paginationOffset(page, pageSize);
  if (offset === null) {
    return badRequest(
      "Pagination depth exceeds 20,000 rows; narrow the time range or filters",
    );
  }
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation(
    "pages-dashboard",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters,
    },
    async () => ({
      value: await queryPagesDashboard(env, siteId, {
        window,
        filters,
        interval: parseInterval(url),
        page,
        pageSize,
        offset,
      }),
    }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}
