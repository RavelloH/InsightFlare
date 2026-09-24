import { MAX_FUNNEL_STEPS } from "./funnel-config";

export const FUNNEL_SQL_MAX_BINDINGS = 100;
export const FUNNEL_SQL_MAX_LENGTH = 1_000_000;
export const FUNNEL_SQL_CTES_PER_STEP = 6 as const;

export interface FunnelSqlStructuralBudget {
  readonly maxSteps: number;
  readonly maxStagedCtes: number;
  readonly maxFunnelCtes: number;
  readonly maxSqlLength: number;
  readonly maxBindings: number;
}

/** Bounded shape contract shared by application cost planning and D1 SQL. */
export const FUNNEL_SQL_STRUCTURAL_BUDGET: FunnelSqlStructuralBudget =
  Object.freeze({
    maxSteps: MAX_FUNNEL_STEPS,
    maxStagedCtes: MAX_FUNNEL_STEPS,
    maxFunnelCtes: MAX_FUNNEL_STEPS * FUNNEL_SQL_CTES_PER_STEP + 1,
    maxSqlLength: FUNNEL_SQL_MAX_LENGTH,
    maxBindings: FUNNEL_SQL_MAX_BINDINGS,
  });

export const FUNNEL_SQL_BASE_DATASET_BINDINGS = 6;
