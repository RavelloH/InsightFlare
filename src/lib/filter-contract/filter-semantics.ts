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
    case "context-intrinsic":
      if (target.intrinsic === "same")
        visitTarget(target.input, registry, state);
      break;
    case "occurrence-time":
      visitTarget(target.input, registry, state);
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

const ENTITY_NAMESPACES = new Set([
  "geo",
  "client",
  "referrer",
  "utm",
  "user",
  "performance",
]);

function entityCollection(target: FilterTargetExpression): string | undefined {
  if (target.kind === "entity-root") return target.entity;
  if (target.kind === "selector") return entityCollection(target.collection);
  if (
    target.kind === "reducer" &&
    ["first", "last", "nth"].includes(target.reducer)
  )
    return entityCollection(target.input);
  return undefined;
}

function eventPayloadCollection(target: FilterTargetExpression): boolean {
  if (target.kind === "entity-root") return target.entity === "event";
  return (
    target.kind === "selector" && eventPayloadCollection(target.collection)
  );
}

function isScopeTimeTarget(target: FilterTargetExpression): boolean {
  return (
    target.kind === "member" &&
    target.member === "time" &&
    target.object.kind === "context-root" &&
    target.object.context === "current"
  );
}

/**
 * The public member language is intentionally closed. This is the single
 * Semantic Analysis allow-list; the type checker and evaluators may implement
 * values for allowed members but cannot add new syntax implicitly.
 */
function validateMemberWhitelist(
  document: FilterDocument,
  registry: FilterFieldRegistry,
): void {
  const invalid = (path: string, member: string): never => {
    throw new FilterValidationError(
      "invalid_member",
      path,
      `Member '${member}' is not registered or structurally supported.`,
    );
  };

  const validateTarget = (
    target: FilterTargetExpression,
    path: string,
  ): void => {
    if (target.kind === "member") {
      const parts: string[] = [];
      let base: FilterTargetExpression = target;
      while (base.kind === "member") {
        parts.unshift(base.member);
        base = base.object;
      }
      if (base.kind === "context-root") {
        const allowed =
          parts.length === 1 &&
          base.context === "current" &&
          parts[0] === "time";
        if (!allowed) invalid(path, parts.join("."));
        return;
      }
      const entity = entityCollection(base);
      if (entity) {
        const memberPath = parts.join(".");
        // `event.payload` is a registered execution strategy, but its JSON
        // object is deliberately not a public member. Callers must project a
        // concrete path with event.payload(path).
        if (entity === "event" && memberPath === "payload")
          invalid(path, memberPath);
        const exact = registry.has(`${entity}.${memberPath}`);
        const namespaced =
          ENTITY_NAMESPACES.has(parts[0] ?? "") && registry.has(memberPath);
        if (!exact && !namespaced) invalid(path, memberPath);
      } else {
        invalid(path, parts.join("."));
      }
      validateTarget(base, `${path}.object`);
      return;
    }
    switch (target.kind) {
      case "event-payload":
      case "entity-root":
      case "context-root":
      case "duration":
      case "time-anchor":
        return;
      case "context-intrinsic":
        if (target.intrinsic === "same")
          validateTarget(target.input, `${path}.input`);
        return;
      case "occurrence-time":
        validateTarget(target.input, `${path}.input`);
        return;
      case "field":
        if (!registry.has(target.field)) invalid(path, target.field);
        return;
      case "selector":
        validateTarget(target.collection, `${path}.collection`);
        validateExpression(target.predicate, `${path}.predicate`);
        return;
      case "projection": {
        const source = entityCollection(target.collection);
        if (
          target.member !== "payload" ||
          !target.path ||
          source !== "event" ||
          !eventPayloadCollection(target.collection)
        )
          invalid(path, target.member);
        validateTarget(target.collection, `${path}.collection`);
        return;
      }
      case "reducer":
        validateTarget(target.input, `${path}.input`);
        return;
      case "arithmetic":
        validateTarget(target.left, `${path}.left`);
        validateTarget(target.right, `${path}.right`);
        return;
      case "bucket":
        validateTarget(target.input, `${path}.input`);
        return;
      case "window":
        validateTarget(target.collection, `${path}.collection`);
        validateTarget(target.anchor, `${path}.anchor`);
        return;
      case "periods":
        validateTarget(target.collection, `${path}.collection`);
        return;
      case "sequence":
        target.steps.forEach((step, index) =>
          validateTarget(step, `${path}.steps[${index}]`),
        );
        return;
      case "adjacent":
        validateTarget(target.sequence, `${path}.sequence`);
        return;
      case "without":
        validateTarget(target.sequence, `${path}.sequence`);
        validateTarget(target.excluded, `${path}.excluded`);
        return;
    }
  };

  const validateExpression = (
    expression: FilterExpression,
    path: string,
  ): void => {
    if (expression.kind === "condition") {
      validateTarget(expression.target, `${path}.target`);
      if (
        expression.value &&
        typeof expression.value === "object" &&
        !Array.isArray(expression.value) &&
        "kind" in expression.value
      )
        validateTarget(
          expression.value as FilterTargetExpression,
          `${path}.value`,
        );
      return;
    }
    if (expression.kind === "not") {
      validateExpression(expression.child, `${path}.child`);
      return;
    }
    expression.children.forEach((child, index) =>
      validateExpression(child, `${path}.children[${index}]`),
    );
  };

  if (document.root) validateExpression(document.root, "root");
}

