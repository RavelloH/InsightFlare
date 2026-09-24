import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";

import { createAnalyticsQueryRuntime } from "./query-runtime";

/** Source-neutral provider input for the canonical team analytics runtime. */
export function createTeamAnalyticsRuntime(
  providerRegistry: AnalyticsProviderRegistry,
) {
  return createAnalyticsQueryRuntime(providerRegistry);
}
