import { resolveReportingTimeZone } from "@/lib/dashboard/time-zone";
import { parseFilterUrlForAudience } from "@/lib/edge/analytics/contract";
import {
  createTypedQueryProviderRegistry,
  executeTypedApplicationOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  badRequest,
  jsonResponseWith,
  mapVisitors,
  parseLimit,
  parseListSearch,
  parseQueryLimit,
  parseSessionListSort,
  parseVisitorListSort,
  parseWindow,
  queryErrorResponse,
  type ResponseContext,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  parseSessionListCursor,
  parseVisitorListCursor,
  querySessionListPageFromD1,
  querySessionsFromD1,
  queryVisitorListPageFromD1,
  serializeSessionListCursor,
  serializeVisitorListCursor,
} from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  querySessionDetailFromD1,
  queryVisitorAggregate,
  queryVisitorDetailFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/journeys";
import { toQueryTime } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";

export async function handleVisitorsContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const paged =
    url.searchParams.has("cursor") || url.searchParams.has("pageSize");
  const pageSize = paged
    ? parseQueryLimit(url, "pageSize", 80, 1, 120)
    : parseLimit(url, 20, 200);
  const sort = parseVisitorListSort(url);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? parseVisitorListCursor(rawCursor, sort) : null;
  if (rawCursor && !cursor) return badRequest("Invalid cursor");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation<{
    readonly data: ReturnType<typeof mapVisitors>;
    readonly meta: {
      readonly pageSize: number;
      readonly returned: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  }>(
    "visitors",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("visitors", async () => {
      const page = paged
        ? await queryVisitorListPageFromD1(env, siteId, window, filters, {
            pageSize,
            sort,
            search: parseListSearch(url),
            cursor,
          })
        : {
            rows: await queryVisitorAggregate(
              env,
              siteId,
              window,
              filters,
              pageSize,
              0,
              sort,
              parseListSearch(url),
            ),
            nextCursor: null,
          };
      return {
        value: {
          data: mapVisitors(page.rows),
          meta: {
            pageSize,
            returned: page.rows.length,
            hasMore: page.nextCursor !== null,
            nextCursor: page.nextCursor
              ? serializeVisitorListCursor(page.nextCursor)
              : null,
          },
        },
      };
    }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

export async function handleSessionsContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const paged =
    url.searchParams.has("cursor") || url.searchParams.has("pageSize");
  const pageSize = paged
    ? parseQueryLimit(url, "pageSize", 80, 1, 120)
    : parseLimit(url, 100, 500);
  const sort = parseSessionListSort(url);
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor ? parseSessionListCursor(rawCursor, sort) : null;
  if (rawCursor && !cursor) return badRequest("Invalid cursor");
  const filters = parseFilterUrlForAudience(queryContext.policy.audience, url);
  const result = await executeTypedApplicationOperation<{
    readonly data: Awaited<
      ReturnType<typeof querySessionListPageFromD1>
    >["rows"];
    readonly meta: {
      readonly pageSize: number;
      readonly returned: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  }>(
    "sessions",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: filters,
    },
    createTypedQueryProviderRegistry("sessions", async () => {
      const page = paged
        ? await querySessionListPageFromD1(env, siteId, window, filters, {
            pageSize,
            sort,
            search: parseListSearch(url),
            cursor,
          })
        : {
            rows: await querySessionsFromD1(
              env,
              siteId,
              window,
              filters,
              pageSize,
              undefined,
              0,
              sort,
              parseListSearch(url),
            ),
            nextCursor: null,
          };
      return {
        value: {
          data: page.rows,
          meta: {
            pageSize,
            returned: page.rows.length,
            hasMore: page.nextCursor !== null,
            nextCursor: page.nextCursor
              ? serializeSessionListCursor(page.nextCursor)
              : null,
          },
        },
      };
    }),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, ...result.data });
}

export async function handleVisitorDetailContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const visitorId = (url.searchParams.get("visitorId") || "").trim();
  if (!visitorId) return badRequest("Missing visitorId");
  // Detail readers intentionally do not filter a visitor's trajectory by the
  // dashboard window; the window is only contract metadata and policy input.
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const result = await executeTypedApplicationOperation<
    Awaited<ReturnType<typeof queryVisitorDetailFromD1>>
  >(
    "visitor-detail",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: { version: 1, root: null },
    },
    createTypedQueryProviderRegistry("visitor-detail", async () => ({
      value: await queryVisitorDetailFromD1(
        env,
        siteId,
        visitorId,
        resolveReportingTimeZone(url.searchParams.get("timeZone")),
      ),
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}

export async function handleSessionDetailContract(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  queryContext = siteQueryContext(siteId, "private-dashboard"),
): Promise<Response> {
  const sessionId = (url.searchParams.get("sessionId") || "").trim();
  if (!sessionId) return badRequest("Missing sessionId");
  const window = parseWindow(url);
  if (!window) return badRequest("Invalid time window");
  const result = await executeTypedApplicationOperation<
    Awaited<ReturnType<typeof querySessionDetailFromD1>>
  >(
    "session-detail",
    {
      context: queryContext,
      time: toQueryTime(window),
      filters: { version: 1, root: null },
    },
    createTypedQueryProviderRegistry("session-detail", async () => ({
      value: await querySessionDetailFromD1(env, siteId, sessionId),
    })),
  );
  if (!result.ok) return queryErrorResponse(result.error);
  return jsonResponseWith(ctx!, { ok: true, data: result.data });
}
