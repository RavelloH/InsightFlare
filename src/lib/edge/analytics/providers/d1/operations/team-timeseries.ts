import "@tanstack/react-start/server-only";

import type {
  FilterDocument,
  QuerySource,
  TrendPoint,
  TrendResult,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
import {
  createOverviewReader,
  toQueryTime,
} from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";

export interface ReadTeamTimeseriesInput {
  readonly env: Env;
  readonly teamId: string;
  readonly window: QueryWindow;
  readonly interval: TrendResult["interval"];
  readonly filters: FilterDocument;
  readonly allowedSiteIds?: readonly string[];
}

export interface TeamTimeseriesQueryResult {
  readonly data: TrendResult;
  readonly source: QuerySource;
  readonly approximateVisitors: boolean;
}

function source(values: readonly QuerySource[]): QuerySource {
  if (values.length === 0) return "raw";
  if (values.every((value) => value === values[0])) return values[0]!;
  return "mixed";
}

function mergePoints(points: readonly TrendPoint[]): readonly TrendPoint[] {
  const merged = new Map<number, TrendPoint>();
  for (const point of points) {
    const current = merged.get(point.bucket);
    if (!current) {
      merged.set(point.bucket, { ...point });
      continue;
    }
    merged.set(point.bucket, {
      ...current,
      views: current.views + point.views,
      sessions: current.sessions + point.sessions,
      visitors: current.visitors + point.visitors,
      bounces: current.bounces + point.bounces,
      totalDurationMs: current.totalDurationMs + point.totalDurationMs,
      durationViews: current.durationViews + point.durationViews,
    });
  }
  return [...merged.values()].sort((left, right) => left.bucket - right.bucket);
}

export async function readTeamTimeseries(
  input: ReadTeamTimeseriesInput,
): Promise<TeamTimeseriesQueryResult> {
  const allowed = input.allowedSiteIds ? new Set(input.allowedSiteIds) : null;
  const sites = (await listTeamSites(input.env, input.teamId)).filter(
    (site) => !allowed || allowed.has(site.id),
  );
  const time = toQueryTime(input.window);
  const results = await Promise.all(
    sites.map((site) =>
      createOverviewReader(input.env, site.id).readTrend({
        time,
        filters: input.filters,
        interval: input.interval,
      }),
    ),
  );
  return {
    data: {
      interval: input.interval,
      points: mergePoints(results.flatMap((result) => result.value)),
    },
    source: source(results.map((result) => result.source)),
    approximateVisitors: results.some((result) => result.approximateVisitors),
  };
}
