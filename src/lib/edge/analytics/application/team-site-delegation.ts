import {
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type QueryAudience,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { prepareScopedQuery } from "@/lib/edge/analytics/contract/scoped-filter";

/**
 * Derive the single-site query a team request delegates to one authorized
 * site. The site query keeps the team request's own audience, time and filter,
 * so it adds no data surface: the team layer has already restricted the sites.
 */
export function prepareSiteQueryForTeamRequest(
  operation: "overview" | "trend",
  siteId: string,
  request: {
    readonly audience: QueryAudience;
    readonly time: QueryTime;
    readonly filters?: FilterDocument;
    readonly scopePreference?: unknown;
    readonly interval?: unknown;
  },
) {
  return prepareScopedQuery(operation, {
    context: siteQueryContext(siteId, request.audience),
    time: request.time,
    filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
    ...(request.scopePreference !== undefined
      ? { scopePreference: request.scopePreference }
      : {}),
    ...(request.interval !== undefined ? { interval: request.interval } : {}),
  } as never);
}
