import "@tanstack/react-start/server-only";

import {
  assertFilterAudience,
  assertOperationAllowed,
  type BreakdownItem,
  type BreakdownResult,
  type FilterDocument,
  teamQueryContext,
  validateTypedQueryFilters,
} from "@/lib/edge/analytics/contract";
import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
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
  const context = teamQueryContext(
    input.teamId,
    "api-v1",
    input.allowedSiteIds,
  );
  const operationError = assertOperationAllowed(context, "dimension");
  if (operationError) throw new Error(operationError.kind);
  const filterError = validateTypedQueryFilters(context, input.filters);
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
        context,
      }),
    ),
  );
  return mergeBreakdownItems(results, input.limit);
}
