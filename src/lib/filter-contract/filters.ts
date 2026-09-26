import type { FilterAudience } from "./types";

export const FILTER_DOCUMENT_VERSION = 1 as const;

export type FilterValue = string | number | boolean | null;
export type FilterValueKind =
  | "string"
  | "enum"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "json-scalar";
export const FILTER_OPERATOR_IDS = [
  "eq",
  "neq",
  "in",
  "notIn",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "exists",
  "notExists",
  "isNull",
  "notNull",
  "isEmpty",
  "notEmpty",
] as const;

export type FilterOperator =
  | "eq"
  | "neq"
  | "in"
  | "notIn"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "exists"
  | "notExists"
  | "isNull"
  | "notNull"
  | "isEmpty"
  | "notEmpty";

export type FilterFieldId = string & { readonly __brand: "FilterFieldId" };
export type CanonicalJsonPath = string & {
  readonly __brand: "CanonicalJsonPath";
};

export interface FieldFilterTarget {
  readonly kind: "field";
  readonly field: FilterFieldId;
}

export interface EventPayloadFilterTarget {
  readonly kind: "event-payload";
  readonly path: CanonicalJsonPath;
}

export type FilterEntityRoot = "event" | "page" | "session" | "visitor";
export type FilterDurationUnit =
  "ms" | "s" | "m" | "h" | "d" | "w" | "mo" | "y";

export interface FilterEntityRootTarget {
  readonly kind: "entity-root";
  readonly entity: FilterEntityRoot;
}

export interface FilterContextRootTarget {
  readonly kind: "context-root";
  readonly context: "current" | "sequence" | "period" | "bucket";
}

export interface FilterMemberTarget {
  readonly kind: "member";
  readonly object: FilterTargetExpression;
  readonly member: string;
}

export interface FilterSelectorTarget {
  readonly kind: "selector";
  readonly collection: FilterTargetExpression;
  readonly predicate: FilterExpression;
}

export interface FilterProjectionTarget {
  readonly kind: "projection";
  readonly collection: FilterTargetExpression;
  readonly member: string;
  readonly path?: CanonicalJsonPath;
}

export interface FilterReducerTarget {
  readonly kind: "reducer";
  readonly reducer:
    | "count"
    | "first"
    | "last"
    | "nth"
    | "sum"
    | "avg"
    | "min"
    | "max"
    | "countDistinct";
  readonly input: FilterTargetExpression;
  readonly index?: number;
}

export interface FilterArithmeticTarget {
  readonly kind: "arithmetic";
  readonly operator: "add" | "sub" | "mul" | "div";
  readonly left: FilterTargetExpression;
  readonly right: FilterTargetExpression;
}

export interface FilterDurationTarget {
  readonly kind: "duration";
  readonly amount: number;
  readonly unit: FilterDurationUnit;
}

export interface FilterTimeAnchorTarget {
  readonly kind: "time-anchor";
  readonly anchor: "now" | "range.start" | "range.end";
  readonly offset?: FilterDurationTarget;
}

export interface FilterBucketTarget {
  readonly kind: "bucket";
  readonly input: FilterTargetExpression;
  readonly interval: FilterDurationTarget;
}

export interface FilterWindowTarget {
  readonly kind: "window";
  readonly collection: FilterTargetExpression;
  readonly anchor: FilterTargetExpression;
  readonly startOffset: FilterDurationTarget;
  readonly endOffset: FilterDurationTarget;
}

export interface FilterPeriodsTarget {
  readonly kind: "periods";
  readonly collection: FilterTargetExpression;
  readonly interval: FilterDurationTarget;
}

export interface FilterSequenceTarget {
  readonly kind: "sequence";
  readonly steps: readonly FilterTargetExpression[];
}

export interface FilterAdjacentTarget {
  readonly kind: "adjacent";
  readonly sequence: FilterTargetExpression;
}

export interface FilterWithoutTarget {
  readonly kind: "without";
  readonly sequence: FilterTargetExpression;
  readonly excluded: FilterTargetExpression;
}

/**
 * Core and Relation targets extend the original v1 field and payload targets.
 * The document and DSL versions stay at 1; legacy targets retain their exact
 * shape so old persisted filters continue to normalize as before.
 */
export type FilterTargetExpression =
  | FieldFilterTarget
  | EventPayloadFilterTarget
  | FilterEntityRootTarget
  | FilterContextRootTarget
  | FilterMemberTarget
  | FilterSelectorTarget
  | FilterProjectionTarget
  | FilterReducerTarget
  | FilterArithmeticTarget
  | FilterDurationTarget
  | FilterTimeAnchorTarget
  | FilterBucketTarget
  | FilterWindowTarget
  | FilterPeriodsTarget
  | FilterSequenceTarget
  | FilterAdjacentTarget
  | FilterWithoutTarget;

/** Legacy name retained for consumers that only accept field / payload paths. */
export type FilterTarget = FieldFilterTarget | EventPayloadFilterTarget;

/** Values which may appear at one endpoint of a computed temporal range. */
export type FilterComparisonValue =
  FilterValue | FilterTimeAnchorTarget | FilterDurationTarget;

/**
 * The Filter v1 language allows scalar lists, plus duration/time-anchor
 * endpoints for `between`. Runtime normalization validates that computed
 * endpoints are only used by `between` and that the pair has compatible types.
 */
export type FilterConditionValue =
  | FilterValue
  | readonly FilterValue[]
  | readonly [FilterComparisonValue, FilterComparisonValue]
  | FilterTimeAnchorTarget
  | FilterDurationTarget;

export interface FilterCondition {
  readonly kind: "condition";
  readonly target: FilterTargetExpression;
  readonly operator: FilterOperator;
  readonly value?: FilterConditionValue;
}

export interface FilterGroup {
  readonly kind: "and" | "or";
  readonly children: readonly FilterExpression[];
}

export interface FilterNot {
  readonly kind: "not";
  readonly child: FilterExpression;
}

export type FilterExpression = FilterCondition | FilterGroup | FilterNot;

export interface FilterDocument {
  readonly version: typeof FILTER_DOCUMENT_VERSION;
  readonly root: FilterExpression | null;
}

