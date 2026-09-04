import "@tanstack/react-start/server-only";

import {
  analyticsFilterRegistry,
  type FilterDocument,
  filterFingerprint,
  type OverviewMetrics,
  type QueryAudience,
  type QuerySource,
  type TrendResult,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  decodePageCursor,
  encodePageCursor,
  paginationBinding,
} from "@/lib/edge/analytics/providers/d1/internal/pagination";
import {
  listTeamSites,
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

export interface TeamSiteAnalyticsResult {
  readonly siteId: string;
  readonly name: string;
  readonly domain: string;
  readonly publicEnabled: boolean;
  readonly publicSlug: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly metrics: OverviewMetrics;
  readonly trend?: TrendResult["points"];
  readonly lastEventAtMs: number | null;
}

export interface TeamSitesQueryResult {
  readonly data: {
    readonly sites: readonly TeamSiteAnalyticsResult[];
    readonly pagination?: {
      readonly limit: number;
      readonly returned: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  };
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}

function allowedSiteBinding(
  allowedSiteIds?: readonly string[],
): readonly string[] {
  return [...(allowedSiteIds ?? [])].sort();
}

async function teamSitesCursorBinding(
  input: ReadTeamSitesInput,
): Promise<string> {
  return paginationBinding([
    "analytics-team-sites-v1",
    input.audience ?? "private-dashboard",
    input.teamId,
    input.window.startMs,
    input.window.endExclusiveMs,
    input.window.timeZone,
    filterFingerprint(input.filters, analyticsFilterRegistry),
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
  const cursor = await decodePageCursor<{
    readonly createdAt: number;
    readonly id: string;
  }>(input.env, binding, page.cursor);
  if (page.cursor && !cursor) throw new Error("invalid-cursor");
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

/**
 * A team-site composite owns its metadata, metrics, optional trend and latest
 * activity. It intentionally does not project a generic breakdown row.
 */
export async function readTeamSites(
  input: ReadTeamSitesInput,
): Promise<TeamSitesQueryResult> {
  const allowed = input.allowedSiteIds ? new Set(input.allowedSiteIds) : null;
  const page = input.page ? await readTeamSitesPage(input, input.page) : null;
  const sites = page
    ? page.rows
    : (await listTeamSites(input.env, input.teamId)).filter(
        (site) => !allowed || allowed.has(site.id),
      );
  const time = toQueryTime(input.window);
  const values = await Promise.all(
    sites.map(async (site) => {
      const reader = createOverviewReader(input.env, site.id);
      const overview = await reader.readOverview({
        time,
        filters: input.filters,
      });
      const trend = input.interval
        ? await reader.readTrend({
            time,
            filters: input.filters,
            interval: input.interval,
          })
        : undefined;
      const lastEventAtMs = await readLatestSiteActivity(
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
      sites: values.map((value) => value.site),
      ...(page
        ? {
            pagination: {
              limit: input.page!.limit,
              returned: values.length,
              hasMore: page.nextCursor !== null,
              nextCursor: page.nextCursor,
            },
          }
        : {}),
    },
    source: source(values.flatMap((value) => value.sources)),
    approximateVisitors: values.some((value) => value.approximateVisitors),
  };
}
