import {
  TRAFFIC_CHANNEL_RULES,
  type TrafficChannelId,
  UTM_CHANNEL_MEDIUMS,
} from "@/lib/analytics/traffic-channel-rules";
import { BROWSER_ENGINE_BLINK_TOKENS } from "@/lib/browser-engine";
import {
  and,
  callFunction,
  caseWhen,
  castText,
  coalesce,
  concatText,
  constant,
  eq,
  type ExpressionResultType,
  filter,
  gt,
  gte,
  inList,
  inSubquery,
  isNotNull,
  isNull,
  jsonScalarArray,
  lt,
  lte,
  neq,
  not,
  or,
  param,
  type Predicate,
  project,
  scalar,
  type SqlExpression,
  sub,
  textLike,
  textPosition,
  textSubstring,
  trimSpaces,
} from "@/lib/db";
import { schema } from "@/lib/db/schema/generated";
import {
  analyticsFilterDefinition,
  analyticsFilterRegistry,
  type FilterCompilerStrategy,
  type RegisteredFilterField,
} from "@/lib/filter-contract/filter-registry";
import {
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterGroup,
  type FilterOperator,
  type FilterValue,
  legacyConditionValue,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

export const LEGACY_JSON_EACH_SET_THRESHOLD = 8;

type VisitColumnName = Extract<keyof typeof schema.visits.columns, string>;
type FactStrategy = Extract<FilterCompilerStrategy, `fact.${string}`>;
type TextExpression = SqlExpression<
  string | null,
  ExpressionResultType<"text", boolean>
>;
type NumericExpression = SqlExpression<
  number | null,
  ExpressionResultType<"integer" | "real" | "numeric", boolean>
>;

export interface LegacyScalarFilterContext {
  readonly visitColumns: Readonly<
    Partial<Record<VisitColumnName, SqlExpression>>
  >;
  readonly eventName?: SqlExpression;
  readonly facts?: Readonly<Partial<Record<FactStrategy, SqlExpression>>>;
}

export type LegacyScalarFilterLoweringErrorCode =
  | "unsupported_target"
  | "unsupported_strategy"
  | "unsupported_value"
  | "missing_dependency"
  | "invalid_expression";

export class LegacyScalarFilterLoweringError extends Error {
  readonly name = "LegacyScalarFilterLoweringError";

  constructor(
    readonly code: LegacyScalarFilterLoweringErrorCode,
    readonly location: string,
    message: string,
  ) {
    super(`${message} (${location})`);
  }
}

function unsupported(
  code: LegacyScalarFilterLoweringErrorCode,
  location: string,
  message: string,
): never {
  throw new LegacyScalarFilterLoweringError(code, location, message);
}

function isTextField(field: RegisteredFilterField): boolean {
  return (
    field.valueKind === "string" ||
    field.valueKind === "enum" ||
    field.valueKind === "date" ||
    field.valueKind === "datetime"
  );
}

function assertFieldExpression(
  field: RegisteredFilterField,
  expression: SqlExpression,
  location: string,
): void {
  const affinity = expression.resultType.affinity;
  const valid = isTextField(field)
    ? affinity === "text"
    : field.valueKind === "number"
      ? affinity === "integer" || affinity === "real" || affinity === "numeric"
      : field.valueKind === "boolean"
        ? affinity === "integer"
        : false;
  if (!valid) {
    unsupported(
      "invalid_expression",
      location,
      `The resolved expression for ${field.id} has incompatible ${affinity} affinity.`,
    );
  }
}

function fieldForCondition(
  condition: FilterCondition,
  location: string,
  mode: LegacyScalarValueMode = "row-scalar-v1",
): RegisteredFilterField {
  if (condition.target.kind !== "field") {
    unsupported(
      "unsupported_target",
      `${location}.target`,
      "Only registered scalar field targets are supported by legacy scalar lowering.",
    );
  }
  const field = analyticsFilterDefinition(condition.target.field);
  if (!field) {
    unsupported(
      "unsupported_target",
      `${location}.target.field`,
      `No registered filter field exists for ${condition.target.field}.`,
    );
  }
  const isSessionBoundary =
    field.profile === "session-boundary" ||
    field.compilerStrategy === "session.boundary.entry" ||
    field.compilerStrategy === "session.boundary.exit";
  if (
    (isSessionBoundary && mode !== "session-boundary-v1") ||
    (!isSessionBoundary && mode === "session-boundary-v1") ||
    field.compilerStrategy === "event.payload"
  ) {
    unsupported(
      "unsupported_target",
      `${location}.target.field`,
      `The ${field.id} target is outside the scalar lowering boundary.`,
    );
  }
  if (field.valueKind === "json-scalar") {
    unsupported(
      "unsupported_target",
      `${location}.target.field`,
      `The ${field.id} target requires event-payload lowering.`,
    );
  }
  if (
    mode === "entity-fact-v1" &&
    !field.compilerStrategy.startsWith("fact.")
  ) {
    unsupported(
      "unsupported_target",
      `${location}.target.field`,
      "Entity-fact value semantics require a registered fact field.",
    );
  }
  return field;
}

export type LegacyScalarValueMode =
  "row-scalar-v1" | "entity-fact-v1" | "session-boundary-v1";

function visitColumn(
  context: LegacyScalarFilterContext,
  name: string,
  location: string,
): SqlExpression {
  if (!Object.hasOwn(schema.visits.columns, name)) {
    unsupported(
      "unsupported_strategy",
      location,
      `The registry column strategy references unknown visit column ${name}.`,
    );
  }
  const expression = context.visitColumns[name as VisitColumnName];
  if (!expression) {
    unsupported(
      "missing_dependency",
      location,
      `The visit column ${name} was not supplied by the current scope.`,
    );
  }
  const expectedAffinity =
    schema.visits.columns[name as VisitColumnName].affinity;
  if (expression.resultType.affinity !== expectedAffinity) {
    unsupported(
      "unsupported_strategy",
      location,
      `The supplied ${name} expression has ${expression.resultType.affinity} affinity; the visits schema declares ${expectedAffinity}.`,
    );
  }
  return expression;
}

function requiredDerivedColumns<const Names extends readonly VisitColumnName[]>(
  context: LegacyScalarFilterContext,
  names: Names,
  location: string,
): Readonly<Record<Names[number], SqlExpression>> {
  const result: Partial<Record<VisitColumnName, SqlExpression>> = {};
  for (const name of names) result[name] = visitColumn(context, name, location);
  return result as Readonly<Record<Names[number], SqlExpression>>;
}

function resolveStrategy(
  strategy: FilterCompilerStrategy,
  context: LegacyScalarFilterContext,
  field: RegisteredFilterField,
  location: string,
): SqlExpression {
  if (strategy.startsWith("column.")) {
    return visitColumn(context, strategy.slice("column.".length), location);
  }
  if (strategy === "event.name") {
    if (!context.eventName) {
      unsupported(
        "missing_dependency",
        location,
        "The event-name expression was not supplied by the current scope.",
      );
    }
    return context.eventName;
  }
  if (strategy.startsWith("fact.")) {
    const expression = context.facts?.[strategy as FactStrategy];
    if (!expression) {
      unsupported(
        "missing_dependency",
        location,
        `The fact expression ${strategy} was not supplied by the current scope.`,
      );
    }
    return expression;
  }
  if (strategy === "derived.trafficChannel") {
    const columns = requiredDerivedColumns(
      context,
      ["referrer_host", "utm_source", "utm_medium", "utm_campaign"],
      location,
    );
    return trafficChannelExpression(columns);
  }
  if (strategy === "derived.browserEngine") {
    const columns = requiredDerivedColumns(
      context,
      ["browser", "os"],
      location,
    );
    return browserEngineExpression(columns.browser, columns.os);
  }
  if (strategy === "derived.osVersion") {
    const columns = requiredDerivedColumns(
      context,
      ["os", "os_version"],
      location,
    );
    return osVersionExpression(columns.os, columns.os_version);
  }
  if (strategy === "derived.screenSize") {
    const columns = requiredDerivedColumns(
      context,
      ["screen_width", "screen_height"],
      location,
    );
    return screenSizeExpression(columns.screen_width, columns.screen_height);
  }
  unsupported(
    "unsupported_strategy",
    location,
    `The ${field.id} strategy ${strategy} is not supported by scalar lowering.`,
  );
}

function requireTextExpression(expression: SqlExpression): TextExpression {
  if (expression.resultType.affinity !== "text") {
    throw new TypeError(
      "A text-derived filter dependency must have text affinity.",
    );
  }
  return expression as TextExpression;
}

function requireNumericExpression(
  expression: SqlExpression,
): NumericExpression {
  if (
    expression.resultType.affinity !== "integer" &&
    expression.resultType.affinity !== "real" &&
    expression.resultType.affinity !== "numeric"
  ) {
    throw new TypeError(
      "A numeric-derived filter dependency must have numeric affinity.",
    );
  }
  return expression as NumericExpression;
}

function trimCoalesceText(expression: SqlExpression): TextExpression {
  const result = coalesce(requireTextExpression(expression), constant(""));
  return trimSpaces(result) as TextExpression;
}

function lowerText(
  expression: SqlExpression,
  field: RegisteredFilterField,
): TextExpression {
  const trimmed = trimCoalesceText(expression);
  return field.comparison === "case-insensitive"
    ? callFunction("lower", trimmed)
    : trimmed;
}

function normalizedConditionValue(
  condition: FilterCondition,
  location: string,
): FilterValue | readonly FilterValue[] | undefined {
  try {
    return legacyConditionValue(condition.value);
  } catch {
    return unsupported(
      "unsupported_value",
      `${location}.value`,
      "This scalar lowerer only accepts legacy scalar condition values.",
    );
  }
}

function isFilterValueArray(
  value: FilterValue | readonly FilterValue[] | undefined,
): value is readonly FilterValue[] {
  return Array.isArray(value);
}

function storedStringValue(
  field: RegisteredFilterField,
  operator: FilterOperator,
  value: string,
): string {
  return field.profile === "direct-referrer" &&
    value === "__direct__" &&
    (operator === "eq" ||
      operator === "neq" ||
      operator === "in" ||
      operator === "notIn")
    ? ""
    : value;
}

function scalarValue(
  field: RegisteredFilterField,
  value: FilterValue,
  location: string,
  operator: FilterOperator = "eq",
): string | number {
  if (value === null) {
    return unsupported(
      "unsupported_value",
      location,
      "A non-null scalar value is required by this SQL predicate.",
    );
  }
  if (field.valueKind === "boolean") {
    if (typeof value !== "boolean") {
      return unsupported(
        "unsupported_value",
        location,
        "Boolean filter values must be boolean.",
      );
    }
    return value ? 1 : 0;
  }
  if (field.valueKind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return unsupported(
        "unsupported_value",
        location,
        "Numeric filter values must be finite numbers.",
      );
    }
    return value;
  }
  if (typeof value !== "string") {
    return unsupported(
      "unsupported_value",
      location,
      "Text filter values must be strings.",
    );
  }
  return storedStringValue(field, operator, value);
}