export type FilterConditionEntity =
  "page" | "event" | "session" | "visitor" | "activity";

export interface FilterLimits {
  readonly maxConditions: number;
  readonly maxDepth: number;
  readonly maxGroups: number;
  readonly maxSetValues: number;
  readonly maxValueLength: number;
}

export const DEFAULT_FILTER_LIMITS: FilterLimits = {
  maxConditions: 128,
  maxDepth: 16,
  maxGroups: 64,
  maxSetValues: 128,
  maxValueLength: 4_096,
};

export interface FilterFieldDefinition {
  readonly id: string;
  readonly valueKind: FilterValueKind;
  readonly operators: ReadonlySet<FilterOperator>;
  readonly audiences: ReadonlySet<FilterAudience>;
  /** Entity domain used when a condition is evaluated inside an aggregate selector. */
  readonly conditionEntity?: FilterConditionEntity;
  readonly number?: {
    readonly min?: number;
    readonly max?: number;
    readonly step?: number;
  };
  /** Set-to-scalar reduction is only sound when the storage profile proves it. */
  readonly singletonSetEquivalent?: boolean;
  readonly unit?: "ms" | "px" | "ratio";
  readonly canonicalize?: (value: FilterValue) => FilterValue;
}

export type FilterFieldRegistry = ReadonlyMap<string, FilterFieldDefinition>;

export class FilterValidationError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "FilterValidationError";
    this.code = code;
    this.path = path;
  }
}

const VALUELESS_OPERATORS = new Set<FilterOperator>([
  "exists",
  "notExists",
  "isNull",
  "notNull",
  "isEmpty",
  "notEmpty",
]);
const SET_OPERATORS = new Set<FilterOperator>(["in", "notIn"]);
const RANGE_OPERATORS = new Set<FilterOperator>(["between"]);
const ALL_OPERATORS = new Set<FilterOperator>(FILTER_OPERATOR_IDS);

function fail(code: string, path: string, message: string): never {
  throw new FilterValidationError(code, path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFilterValue(value: unknown): value is FilterValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function canonicalJsonPath(value: unknown, path: string): CanonicalJsonPath {
  if (typeof value !== "string" || value.length === 0 || value.length > 240) {
    fail(
      "invalid_json_path",
      path,
      "Expected a bounded canonical JSON pointer path.",
    );
  }
  if (!value.startsWith("/") || value === "/" || value.includes("//")) {
    fail(
      "invalid_json_path",
      path,
      "JSON path must be a non-empty JSON pointer.",
    );
  }
  const segments = value.slice(1).split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || /~(?![01])/.test(segment),
    )
  ) {
    fail(
      "invalid_json_path",
      path,
      "JSON path contains an invalid pointer segment.",
    );
  }
  return value as CanonicalJsonPath;
}

function resolveTarget(
  input: Record<string, unknown>,
  registry: FilterFieldRegistry,
  path: string,
): { target: FilterTarget; definition: FilterFieldDefinition } {
  if (!isRecord(input.target) || typeof input.target.kind !== "string") {
    fail(
      "invalid_target",
      `${path}.target`,
      "Filter condition requires a typed target.",
    );
  }
  if (input.target.kind === "field") {
    const definition = definitionFor(
      input.target.field,
      registry,
      `${path}.target.field`,
    );
    return {
      target: {
        kind: "field",
        field: definition.id as FilterFieldId,
      },
      definition,
    };
  }
  if (input.target.kind === "event-payload") {
    const definition = registry.get("event.payload");
    if (!definition) {
      fail(
        "unknown_field",
        `${path}.target`,
        "The event payload field is not registered.",
      );
    }
    return {
      target: {
        kind: "event-payload",
        path: canonicalJsonPath(input.target.path, `${path}.target.path`),
      },
      definition,
    };
  }
  fail("invalid_target", `${path}.target.kind`, "Unknown filter target kind.");
}

export function isLegacyFilterTarget(
  target: FilterTargetExpression,
): target is FilterTarget {
  return target.kind === "field" || target.kind === "event-payload";
}

/** Returns the v1 scalar value shape or rejects expressions needing the new compiler. */
export function legacyConditionValue(
  value: FilterConditionValue | undefined,
): FilterValue | readonly FilterValue[] | undefined {
  if (value === undefined || isFilterValue(value)) return value;
  if (Array.isArray(value) && value.every(isFilterValue)) {
    return value as readonly FilterValue[];
  }
  throw new TypeError("unsupported_filter_condition_value");
}

const ENTITY_ROOTS = new Set<FilterEntityRoot>([
  "event",
  "page",
  "session",
  "visitor",
]);
const DURATION_UNITS = new Set<FilterDurationUnit>([
  "ms",
  "s",
  "m",
  "h",
  "d",
  "w",
  "mo",
  "y",
]);
const REDUCERS = new Set<FilterReducerTarget["reducer"]>([
  "count",
  "first",
  "last",
  "nth",
  "sum",
  "avg",
  "min",
  "max",
  "countDistinct",
]);

function canonicalDuration(input: unknown, path: string): FilterDurationTarget {
  if (
    !isRecord(input) ||
    input.kind !== "duration" ||
    typeof input.amount !== "number" ||
    !Number.isFinite(input.amount) ||
    typeof input.unit !== "string" ||
    !DURATION_UNITS.has(input.unit as FilterDurationUnit)
  ) {
    fail(
      "invalid_duration",
      path,
      "Expected a finite duration with a supported unit.",
    );
  }
  return {
    kind: "duration",
    amount: Object.is(input.amount, -0) ? 0 : input.amount,
    unit: input.unit as FilterDurationUnit,
  };
}

