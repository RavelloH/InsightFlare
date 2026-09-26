import {
  type FilterScalarType,
  type FilterSemanticValueType,
  inferFilterTargetType,
  validateFilterExpressionTypes,
} from "./filter-types";
import type {
  FilterCondition,
  FilterDocument,
  FilterExpression,
  FilterFieldRegistry,
  FilterTargetExpression,
} from "./filters";

export interface FilterConditionSemantics {
  readonly valueType: FilterSemanticValueType;
  readonly expectedType?: FilterScalarType;
  readonly temporalPredicate?: boolean;
}

/** Typed sidecar for a canonical FilterDocument; the public AST stays v1. */
export interface AnalyzedFilterDocument {
  readonly document: FilterDocument;
  readonly targetTypes: WeakMap<
    FilterTargetExpression,
    FilterSemanticValueType
  >;
  readonly expectedTargetTypes: WeakMap<
    FilterTargetExpression,
    FilterScalarType
  >;
  readonly conditions: WeakMap<FilterCondition, FilterConditionSemantics>;
  /** Targets that introduce an ordered activity relation timeline. */
  readonly relationTargets: WeakSet<FilterTargetExpression>;
}

interface AnalysisState {
  readonly targetTypes: WeakMap<
    FilterTargetExpression,
    FilterSemanticValueType
  >;
  readonly expectedTargetTypes: WeakMap<
    FilterTargetExpression,
    FilterScalarType
  >;
  readonly conditions: WeakMap<FilterCondition, FilterConditionSemantics>;
  readonly relationTargets: WeakSet<FilterTargetExpression>;
}

function scalarType(type: FilterSemanticValueType): FilterScalarType | null {
  const value = type.kind === "collection" ? type.item : type;
  return value.kind === "scalar" ? value.scalar : null;
}

function knownLiteralType(value: unknown): FilterScalarType | null {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return typeof value === "string" ? "string" : null;
}

function isDynamicScalar(type: FilterScalarType): boolean {
  return type === "json-scalar" || type === "unknown";
}

function visitTarget(
  target: FilterTargetExpression,
  registry: FilterFieldRegistry,
  state: AnalysisState,
): void {
  state.targetTypes.set(target, inferFilterTargetType(target, registry));
  switch (target.kind) {
    case "member":
      visitTarget(target.object, registry, state);
      break;
    case "selector":
      visitTarget(target.collection, registry, state);
      visitExpression(target.predicate, registry, state);
      break;
    case "projection":
      visitTarget(target.collection, registry, state);
      break;
    case "reducer":
      visitTarget(target.input, registry, state);
      break;
    case "arithmetic":
      visitTarget(target.left, registry, state);
      visitTarget(target.right, registry, state);
      break;
    case "bucket":
      visitTarget(target.input, registry, state);
      break;
    case "window":
      visitTarget(target.collection, registry, state);
      visitTarget(target.anchor, registry, state);
      break;
    case "periods":
      visitTarget(target.collection, registry, state);
      break;
    case "sequence":
      state.relationTargets.add(target);
      target.steps.forEach((step) => visitTarget(step, registry, state));
      break;
    case "adjacent":
      state.relationTargets.add(target);
      visitTarget(target.sequence, registry, state);
      break;
    case "without":
      state.relationTargets.add(target);
      visitTarget(target.sequence, registry, state);
      visitTarget(target.excluded, registry, state);
      break;
  }
}

function visitExpression(
  expression: FilterExpression,
  registry: FilterFieldRegistry,
  state: AnalysisState,
): void {
  if (expression.kind === "not") {
    visitExpression(expression.child, registry, state);
    return;
  }
  if (expression.kind === "and" || expression.kind === "or") {
    expression.children.forEach((child) =>
      visitExpression(child, registry, state),
    );
    return;
  }
  if (expression.kind !== "condition") return;

  visitTarget(expression.target, registry, state);
  const temporalPredicate =
    expression.target.kind === "member" &&
    expression.target.member === "time" &&
    expression.target.object.kind === "context-root" &&
    expression.target.object.context === "current";
  const valueType = state.targetTypes.get(expression.target)!;
  const leftType = scalarType(valueType);
  const firstValue = Array.isArray(expression.value)
    ? expression.value[0]
    : expression.value;
  const expected =
    firstValue &&
    typeof firstValue === "object" &&
    !Array.isArray(firstValue) &&
    "kind" in firstValue
      ? scalarType(inferFilterTargetType(firstValue, registry))
      : knownLiteralType(firstValue);
  const effectiveExpected =
    leftType &&
    isDynamicScalar(leftType) &&
    expected &&
    !isDynamicScalar(expected)
      ? expected
      : leftType;
  const narrowsPayloadType = [
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "contains",
    "startsWith",
    "endsWith",
  ].includes(expression.operator);
  if (
    narrowsPayloadType &&
    effectiveExpected &&
    !isDynamicScalar(effectiveExpected)
  )
    narrowTarget(
      expression.target,
      effectiveExpected,
      state.expectedTargetTypes,
    );

  const narrowed = state.expectedTargetTypes.get(expression.target);
  state.conditions.set(expression, {
    valueType,
    ...(narrowed ? { expectedType: narrowed } : {}),
    ...(temporalPredicate ? { temporalPredicate: true } : {}),
  });
}

function narrowTarget(
  target: FilterTargetExpression,
  expected: FilterScalarType,
  expectedTargetTypes: WeakMap<FilterTargetExpression, FilterScalarType>,
): void {
  if (isDynamicScalar(expected) || expected === "calendar-period") return;
  expectedTargetTypes.set(target, expected);
  if (target.kind === "event-payload") return;
  if (target.kind === "projection" && target.member === "payload") return;
  if (target.kind === "reducer") {
    if (target.reducer === "sum" || target.reducer === "avg") {
      narrowTarget(target.input, "number", expectedTargetTypes);
      return;
    }
    if (["min", "max", "first", "last", "nth"].includes(target.reducer))
      narrowTarget(target.input, expected, expectedTargetTypes);
    return;
  }
  if (target.kind === "arithmetic") {
    const operandType =
      target.operator === "sub" && expected === "duration"
        ? "datetime"
        : "number";
    narrowTarget(target.left, operandType, expectedTargetTypes);
    narrowTarget(target.right, operandType, expectedTargetTypes);
    return;
  }
  if (target.kind === "selector") {
    narrowTarget(target.collection, expected, expectedTargetTypes);
    return;
  }
  if (target.kind === "member") {
    const parent = target.object;
    if (
      parent.kind === "entity-root" &&
      parent.entity === "event" &&
      target.member === "payload"
    )
      expectedTargetTypes.set(target, expected);
  }
}

export function analyzeFilterDocument(
  document: FilterDocument,
  registry: FilterFieldRegistry,
): AnalyzedFilterDocument {
  validateFilterExpressionTypes(document, registry);
  const state: AnalysisState = {
    targetTypes: new WeakMap(),
    expectedTargetTypes: new WeakMap(),
    conditions: new WeakMap(),
    relationTargets: new WeakSet(),
  };
  if (document.root) visitExpression(document.root, registry, state);
  return { document, ...state };
}