function validateScopeTimePlacement(
  document: FilterDocument,
  scope?: FilterRelationScope,
): void {
  if (!document.root) return;
  const invalid = (path: string): never => {
    throw new FilterValidationError(
      "invalid_time_scope",
      path,
      "time is only allowed in the top-level AND domain for Session or Visitor scope.",
    );
  };

  const targetHasScopeTime = (target: FilterTargetExpression): boolean => {
    if (isScopeTimeTarget(target)) return true;
    switch (target.kind) {
      case "member":
        return targetHasScopeTime(target.object);
      case "context-intrinsic":
        return target.intrinsic === "same" && targetHasScopeTime(target.input);
      case "occurrence-time":
        return targetHasScopeTime(target.input);
      case "selector":
        return (
          targetHasScopeTime(target.collection) ||
          expressionHasScopeTime(target.predicate)
        );
      case "projection":
        return targetHasScopeTime(target.collection);
      case "reducer":
        return targetHasScopeTime(target.input);
      case "arithmetic":
        return (
          targetHasScopeTime(target.left) || targetHasScopeTime(target.right)
        );
      case "bucket":
        return targetHasScopeTime(target.input);
      case "window":
        return (
          targetHasScopeTime(target.collection) ||
          targetHasScopeTime(target.anchor)
        );
      case "periods":
        return targetHasScopeTime(target.collection);
      case "sequence":
        return target.steps.some(targetHasScopeTime);
      case "adjacent":
        return targetHasScopeTime(target.sequence);
      case "without":
        return (
          targetHasScopeTime(target.sequence) ||
          targetHasScopeTime(target.excluded)
        );
      default:
        return false;
    }
  };
  const expressionHasScopeTime = (expression: FilterExpression): boolean => {
    if (expression.kind === "condition")
      return (
        targetHasScopeTime(expression.target) ||
        Boolean(
          expression.value &&
          typeof expression.value === "object" &&
          !Array.isArray(expression.value) &&
          "kind" in expression.value &&
          targetHasScopeTime(expression.value as FilterTargetExpression),
        )
      );
    if (expression.kind === "not")
      return expressionHasScopeTime(expression.child);
    return expression.children.some(expressionHasScopeTime);
  };
  const visit = (
    expression: FilterExpression,
    path: string,
    topAnd: boolean,
  ): void => {
    if (expression.kind === "condition") {
      if (isScopeTimeTarget(expression.target)) {
        if (
          !topAnd ||
          (scope !== undefined && scope !== "session" && scope !== "visitor")
        )
          invalid(`${path}.target`);
        if (
          !["gt", "gte", "lt", "lte", "between"].includes(expression.operator)
        )
          invalid(`${path}.operator`);
        return;
      }
      if (
        targetHasScopeTime(expression.target) ||
        (expression.value &&
          typeof expression.value === "object" &&
          !Array.isArray(expression.value) &&
          "kind" in expression.value &&
          targetHasScopeTime(expression.value as FilterTargetExpression))
      )
        invalid(`${path}.target`);
      return;
    }
    if (expression.kind === "not") {
      visit(expression.child, `${path}.child`, false);
      return;
    }
    const allowChildren = topAnd && expression.kind === "and";
    expression.children.forEach((child, index) =>
      visit(child, `${path}.children[${index}]`, allowChildren),
    );
  };
  visit(document.root, "root", true);
}