function canonicalTargetExpression(
  input: unknown,
  registry: FilterFieldRegistry,
  limits: FilterLimits,
  counters: Counters,
  path: string,
  depth: number,
): FilterTargetExpression {
  if (depth > limits.maxDepth) {
    fail("too_deep", path, "Filter target depth limit exceeded.");
  }
  if (!isRecord(input) || typeof input.kind !== "string") {
    fail("invalid_target", path, "Expected a typed target expression.");
  }
  if (input.kind === "field") {
    const definition = definitionFor(input.field, registry, `${path}.field`);
    return { kind: "field", field: definition.id as FilterFieldId };
  }
  if (input.kind === "event-payload") {
    if (!registry.get("event.payload")) {
      fail("unknown_field", path, "The event payload field is not registered.");
    }
    return {
      kind: "event-payload",
      path: canonicalJsonPath(input.path, `${path}.path`),
    };
  }
  const target = (value: unknown, key: string) =>
    canonicalTargetExpression(
      value,
      registry,
      limits,
      counters,
      `${path}.${key}`,
      depth + 1,
    );
  const memberName = (value: unknown, key: string): string => {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)
    ) {
      fail(
        "invalid_member",
        `${path}.${key}`,
        "Expected a supported member name.",
      );
    }
    return value;
  };
  switch (input.kind) {
    case "entity-root":
      if (
        typeof input.entity !== "string" ||
        !ENTITY_ROOTS.has(input.entity as FilterEntityRoot)
      ) {
        fail("invalid_entity_root", `${path}.entity`, "Unknown entity root.");
      }
      return { kind: "entity-root", entity: input.entity as FilterEntityRoot };
    case "context-root":
      if (
        !["current", "sequence", "period", "bucket"].includes(
          String(input.context),
        )
      ) {
        fail(
          "invalid_context_root",
          `${path}.context`,
          "Unknown expression context root.",
        );
      }
      return {
        kind: "context-root",
        context: input.context as FilterContextRootTarget["context"],
      };
    case "member":
      return {
        kind: "member",
        object: target(input.object, "object"),
        member: memberName(input.member, "member"),
      };
    case "selector": {
      if (!Object.prototype.hasOwnProperty.call(input, "predicate")) {
        fail(
          "missing_predicate",
          `${path}.predicate`,
          "Selector requires a predicate.",
        );
      }
      return {
        kind: "selector",
        collection: target(input.collection, "collection"),
        predicate: canonicalExpression(
          input.predicate,
          registry,
          limits,
          counters,
          `${path}.predicate`,
          depth + 1,
        ),
      };
    }
    case "projection":
      return {
        kind: "projection",
        collection: target(input.collection, "collection"),
        member: memberName(input.member, "member"),
        ...(input.path === undefined
          ? {}
          : { path: canonicalJsonPath(input.path, `${path}.path`) }),
      };
    case "reducer": {
      if (
        typeof input.reducer !== "string" ||
        !REDUCERS.has(input.reducer as FilterReducerTarget["reducer"])
      ) {
        fail("invalid_reducer", `${path}.reducer`, "Unknown reducer.");
      }
      const reducer = input.reducer as FilterReducerTarget["reducer"];
      if (reducer === "nth") {
        if (!Number.isSafeInteger(input.index) || (input.index as number) < 1) {
          fail(
            "invalid_index",
            `${path}.index`,
            "nth index must be a positive integer.",
          );
        }
      } else if (input.index !== undefined) {
        fail("unexpected_index", `${path}.index`, "Only nth accepts an index.");
      }
      return {
        kind: "reducer",
        reducer,
        input: target(input.input, "input"),
        ...(reducer === "nth" ? { index: input.index as number } : {}),
      };
    }
    case "arithmetic":
      if (!["add", "sub", "mul", "div"].includes(String(input.operator))) {
        fail(
          "invalid_arithmetic",
          `${path}.operator`,
          "Unknown arithmetic operator.",
        );
      }
      return {
        kind: "arithmetic",
        operator: input.operator as FilterArithmeticTarget["operator"],
        left: target(input.left, "left"),
        right: target(input.right, "right"),
      };
    case "duration":
      return canonicalDuration(input, path);
    case "time-anchor":
      if (!["now", "range.start", "range.end"].includes(String(input.anchor))) {
        fail(
          "invalid_time_anchor",
          `${path}.anchor`,
          "Unknown relative time anchor.",
        );
      }
      return {
        kind: "time-anchor",
        anchor: input.anchor as FilterTimeAnchorTarget["anchor"],
        ...(input.offset === undefined
          ? {}
          : { offset: canonicalDuration(input.offset, `${path}.offset`) }),
      };
    case "bucket":
      return {
        kind: "bucket",
        input: target(input.input, "input"),
        interval: canonicalDuration(input.interval, `${path}.interval`),
      };
    case "window": {
      const startOffset = canonicalDuration(
        input.startOffset,
        `${path}.startOffset`,
      );
      const endOffset = canonicalDuration(input.endOffset, `${path}.endOffset`);
      return {
        kind: "window",
        collection: target(input.collection, "collection"),
        anchor: target(input.anchor, "anchor"),
        startOffset,
        endOffset,
      };
    }
    case "periods":
      return {
        kind: "periods",
        collection: target(input.collection, "collection"),
        interval: canonicalDuration(input.interval, `${path}.interval`),
      };
    case "sequence":
      if (!Array.isArray(input.steps) || input.steps.length < 2) {
        fail(
          "invalid_sequence",
          `${path}.steps`,
          "A sequence requires at least two steps.",
        );
      }
      return {
        kind: "sequence",
        steps: input.steps.map((step, index) =>
          target(step, `steps[${index}]`),
        ),
      };
    case "adjacent":
      return {
        kind: "adjacent",
        sequence: target(input.sequence, "sequence"),
      };
    case "without":
      return {
        kind: "without",
        sequence: target(input.sequence, "sequence"),
        excluded: target(input.excluded, "excluded"),
      };
    default:
      fail(
        "invalid_target",
        `${path}.kind`,
        "Unknown filter target expression kind.",
      );
  }
}

function validateLimits(limits: FilterLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail(
        "invalid_limit",
        `limits.${name}`,
        "Filter limits must be positive integers.",
      );
    }
  }
}

function definitionFor(
  field: unknown,
  registry: FilterFieldRegistry,
  path: string,
): FilterFieldDefinition {
  if (
    typeof field !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(field)
  ) {
    fail(
      "invalid_field",
      path,
      "Filter field must be a stable dot-namespaced ID.",
    );
  }
  const definition = registry.get(field);
  if (!definition)
    fail("unknown_field", path, `Unknown filter field: ${field}`);
  if (field === "event.payload") {
    fail(
      "invalid_target",
      path,
      "event.payload requires an event-payload target with a JSON pointer path.",
    );
  }
  return definition;
}

