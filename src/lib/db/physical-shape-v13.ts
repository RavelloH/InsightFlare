import { sha256Hex } from "@/lib/sha256";

import type { DatabasePhysicalPlanShape } from "./types";

type VersionTwelveShape = Extract<
  DatabasePhysicalPlanShape,
  { readonly version: 12 }
>;
type VersionThirteenShape = Extract<
  DatabasePhysicalPlanShape,
  { readonly version: 13 }
>;

function hasExactOwnDataKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  try {
    const keys = Reflect.ownKeys(value);
    if (
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (!required.includes(key) && !optional.includes(key)),
      ) ||
      required.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor || !("value" in descriptor);
      }) ||
      optional.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && !("value" in descriptor);
      })
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++)
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  return true;
}

function isValidMaterializationSelectionShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const item = value as {
    readonly definitionIndex?: unknown;
    readonly kind?: unknown;
    readonly choiceIndex?: unknown;
    readonly emissionCount?: unknown;
  };
  return (
    hasExactOwnDataKeys(value, [
      "definitionIndex",
      "kind",
      "choiceIndex",
      "emissionCount",
    ]) &&
    Number.isSafeInteger(item.definitionIndex) &&
    (item.definitionIndex as number) >= 0 &&
    (item.kind === "strict-serial-rank-stage" ||
      item.kind === "stage-derived-auto" ||
      item.kind === "current-boundary-derived-auto") &&
    Number.isSafeInteger(item.choiceIndex) &&
    (item.choiceIndex as number) >= 0 &&
    Number.isSafeInteger(item.emissionCount) &&
    (item.emissionCount as number) > 0
  );
}

function isValidDerivedSelfMembershipShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const item = value as {
    readonly definitionIndex?: unknown;
    readonly producerIndex?: unknown;
    readonly tupleWidth?: unknown;
    readonly nullableGuardCount?: unknown;
    readonly emissionCount?: unknown;
  };
  return (
    hasExactOwnDataKeys(value, [
      "definitionIndex",
      "producerIndex",
      "tupleWidth",
      "nullableGuardCount",
      "emissionCount",
    ]) &&
    Number.isSafeInteger(item.definitionIndex) &&
    (item.definitionIndex as number) >= 0 &&
    Number.isSafeInteger(item.producerIndex) &&
    (item.producerIndex as number) > (item.definitionIndex as number) &&
    Number.isSafeInteger(item.tupleWidth) &&
    (item.tupleWidth as number) > 0 &&
    Number.isSafeInteger(item.nullableGuardCount) &&
    (item.nullableGuardCount as number) >= 0 &&
    (item.nullableGuardCount as number) <= (item.tupleWidth as number) &&
    Number.isSafeInteger(item.emissionCount) &&
    (item.emissionCount as number) > 0
  );
}

function versionTwelveLegacyShape(
  shape: VersionThirteenShape,
): VersionTwelveShape {
  return {
    version: 12,
    cteCount: shape.cteCount,
    directScanProjectionCount: shape.directScanProjectionCount,
    nativeMembershipCount: shape.nativeMembershipCount,
    jsonMembershipCount: shape.jsonMembershipCount,
    nativeRowRelationCount: shape.nativeRowRelationCount,
    jsonRowRelationCount: shape.jsonRowRelationCount,
    rightAnchorJoinOrderCount: shape.rightAnchorJoinOrderCount,
    uniqueLookupJoinOrderCount: shape.uniqueLookupJoinOrderCount,
    factLocalIndexedJoinStrategies: shape.factLocalIndexedJoinStrategies,
    conditionalLookupCount: shape.conditionalLookupCount,
    conditionalLookupStrategies: shape.conditionalLookupStrategies,
    selfMembershipCount: shape.selfMembershipCount,
    rowPipelineChoices: shape.rowPipelineChoices,
    lexicographicComparisonCount: shape.lexicographicComparisonCount,
    lexicographicComparisons: shape.lexicographicComparisons,
    semiMembershipCount: shape.semiMembershipCount,
    semiMemberships: shape.semiMemberships,
    singletonRankFusionCount: shape.singletonRankFusionCount,
    singletonRankFusions: shape.singletonRankFusions,
    nativeNullOrderingCount: shape.nativeNullOrderingCount,
    nativeNullOrderings: shape.nativeNullOrderings,
    directMaterializedReferenceCount: shape.directMaterializedReferenceCount,
    directMaterializedReferences: shape.directMaterializedReferences,
    parameterStrategy: shape.parameterStrategy,
    parameterOccurrenceCount: shape.parameterOccurrenceCount,
    parameterSlotCount: shape.parameterSlotCount,
  };
}

export function isValidVersionThirteenPhysicalShape(
  shape: VersionThirteenShape,
  validateVersionTwelve: (shape: VersionTwelveShape) => boolean,
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
  ] as const;
  const optional = [
    "parameterStrategy",
    "parameterOccurrenceCount",
    "parameterSlotCount",
  ] as const;
  if (
    !hasExactOwnDataKeys(shape, required, optional) ||
    !Number.isSafeInteger(shape.materializationSelectionCount) ||
    shape.materializationSelectionCount < 0 ||
    !Array.isArray(shape.materializationSelections) ||
    !isDenseArray(shape.materializationSelections) ||
    shape.materializationSelections.length !==
      shape.materializationSelectionCount ||
    !shape.materializationSelections.every(
      isValidMaterializationSelectionShape,
    ) ||
    !Number.isSafeInteger(shape.derivedSelfMembershipCount) ||
    shape.derivedSelfMembershipCount < 0 ||
    !Array.isArray(shape.derivedSelfMemberships) ||
    !isDenseArray(shape.derivedSelfMemberships) ||
    shape.derivedSelfMemberships.length !== shape.derivedSelfMembershipCount ||
    !shape.derivedSelfMemberships.every(isValidDerivedSelfMembershipShape) ||
    shape.materializationSelectionCount + shape.derivedSelfMembershipCount === 0
  )
    return false;
  const selectionIndexes = (
    shape.materializationSelections as readonly {
      readonly definitionIndex: number;
    }[]
  ).map(({ definitionIndex }) => definitionIndex);
  if (new Set(selectionIndexes).size !== selectionIndexes.length) return false;
  return validateVersionTwelve(versionTwelveLegacyShape(shape));
}

export async function hashVersionThirteenPhysicalShape(
  shape: VersionThirteenShape,
  hashVersionTwelve: (shape: VersionTwelveShape) => Promise<string | null>,
): Promise<string | null> {
  const legacyHash = await hashVersionTwelve(versionTwelveLegacyShape(shape));
  if (!legacyHash) return null;
  const payload = JSON.stringify([
    "d1-query-shape-v13",
    legacyHash,
    shape.materializationSelectionCount,
    shape.materializationSelections.map(
      ({ definitionIndex, kind, choiceIndex, emissionCount }) => [
        definitionIndex,
        kind,
        choiceIndex,
        emissionCount,
      ],
    ),
    shape.derivedSelfMembershipCount,
    shape.derivedSelfMemberships.map(
      ({
        definitionIndex,
        producerIndex,
        tupleWidth,
        nullableGuardCount,
        emissionCount,
      }) => [
        definitionIndex,
        producerIndex,
        tupleWidth,
        nullableGuardCount,
        emissionCount,
      ],
    ),
  ]);
  return `v13:${await sha256Hex(payload)}`;
}