function textComparison(
  left: TextExpression,
  value: string,
  operator: "contains" | "startsWith" | "endsWith",
): Predicate {
  const right = param(value);
  if (operator === "contains") {
    return gt(textPosition(left, right), constant(0));
  }
  if (operator === "startsWith") {
    return eq(
      textSubstring(left, constant(1), callFunction("length", right)),
      right,
    );
  }
  const length = callFunction("length", right);
  return or(
    eq(length, constant(0)),
    eq(textSubstring(left, sub(constant(0), length)), right),
  );
}

function nativeSetValues(
  field: RegisteredFilterField,
  operator: FilterOperator,
  values: readonly FilterValue[],
  location: string,
): readonly (string | number)[] {
  return values.map((value, index) => {
    const converted = scalarValue(
      field,
      value,
      `${location}[${index}]`,
      operator,
    );
    return typeof converted === "string"
      ? storedStringValue(field, operator, converted)
      : converted;
  });
}

function jsonSetPredicate(
  expression: SqlExpression,
  field: RegisteredFilterField,
  operator: "in" | "notIn",
  values: readonly (string | number)[],
): Predicate {
  const membership = isTextField(field)
    ? inSubquery(
        requireTextExpression(expression),
        jsonScalarArray(
          "text",
          values.map((value, index) => {
            if (typeof value !== "string") {
              return unsupported(
                "unsupported_value",
                `condition.value[${index}]`,
                "Text set values must be strings.",
              );
            }
            return value;
          }),
        ),
      )
    : inSubquery(
        requireNumericExpression(expression),
        jsonScalarArray(
          "numeric",
          values.map((value, index) => {
            if (typeof value !== "number") {
              return unsupported(
                "unsupported_value",
                `condition.value[${index}]`,
                "Numeric set values must be numbers.",
              );
            }
            return value;
          }),
        ),
      );
  return operator === "in" ? membership : not(membership);
}

