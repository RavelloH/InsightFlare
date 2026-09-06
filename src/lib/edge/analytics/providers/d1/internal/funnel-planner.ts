import {
  type FunnelConfigV2,
  type FunnelStepV2,
  MAX_FUNNEL_STEPS,
  parseFunnelStepFilter,
  type ScopedDatasetSql,
  type SqlBinding,
} from "@/lib/edge/analytics/contract";

import {
  executeObservationFilterOnScopedDataset,
  type ScopedObservationFilterSql,
} from "./scoped-dataset";

/** D1's existing provider code treats one hundred parameters as the safe cap. */
export const FUNNEL_SQL_MAX_BINDINGS = 100;
/** A bounded statement budget for a ten-step plan and its filter expansion. */
export const FUNNEL_SQL_MAX_LENGTH = 1_000_000;
export const FUNNEL_SQL_CTES_PER_STEP = 6 as const;
export const MAX_HISTORICAL_FUNNEL_STEPS = 12 as const;

export interface FunnelSqlStructuralBudget {
  readonly maxSteps: number;
  readonly maxStagedCtes: number;
  readonly maxFunnelCtes: number;
  readonly maxSqlLength: number;
  readonly maxBindings: number;
}

/**
 * The staged part is exactly one `reached_i` CTE per step.  Each step also
 * contributes four filter relations, one witness relation, and that reached
 * relation; visitor mode adds one parameter CTE.
 */
export const FUNNEL_SQL_STRUCTURAL_BUDGET: FunnelSqlStructuralBudget =
  Object.freeze({
    maxSteps: MAX_FUNNEL_STEPS,
    maxStagedCtes: MAX_FUNNEL_STEPS,
    maxFunnelCtes: MAX_FUNNEL_STEPS * FUNNEL_SQL_CTES_PER_STEP + 1,
    maxSqlLength: FUNNEL_SQL_MAX_LENGTH,
    maxBindings: FUNNEL_SQL_MAX_BINDINGS,
  });

/** Compatibility budget for the pre-v2 database maximum. It is only used for
 * an already-stored definition; all new writes remain on the ten-step budget. */
export const FUNNEL_SQL_HISTORICAL_STRUCTURAL_BUDGET: FunnelSqlStructuralBudget =
  Object.freeze({
    maxSteps: MAX_HISTORICAL_FUNNEL_STEPS,
    maxStagedCtes: MAX_HISTORICAL_FUNNEL_STEPS,
    maxFunnelCtes: MAX_HISTORICAL_FUNNEL_STEPS * FUNNEL_SQL_CTES_PER_STEP + 1,
    maxSqlLength: FUNNEL_SQL_MAX_LENGTH,
    maxBindings: FUNNEL_SQL_MAX_BINDINGS,
  });

export interface FunnelSqlShape {
  readonly stepCount: number;
  readonly stagedCteCount: number;
  readonly funnelCteCount: number;
  readonly sqlLength: number;
  readonly bindingCount: number;
}

export interface FunnelSqlStepLayer {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly reachedRelation: string;
}

export interface FunnelSqlResultRow {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly sessions: number;
  readonly visitors: number;
}

export interface FunnelSqlPlan {
  readonly sql: string;
  readonly bindings: readonly SqlBinding[];
  readonly steps: readonly FunnelSqlStepLayer[];
  readonly shape: FunnelSqlShape;
}

function mergedBudget(
  budget: Partial<FunnelSqlStructuralBudget>,
): FunnelSqlStructuralBudget {
  return {
    ...FUNNEL_SQL_STRUCTURAL_BUDGET,
    ...budget,
  };
}

export function measureFunnelSqlShape(input: {
  readonly sql: string;
  readonly bindings: readonly unknown[];
  readonly stepCount: number;
  readonly funnelCteCount: number;
}): FunnelSqlShape {
  return {
    stepCount: input.stepCount,
    stagedCteCount: input.stepCount,
    funnelCteCount: input.funnelCteCount,
    sqlLength: input.sql.length,
    bindingCount: input.bindings.length,
  };
}

