import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";

export function createProviderRegistry(): AnalyticsProviderRegistry {
  return new AnalyticsProviderRegistry();
}