function compareScalar(
  left: SqlExpression,
  field: RegisteredFilterField,
  operator: FilterOperator,
  value: FilterValue | readonly FilterValue[] | undefined,
  location: string,
  mode: LegacyScalarValueMode = "row-scalar-v1",
): Predicate {
  const textField = isTextField(field);
  const normalized = textField ? lowerForField(left, field) : left;
  if (
    operator === "exists" ||
    operator === "notExists" ||
    operator === "isNull" ||
    operator === "notNull"
  ) {
    return operator === "exists" || operator === "notNull"
      ? isNotNull(left)
      : isNull(left);
  }
  if (operator === "isEmpty" || operator === "notEmpty") {
    const rawText = requireTextExpression(left);
    return operator === "isEmpty"
      ? and(isNotNull(rawText), eq(rawText, constant("")))
      : and(isNotNull(rawText), neq(rawText, constant("")));
  }
  if (operator === "in" || operator === "notIn") {
    if (!Array.isArray(value) || value.length === 0) {
      return unsupported(
        "unsupported_value",
        `${location}.value`,
        `${operator} requires a non-empty scalar list.`,
      );
    }
    const values = nativeSetValues(field, operator, value, `${location}.value`);
    if (
      mode !== "entity-fact-v1" &&
      values.length >= LEGACY_JSON_EACH_SET_THRESHOLD
    ) {
      return jsonSetPredicate(normalized, field, operator, values);
    }
    const membership = textField
      ? inList(
          requireTextExpression(normalized),
          values.map((value, index) => {
            if (typeof value !== "string") {
              return unsupported(
                "unsupported_value",
                `${location}.value[${index}]`,
                "Text set values must be strings.",
              );
            }
            return value;
          }),
        )
      : inList(
          requireNumericExpression(normalized),
          values.map((value, index) => {
            if (typeof value !== "number") {
              return unsupported(
                "unsupported_value",
                `${location}.value[${index}]`,
                "Numeric set values must be numbers.",
              );
            }
            return value;
          }),
        );
    return operator === "in" ? membership : not(membership);
  }
  if (operator === "between") {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      field.valueKind !== "number"
    ) {
      return unsupported(
        "unsupported_value",
        `${location}.value`,
        "between requires exactly two numeric endpoints.",
      );
    }
    const lowerBound = scalarValue(
      field,
      value[0]!,
      `${location}.value[0]`,
      operator,
    );
    const upperBound = scalarValue(
      field,
      value[1]!,
      `${location}.value[1]`,
      operator,
    );
    if (typeof lowerBound !== "number" || typeof upperBound !== "number") {
      return unsupported(
        "unsupported_value",
        `${location}.value`,
        "between requires numeric endpoints.",
      );
    }
    const numeric = requireNumericExpression(normalized);
    return and(
      gte(numeric, param(lowerBound)),
      lte(numeric, param(upperBound)),
    );
  }
  if (
    operator === "contains" ||
    operator === "startsWith" ||
    operator === "endsWith"
  ) {
    if (!isTextField(field) || typeof value !== "string") {
      return unsupported(
        "unsupported_value",
        `${location}.value`,
        `${operator} requires a text scalar.`,
      );
    }
    return textComparison(requireTextExpression(normalized), value, operator);
  }
  if (
    operator !== "eq" &&
    operator !== "neq" &&
    operator !== "gt" &&
    operator !== "gte" &&
    operator !== "lt" &&
    operator !== "lte"
  ) {
    return unsupported(
      "unsupported_value",
      `${location}.operator`,
      `The ${operator} operator is not supported by scalar lowering.`,
    );
  }
  if (isFilterValueArray(value) || value === undefined) {
    return unsupported(
      "unsupported_value",
      `${location}.value`,
      `${operator} requires one scalar value.`,
    );
  }
  const binding = scalarValue(field, value, `${location}.value`, operator);
  if (isTextField(field)) {
    if (typeof binding !== "string") {
      return unsupported(
        "unsupported_value",
        `${location}.value`,
        `${operator} requires a text value.`,
      );
    }
    const comparable = requireTextExpression(normalized);
    const right = param(binding);
    switch (operator) {
      case "eq":
        return eq(comparable, right);
      case "neq":
        return neq(comparable, right);
      case "gt":
        return gt(comparable, right);
      case "gte":
        return gte(comparable, right);
      case "lt":
        return lt(comparable, right);
      case "lte":
        return lte(comparable, right);
    }
  }
  if (typeof binding !== "number") {
    return unsupported(
      "unsupported_value",
      `${location}.value`,
      `${operator} requires a numeric value.`,
    );
  }
  const comparable = requireNumericExpression(normalized);
  const right = param(binding);
  switch (operator) {
    case "eq":
      return eq(comparable, right);
    case "neq":
      return neq(comparable, right);
    case "gt":
      return gt(comparable, right);
    case "gte":
      return gte(comparable, right);
    case "lt":
      return lt(comparable, right);
    case "lte":
      return lte(comparable, right);
  }
}

