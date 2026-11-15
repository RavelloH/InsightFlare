import { expect } from "vitest";

import type {
  CanonicalFunnelAnalysisResult,
  RetentionResult,
} from "@/lib/edge/analytics/contract";
import type { CanonicalEventFieldsResult } from "@/lib/edge/analytics/contract/operation-results";
import * as qualification from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import * as funnels from "@/lib/edge/analytics/providers/d1/internal/funnels";
import * as retention from "@/lib/edge/analytics/providers/d1/internal/retention-qualification-program";
import type { Env } from "@/lib/edge/types";

import {
  executeAnalyticsCostScenario,
  type ProviderCostScenario,
} from "./analytics-cost-scenarios";
import { NEXT_FUNNEL_ID } from "./journey-event-fields-cost-fixture";
import { COST_FILTER } from "./referrers-cost-harness";

const reports = [
  {
    operation: "retention",
    family: "retention",
    parameters: { granularity: "day" },
  },
  {
    operation: "funnel-analysis",
    family: "funnel",
    parameters: { funnelId: NEXT_FUNNEL_ID },
  },
  {
    operation: "event-fields",
    family: "event-fields",
    parameters: { eventName: "qualifier", limit: 20, cursor: null },
  },
] as const;

export const JOURNEY_EVENT_FIELDS_COST_SCENARIOS: readonly ProviderCostScenario[] =
  reports.flatMap((report) =>
    [undefined, COST_FILTER, `${COST_FILTER} and time gte @range.start+1d`].map(
      (filterDsl, index) => ({
        ...report,
        scope: "session" as const,
        filterDsl,
        name: `${report.operation} / ${["no filter", "count", "count + time"][index]}`,
      }),
    ),
  );

/** Executor outcomes and calls are observed, never supplied by the fixture. */
export async function executeJourneyEventFieldsCostScenario(
  env: Env,
  scenario: ProviderCostScenario,
) {
  const result = await executeAnalyticsCostScenario(env, scenario, [
    { module: retention, names: ["executeRetentionQualificationProgram"] },
    {
      module: qualification,
      names: ["executeEventFieldsQualificationProgram"],
    },
    { module: funnels, names: ["queryFunnelAnalysis"] },
  ]);
  if (scenario.operation === "funnel-analysis") {
    expect(
      result.strategyObservations.some(
        (observation) => observation.executor === "queryFunnelAnalysis",
      ),
    ).toBe(true);
    result.actualStrategies.push("sql-funnel-progression");
  }
  return result;
}

/** These dispatch-specific casts follow the actual canonical operation. */
export function assertPositiveJourneyEventFieldsDto(
  scenario: ProviderCostScenario,
  value: unknown,
) {
  if (scenario.operation === "retention") {
    const result = value as RetentionResult;
    expect(result.cohorts.some((cohort) => cohort.size > 0)).toBe(true);
    expect(
      result.cohorts.some((cohort) =>
        cohort.periods.some(
          (period) => period.index > 0 && period.visitors > 0,
        ),
      ),
    ).toBe(true);
  } else if (scenario.operation === "funnel-analysis") {
    const result = value as CanonicalFunnelAnalysisResult;
    if (!("funnel" in result))
      throw new Error("c01_next_funnel_analysis_result_missing");
    expect(result.funnel?.id).toBe(NEXT_FUNNEL_ID);
    expect(result.analysis?.summary.totalProgressions).toBeGreaterThan(0);
    expect(result.analysis?.summary.convertedProgressions).toBeGreaterThan(0);
  } else if (scenario.operation === "event-fields") {
    const result = value as CanonicalEventFieldsResult;
    expect(result.data.items.length).toBeGreaterThan(0);
    expect(result.data.items.some((field) => field.path === "/plan")).toBe(
      true,
    );
  } else throw new Error(`c01_next_unexpected_operation:${scenario.operation}`);
}
