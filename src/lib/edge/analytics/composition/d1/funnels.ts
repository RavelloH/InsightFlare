import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import {
  queryFunnelAnalysis,
  queryFunnelDefinition,
  queryFunnelDefinitions,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";

import {
  type D1SiteQueryRuntimeOptions,
  query,
  stringField,
  timeWindow,
} from "./shared";

export function registerFunnelProvider(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry.register(
    "funnel-analysis",
    typedQueryProvider<Record<string, unknown>>(async (input) => {
      const request = query(input!);
      const funnelId = stringField(request, "funnelId");
      if (!funnelId) {
        return {
          value: {
            funnels: await queryFunnelDefinitions(options.env, options.siteId),
          } as Record<string, unknown>,
        };
      }
      const funnel = await queryFunnelDefinition(
        options.env,
        options.siteId,
        funnelId,
      );
      return {
        value: {
          funnel,
          analysis:
            funnel && funnel.steps.length >= 2
              ? await queryFunnelAnalysis(
                  options.env,
                  options.siteId,
                  timeWindow(request.time),
                  request.filters ?? EMPTY_FILTER_DOCUMENT,
                  funnel.steps,
                )
              : null,
        } as Record<string, unknown>,
      };
    }),
  );
}
