import "@tanstack/react-start/server-only";

import {
  analyticsFilterRegistry,
  effectiveScopeForPagination,
  type FilterDocument,
  filterFingerprint,
  type OverviewMetrics,
  type QueryAudience,
  type QuerySource,
  type TeamSitesQueryResult,
  type TrendPoint,
  type TrendResult,
} from "@/lib/edge/analytics/contract";
import type {
  OverviewAggregateRow,
  QueryWindow,
  TrendAggregateRow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryOverviewAndTrendForSitesFromHourlyRollupsPartial,
  queryOverviewForSitesFromHourlyRollupsPartial,
} from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-queries";
import { queryTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  paginationBindingForWindow,
} from "@/lib/edge/analytics/providers/d1/internal/pagination";
import { canUseHourlyRollupsForFilter } from "@/lib/edge/analytics/providers/d1/internal/rollup-eligibility";
import {
  queryTeamLatestActivityFromD1,
  queryTeamOverviewFromD1,
  queryTeamSitesPageFromD1,
  type TeamSiteListPage,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import {
  createOverviewReader,
  readLatestSiteActivity,
  toQueryTime,
} from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";
export interface ReadTeamSitesInput {
  readonly env: Env;
  readonly teamId: string;
  readonly window: QueryWindow;
  readonly interval?: TrendResult["interval"];
  readonly filters: FilterDocument;
  readonly allowedSiteIds?: readonly string[];
  readonly page?: { readonly limit: number; readonly cursor?: string | null };
  readonly audience?: QueryAudience;
}
function allowedSiteBinding(
  allowedSiteIds?: readonly string[],
): readonly string[] {
  return [...new Set(allowedSiteIds ?? [])].sort();
}
function teamSiteCursor(value: unknown): {
  readonly createdAt: number;
  readonly id: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["createdAt", "id"]) &&
    typeof candidate.id === "string" &&
    Number.isSafeInteger(candidate.createdAt)
    ? { createdAt: candidate.createdAt as number, id: candidate.id }
    : null;
}
async function teamSitesCursorBinding(
  input: ReadTeamSitesInput,
): Promise<string> {
  return paginationBindingForWindow(input.window, [
    "analytics-team-sites-v1",
    input.audience ?? "private-dashboard",
    input.teamId,
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    filterFingerprint(input.filters, analyticsFilterRegistry),
    effectiveScopeForPagination(input.filters),
    input.interval ?? null,
    allowedSiteBinding(input.allowedSiteIds),
    "createdAt:desc,id:asc",
  ]);
}
async function readTeamSitesPage(
  input: ReadTeamSitesInput,
  page: NonNullable<ReadTeamSitesInput["page"]>,
): Promise<{ rows: TeamSiteListPage["rows"]; nextCursor: string | null }> {
  const binding = await teamSitesCursorBinding(input);
  const cursor = await decodePageCursor(
    input.env,
    binding,
    page.cursor,
    "team-sites",
    teamSiteCursor,
  );
  const result = await queryTeamSitesPageFromD1(
    input.env,
    input.teamId,
    page.limit,
    cursor,
    input.allowedSiteIds,
  );
  return {
    rows: result.rows,
    nextCursor: result.nextCursor
      ? await encodePageCursor(input.env, binding, result.nextCursor)
      : null,
  };
}
function source(values: readonly QuerySource[]): QuerySource {
  if (values.length === 0) return "raw";
  if (values.every((value) => value === values[0])) return values[0]!;
  return "mixed";
}
function asOverviewMetrics(value: OverviewAggregateRow): OverviewMetrics {
  return {
    views: value.views,
    sessions: value.sessions,
    visitors: value.visitors,
    bounces: value.bounces,
    totalDurationMs: value.totalDuration,
    durationViews: value.durationViews,
  };
}
function asTrendPoint(value: TrendAggregateRow): TrendPoint {
  return {
    bucket: value.bucket,
    timestampMs: value.timestampMs as TrendPoint["timestampMs"],
    ...asOverviewMetrics(value),
  };
}
const EMPTY_OVERVIEW: OverviewAggregateRow = {
  views: 0,
  sessions: 0,
  visitors: 0,
  bounces: 0,
  totalDuration: 0,
  durationViews: 0,
};
/**
 * A team-site composite owns its metadata, metrics, optional trend and latest
 * activity. It intentionally does not project a generic breakdown row.
 */
