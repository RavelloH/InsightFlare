import "@tanstack/react-start/server-only";

import type { QueryWindow } from "@/lib/edge/query/core";
import { listTeamSites } from "@/lib/edge/query/team";
import {
  assertFilterAudience,
  assertOperationAllowed,
  type BreakdownItem,
  type BreakdownResult,
  type FilterDocument,
  teamQueryContext,
  validateQueryFilters,
} from "@/lib/edge/query-contract";
import { analyticsFilterRegistry } from "@/lib/edge/query-contract/filter-registry";
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
      .slice(0, limit),
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
  const perSiteLimit = 200;
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
