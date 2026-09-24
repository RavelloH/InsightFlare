import { createD1FunnelDefinitionResource } from "@/lib/edge/analytics/providers/d1/resources/funnels";
import { createD1GoalDefinitionResource } from "@/lib/edge/analytics/providers/d1/resources/goals";
import type { FunnelDefinitionResource } from "@/lib/edge/analytics/resources/funnels";
import type { GoalDefinitionResource } from "@/lib/edge/analytics/resources/goals";
import type { Env } from "@/lib/edge/types";

import { createD1SiteProviderRegistry } from "./d1/create-site-runtime";
import { createD1TeamProviderRegistry } from "./d1/create-team-runtime";
import { registerComparisonQueryProviders } from "./comparison-query-providers";
import { createComparisonRuntime } from "./comparison-runtime";
import type { AnalyticsReadDiagnostics } from "./query-diagnostics";
import type { AnalyticsQueryRuntime } from "./query-runtime";
import { registerSiteRealtimeProviders } from "./site-realtime-providers";
import { createSiteAnalyticsRuntime } from "./site-runtime";
import { createTeamAnalyticsRuntime } from "./team-runtime";

export interface EdgeSiteAnalyticsRuntimeOptions {
  readonly env: Env;
  readonly siteId: string;
  readonly diagnostics?: AnalyticsReadDiagnostics;
}

export interface EdgeTeamAnalyticsRuntimeOptions {
  readonly env: Env;
  readonly teamId: string;
  readonly allowedSiteIds: readonly string[];
}

export type EdgeAnalyticsRuntime = AnalyticsQueryRuntime & {
  readonly readSiteCount: () => Promise<number>;
};
export type EdgeSiteAnalyticsRuntime = EdgeAnalyticsRuntime & {
  readonly resources: {
    readonly goals: GoalDefinitionResource;
    readonly funnels: FunnelDefinitionResource;
  };
};

/** Compose current Edge data sources before entering the source-neutral runtime. */
export function createEdgeSiteAnalyticsRuntime(
  options: EdgeSiteAnalyticsRuntimeOptions,
): EdgeSiteAnalyticsRuntime {
  const providerRegistry = createD1SiteProviderRegistry(options);
  registerSiteRealtimeProviders(providerRegistry, options);
  const comparisonRuntime = createComparisonRuntime({
    env: options.env,
    siteId: options.siteId,
  });
  registerComparisonQueryProviders(providerRegistry, comparisonRuntime);
  return {
    ...createSiteAnalyticsRuntime(providerRegistry),
    readSiteCount: comparisonRuntime.readSiteCount,
    resources: {
      goals: createD1GoalDefinitionResource(options.env),
      funnels: createD1FunnelDefinitionResource(options.env),
    },
  };
}

/** Compose current Edge data sources before entering the source-neutral runtime. */
export function createEdgeTeamAnalyticsRuntime(
  options: EdgeTeamAnalyticsRuntimeOptions,
): EdgeAnalyticsRuntime {
  const providerRegistry = createD1TeamProviderRegistry(options);
  const comparisonRuntime = createComparisonRuntime({
    env: options.env,
    teamId: options.teamId,
    allowedSiteIds: options.allowedSiteIds,
  });
  registerComparisonQueryProviders(providerRegistry, comparisonRuntime);
  return {
    ...createTeamAnalyticsRuntime(providerRegistry),
    readSiteCount: comparisonRuntime.readSiteCount,
  };
}
