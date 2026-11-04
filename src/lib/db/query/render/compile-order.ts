import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type {
  PhysicalCompileOrderPolicy,
  SharedRelationDefinition,
} from "@/lib/db/query/physical/contracts";
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import type { FinalRenderSession } from "@/lib/db/query/render/final-render-session";
import { recordFinalRenderEmission } from "@/lib/db/query/render/fragment-provenance";
import type { SqlFragment } from "@/lib/db/sql/fragment";
import { concat, text } from "@/lib/db/sql/fragment";
import { identifier } from "@/lib/db/sql/identifier";

export const MAX_SCHEDULED_RELATIONS = 100;

export interface CompileOrderSharedReference {
  readonly definition: LogicalQueryNode;
  readonly definitionIndex: number;
  readonly emissionCount: number;
}

export interface CompileOrderHelperEmission {
  readonly helper: object;
  readonly leafDefinitionIndexes: readonly number[];
  readonly strategy: "dead-branch-materialization-order";
}

export interface RenderedCompileOrderHelper {
  readonly definition: SqlFragment;
  readonly cteName: string;
  readonly alias: string;
  readonly marker: string;
  readonly leafCount: number;
  readonly emission: CompileOrderHelperEmission;
}

function invalidPlan(message: string): never {
  throw new DatabaseCompilerError("invalid_plan", message);
}

function validateReference(
  reference: CompileOrderSharedReference,
  definitions: readonly SharedRelationDefinition[],
): number {
  if (
    !reference ||
    !Number.isSafeInteger(reference.definitionIndex) ||
    reference.definitionIndex < 0 ||
    reference.definitionIndex >= definitions.length ||
    !Number.isSafeInteger(reference.emissionCount) ||
    reference.emissionCount <= 0 ||
    definitions[reference.definitionIndex]?.node !== reference.definition
  )
    return invalidPlan("compile_order_shared_reference_is_not_current");
  return reference.definitionIndex;
}

/**
 * Resolve final-fragment references without inspecting SQL. Definitions keep
 * their compiler layout; only the helper leaves are ordered by actual edges.
 */
export function scheduledCompileOrderLeaves(args: {
  readonly policy: PhysicalCompileOrderPolicy | undefined;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly referencesByDefinition: readonly (readonly CompileOrderSharedReference[])[];
  readonly mainReferences: readonly CompileOrderSharedReference[];
  readonly maxScheduledRelations?: number;
}): readonly number[] | undefined {
  const {
    policy,
    definitions,
    referencesByDefinition,
    mainReferences,
    maxScheduledRelations = MAX_SCHEDULED_RELATIONS,
  } = args;
  if (!policy) return undefined;
  if (
    policy.kind !== "strict-rank-materialization-order" ||
    policy.rootSort.kind !== "sort" ||
    referencesByDefinition.length !== definitions.length ||
    !Number.isSafeInteger(maxScheduledRelations) ||
    maxScheduledRelations < 2
  )
    return invalidPlan("compile_order_policy_or_reference_layout_is_invalid");

  const candidateIndexes = new Set<number>();
  for (const index of policy.candidateDefinitionIndexes) {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= definitions.length ||
      candidateIndexes.has(index) ||
      definitions[index]?.materialization !== "materialized"
    )
      return invalidPlan("compile_order_candidate_is_not_currently_licensed");
    candidateIndexes.add(index);
  }
  if (
    policy.strictStageDefinitionIndexes.length === 0 ||
    policy.strictStageDefinitionIndexes.some(
      (index) =>
        !candidateIndexes.has(index) ||
        definitions[index]?.materializationSelection?.kind !==
          "strict-serial-rank-stage",
    )
  )
    return invalidPlan("compile_order_strict_stage_policy_is_invalid");

  const dependencies = definitions.map(() => new Set<number>());
  for (
    let producerIndex = 0;
    producerIndex < definitions.length;
    producerIndex++
  ) {
    const producer = definitions[producerIndex]!;
    for (const reference of referencesByDefinition[producerIndex]!) {
      const dependencyIndex = validateReference(reference, definitions);
      if (
        dependencyIndex >= producerIndex ||
        !producer.dependencies.includes(definitions[dependencyIndex]!.name)
      )
        return invalidPlan("compile_order_dependency_is_forward_or_unlisted");
      dependencies[producerIndex]!.add(dependencyIndex);
    }
  }

  const mainDependencies = new Set<number>();
  for (const reference of mainReferences)
    mainDependencies.add(validateReference(reference, definitions));

  const reachable = new Set<number>();
  const pending = [...mainDependencies];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const dependency of dependencies[current]!) pending.push(dependency);
  }

  const remainingDependencyCount = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  for (const index of reachable) {
    const reachableDependencies = [...dependencies[index]!].filter(
      (dependency) => reachable.has(dependency),
    );
    remainingDependencyCount.set(index, reachableDependencies.length);
    for (const dependency of reachableDependencies) {
      const current = dependents.get(dependency) ?? [];
      current.push(index);
      dependents.set(dependency, current);
    }
  }
  const ready = [...reachable]
    .filter((index) => remainingDependencyCount.get(index) === 0)
    .sort((left, right) => left - right);
  const topological: number[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    topological.push(current);
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = remainingDependencyCount.get(dependent)! - 1;
      remainingDependencyCount.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort((left, right) => left - right);
      }
    }
  }
  if (topological.length !== reachable.size)
    return invalidPlan("compile_order_dependency_cycle");

  const leaves = topological.filter((index) => candidateIndexes.has(index));
  if (leaves.length < 2 || leaves.length > maxScheduledRelations)
    return undefined;
  return Object.freeze(leaves);
}

