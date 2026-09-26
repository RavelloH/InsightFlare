import {
  analyticsFilterRegistry,
  type RegisteredFilterField,
} from "./filter-registry";
import type { FilterOperator, FilterValue } from "./filters";

const DIRECT_REFERRER_VALUE = "__direct__";
const DIRECT_REFERRER_OPERATORS = new Set<FilterOperator>([
  "eq",
  "neq",
  "in",
  "notIn",
]);

function definitionFor(fieldId?: string): RegisteredFilterField | undefined {
  return fieldId ? analyticsFilterRegistry.get(fieldId) : undefined;
}

function canonicalString(
  value: string,
  definition: RegisteredFilterField | undefined,
  operator?: FilterOperator,
): string {
  let candidate = value;
  if (
    definition?.profile === "direct-referrer" &&
    operator !== undefined &&
    DIRECT_REFERRER_OPERATORS.has(operator) &&
    candidate === DIRECT_REFERRER_VALUE
  )
    candidate = "";
  const canonical = definition?.canonicalize?.(candidate);
  if (typeof canonical === "string") return canonical;
  if (!definition) return candidate;
  if (definition.comparison === "case-insensitive")
    return candidate.trim().toLocaleLowerCase();
  return definition.profile === "trimmed-text" ||
    definition.profile === "case-folded-text" ||
    definition.profile === "session-boundary"
    ? candidate.trim()
    : candidate;
}

/** Canonicalize a scalar with the registered field's storage profile. */
export function canonicalizeFilterValue(
  value: FilterValue,
  fieldId?: string,
  operator?: FilterOperator,
): FilterValue {
  const definition = definitionFor(fieldId);
  if (typeof value === "string")
    return canonicalString(value, definition, operator);
  return definition?.canonicalize?.(value) ?? value;
}

export function filterValuesEqual(
  left: unknown,
  right: unknown,
  fieldId?: string,
  operator: FilterOperator = "eq",
): boolean {
  if (
    left === null ||
    right === null ||
    left === undefined ||
    right === undefined
  )
    return false;
  if (typeof left === "string" && typeof right === "string")
    return (
      canonicalString(left, definitionFor(fieldId), operator) ===
      canonicalString(right, definitionFor(fieldId), operator)
    );
  const definition = definitionFor(fieldId);
  const allowsDateTimeEncoding =
    definition === undefined ||
    definition.valueKind === "date" ||
    definition.valueKind === "datetime";
  if (
    allowsDateTimeEncoding &&
    typeof left === "number" &&
    typeof right === "string" &&
    /^\d{4}-\d\d-\d\dT/u.test(right)
  ) {
    const timestamp = Date.parse(right);
    return Number.isFinite(timestamp) && left === timestamp;
  }
  if (
    allowsDateTimeEncoding &&
    typeof right === "number" &&
    typeof left === "string" &&
    /^\d{4}-\d\d-\d\dT/u.test(left)
  ) {
    const timestamp = Date.parse(left);
    return Number.isFinite(timestamp) && right === timestamp;
  }
  return typeof left === typeof right && left === right;
}

export function filterValueInSet(
  actual: unknown,
  expectedValues: readonly unknown[],
  fieldId: string | undefined,
  operator: "in" | "notIn",
): boolean {
  return expectedValues.some((expected) =>
    filterValuesEqual(actual, expected, fieldId, operator),
  );
}

export function compareFilterStrings(
  left: string,
  right: string,
  fieldId?: string,
): number {
  return canonicalString(left, definitionFor(fieldId)).localeCompare(
    canonicalString(right, definitionFor(fieldId)),
  );
}

export function compareFilterValues(
  left: string | number | boolean,
  right: string | number | boolean,
  fieldId?: string,
): number {
  if (typeof left === "string" && typeof right === "string")
    return compareFilterStrings(left, right, fieldId);
  if (typeof left === "boolean" && typeof right === "boolean")
    return Number(left) - Number(right);
  return Number(left) - Number(right);
}

export function matchFilterString(
  actual: string,
  expected: string,
  operator: "contains" | "startsWith" | "endsWith",
  fieldId?: string,
): boolean {
  const left = canonicalString(actual, definitionFor(fieldId));
  const right = canonicalString(expected, definitionFor(fieldId));
  return operator === "contains"
    ? left.includes(right)
    : operator === "startsWith"
      ? left.startsWith(right)
      : left.endsWith(right);
}

export interface FilterPresenceState {
  readonly missing: boolean;
  readonly value: unknown;
  readonly emptyCollection: boolean;
  /** Preserve the legacy field-target NULL behavior at the root. */
  readonly legacyField: boolean;
}

/** Apply field storage presence/null semantics to valueless operators. */
export function filterPresenceMatches(
  operator: FilterOperator,
  state: FilterPresenceState,
  fieldId?: string,
): boolean | undefined {
  const definition = definitionFor(fieldId);
  const isMissing = state.missing;
  const isNull = state.value === null;
  const missingIsNull =
    definition !== undefined && definition.presence !== "json-pointer";
  switch (operator) {
    case "exists":
      return (
        !isMissing &&
        (!isNull || definition?.presence === "json-pointer") &&
        !state.emptyCollection
      );
    case "notExists":
      return (
        isMissing ||
        state.emptyCollection ||
        (isNull && (missingIsNull || state.legacyField))
      );
    case "isNull":
      return isNull || (isMissing && (missingIsNull || state.legacyField));
    case "notNull":
      return !isMissing && !isNull;
    case "isEmpty":
      return definition?.empty === "raw-empty-string" && state.value === "";
    case "notEmpty":
      return (
        definition?.empty === "raw-empty-string" &&
        typeof state.value === "string" &&
        state.value !== ""
      );
    default:
      return undefined;
  }
}