function requireOperator(value: unknown, path: string): FilterOperator {
  if (
    typeof value !== "string" ||
    !ALL_OPERATORS.has(value as FilterOperator)
  ) {
    fail("invalid_operator", path, "Unknown filter operator.");
  }
  return value as FilterOperator;
}

function canonicalDate(value: string, path: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail("invalid_date", path, "Expected an ISO calendar date.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    fail("invalid_date", path, "Expected a real ISO calendar date.");
  }
  return value;
}

function canonicalDateTime(value: string, path: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    fail(
      "invalid_datetime",
      path,
      "Expected an RFC 3339 datetime with timezone.",
    );
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail("invalid_datetime", path, "Expected a real RFC 3339 datetime.");
  }
  return new Date(timestamp).toISOString();
}

function canonicalValue(
  raw: unknown,
  definition: FilterFieldDefinition,
  path: string,
  limits: FilterLimits,
): FilterValue {
  if (!isFilterValue(raw)) {
    fail("invalid_value", path, "Filter values must be JSON scalar values.");
  }
  if (typeof raw === "string" && raw.length > limits.maxValueLength) {
    fail(
      "value_too_long",
      path,
      "Filter value exceeds the configured length limit.",
    );
  }

  let value: FilterValue;
  if (definition.valueKind === "number") {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      fail("invalid_number", path, "Expected a finite numeric filter value.");
    }
    value = Object.is(raw, -0) ? 0 : raw;
    if (definition.number?.min !== undefined && value < definition.number.min) {
      fail(
        "number_below_minimum",
        path,
        "Numeric filter value is below the field minimum.",
      );
    }
    if (definition.number?.max !== undefined && value > definition.number.max) {
      fail(
        "number_above_maximum",
        path,
        "Numeric filter value is above the field maximum.",
      );
    }
    if (definition.number?.step !== undefined) {
      const step = definition.number.step;
      const base = definition.number.min ?? 0;
      const quotient = (value - base) / step;
      const tolerance = Number.EPSILON * Math.max(1, Math.abs(quotient)) * 8;
      if (Math.abs(quotient - Math.round(quotient)) > tolerance) {
        fail(
          "number_not_on_step",
          path,
          "Numeric filter value does not match the field step.",
        );
      }
    }
  } else if (definition.valueKind === "boolean") {
    if (typeof raw !== "boolean") {
      fail("invalid_boolean", path, "Expected a boolean filter value.");
    }
    value = raw;
  } else if (definition.valueKind === "date") {
    if (typeof raw !== "string")
      fail("invalid_date", path, "Expected an ISO date.");
    value = canonicalDate(raw, path);
  } else if (definition.valueKind === "datetime") {
    if (typeof raw !== "string") {
      fail("invalid_datetime", path, "Expected an RFC 3339 datetime.");
    }
    value = canonicalDateTime(raw, path);
  } else if (definition.valueKind === "json-scalar") {
    value = raw;
  } else {
    if (typeof raw !== "string") {
      fail("invalid_string", path, "Expected a string filter value.");
    }
    value = raw;
  }

  const canonical = definition.canonicalize
    ? definition.canonicalize(value)
    : value;
  if (!isFilterValue(canonical)) {
    fail(
      "invalid_canonical_value",
      path,
      "Field canonicalization returned an invalid value.",
    );
  }
  if (
    definition.valueKind === "number" &&
    (typeof canonical !== "number" || !Number.isFinite(canonical))
  ) {
    fail(
      "invalid_canonical_value",
      path,
      "Field canonicalization returned a non-numeric value.",
    );
  }
  if (
    ["string", "enum", "date", "datetime"].includes(definition.valueKind) &&
    typeof canonical !== "string"
  ) {
    fail(
      "invalid_canonical_value",
      path,
      "Field canonicalization returned a non-string value.",
    );
  }
  if (
    typeof canonical === "string" &&
    canonical.length > limits.maxValueLength
  ) {
    fail(
      "value_too_long",
      path,
      "Canonical filter value exceeds the configured length limit.",
    );
  }
  return canonical;
}

interface Counters {
  conditions: number;
  groups: number;
}

type SetAlgebraCondition = {
  readonly target: FilterTarget;
  readonly operator: "in" | "notIn";
  readonly sourceOperator: "eq" | "neq" | "in" | "notIn";
  readonly values: readonly FilterValue[];
};

type IndexedSetAlgebraCondition = SetAlgebraCondition & {
  readonly index: number;
};

function targetKey(target: FilterTarget): string {
  return target.kind === "field"
    ? `field\u0000${target.field}`
    : `event-payload\u0000${target.path}`;
}

function targetDefinition(
  target: FilterTarget,
  registry: FilterFieldRegistry,
): FilterFieldDefinition | undefined {
  return registry.get(target.kind === "field" ? target.field : "event.payload");
}

function setAlgebraCondition(
  expression: FilterExpression,
): SetAlgebraCondition | undefined {
  if (expression.kind !== "condition") return undefined;
  if (!isLegacyFilterTarget(expression.target)) return undefined;
  if (
    expression.operator !== "eq" &&
    expression.operator !== "neq" &&
    expression.operator !== "in" &&
    expression.operator !== "notIn"
  ) {
    return undefined;
  }
  const values =
    expression.operator === "eq" || expression.operator === "neq"
      ? [expression.value!]
      : expression.value;
  if (!Array.isArray(values) || values.some((value) => value === null)) {
    return undefined;
  }
  return {
    target: expression.target,
    operator:
      expression.operator === "neq" || expression.operator === "notIn"
        ? "notIn"
        : "in",
    sourceOperator: expression.operator,
    values: values as readonly FilterValue[],
  };
}

