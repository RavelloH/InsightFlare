import type { Env } from "@/lib/edge/types";

import { registerComparisonQueryProviders } from "./comparison-query-providers";
import { createComparisonRuntime } from "./comparison-runtime";
import { createD1SiteQueryRuntime, createD1TeamQueryRuntime } from "./d1";
import type { AnalyticsReadDiagnostics } from "./query-diagnostics";
import type { AnalyticsQueryRuntime } from "./query-runtime";
import { registerSiteAnalyticsOperations } from "./site-operation-providers";
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
  const providers = createD1SiteQueryRuntime(options);
  registerSiteAnalyticsOperations(providers, options);
  registerSiteRealtimeProviders(providers.providerRegistry, options);
  const comparisonRuntime = createComparisonRuntime({
    env: options.env,
    siteId: options.siteId,
  });
  registerComparisonQueryProviders(
    providers.providerRegistry,
    comparisonRuntime,
  );
  return {
    ...createSiteAnalyticsRuntime({
      providerRegistry: providers.providerRegistry,
    }),
    readSiteCount: comparisonRuntime.readSiteCount,
  };
}

/** Compose current Edge data sources before entering the source-neutral runtime. */
export function createEdgeTeamAnalyticsRuntime(
  options: EdgeTeamAnalyticsRuntimeOptions,
): EdgeAnalyticsRuntime {
  const providers = createD1TeamQueryRuntime(options);
  const comparisonRuntime = createComparisonRuntime({
    env: options.env,
    teamId: options.teamId,
    allowedSiteIds: options.allowedSiteIds,
  });
  registerComparisonQueryProviders(
    providers.providerRegistry,
    comparisonRuntime,
  );
  return {
    ...createTeamAnalyticsRuntime({
      providerRegistry: providers.providerRegistry,
    }),
    readSiteCount: comparisonRuntime.readSiteCount,
  };
}
