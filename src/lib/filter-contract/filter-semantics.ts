import { filterConditionEntity } from "./filter-registry";
import type { FilterRelationScope } from "./filter-types";
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
  FilterFieldDefinition,
  FilterFieldRegistry,
  FilterTargetExpression,
} from "./filters";
import { FilterValidationError, isLegacyFilterTarget } from "./filters";

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

function setValueType(value: unknown): FilterScalarType | null {
  return knownLiteralType(value);
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
  const values = Array.isArray(expression.value)
    ? expression.value
    : [expression.value];
  const firstValue = values[0];
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
  const setTypes = values.map(setValueType);
  const homogeneousSetType =
    setTypes.length > 0 &&
    setTypes[0] !== null &&
    setTypes.every((type) => type === setTypes[0])
      ? setTypes[0]
      : null;
  const narrowingExpectation =
    expression.operator === "in" || expression.operator === "notIn"
      ? homogeneousSetType
      : effectiveExpected;
  const narrowsPayloadType = [
    "eq",
    "neq",
    "in",
    "notIn",
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
    !isLegacyFilterTarget(expression.target) &&
    narrowsPayloadType &&
    narrowingExpectation &&
    !isDynamicScalar(narrowingExpectation)
  )
    narrowTarget(
      expression.target,
      narrowingExpectation,
      state.expectedTargetTypes,
    );

  const narrowed = state.expectedTargetTypes.get(expression.target);
  state.conditions.set(expression, {
    valueType,
    ...(narrowed ? { expectedType: narrowed } : {}),
    ...(temporalPredicate ? { temporalPredicate: true } : {}),
  });
}

type NativeEntity = "page" | "event" | "session" | "visitor" | "activity";
function fieldIdForTarget(target: FilterTargetExpression): string | undefined {
  if (target.kind === "field") return target.field;
  if (target.kind === "event-payload") return "event.payload";
  if (target.kind === "projection" && target.member === "payload")
    return "event.payload";
  if (target.kind !== "member") return undefined;
  const members: string[] = [];
  let current: FilterTargetExpression = target;
  while (current.kind === "member") {
    members.push(current.member);
    current = current.object;
  }
  if (current.kind === "entity-root")
    return `${current.entity}.${members.reverse().join(".")}`;
  if (
    current.kind === "context-root" &&
    ["geo", "client", "referrer", "utm", "user", "performance"].includes(
      current.context,
    )
  )
    return `${current.context}.${members.reverse().join(".")}`;
  return undefined;
}

function nativeEntityForTarget(
  target: FilterTargetExpression,
  registry: FilterFieldRegistry,
): {
  readonly entity: NativeEntity;
  readonly definition?: FilterFieldDefinition;
} {
  if (
    target.kind === "member" &&
    target.member === "time" &&
    target.object.kind === "context-root" &&
    target.object.context === "current"
  )
    return { entity: "activity" };
  if (target.kind === "member" && target.member === "time") {
    const parent = target.object;
    if (
      parent.kind === "entity-root" &&
      (parent.entity === "page" || parent.entity === "event")
    )
      return { entity: parent.entity };
  }
  const fieldId = fieldIdForTarget(target);
  const definition = fieldId ? registry.get(fieldId) : undefined;
  const entity = filterConditionEntity(definition);
  if (entity) return { entity, definition };
  if (target.kind === "event-payload") return { entity: "event", definition };
  if (target.kind === "member" && target.object.kind === "entity-root")
    return { entity: target.object.entity };
  if (target.kind === "projection") {
    const collection = target.collection;
    if (collection.kind === "entity-root") return { entity: collection.entity };
  }
  return { entity: "activity", definition };
}

function collectionEntity(
  target: FilterTargetExpression,
): NativeEntity | undefined {
  if (target.kind === "entity-root") return target.entity;
  if (target.kind === "selector") return collectionEntity(target.collection);
  if (target.kind === "member") return collectionEntity(target.object);
  if (target.kind === "projection") return collectionEntity(target.collection);
  if (target.kind === "reducer") return collectionEntity(target.input);
  if (target.kind === "window") return collectionEntity(target.collection);
  if (target.kind === "periods") return collectionEntity(target.collection);
  return undefined;
}

