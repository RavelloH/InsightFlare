import { sha256Hex } from "@/lib/sha256";

import {
  assertD1StatementBudget,
  D1_MAX_SQL_UTF8_BYTES,
  D1StatementBudgetError,
} from "./d1-budget";
import {
  hashVersionThirteenPhysicalShape,
  isValidVersionThirteenPhysicalShape,
} from "./physical-shape-v13";
import {
  hashVersionFourteenPhysicalShape,
  isValidVersionFourteenPhysicalShape,
} from "./physical-shape-v14";
import type {
  DatabaseObservationReason,
  DatabaseObservationSession,
  DatabaseObservationStatus,
  DatabaseOperation,
  DatabasePhysicalPlanShape,
  DatabaseQueryObservation,
  DatabaseQueryObserver,
  DatabaseRuntime,
  DatabaseRuntimeOptions,
  DatabaseStatement,
} from "./types";

const DATABASE_QUERY_OBSERVERS = new WeakMap<
  D1Database,
  DatabaseQueryObserver
>();
const MAX_OBSERVED_BATCH_MEMBERS = 32;
let nextBatchId = 0n;

interface ObservationOutcome {
  readonly status: DatabaseObservationStatus;
  readonly elapsedMs: number | null;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly resultHasD1Meta?: boolean;
  readonly reason?: DatabaseObservationReason;
  readonly budget?: {
    readonly item: "sql_bytes" | "bindings";
    readonly actual: number;
    readonly limit: number;
  };
}

interface SelectedObservationSession {
  readonly session: DatabaseObservationSession;
  readonly statementIndexes: readonly number[];
  readonly includeBatchSummary: boolean;
  readonly batchId?: string;
}

interface D1MetaLike {
  readonly rows_read?: unknown;
  readonly rows_written?: unknown;
  readonly duration?: unknown;
  readonly timings?: { readonly sql_duration_ms?: unknown };
}

function safeNow(): number {
  try {
    const value = globalThis.performance?.now() ?? Date.now();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function elapsedSince(startedAt: number): number | null {
  const elapsed = safeNow() - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function safeBegin(
  observer: DatabaseQueryObserver | undefined,
  operation: DatabaseOperation,
  statementCount: number,
): SelectedObservationSession | undefined {
  if (!observer) return undefined;
  const batchId =
    operation === "batch" ? (++nextBatchId).toString(36) : undefined;
  let session: DatabaseObservationSession | undefined;
  try {
    session = observer.begin({
      operation,
      statementCount,
      ...(batchId === undefined ? {} : { batchId }),
    });
  } catch {
    return undefined;
  }
  if (!session) return undefined;

  try {
    const maxSelected = operation === "batch" ? MAX_OBSERVED_BATCH_MEMBERS : 1;
    const statementIndexes: number[] = [];
    for (const index of session.statementIndexes) {
      if (statementIndexes.length >= maxSelected) break;
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < statementCount &&
        statementIndexes.length < maxSelected &&
        !statementIndexes.includes(index)
      )
        statementIndexes.push(index);
    }
    const includeBatchSummary =
      operation === "batch" && session.includeBatchSummary;
    if (statementIndexes.length === 0 && !includeBatchSummary) {
      releaseSession(session);
      return undefined;
    }
    return {
      session,
      statementIndexes,
      includeBatchSummary,
      ...(batchId === undefined ? {} : { batchId }),
    };
  } catch {
    releaseSession(session);
    return undefined;
  }
}

function releaseSession(session: DatabaseObservationSession): void {
  try {
    session.release();
  } catch {
    // Observation cleanup must never replace a database result or error.
  }
}

function validNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function validNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function d1Meta(result: unknown): D1MetaLike | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const meta = (result as { readonly meta?: unknown }).meta;
  return typeof meta === "object" && meta !== null
    ? (meta as D1MetaLike)
    : undefined;
}

function resultFailed(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { readonly success?: unknown }).success === false
  );
}

