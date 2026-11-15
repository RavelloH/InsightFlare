import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { ProgramMembershipOutput } from "@/lib/edge/analytics/engine/program-membership-source";
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
  type QualificationDependencyRef,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { sameSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type FilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

import { matchProgramMembershipConstantFold } from "./program-membership-constant-folding";

/** Immutable request data only. This carries no relation, rows, handle or execution authority. */
export interface QualificationRequestSnapshot {
  readonly siteId: string;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly scopePlan: ScopedFilterPlan;
  readonly consumerKey: unknown;
}

export interface QualificationPlanContext extends QualificationRequestSnapshot {
  readonly qualificationSemantics?: "whole-original";
  readonly dependencyRef: QualificationDependencyRef;
  readonly availableDependencies: readonly QualificationDependencyRef[];
  readonly maxSourcesPerRole: number;
}

export function sameValue(left: unknown, right: unknown): boolean {
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

export function snapshot<T>(value: T): T {
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

/** Capture exactly the old preparation's data checks, without minting any authority. */
export function snapshotQualificationRequest(
  input: QualificationRequestSnapshot & {
    readonly qualificationSemantics?: "whole-original";
    readonly dependencyRef?: QualificationDependencyRef;
  },
): QualificationRequestSnapshot {
  if (
    !input.siteId ||
    (!input.filters.root && input.qualificationSemantics !== "whole-original")
  )
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
  return Object.freeze({
    siteId: input.siteId,
    filters,
    queryTime,
    scopePlan,
    consumerKey,
  });
}

/** Data equality only; actual legacy/native holders own trust and once-only claims. */
export function assertQualificationRequestSnapshot(
  input: QualificationRequestSnapshot,
  state: QualificationRequestSnapshot,
): void {
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

export function assertQualificationPlanContext(
  plan: ValidatedLogicalPlan,
  state: QualificationPlanContext,
  readerQueryTime?: QueryTime,
  readerFilters?: FilterDocument,
  readerPreparationTime?: QueryTime,
  producer?: ProgramMembershipOutput,
): void {
  if (
    readerFilters !== undefined &&
    (state.qualificationSemantics !== "whole-original" || !readerQueryTime)
  )
    throw new Error("qualification_execution_reader_filters_unsupported");
  const expectedReaderFilters =
    readerFilters === undefined
      ? state.filters
      : normalizeFilterDocument(readerFilters, analyticsFilterRegistry);
  if (state.qualificationSemantics === "whole-original" && !readerQueryTime)
    throw new Error("qualification_execution_plan_context_mismatch");
  if (
    readerPreparationTime !== undefined &&
    (state.qualificationSemantics !== "whole-original" || !readerQueryTime)
  )
    throw new Error(
      "qualification_execution_reader_preparation_time_unsupported",
    );
  // Without a reader window the plan reads exactly the prepared domains under
  // the canonical profile. With one, the plan reads that window while every
  // Source keeps the prepared domains as its preparation proof.
  const preparedDomains = semanticTemporalDomainsFromQueryTime(state.queryTime);
  const planDomains = readerQueryTime
    ? semanticTemporalDomainsFromQueryTime(readerQueryTime)
    : preparedDomains;
  // The fixed preparation envelope remains validated separately. Only a
  // whole-original canonical reader may describe the Source time it actually
  // read at its own historical checkpoint, independently of that envelope.
  const sourcePreparationDomains =
    readerPreparationTime === undefined
      ? preparedDomains
      : semanticTemporalDomainsFromQueryTime(readerPreparationTime);
  const context = plan.context;
  if (producer) {
    if (
      !sameSemanticSubjectDomain(
        plan.context.subject,
        producer.plan.context.subject,
      )
    )
      throw new Error("qualification_execution_program_producer_mismatch");
  }
  const dependencySources = plan.nodes.flatMap((node) => {
    if (node.kind !== "source" || !node.selection) return [];
    if (!producer)
      return (node.selection.qualificationDependencyRefs ?? []).map((ref) => ({
        node,
        ref,
      }));
    if (
      node.selection.qualificationDependencyRefs !== undefined ||
      node.selection.preparedMembership !== undefined ||
      node.entity !== "page" ||
      node.membershipInputs?.length !== 1
    )
      throw new Error("qualification_execution_plan_context_mismatch");
    const edge = node.membershipInputs[0]!;
    const folded = matchProgramMembershipConstantFold(plan, edge);
    if (
      edge.role !== "entity" ||
      !folded ||
      folded.imported.childPlan !== producer.plan ||
      folded.imported.outputId !== producer.output.id
    )
      throw new Error("qualification_execution_program_producer_mismatch");
    return [{ node, ref: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY }];
  });
  const available = new Set(state.availableDependencies);
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
        ? (state.qualificationSemantics === "whole-original"
            ? selection.profile !== "prepared-whole-filter-reader-window-v1"
            : selection.profile !== "prepared-page-reader-window-v1" &&
              selection.profile !== "prepared-scoped-reader-window-v1") ||
          !sameValue(selection.preparationTime, sourcePreparationDomains)
        : selection.profile !== "prepared-scoped-v1") ||
      selection.scope !== state.scopePlan.scope ||
      selection.mode !== state.scopePlan.mode ||
      selection.entityKind !== expectedEntityKind ||
      !sameValue(selection.filter, expectedReaderFilters) ||
      !sameValue(selection.subject, context.subject) ||
      !sameValue(selection.authorizedSiteIds, [state.siteId]) ||
      !sameValue(selection.time, planDomains)
    )
      throw new Error("qualification_execution_plan_context_mismatch");
  }
}