function lowerForField(
  expression: SqlExpression,
  field: RegisteredFilterField,
): SqlExpression {
  if (!isTextField(field)) return expression;
  return lowerText(expression, field);
}

/** Lower one normalized legacy scalar leaf. This helper never canonicalizes. */
export function lowerLegacyScalarFilterCondition(
  condition: FilterCondition,
  resolvedValue: SqlExpression,
): Predicate {
  return lowerLegacyScalarValueCondition(
    condition,
    resolvedValue,
    "row-scalar-v1",
  );
}

/** Resolve a registered legacy strategy and lower the leaf in one step. */
export function lowerLegacyScalarContextCondition(
  condition: FilterCondition,
  context: LegacyScalarFilterContext,
  mode: LegacyScalarValueMode = "row-scalar-v1",
): Predicate {
  const location =
    condition.target.kind === "field"
      ? condition.target.field
      : "condition.target";
  const { expression } = resolveConditionValue(
    condition,
    context,
    location,
    mode,
  );
  return lowerLegacyScalarValueCondition(condition, expression, mode);
}

/**
 * Compare one legacy Filter leaf against a typed expression while preserving
 * its explicit value-codec profile. Entity facts keep all sets native; row
 * scalar and session-boundary leaves retain the old threshold-eight codec.
 */
