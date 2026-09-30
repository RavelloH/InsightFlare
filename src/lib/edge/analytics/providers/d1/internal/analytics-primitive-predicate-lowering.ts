import {
  and,
  callFunction,
  eq,
  inList,
  isNotNull,
  isNull,
  neq,
  not,
  param,
} from "@/lib/db";
import type { Predicate, SqlExpression } from "@/lib/db/query/expression";
import { semanticAttribute } from "@/lib/edge/analytics/engine/semantic/attributes";
import {
  analyticsFilterRegistry,
  filterConditionEntity,
} from "@/lib/filter-contract/filter-registry";

export type NativePrimitiveFieldId =
  "page.path" | "page.title" | "page.query" | "page.hash" | "event.name";

export interface NativePrimitiveFieldContract {
  readonly id: NativePrimitiveFieldId;
  readonly activity: "page" | "event";
  readonly compilerStrategy:
    | "column.pathname"
    | "column.title"
    | "column.query_string"
    | "column.hash_fragment"
    | "event.name";
  readonly storageSource: "visit" | "event";
  /** Physical typed-schema column nullability (separate from logical slot nullability). */
  readonly storageNullable: boolean;
  /** Logical semantic attribute nullability exposed by the registry/catalog. */
  readonly nullable: boolean;
}

export type NativePrimitivePredicate =
  | { readonly operator: "eq" | "neq"; readonly value: string }
  | { readonly operator: "in" | "notIn"; readonly values: readonly string[] }
  | { readonly operator: "isNull" | "notNull" };

const FIELD_CONTRACTS: Readonly<
  Record<NativePrimitiveFieldId, NativePrimitiveFieldContract>
> = {
  "page.path": {
    id: "page.path",
    activity: "page",
    compilerStrategy: "column.pathname",
    storageSource: "visit",
    storageNullable: false,
    nullable: true,
  },
  "page.title": {
    id: "page.title",
    activity: "page",
    compilerStrategy: "column.title",
    storageSource: "visit",
    storageNullable: false,
    nullable: true,
  },
  "page.query": {
    id: "page.query",
    activity: "page",
    compilerStrategy: "column.query_string",
    storageSource: "visit",
    storageNullable: false,
    nullable: true,
  },
  "page.hash": {
    id: "page.hash",
    activity: "page",
    compilerStrategy: "column.hash_fragment",
    storageSource: "visit",
    storageNullable: false,
    nullable: true,
  },
  "event.name": {
    id: "event.name",
    activity: "event",
    compilerStrategy: "event.name",
    storageSource: "event",
    storageNullable: false,
    nullable: false,
  },
};

/**
 * Resolve only fields whose registry and semantic contracts still agree with
 * this adapter's explicitly supported primitive subset.
 */
export function nativePrimitiveFieldContract(
  fieldId: string,
): NativePrimitiveFieldContract | undefined {
  if (!Object.hasOwn(FIELD_CONTRACTS, fieldId)) return undefined;
  const contract = FIELD_CONTRACTS[fieldId as NativePrimitiveFieldId];
  const field = analyticsFilterRegistry.get(contract.id);
  const attribute = semanticAttribute(contract.id);
  const expectedConditionEntity = contract.activity;
  const expectedNativeEntity = contract.activity === "page" ? "visit" : "event";
  const expectedObservationKind = expectedNativeEntity;

  if (
    !field ||
    !attribute ||
    field.valueKind !== "string" ||
    field.profile !== "trimmed-text" ||
    field.compilerStrategy !== contract.compilerStrategy ||
    field.source !== contract.storageSource ||
    field.nativeEntity !== expectedNativeEntity ||
    filterConditionEntity(field) !== expectedConditionEntity ||
    field.evaluation !== "observation" ||
    field.presence !== "non-null-column" ||
    field.empty !== "raw-empty-string" ||
    field.comparison !== "case-sensitive" ||
    field.nullable !== contract.nullable ||
    !field.observationKinds.has(expectedObservationKind) ||
    attribute.id !== contract.id ||
    attribute.valueType.kind !== "scalar" ||
    attribute.valueType.scalar !== "string" ||
    attribute.nativeEntity !== contract.activity ||
    !attribute.observationKinds.includes(contract.activity) ||
    attribute.nullable !== contract.nullable ||
    attribute.evaluation !== "observation" ||
    attribute.presence !== "non-null" ||
    attribute.empty !== "empty-string-is-value" ||
    attribute.comparison !== "case-sensitive"
  ) {
    return undefined;
  }

  return contract;
}

/** Compile native string primitives against the original typed storage column. */
export function lowerNativePrimitivePredicate(
  column: SqlExpression<string | null>,
  primitive: NativePrimitivePredicate,
): Predicate {
  const normalized = callFunction("trim", column);
  const normalizedValues =
    primitive.operator === "eq" || primitive.operator === "neq"
      ? undefined
      : primitive.operator === "in" || primitive.operator === "notIn"
        ? primitive.values.map((value) => value.trim())
        : undefined;

  switch (primitive.operator) {
    case "eq":
      return eq(normalized, param(primitive.value.trim()));
    case "neq":
      return and(
        isNotNull(column),
        neq(normalized, param(primitive.value.trim())),
      );
    case "in":
      return primitive.values.length === 1
        ? eq(normalized, param(normalizedValues![0]!))
        : inList(normalized, normalizedValues!);
    case "notIn":
      return and(isNotNull(column), not(inList(normalized, normalizedValues!)));
    case "isNull":
      return isNull(column);
    case "notNull":
      return isNotNull(column);
  }
}
