import { DatabaseCompilerError } from "@/lib/db/query/errors";
import type {
  PhysicalCompileOrderPolicy,
  SharedRelationDefinition,
} from "@/lib/db/query/physical/contracts";
import { isCurrentMaterializationInterface } from "@/lib/db/query/physical/materialization-reader-context";
import type { PhysicalSharedRelationBoundaryEvidence } from "@/lib/db/query/physical/shared-relation-interfaces";
import type { LogicalQueryNode } from "@/lib/db/query/plan";

function currentLicense(
  definition: SharedRelationDefinition,
  evidence: PhysicalSharedRelationBoundaryEvidence | undefined,
): evidence is PhysicalSharedRelationBoundaryEvidence {
  return (
    evidence !== undefined &&
    isCurrentMaterializationInterface(
      definition.node,
      definition,
      evidence,
      (left, right) =>
        left.length === right.length &&
        left.every(
          (field, index) =>
            field.name === right[index]?.name &&
            field.affinity === right[index]?.affinity &&
            field.nullable === right[index]?.nullable,
        ),
    )
  );
}

/** Derive the only physical condition that permits render-time CTE scheduling. */
export function derivePhysicalCompileOrderPolicy(
  root: LogicalQueryNode,
  definitions: readonly SharedRelationDefinition[],
  boundaries: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >,
): PhysicalCompileOrderPolicy | undefined {
  if (root.kind !== "sort") return undefined;
  const strictStageDefinitionIndexes: number[] = [];
  const candidateDefinitionIndexes: number[] = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const definition = definitions[index]!;
    const evidence = boundaries.get(definition.node);
    if (!currentLicense(definition, evidence)) continue;
    if (
      definition.materializationSelection?.kind === "strict-serial-rank-stage"
    )
      strictStageDefinitionIndexes.push(index);
    candidateDefinitionIndexes.push(index);
  }
  if (
    strictStageDefinitionIndexes.length === 0 ||
    candidateDefinitionIndexes.length < 2
  )
    return undefined;
  return Object.freeze({
    kind: "strict-rank-materialization-order",
    rootSort: root,
    strictStageDefinitionIndexes: Object.freeze(strictStageDefinitionIndexes),
    candidateDefinitionIndexes: Object.freeze(candidateDefinitionIndexes),
  });
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function denseIndexes(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value))
    return undefined;
  const indexes: number[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !Number.isSafeInteger(descriptor.value)
    )
      return undefined;
    indexes.push(descriptor.value as number);
  }
  return indexes;
}

/** Fail closed on altered policy objects, sparse arrays, and accessors. */
export function samePhysicalCompileOrderPolicy(
  actual: unknown,
  expected: PhysicalCompileOrderPolicy | undefined,
): boolean {
  if (expected === undefined) return actual === undefined;
  if (!actual || typeof actual !== "object" || Array.isArray(actual))
    return false;
  try {
    const keys = Reflect.ownKeys(actual);
    if (
      (Object.getPrototypeOf(actual) !== Object.prototype &&
        Object.getPrototypeOf(actual) !== null) ||
      keys.length !== 4 ||
      keys.some(
        (key) =>
          key !== "kind" &&
          key !== "rootSort" &&
          key !== "strictStageDefinitionIndexes" &&
          key !== "candidateDefinitionIndexes",
      )
    )
      return false;
  } catch {
    return false;
  }
  const candidate = actual as object;
  const strictIndexes = denseIndexes(
    ownDataValue(candidate, "strictStageDefinitionIndexes"),
  );
  const candidateIndexes = denseIndexes(
    ownDataValue(candidate, "candidateDefinitionIndexes"),
  );
  return (
    ownDataValue(candidate, "kind") === expected.kind &&
    ownDataValue(candidate, "rootSort") === expected.rootSort &&
    strictIndexes !== undefined &&
    candidateIndexes !== undefined &&
    strictIndexes.length === expected.strictStageDefinitionIndexes.length &&
    candidateIndexes.length === expected.candidateDefinitionIndexes.length &&
    strictIndexes.every(
      (value, index) => value === expected.strictStageDefinitionIndexes[index],
    ) &&
    candidateIndexes.every(
      (value, index) => value === expected.candidateDefinitionIndexes[index],
    )
  );
}

/** Read policy data without invoking accessors and recheck the current layout. */
export function assertCurrentPhysicalCompileOrderPolicy(
  plan: { readonly root: LogicalQueryNode },
  definitions: readonly SharedRelationDefinition[],
  boundaries: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >,
): void {
  const expected = derivePhysicalCompileOrderPolicy(
    plan.root,
    definitions,
    boundaries,
  );
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(plan, "compileOrderPolicy");
  } catch {
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical compile-order policy is not current",
    );
  }
  if (
    (descriptor !== undefined && !("value" in descriptor)) ||
    !samePhysicalCompileOrderPolicy(descriptor?.value, expected)
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical compile-order policy is not current",
    );
}