function shapeIsValid(
  shape: DatabasePhysicalPlanShape | undefined,
): shape is DatabasePhysicalPlanShape {
  return (
    (shape?.version === 1 ||
      (shape?.version === 2 &&
        Number.isInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0) ||
      (shape?.version === 3 &&
        Number.isInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0 &&
        shape.parameterStrategy === "numbered-reuse" &&
        Number.isSafeInteger(shape.parameterOccurrenceCount) &&
        shape.parameterOccurrenceCount > 100 &&
        Number.isSafeInteger(shape.parameterSlotCount) &&
        shape.parameterSlotCount > 0 &&
        shape.parameterSlotCount < shape.parameterOccurrenceCount) ||
      (shape?.version === 4 &&
        Number.isInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0 &&
        Number.isInteger(shape.rightAnchorJoinOrderCount) &&
        shape.rightAnchorJoinOrderCount >= 0 &&
        Number.isInteger(shape.uniqueLookupJoinOrderCount) &&
        shape.uniqueLookupJoinOrderCount >= 0 &&
        (shape.parameterStrategy === undefined
          ? shape.parameterOccurrenceCount === undefined &&
            shape.parameterSlotCount === undefined
          : shape.parameterStrategy === "numbered-reuse" &&
            Number.isSafeInteger(shape.parameterOccurrenceCount) &&
            shape.parameterOccurrenceCount! > 100 &&
            Number.isSafeInteger(shape.parameterSlotCount) &&
            shape.parameterSlotCount! > 0 &&
            shape.parameterSlotCount! < shape.parameterOccurrenceCount!)) ||
      (shape?.version === 5 &&
        Number.isInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0 &&
        Number.isInteger(shape.rightAnchorJoinOrderCount) &&
        shape.rightAnchorJoinOrderCount >= 0 &&
        Number.isInteger(shape.uniqueLookupJoinOrderCount) &&
        shape.uniqueLookupJoinOrderCount >= 0 &&
        Array.isArray(shape.factLocalIndexedJoinStrategies) &&
        shape.factLocalIndexedJoinStrategies.length > 0 &&
        shape.factLocalIndexedJoinStrategies.every(
          isValidFactLocalIndexedJoinShape,
        ) &&
        (shape.parameterStrategy === undefined
          ? shape.parameterOccurrenceCount === undefined &&
            shape.parameterSlotCount === undefined
          : shape.parameterStrategy === "numbered-reuse" &&
            Number.isSafeInteger(shape.parameterOccurrenceCount) &&
            shape.parameterOccurrenceCount! > 100 &&
            Number.isSafeInteger(shape.parameterSlotCount) &&
            shape.parameterSlotCount! > 0 &&
            shape.parameterSlotCount! < shape.parameterOccurrenceCount!)) ||
      (shape?.version === 6 &&
        Number.isSafeInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isSafeInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0 &&
        Number.isSafeInteger(shape.rightAnchorJoinOrderCount) &&
        shape.rightAnchorJoinOrderCount >= 0 &&
        Number.isSafeInteger(shape.uniqueLookupJoinOrderCount) &&
        shape.uniqueLookupJoinOrderCount >= 0 &&
        Array.isArray(shape.factLocalIndexedJoinStrategies) &&
        isDenseArray(shape.factLocalIndexedJoinStrategies) &&
        shape.factLocalIndexedJoinStrategies.every(
          isValidFactLocalIndexedJoinShape,
        ) &&
        Number.isSafeInteger(shape.conditionalLookupCount) &&
        shape.conditionalLookupCount > 0 &&
        Array.isArray(shape.conditionalLookupStrategies) &&
        isDenseArray(shape.conditionalLookupStrategies) &&
        shape.conditionalLookupStrategies.length ===
          shape.conditionalLookupCount &&
        shape.conditionalLookupStrategies.every(
          isValidConditionalLookupShape,
        ) &&
        (shape.parameterStrategy === undefined
          ? shape.parameterOccurrenceCount === undefined &&
            shape.parameterSlotCount === undefined
          : shape.parameterStrategy === "numbered-reuse" &&
            Number.isSafeInteger(shape.parameterOccurrenceCount) &&
            shape.parameterOccurrenceCount! > 100 &&
            Number.isSafeInteger(shape.parameterSlotCount) &&
            shape.parameterSlotCount! > 0 &&
            shape.parameterSlotCount! < shape.parameterOccurrenceCount!)) ||
      (shape?.version === 7 &&
        Number.isSafeInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isSafeInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0 &&
        Number.isSafeInteger(shape.rightAnchorJoinOrderCount) &&
        shape.rightAnchorJoinOrderCount >= 0 &&
        Number.isSafeInteger(shape.uniqueLookupJoinOrderCount) &&
        shape.uniqueLookupJoinOrderCount >= 0 &&
        Array.isArray(shape.factLocalIndexedJoinStrategies) &&
        isDenseArray(shape.factLocalIndexedJoinStrategies) &&
        shape.factLocalIndexedJoinStrategies.every(
          isValidFactLocalIndexedJoinShape,
        ) &&
        Number.isSafeInteger(shape.conditionalLookupCount) &&
        shape.conditionalLookupCount >= 0 &&
        Array.isArray(shape.conditionalLookupStrategies) &&
        isDenseArray(shape.conditionalLookupStrategies) &&
        shape.conditionalLookupStrategies.length ===
          shape.conditionalLookupCount &&
        shape.conditionalLookupStrategies.every(
          isValidConditionalLookupShape,
        ) &&
        Number.isSafeInteger(shape.selfMembershipCount) &&
        shape.selfMembershipCount > 0 &&
        (shape.parameterStrategy === undefined
          ? shape.parameterOccurrenceCount === undefined &&
            shape.parameterSlotCount === undefined
          : shape.parameterStrategy === "numbered-reuse" &&
            Number.isSafeInteger(shape.parameterOccurrenceCount) &&
            shape.parameterOccurrenceCount! > 100 &&
            Number.isSafeInteger(shape.parameterSlotCount) &&
            shape.parameterSlotCount! > 0 &&
            shape.parameterSlotCount! < shape.parameterOccurrenceCount!)) ||
      (shape?.version === 8 &&
        Number.isSafeInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isSafeInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0 &&
        Number.isSafeInteger(shape.rightAnchorJoinOrderCount) &&
        shape.rightAnchorJoinOrderCount >= 0 &&
        Number.isSafeInteger(shape.uniqueLookupJoinOrderCount) &&
        shape.uniqueLookupJoinOrderCount >= 0 &&
        Array.isArray(shape.factLocalIndexedJoinStrategies) &&
        isDenseArray(shape.factLocalIndexedJoinStrategies) &&
        shape.factLocalIndexedJoinStrategies.every(
          isValidFactLocalIndexedJoinShape,
        ) &&
        Number.isSafeInteger(shape.conditionalLookupCount) &&
        shape.conditionalLookupCount >= 0 &&
        Array.isArray(shape.conditionalLookupStrategies) &&
        isDenseArray(shape.conditionalLookupStrategies) &&
        shape.conditionalLookupStrategies.length ===
          shape.conditionalLookupCount &&
        shape.conditionalLookupStrategies.every(
          isValidConditionalLookupShape,
        ) &&
        Number.isSafeInteger(shape.selfMembershipCount) &&
        shape.selfMembershipCount >= 0 &&
        Array.isArray(shape.rowPipelineChoices) &&
        isDenseArray(shape.rowPipelineChoices) &&
        shape.rowPipelineChoices.length > 0 &&
        shape.rowPipelineChoices.every(isValidRowPipelineShape) &&
        (shape.parameterStrategy === undefined
          ? shape.parameterOccurrenceCount === undefined &&
            shape.parameterSlotCount === undefined
          : shape.parameterStrategy === "numbered-reuse" &&
            Number.isSafeInteger(shape.parameterOccurrenceCount) &&
            shape.parameterOccurrenceCount! > 100 &&
            Number.isSafeInteger(shape.parameterSlotCount) &&
            shape.parameterSlotCount! > 0 &&
            shape.parameterSlotCount! < shape.parameterOccurrenceCount!)) ||
      (shape?.version === 9 &&
        Number.isSafeInteger(shape.nativeRowRelationCount) &&
        shape.nativeRowRelationCount >= 0 &&
        Number.isSafeInteger(shape.jsonRowRelationCount) &&
        shape.jsonRowRelationCount >= 0 &&
        Number.isSafeInteger(shape.rightAnchorJoinOrderCount) &&
        shape.rightAnchorJoinOrderCount >= 0 &&
        Number.isSafeInteger(shape.uniqueLookupJoinOrderCount) &&
        shape.uniqueLookupJoinOrderCount >= 0 &&
        Array.isArray(shape.factLocalIndexedJoinStrategies) &&
        isDenseArray(shape.factLocalIndexedJoinStrategies) &&
        shape.factLocalIndexedJoinStrategies.every(
          isValidFactLocalIndexedJoinShape,
        ) &&
        Number.isSafeInteger(shape.conditionalLookupCount) &&
        shape.conditionalLookupCount >= 0 &&
        Array.isArray(shape.conditionalLookupStrategies) &&
        isDenseArray(shape.conditionalLookupStrategies) &&
        shape.conditionalLookupStrategies.length ===
          shape.conditionalLookupCount &&
        shape.conditionalLookupStrategies.every(
          isValidConditionalLookupShape,
        ) &&
        Number.isSafeInteger(shape.selfMembershipCount) &&
        shape.selfMembershipCount >= 0 &&
        Array.isArray(shape.rowPipelineChoices) &&
        isDenseArray(shape.rowPipelineChoices) &&
        shape.rowPipelineChoices.every(isValidRowPipelineShape) &&
        Number.isSafeInteger(shape.lexicographicComparisonCount) &&
        shape.lexicographicComparisonCount > 0 &&
        Array.isArray(shape.lexicographicComparisons) &&
        isDenseArray(shape.lexicographicComparisons) &&
        shape.lexicographicComparisons.length ===
          shape.lexicographicComparisonCount &&
        shape.lexicographicComparisons.every(
          isValidLexicographicComparisonShape,
        ) &&
        (shape.parameterStrategy === undefined
          ? shape.parameterOccurrenceCount === undefined &&
            shape.parameterSlotCount === undefined
          : shape.parameterStrategy === "numbered-reuse" &&
            Number.isSafeInteger(shape.parameterOccurrenceCount) &&
            shape.parameterOccurrenceCount! > 100 &&
            Number.isSafeInteger(shape.parameterSlotCount) &&
            shape.parameterSlotCount! > 0 &&
            shape.parameterSlotCount! < shape.parameterOccurrenceCount!)) ||
      (shape?.version === 10 && isValidVersionTenPhysicalShape(shape)) ||
      (shape?.version === 11 && isValidVersionElevenPhysicalShape(shape)) ||
      (shape?.version === 12 && isValidVersionTwelvePhysicalShape(shape)) ||
      (shape?.version === 13 &&
        isValidVersionThirteenPhysicalShape(
          shape,
          isValidVersionTwelvePhysicalShapePayload,
        )) ||
      (shape?.version === 14 &&
        isValidVersionFourteenPhysicalShape(
          shape,
          isValidVersionTwelvePhysicalShapePayload,
        ))) &&
    Number.isInteger(shape.cteCount) &&
    shape.cteCount >= 0 &&
    Number.isInteger(shape.directScanProjectionCount) &&
    shape.directScanProjectionCount >= 0 &&
    Number.isInteger(shape.nativeMembershipCount) &&
    shape.nativeMembershipCount >= 0 &&
    Number.isInteger(shape.jsonMembershipCount) &&
    shape.jsonMembershipCount >= 0
  );
}

function isValidSingletonRankFusionShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const keys = [
    "partitionFieldCount",
    "keyFieldCount",
    "consumerCertificateCount",
    "emissionCount",
    "distinct",
  ] as const;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      ownKeys.length !== keys.length ||
      ownKeys.some(
        (key) =>
          typeof key !== "string" ||
          !keys.includes(key as (typeof keys)[number]),
      ) ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor || !("value" in descriptor);
      })
    )
      return false;
  } catch {
    return false;
  }
  const fusion = value as {
    readonly partitionFieldCount?: unknown;
    readonly keyFieldCount?: unknown;
    readonly consumerCertificateCount?: unknown;
    readonly emissionCount?: unknown;
    readonly distinct?: unknown;
  };
  return (
    Number.isSafeInteger(fusion.partitionFieldCount) &&
    (fusion.partitionFieldCount as number) > 0 &&
    Number.isSafeInteger(fusion.keyFieldCount) &&
    (fusion.keyFieldCount as number) > 0 &&
    Number.isSafeInteger(fusion.consumerCertificateCount) &&
    (fusion.consumerCertificateCount as number) >= 0 &&
    Number.isSafeInteger(fusion.emissionCount) &&
    (fusion.emissionCount as number) > 0 &&
    fusion.distinct === true
  );
}

function isValidVersionElevenPhysicalShape(
  shape: Extract<DatabasePhysicalPlanShape, { readonly version: 11 }>,
): boolean {
  if (
    !Number.isSafeInteger(shape.singletonRankFusionCount) ||
    shape.singletonRankFusionCount <= 0 ||
    !Array.isArray(shape.singletonRankFusions) ||
    !isDenseArray(shape.singletonRankFusions) ||
    shape.singletonRankFusions.length !== shape.singletonRankFusionCount ||
    !shape.singletonRankFusions.every(isValidSingletonRankFusionShape)
  )
    return false;
  const legacySemiMemberships =
    shape.semiMembershipCount === 0
      ? [{ keyCount: 1, emissionCount: 1 }]
      : shape.semiMemberships;
  const legacyShape = {
    ...shape,
    version: 10 as const,
    semiMembershipCount: Math.max(shape.semiMembershipCount, 1),
    semiMemberships: legacySemiMemberships,
  } as Extract<DatabasePhysicalPlanShape, { readonly version: 10 }>;
  return isValidVersionTenPhysicalShape(legacyShape);
}

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

function isValidNativeNullOrderingShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const fields = [
    "windowIndex",
    "pairIndex",
    "columnIndex",
    "valueDirection",
    "nullPlacement",
    "emissionCount",
  ] as const;
  if (!hasExactOwnDataKeys(value, fields)) return false;
  const shape = value as {
    readonly windowIndex: unknown;
    readonly pairIndex: unknown;
    readonly columnIndex: unknown;
    readonly valueDirection: unknown;
    readonly nullPlacement: unknown;
    readonly emissionCount: unknown;
  };
  return (
    Number.isSafeInteger(shape.windowIndex) &&
    (shape.windowIndex as number) >= 0 &&
    Number.isSafeInteger(shape.pairIndex) &&
    (shape.pairIndex as number) >= 0 &&
    Number.isSafeInteger(shape.columnIndex) &&
    (shape.columnIndex as number) >= 0 &&
    (shape.valueDirection === "ASC" || shape.valueDirection === "DESC") &&
    (shape.nullPlacement === "FIRST" || shape.nullPlacement === "LAST") &&
    Number.isSafeInteger(shape.emissionCount) &&
    (shape.emissionCount as number) > 0
  );
}

function isValidDirectMaterializedReferenceShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const fields = ["definitionIndex", "fieldCount", "emissionCount"] as const;
  if (!hasExactOwnDataKeys(value, fields)) return false;
  const shape = value as {
    readonly definitionIndex: unknown;
    readonly fieldCount: unknown;
    readonly emissionCount: unknown;
  };
  return (
    Number.isSafeInteger(shape.definitionIndex) &&
    (shape.definitionIndex as number) >= 0 &&
    Number.isSafeInteger(shape.fieldCount) &&
    (shape.fieldCount as number) > 0 &&
    Number.isSafeInteger(shape.emissionCount) &&
    (shape.emissionCount as number) > 0
  );
}

function isValidVersionTwelvePhysicalShape(
  shape: Extract<DatabasePhysicalPlanShape, { readonly version: 12 }>,
): boolean {
  return (
    shape.nativeNullOrderingCount + shape.directMaterializedReferenceCount >
      0 && isValidVersionTwelvePhysicalShapePayload(shape)
  );
}

