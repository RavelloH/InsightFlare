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
  type QualificationExecutionInputs,
} from "./qualification-execution-inputs";

interface PreparationState {
  readonly dependencyRef: QualificationDependencyRef;
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
  readonly relation: AnalyticsDbRelation;
  bound: boolean;
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

function assertPlanContext(
  plan: ValidatedLogicalPlan,
  state: PreparationState,
): void {
  const context = plan.context;
  const dependencySources = plan.nodes.flatMap((node) => {
    if (node.kind !== "source" || !node.selection) return [];
    return (node.selection.qualificationDependencyRefs ?? []).map((ref) => ({
      node,
      ref,
    }));
  });
  const dependency = dependencySources[0];
  if (
    !Object.isFrozen(plan) ||
    context.scope.requested !== "event" ||
    context.scope.contractScope !== "event" ||
    context.scope.logicalScope !== "observation" ||
    context.subject.origin !== "site" ||
    context.subject.siteIds.length !== 1 ||
    context.subject.siteIds[0] !== state.siteId ||
    !sameValue(
      context.time,
      semanticTemporalDomainsFromQueryTime(state.queryTime),
    ) ||
    dependencySources.length !== 1 ||
    dependency?.ref !== state.dependencyRef ||
    dependency?.node.entity !==
      (state.dependencyRef === EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY
        ? "event"
        : "page") ||
    dependency?.node.selection?.profile !== "prepared-scoped-v1" ||
    dependency?.node.selection?.scope !== state.scopePlan.scope ||
    dependency?.node.selection?.mode !== state.scopePlan.mode ||
    dependency?.node.selection?.entityKind !== undefined ||
    !sameValue(dependency?.node.selection?.filter, state.filters) ||
    !sameValue(dependency?.node.selection?.subject, context.subject) ||
    !sameValue(dependency?.node.selection?.authorizedSiteIds, [state.siteId]) ||
    !sameValue(
      dependency?.node.selection?.time,
      semanticTemporalDomainsFromQueryTime(state.queryTime),
    )
  )
    throw new Error("qualification_execution_plan_context_mismatch");
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
}): PageVisitQualificationPreparation {
  if (!input.siteId || !input.filters.root)
    throw new Error("qualification_execution_preparation_invalid");
  const filters = snapshot(
    normalizeFilterDocument(input.filters, analyticsFilterRegistry),
  );
  const queryTime = snapshot(input.queryTime);
  const scopePlan = snapshot(input.scopePlan);
  const consumerKey = snapshot(input.consumerKey);
  if (
    scopePlan.scope !== "event" ||
    scopePlan.mode !== "observation" ||
    scopePlan.advancedMatches !== undefined
  )
    throw new Error("qualification_execution_preparation_context_mismatch");

  const preparation = Object.freeze(
    Object.create(null),
  ) as PageVisitQualificationPreparation;
  states.set(preparation as object, {
    dependencyRef: input.dependencyRef ?? EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
    siteId: input.siteId,
    filters,
    queryTime,
    scopePlan,
    consumerKey,
    relation: input.relation,
    bound: false,
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
  if (state.bound)
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
}): QualificationExecutionInputs {
  const state = validatePreparationContext(input);
  assertPlanContext(input.plan, state);
  const executionInputs = createQualificationExecutionInputsForTrustedPlan(
    state.relation,
    input.plan,
    state.dependencyRef,
  );
  state.bound = true;
  return executionInputs;
}