export function lowerLegacyScalarValueCondition(
  condition: FilterCondition,
  resolvedValue: SqlExpression,
  mode: LegacyScalarValueMode,
): Predicate {
  const location =
    condition.target.kind === "field"
      ? condition.target.field
      : "condition.target";
  const field = fieldForCondition(condition, location, mode);
  assertFieldExpression(field, resolvedValue, `${location}.target.field`);
  const value = normalizedConditionValue(condition, location);
  return compareScalar(
    resolvedValue,
    field,
    condition.operator,
    value,
    location,
    mode,
  );
}

function resolveConditionValue(
  condition: FilterCondition,
  context: LegacyScalarFilterContext,
  location: string,
  mode: LegacyScalarValueMode = "row-scalar-v1",
): {
  readonly field: RegisteredFilterField;
  readonly expression: SqlExpression;
} {
  const field = fieldForCondition(condition, location, mode);
  const strategy = field.compilerStrategy;
  const expression = resolveStrategy(
    strategy,
    context,
    field,
    `${location}.target.field`,
  );
  assertFieldExpression(field, expression, `${location}.target.field`);
  return { field, expression };
}

function textVectorMatch(
  left: TextExpression,
  right: TextExpression,
  operator: "contains" | "startsWith" | "endsWith",
): Predicate {
  const textLeft = left;
  const textRight = right;
  if (operator === "contains") {
    return gt(textPosition(textLeft, textRight), constant(0));
  }
  if (operator === "startsWith") {
    return eq(
      textSubstring(textLeft, constant(1), callFunction("length", textRight)),
      textRight,
    );
  }
  const length = callFunction("length", textRight);
  return or(
    eq(length, constant(0)),
    eq(textSubstring(textLeft, sub(constant(0), length)), textRight),
  );
}

