import "@tanstack/react-start/server-only";

import type { QueryWindow } from "@/lib/edge/query/core";
import {
  createOverviewReader,
  readLatestSiteActivity,
  toQueryTime,
} from "@/lib/edge/query/overview-contract-adapter";
import { listTeamSites } from "@/lib/edge/query/team";
import type { QuerySource } from "@/lib/edge/query-contract";
import {
  assertFilterAudience,
  assertOperationAllowed,
  type FilterDocument,
  type OverviewMetrics,
  teamQueryContext,
  type TrendResult,
  validateQueryFilters,
} from "@/lib/edge/query-contract";
import { analyticsFilterRegistry } from "@/lib/edge/query-contract/filter-registry";
import type { Env } from "@/lib/edge/types";

export interface ReadTeamSitesInput {
  readonly env: Env;
  readonly teamId: string;
  readonly window: QueryWindow;
  readonly interval?: TrendResult["interval"];
  readonly filters: FilterDocument;
  readonly allowedSiteIds?: readonly string[];
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
  readonly data: { readonly sites: readonly TeamSiteAnalyticsResult[] };
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
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
  const context = teamQueryContext(
    input.teamId,
    "api-v1",
    input.allowedSiteIds,
  );
  const operationError = assertOperationAllowed(context, "overview");
  if (operationError) throw new Error(operationError.kind);
  const filterError = validateQueryFilters(context, input.filters);
  if (filterError) throw new Error(filterError.kind);
  try {
    assertFilterAudience(
      input.filters,
      analyticsFilterRegistry,
      context.policy.audience,
    );
  } catch {
    throw new Error("invalid-input");
  }

  const allowed = input.allowedSiteIds ? new Set(input.allowedSiteIds) : null;
  const sites = (await listTeamSites(input.env, input.teamId)).filter(
    (site) => !allowed || allowed.has(site.id),
  );
  const time = toQueryTime(input.window);
  const values = await Promise.all(
    sites.map(async (site) => {
      const reader = createOverviewReader(input.env, site.id);
      const overview = await reader.readOverview({
        context,
        time,
        filters: input.filters,
      });
      const trend = input.interval
        ? await reader.readTrend({
            context,
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
    data: { sites: values.map((value) => value.site) },
    source: source(values.flatMap((value) => value.sources)),
    approximateVisitors: values.some((value) => value.approximateVisitors),
  };
}
