import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import {
  EMPTY_FILTER_DOCUMENT,
  type FunnelConfigV2,
} from "@/lib/edge/analytics/contract";
import {
  decodeFunnelDefinitionCursor,
  queryFunnelAnalysis,
  queryFunnelDefinition,
  queryFunnelDefinitionsPage,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
import { InvalidCursorError } from "@/lib/pagination";

import { type D1SiteRuntimeBindings, stringField, timeWindow } from "./shared";
export {
  archiveFunnelDefinition,
  createFunnelDefinition,
  queryFunnelDefinition,
  updateFunnelDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
export function registerFunnelProvider(
  registry: AnalyticsProviderRegistry,
  options: D1SiteRuntimeBindings,
): void {
  registry.register(
    "funnel-analysis",
    typedQueryProviderFor("funnel-analysis", async (input) => {
      const request = input;
      const funnelId = stringField(request, "funnelId");
      if (!funnelId) {
        const limit = request.page?.limit ?? 50;
        const cursorText = request.page?.cursor ?? null;
        const cursor = await decodeFunnelDefinitionCursor(
          options.env,
          options.siteId,
          cursorText,
        );
        if (cursorText && !cursor) throw new InvalidCursorError("funnels");
        return {
          value: await queryFunnelDefinitionsPage(
            options.env,
            options.siteId,
            limit,
            cursor,
          ),
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
                  {
                    filterDslVersion: funnel.filterDslVersion,
                    progressionScope: funnel.progressionScope,
                    conversionWindowMs: funnel.conversionWindowMs,
                    steps: funnel.steps,
                  } satisfies FunnelConfigV2,
                )
              : null,
        },
      };
    }),
  );
}