function isValidVersionTwelvePhysicalShapePayload(
  shape: Extract<DatabasePhysicalPlanShape, { readonly version: 12 }>,
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
  ] as const;
  const optional = [
    "parameterStrategy",
    "parameterOccurrenceCount",
    "parameterSlotCount",
  ] as const;
  if (
    !hasExactOwnDataKeys(shape, required, optional) ||
    !Number.isSafeInteger(shape.singletonRankFusionCount) ||
    shape.singletonRankFusionCount < 0 ||
    !Array.isArray(shape.singletonRankFusions) ||
    !isDenseArray(shape.singletonRankFusions) ||
    shape.singletonRankFusions.length !== shape.singletonRankFusionCount ||
    !shape.singletonRankFusions.every(isValidSingletonRankFusionShape) ||
    !Number.isSafeInteger(shape.semiMembershipCount) ||
    shape.semiMembershipCount < 0 ||
    !Array.isArray(shape.semiMemberships) ||
    !isDenseArray(shape.semiMemberships) ||
    shape.semiMemberships.length !== shape.semiMembershipCount ||
    !shape.semiMemberships.every(isValidSemiMembershipShape) ||
    !Number.isSafeInteger(shape.nativeNullOrderingCount) ||
    shape.nativeNullOrderingCount < 0 ||
    !Array.isArray(shape.nativeNullOrderings) ||
    !isDenseArray(shape.nativeNullOrderings) ||
    shape.nativeNullOrderings.length !== shape.nativeNullOrderingCount ||
    !shape.nativeNullOrderings.every(isValidNativeNullOrderingShape) ||
    !Number.isSafeInteger(shape.directMaterializedReferenceCount) ||
    shape.directMaterializedReferenceCount < 0 ||
    !Array.isArray(shape.directMaterializedReferences) ||
    !isDenseArray(shape.directMaterializedReferences) ||
    shape.directMaterializedReferences.length !==
      shape.directMaterializedReferenceCount ||
    !shape.directMaterializedReferences.every(
      isValidDirectMaterializedReferenceShape,
    )
  )
    return false;
  const nativeNullOrderings = shape.nativeNullOrderings as Extract<
    DatabasePhysicalPlanShape,
    { readonly version: 12 }
  >["nativeNullOrderings"];
  const directMaterializedReferences =
    shape.directMaterializedReferences as Extract<
      DatabasePhysicalPlanShape,
      { readonly version: 12 }
    >["directMaterializedReferences"];
  const nullPairKeys = nativeNullOrderings.map(
    ({ windowIndex, pairIndex }) => `${windowIndex}:${pairIndex}`,
  );
  const definitionIndexes = directMaterializedReferences.map(
    ({ definitionIndex }) => definitionIndex,
  );
  if (
    new Set(nullPairKeys).size !== nullPairKeys.length ||
    new Set(definitionIndexes).size !== definitionIndexes.length
  )
    return false;
  const legacySemiMemberships =
    shape.semiMembershipCount === 0
      ? [{ keyCount: 1, emissionCount: 1 }]
      : shape.semiMemberships;
  const legacyShape = {
    ...shape,
    version: 10 as const,
    semiMembershipCount: Math.max(shape.semiMembershipCount, 1),
    semiMemberships: legacySemiMemberships,
  } as Extract<DatabasePhysicalPlanShape, { readonly version: 10 }>;
  return isValidVersionTenPhysicalShape(legacyShape);
}

function isValidVersionTenPhysicalShape(
  shape: Extract<DatabasePhysicalPlanShape, { readonly version: 10 }>,
): boolean {
  if (
    !Number.isSafeInteger(shape.semiMembershipCount) ||
    shape.semiMembershipCount <= 0 ||
    !Array.isArray(shape.semiMemberships) ||
    !isDenseArray(shape.semiMemberships) ||
    shape.semiMemberships.length !== shape.semiMembershipCount ||
    !shape.semiMemberships.every(isValidSemiMembershipShape) ||
    !Number.isSafeInteger(shape.lexicographicComparisonCount) ||
    shape.lexicographicComparisonCount < 0 ||
    !Array.isArray(shape.lexicographicComparisons) ||
    !isDenseArray(shape.lexicographicComparisons) ||
    shape.lexicographicComparisons.length !==
      shape.lexicographicComparisonCount ||
    !shape.lexicographicComparisons.every(isValidLexicographicComparisonShape)
  )
    return false;

  // Reuse the complete v9 validator for its shared fields. Version 9 requires
  // at least one lexicographic choice, so supply a local sentinel only for
  // that check when the v10 shape has none.
  const legacyComparisons =
    shape.lexicographicComparisonCount === 0
      ? [{ direction: ">" as const, componentCount: 2, emissionCount: 1 }]
      : (shape.lexicographicComparisons as Extract<
          DatabasePhysicalPlanShape,
          { readonly version: 9 }
        >["lexicographicComparisons"]);
  const legacyShape = {
    ...shape,
    version: 9 as const,
    lexicographicComparisonCount: shape.lexicographicComparisonCount || 1,
    lexicographicComparisons: legacyComparisons,
  } as Extract<DatabasePhysicalPlanShape, { readonly version: 9 }>;
  return shapeIsValid(legacyShape);
}

function isValidSemiMembershipShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const item = value as {
    readonly keyCount?: unknown;
    readonly emissionCount?: unknown;
  };
  return (
    Number.isSafeInteger(item.keyCount) &&
    (item.keyCount as number) > 0 &&
    Number.isSafeInteger(item.emissionCount) &&
    (item.emissionCount as number) > 0
  );
}

function isValidLexicographicComparisonShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const comparison = value as {
    readonly direction?: unknown;
    readonly componentCount?: unknown;
    readonly emissionCount?: unknown;
  };
  return (
    (comparison.direction === ">" || comparison.direction === "<") &&
    Number.isSafeInteger(comparison.componentCount) &&
    (comparison.componentCount as number) >= 2 &&
    Number.isSafeInteger(comparison.emissionCount) &&
    (comparison.emissionCount as number) > 0
  );
}

function isValidRowPipelineShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const choice = value as {
    readonly nodeKinds?: unknown;
    readonly outputColumnIndexes?: unknown;
    readonly filterColumnIndexes?: unknown;
  };
  const nodeKinds = choice.nodeKinds;
  const outputColumnIndexes = choice.outputColumnIndexes;
  const filterColumnIndexes = choice.filterColumnIndexes;
  if (
    !Array.isArray(nodeKinds) ||
    !isDenseArray(nodeKinds) ||
    nodeKinds.length < 2 ||
    !nodeKinds.every(
      (kind: unknown) => kind === "filter" || kind === "project",
    ) ||
    !Array.isArray(outputColumnIndexes) ||
    !isDenseArray(outputColumnIndexes) ||
    outputColumnIndexes.length === 0 ||
    !outputColumnIndexes.every(
      (index: unknown) =>
        typeof index === "number" && Number.isSafeInteger(index) && index >= 0,
    ) ||
    !Array.isArray(filterColumnIndexes) ||
    !isDenseArray(filterColumnIndexes) ||
    filterColumnIndexes.length !==
      nodeKinds.filter((kind: unknown) => kind === "filter").length
  )
    return false;
  return filterColumnIndexes.every((indexes: unknown) => {
    if (!Array.isArray(indexes) || !isDenseArray(indexes)) return false;
    return indexes.every(
      (index: unknown) =>
        typeof index === "number" && Number.isSafeInteger(index) && index >= 0,
    );
  });
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++)
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  return true;
}