function canonicalSetValues(
  values: Iterable<FilterValue>,
): readonly FilterValue[] {
  return [
    ...new Map([...values].map((value) => [canonicalValueKey(value), value])),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function setOperation(
  left: readonly FilterValue[],
  right: readonly FilterValue[],
  operator: "union" | "intersection",
): readonly FilterValue[] {
  const leftEntries = new Map(
    left.map((value) => [canonicalValueKey(value), value]),
  );
  const rightEntries = new Map(
    right.map((value) => [canonicalValueKey(value), value]),
  );
  const values =
    operator === "union"
      ? [...leftEntries.values(), ...rightEntries.values()]
      : [...leftEntries].flatMap(([key, value]) =>
          rightEntries.has(key) ? [value] : [],
        );
  return canonicalSetValues(values);
}

function setCondition(
  condition: SetAlgebraCondition,
  values: readonly FilterValue[],
  useEquality: boolean,
): FilterCondition | undefined {
  if (values.length === 0) return undefined;
  if (values.length === 1 && useEquality) {
    return {
      kind: "condition",
      target: condition.target,
      operator: "eq",
      value: values[0],
    };
  }
  return {
    kind: "condition",
    target: condition.target,
    operator: condition.operator,
    value: values,
  };
}

/**
 * Performs only lossless finite-set algebra. Empty intersections remain as
 * separate predicates because this AST intentionally has no boolean literals.
 */
function simplifySetGroups(
  kind: "and" | "or",
  children: readonly FilterExpression[],
  registry: FilterFieldRegistry,
  limits: FilterLimits,
): readonly FilterExpression[] {
  const groups = new Map<string, IndexedSetAlgebraCondition[]>();
  for (const [index, child] of children.entries()) {
    const condition = setAlgebraCondition(child);
    if (!condition) continue;
    if (
      !targetDefinition(condition.target, registry)?.operators.has(
        condition.operator,
      )
    ) {
      continue;
    }
    const key = targetKey(condition.target);
    const group = groups.get(key) ?? [];
    group.push({ ...condition, index });
    groups.set(key, group);
  }
  const removedIndexes = new Set<number>();
  const replacements = new Map<number, FilterCondition>();
  for (const group of groups.values()) {
    const positive = group.filter(({ operator }) => operator === "in");
    const negative = group.filter(({ operator }) => operator === "notIn");
    if (positive.length > 1) {
      const values = positive
        .slice(1)
        .reduce(
          (current, condition) =>
            setOperation(
              current,
              condition.values,
              kind === "or" ? "union" : "intersection",
            ),
          positive[0]!.values,
        );
      const replacement = setCondition(
        positive[0]!,
        values,
        kind === "and" &&
          positive.some(({ sourceOperator }) => sourceOperator === "eq"),
      );
      if (replacement && values.length <= limits.maxSetValues) {
        replacements.set(positive[0]!.index, replacement);
        positive.slice(1).forEach(({ index }) => removedIndexes.add(index));
      }
    }
    if (kind === "and" && negative.length > 1) {
      const values = negative
        .slice(1)
        .reduce(
          (current, condition) =>
            setOperation(current, condition.values, "union"),
          negative[0]!.values,
        );
      const replacement = setCondition(negative[0]!, values, false);
      if (replacement && values.length <= limits.maxSetValues) {
        replacements.set(negative[0]!.index, replacement);
        negative.slice(1).forEach(({ index }) => removedIndexes.add(index));
      }
    }
  }
  return children.flatMap((child, index) => {
    if (removedIndexes.has(index)) return [];
    return [replacements.get(index) ?? child];
  });
}

function canonicalCondition(
  input: Record<string, unknown>,
  registry: FilterFieldRegistry,
  limits: FilterLimits,
  counters: Counters,
  path: string,
): FilterCondition {
  const rawTarget = input.target;
  const legacy =
    isRecord(rawTarget) &&
    (rawTarget.kind === "field" || rawTarget.kind === "event-payload");
  const resolved = legacy ? resolveTarget(input, registry, path) : null;
  const target = resolved
    ? resolved.target
    : canonicalTargetExpression(
        rawTarget,
        registry,
        limits,
        counters,
        `${path}.target`,
        1,
      );
  const definition = resolved?.definition;
  const operator = requireOperator(input.operator, `${path}.operator`);
  if (definition && !definition.operators.has(operator)) {
    fail(
      "operator_not_allowed",
      `${path}.operator`,
      "Operator is not allowed for this field.",
    );
  }
  counters.conditions += 1;
  if (counters.conditions > limits.maxConditions) {
    fail("too_many_conditions", path, "Filter condition limit exceeded.");
  }

  if (VALUELESS_OPERATORS.has(operator)) {
    if (hasOwn(input, "value")) {
      fail(
        "unexpected_value",
        `${path}.value`,
        "Unary filter operators do not accept a value.",
      );
    }
    return {
      kind: "condition",
      target,
      operator,
    };
  }

  if (!hasOwn(input, "value")) {
    fail(
      "missing_value",
      `${path}.value`,
      "This filter operator requires a value.",
    );
  }
  const rawValue = input.value;

  if (!definition) {
    const canonicalDynamicValue = (
      value: unknown,
      valuePath: string,
    ): FilterValue | FilterTimeAnchorTarget | FilterDurationTarget => {
      if (isRecord(value) && typeof value.kind === "string") {
        const expression = canonicalTargetExpression(
          value,
          registry,
          limits,
          counters,
          valuePath,
          1,
        );
        if (
          expression.kind !== "time-anchor" &&
          expression.kind !== "duration"
        ) {
          fail(
            "invalid_condition_value",
            valuePath,
            "Only temporal anchors and durations may appear as comparison values.",
          );
        }
        return expression;
      }
      if (!isFilterValue(value)) {
        fail("invalid_value", valuePath, "Expected a scalar condition value.");
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        fail("invalid_number", valuePath, "Expected a finite number.");
      }
      if (typeof value === "string" && value.length > limits.maxValueLength) {
        fail(
          "value_too_long",
          valuePath,
          "Filter value exceeds the configured length limit.",
        );
      }
      return value;
    };
    if (SET_OPERATORS.has(operator)) {
      if (!Array.isArray(rawValue) || rawValue.length === 0) {
        fail(
          "invalid_set",
          `${path}.value`,
          "Set operators require a non-empty value array.",
        );
      }
      if (rawValue.length > limits.maxSetValues) {
        fail(
          "too_many_set_values",
          `${path}.value`,
          "Filter set-value limit exceeded.",
        );
      }
      return {
        kind: "condition",
        target,
        operator,
        value: rawValue.map((value, index) => {
          if (isRecord(value) && typeof value.kind === "string") {
            fail(
              "invalid_set",
              `${path}.value[${index}]`,
              "Set values must be scalar literals.",
            );
          }
          return canonicalDynamicValue(
            value,
            `${path}.value[${index}]`,
          ) as FilterValue;
        }),
      };
    }
    if (operator === "between") {
      if (!Array.isArray(rawValue) || rawValue.length !== 2) {
        fail(
          "invalid_range",
          `${path}.value`,
          "between requires exactly two values.",
        );
      }
      const values = rawValue.map((value, index) =>
        canonicalDynamicValue(value, `${path}.value[${index}]`),
      );
      const computedKinds = values.map((value) =>
        value && typeof value === "object" && "kind" in value
          ? value.kind
          : null,
      );
      if (
        computedKinds.some((kind) => kind === "duration") &&
        computedKinds.some((kind) => kind !== "duration")
      ) {
        fail(
          "invalid_range",
          `${path}.value`,
          "Duration endpoints must both be elapsed durations.",
        );
      }
      if (
        values.some((value) => {
          if (typeof value === "boolean" || value === null) return true;
          if (value && typeof value === "object" && value.kind === "duration")
            return value.unit === "mo" || value.unit === "y";
          return false;
        })
      ) {
        fail(
          "invalid_range",
          `${path}.value`,
          "Range endpoints must be ordered temporal or numeric values.",
        );
      }
      const durationMs = (value: FilterDurationTarget) => {
        const factors: Readonly<Record<string, number>> = {
          ms: 1,
          s: 1_000,
          m: 60_000,
          h: 3_600_000,
          d: 86_400_000,
          w: 604_800_000,
        };
        return value.amount * factors[value.unit]!;
      };
      const staticLower = values[0];
      const staticUpper = values[1];
      const isDurationRange = computedKinds[0] === "duration";
      const isAnchorRange = computedKinds.some(
        (kind) => kind === "time-anchor",
      );
      if (
        isAnchorRange &&
        values.some(
          (value, index) =>
            computedKinds[index] !== "time-anchor" &&
            !(
              typeof value === "string" &&
              /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/u.test(
                value,
              ) &&
              Number.isFinite(Date.parse(value))
            ) &&
            !(value && typeof value === "object" && "kind" in value),
        )
      ) {
        fail(
          "invalid_range",
          `${path}.value`,
          "Time-anchor ranges require datetime or computed temporal endpoints.",
        );
      }
      if (
        isDurationRange &&
        durationMs(staticLower as FilterDurationTarget) >
          durationMs(staticUpper as FilterDurationTarget)
      ) {
        fail(
          "reversed_range",
          `${path}.value`,
          "Between endpoints must be ordered from lower to upper.",
        );
      }
      const reversedNumericRange =
        typeof staticLower === "number" &&
        typeof staticUpper === "number" &&
        staticLower > staticUpper;
      const reversedStringRange =
        typeof staticLower === "string" &&
        typeof staticUpper === "string" &&
        staticLower > staticUpper;
      if (
        !isDurationRange &&
        !isAnchorRange &&
        (reversedNumericRange || reversedStringRange)
      )
        fail(
          "reversed_range",
          `${path}.value`,
          "Between endpoints must be ordered from lower to upper.",
        );
      return {
        kind: "condition",
        target,
        operator,
        value: [values[0]!, values[1]!] as const,
      };
    }
    if (Array.isArray(rawValue)) {
      fail(
        "invalid_scalar",
        `${path}.value`,
        "Scalar operators require one scalar value.",
      );
    }
    return {
      kind: "condition",
      target,
      operator,
      value: canonicalDynamicValue(rawValue, `${path}.value`),
    };
  }

  if (SET_OPERATORS.has(operator)) {
    if (!Array.isArray(rawValue) || rawValue.length === 0) {
      fail(
        "invalid_set",
        `${path}.value`,
        "Set operators require a non-empty value array.",
      );
    }
    if (rawValue.length > limits.maxSetValues) {
      fail(
        "too_many_set_values",
        `${path}.value`,
        "Filter set-value limit exceeded.",
      );
    }
    const values = rawValue.map((value, index) =>
      canonicalValue(value, definition, `${path}.value[${index}]`, limits),
    );
    const unique = new Map(
      values.map((value) => [canonicalValueKey(value), value]),
    );
    const ordered = [...unique.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => value);
    if (ordered.length === 1 && definition.singletonSetEquivalent) {
      return {
        kind: "condition",
        target,
        operator: operator === "in" ? "eq" : "neq",
        value: ordered[0],
      };
    }
    return {
      kind: "condition",
      target,
      operator,
      value: ordered,
    };
  }

  if (RANGE_OPERATORS.has(operator)) {
    if (!Array.isArray(rawValue) || rawValue.length !== 2) {
      fail(
        "invalid_range",
        `${path}.value`,
        "Between requires exactly two values.",
      );
    }
    const values = rawValue.map((value, index) =>
      canonicalValue(value, definition, `${path}.value[${index}]`, limits),
    );
    assertAscendingRange(values, definition, `${path}.value`);
    return {
      kind: "condition",
      target,
      operator,
      value: values,
    };
  }

  if (Array.isArray(rawValue)) {
    fail(
      "invalid_scalar",
      `${path}.value`,
      "Scalar operators require one scalar value.",
    );
  }
  if (rawValue === null) {
    fail(
      "null_requires_unary_operator",
      `${path}.value`,
      "Use isNull or notNull instead of comparing to null.",
    );
  }
  if (isRecord(rawValue) && rawValue.kind === "duration") {
    if (definition.unit !== "ms")
      fail(
        "invalid_value",
        `${path}.value`,
        "Duration values require a field stored in milliseconds.",
      );
    const duration = canonicalTargetExpression(
      rawValue,
      registry,
      limits,
      counters,
      `${path}.value`,
      1,
    );
    if (duration.kind !== "duration")
      fail("invalid_value", `${path}.value`, "Expected a duration value.");
    return {
      kind: "condition",
      target,
      operator,
      value: duration,
    };
  }
  return {
    kind: "condition",
    target,
    operator,
    value: canonicalValue(rawValue, definition, `${path}.value`, limits),
  };
}

function canonicalExpression(
  input: unknown,
  registry: FilterFieldRegistry,
  limits: FilterLimits,
  counters: Counters,
  path: string,
  depth: number,
): FilterExpression {
  if (depth > limits.maxDepth) {
    fail("too_deep", path, "Filter expression depth limit exceeded.");
  }
  if (!isRecord(input) || typeof input.kind !== "string") {
    fail("invalid_expression", path, "Expected a filter expression node.");
  }
  if (input.kind === "condition") {
    return canonicalCondition(input, registry, limits, counters, path);
  }
  if (input.kind === "not") {
    counters.groups += 1;
    if (counters.groups > limits.maxGroups) {
      fail("too_many_groups", path, "Filter group limit exceeded.");
    }
    if (!hasOwn(input, "child")) {
      fail(
        "missing_child",
        `${path}.child`,
        "Not requires exactly one child expression.",
      );
    }
    const child = canonicalExpression(
      input.child,
      registry,
      limits,
      counters,
      `${path}.child`,
      depth + 1,
    );
    return child.kind === "not" ? child.child : { kind: "not", child };
  }
  if (input.kind !== "and" && input.kind !== "or") {
    fail(
      "invalid_expression",
      `${path}.kind`,
      "Unknown filter expression kind.",
    );
  }
  if (!Array.isArray(input.children) || input.children.length === 0) {
    fail(
      "invalid_group",
      `${path}.children`,
      "Boolean groups require at least one child.",
    );
  }
  counters.groups += 1;
  if (counters.groups > limits.maxGroups) {
    fail("too_many_groups", path, "Filter group limit exceeded.");
  }
  const children: FilterExpression[] = [];
  for (const [index, rawChild] of input.children.entries()) {
    const child = canonicalExpression(
      rawChild,
      registry,
      limits,
      counters,
      `${path}.children[${index}]`,
      depth + 1,
    );
    if (child.kind === input.kind) children.push(...child.children);
    else children.push(child);
  }
  const unique = new Map(
    children.map((child) => [filterExpressionFingerprint(child), child]),
  );
  const simplified = simplifySetGroups(
    input.kind,
    [...unique.values()],
    registry,
    limits,
  );
  const ordered = simplified
    .map((child) => [filterExpressionFingerprint(child), child] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, child]) => child);
  if (ordered.length === 1) return ordered[0]!;
  return { kind: input.kind, children: ordered };
}

