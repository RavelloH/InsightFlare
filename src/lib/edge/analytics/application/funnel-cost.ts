import {
  FUNNEL_SQL_MAX_BINDINGS,
  FUNNEL_SQL_STRUCTURAL_BUDGET,
} from "@/lib/edge/analytics/contract/funnel-budget";

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
