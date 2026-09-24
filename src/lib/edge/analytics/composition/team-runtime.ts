import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";

import { createAnalyticsQueryRuntime } from "./query-runtime";

/** Source-neutral provider input for the canonical team analytics runtime. */
export interface TeamAnalyticsRuntimeOptions {
  readonly providerRegistry: AnalyticsProviderRegistry;
}

export function createTeamAnalyticsRuntime(
  options: TeamAnalyticsRuntimeOptions,
) {
  return createAnalyticsQueryRuntime(options.providerRegistry);
}
