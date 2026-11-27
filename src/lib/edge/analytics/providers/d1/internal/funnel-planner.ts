import {
  type FunnelConfigV2,
  type FunnelStepV2,
  MAX_FUNNEL_STEPS,
  parseFunnelStepFilter,
} from "@/lib/edge/analytics/contract";

import {
  FUNNEL_SQL_CTES_PER_STEP,
  FUNNEL_SQL_MAX_BINDINGS as FUNNEL_CONFIG_MAX_SQL_BINDINGS,
  FUNNEL_SQL_MAX_LENGTH as FUNNEL_CONFIG_MAX_SQL_LENGTH,
  FUNNEL_SQL_STRUCTURAL_BUDGET,
  type FunnelSqlStructuralBudget,
} from "./funnel-budget";
import type { ScopedDatasetSql, SqlBinding } from "./scoped-dataset";
export { FUNNEL_SQL_CTES_PER_STEP, FUNNEL_SQL_STRUCTURAL_BUDGET };
export type { FunnelSqlStructuralBudget };
import {
  executeObservationFilterOnScopedDataset,
  type ScopedObservationFilterSql,
} from "./scoped-dataset";
/** D1's existing provider code treats one hundred parameters as the safe cap. */
export const FUNNEL_SQL_MAX_BINDINGS = FUNNEL_CONFIG_MAX_SQL_BINDINGS;
/** A bounded statement budget for a ten-step plan and its filter expansion. */
export const FUNNEL_SQL_MAX_LENGTH = FUNNEL_CONFIG_MAX_SQL_LENGTH;
export const MAX_HISTORICAL_FUNNEL_STEPS = 12 as const;
/** Compatibility budget for the pre-v2 database maximum. It is only used for
 * an already-stored definition; all new writes remain on the ten-step budget. */
