import {
  analyticsOperationProvider,
  TypedApplicationProviderRegistry,
} from "@/lib/edge/analytics/application/provider-registry";
import type { OverviewQuery, TrendQuery } from "@/lib/edge/analytics/contract";
import {
  executeOverview,
  executeTrend,
  type OverviewReader,
} from "@/lib/edge/analytics/contract/overview";

/**
 * Overview and timeseries are ordinary application operations. Their
 * composite reader is adapted here, at the D1 composition boundary, instead
 * of receiving special methods on TypedQueryApplicationService.
 */
export function createOverviewProviderRegistry(
  reader: OverviewReader,
): TypedApplicationProviderRegistry {
  return new TypedApplicationProviderRegistry()
    .register(
      "site.analytics.overview",
      analyticsOperationProvider<
        OverviewQuery,
        Awaited<ReturnType<typeof executeOverview>>
      >((query) => executeOverview(reader, query)),
    )
    .register(
      "site.analytics.timeseries",
      analyticsOperationProvider<
        TrendQuery,
        Awaited<ReturnType<typeof executeTrend>>
      >((query) => executeTrend(reader, query)),
    );
}