export function assertFunnelSqlShapeWithinBudget(
  shape: FunnelSqlShape,
  budget: Partial<FunnelSqlStructuralBudget> = {},
): void {
  const limits = mergedBudget(budget);
  if (shape.stepCount > limits.maxSteps) {
    throw new Error("funnel_sql_step_limit_exceeded");
  }
  if (shape.stagedCteCount > limits.maxStagedCtes) {
    throw new Error("funnel_sql_staged_cte_limit_exceeded");
  }
  if (shape.funnelCteCount > limits.maxFunnelCtes) {
    throw new Error("funnel_sql_cte_limit_exceeded");
  }
  if (shape.sqlLength > limits.maxSqlLength) {
    throw new Error("funnel_sql_length_exceeded");
  }
  if (shape.bindingCount > limits.maxBindings) {
    throw new Error("funnel_sql_binding_limit_exceeded");
  }
}

function identityColumn(
  scope: FunnelConfigV2["progressionScope"],
): "session_id" | "visitor_id" {
  return scope === "session" ? "session_id" : "visitor_id";
}

function identityPredicate(
  alias: string,
  identity: "session_id" | "visitor_id",
): string {
  return `TRIM(COALESCE(${alias}.${identity}, '')) != ''`;
}

function observationAfter(candidate: string, previous: string): string {
  return `(
    ${candidate}.observed_at > ${previous}.last_observed_at
    OR (
      ${candidate}.observed_at = ${previous}.last_observed_at
      AND (
        ${candidate}.observation_rank > ${previous}.last_observation_rank
        OR (
          ${candidate}.observation_rank = ${previous}.last_observation_rank
          AND (
            ${candidate}.sequence > ${previous}.last_sequence
            OR (
              ${candidate}.sequence = ${previous}.last_sequence
              AND ${candidate}.source_id > ${previous}.last_source_id
            )
          )
        )
      )
    )
  )`;
}

function witnessCte(
  stepIndex: number,
  filter: ScopedObservationFilterSql,
  identity: "session_id" | "visitor_id",
): string {
  const name = `funnel_step_${stepIndex}_witnesses`;
  return `
${name} AS (
  SELECT
    deduped.site_pk,
    deduped.session_id,
    deduped.visitor_id,
    deduped.observed_at,
    deduped.observation_rank,
    deduped.sequence,
    deduped.source_id
  FROM (
    SELECT
      candidates.*,
      ROW_NUMBER() OVER (
        PARTITION BY candidates.site_pk,
                     candidates.observation_rank,
                     candidates.source_id
        ORDER BY candidates.observed_at ASC,
                 candidates.observation_rank ASC,
                 candidates.sequence ASC,
                 candidates.source_id ASC
      ) AS source_rank
    FROM (
      SELECT
        v.site_pk,
        v.session_id,
        v.visitor_id,
        v.started_at AS observed_at,
        0 AS observation_rank,
        0 AS sequence,
        CAST(v.visit_id AS TEXT) AS source_id
      FROM ${filter.matchedVisitRelation} v
      WHERE v.site_pk IS NOT NULL
        AND ${identityPredicate("v", identity)}
        AND v.started_at IS NOT NULL
        AND TRIM(COALESCE(CAST(v.visit_id AS TEXT), '')) != ''
      UNION ALL
      SELECT
        e.site_pk,
        e.session_id,
        e.visitor_id,
        e.occurred_at AS observed_at,
        1 AS observation_rank,
        e.sequence AS sequence,
        CAST(e.event_id AS TEXT) AS source_id
      FROM ${filter.matchedEventRelation} e
      WHERE e.site_pk IS NOT NULL
        AND ${identityPredicate("e", identity)}
        AND e.occurred_at IS NOT NULL
        AND TRIM(COALESCE(CAST(e.event_id AS TEXT), '')) != ''
    ) candidates
  ) deduped
  WHERE deduped.source_rank = 1
)`;
}

