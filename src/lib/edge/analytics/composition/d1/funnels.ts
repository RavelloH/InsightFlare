import type { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { typedQueryProvider } from "@/lib/edge/analytics/application/provider-registry";
import {
  EMPTY_FILTER_DOCUMENT,
  type FunnelConfigV2,
} from "@/lib/edge/analytics/contract";
import {
  FUNNEL_SQL_MAX_BINDINGS,
  FUNNEL_SQL_STRUCTURAL_BUDGET,
} from "@/lib/edge/analytics/providers/d1/internal/funnel-planner";
import {
  decodeFunnelDefinitionCursor,
  queryFunnelAnalysis,
  queryFunnelDefinition,
  queryFunnelDefinitionsPage,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
import { InvalidCursorError } from "@/lib/pagination";

import {
  type D1SiteRuntimeBindings,
  query,
  stringField,
  timeWindow,
} from "./shared";
export {
  archiveFunnelDefinition,
  createFunnelDefinition,
  queryFunnelDefinition,
  updateFunnelDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/funnels";
export function funnelAnalysisCost(rangeMs: number) {
  return {
    rangeMs,
    siteCount: 1,
    metricCount: 1,
    provider: "d1" as const,
    funnelStepCount: FUNNEL_SQL_STRUCTURAL_BUDGET.maxSteps,
    funnelCteCount: FUNNEL_SQL_STRUCTURAL_BUDGET.maxFunnelCtes,
    funnelSqlLength: FUNNEL_SQL_STRUCTURAL_BUDGET.maxSqlLength,
    funnelBindingCount: FUNNEL_SQL_MAX_BINDINGS,
    funnelWorstCase: true,
  };
}
export function registerFunnelProvider(
  registry: AnalyticsProviderRegistry,
  options: D1SiteRuntimeBindings,
): void {
  registry.register(
    "funnel-analysis",
    typedQueryProvider<Record<string, unknown>>(async (input) => {
      const request = query(input!);
      const funnelId = stringField(request, "funnelId");
      if (!funnelId) {
        const pageValue = request.page;
        const page =
          pageValue && typeof pageValue === "object"
            ? (pageValue as { limit?: unknown; cursor?: unknown })
            : {};
        const limit =
          typeof page.limit === "number" && Number.isFinite(page.limit)
            ? page.limit
            : 50;
        const cursorText = typeof page.cursor === "string" ? page.cursor : null;
        const cursor = await decodeFunnelDefinitionCursor(
          options.env,
          options.siteId,
          cursorText,
        );
        if (cursorText && !cursor) throw new InvalidCursorError("funnels");
        return {
          value: (await queryFunnelDefinitionsPage(
            options.env,
            options.siteId,
            limit,
            cursor,
          )) as Record<string, unknown>,
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
        } as Record<string, unknown>,
      };
    }),
  );
}
