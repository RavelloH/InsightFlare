import type {
  LogicalPlan,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import {
  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
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
  lowerer?: object;
  readonly analysisInputs?: readonly AnalysisResultQualificationExecutionBinding[];
}

const qualificationExecutionStates = new WeakMap<
  object,
  QualificationExecutionState
>();

function planDependencies(
  plan: LogicalPlan,
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
  [EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY]: "entity_id",
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
  if (state.analysisInputs)
    assertAnalysisInputsMatchPlan(state.analysisInputs, plan);
  else assertBindingsMatchPlan(state.bindings, plan);
  state.lowerer = lowerer;
  state.attached = true;
  return state.bindings;
}

export interface AnalysisResultQualificationExecutionBinding {
  readonly childPlan: ValidatedLogicalPlan;
  readonly executionInputs: QualificationExecutionInputs;
}
function assertAnalysisInputsMatchPlan(
  bindings: readonly AnalysisResultQualificationExecutionBinding[],
  plan: ValidatedLogicalPlan,
): void {
  const children = [
    ...new Set(
      plan.nodes.flatMap((n) =>
        n.kind === "analysis-result" && planDependencies(n.childPlan).length > 0
          ? [n.childPlan]
          : [],
      ),
    ),
  ];
  if (
    planDependencies(plan).length !== 0 ||
    children.length === 0 ||
    children.length !== bindings.length ||
    new Set(bindings.map((b) => b.childPlan)).size !== bindings.length ||
    children.some((c) => !bindings.some((b) => b.childPlan === c))
  )
    throw new Error("qualification_execution_analysis_dependency_unexpected");
  for (const b of bindings) {
    const st = qualificationExecutionStates.get(b.executionInputs);
    if (!st || st.plan !== b.childPlan || st.attached || st.analysisInputs)
      throw new Error("qualification_execution_analysis_input_mismatch");
    assertBindingsMatchPlan(st.bindings, b.childPlan);
  }
}
/** Compose independently bound child inputs without merging dependency refs.
 * Original child capabilities are consumed atomically; delegated capabilities
 * remain private to this exact frozen parent and its imported child identities. */
export function createAnalysisResultQualificationExecutionInputsForTrustedPlan(
  bindings: readonly AnalysisResultQualificationExecutionBinding[],
  plan: ValidatedLogicalPlan,
): QualificationExecutionInputs {
  if (!Object.isFrozen(plan))
    throw new Error("qualification_execution_plan_not_frozen");
  assertAnalysisInputsMatchPlan(bindings, plan);
  const delegated = bindings.map((b) => {
    const state = qualificationExecutionStates.get(b.executionInputs)!;
    state.attached = true;
    const handle = Object.freeze(
      Object.create(null),
    ) as QualificationExecutionInputs;
    qualificationExecutionStates.set(handle, {
      bindings: state.bindings,
      plan: b.childPlan,
      attached: false,
    });
    return Object.freeze({ childPlan: b.childPlan, executionInputs: handle });
  });
  const handle = Object.freeze(
    Object.create(null),
  ) as QualificationExecutionInputs;
  qualificationExecutionStates.set(handle, {
    bindings: [],
    plan,
    analysisInputs: Object.freeze(delegated),
    attached: false,
  });
  return handle;
}
/** Called only after this lowerer attached the exact parent capability. */
export function analysisResultQualificationExecutionInputsForLowerer(
  input: unknown,
  lowerer: object,
  plan: ValidatedLogicalPlan,
): readonly AnalysisResultQualificationExecutionBinding[] {
  if (input === undefined) return [];
  const st =
    typeof input === "object" && input !== null
      ? qualificationExecutionStates.get(input)
      : undefined;
  if (!st || !st.attached || st.lowerer !== lowerer || st.plan !== plan)
    throw new Error("qualification_execution_analysis_input_mismatch");
  return st.analysisInputs ?? [];
}
