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
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
  type QualificationDependencyRef,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type FilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

import type { AnalyticsDbRelation } from "./analytics-relational-storage";
import {
  createQualificationExecutionInputsForTrustedPlan,
  type QualificationDependencyRelationBinding,
  type QualificationExecutionInputs,
} from "./qualification-execution-inputs";

interface PreparationState {
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

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left instanceof Set || right instanceof Set)
    return (
      left instanceof Set &&
      right instanceof Set &&
      left.size === right.size &&
      [...left].every((value) =>
        [...right].some((candidate) => sameValue(value, candidate)),
      )
    );
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] &&
        sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function snapshot<T>(value: T): T {
  if (Array.isArray(value)) return value.map(snapshot) as T;
  if (value instanceof Set) return new Set([...value].map(snapshot)) as T;
  if (!value || typeof value !== "object") return value;
  const copied = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      snapshot(child),
    ]),
  );
  return Object.freeze(copied) as T;
}

const DEPENDENCY_SOURCE_ENTITY: Readonly<
  Record<QualificationDependencyRef, readonly ("event" | "page")[]>
> = {
  [EVENT_FILTER_PAGE_VISIT_DEPENDENCY]: ["page"],
  [EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY]: ["event"],
  // Entity membership qualifies both the Event and the Page rows of a
  // session or visitor.
  [EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY]: ["event", "page"],
};

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
): void {
  // Without a reader window the plan reads exactly the prepared domains under
  // the canonical profile. With one, the plan reads that window while every
  // Source keeps the prepared domains as its preparation proof.
  const preparedDomains = semanticTemporalDomainsFromQueryTime(state.queryTime);
  const planDomains = readerQueryTime
    ? semanticTemporalDomainsFromQueryTime(readerQueryTime)
    : preparedDomains;
  const context = plan.context;
  const dependencySources = plan.nodes.flatMap((node) => {
    if (node.kind !== "source" || !node.selection) return [];
    return (node.selection.qualificationDependencyRefs ?? []).map((ref) => ({
      node,
      ref,
    }));
  });
  const available = new Set(
    state.relations.map((binding) => binding.dependencyRef),
  );
  const counts = new Map<QualificationDependencyRef, number>();
  for (const { ref } of dependencySources)
    counts.set(ref, (counts.get(ref) ?? 0) + 1);
  const entityScope = state.scopePlan.mode === "entity";
  const expectedEntityKind =
    state.scopePlan.membership.kind === "entity"
      ? state.scopePlan.membership.entityKind
      : undefined;
  if (
    !Object.isFrozen(plan) ||
    context.scope.requested !== state.scopePlan.scope ||
    context.scope.contractScope !== state.scopePlan.scope ||
    context.scope.logicalScope !==
      (entityScope ? state.scopePlan.scope : "observation") ||
    context.subject.origin !== "site" ||
    context.subject.siteIds.length !== 1 ||
    context.subject.siteIds[0] !== state.siteId ||
    !sameValue(context.time, planDomains) ||
    // The primary role is always present, every named role has a relation
    // from this evaluation, and each role backs no more Sources than declared.
    !counts.has(state.dependencyRef) ||
    [...counts].some(
      ([ref, count]) =>
        !available.has(ref) || count < 1 || count > state.maxSourcesPerRole,
    )
  )
    throw new Error("qualification_execution_plan_context_mismatch");
  for (const { node, ref } of dependencySources) {
    const selection = node.selection;
    if (
      node.kind !== "source" ||
      !(DEPENDENCY_SOURCE_ENTITY[ref] as readonly string[]).includes(
        node.entity,
      ) ||
      !selection ||
      (readerQueryTime
        ? (selection.profile !== "prepared-page-reader-window-v1" &&
            selection.profile !== "prepared-scoped-reader-window-v1") ||
          !sameValue(selection.preparationTime, preparedDomains)
        : selection.profile !== "prepared-scoped-v1") ||
      selection.scope !== state.scopePlan.scope ||
      selection.mode !== state.scopePlan.mode ||
      selection.entityKind !== expectedEntityKind ||
      !sameValue(selection.filter, state.filters) ||
      !sameValue(selection.subject, context.subject) ||
      !sameValue(selection.authorizedSiteIds, [state.siteId]) ||
      !sameValue(selection.time, planDomains)
    )
      throw new Error("qualification_execution_plan_context_mismatch");
  }
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
  if (!input.siteId || !input.filters.root)
    throw new Error("qualification_execution_preparation_invalid");
  const filters = snapshot(
    normalizeFilterDocument(input.filters, analyticsFilterRegistry),
  );
  const queryTime = snapshot(input.queryTime);
  const scopePlan = snapshot(input.scopePlan);
  const consumerKey = snapshot(input.consumerKey);
  const entityRole =
    (input.dependencyRef ?? EVENT_FILTER_PAGE_VISIT_DEPENDENCY) ===
    EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY;
  if (
    scopePlan.preparedMembership !== undefined ||
    (entityRole
      ? scopePlan.mode !== "entity" ||
        scopePlan.scope === "event" ||
        scopePlan.membership.kind !== "entity"
      : scopePlan.scope !== "event" || scopePlan.mode !== "observation")
  )
    throw new Error("qualification_execution_preparation_context_mismatch");

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
    dependencyRef,
    siteId: input.siteId,
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

  let filters: FilterDocument;
  try {
    filters = normalizeFilterDocument(input.filters, analyticsFilterRegistry);
  } catch {
    throw new Error("qualification_execution_plan_snapshot_mismatch");
  }
  if (
    input.siteId !== state.siteId ||
    !sameValue(filters, state.filters) ||
    !sameValue(input.queryTime, state.queryTime) ||
    !sameValue(input.scopePlan, state.scopePlan) ||
    !sameValue(input.consumerKey, state.consumerKey)
  )
    throw new Error("qualification_execution_plan_snapshot_mismatch");
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
}): QualificationExecutionInputs {
  const state = validatePreparationContext(input);
  if (state.boundPlans.has(input.plan))
    throw new Error("qualification_execution_preparation_replayed");
  assertPlanContext(input.plan, state, input.readerQueryTime);
  const used = new Set(planDependencyRefs(input.plan));
  const executionInputs = createQualificationExecutionInputsForTrustedPlan(
    state.relations.filter((binding) => used.has(binding.dependencyRef)),
    input.plan,
  );
  state.boundPlans.add(input.plan);
  state.bindings += 1;
  return executionInputs;
}
