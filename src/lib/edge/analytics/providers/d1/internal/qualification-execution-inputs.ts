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
  readonly bindings: readonly QualificationDependencyRelationBinding[];
  readonly plan: ValidatedLogicalPlan;
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
 * The plan's Sources may share one dependency ref, but the distinct refs the
 * plan names must be exactly the refs of the supplied relations.
 */
function assertBindingsMatchPlan(
  bindings: readonly QualificationDependencyRelationBinding[],
  plan: ValidatedLogicalPlan,
): void {
  const dependencies = new Set(planDependencies(plan));
  const bound = new Set(bindings.map(({ dependencyRef }) => dependencyRef));
  if (
    dependencies.size === 0 ||
    bound.size !== bindings.length ||
    dependencies.size !== bound.size ||
    [...dependencies].some((ref) => !bound.has(ref))
  )
    throw new Error("qualification_execution_dependency_unexpected");
  for (const binding of bindings)
    assertRelationSchema(binding.relation, binding.dependencyRef);
}

/**
 * Trusted report preparation passes already-built physical relations and its
 * final frozen plan. Raw match IDs are deliberately not accepted here.
 */
export function createQualificationExecutionInputsForTrustedPlan(
  relations: readonly QualificationDependencyRelationBinding[],
  plan: ValidatedLogicalPlan,
): QualificationExecutionInputs {
  if (!Object.isFrozen(plan))
    throw new Error("qualification_execution_plan_not_frozen");
  assertBindingsMatchPlan(relations, plan);
  const handle = Object.freeze(
    Object.create(null),
  ) as QualificationExecutionInputs;
  qualificationExecutionStates.set(handle as object, {
    bindings: Object.freeze(
      relations.map(({ dependencyRef, relation }) =>
        Object.freeze({ dependencyRef, relation }),
      ),
    ),
    plan,
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
  assertBindingsMatchPlan(state.bindings, plan);
  state.attached = true;
  return state.bindings;
}
