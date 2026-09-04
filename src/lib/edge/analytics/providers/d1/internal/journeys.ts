import type { Env } from "@/lib/edge/types";

import type {
  FilterDocument,
  GeoPointAggregate,
  ListSort,
  QueryWindow,
  VisitorListSortKey,
  VisitorRow,
} from "./core";
import { DEFAULT_VISITOR_LIST_SORT } from "./core";
import type { D1ReadDiagnostics } from "./diagnostics";
import { queryGeoPointsFromD1 } from "./journey-geo-queries";
import { queryVisitorsFromD1 } from "./journey-list-queries";

export {
  queryJourneyEventDetailFromD1,
  queryJourneyEventsForDetailFromD1,
  querySessionDetailFromD1,
  querySessionsForDetailFromD1,
  queryVisitorDetailFromD1,
  queryVisitorForDetailFromD1,
  stripSessionDetailCollections,
  stripVisitorDetailCollections,
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
  filters: FilterDocument,
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
  filters: FilterDocument,
  limit: number,
  diagnostics?: D1ReadDiagnostics,
): Promise<GeoPointAggregate> {
  return queryGeoPointsFromD1(env, siteId, window, filters, limit, diagnostics);
}