function canonicalValueKey(value: FilterValue): string {
  return JSON.stringify(value);
}

function assertAscendingRange(
  values: readonly FilterValue[],
  definition: FilterFieldDefinition,
  path: string,
): void {
  const [lower, upper] = values;
  if (lower === null || upper === null) {
    fail("invalid_range", path, "Between endpoints cannot be null.");
  }
  if (definition.valueKind === "json-scalar") {
    if (
      (typeof lower !== "number" && typeof lower !== "string") ||
      typeof lower !== typeof upper
    ) {
      fail(
        "invalid_range",
        path,
        "JSON scalar ranges require two values of the same ordered type.",
      );
    }
  }
  if (lower > upper) {
    fail(
      "reversed_range",
      path,
      "Between endpoints must be ordered from lower to upper.",
    );
  }
}

function stableExpressionValue(expression: FilterExpression): unknown {
  if (expression.kind === "condition") {
    return {
      target: expression.target,
      kind: expression.kind,
      operator: expression.operator,
      ...(expression.value === undefined ? {} : { value: expression.value }),
    };
  }
  if (expression.kind === "not") {
    return {
      child: stableExpressionValue(expression.child),
      kind: expression.kind,
    };
  }
  return {
    children: expression.children.map(stableExpressionValue),
    kind: expression.kind,
  };
}