/** Rejects Page/Event sibling reads from a single-activity selector. */
export function validateFilterConditionDomains(
  document: FilterDocument,
  resolvedScope: FilterRelationScope,
  registry: FilterFieldRegistry,
): void {
  if (!document.root) return;

  const visitTarget = (
    target: FilterTargetExpression,
    domain: NativeEntity,
    strictActivityAnchor: boolean,
    path: string,
  ): void => {
    if (target.kind === "selector") {
      const entity = collectionEntity(target.collection);
      if (
        strictActivityAnchor &&
        (domain === "page" || domain === "event") &&
        (entity === "page" || entity === "event") &&
        entity !== domain
      )
        throw new FilterValidationError(
          "invalid_condition_entity_domain",
          `${path}.collection`,
          "Page and Event sibling selectors require a Session or Visitor anchor.",
        );
      const predicateDomain = entity ?? domain;
      visitExpression(
        target.predicate,
        predicateDomain,
        predicateDomain === "page" || predicateDomain === "event",
        `${path}.predicate`,
      );
      visitTarget(
        target.collection,
        domain,
        strictActivityAnchor,
        `${path}.collection`,
      );
      return;
    }
    switch (target.kind) {
      case "member":
        visitTarget(
          target.object,
          domain,
          strictActivityAnchor,
          `${path}.object`,
        );
        break;
      case "projection":
        visitTarget(
          target.collection,
          domain,
          strictActivityAnchor,
          `${path}.collection`,
        );
        break;
      case "reducer":
        visitTarget(
          target.input,
          domain,
          strictActivityAnchor,
          `${path}.input`,
        );
        break;
      case "arithmetic":
        visitTarget(target.left, domain, strictActivityAnchor, `${path}.left`);
        visitTarget(
          target.right,
          domain,
          strictActivityAnchor,
          `${path}.right`,
        );
        break;
      case "bucket":
        visitTarget(
          target.input,
          domain,
          strictActivityAnchor,
          `${path}.input`,
        );
        break;
      case "window":
        visitTarget(
          target.collection,
          domain,
          strictActivityAnchor,
          `${path}.collection`,
        );
        visitTarget(
          target.anchor,
          domain,
          strictActivityAnchor,
          `${path}.anchor`,
        );
        break;
      case "periods":
        visitTarget(
          target.collection,
          domain,
          strictActivityAnchor,
          `${path}.collection`,
        );
        break;
      case "sequence":
        target.steps.forEach((step, index) =>
          visitTarget(
            step,
            domain,
            strictActivityAnchor,
            `${path}.steps[${index}]`,
          ),
        );
        break;
      case "adjacent":
        visitTarget(
          target.sequence,
          domain,
          strictActivityAnchor,
          `${path}.sequence`,
        );
        break;
      case "without":
        visitTarget(
          target.sequence,
          domain,
          strictActivityAnchor,
          `${path}.sequence`,
        );
        visitTarget(
          target.excluded,
          domain,
          strictActivityAnchor,
          `${path}.excluded`,
        );
        break;
    }
  };

  const visitExpression = (
    expression: FilterExpression,
    domain: NativeEntity,
    strictActivityAnchor: boolean,
    path: string,
  ): void => {
    if (expression.kind === "condition") {
      if (strictActivityAnchor && (domain === "page" || domain === "event")) {
        const native = nativeEntityForTarget(expression.target, registry);
        const isSiblingField =
          (native.entity === "page" || native.entity === "event") &&
          native.entity !== domain;
        if (isSiblingField)
          throw new FilterValidationError(
            "invalid_condition_entity_domain",
            `${path}.target`,
            `${domain} selectors cannot read sibling ${native.entity} fields. Use a Session or Visitor selector.`,
          );
      }
      visitTarget(
        expression.target,
        domain,
        strictActivityAnchor,
        `${path}.target`,
      );
      if (
        expression.value &&
        typeof expression.value === "object" &&
        !Array.isArray(expression.value) &&
        "kind" in expression.value
      )
        visitTarget(
          expression.value as FilterTargetExpression,
          domain,
          strictActivityAnchor,
          `${path}.value`,
        );
      return;
    }
    if (expression.kind === "not") {
      visitExpression(
        expression.child,
        domain,
        strictActivityAnchor,
        `${path}.child`,
      );
      return;
    }
    expression.children.forEach((child, index) =>
      visitExpression(
        child,
        domain,
        strictActivityAnchor,
        `${path}.children[${index}]`,
      ),
    );
  };

  visitExpression(document.root, resolvedScope, false, "root");
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