export const FUNNEL_SQL_HISTORICAL_STRUCTURAL_BUDGET: FunnelSqlStructuralBudget =
  Object.freeze({
    maxSteps: MAX_HISTORICAL_FUNNEL_STEPS,
    maxStagedCtes: MAX_HISTORICAL_FUNNEL_STEPS,
    maxFunnelCtes:
      MAX_HISTORICAL_FUNNEL_STEPS * (FUNNEL_SQL_CTES_PER_STEP + 1) + 2,
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
export interface FunnelMembershipSqlPlan {
  readonly ctes: string;
  readonly bindings: readonly SqlBinding[];
  readonly relation: string;
  readonly identity: "session_id" | "visitor_id";
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
function observationAfter(
  candidate: string,
  previous: string,
  compact: boolean,
): string {
  if (compact) {
    // The JOIN accepts only TRUE; a row-value comparison preserves the
    // lexicographic ordering (including NULL) without the deep OR tree.
    return `(
      ${candidate}.observed_at, ${candidate}.observation_rank,
      ${candidate}.sequence, ${candidate}.source_id
    ) > (
      ${previous}.last_observed_at, ${previous}.last_observation_rank,
      ${previous}.last_sequence, ${previous}.last_source_id
    )`;
  }
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
  uniqueObservationIds: boolean,
): string {
  const name = `funnel_step_${stepIndex}_witnesses`;
  const candidates = `
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
`;
  if (uniqueObservationIds) return `${name} AS (${candidates})`;
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
      ${candidates}
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
  materialize: boolean,
  compactOrdering: boolean,
): string {
  const windowClause = visitorWindow
    ? `
        AND candidate.observed_at <= previous.first_observed_at
          + (SELECT conversion_window_ms FROM funnel_params)`
    : "";
  return `
reached_${stepIndex} AS ${materialize ? "MATERIALIZED " : ""}(
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
    FROM ${previous} previous
    INNER JOIN ${filter} candidate
      ON candidate.site_pk = previous.site_pk
     AND candidate.${identity} = previous.${identity}
     AND ${observationAfter("candidate", "previous", compactOrdering)}
     ${windowClause}
  ) ranked
  WHERE ranked.reached_rank = 1
)`;
}
const COMPACT_RESULT_MIN_STEPS = 6;

function resultCteCount(stepCount: number): number {
  return stepCount >= COMPACT_RESULT_MIN_STEPS ? stepCount + 1 : 0;
}

function resultSql(
  steps: readonly FunnelStepV2[],
  firstFilter: ScopedObservationFilterSql,
): { ctes: readonly string[]; sql: string } {
  // Step zero counts all matched observations, independently of whether the
  // other identity or the witness ordering fields are valid. Later steps
  // count reached progressions only. Group by site to keep composite identity
  // semantics without rescanning either source for the second metric.
  const firstObservations = `(
    SELECT site_pk, session_id, visitor_id FROM ${firstFilter.matchedVisitRelation}
    UNION ALL
    SELECT site_pk, session_id, visitor_id FROM ${firstFilter.matchedEventRelation}
  )`;
  const counts = steps.map(
    (_step, index) => `
SELECT
  ${index} AS stepIndex,
  ? AS stepId,
  COALESCE(SUM(sessions), 0) AS sessions,
  COALESCE(SUM(visitors), 0) AS visitors
FROM (
  SELECT site_pk,
    COUNT(DISTINCT CASE WHEN TRIM(COALESCE(session_id, '')) != '' THEN session_id END) AS sessions,
    COUNT(DISTINCT CASE WHEN TRIM(COALESCE(visitor_id, '')) != '' THEN visitor_id END) AS visitors
  FROM ${index === 0 ? firstObservations : `reached_${index}`}
  WHERE site_pk IS NOT NULL
  GROUP BY site_pk
)`,
  );
  if (steps.length < COMPACT_RESULT_MIN_STEPS) {
    return {
      ctes: [],
      sql: counts.join("\nUNION ALL\n").concat("\nORDER BY stepIndex ASC"),
    };
  }

  // D1 expands the UNION of long, nested progression chains beyond its
  // compound-SELECT limit. Each count is exactly one row (including zero).
  // Join those scalar aggregates once, then project one row per stage.
  const names = steps.map((_, index) => `counted_${index}`);
  const fields = ["stepId", "sessions", "visitors"].map(
    (field) =>
      `CASE stage.stepIndex ${names.map((name, index) => `WHEN ${index} THEN ${name}.${field}`).join(" ")} END AS ${field}`,
  );
  return {
    ctes: [
      ...counts.map((count, index) => `${names[index]} AS (${count})`),
      `stage(stepIndex) AS (VALUES ${steps.map((_, index) => `(${index})`).join(",")})`,
    ],
    sql: `SELECT stage.stepIndex, ${fields.join(", ")}
FROM stage ${names.map((name) => `CROSS JOIN ${name}`).join(" ")}
ORDER BY stage.stepIndex ASC`,
  };
}
interface FunnelCteParts {
  readonly funnelCtes: readonly string[];
  readonly filterBindings: readonly SqlBinding[];
  readonly steps: readonly FunnelSqlStepLayer[];
  readonly identity: "session_id" | "visitor_id";
  readonly firstFilter: ScopedObservationFilterSql;
}
function buildFunnelCteParts(
  config: FunnelConfigV2,
  dataset: ScopedDatasetSql,
  options: {
    readonly allowHistoricalOverLimit?: boolean;
    readonly analysis?: boolean;
  } = {},
): FunnelCteParts {
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

  // With identical stages, the greedy next witness is simply the next
  // ordered occurrence. Rank once; retain the first witness identities and
  // conversion-window anchor rather than counting the later witness's session.
  // Membership plans retain their existing reached-relation construction.
  if (
    options.analysis &&
    dataset.uniqueObservationIds === true &&
    config.steps.length >= 3 &&
    config.steps.every((step) => step.filterDsl === config.steps[0]!.filterDsl)
  ) {
    const filter = executeObservationFilterOnScopedDataset(
      dataset,
      parseFunnelStepFilter(config.steps[0]!),
      "funnel_step_0",
    );
    funnelCtes.push(filter.ctes.trim(), witnessCte(0, filter, identity, true));
    filterBindings.push(...filter.bindings);
    const order = `PARTITION BY site_pk, ${identity} ORDER BY observed_at, observation_rank, sequence, source_id`;
    funnelCtes.push(`repeat_ranked AS (
      SELECT site_pk,
        FIRST_VALUE(session_id) OVER w AS session_id,
        FIRST_VALUE(visitor_id) OVER w AS visitor_id,
        FIRST_VALUE(observed_at) OVER w AS first_observed_at,
        observed_at AS last_observed_at, observation_rank AS last_observation_rank,
        sequence AS last_sequence, source_id AS last_source_id,
        ROW_NUMBER() OVER w AS reached_rank
      FROM funnel_step_0_witnesses
      WINDOW w AS (${order})
    ), repeat_reached AS MATERIALIZED (
      SELECT * FROM repeat_ranked WHERE reached_rank <= ${config.steps.length}
      ${visitorWindow ? "AND last_observed_at <= first_observed_at + (SELECT conversion_window_ms FROM funnel_params)" : ""}
    )`);
    config.steps.forEach((step, index) => {
      funnelCtes.push(
        `reached_${index} AS (SELECT * FROM repeat_reached WHERE reached_rank=${index + 1})`,
      );
      layers.push({
        stepId: step.id,
        stepIndex: index,
        reachedRelation: `reached_${index}`,
      });
    });
    return {
      funnelCtes,
      filterBindings,
      steps: layers,
      identity,
      firstFilter: filter,
    };
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
    funnelCtes.push(
      witnessCte(
        stepIndex,
        filter,
        identity,
        dataset.uniqueObservationIds === true,
      ),
    );
    funnelCtes.push(
      stepIndex === 0
        ? reachedZeroCte(witnesses, identity)
        : reachedNextCte(
            stepIndex,
            `reached_${stepIndex - 1}`,
            witnesses,
            identity,
            visitorWindow,
            (options.analysis
              ? config.steps.length >= 4
              : config.steps.length >= COMPACT_RESULT_MIN_STEPS) &&
              stepIndex < config.steps.length - 1,
            config.steps.length >= COMPACT_RESULT_MIN_STEPS,
          ),
    );
    layers.push({
      stepId: step.id,
      stepIndex,
      reachedRelation: `reached_${stepIndex}`,
    });
  });

  if (!firstFilter) throw new Error("funnel_steps_required");
  return {
    funnelCtes,
    filterBindings,
    steps: layers,
    identity,
    firstFilter,
  };
}
export function assertFunnelStructuralBudget(stepCount: number): void {
  if (!Number.isSafeInteger(stepCount) || stepCount < 1) {
    throw new Error("funnel_steps_required");
  }
  if (stepCount > MAX_FUNNEL_STEPS) {
    throw new Error("funnel_sql_step_limit_exceeded");
  }
  const estimatedCtes =
    stepCount * FUNNEL_SQL_CTES_PER_STEP + resultCteCount(stepCount) + 1;
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
 * Every step owns an independent observation-filter bundle. Long analyses
 * additionally use one scalar count CTE per step and a stage relation. The progression
 * CTEs consume only those bundles' final matched relations and never access
 * raw tables or alter the dataset window.
 */
export function buildFunnelSqlPlan(
  config: FunnelConfigV2,
  dataset: ScopedDatasetSql,
  options: { readonly allowHistoricalOverLimit?: boolean } = {},
): FunnelSqlPlan {
  const parts = buildFunnelCteParts(config, dataset, {
    ...options,
    analysis: true,
  });
  const visitorWindow = config.progressionScope === "visitor";
  const result = resultSql(config.steps, parts.firstFilter);

  const sql = `WITH
${dataset.ctes.trim()},
${[...parts.funnelCtes, ...result.ctes].join(",\n")}
${result.sql}`;
  const bindings: SqlBinding[] = [
    ...dataset.bindings,
    ...(visitorWindow ? [{ value: config.conversionWindowMs! }] : []),
    ...parts.filterBindings,
    ...config.steps.map((step) => ({ value: step.id })),
  ];
  const shape = measureFunnelSqlShape({
    sql,
    bindings,
    stepCount: config.steps.length,
    funnelCteCount:
      config.steps.length * FUNNEL_SQL_CTES_PER_STEP +
      result.ctes.length +
      (visitorWindow ? 1 : 0),
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
    steps: parts.steps,
    shape,
  };
}
/**
 * Build the progression CTEs needed to restrict a journey list to one funnel
 * stage.  The caller owns the surrounding dataset CTEs and can then project
 * the reached relation through the normal visitor/session aggregation query.
 */
export function buildFunnelMembershipSqlPlan(
  config: FunnelConfigV2,
  dataset: ScopedDatasetSql,
  stepIndex: number,
  options: {
    readonly allowHistoricalOverLimit?: boolean;
    readonly outcome?: "converted" | "dropoff";
  } = {},
): FunnelMembershipSqlPlan {
  const parts = buildFunnelCteParts(config, dataset, options);
  if (
    !Number.isSafeInteger(stepIndex) ||
    stepIndex < 0 ||
    stepIndex >= parts.steps.length
  ) {
    throw new Error("funnel_step_not_found");
  }
  const reachedRelation = parts.steps[stepIndex]!.reachedRelation;
  const relation =
    options.outcome === "dropoff"
      ? stepIndex === 0
        ? `(SELECT reached_0.*
            FROM reached_0
            WHERE 1 = 0)`
        : `(SELECT previous.*
            FROM reached_${stepIndex - 1} previous
            WHERE NOT EXISTS (
              SELECT 1
              FROM ${reachedRelation} current
              WHERE current.site_pk = previous.site_pk
                AND current.${parts.identity} = previous.${parts.identity}
            ))`
      : reachedRelation;
  const sql = `${dataset.ctes.trim()},\n${parts.funnelCtes.join(",\n")}`;
  const shape = measureFunnelSqlShape({
    sql: `${sql}\nSELECT * FROM ${relation}`,
    bindings: [
      ...dataset.bindings,
      ...(config.progressionScope === "visitor"
        ? [{ value: config.conversionWindowMs! }]
        : []),
      ...parts.filterBindings,
    ],
    stepCount: config.steps.length,
    funnelCteCount:
      config.steps.length * FUNNEL_SQL_CTES_PER_STEP +
      (config.progressionScope === "visitor" ? 1 : 0),
  });
  assertFunnelSqlShapeWithinBudget(
    shape,
    options.allowHistoricalOverLimit
      ? FUNNEL_SQL_HISTORICAL_STRUCTURAL_BUDGET
      : FUNNEL_SQL_STRUCTURAL_BUDGET,
  );
  return {
    ctes: parts.funnelCtes.join(",\n"),
    bindings: [
      ...(config.progressionScope === "visitor"
        ? [{ value: config.conversionWindowMs! }]
        : []),
      ...parts.filterBindings,
    ],
    relation,
    identity: parts.identity,
    shape,
  };
}
/** Alias kept concise for callers that use planner terminology. */
export const planFunnelSql = buildFunnelSqlPlan;