function reachedZeroCte(
  filter: string,
  identity: "session_id" | "visitor_id",
): string {
  return `
reached_0 AS (
  SELECT
    ranked.site_pk,
    ranked.session_id,
    ranked.visitor_id,
    ranked.observed_at AS first_observed_at,
    ranked.observed_at AS last_observed_at,
    ranked.observation_rank AS last_observation_rank,
    ranked.sequence AS last_sequence,
    ranked.source_id AS last_source_id
  FROM (
    SELECT
      witnesses.*,
      ROW_NUMBER() OVER (
        PARTITION BY witnesses.site_pk, witnesses.${identity}
        ORDER BY witnesses.observed_at ASC,
                 witnesses.observation_rank ASC,
                 witnesses.sequence ASC,
                 witnesses.source_id ASC
      ) AS reached_rank
    FROM ${filter} witnesses
  ) ranked
  WHERE ranked.reached_rank = 1
)`;
}

function reachedNextCte(
  stepIndex: number,
  previous: string,
  filter: string,
  identity: "session_id" | "visitor_id",
  visitorWindow: boolean,
): string {
  const windowClause = visitorWindow
    ? `
        AND candidate.observed_at <= previous.first_observed_at
          + (SELECT conversion_window_ms FROM funnel_params)`
    : "";
  return `
reached_${stepIndex} AS (
  SELECT
    ranked.site_pk,
    ranked.session_id,
    ranked.visitor_id,
    ranked.first_observed_at,
    ranked.observed_at AS last_observed_at,
    ranked.observation_rank AS last_observation_rank,
    ranked.sequence AS last_sequence,
    ranked.source_id AS last_source_id
  FROM (
    SELECT
      previous.site_pk,
      previous.session_id,
      previous.visitor_id,
      previous.first_observed_at,
      candidate.observed_at,
      candidate.observation_rank,
      candidate.sequence,
      candidate.source_id,
      ROW_NUMBER() OVER (
        PARTITION BY previous.site_pk, previous.${identity}
        ORDER BY candidate.observed_at ASC,
                 candidate.observation_rank ASC,
                 candidate.sequence ASC,
                 candidate.source_id ASC
      ) AS reached_rank
    FROM reached_${stepIndex - 1} previous
    INNER JOIN ${filter} candidate
      ON candidate.site_pk = previous.site_pk
     AND candidate.${identity} = previous.${identity}
     AND ${observationAfter("candidate", "previous")}
     ${windowClause}
  ) ranked
  WHERE ranked.reached_rank = 1
)`;
}

function countRelation(
  reached: string,
  column: "session_id" | "visitor_id",
): string {
  return `(SELECT COUNT(*)
    FROM (
      SELECT DISTINCT site_pk, ${column}
      FROM ${reached}
      WHERE site_pk IS NOT NULL
        AND TRIM(COALESCE(${column}, '')) != ''
    ))`;
}

function resultSql(
  steps: readonly FunnelStepV2[],
  firstFilter: ScopedObservationFilterSql,
): string {
  return steps
    .map(
      (_step, index) => `
SELECT
  ${index} AS stepIndex,
  ? AS stepId,
  ${countRelation(
    index === 0 ? firstFilter.sessionRelation : `reached_${index}`,
    "session_id",
  )} AS sessions,
  ${countRelation(
    index === 0 ? firstFilter.visitorRelation : `reached_${index}`,
    "visitor_id",
  )} AS visitors`,
    )
    .join("\nUNION ALL\n")
    .concat("\nORDER BY stepIndex ASC");
}

export function assertFunnelStructuralBudget(stepCount: number): void {
  if (!Number.isSafeInteger(stepCount) || stepCount < 1) {
    throw new Error("funnel_steps_required");
  }
  if (stepCount > MAX_FUNNEL_STEPS) {
    throw new Error("funnel_sql_step_limit_exceeded");
  }
  const estimatedCtes = stepCount * FUNNEL_SQL_CTES_PER_STEP + 1;
  if (estimatedCtes > FUNNEL_SQL_STRUCTURAL_BUDGET.maxFunnelCtes) {
    throw new Error("funnel_sql_cte_limit_exceeded");
  }
}

function assertConfigShape(config: FunnelConfigV2): void {
  assertFunnelStructuralBudget(config.steps.length);
  if (config.progressionScope === "visitor") {
    if (
      config.conversionWindowMs === null ||
      !Number.isFinite(config.conversionWindowMs) ||
      config.conversionWindowMs <= 0
    ) {
      throw new Error("visitor_funnel_conversion_window_must_be_positive");
    }
  } else if (config.conversionWindowMs !== null) {
    throw new Error("session_funnel_conversion_window_must_be_null");
  }
}

