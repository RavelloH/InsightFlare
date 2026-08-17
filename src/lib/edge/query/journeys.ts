import { resolveReportingTimeZone } from "@/lib/dashboard/time-zone";
import type { Env } from "@/lib/edge/types";

import type {
  DashboardFilters,
  GeoPointAggregate,
  ListSort,
  QueryWindow,
  VisitorListSortKey,
  VisitorRow,
} from "./core";
import {
  badRequest,
  DEFAULT_VISITOR_LIST_SORT,
  jsonResponseWith,
  type ResponseContext,
} from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import {
  querySessionDetailFromD1,
  queryVisitorDetailFromD1,
} from "./journey-detail-queries";
import { queryGeoPointsFromD1 } from "./journey-geo-queries";
import { queryVisitorsFromD1 } from "./journey-list-queries";

export {
  queryJourneyEventsForDetailFromD1,
  querySessionDetailFromD1,
  querySessionsForDetailFromD1,
  queryVisitorDetailFromD1,
  queryVisitorForDetailFromD1,
} from "./journey-detail-queries";
export {
  queryGeoPointsFromD1,
  querySessionLocationPointsFromD1,
} from "./journey-geo-queries";
export type { DetailTarget } from "./journey-helpers";
export {
  averageGapMs,
  buildJourneySearchSql,
  detailTargetColumn,
  directionSql,
  emptyJourneyPerformanceSummary,
  escapeLikeSearch,
  mapGeoPointRow,
  mapJourneyEventRow,
  mapSessionRow,
  mapVisitorRow,
  nullableCoordinate,
  nullableNumber,
  percentile,
  reportingDateKey,
  sessionDurationMs,
  sessionLeaveEvent,
  sessionListOrderBy,
  sessionStartEvent,
  summarizeActivity,
  summarizeEventDistribution,
  summarizeJourneyPerformance,
  summarizeVisitedPages,
  visitorListOrderBy,
  whereClauseWithTarget,
} from "./journey-helpers";
export {
  queryJourneyEventsFromD1,
  querySessionsFromD1,
  queryVisitorsFromD1,
} from "./journey-list-queries";

export async function queryVisitorAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  offset = 0,
  sort: ListSort<VisitorListSortKey> = DEFAULT_VISITOR_LIST_SORT,
  search?: string,
): Promise<VisitorRow[]> {
  return queryVisitorsFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    undefined,
    offset,
    sort,
    search,
  );
}

export async function queryGeoPointAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  limit: number,
  diagnostics?: D1ReadDiagnostics,
): Promise<GeoPointAggregate> {
  return queryGeoPointsFromD1(env, siteId, window, filters, limit, diagnostics);
}

export async function handleVisitorDetail(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const visitorId = (url.searchParams.get("visitorId") || "").trim();
  if (!visitorId) return badRequest("Missing visitorId");
  const timeZone = resolveReportingTimeZone(url.searchParams.get("timeZone"));
  const detail = await queryVisitorDetailFromD1(
    env,
    siteId,
    visitorId,
    timeZone,
  );
  return jsonResponseWith(ctx!, { ok: true, data: detail });
}

export async function handleSessionDetail(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const sessionId = (url.searchParams.get("sessionId") || "").trim();
  if (!sessionId) return badRequest("Missing sessionId");
  const detail = await querySessionDetailFromD1(env, siteId, sessionId);
  return jsonResponseWith(ctx!, { ok: true, data: detail });
}