function validPhysicalIdentifier(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function asciiFold(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    result +=
      code >= 0x41 && code <= 0x5a
        ? String.fromCharCode(code + 0x20)
        : value[index];
  }
  return result;
}

function isValidConditionalLookupShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const strategy = value as {
    readonly tableName?: unknown;
    readonly indexName?: unknown;
    readonly keyColumns?: unknown;
    readonly selectedKey?: unknown;
    readonly guardConjunctCount?: unknown;
  };
  if (
    !validPhysicalIdentifier(strategy.tableName) ||
    !validPhysicalIdentifier(strategy.indexName) ||
    !Number.isSafeInteger(strategy.guardConjunctCount) ||
    (strategy.guardConjunctCount as number) <= 0 ||
    !Array.isArray(strategy.keyColumns) ||
    !isDenseArray(strategy.keyColumns) ||
    strategy.keyColumns.length === 0 ||
    !strategy.selectedKey ||
    typeof strategy.selectedKey !== "object" ||
    Array.isArray(strategy.selectedKey)
  )
    return false;
  const names = new Set<string>();
  const leftIndexes = new Set<number>();
  const rightIndexes = new Set<number>();
  const parseKey = (
    candidate: unknown,
  ):
    | {
        readonly name: string;
        readonly leftIndex: number;
        readonly rightIndex: number;
      }
    | undefined => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      return undefined;
    const key = candidate as {
      readonly name?: unknown;
      readonly leftIndex?: unknown;
      readonly rightIndex?: unknown;
    };
    if (
      !validPhysicalIdentifier(key.name) ||
      !Number.isSafeInteger(key.leftIndex) ||
      (key.leftIndex as number) < 0 ||
      !Number.isSafeInteger(key.rightIndex) ||
      (key.rightIndex as number) < 0
    )
      return undefined;
    return {
      name: key.name,
      leftIndex: key.leftIndex as number,
      rightIndex: key.rightIndex as number,
    };
  };
  const keys = strategy.keyColumns.map(parseKey);
  if (keys.some((key) => key === undefined)) return false;
  for (const key of keys) {
    if (!key) return false;
    const foldedName = asciiFold(key.name);
    if (
      names.has(foldedName) ||
      leftIndexes.has(key.leftIndex) ||
      rightIndexes.has(key.rightIndex)
    )
      return false;
    names.add(foldedName);
    leftIndexes.add(key.leftIndex);
    rightIndexes.add(key.rightIndex);
  }
  const selected = parseKey(strategy.selectedKey);
  return (
    !!selected &&
    keys.some(
      (key) =>
        key?.name === selected.name &&
        key.leftIndex === selected.leftIndex &&
        key.rightIndex === selected.rightIndex,
    )
  );
}

function isValidFactLocalIndexedJoinShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const strategy = value as {
    readonly tableName?: unknown;
    readonly indexName?: unknown;
    readonly keyColumns?: unknown;
  };
  if (
    typeof strategy.tableName !== "string" ||
    strategy.tableName.length === 0 ||
    typeof strategy.indexName !== "string" ||
    strategy.indexName.length === 0 ||
    !Array.isArray(strategy.keyColumns) ||
    strategy.keyColumns.length < 2
  )
    return false;
  const keyColumns = strategy.keyColumns as unknown[];
  const names: string[] = [];
  const leftIndexes: number[] = [];
  const rightIndexes: number[] = [];
  for (const value of keyColumns) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const key = value as {
      readonly name?: unknown;
      readonly leftIndex?: unknown;
      readonly rightIndex?: unknown;
    };
    if (
      typeof key.name !== "string" ||
      key.name.length === 0 ||
      !Number.isSafeInteger(key.leftIndex) ||
      (key.leftIndex as number) < 0 ||
      !Number.isSafeInteger(key.rightIndex) ||
      (key.rightIndex as number) < 0
    )
      return false;
    names.push(key.name.toLowerCase());
    leftIndexes.push(key.leftIndex as number);
    rightIndexes.push(key.rightIndex as number);
  }
  return (
    new Set(names).size === names.length &&
    new Set(leftIndexes).size === leftIndexes.length &&
    new Set(rightIndexes).size === rightIndexes.length
  );
}