function groupedTextVector(
  context: LegacyScalarFilterContext,
  conditions: readonly FilterCondition[],
  location: string,
): Predicate {
  const first = conditions[0]!;
  if (first.target.kind !== "field") {
    return unsupported(
      "invalid_expression",
      `${location}.children[0].target`,
      "A grouped text vector must target a registered field.",
    );
  }
  const firstField = first.target.field;
  const { field, expression } = resolveConditionValue(first, context, location);
  const values = conditions.map((condition, index) => {
    if (
      condition.target.kind !== "field" ||
      condition.target.field !== firstField ||
      condition.operator !== first.operator ||
      typeof condition.value !== "string"
    ) {
      return unsupported(
        "invalid_expression",
        `${location}.children[${index}]`,
        "A grouped text vector must contain one registered field and operator with string values.",
      );
    }
    return condition.value;
  });
  const rightRows = jsonScalarArray("text", values);
  const left = requireTextExpression(lowerForField(expression, field));
  const right = requireTextExpression(
    lowerForField(rightRows.columns.value, field),
  );
  const matchingRows = filter(
    rightRows,
    textVectorMatch(
      left,
      right,
      first.operator as "contains" | "startsWith" | "endsWith",
    ),
  );
  const oneMatch = project(matchingRows, { match: constant(1) });
  return isNotNull(scalar(oneMatch));
}

function isTextVectorCondition(
  expression: FilterExpression,
): expression is FilterCondition {
  if (
    expression.kind !== "condition" ||
    expression.target.kind !== "field" ||
    (expression.operator !== "contains" &&
      expression.operator !== "startsWith" &&
      expression.operator !== "endsWith") ||
    typeof expression.value !== "string"
  ) {
    return false;
  }
  const field = analyticsFilterDefinition(expression.target.field);
  return Boolean(
    field && isTextField(field) && field.profile !== "session-boundary",
  );
}

function lowerOrGroup(
  expression: FilterGroup & { readonly kind: "or" },
  context: LegacyScalarFilterContext,
  location: string,
): Predicate {
  const vectors = expression.children.map((child) =>
    isTextVectorCondition(child) ? child : undefined,
  );
  const groups = new Map<string, number[]>();
  for (const [index, vector] of vectors.entries()) {
    if (!vector || vector.target.kind !== "field") continue;
    const key = `${vector.target.field}\u0000${vector.operator}`;
    const indices = groups.get(key) ?? [];
    indices.push(index);
    groups.set(key, indices);
  }
  const groupedIndexes = new Set(
    [...groups.values()].flatMap((indices) =>
      indices.length > 1 ? indices.slice(1) : [],
    ),
  );
  const clauses: Predicate[] = [];
  for (const [index, child] of expression.children.entries()) {
    if (groupedIndexes.has(index)) continue;
    const vector = vectors[index];
    const indices =
      vector && vector.target.kind === "field"
        ? groups.get(`${vector.target.field}\u0000${vector.operator}`)
        : undefined;
    if (vector && indices && indices.length > 1) {
      clauses.push(
        groupedTextVector(
          context,
          indices.map((itemIndex) => vectors[itemIndex]!),
          `${location}.children`,
        ),
      );
    } else {
      clauses.push(
        lowerExpression(child, context, `${location}.children[${index}]`),
      );
    }
  }
  return clauses.slice(1).reduce((left, right) => or(left, right), clauses[0]!);
}

