import type { ComparisonRuntime } from "@/lib/edge/analytics/application/comparison-runtime";
import { createComparisonProviders } from "@/lib/edge/analytics/providers/d1/comparison";
import { listTeamSites } from "@/lib/edge/analytics/providers/d1/internal/team";
import type { Env } from "@/lib/edge/types";

export interface ComparisonRuntimeOptions {
  readonly env: Env;
  readonly siteId?: string;
  readonly teamId?: string;
  readonly allowedSiteIds?: readonly string[];
}

/** Binds D1 comparison providers and the matching cost-estimate reader. */
export function createComparisonRuntime(
  options: ComparisonRuntimeOptions,
): ComparisonRuntime {
  return {
    providers: createComparisonProviders(options),
    readSiteCount: async () => {
      if (!options.teamId) return 1;
      const sites = await listTeamSites(options.env, options.teamId);
      const allowed =
        options.allowedSiteIds && options.allowedSiteIds.length > 0
          ? new Set(options.allowedSiteIds)
          : null;
      return Math.max(
        1,
        sites.filter((site) => !allowed || allowed.has(site.id)).length,
      );
    },
  };
}