async function physicalPlanHash(
  statement: DatabaseStatement,
  sqlBytes: number,
  allowNonGatedVersionTwelve = false,
): Promise<string | null> {
  const shape = statement.physicalPlanShape;
  if (!shape) return null;
  if (sqlBytes > D1_MAX_SQL_UTF8_BYTES) return null;
  if (shape.version === 12 && allowNonGatedVersionTwelve) {
    if (!isValidVersionTwelvePhysicalShapePayload(shape)) return null;
  } else if (!shapeIsValid(shape)) return null;
  try {
    if (shape.version === 14) {
      return hashVersionFourteenPhysicalShape(shape, (legacyShape) =>
        physicalPlanHash(
          { ...statement, physicalPlanShape: legacyShape },
          sqlBytes,
          true,
        ),
      );
    }
    if (shape.version === 13) {
      return hashVersionThirteenPhysicalShape(shape, (legacyShape) =>
        physicalPlanHash(
          { ...statement, physicalPlanShape: legacyShape },
          sqlBytes,
          true,
        ),
      );
    }
    if (shape.version === 12) {
      const legacySemiMemberships =
        shape.semiMembershipCount === 0
          ? [{ keyCount: 1, emissionCount: 1 }]
          : shape.semiMemberships;
      const legacyShape = {
        ...shape,
        version: 10 as const,
        semiMembershipCount: Math.max(shape.semiMembershipCount, 1),
        semiMemberships: legacySemiMemberships,
      } as Extract<DatabasePhysicalPlanShape, { readonly version: 10 }>;
      const legacyHash = await physicalPlanHash(
        { ...statement, physicalPlanShape: legacyShape },
        sqlBytes,
      );
      if (!legacyHash) return null;
      const payload = JSON.stringify([
        "d1-query-shape-v12",
        legacyHash,
        shape.singletonRankFusionCount,
        shape.singletonRankFusions.map(
          ({
            partitionFieldCount,
            keyFieldCount,
            consumerCertificateCount,
            emissionCount,
            distinct,
          }) => [
            partitionFieldCount,
            keyFieldCount,
            consumerCertificateCount,
            emissionCount,
            distinct,
          ],
        ),
        shape.nativeNullOrderingCount,
        shape.nativeNullOrderings.map(
          ({
            windowIndex,
            pairIndex,
            columnIndex,
            valueDirection,
            nullPlacement,
            emissionCount,
          }) => [
            windowIndex,
            pairIndex,
            columnIndex,
            valueDirection,
            nullPlacement,
            emissionCount,
          ],
        ),
        shape.directMaterializedReferenceCount,
        shape.directMaterializedReferences.map(
          ({ definitionIndex, fieldCount, emissionCount }) => [
            definitionIndex,
            fieldCount,
            emissionCount,
          ],
        ),
      ]);
      return `v12:${await sha256Hex(payload)}`;
    }
    if (shape.version === 11) {
      const legacySemiMemberships =
        shape.semiMembershipCount === 0
          ? [{ keyCount: 1, emissionCount: 1 }]
          : shape.semiMemberships;
      const legacyShape = {
        ...shape,
        version: 10 as const,
        semiMembershipCount: Math.max(shape.semiMembershipCount, 1),
        semiMemberships: legacySemiMemberships,
      } as Extract<DatabasePhysicalPlanShape, { readonly version: 10 }>;
      const legacyHash = await physicalPlanHash(
        { ...statement, physicalPlanShape: legacyShape },
        sqlBytes,
      );
      if (!legacyHash) return null;
      const payload = JSON.stringify([
        "d1-query-shape-v11",
        legacyHash,
        shape.singletonRankFusionCount,
        shape.singletonRankFusions.map(
          ({
            partitionFieldCount,
            keyFieldCount,
            consumerCertificateCount,
            emissionCount,
            distinct,
          }) => [
            partitionFieldCount,
            keyFieldCount,
            consumerCertificateCount,
            emissionCount,
            distinct,
          ],
        ),
      ]);
      return `v11:${await sha256Hex(payload)}`;
    }
    if (shape.version === 10) {
      const payload = JSON.stringify([
        "d1-query-shape-v10",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
        shape.rightAnchorJoinOrderCount,
        shape.uniqueLookupJoinOrderCount,
        shape.factLocalIndexedJoinStrategies.map(
          ({ tableName, indexName, keyColumns }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
          ],
        ),
        shape.conditionalLookupCount,
        shape.conditionalLookupStrategies.map(
          ({
            tableName,
            indexName,
            keyColumns,
            selectedKey,
            guardConjunctCount,
          }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
            [selectedKey.name, selectedKey.leftIndex, selectedKey.rightIndex],
            guardConjunctCount,
          ],
        ),
        shape.selfMembershipCount,
        shape.rowPipelineChoices.map(
          ({ nodeKinds, outputColumnIndexes, filterColumnIndexes }) => [
            nodeKinds,
            outputColumnIndexes,
            filterColumnIndexes,
          ],
        ),
        shape.lexicographicComparisonCount,
        shape.lexicographicComparisons.map(
          ({ direction, componentCount, emissionCount }) => [
            direction,
            componentCount,
            emissionCount,
          ],
        ),
        shape.semiMembershipCount,
        shape.semiMemberships.map(({ keyCount, emissionCount }) => [
          keyCount,
          emissionCount,
        ]),
        shape.parameterStrategy ?? null,
        shape.parameterOccurrenceCount ?? null,
        shape.parameterSlotCount ?? null,
      ]);
      return `v10:${await sha256Hex(payload)}`;
    }
    if (shape.version === 9) {
      const payload = JSON.stringify([
        "d1-query-shape-v9",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
        shape.rightAnchorJoinOrderCount,
        shape.uniqueLookupJoinOrderCount,
        shape.factLocalIndexedJoinStrategies.map(
          ({ tableName, indexName, keyColumns }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
          ],
        ),
        shape.conditionalLookupCount,
        shape.conditionalLookupStrategies.map(
          ({
            tableName,
            indexName,
            keyColumns,
            selectedKey,
            guardConjunctCount,
          }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
            [selectedKey.name, selectedKey.leftIndex, selectedKey.rightIndex],
            guardConjunctCount,
          ],
        ),
        shape.selfMembershipCount,
        shape.rowPipelineChoices.map(
          ({ nodeKinds, outputColumnIndexes, filterColumnIndexes }) => [
            nodeKinds,
            outputColumnIndexes,
            filterColumnIndexes,
          ],
        ),
        shape.lexicographicComparisonCount,
        shape.lexicographicComparisons.map(
          ({ direction, componentCount, emissionCount }) => [
            direction,
            componentCount,
            emissionCount,
          ],
        ),
        shape.parameterStrategy ?? null,
        shape.parameterOccurrenceCount ?? null,
        shape.parameterSlotCount ?? null,
      ]);
      return `v9:${await sha256Hex(payload)}`;
    }
    if (shape.version === 8) {
      const payload = JSON.stringify([
        "d1-query-shape-v8",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
        shape.rightAnchorJoinOrderCount,
        shape.uniqueLookupJoinOrderCount,
        shape.factLocalIndexedJoinStrategies.map(
          ({ tableName, indexName, keyColumns }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
          ],
        ),
        shape.conditionalLookupCount,
        shape.conditionalLookupStrategies.map(
          ({
            tableName,
            indexName,
            keyColumns,
            selectedKey,
            guardConjunctCount,
          }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
            [selectedKey.name, selectedKey.leftIndex, selectedKey.rightIndex],
            guardConjunctCount,
          ],
        ),
        shape.selfMembershipCount,
        shape.rowPipelineChoices.map(
          ({ nodeKinds, outputColumnIndexes, filterColumnIndexes }) => [
            nodeKinds,
            outputColumnIndexes,
            filterColumnIndexes,
          ],
        ),
        shape.parameterStrategy ?? null,
        shape.parameterOccurrenceCount ?? null,
        shape.parameterSlotCount ?? null,
      ]);
      return `v8:${await sha256Hex(payload)}`;
    }
    if (shape.version === 1) {
      const payload = JSON.stringify([
        "d1-query-shape-v1",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
      ]);
      return `v1:${await sha256Hex(payload)}`;
    }
    if (shape.version === 2) {
      const payload = JSON.stringify([
        "d1-query-shape-v2",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
      ]);
      return `v2:${await sha256Hex(payload)}`;
    }
    if (shape.version === 3) {
      const payload = JSON.stringify([
        "d1-query-shape-v3",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
        shape.parameterStrategy,
        shape.parameterOccurrenceCount,
        shape.parameterSlotCount,
      ]);
      return `v3:${await sha256Hex(payload)}`;
    }
    if (shape.version === 4) {
      const payload = JSON.stringify([
        "d1-query-shape-v4",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
        shape.rightAnchorJoinOrderCount,
        shape.uniqueLookupJoinOrderCount,
        shape.parameterStrategy ?? null,
        shape.parameterOccurrenceCount ?? null,
        shape.parameterSlotCount ?? null,
      ]);
      return `v4:${await sha256Hex(payload)}`;
    }
    if (shape.version === 7) {
      const payload = JSON.stringify([
        "d1-query-shape-v7",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
        shape.rightAnchorJoinOrderCount,
        shape.uniqueLookupJoinOrderCount,
        shape.factLocalIndexedJoinStrategies.map(
          ({ tableName, indexName, keyColumns }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
          ],
        ),
        shape.conditionalLookupCount,
        shape.conditionalLookupStrategies.map(
          ({
            tableName,
            indexName,
            keyColumns,
            selectedKey,
            guardConjunctCount,
          }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
            [selectedKey.name, selectedKey.leftIndex, selectedKey.rightIndex],
            guardConjunctCount,
          ],
        ),
        shape.selfMembershipCount,
        shape.parameterStrategy ?? null,
        shape.parameterOccurrenceCount ?? null,
        shape.parameterSlotCount ?? null,
      ]);
      return `v7:${await sha256Hex(payload)}`;
    }
    if (shape.version === 6) {
      const payload = JSON.stringify([
        "d1-query-shape-v6",
        statement.sql,
        shape.cteCount,
        shape.directScanProjectionCount,
        shape.nativeMembershipCount,
        shape.jsonMembershipCount,
        shape.nativeRowRelationCount,
        shape.jsonRowRelationCount,
        shape.rightAnchorJoinOrderCount,
        shape.uniqueLookupJoinOrderCount,
        shape.factLocalIndexedJoinStrategies.map(
          ({ tableName, indexName, keyColumns }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
          ],
        ),
        shape.conditionalLookupCount,
        shape.conditionalLookupStrategies.map(
          ({
            tableName,
            indexName,
            keyColumns,
            selectedKey,
            guardConjunctCount,
          }) => [
            tableName,
            indexName,
            keyColumns.map(({ name, leftIndex, rightIndex }) => [
              name,
              leftIndex,
              rightIndex,
            ]),
            [selectedKey.name, selectedKey.leftIndex, selectedKey.rightIndex],
            guardConjunctCount,
          ],
        ),
        shape.parameterStrategy ?? null,
        shape.parameterOccurrenceCount ?? null,
        shape.parameterSlotCount ?? null,
      ]);
      return `v6:${await sha256Hex(payload)}`;
    }
    const payload = JSON.stringify([
      "d1-query-shape-v5",
      statement.sql,
      shape.cteCount,
      shape.directScanProjectionCount,
      shape.nativeMembershipCount,
      shape.jsonMembershipCount,
      shape.nativeRowRelationCount,
      shape.jsonRowRelationCount,
      shape.rightAnchorJoinOrderCount,
      shape.uniqueLookupJoinOrderCount,
      shape.factLocalIndexedJoinStrategies.map(
        ({ tableName, indexName, keyColumns }) => [
          tableName,
          indexName,
          keyColumns.map(({ name, leftIndex, rightIndex }) => [
            name,
            leftIndex,
            rightIndex,
          ]),
        ],
      ),
      shape.parameterStrategy ?? null,
      shape.parameterOccurrenceCount ?? null,
      shape.parameterSlotCount ?? null,
    ]);
    return `v5:${await sha256Hex(payload)}`;
  } catch {
    return null;
  }
}

