import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { createOverviewReader } from "@/lib/edge/analytics/providers/d1/operations/overview-reader";

import { registerEventProviders } from "./events";
import { registerFunnelProvider } from "./funnels";
import { registerJourneyProviders } from "./journeys";
import { overviewProvider, trendProvider } from "./overview";
import type { D1SiteQueryRuntimeOptions } from "./shared";
import { registerSiteContractProviders } from "./site";
import { registerTechnologyProviders } from "./technology";

export type { D1SiteQueryRuntimeOptions } from "./shared";
export type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";

/**
 * Compose the D1 implementation for the canonical site overview operations.
 * Audience policy and filter authorization are validated by the application
 * service before the provider is invoked.
 */
export function createD1SiteQueryRuntime(options: D1SiteQueryRuntimeOptions) {
  const diagnostics = options.diagnostics ?? createD1ReadDiagnostics();
  const reader = createOverviewReader(options.env, options.siteId, diagnostics);
  const registry = new AnalyticsProviderRegistry()
    .register("overview", overviewProvider(reader))
    .register("trend", trendProvider(reader));
  registerSiteContractProviders(registry, options);
  registerEventProviders(registry, options);
  registerJourneyProviders(registry, options);
  registerTechnologyProviders(registry, options);
  registerFunnelProvider(registry, options);

  return createAnalyticsQueryRuntime(registry);
}
