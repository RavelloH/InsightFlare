import { sha256Hex } from "@/lib/sha256";

import {
  hashVersionThirteenPhysicalShape,
  isValidVersionThirteenPhysicalShape,
} from "./physical-shape-v13";
import type { DatabasePhysicalPlanShape } from "./types";

type VersionThirteenShape = Extract<
  DatabasePhysicalPlanShape,
  { readonly version: 13 }
>;
type VersionFourteenShape = Extract<
  DatabasePhysicalPlanShape,
  { readonly version: 14 }
>;

function exactDataKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    return (
      (Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null) &&
      keys.every(
        (key) =>
          typeof key === "string" &&
          (required.includes(key) || optional.includes(key)),
      ) &&
      required.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && "value" in descriptor;
      }) &&
      optional.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor === undefined || "value" in descriptor;
      })
    );
  } catch {
    return false;
  }
}

function denseIndexes(value: unknown): value is readonly number[] {
  if (!Array.isArray(value)) return false;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    !length ||
    !("value" in length) ||
    !Number.isSafeInteger(length.value)
  )
    return false;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length.value + 1 || keys[0] === undefined) return false;
  } catch {
    return false;
  }
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !Number.isSafeInteger(descriptor.value) ||
      descriptor.value < 0
    )
      return false;
  }
  return true;
}

function validCompileOrder(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (
    !exactDataKeys(
      value,
      ["helperCount", "leafCount", "definitionIndexes", "strategy"],
      [],
    )
  )
    return false;
  const shape = value as {
    readonly helperCount: unknown;
    readonly leafCount: unknown;
    readonly definitionIndexes: unknown;
    readonly strategy: unknown;
  };
  if (
    shape.helperCount !== 1 ||
    !Number.isSafeInteger(shape.leafCount) ||
    (shape.leafCount as number) < 2 ||
    (shape.leafCount as number) > 100 ||
    shape.strategy !== "dead-branch-materialization-order" ||
    !denseIndexes(shape.definitionIndexes) ||
    shape.definitionIndexes.length !== shape.leafCount
  )
    return false;
  return (
    new Set(shape.definitionIndexes).size === shape.definitionIndexes.length
  );
}

function versionThirteenShape(
  shape: VersionFourteenShape,
): VersionThirteenShape {
  const { version: _version, compileOrder: _compileOrder, ...fields } = shape;
  return { ...fields, version: 13 } as VersionThirteenShape;
}

export function isValidVersionFourteenPhysicalShape(
  shape: VersionFourteenShape,
  validateVersionTwelve: (
    shape: Extract<DatabasePhysicalPlanShape, { readonly version: 12 }>,
  ) => boolean,
): boolean {
  const required = [
    "version",
    "cteCount",
    "directScanProjectionCount",
    "nativeMembershipCount",
    "jsonMembershipCount",
    "nativeRowRelationCount",
    "jsonRowRelationCount",
    "rightAnchorJoinOrderCount",
    "uniqueLookupJoinOrderCount",
    "factLocalIndexedJoinStrategies",
    "conditionalLookupCount",
    "conditionalLookupStrategies",
    "selfMembershipCount",
    "rowPipelineChoices",
    "lexicographicComparisonCount",
    "lexicographicComparisons",
    "semiMembershipCount",
    "semiMemberships",
    "singletonRankFusionCount",
    "singletonRankFusions",
    "nativeNullOrderingCount",
    "nativeNullOrderings",
    "directMaterializedReferenceCount",
    "directMaterializedReferences",
    "materializationSelectionCount",
    "materializationSelections",
    "derivedSelfMembershipCount",
    "derivedSelfMemberships",
    "compileOrder",
  ] as const;
  const optional = [
    "parameterStrategy",
    "parameterOccurrenceCount",
    "parameterSlotCount",
  ] as const;
  try {
    return (
      shape.version === 14 &&
      exactDataKeys(shape, required, optional) &&
      validCompileOrder(shape.compileOrder) &&
      shape.compileOrder.definitionIndexes.every(
        (index) => index < shape.cteCount - shape.compileOrder.helperCount,
      ) &&
      isValidVersionThirteenPhysicalShape(
        versionThirteenShape(shape),
        validateVersionTwelve,
      )
    );
  } catch {
    return false;
  }
}

export async function hashVersionFourteenPhysicalShape(
  shape: VersionFourteenShape,
  hashVersionTwelve: (
    shape: Extract<DatabasePhysicalPlanShape, { readonly version: 12 }>,
  ) => Promise<string | null>,
): Promise<string | null> {
  const legacyHash = await hashVersionThirteenPhysicalShape(
    versionThirteenShape(shape),
    hashVersionTwelve,
  );
  if (!legacyHash) return null;
  const payload = JSON.stringify([
    "d1-query-shape-v14",
    legacyHash,
    shape.compileOrder.helperCount,
    shape.compileOrder.leafCount,
    shape.compileOrder.definitionIndexes,
    shape.compileOrder.strategy,
  ]);
  return `v14:${await sha256Hex(payload)}`;
}