function observationStatusForError(
  error: unknown,
): Pick<ObservationOutcome, "status" | "reason" | "budget"> | undefined {
  if (error instanceof D1StatementBudgetError)
    return {
      status: "rejected",
      reason: "budget",
      budget: {
        item: error.item,
        actual: error.actual,
        limit: error.limit,
      },
    };
  return { status: "failed", reason: "database_failure" };
}

function statementEvent(
  statement: DatabaseStatement,
  operation: Exclude<DatabaseOperation, "batch">,
  outcome: ObservationOutcome,
): Promise<DatabaseQueryObservation>;
function statementEvent(
  statement: DatabaseStatement,
  operation: "batch",
  outcome: ObservationOutcome,
  batch: { readonly batchId: string; readonly batchIndex: number },
): Promise<DatabaseQueryObservation>;
async function statementEvent(
  statement: DatabaseStatement,
  operation: DatabaseOperation,
  outcome: ObservationOutcome,
  batch?: { readonly batchId: string; readonly batchIndex: number },
): Promise<DatabaseQueryObservation> {
  const sqlBytes =
    outcome.budget?.item === "sql_bytes"
      ? outcome.budget.actual
      : new TextEncoder().encode(statement.sql).byteLength;
  const meta =
    outcome.status === "success" && outcome.resultHasD1Meta
      ? d1Meta(outcome.result)
      : undefined;
  const timing = validNonNegativeNumber(meta?.timings?.sql_duration_ms);
  const dbDurationMs = timing ?? validNonNegativeNumber(meta?.duration) ?? null;
  const hash = await physicalPlanHash(statement, sqlBytes);
  const base = {
    version: 1,
    tag: statement.tag ?? null,
    status: outcome.status,
    rowsRead: validNonNegativeInteger(meta?.rows_read),
    rowsWritten: validNonNegativeInteger(meta?.rows_written),
    dbDurationMs,
    elapsedMs: outcome.elapsedMs,
    sqlBytes,
    bindings: statement.bindings?.length ?? 0,
    physicalPlanHash: hash,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.budget === undefined ? {} : { budget: outcome.budget }),
  } as const;
  if (operation === "batch")
    return {
      ...base,
      operation,
      batchId: batch!.batchId,
      batchIndex: batch!.batchIndex,
    };
  return { ...base, operation };
}

function batchSummaryEvent(
  batchId: string,
  statementCount: number,
  outcome: ObservationOutcome,
): DatabaseQueryObservation {
  return {
    version: 1,
    tag: null,
    operation: "batch",
    status: outcome.status,
    rowsRead: null,
    rowsWritten: null,
    dbDurationMs: null,
    elapsedMs: outcome.elapsedMs,
    sqlBytes: null,
    bindings: null,
    physicalPlanHash: null,
    batchId,
    batchIndex: null,
    statementCount,
    ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    ...(outcome.budget === undefined ? {} : { budget: outcome.budget }),
  };
}

function publishObservations(
  selected: SelectedObservationSession,
  events: readonly (
    DatabaseQueryObservation | Promise<DatabaseQueryObservation>
  )[],
): void {
  const task = (async () => {
    try {
      for (const event of events) await selected.session.record(await event);
    } catch {
      // An observer failure cannot change the native database result.
    } finally {
      releaseSession(selected.session);
    }
  })();
  void task.catch(() => releaseSession(selected.session));
}

