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

/** Compose current Edge data sources before entering the source-neutral runtime. */
export function createEdgeSiteAnalyticsRuntime(
  options: EdgeSiteAnalyticsRuntimeOptions,
): EdgeAnalyticsRuntime {
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