export function normalizeFilterDocument(
  input: unknown,
  registry: FilterFieldRegistry,
  suppliedLimits: Partial<FilterLimits> = {},
): FilterDocument {
  const limits = { ...DEFAULT_FILTER_LIMITS, ...suppliedLimits };
  validateLimits(limits);
  if (!isRecord(input) || input.version !== FILTER_DOCUMENT_VERSION) {
    fail(
      "unsupported_version",
      "version",
      "Expected filter document version 1.",
    );
  }
  if (!hasOwn(input, "root")) {
    fail(
      "missing_root",
      "root",
      "Filter document must include a root expression or null.",
    );
  }
  if (input.root === null)
    return { version: FILTER_DOCUMENT_VERSION, root: null };
  return {
    version: FILTER_DOCUMENT_VERSION,
    root: canonicalExpression(
      input.root,
      registry,
      limits,
      { conditions: 0, groups: 0 },
      "root",
      1,
    ),
  };
}

export function filterExpressionFingerprint(
  expression: FilterExpression,
): string {
  return JSON.stringify(stableExpressionValue(expression));
}

export function filterFingerprint(
  document: FilterDocument,
  registry: FilterFieldRegistry,
): string {
  const normalized = normalizeFilterDocument(document, registry);
  return `filter-v${FILTER_DOCUMENT_VERSION}:${normalized.root ? filterExpressionFingerprint(normalized.root) : "null"}`;
}

export function hasEffectiveFilters(document: FilterDocument): boolean {
  return document.root !== null;
}

function filterDocumentWithRoot(
  document: FilterDocument,
  root: FilterExpression | null,
): FilterDocument {
  const result = { version: document.version, root } as FilterDocument;
  for (const key of Reflect.ownKeys(document)) {
    if (typeof key !== "symbol") continue;
    const descriptor = Object.getOwnPropertyDescriptor(document, key);
    if (descriptor) Object.defineProperty(result, key, descriptor);
  }
  return result;
}

/**
 * Removes only the target field's atomic conditions at the top facet level.
 * Nested OR/NOT (and compound AND) expressions are deliberately preserved.
 */
