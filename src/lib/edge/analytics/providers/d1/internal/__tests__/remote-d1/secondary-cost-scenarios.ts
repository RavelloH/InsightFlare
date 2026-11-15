import * as eventRecords from "@/lib/edge/analytics/providers/d1/internal/analytics-event-record-qualification-program";
import * as sessions from "@/lib/edge/analytics/providers/d1/internal/session-list-qualification-program";
import * as visitors from "@/lib/edge/analytics/providers/d1/internal/visitor-list-qualification-program";
import type { Env } from "@/lib/edge/types";

import {
  executeAnalyticsCostScenario,
  type ProviderCostScenario,
} from "./analytics-cost-scenarios";
import { COST_FILTER } from "./referrers-cost-harness";

export interface SecondaryCostScenario extends ProviderCostScenario {
  readonly family: "lists";
  readonly operation:
    "visitors" | "sessions" | "visitor-sessions" | "event-records";
}

const page = { limit: 20, cursor: null } as const;
const lists = [
  {
    operation: "visitors",
    scope: "visitor",
    parameters: { page, sort: { key: "lastSeenAt", direction: "desc" } },
  },
  {
    operation: "sessions",
    scope: "session",
    parameters: { page, sort: { key: "startedAt", direction: "desc" } },
  },
  {
    operation: "visitor-sessions",
    scope: "visitor",
    parameters: { visitorId: "vis20", page },
  },
  {
    operation: "event-records",
    scope: "session",
    parameters: { page, sort: { direction: "desc" } },
  },
] as const;

/** New baselines: no historical cost or before-budget claim for these lists. */
export const SECONDARY_COST_SCENARIOS: readonly SecondaryCostScenario[] =
  lists.flatMap((list) => [
    { ...list, family: "lists", name: `${list.operation} / no filter` },
    {
      ...list,
      family: "lists",
      name: `${list.operation} / count`,
      filterDsl: COST_FILTER,
    },
    {
      ...list,
      family: "lists",
      name: `${list.operation} / count + time`,
      filterDsl: `${COST_FILTER} and time gte @range.start+1d`,
    },
  ]);

export function executeSecondaryCostScenario(
  env: Env,
  scenario: SecondaryCostScenario,
) {
  return executeAnalyticsCostScenario(env, scenario, [
    { module: visitors, names: ["executeVisitorListQualificationProgram"] },
    { module: sessions, names: ["executeSessionListQualificationProgram"] },
    {
      module: eventRecords,
      names: ["executeEventRecordsQualificationProgram"],
    },
  ]);
}