function lowerExpression(
  expression: FilterExpression,
  context: LegacyScalarFilterContext,
  location: string,
): Predicate {
  if (expression.kind === "condition") {
    const { field, expression: resolvedValue } = resolveConditionValue(
      expression,
      context,
      location,
    );
    try {
      return compareScalar(
        resolvedValue,
        field,
        expression.operator,
        normalizedConditionValue(expression, location),
        location,
      );
    } catch (error) {
      if (error instanceof LegacyScalarFilterLoweringError) throw error;
      return unsupported(
        "unsupported_value",
        `${location}.value`,
        error instanceof Error
          ? error.message
          : "Invalid legacy scalar condition.",
      );
    }
  }
  if (expression.kind === "not") {
    return not(lowerExpression(expression.child, context, `${location}.child`));
  }
  if (expression.kind === "or") {
    return lowerOrGroup(
      expression as FilterGroup & { readonly kind: "or" },
      context,
      location,
    );
  }
  const children = expression.children.map((child, index) =>
    lowerExpression(child, context, `${location}.children[${index}]`),
  );
  return children
    .slice(1)
    .reduce((left, right) => and(left, right), children[0]!);
}

/** Normalize once, then lower the complete legacy scalar document to Generic. */
export function lowerLegacyScalarFilterDocument(
  document: FilterDocument,
  context: LegacyScalarFilterContext,
): Predicate | undefined {
  const normalized = normalizeFilterDocument(document, analyticsFilterRegistry);
  if (normalized.root === null) return undefined;
  return lowerExpression(normalized.root, context, "root");
}

function textEquals(expression: TextExpression, value: string): Predicate {
  return eq(expression, constant(value));
}

function textContainsPattern(
  expression: TextExpression,
  value: string,
): Predicate {
  return textLike(expression, constant(`%${value}%`));
}

function normalizeRuleText(expression: SqlExpression): TextExpression {
  return callFunction("lower", trimCoalesceText(expression)) as TextExpression;
}

function domainMatch(
  host: TextExpression,
  domains: readonly string[],
): Predicate {
  const predicates = domains.flatMap((domain) => [
    textEquals(host, domain),
    textLike(host, constant(`%.${domain}`)),
  ]);
  return predicates
    .slice(1)
    .reduce((left, right) => or(left, right), predicates[0]!);
}

