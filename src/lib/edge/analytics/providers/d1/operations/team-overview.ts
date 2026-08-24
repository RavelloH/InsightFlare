import "@tanstack/react-start/server-only";

import type {
  FilterDocument,
  OverviewMetrics,
  QuerySource,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
import {
  createOverviewReader,
  toQueryTime,
} from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";

export interface ReadTeamOverviewInput {
  readonly env: Env;
  readonly teamId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly allowedSiteIds?: readonly string[];
}

export interface TeamOverviewQueryResult {
  readonly data: OverviewMetrics;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}

function source(values: readonly QuerySource[]): QuerySource {
  if (values.length === 0) return "raw";
  if (values.every((value) => value === values[0])) return values[0]!;
  return "mixed";
}

export async function readTeamOverview(
  input: ReadTeamOverviewInput,
): Promise<TeamOverviewQueryResult> {
  const allowed = input.allowedSiteIds ? new Set(input.allowedSiteIds) : null;
  const sites = (await listTeamSites(input.env, input.teamId)).filter(
    (site) => !allowed || allowed.has(site.id),
  );
  const time = toQueryTime(input.window);
  const results = await Promise.all(
    sites.map((site) =>
      createOverviewReader(input.env, site.id).readOverview({
        time,
        filters: input.filters,
      }),
    ),
  );
  const data = results.reduce<OverviewMetrics>(
    (total, result) => ({
      views: total.views + result.value.views,
      sessions: total.sessions + result.value.sessions,
      visitors: total.visitors + result.value.visitors,
      bounces: total.bounces + result.value.bounces,
      totalDurationMs: total.totalDurationMs + result.value.totalDurationMs,
      durationViews: total.durationViews + result.value.durationViews,
    }),
    {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDurationMs: 0,
      durationViews: 0,
    },
  );
  return {
    data,
    source: source(results.map((result) => result.source)),
    approximateVisitors: results.some((result) => result.approximateVisitors),
  };
}
