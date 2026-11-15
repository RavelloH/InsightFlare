import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  QueryAudience,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import {
  snapshotLogicalPlan,
  type ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import {
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
  type QualificationDependencyRef,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import type { AnalyticsDbRelation } from "./analytics-relational-storage";
import {
  createQualificationExecutionInputsForTrustedPlan,
  type QualificationDependencyRelationBinding,
  type QualificationExecutionInputs,
} from "./qualification-execution-inputs";
import {
  assertQualificationPlanContext,
  assertQualificationRequestSnapshot,
  type QualificationRequestSnapshot,
  sameValue,
  snapshot,
  snapshotQualificationRequest,
} from "./qualification-plan-context";

interface PreparationState {
  readonly qualificationSemantics?: "whole-original";
  readonly dependencyRef: QualificationDependencyRef;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
  /** The primary relation first, then optional relations from the same evaluation. */
  readonly relations: readonly QualificationDependencyRelationBinding[];
  /** Number of distinct frozen plans the report owner declared at preparation. */
  readonly maxBindings: number;
  /** Sources of one role a single plan may read (for example summary + denominator). */
  readonly maxSourcesPerRole: number;
  readonly boundPlans: WeakSet<object>;
  bindings: number;
}

declare const pageVisitPreparationBrand: unique symbol;

/** Request-local Page visit relation awaiting a report owner's canonical plan. */
export type PageVisitQualificationPreparation = Readonly<{
  readonly [pageVisitPreparationBrand]: true;
}>;

const states = new WeakMap<object, PreparationState>();

/** Freeze an owner-built canonical plan before binding request-local inputs. */
export function snapshotPageVisitQualificationPlan(
  plan: ValidatedLogicalPlan,
): ValidatedLogicalPlan {
  return validateLogicalPlan(snapshotLogicalPlan(plan));
}

export function pageVisitQualificationConsumerKey(
  operation: string,
  configuration: unknown,
): Readonly<{ operation: string; configuration: unknown }> {
  if (!operation)
    throw new Error("qualification_execution_consumer_key_invalid");
  return Object.freeze({ operation, configuration: snapshot(configuration) });
}

/** Dependency refs a canonical plan names, in Source order. */
function planDependencyRefs(
  plan: ValidatedLogicalPlan,
): readonly QualificationDependencyRef[] {
  return plan.nodes.flatMap((node) =>
    node.kind === "source" && node.selection
      ? (node.selection.qualificationDependencyRefs ?? [])
      : [],
  );
}

function assertPlanContext(
  plan: ValidatedLogicalPlan,
  state: PreparationState,
  readerQueryTime?: QueryTime,
  readerFilters?: FilterDocument,
  readerPreparationTime?: QueryTime,
): void {
  assertQualificationPlanContext(
    plan,
    {
      ...state,
      availableDependencies: state.relations.map(
        (binding) => binding.dependencyRef,
      ),
    },
    readerQueryTime,
    readerFilters,
    readerPreparationTime,
  );
}

declare const filterValuesProjectionBrand: unique symbol;

export type FilterValuesPageQualificationProjection = Readonly<{
  readonly [filterValuesProjectionBrand]: true;
}>;

interface FilterValuesProjectionState {
  readonly field: string;
  readonly limit: number;
  readonly cursorToken: string | null;
  readonly search: string | undefined;
  readonly audience: QueryAudience;
  readonly cursor: unknown;
  readonly consumerKey: unknown;
}

const filterValuesProjections = new WeakMap<
  object,
  FilterValuesProjectionState
>();

export function filterValuesPageQualificationConsumerKey(input: {
  readonly field: string;
  readonly limit: number;
  readonly cursorToken: string | null;
  readonly search?: string;
  readonly audience: QueryAudience;
}) {
  return pageVisitQualificationConsumerKey("filter-values", input);
}

/** Seal the actual FilterValues request and decoded page cursor for nested readers. */
export function createFilterValuesPageQualificationProjection(input: {
  readonly field: string;
  readonly limit: number;
  readonly cursorToken: string | null;
  readonly search?: string;
  readonly audience: QueryAudience;
  readonly cursor: unknown;
}): FilterValuesPageQualificationProjection {
  const projection = Object.freeze(
    Object.create(null),
  ) as FilterValuesPageQualificationProjection;
  filterValuesProjections.set(projection as object, {
    field: input.field,
    limit: input.limit,
    cursorToken: input.cursorToken,
    search: input.search,
    audience: input.audience,
    cursor: snapshot(input.cursor),
    consumerKey: filterValuesPageQualificationConsumerKey({
      field: input.field,
      limit: input.limit,
      cursorToken: input.cursorToken,
      search: input.search,
      audience: input.audience,
    }),
  });
  return projection;
}

/** Validate the actual FilterValues projection before a nested page reader binds it. */
export function assertFilterValuesPageQualificationProjection(input: {
  readonly projection: FilterValuesPageQualificationProjection | undefined;
  readonly field: string;
  readonly limit: number;
  readonly hasCursor: boolean;
  readonly cursor: unknown;
  readonly search?: string;
  readonly audience: QueryAudience;
}): unknown {
  const state =
    typeof input.projection === "object" && input.projection !== null
      ? filterValuesProjections.get(input.projection)
      : undefined;
  if (
    !state ||
    state.field !== input.field ||
    state.limit !== input.limit ||
    (state.cursorToken !== null) !== input.hasCursor ||
    !sameValue(state.cursor, input.cursor) ||
    state.search !== input.search ||
    state.audience !== input.audience
  )
    throw new Error("qualification_execution_consumer_projection_mismatch");
  return state.consumerKey;
}

/** Create an opaque preparation after eligibility and Core evaluation succeed. */
export function createPageVisitQualificationPreparation(input: {
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
  readonly relation: AnalyticsDbRelation;
  /** Existing native failed-attempt data, never relation/row authority. */
  readonly requestSnapshot?: QualificationRequestSnapshot;
  /** Only the closed whole-original reader permits a currently empty filter. */
  readonly qualificationSemantics?: "whole-original";
  /** Defaults to the Page visit role; Event consumers pass the Event membership ref. */
  readonly dependencyRef?: QualificationDependencyRef;
  /** Further relations from the same Core evaluation (other roles of the plan). */
  readonly additionalRelations?: readonly QualificationDependencyRelationBinding[];
  /**
   * Distinct frozen plans one report owner may bind to this single Core
   * evaluation (for example dependent series/points/other reads). A plan can
   * never be bound twice and the default remains a single plan.
   */
  readonly maxBindings?: number;
  /** Sources of one role a plan may read from the shared relation; defaults to 1. */
  readonly maxSourcesPerRole?: number;
}): PageVisitQualificationPreparation {
  const context = input.requestSnapshot ?? snapshotQualificationRequest(input);
  const { filters, queryTime, scopePlan, consumerKey } = context;

  const dependencyRef =
    input.dependencyRef ?? EVENT_FILTER_PAGE_VISIT_DEPENDENCY;
  const relations: readonly QualificationDependencyRelationBinding[] =
    Object.freeze([
      Object.freeze({ dependencyRef, relation: input.relation }),
      ...(input.additionalRelations ?? []).map((binding) =>
        Object.freeze({
          dependencyRef: binding.dependencyRef,
          relation: binding.relation,
        }),
      ),
    ]);
  if (
    new Set(relations.map((binding) => binding.dependencyRef)).size !==
    relations.length
  )
    throw new Error("qualification_execution_preparation_context_mismatch");

  const preparation = Object.freeze(
    Object.create(null),
  ) as PageVisitQualificationPreparation;
  states.set(preparation as object, {
    ...(input.qualificationSemantics
      ? { qualificationSemantics: input.qualificationSemantics }
      : {}),
    dependencyRef,
    siteId: context.siteId,
    filters,
    queryTime,
    scopePlan,
    consumerKey,
    relations,
    maxBindings: input.maxBindings ?? 1,
    maxSourcesPerRole: input.maxSourcesPerRole ?? 1,
    boundPlans: new WeakSet(),
    bindings: 0,
  });
  return preparation;
}

function validatePreparationContext(input: {
  readonly preparation: unknown;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
}): PreparationState {
  const state =
    typeof input.preparation === "object" && input.preparation !== null
      ? states.get(input.preparation)
      : undefined;
  if (!state) throw new Error("qualification_execution_preparation_untrusted");
  if (state.bindings >= state.maxBindings)
    throw new Error("qualification_execution_preparation_replayed");

  assertQualificationRequestSnapshot(input, state);
  return state;
}

/** Validate request binding before an owner constructs its final plan. */
export function assertPageVisitQualificationPreparationContext(input: {
  readonly preparation: unknown;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
}): void {
  validatePreparationContext(input);
}

/** Return the exact frozen scope-plan snapshot sealed at preparation time. */
export function pageVisitQualificationPreparationScopePlan(input: {
  readonly preparation: unknown;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
}): ScopedFilterPlan {
  return validatePreparationContext(input).scopePlan;
}

/** Bind only the exact frozen canonical plan made by the report owner. */
export function bindPageVisitQualificationPreparation(input: {
  readonly preparation: unknown;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
  readonly plan: ValidatedLogicalPlan;
  /** The window the report reads when it differs from the prepared domains. */
  readonly readerQueryTime?: QueryTime;
  readonly readerFilters?: FilterDocument;
  /** Actual canonical Source preparation input at this reader checkpoint.
   * Whole-original + explicit readerQueryTime only; never replaces the fixed
   * queryTime used by validatePreparationContext or authorizes a new relation. */
  readonly readerPreparationTime?: QueryTime;
}): QualificationExecutionInputs {
  const state = validatePreparationContext(input);
  if (state.boundPlans.has(input.plan))
    throw new Error("qualification_execution_preparation_replayed");
  assertPlanContext(
    input.plan,
    state,
    input.readerQueryTime,
    input.readerFilters,
    input.readerPreparationTime,
  );
  const used = new Set(planDependencyRefs(input.plan));
  const executionInputs = createQualificationExecutionInputsForTrustedPlan(
    state.relations.filter((binding) => used.has(binding.dependencyRef)),
    input.plan,
  );
  state.boundPlans.add(input.plan);
  state.bindings += 1;
  return executionInputs;
}

/** Pure request data from an already-existing legacy attempt. Reading it grants
 * no relation and consumes nothing; native Program state will perform the same live checks. */
export function pageVisitQualificationRequestSnapshot(
  preparation: unknown,
): QualificationRequestSnapshot {
  const state =
    typeof preparation === "object" && preparation !== null
      ? states.get(preparation)
      : undefined;
  if (!state) throw new Error("qualification_execution_preparation_untrusted");
  if (state.bindings >= state.maxBindings)
    throw new Error("qualification_execution_preparation_replayed");
  return Object.freeze({
    siteId: state.siteId,
    filters: state.filters,
    queryTime: state.queryTime,
    scopePlan: state.scopePlan,
    consumerKey: state.consumerKey,
  });
}

/** Retire a pre-existing legacy view after its native consumer has succeeded.
 * This only revokes reuse; it cannot grant a relation or create a completion. */
export function retirePageVisitQualificationPreparation(
  preparation: unknown,
  original: ValidatedLogicalPlan,
  converted: ValidatedLogicalPlan,
): void {
  const state =
    typeof preparation === "object" && preparation !== null
      ? states.get(preparation)
      : undefined;
  if (!state) throw new Error("qualification_execution_preparation_untrusted");
  if (state.bindings >= state.maxBindings || state.boundPlans.has(original))
    throw new Error("qualification_execution_preparation_replayed");
  state.boundPlans.add(original);
  state.boundPlans.add(converted);
  state.bindings += 1;
}