export function stripTopLevelFacet(
  document: FilterDocument,
  field: string,
): FilterDocument {
  const root = document.root;
  if (!root) return document;
  const targetsField = (expression: FilterExpression): boolean =>
    expression.kind === "condition" &&
    expression.target.kind === "field" &&
    expression.target.field === field;

  if (targetsField(root)) {
    return filterDocumentWithRoot(document, null);
  }
  if (root.kind !== "and") return document;

  const children = root.children.filter((child) => !targetsField(child));
  if (children.length === root.children.length) return document;
  if (children.length === 0) return filterDocumentWithRoot(document, null);
  if (children.length === 1) {
    return filterDocumentWithRoot(document, children[0]!);
  }
  return filterDocumentWithRoot(document, { kind: "and", children });
}

export function filterConditionCount(document: FilterDocument): number {
  const countTarget = (target: FilterTargetExpression): number => {
    switch (target.kind) {
      case "selector":
        return countTarget(target.collection) + count(target.predicate);
      case "projection":
        return countTarget(target.collection);
      case "context-root":
        return 0;
      case "member":
        return countTarget(target.object);
      case "reducer":
        return countTarget(target.input);
      case "arithmetic":
        return countTarget(target.left) + countTarget(target.right);
      case "bucket":
        return countTarget(target.input);
      case "window":
        return countTarget(target.collection) + countTarget(target.anchor);
      case "periods":
        return countTarget(target.collection);
      case "sequence":
        return target.steps.reduce(
          (total, step) => total + countTarget(step),
          0,
        );
      case "adjacent":
        return countTarget(target.sequence);
      case "without":
        return countTarget(target.sequence) + countTarget(target.excluded);
      default:
        return 0;
    }
  };
  const count = (expression: FilterExpression | null): number => {
    if (!expression) return 0;
    if (expression.kind === "condition")
      return 1 + countTarget(expression.target);
    if (expression.kind === "not") return count(expression.child);
    return expression.children.reduce(
      (total, child) => total + count(child),
      0,
    );
  };
  return count(document.root);
}

export function assertFilterAudience(
  document: FilterDocument,
  registry: FilterFieldRegistry,
  audience: FilterAudience,
): void {
  const normalized = normalizeFilterDocument(document, registry);
  const advancedFieldForTarget = (
    target: FilterTargetExpression,
  ): string | null => {
    if (target.kind === "projection" && target.member === "payload") {
      return "event.payload";
    }
    const members: string[] = [];
    let entity: string | null = null;
    const find = (item: FilterTargetExpression): void => {
      switch (item.kind) {
        case "member":
          members.push(item.member);
          find(item.object);
          break;
        case "entity-root":
          entity = item.entity;
          break;
        case "selector":
          find(item.collection);
          break;
        case "projection":
          members.push(item.member);
          find(item.collection);
          break;
        case "reducer":
          find(item.input);
          break;
        default:
          break;
      }
    };
    find(target);
    const parts = members.reverse();
    const candidates = [
      ...(entity && parts.length > 0 ? [`${entity}.${parts.join(".")}`] : []),
      ...parts.slice(0).map((_, index) => parts.slice(index).join(".")),
    ];
    return candidates.find((candidate) => registry.has(candidate)) ?? null;
  };
  const assertFieldAudience = (field: string, operator?: FilterOperator) => {
    const definition = registry.get(field);
    if (!definition || !definition.audiences.has(audience)) {
      fail(
        "field_not_allowed",
        "filters",
        "Filter field is not allowed for this audience.",
      );
    }
    if (operator && !definition.operators.has(operator)) {
      fail(
        "operator_not_allowed",
        "filters",
        "Filter operator is not allowed for this field.",
      );
    }
  };
  const visitTarget = (target: FilterTargetExpression): void => {
    if (target.kind === "field" || target.kind === "event-payload") {
      const field = target.kind === "field" ? target.field : "event.payload";
      assertFieldAudience(field);
      return;
    }
    switch (target.kind) {
      case "member":
        {
          const field = advancedFieldForTarget(target);
          if (field) assertFieldAudience(field);
        }
        visitTarget(target.object);
        break;
      case "selector":
        visitTarget(target.collection);
        visit(target.predicate);
        break;
      case "projection":
        {
          const field = advancedFieldForTarget(target);
          if (field) assertFieldAudience(field);
        }
        visitTarget(target.collection);
        break;
      case "context-root":
        break;
      case "reducer":
        visitTarget(target.input);
        break;
      case "arithmetic":
        visitTarget(target.left);
        visitTarget(target.right);
        break;
      case "bucket":
        visitTarget(target.input);
        break;
      case "window":
        visitTarget(target.collection);
        visitTarget(target.anchor);
        break;
      case "periods":
        visitTarget(target.collection);
        break;
      case "sequence":
        if (
          target.steps.some(
            (step) => step.kind === "entity-root" && step.entity === "event",
          ) &&
          audience === "public-share"
        ) {
          fail(
            "field_not_allowed",
            "filters",
            "Custom event filters are not allowed for this audience.",
          );
        }
        target.steps.forEach(visitTarget);
        break;
      case "adjacent":
        visitTarget(target.sequence);
        break;
      case "without":
        if (
          target.excluded.kind === "entity-root" &&
          target.excluded.entity === "event" &&
          audience === "public-share"
        ) {
          fail(
            "field_not_allowed",
            "filters",
            "Custom event filters are not allowed for this audience.",
          );
        }
        visitTarget(target.sequence);
        visitTarget(target.excluded);
        break;
      case "entity-root":
        if (target.entity === "event" && audience === "public-share") {
          fail(
            "field_not_allowed",
            "filters",
            "Custom event filters are not allowed for this audience.",
          );
        }
        break;
      default:
        break;
    }
  };
  const visit = (expression: FilterExpression | null): void => {
    if (!expression) return;
    if (expression.kind === "condition") {
      const field = advancedFieldForTarget(expression.target);
      if (field) assertFieldAudience(field, expression.operator);
      visitTarget(expression.target);
      return;
    }
    if (expression.kind === "not") return visit(expression.child);
    expression.children.forEach(visit);
  };
  visit(normalized.root);
}