function allocateIdentifier(
  base: string,
  reservedIdentifiers: Set<string>,
): string {
  const fold = (value: string) =>
    value.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
  const folded = new Set([...reservedIdentifiers].map(fold));
  let suffix = 0;
  let name = base;
  while (folded.has(fold(name))) name = `${base}_${++suffix}`;
  reservedIdentifiers.add(name);
  return name;
}

function balancedSum(expressions: readonly SqlFragment[]): SqlFragment {
  if (expressions.length === 0)
    return invalidPlan("compile_order_helper_requires_leaves");
  if (expressions.length === 1) return expressions[0]!;
  const midpoint = Math.ceil(expressions.length / 2);
  return concat(
    text("("),
    balancedSum(expressions.slice(0, midpoint)),
    text(" + "),
    balancedSum(expressions.slice(midpoint)),
    text(")"),
  );
}

export function renderCompileOrderHelper(args: {
  readonly definitions: readonly SharedRelationDefinition[];
  readonly definitionIndexes: readonly number[];
  readonly reservedIdentifiers: Set<string>;
  readonly session: FinalRenderSession;
}): RenderedCompileOrderHelper {
  const { definitions, definitionIndexes, reservedIdentifiers, session } = args;
  if (
    definitionIndexes.length < 2 ||
    definitionIndexes.length > MAX_SCHEDULED_RELATIONS
  )
    return invalidPlan("compile_order_helper_leaf_count_is_out_of_range");
  const helper = Object.freeze({});
  const leafDefinitionIndexes = Object.freeze([...definitionIndexes]);
  const cteName = allocateIdentifier("_d1_compile_order", reservedIdentifiers);
  const alias = allocateIdentifier(
    "_d1_compile_order_alias",
    reservedIdentifiers,
  );
  const marker = allocateIdentifier(
    "_d1_compile_order_marker",
    reservedIdentifiers,
  );
  const leaves = leafDefinitionIndexes.map((definitionIndex) => {
    const definition = definitions[definitionIndex];
    if (!definition || definition.materialization !== "materialized")
      return invalidPlan("compile_order_helper_leaf_is_not_materialized");
    return concat(
      text("CASE WHEN 0 THEN EXISTS (SELECT 1 FROM "),
      identifier(definition.name),
      text(") ELSE 1 END"),
    );
  });
  const emission: CompileOrderHelperEmission = Object.freeze({
    helper,
    leafDefinitionIndexes,
    strategy: "dead-branch-materialization-order",
  });
  const definition = recordFinalRenderEmission(
    session,
    concat(
      identifier(cteName),
      text(" AS MATERIALIZED (SELECT "),
      balancedSum(leaves),
      text(" AS "),
      identifier(marker),
      text(")"),
    ),
    { kind: "compile-order-helper", ...emission },
  );
  return Object.freeze({
    definition,
    cteName,
    alias,
    marker,
    leafCount: leaves.length,
    emission,
  });
}

export function renderCompileOrderCrossJoin(
  helper: RenderedCompileOrderHelper,
): SqlFragment {
  return concat(
    identifier(helper.cteName),
    text(" AS "),
    identifier(helper.alias),
  );
}

export function renderCompileOrderGuard(
  helper: RenderedCompileOrderHelper,
): SqlFragment {
  return concat(
    identifier(helper.alias),
    text("."),
    identifier(helper.marker),
    text(` = ${helper.leafCount}`),
  );
}