function trafficChannelExpression(
  columns: Readonly<
    Record<
      "referrer_host" | "utm_source" | "utm_medium" | "utm_campaign",
      SqlExpression
    >
  >,
): SqlExpression {
  const referrerHost = normalizeRuleText(columns.referrer_host);
  const utmSource = normalizeRuleText(columns.utm_source);
  const utmMedium = normalizeRuleText(columns.utm_medium);
  const utmCampaign = normalizeRuleText(columns.utm_campaign);
  const isUntagged = and(
    textEquals(utmSource, ""),
    textEquals(utmMedium, ""),
    textEquals(utmCampaign, ""),
  );
  const organic = and(
    isUntagged,
    domainMatch(
      referrerHost,
      TRAFFIC_CHANNEL_RULES.organic_search.referrerDomains,
    ),
  );
  const social = and(
    isUntagged,
    domainMatch(referrerHost, TRAFFIC_CHANNEL_RULES.social.referrerDomains),
  );
  const mediumBranches = (
    Object.entries(UTM_CHANNEL_MEDIUMS) as Array<
      [
        Exclude<
          TrafficChannelId,
          "organic_search" | "social" | "direct" | "referral" | "campaign"
        >,
        readonly string[],
      ]
    >
  ).map(([channel, values]) => ({
    when: values
      .map((value) => textEquals(utmMedium, value))
      .slice(1)
      .reduce(
        (left, right) => or(left, right),
        textEquals(utmMedium, values[0]!),
      ),
    then: constant(channel),
  }));
  const tagged = or(
    neq(utmSource, constant("")),
    neq(utmMedium, constant("")),
    neq(utmCampaign, constant("")),
  );
  return caseWhen(
    [
      { when: organic, then: constant("organic_search") },
      { when: social, then: constant("social") },
      ...mediumBranches,
      { when: tagged, then: constant("campaign") },
      { when: neq(referrerHost, constant("")), then: constant("referral") },
      {
        when: and(isUntagged, textEquals(referrerHost, "")),
        then: constant("direct"),
      },
    ],
    constant("other"),
  );
}

function browserEngineExpression(
  browser: SqlExpression,
  os: SqlExpression,
): SqlExpression {
  const normalizedBrowser = normalizeRuleText(browser);
  const normalizedOs = normalizeRuleText(os);
  const includes = (value: TextExpression, token: string) =>
    textContainsPattern(value, token);
  const blink = BROWSER_ENGINE_BLINK_TOKENS.map((token) =>
    includes(normalizedBrowser, token),
  )
    .slice(1)
    .reduce(
      (left, right) => or(left, right),
      includes(normalizedBrowser, BROWSER_ENGINE_BLINK_TOKENS[0]!),
    );
  return caseWhen(
    [
      { when: textEquals(normalizedBrowser, ""), then: constant("") },
      {
        when: or(
          includes(normalizedBrowser, "internet explorer"),
          textEquals(normalizedBrowser, "ie"),
          includes(normalizedBrowser, "trident"),
        ),
        then: constant("Trident"),
      },
      { when: includes(normalizedOs, "ios"), then: constant("WebKit") },
      {
        when: or(
          includes(normalizedBrowser, "opera mini"),
          includes(normalizedBrowser, "presto"),
        ),
        then: constant("Presto"),
      },
      {
        when: or(
          includes(normalizedBrowser, "firefox"),
          includes(normalizedBrowser, "gecko"),
        ),
        then: constant("Gecko"),
      },
      { when: blink, then: constant("Blink") },
      {
        when: or(
          includes(normalizedBrowser, "safari"),
          includes(normalizedBrowser, "webkit"),
        ),
        then: constant("WebKit"),
      },
    ],
    constant(""),
  );
}

function osVersionExpression(
  os: SqlExpression,
  version: SqlExpression,
): SqlExpression {
  const hasOs = neq(requireTextExpression(os), constant(""));
  const hasVersion = neq(requireTextExpression(version), constant(""));
  const combined = coalesce(
    concatText(
      requireTextExpression(os),
      constant(" "),
      requireTextExpression(version),
    ),
    constant(""),
  );
  return trimSpaces(
    caseWhen(
      [
        { when: and(hasOs, hasVersion), then: combined },
        {
          when: hasOs,
          then: coalesce(requireTextExpression(os), constant("")),
        },
        {
          when: hasVersion,
          then: coalesce(requireTextExpression(version), constant("")),
        },
      ],
      constant(""),
    ),
  );
}

function screenSizeExpression(
  width: SqlExpression,
  height: SqlExpression,
): SqlExpression {
  const bothPresent = and(isNotNull(width), isNotNull(height));
  const size = coalesce(
    concatText(
      castText(requireNumericExpression(width)),
      constant("x"),
      castText(requireNumericExpression(height)),
    ),
    constant(""),
  );
  return caseWhen([{ when: bothPresent, then: size }], constant(""));
}