export async function readTeamSites(
  input: ReadTeamSitesInput,
): Promise<TeamSitesQueryResult> {
  const requestedPage = input.page ?? { limit: 20, cursor: null };
  const page = await readTeamSitesPage(input, requestedPage);
  const sites = page.rows;
  const time = toQueryTime(input.window);
  const siteIds = sites.map((site) => site.id);
  // Only an unfiltered Event/observation scope has the same semantics as
  // the hourly rollup. Preserve per-site readers for entity/filtered scopes.
  const canBatch =
    siteIds.length > 0 && canUseHourlyRollupsForFilter(input.filters);
  const [rollup, activities] = canBatch
    ? await Promise.all([
        input.interval
          ? queryOverviewAndTrendForSitesFromHourlyRollupsPartial(
              input.env,
              siteIds,
              input.window,
              input.interval,
            )
          : queryOverviewForSitesFromHourlyRollupsPartial(
              input.env,
              siteIds,
              input.window,
            ).then((overview) => ({ overview, trend: null })),
        queryTeamLatestActivityFromD1(input.env, siteIds, input.window),
      ])
    : [null, null];
  // The grouped Raw fallback is restricted to sites with missing rollups.
  // In particular, do not probe hourly state once again per missing site.
  const missingOverview = rollup
    ? siteIds.filter((siteId) => !rollup.overview.has(siteId))
    : [];
  const rawOverview =
    missingOverview.length > 0
      ? await queryTeamOverviewFromD1(
          input.env,
          missingOverview,
          input.window,
          undefined,
          input.filters,
        )
      : new Map<string, OverviewAggregateRow>();

  const values = await Promise.all(
    sites.map(async (site) => {
      // Filtered and entity-scoped queries retain the legacy readers, whose
      // SQL applies exact scoped membership rather than the Event rollup.
      const reader = rollup ? null : createOverviewReader(input.env, site.id);
      const rolledOverview = rollup?.overview.get(site.id);
      const overview = rollup
        ? {
            value: asOverviewMetrics(
              rolledOverview ?? rawOverview.get(site.id) ?? EMPTY_OVERVIEW,
            ),
            source: (rolledOverview ? "rollup" : "raw") as QuerySource,
            approximateVisitors: false,
          }
        : await reader!.readOverview({ time, filters: input.filters });
      const rolledTrend = rollup?.trend?.get(site.id);
      const trend = input.interval
        ? rollup
          ? {
              value: (
                rolledTrend ??
                (await queryTrendFromD1(
                  input.env,
                  site.id,
                  input.window,
                  input.interval,
                  input.filters,
                ))
              ).map(asTrendPoint),
              source: (rolledTrend ? "rollup" : "raw") as QuerySource,
              approximateVisitors: false,
            }
          : await reader!.readTrend({
              time,
              filters: input.filters,
              interval: input.interval,
            })
        : undefined;
      const lastEventAtMs = activities
        ? (activities.get(site.id) ?? null)
        : await readLatestSiteActivity(
            input.env,
            site.id,
            input.window,
            input.filters,
          );
      return {
        site: {
          siteId: site.id,
          name: site.name,
          domain: site.domain,
          publicEnabled: Boolean(site.publicEnabled),
          publicSlug: site.publicSlug,
          createdAt: site.createdAt,
          updatedAt: site.updatedAt,
          metrics: overview.value,
          ...(trend ? { trend: trend.value } : {}),
          lastEventAtMs,
        },
        sources: [overview.source, ...(trend ? [trend.source] : [])],
        approximateVisitors:
          overview.approximateVisitors || Boolean(trend?.approximateVisitors),
      };
    }),
  );
  return {
    data: {
      items: values.map((value) => value.site),
      pagination: {
        limit: requestedPage.limit,
        returned: values.length,
        hasMore: page.nextCursor !== null,
        nextCursor: page.nextCursor,
      },
    },
    source: source(values.flatMap((value) => value.sources)),
    approximateVisitors: values.some((value) => value.approximateVisitors),
  };
}
