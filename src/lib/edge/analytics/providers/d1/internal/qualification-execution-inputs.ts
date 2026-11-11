import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY,
  EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
  type QualificationDependencyRef,
} from "@/lib/edge/analytics/engine/semantic/qualification-dependency";

import type { AnalyticsDbRelation } from "./analytics-relational-storage";

export interface QualificationDependencyRelationBinding {
  readonly dependencyRef: QualificationDependencyRef;
  readonly relation: AnalyticsDbRelation;
}

declare const qualificationExecutionInputsBrand: unique symbol;

/** Opaque, request-local physical input consumed only by the D1 lowerer. */
export type QualificationExecutionInputs = Readonly<{
  readonly [qualificationExecutionInputsBrand]: true;
}>;

interface QualificationExecutionState {
  readonly dependencyRef: QualificationDependencyRef;
  readonly plan: ValidatedLogicalPlan;
  readonly relation: AnalyticsDbRelation;
  attached: boolean;
}

const qualificationExecutionStates = new WeakMap<
  object,
  QualificationExecutionState
>();

function planDependencies(
  plan: ValidatedLogicalPlan,
): readonly QualificationDependencyRef[] {
  return plan.nodes.flatMap((node) =>
    node.kind === "source"
      ? (node.selection?.qualificationDependencyRefs ?? [])
      : [],
  );
}

const RELATION_IDENTITY_COLUMN: Readonly<
  Record<QualificationDependencyRef, string>
> = {
  [EVENT_FILTER_PAGE_VISIT_DEPENDENCY]: "visit_id",
  [EVENT_FILTER_EVENT_MEMBERSHIP_DEPENDENCY]: "event_id",
};

function assertRelationSchema(
  relation: AnalyticsDbRelation,
  dependencyRef: QualificationDependencyRef,
): void {
  if (
    Object.keys(relation.columns).sort().join("\u0000") !==
    ["site_id", RELATION_IDENTITY_COLUMN[dependencyRef]].sort().join("\u0000")
  )
    throw new Error("qualification_execution_relation_schema_mismatch");
}

/**
 * Trusted report preparation passes an already-built physical relation and
 * its final frozen plan. Raw match IDs are deliberately not accepted here.
 */
export function createQualificationExecutionInputsForTrustedPlan(
  relation: AnalyticsDbRelation,
  plan: ValidatedLogicalPlan,
  dependencyRef: QualificationDependencyRef = EVENT_FILTER_PAGE_VISIT_DEPENDENCY,
): QualificationExecutionInputs {
  if (!Object.isFrozen(plan))
    throw new Error("qualification_execution_plan_not_frozen");
  const dependencies = planDependencies(plan);
  if (dependencies.length !== 1 || dependencies[0] !== dependencyRef)
    throw new Error("qualification_execution_dependency_unexpected");
  assertRelationSchema(relation, dependencyRef);
  const handle = Object.freeze(
    Object.create(null),
  ) as QualificationExecutionInputs;
  qualificationExecutionStates.set(handle as object, {
    dependencyRef,
    plan,
    relation,
    attached: false,
  });
  return handle;
}

/** Attach without invoking any method or getter on the supplied capability. */
export function attachQualificationExecutionInputs(
  input: unknown,
  lowerer: object,
  plan: ValidatedLogicalPlan,
): readonly QualificationDependencyRelationBinding[] {
  const dependencies = planDependencies(plan);
  if (input === undefined) {
    if (dependencies.length > 0)
      throw new Error("qualification_execution_dependency_unbound");
    return [];
  }
  const state =
    (typeof input === "object" && input !== null) || typeof input === "function"
      ? qualificationExecutionStates.get(input as object)
      : undefined;
  if (!state) throw new Error("qualification_execution_input_untrusted");
  if (
    !lowerer ||
    state.attached ||
    plan !== state.plan ||
    !Object.isFrozen(plan)
  )
    throw new Error("qualification_execution_input_plan_mismatch");
  if (dependencies.length !== 1 || dependencies[0] !== state.dependencyRef)
    throw new Error("qualification_execution_dependency_unexpected");
  assertRelationSchema(state.relation, state.dependencyRef);
  state.attached = true;
  return Object.freeze([
    Object.freeze({
      dependencyRef: state.dependencyRef,
      relation: state.relation,
    }),
  ]);
}