function assertHistoricalConfigShape(config: FunnelConfigV2): void {
  if (!Number.isSafeInteger(config.steps.length) || config.steps.length < 1) {
    throw new Error("funnel_steps_required");
  }
  if (config.steps.length > MAX_HISTORICAL_FUNNEL_STEPS) {
    throw new Error("funnel_historical_step_limit_exceeded");
  }
  if (config.progressionScope === "visitor") {
    if (
      config.conversionWindowMs === null ||
      !Number.isFinite(config.conversionWindowMs) ||
      config.conversionWindowMs <= 0
    ) {
      throw new Error("visitor_funnel_conversion_window_must_be_positive");
    }
  } else if (config.conversionWindowMs !== null) {
    throw new Error("session_funnel_conversion_window_must_be_null");
  }
}

/**
 * Build one D1 statement for a Funnel v2 config over a prepared dataset.
 * Every step owns an independent observation-filter bundle.  The progression
 * CTEs consume only those bundles' final matched relations and never access
 * raw tables or alter the dataset window.
 */
export function buildFunnelSqlPlan(
  config: FunnelConfigV2,
  dataset: ScopedDatasetSql,
  options: { readonly allowHistoricalOverLimit?: boolean } = {},
): FunnelSqlPlan {
  if (options.allowHistoricalOverLimit) {
    assertHistoricalConfigShape(config);
  } else {
    assertConfigShape(config);
  }
  const identity = identityColumn(config.progressionScope);
  const visitorWindow = config.progressionScope === "visitor";
  const funnelCtes: string[] = [];
  const filterBindings: SqlBinding[] = [];
  const layers: FunnelSqlStepLayer[] = [];
  let firstFilter: ScopedObservationFilterSql | undefined;

  if (visitorWindow) {
    funnelCtes.push("funnel_params AS (SELECT ? AS conversion_window_ms)");
  }

  config.steps.forEach((step, stepIndex) => {
    const filter = executeObservationFilterOnScopedDataset(
      dataset,
      parseFunnelStepFilter(step),
      `funnel_step_${stepIndex}`,
    );
    funnelCtes.push(filter.ctes.trim());
    filterBindings.push(...filter.bindings);
    if (stepIndex === 0) firstFilter = filter;

    const witnesses = `funnel_step_${stepIndex}_witnesses`;
    funnelCtes.push(witnessCte(stepIndex, filter, identity));
    funnelCtes.push(
      stepIndex === 0
        ? reachedZeroCte(witnesses, identity)
        : reachedNextCte(
            stepIndex,
            `reached_${stepIndex - 1}`,
            witnesses,
            identity,
            visitorWindow,
          ),
    );
    layers.push({
      stepId: step.id,
      stepIndex,
      reachedRelation: `reached_${stepIndex}`,
    });
  });

  const sql = `WITH
${dataset.ctes.trim()},
${funnelCtes.join(",\n")}
${resultSql(config.steps, firstFilter!)}`;
  const bindings: SqlBinding[] = [
    ...dataset.bindings,
    ...(visitorWindow ? [{ value: config.conversionWindowMs! }] : []),
    ...filterBindings,
    ...config.steps.map((step) => ({ value: step.id })),
  ];
  const shape = measureFunnelSqlShape({
    sql,
    bindings,
    stepCount: config.steps.length,
    funnelCteCount:
      config.steps.length * FUNNEL_SQL_CTES_PER_STEP + (visitorWindow ? 1 : 0),
  });
  assertFunnelSqlShapeWithinBudget(
    shape,
    options.allowHistoricalOverLimit
      ? FUNNEL_SQL_HISTORICAL_STRUCTURAL_BUDGET
      : FUNNEL_SQL_STRUCTURAL_BUDGET,
  );

  return {
    sql,
    bindings,
    steps: layers,
    shape,
  };
}

/** Alias kept concise for callers that use planner terminology. */
export const planFunnelSql = buildFunnelSqlPlan;