function runObserved<T>(
  selected: SelectedObservationSession | undefined,
  operation: DatabaseOperation,
  statements: readonly DatabaseStatement[],
  action: () => Promise<T>,
  eventsForSuccess: (
    result: T,
    elapsedMs: number | null,
  ) =>
    | readonly (DatabaseQueryObservation | Promise<DatabaseQueryObservation>)[]
    | undefined,
): Promise<T> {
  if (!selected) return action();
  const startedAt = safeNow();
  const onError = (error: unknown) => {
    const elapsedMs = elapsedSince(startedAt);
    const failure = observationStatusForError(error)!;
    const outcome: ObservationOutcome = {
      ...failure,
      elapsedMs,
    };
    const events: (
      DatabaseQueryObservation | Promise<DatabaseQueryObservation>
    )[] = [];
    try {
      if (operation === "batch") {
        const batchId = selected.batchId!;
        if (selected.includeBatchSummary)
          events.push(batchSummaryEvent(batchId, statements.length, outcome));
        if (failure.status !== "rejected")
          for (const index of selected.statementIndexes) {
            const statement = statements[index];
            if (!statement) continue;
            events.push(
              statementEvent(
                statement,
                "batch",
                { ...outcome, elapsedMs: null, resultHasD1Meta: false },
                { batchId, batchIndex: index },
              ),
            );
          }
      } else {
        const statement = statements[0];
        if (statement && selected.statementIndexes.includes(0))
          events.push(
            statementEvent(statement, operation, {
              ...outcome,
              resultHasD1Meta: false,
            }),
          );
      }
      publishObservations(selected, events);
    } catch {
      releaseSession(selected.session);
    }
  };

  let promise: Promise<T>;
  try {
    promise = action();
  } catch (error) {
    onError(error);
    throw error;
  }
  return promise.then(
    (result) => {
      const elapsedMs = elapsedSince(startedAt);
      try {
        const events = eventsForSuccess(result, elapsedMs);
        if (events) publishObservations(selected, events);
        else releaseSession(selected.session);
      } catch {
        releaseSession(selected.session);
      }
      return result;
    },
    (error: unknown) => {
      onError(error);
      throw error;
    },
  );
}

function databaseResultEvent(
  statement: DatabaseStatement,
  operation: Exclude<DatabaseOperation, "batch">,
  result: unknown,
  elapsedMs: number | null,
  includeMeta: boolean,
): Promise<DatabaseQueryObservation> {
  const failed = includeMeta && resultFailed(result);
  return statementEvent(statement, operation, {
    status: failed ? "failed" : "success",
    ...(failed ? { reason: "result_failure" as const } : {}),
    elapsedMs,
    result,
    resultHasD1Meta: includeMeta,
  });
}

function batchSuccessEvents(
  selected: SelectedObservationSession,
  statements: readonly DatabaseStatement[],
  results: readonly D1Result[],
  elapsedMs: number | null,
): readonly (DatabaseQueryObservation | Promise<DatabaseQueryObservation>)[] {
  const batchId = selected.batchId!;
  const countMismatch = results.length !== statements.length;
  const anyFailed = results.some(resultFailed);
  const summaryOutcome: ObservationOutcome = {
    status: countMismatch || anyFailed ? "failed" : "success",
    elapsedMs,
    ...(countMismatch
      ? { reason: "missing_batch_result" as const }
      : anyFailed
        ? { reason: "result_failure" as const }
        : {}),
  };
  const events: (
    DatabaseQueryObservation | Promise<DatabaseQueryObservation>
  )[] = [];
  if (selected.includeBatchSummary)
    events.push(batchSummaryEvent(batchId, statements.length, summaryOutcome));
  for (const index of selected.statementIndexes) {
    const statement = statements[index];
    if (!statement) continue;
    const result = results[index];
    if (!result) {
      events.push(
        statementEvent(
          statement,
          "batch",
          {
            status: "failed",
            reason: "missing_batch_result",
            elapsedMs: null,
            resultHasD1Meta: false,
          },
          { batchId, batchIndex: index },
        ),
      );
    } else {
      const failed = resultFailed(result);
      events.push(
        statementEvent(
          statement,
          "batch",
          {
            status: failed ? "failed" : "success",
            ...(failed ? { reason: "result_failure" as const } : {}),
            elapsedMs: null,
            result,
            resultHasD1Meta: true,
          },
          { batchId, batchIndex: index },
        ),
      );
    }
  }
  return events;
}

function prepare(database: D1Database, statement: DatabaseStatement) {
  assertD1StatementBudget(statement);
  const prepared = database.prepare(statement.sql);
  return statement.bindings === undefined
    ? prepared
    : prepared.bind(...statement.bindings);
}

export function registerDatabaseQueryObserver(
  database: D1Database,
  observer: DatabaseQueryObserver,
): void {
  DATABASE_QUERY_OBSERVERS.set(database, observer);
}

export function createDatabaseRuntime(
  database: D1Database,
  options: DatabaseRuntimeOptions = {},
): DatabaseRuntime {
  const observer = options.observer ?? DATABASE_QUERY_OBSERVERS.get(database);
  return {
    all<T extends object>(statement: DatabaseStatement): Promise<D1Result<T>> {
      const selected = safeBegin(observer, "all", 1);
      return runObserved(
        selected,
        "all",
        [statement],
        () => prepare(database, statement).all<T>(),
        (result, elapsedMs) => {
          if (!selected?.statementIndexes.includes(0)) return undefined;
          return [
            databaseResultEvent(statement, "all", result, elapsedMs, true),
          ];
        },
      );
    },
    first<T>(
      statement: DatabaseStatement,
      columnName?: string,
    ): Promise<T | null> {
      const selected = safeBegin(observer, "first", 1);
      return runObserved(
        selected,
        "first",
        [statement],
        () => {
          const prepared = prepare(database, statement);
          return columnName === undefined
            ? prepared.first<T>()
            : prepared.first<T>(columnName);
        },
        (_result, elapsedMs) => {
          if (!selected?.statementIndexes.includes(0)) return undefined;
          return [
            statementEvent(statement, "first", {
              status: "success",
              elapsedMs,
              resultHasD1Meta: false,
            }),
          ];
        },
      );
    },
    run(statement: DatabaseStatement): Promise<D1Result> {
      const selected = safeBegin(observer, "run", 1);
      return runObserved(
        selected,
        "run",
        [statement],
        () => prepare(database, statement).run(),
        (result, elapsedMs) => {
          if (!selected?.statementIndexes.includes(0)) return undefined;
          return [
            databaseResultEvent(statement, "run", result, elapsedMs, true),
          ];
        },
      );
    },
    batch(
      statements: readonly DatabaseStatement[],
    ): Promise<readonly D1Result[]> {
      const selected = safeBegin(observer, "batch", statements.length);
      return runObserved(
        selected,
        "batch",
        statements,
        () => {
          statements.forEach(assertD1StatementBudget);
          return database.batch(
            statements.map((statement) => prepare(database, statement)),
          );
        },
        (results, elapsedMs) =>
          selected
            ? batchSuccessEvents(selected, statements, results, elapsedMs)
            : undefined,
      );
    },
    exec(sql: string): Promise<D1ExecResult> {
      const selected = safeBegin(observer, "exec", 1);
      return runObserved(
        selected,
        "exec",
        [{ sql }],
        () => {
          // D1 exec accepts multi-statement scripts; statement limits are checked
          // on the prepared-statement path and SQL is intentionally not split here.
          return database.exec(sql);
        },
        (_result, elapsedMs) => {
          if (!selected?.statementIndexes.includes(0)) return undefined;
          return [
            statementEvent({ sql }, "exec", {
              status: "success",
              elapsedMs,
              resultHasD1Meta: false,
            }),
          ];
        },
      );
    },
  };
}