interface ContextIntrinsicFrame {
  readonly sequences: readonly Extract<
    FilterTargetExpression,
    { readonly kind: "sequence" }
  >[];
  readonly periods: number;
}

function sequenceContextFor(
  target: FilterTargetExpression,
): Extract<FilterTargetExpression, { readonly kind: "sequence" }> | undefined {
  if (target.kind === "sequence") return target;
  if (target.kind === "adjacent") return sequenceContextFor(target.sequence);
  if (target.kind === "without") return sequenceContextFor(target.sequence);
  if (target.kind === "selector") return sequenceContextFor(target.collection);
  return undefined;
}

function hasPeriodContext(target: FilterTargetExpression): boolean {
  if (target.kind === "periods") return true;
  return target.kind === "selector" && hasPeriodContext(target.collection);
}

function validateContextIntrinsicScopes(
  document: FilterDocument,
  registry: FilterFieldRegistry,
): void {
  const failContext = (code: string, path: string, message: string): never => {
    throw new FilterValidationError(code, path, message);
  };
  const validateSameInput = (
    input: FilterTargetExpression,
    sequence: Extract<FilterTargetExpression, { readonly kind: "sequence" }>,
    path: string,
  ): void => {
    const inputType = inferFilterTargetType(input, registry);
    if (inputType.kind !== "scalar")
      failContext(
        "same_value_type_mismatch",
        path,
        "$same requires a registered scalar field or event.payload(path).",
      );

    const applicableEntity =
      input.kind === "event-payload"
        ? "event"
        : input.kind === "field"
          ? filterConditionEntity(registry.get(input.field))
          : undefined;
    if (!applicableEntity)
      failContext(
        "same_target_not_per_occurrence",
        path,
        "$same input must be a registered field or event.payload(path) evaluated on each occurrence.",
      );

    for (const [index, step] of sequence.steps.entries()) {
      const stepType = inferFilterTargetType(step, registry);
      if (stepType.kind !== "collection") continue;
      const stepEntity = stepType.entity;
      if (
        (applicableEntity === "activity" &&
          (stepEntity === "event" || stepEntity === "page")) ||
        applicableEntity === stepEntity
      )
        continue;
      failContext(
        "same_value_entity_mismatch",
        `${path}.steps[${index}]`,
        "$same input must be available on every sequence step occurrence.",
      );
    }
  };

  const visitTarget = (
    target: FilterTargetExpression,
    frame: ContextIntrinsicFrame,
    path: string,
  ): void => {
    if (target.kind === "context-intrinsic") {
      if (target.context === "sequence") {
        const sequence = frame.sequences.at(-1);
        if (!sequence)
          return failContext(
            "context_intrinsic_outside_sequence",
            path,
            `$${target.intrinsic} is only available inside a Sequence predicate.`,
          );
        if (target.intrinsic === "gap" && target.to > sequence.steps.length)
          failContext(
            "invalid_sequence_gap",
            path,
            "$gap indexes must refer to steps in the active Sequence.",
          );
        if (target.intrinsic === "same")
          validateSameInput(target.input, sequence, `${path}.input`);
        if (target.intrinsic === "same")
          visitTarget(target.input, frame, `${path}.input`);
        return;
      }
      if (frame.periods === 0)
        failContext(
          "context_intrinsic_outside_period",
          path,
          "$items is only available inside a Period predicate.",
        );
      return;
    }

    if (target.kind === "selector") {
      const sequence = sequenceContextFor(target.collection);
      const nestedFrame: ContextIntrinsicFrame = {
        sequences: sequence ? [...frame.sequences, sequence] : frame.sequences,
        periods: frame.periods + (hasPeriodContext(target.collection) ? 1 : 0),
      };
      visitExpression(target.predicate, nestedFrame, `${path}.predicate`);
      visitTarget(target.collection, frame, `${path}.collection`);
      return;
    }

    switch (target.kind) {
      case "member":
        visitTarget(target.object, frame, `${path}.object`);
        break;
      case "occurrence-time":
        visitTarget(target.input, frame, `${path}.input`);
        break;
      case "projection":
        visitTarget(target.collection, frame, `${path}.collection`);
        break;
      case "reducer":
        visitTarget(target.input, frame, `${path}.input`);
        break;
      case "arithmetic":
        visitTarget(target.left, frame, `${path}.left`);
        visitTarget(target.right, frame, `${path}.right`);
        break;
      case "bucket":
        visitTarget(target.input, frame, `${path}.input`);
        break;
      case "window":
        visitTarget(target.collection, frame, `${path}.collection`);
        visitTarget(target.anchor, frame, `${path}.anchor`);
        break;
      case "periods":
        visitTarget(target.collection, frame, `${path}.collection`);
        break;
      case "sequence":
        target.steps.forEach((step, index) =>
          visitTarget(step, frame, `${path}.steps[${index}]`),
        );
        break;
      case "adjacent":
        visitTarget(target.sequence, frame, `${path}.sequence`);
        break;
      case "without":
        visitTarget(target.sequence, frame, `${path}.sequence`);
        visitTarget(target.excluded, frame, `${path}.excluded`);
        break;
    }
  };

  const visitExpression = (
    expression: FilterExpression,
    frame: ContextIntrinsicFrame,
    path: string,
  ): void => {
    if (expression.kind === "condition") {
      visitTarget(expression.target, frame, `${path}.target`);
      if (
        expression.value &&
        typeof expression.value === "object" &&
        !Array.isArray(expression.value) &&
        "kind" in expression.value
      )
        visitTarget(
          expression.value as FilterTargetExpression,
          frame,
          `${path}.value`,
        );
      return;
    }
    if (expression.kind === "not") {
      visitExpression(expression.child, frame, `${path}.child`);
      return;
    }
    expression.children.forEach((child, index) =>
      visitExpression(child, frame, `${path}.children[${index}]`),
    );
  };

  if (document.root)
    visitExpression(document.root, { sequences: [], periods: 0 }, "root");
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
  if (target.kind === "occurrence-time") return { entity: "activity" };
  if (target.kind === "context-intrinsic" && target.intrinsic === "same")
    return nativeEntityForTarget(target.input, registry);
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
  validateScopeTimePlacement(document, resolvedScope);

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
      case "context-intrinsic":
        if (target.intrinsic === "same")
          visitTarget(
            target.input,
            domain,
            strictActivityAnchor,
            `${path}.input`,
          );
        break;
      case "occurrence-time":
        visitTarget(
          target.input,
          domain,
          strictActivityAnchor,
          `${path}.input`,
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
  validateMemberWhitelist(document, registry);
  validateScopeTimePlacement(document);
  validateFilterExpressionTypes(document, registry);
  validateContextIntrinsicScopes(document, registry);
  const state: AnalysisState = {
    targetTypes: new WeakMap(),
    expectedTargetTypes: new WeakMap(),
    conditions: new WeakMap(),
    relationTargets: new WeakSet(),
  };
  if (document.root) visitExpression(document.root, registry, state);
  return { document, ...state };
}
