import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";

import { createAnalyticsQueryRuntime } from "./query-runtime";

/** Source-neutral provider input for the canonical site analytics runtime. */
export interface SiteAnalyticsRuntimeOptions {
  readonly providerRegistry: AnalyticsProviderRegistry;
}

export function createSiteAnalyticsRuntime(
  options: SiteAnalyticsRuntimeOptions,
) {
  return createAnalyticsQueryRuntime(options.providerRegistry);
}
