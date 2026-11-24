import "@tanstack/react-start/server-only";

import {
  type BreakdownItem,
  type BreakdownResult,
  type FilterDocument,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { resolveCrossBreakdownDimension } from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import {
  listTeamSites,
  queryTeamDimensionFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import type { Env } from "@/lib/edge/types";

import { readSiteBreakdown } from "./site-breakdown";

export interface ReadTeamBreakdownInput {
  readonly env: Env;
  readonly teamId: string;
  readonly window: QueryWindow;
  readonly dimension: string;
  readonly limit: number;
  readonly filters: FilterDocument;
  readonly allowedSiteIds?: readonly string[];
}

function mergeBreakdownItems(
  results: readonly BreakdownResult[],
  limit: number,
): BreakdownResult {
  const items = new Map<string, BreakdownItem>();
  for (const result of results) {
    for (const item of result.items) {
      const current = items.get(item.key);
      items.set(
        item.key,
        current
          ? {
              ...current,
              views: current.views + item.views,
              sessions: current.sessions + item.sessions,
              visitors: current.visitors + item.visitors,
            }
          : { ...item },
      );
    }
  }
  return {
    items: [...items.values()]
      .sort(
        (left, right) =>
          right.views - left.views || left.key.localeCompare(right.key),
      )
      .slice(0, limit > 0 ? limit : undefined),
  };
}

/** Aggregate site-level typed dimensions under the authenticated team policy. */
export async function readTeamBreakdown(
  input: ReadTeamBreakdownInput,
): Promise<BreakdownResult> {
  const allowed = input.allowedSiteIds ? new Set(input.allowedSiteIds) : null;
  const sites = (await listTeamSites(input.env, input.teamId)).filter(
    (site) => !allowed || allowed.has(site.id),
  );
  if (sites.length === 0) return { items: [] };

  const definition = resolveCrossBreakdownDimension(input.dimension);
  // Prepared SQL filters carry a site-isolated scoped plan. Unprepared
  // non-empty filters and special session/event dimensions retain the
  // historical per-site path instead of approximating their semantics.
  if (
    definition &&
    (input.filters.root === null || scopedFilterMetadata(input.filters))
  ) {
    const rows = await queryTeamDimensionFromD1(
      input.env,
      sites.map((site) => site.id),
      input.window,
      input.filters,
      definition.labelExpr,
    );
    return {
      items: rows
        .slice(0, input.limit > 0 ? input.limit : undefined)
        .map((row) => ({
          key: row.value,
          label: row.value,
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
        })),
    };
  }

  // A non-positive limit is the internal exact-aggregate mode used by the
  // comparison engine. It intentionally omits the historical per-site top
  // candidate cut; applying a limit before the merge is not exact.
  const perSiteLimit = 0;
  const results = await Promise.all(
    sites.map((site) =>
      readSiteBreakdown({
        env: input.env,
        siteId: site.id,
        window: input.window,
        dimension: input.dimension,
        limit: perSiteLimit,
        filters: input.filters,
      }),
    ),
  );
  return mergeBreakdownItems(results, input.limit);
}
