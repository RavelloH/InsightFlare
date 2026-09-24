import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";

import { createAnalyticsQueryRuntime } from "./query-runtime";

/** Source-neutral provider input for the canonical site analytics runtime. */
export function createSiteAnalyticsRuntime(
  providerRegistry: AnalyticsProviderRegistry,
) {
  return createAnalyticsQueryRuntime(providerRegistry);
}
