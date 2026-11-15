import { vi } from "vitest";

import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryInput,
  type QueryOperation,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as membershipQueries from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-count-query";
import * as qualificationPrograms from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as overviewPrograms from "@/lib/edge/analytics/providers/d1/internal/overview-trend-qualification-program";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

import { COST_FILTER, COST_TIME } from "./referrers-cost-harness";
import { SEED_SITE_ID } from "./seed";

export interface ProviderCostScenario {
  readonly name: string;
  readonly family: string;
  readonly operation: QueryOperation;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly scope: "session" | "visitor";
  readonly filterDsl?: string;
}

export interface AnalyticsCostScenario extends ProviderCostScenario {
  readonly family: "pages" | "overview" | "events";
}

export interface AdditionalCostExecutors {
  readonly module: object;
  readonly names: readonly string[];
}

const reports = [
  {
    family: "pages",
    operation: "pages",
    parameters: { limit: 20, includeDetails: false },
    name: "pages aggregate",
  },
  {
    family: "pages",
    operation: "pages",
    parameters: { variant: "tabs", limit: 20 },
    name: "pages tabs",
  },
  {
    family: "overview",
    operation: "overview",
    parameters: {},
    name: "overview summary",
  },
  {
    family: "overview",
    operation: "trend",
    parameters: { interval: "day" },
    name: "overview trend",
  },
  {
    family: "events",
    operation: "event-summary",
    parameters: {},
    name: "events summary",
  },
  {
    family: "events",
    operation: "event-types",
    parameters: { limit: 20 },
    name: "events types",
  },
  {
    family: "events",
    operation: "event-trend",
    parameters: { interval: "day", limit: 8 },
    name: "events trend",
  },
] as const;

export const ANALYTICS_COST_SCENARIOS: readonly AnalyticsCostScenario[] =
  reports.flatMap((report) => [
    { ...report, scope: "session", name: `${report.name} / no filter` },
    {
      ...report,
      scope: "session",
      filterDsl: COST_FILTER,
      name: `${report.name} / session count`,
    },
    {
      ...report,
      scope: "visitor",
      filterDsl: COST_FILTER,
      name: `${report.name} / visitor count`,
    },
    {
      ...report,
      scope: "session",
      filterDsl: `${COST_FILTER} and time gte @range.start+1d`,
      name: `${report.name} / session count + time`,
    },
  ]);

export interface StrategyObservation {
  readonly executor: string;
  readonly kind: unknown;
  readonly fallbackReason: unknown;
}

/** Observe actual exported production executors; never replace their outcomes. */
export async function executeAnalyticsCostScenario(
  env: Env,
  scenario: ProviderCostScenario,
  additionalExecutors: readonly AdditionalCostExecutors[] = [],
) {
  const query = {
    ...prepareScopedQuery(scenario.operation, {
      context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
      time: COST_TIME,
      filters: scenario.filterDsl
        ? parseFilterDsl(scenario.filterDsl, analyticsFilterRegistry)
        : EMPTY_FILTER_DOCUMENT,
      scopePreference: scenario.scope,
    } as QueryInput & { readonly time: typeof COST_TIME }),
    ...scenario.parameters,
  };
  const strategyObservations: StrategyObservation[] = [];
  const restorations: (() => void)[] = [];
  let membershipCalls = 0;
  function observe(
    module: object,
    names: readonly string[],
    membership = false,
  ) {
    const target = module as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    for (const name of names) {
      const original = target[name]!;
      const spy = vi.spyOn(target, name).mockImplementation(async (...args) => {
        if (membership) membershipCalls += 1;
        const result = await original(...args);
        const outcome = result as
          { kind?: unknown; fallbackReason?: unknown } | undefined;
        strategyObservations.push({
          executor: name,
          kind: outcome?.kind ?? null,
          fallbackReason: outcome?.fallbackReason ?? null,
        });
        return result;
      });
      restorations.push(() => spy.mockRestore());
    }
  }
  observe(qualificationPrograms, [
    "executePagesAggregateQualificationProgram",
    "executePagesTabsQualificationProgram",
    "executeEventSummaryQualificationProgram",
    "executeEventTypesQualificationProgram",
    "executeEventTrendQualificationProgram",
  ]);
  observe(overviewPrograms, ["executeOverviewTrendQualificationProgram"]);
  for (const extra of additionalExecutors) observe(extra.module, extra.names);
  observe(
    membershipQueries,
    [
      "queryAdvancedFilterCountGuard",
      "queryAdvancedFilterCountMatches",
      "queryAdvancedFilterCountCombined",
      "queryAdvancedFilterCountPayloadCombined",
    ],
    true,
  );
  const core = vi.spyOn(evaluator, "evaluateFilterDocument");
  const diagnostics = createD1ReadDiagnostics();
  const started = performance.now();
  try {
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).resolve(scenario.operation);
    if (!provider)
      throw new Error(`c01_provider_missing:${scenario.operation}`);
    const result = await provider.execute(query as never);
    const actualStrategies: string[] = [];
    if (
      strategyObservations.some(
        (observation) => observation.kind === "executed",
      )
    )
      actualStrategies.push("sql-report-fusion");
    if (membershipCalls > 0) actualStrategies.push("sql-membership");
    if (core.mock.calls.length > 0) actualStrategies.push("bounded-core");
    if (!scenario.filterDsl) actualStrategies.push("unqualified-sql");
    if (actualStrategies.length === 0)
      throw new Error(`c01_strategy_observation_missing:${scenario.name}`);
    return {
      scenario: scenario.name,
      family: scenario.family,
      operation: scenario.operation,
      scope: scenario.scope,
      filterDsl: scenario.filterDsl ?? null,
      parameters: scenario.parameters,
      value: result.value,
      source: result.source ?? null,
      actualStrategies,
      strategyObservations,
      membershipCalls,
      coreCalls: core.mock.calls.length,
      diagnostics,
      elapsedMs: Number((performance.now() - started).toFixed(3)),
    };
  } finally {
    core.mockRestore();
    for (const restore of restorations.reverse()) restore();
  }
}
