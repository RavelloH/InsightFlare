import type { QueryAudience } from "./types";

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

export type FilterTarget = FieldFilterTarget | EventPayloadFilterTarget;

export interface FilterCondition {
  readonly kind: "condition";
  readonly target: FilterTarget;
  readonly operator: FilterOperator;
  readonly value?: FilterValue | readonly FilterValue[];
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
  readonly audiences: ReadonlySet<QueryAudience>;
  /** Set-to-scalar reduction is only sound when the storage profile proves it. */
  readonly singletonSetEquivalent?: boolean;
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
  const { target, definition } = resolveTarget(input, registry, path);
  const operator = requireOperator(input.operator, `${path}.operator`);
  if (!definition.operators.has(operator)) {
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
  const count = (expression: FilterExpression | null): number => {
    if (!expression) return 0;
    if (expression.kind === "condition") return 1;
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
  audience: QueryAudience,
): void {
  const normalized = normalizeFilterDocument(document, registry);
  const visit = (expression: FilterExpression | null): void => {
    if (!expression) return;
    if (expression.kind === "condition") {
      const field =
        expression.target.kind === "field"
          ? expression.target.field
          : "event.payload";
      const definition = registry.get(field);
      if (!definition || !definition.audiences.has(audience)) {
        fail(
          "field_not_allowed",
          "filters",
          "Filter field is not allowed for this audience.",
        );
      }
      return;
    }
    if (expression.kind === "not") return visit(expression.child);
    expression.children.forEach(visit);
  };
  visit(normalized.root);
}
