import {
  analyticsFilterRegistry,
  FILTER_OPERATOR_IDS,
  type FilterCondition,
  type FilterContextIntrinsicTarget,
  type FilterDurationTarget,
  type FilterExpression,
  type FilterOccurrenceTimeTarget,
  type FilterOperator,
  type FilterSequenceTarget,
  type FilterTargetExpression,
  type FilterValueKind,
} from "@/lib/filter-contract";
import type { FilterPickerTargetSelection } from "@/lib/filter-contract/filter-picker-registry";

import { allowedFields } from "./field-catalog";
import type {
  AdvancedFilterTargetKind,
  FilterPanelAudience,
  FilterTargetEditorKind,
} from "./model";

const DATETIME_OPERATORS: readonly FilterOperator[] = [
  "eq",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
];

export function createDefaultFilterTarget(
  kind: FilterTargetEditorKind,
  audience: FilterPanelAudience,
): FilterTargetExpression {
  const firstField =
    allowedFields(audience).find((field) => field.id === "page.path")?.id ??
    "page.path";
  const relationEntity = analyticsFilterRegistry
    .get("event.name")
    ?.audiences.has(audience)
    ? "event"
    : "page";
  const relationField = relationEntity === "event" ? "event.name" : "page.path";
  const firstActivityCondition: FilterExpression = {
    kind: "condition",
    target: { kind: "field", field: relationField as never },
    operator: relationEntity === "event" ? "eq" : "exists",
    ...(relationEntity === "event" ? { value: "signup" } : {}),
  };
  const eventNameCondition: FilterExpression = {
    kind: "condition",
    target: { kind: "field", field: relationField as never },
    operator: relationEntity === "event" ? "eq" : "exists",
    ...(relationEntity === "event" ? { value: "signup" } : {}),
  };
  const eventSelector: FilterTargetExpression = {
    kind: "selector",
    collection: { kind: "entity-root", entity: relationEntity },
    predicate: eventNameCondition,
  };
  const defaultSequence: FilterTargetExpression = {
    kind: "sequence",
    steps: [
      eventSelector,
      {
        kind: "selector",
        collection: { kind: "entity-root", entity: relationEntity },
        predicate: {
          kind: "condition",
          target: { kind: "field", field: relationField as never },
          operator: relationEntity === "event" ? "eq" : "exists",
          ...(relationEntity === "event" ? { value: "purchase" } : {}),
        },
      },
    ],
  };
  const oneDay: FilterDurationTarget = {
    kind: "duration",
    amount: 1,
    unit: "d",
  };
  switch (kind) {
    case "time":
      return {
        kind: "member",
        object: { kind: "context-root", context: "current" },
        member: "time",
      };
    case "field":
      return { kind, field: firstField as never };
    case "event-payload":
      return { kind, path: "/value" as never };
    case "entity-root":
      return { kind, entity: relationEntity };
    case "context-root":
      return { kind, context: "current" };
    case "context-intrinsic":
      return {
        kind,
        context: "sequence",
        intrinsic: "span",
      };
    case "sequence-span":
      return {
        kind: "context-intrinsic",
        context: "sequence",
        intrinsic: "span",
      };
    case "sequence-gap":
      return {
        kind: "context-intrinsic",
        context: "sequence",
        intrinsic: "gap",
        from: 1,
        to: 2,
      };
    case "sequence-same":
      return {
        kind: "context-intrinsic",
        context: "sequence",
        intrinsic: "same",
        input: { kind: "event-payload", path: "/productId" as never },
      };
    case "period-items":
      return {
        kind: "context-intrinsic",
        context: "period",
        intrinsic: "items",
      };
    case "occurrence-time":
      return {
        kind,
        input: {
          kind: "reducer",
          reducer: "first",
          input: { kind: "entity-root", entity: "event" },
        },
      };
    case "member":
      return {
        kind,
        object: { kind: "entity-root", entity: "page" },
        member: "path",
      };
    case "selector":
      return {
        kind,
        collection: { kind: "entity-root", entity: relationEntity },
        predicate: eventNameCondition,
      };
    case "projection":
      return {
        kind,
        collection: { kind: "entity-root", entity: "page" },
        member: "path",
      };
    case "reducer":
      return {
        kind,
        reducer: "count",
        input: { kind: "entity-root", entity: relationEntity },
      };
    case "arithmetic":
      return {
        kind,
        operator: "add",
        left: { kind: "field", field: "page.durationMs" as never },
        right: { kind: "field", field: "page.durationMs" as never },
      };
    case "duration":
      return oneDay;
    case "time-anchor":
      return { kind, anchor: "now" };
    case "bucket":
      return {
        kind,
        input: { kind: "entity-root", entity: "event" },
        interval: { kind: "duration", amount: 1, unit: "h" },
      };
    case "window":
      return {
        kind,
        collection: { kind: "entity-root", entity: "page" },
        anchor: { kind: "time-anchor", anchor: "range.start" },
        startOffset: { kind: "duration", amount: -1, unit: "d" },
        endOffset: { kind: "duration", amount: 0, unit: "d" },
      };
    case "periods":
      return {
        kind,
        collection: { kind: "entity-root", entity: "page" },
        interval: oneDay,
      };
    case "sequence":
      return defaultSequence;
    case "adjacent":
      return { kind, sequence: defaultSequence };
    case "without":
      return {
        kind,
        sequence: defaultSequence,
        excluded: {
          kind: "selector",
          collection: { kind: "entity-root", entity: relationEntity },
          predicate: firstActivityCondition,
        },
      };
  }
}

function rootEntity(target: FilterTargetExpression): string | undefined {
  if (target.kind === "entity-root") return target.entity;
  if (target.kind === "selector") return rootEntity(target.collection);
  if (target.kind === "projection") return rootEntity(target.collection);
  if (target.kind === "reducer") return rootEntity(target.input);
  if (target.kind === "member") return rootEntity(target.object);
  return undefined;
}

export interface ContextIntrinsicLocation {
  readonly target: FilterContextIntrinsicTarget;
  readonly sequence?: FilterSequenceTarget;
}

function sequenceContextForTarget(
  target: FilterTargetExpression,
): FilterSequenceTarget | undefined {
  if (target.kind === "sequence") return target;
  if (target.kind === "adjacent")
    return sequenceContextForTarget(target.sequence);
  if (target.kind === "without")
    return sequenceContextForTarget(target.sequence);
  if (target.kind === "selector")
    return sequenceContextForTarget(target.collection);
  return undefined;
}

export function findContextIntrinsic(
  target: FilterTargetExpression,
): ContextIntrinsicLocation | undefined {
  const visitExpression = (
    expression: FilterExpression,
    sequences: readonly FilterSequenceTarget[],
  ): ContextIntrinsicLocation | undefined => {
    if (expression.kind === "condition")
      return (
        visitTarget(expression.target, sequences) ??
        (expression.value &&
        typeof expression.value === "object" &&
        !Array.isArray(expression.value) &&
        "kind" in expression.value
          ? visitTarget(expression.value as FilterTargetExpression, sequences)
          : undefined)
      );
    if (expression.kind === "not")
      return visitExpression(expression.child, sequences);
    for (const child of expression.children) {
      const found = visitExpression(child, sequences);
      if (found) return found;
    }
    return undefined;
  };

  const visitTarget = (
    current: FilterTargetExpression,
    sequences: readonly FilterSequenceTarget[],
  ): ContextIntrinsicLocation | undefined => {
    if (current.kind === "context-intrinsic")
      return {
        target: current,
        ...(current.context === "sequence" && sequences.length
          ? { sequence: sequences.at(-1) }
          : {}),
      };
    if (current.kind === "selector") {
      const sequence = sequenceContextForTarget(current.collection);
      const nestedSequences = sequence ? [...sequences, sequence] : sequences;
      return (
        visitExpression(current.predicate, nestedSequences) ??
        visitTarget(current.collection, sequences)
      );
    }
    switch (current.kind) {
      case "member":
        return visitTarget(current.object, sequences);
      case "occurrence-time":
        return visitTarget(current.input, sequences);
      case "projection":
        return visitTarget(current.collection, sequences);
      case "reducer":
        return visitTarget(current.input, sequences);
      case "arithmetic":
        return (
          visitTarget(current.left, sequences) ??
          visitTarget(current.right, sequences)
        );
      case "bucket":
        return visitTarget(current.input, sequences);
      case "window":
        return (
          visitTarget(current.collection, sequences) ??
          visitTarget(current.anchor, sequences)
        );
      case "periods":
        return visitTarget(current.collection, sequences);
      case "sequence":
        for (const step of current.steps) {
          const found = visitTarget(step, sequences);
          if (found) return found;
        }
        return undefined;
      case "adjacent":
        return visitTarget(current.sequence, sequences);
      case "without":
        return (
          visitTarget(current.sequence, sequences) ??
          visitTarget(current.excluded, sequences)
        );
      default:
        return undefined;
    }
  };

  return visitTarget(target, []);
}

export function findOccurrenceTimeTarget(
  target: FilterTargetExpression,
): FilterOccurrenceTimeTarget | undefined {
  if (target.kind === "occurrence-time") return target;
  switch (target.kind) {
    case "member":
      return findOccurrenceTimeTarget(target.object);
    case "context-intrinsic":
      return target.intrinsic === "same"
        ? findOccurrenceTimeTarget(target.input)
        : undefined;
    case "selector":
      return (
        findOccurrenceTimeInExpression(target.predicate) ??
        findOccurrenceTimeTarget(target.collection)
      );
    case "projection":
      return findOccurrenceTimeTarget(target.collection);
    case "reducer":
      return findOccurrenceTimeTarget(target.input);
    case "arithmetic":
      return (
        findOccurrenceTimeTarget(target.left) ??
        findOccurrenceTimeTarget(target.right)
      );
    case "bucket":
      return findOccurrenceTimeTarget(target.input);
    case "window":
      return (
        findOccurrenceTimeTarget(target.collection) ??
        findOccurrenceTimeTarget(target.anchor)
      );
    case "periods":
      return findOccurrenceTimeTarget(target.collection);
    case "sequence":
      for (const step of target.steps) {
        const found = findOccurrenceTimeTarget(step);
        if (found) return found;
      }
      return undefined;
    case "adjacent":
      return findOccurrenceTimeTarget(target.sequence);
    case "without":
      return (
        findOccurrenceTimeTarget(target.sequence) ??
        findOccurrenceTimeTarget(target.excluded)
      );
    default:
      return undefined;
  }
}

function findOccurrenceTimeInExpression(
  expression: FilterExpression,
): FilterOccurrenceTimeTarget | undefined {
  if (expression.kind === "condition")
    return (
      findOccurrenceTimeTarget(expression.target) ??
      (expression.value &&
      typeof expression.value === "object" &&
      !Array.isArray(expression.value) &&
      "kind" in expression.value
        ? findOccurrenceTimeTarget(expression.value as FilterTargetExpression)
        : undefined)
    );
  if (expression.kind === "not")
    return findOccurrenceTimeInExpression(expression.child);
  for (const child of expression.children) {
    const found = findOccurrenceTimeInExpression(child);
    if (found) return found;
  }
  return undefined;
}

export function replaceTargetReference(
  expression: FilterExpression,
  search: FilterTargetExpression,
  replacement: FilterTargetExpression,
): FilterExpression {
  const visitTarget = (
    target: FilterTargetExpression,
  ): FilterTargetExpression => {
    if (target === search) return replacement;
    switch (target.kind) {
      case "member":
        return { ...target, object: visitTarget(target.object) };
      case "context-intrinsic":
        return target.intrinsic === "same"
          ? { ...target, input: visitTarget(target.input) }
          : target;
      case "occurrence-time":
        return { ...target, input: visitTarget(target.input) };
      case "selector":
        return {
          ...target,
          collection: visitTarget(target.collection),
          predicate: visitExpression(target.predicate),
        };
      case "projection":
        return { ...target, collection: visitTarget(target.collection) };
      case "reducer":
        return { ...target, input: visitTarget(target.input) };
      case "arithmetic":
        return {
          ...target,
          left: visitTarget(target.left),
          right: visitTarget(target.right),
        };
      case "bucket":
        return { ...target, input: visitTarget(target.input) };
      case "window":
        return {
          ...target,
          collection: visitTarget(target.collection),
          anchor: visitTarget(target.anchor),
        };
      case "periods":
        return { ...target, collection: visitTarget(target.collection) };
      case "sequence":
        return { ...target, steps: target.steps.map(visitTarget) };
      case "adjacent":
        return { ...target, sequence: visitTarget(target.sequence) };
      case "without":
        return {
          ...target,
          sequence: visitTarget(target.sequence),
          excluded: visitTarget(target.excluded),
        };
      default:
        return target;
    }
  };
  const visitExpression = (node: FilterExpression): FilterExpression => {
    if (node.kind === "condition")
      return {
        ...node,
        target: visitTarget(node.target),
      };
    if (node.kind === "not")
      return { ...node, child: visitExpression(node.child) };
    return { ...node, children: node.children.map(visitExpression) };
  };
  return visitExpression(expression);
}

export function updateConditionWhere(
  expression: FilterExpression,
  predicate: (condition: FilterCondition) => boolean,
  update: (condition: FilterCondition) => FilterCondition,
): FilterExpression {
  const visitTarget = (
    target: FilterTargetExpression,
  ): FilterTargetExpression => {
    switch (target.kind) {
      case "member":
        return { ...target, object: visitTarget(target.object) };
      case "context-intrinsic":
        return target.intrinsic === "same"
          ? { ...target, input: visitTarget(target.input) }
          : target;
      case "occurrence-time":
        return { ...target, input: visitTarget(target.input) };
      case "selector":
        return {
          ...target,
          collection: visitTarget(target.collection),
          predicate: visitExpression(target.predicate),
        };
      case "projection":
        return { ...target, collection: visitTarget(target.collection) };
      case "reducer":
        return { ...target, input: visitTarget(target.input) };
      case "arithmetic":
        return {
          ...target,
          left: visitTarget(target.left),
          right: visitTarget(target.right),
        };
      case "bucket":
        return { ...target, input: visitTarget(target.input) };
      case "window":
        return {
          ...target,
          collection: visitTarget(target.collection),
          anchor: visitTarget(target.anchor),
        };
      case "periods":
        return { ...target, collection: visitTarget(target.collection) };
      case "sequence":
        return { ...target, steps: target.steps.map(visitTarget) };
      case "adjacent":
        return { ...target, sequence: visitTarget(target.sequence) };
      case "without":
        return {
          ...target,
          sequence: visitTarget(target.sequence),
          excluded: visitTarget(target.excluded),
        };
      default:
        return target;
    }
  };
  const visitExpression = (node: FilterExpression): FilterExpression => {
    if (node.kind === "condition") {
      const nestedTarget = visitTarget(node.target);
      const condition = { ...node, target: nestedTarget };
      return predicate(condition) ? update(condition) : condition;
    }
    if (node.kind === "not")
      return { ...node, child: visitExpression(node.child) };
    return { ...node, children: node.children.map(visitExpression) };
  };
  return visitExpression(expression);
}

export function filterValueKindForTarget(
  target: FilterTargetExpression,
): FilterValueKind {
  if (target.kind === "field")
    return (
      analyticsFilterRegistry.get(target.field)?.valueKind ?? "json-scalar"
    );
  if (target.kind === "event-payload") return "json-scalar";
  if (target.kind === "occurrence-time") return "datetime";
  if (target.kind === "context-intrinsic") {
    if (target.intrinsic === "same") return "boolean";
    if (target.intrinsic === "span" || target.intrinsic === "gap")
      return "number";
  }
  if (
    target.kind === "reducer" &&
    ["count", "sum", "avg", "countDistinct"].includes(target.reducer)
  )
    return "number";
  if (
    target.kind === "reducer" &&
    (target.reducer === "min" || target.reducer === "max") &&
    target.input.kind === "projection" &&
    target.input.collection.kind === "entity-root"
  ) {
    return (
      analyticsFilterRegistry.get(
        `${target.input.collection.entity}.${target.input.member}`,
      )?.valueKind ?? "json-scalar"
    );
  }
  if (target.kind === "arithmetic" || target.kind === "duration")
    return "number";
  if (target.kind === "time-anchor" || target.kind === "bucket")
    return "datetime";
  if (target.kind === "member") {
    const members: string[] = [];
    let object: FilterTargetExpression = target;
    while (object.kind === "member") {
      members.unshift(object.member);
      object = object.object;
    }
    const root = rootEntity(target.object);
    const memberPath = members.join(".");
    const field =
      (root
        ? analyticsFilterRegistry.get(`${root}.${memberPath}`)
        : undefined) ?? analyticsFilterRegistry.get(memberPath);
    return (
      field?.valueKind ?? (memberPath === "time" ? "datetime" : "json-scalar")
    );
  }
  return "json-scalar";
}

export function filterOperatorsForTarget(
  target: FilterTargetExpression,
): readonly FilterOperator[] {
  if (
    target.kind === "time-anchor" ||
    target.kind === "occurrence-time" ||
    isCurrentTimeTarget(target)
  )
    return DATETIME_OPERATORS;
  if (target.kind === "context-intrinsic" && target.intrinsic === "same")
    return ["eq"];
  if (target.kind === "field")
    return [
      ...(analyticsFilterRegistry.get(target.field)?.operators ??
        FILTER_OPERATOR_IDS),
    ];
  if (isCollectionTarget(target)) return ["exists", "notExists"];
  return FILTER_OPERATOR_IDS;
}

function isCurrentTimeTarget(target: FilterTargetExpression): boolean {
  return (
    target.kind === "member" &&
    target.object.kind === "context-root" &&
    target.object.context === "current" &&
    target.member === "time"
  );
}

function isCollectionTarget(target: FilterTargetExpression): boolean {
  return (
    target.kind === "entity-root" ||
    target.kind === "selector" ||
    target.kind === "projection" ||
    target.kind === "bucket" ||
    target.kind === "window" ||
    target.kind === "periods" ||
    target.kind === "sequence" ||
    target.kind === "adjacent" ||
    target.kind === "without" ||
    (target.kind === "context-root" && target.context !== "current")
  );
}

export function createAdvancedFilterCondition(
  kind: AdvancedFilterTargetKind,
  audience: FilterPanelAudience,
): FilterCondition {
  const target = createDefaultFilterTarget(kind, audience);
  if (
    kind === "sequence-span" ||
    kind === "sequence-gap" ||
    kind === "sequence-same"
  ) {
    const sequence = createDefaultFilterTarget("sequence", audience);
    if (sequence.kind !== "sequence")
      throw new Error("invalid_sequence_default");
    const operator = kind === "sequence-same" ? "eq" : "lte";
    const value =
      kind === "sequence-same"
        ? true
        : ({
            kind: "duration",
            amount: kind === "sequence-gap" ? 1 : 14,
            unit: "d",
          } as const);
    const constrainedSequence: FilterTargetExpression = {
      kind: "selector",
      collection: sequence,
      predicate: { kind: "condition", target, operator, value },
    };
    return {
      kind: "condition",
      target: {
        kind: "selector",
        collection: { kind: "entity-root", entity: "session" },
        predicate: {
          kind: "condition",
          target: constrainedSequence,
          operator: "exists",
        },
      },
      operator: "exists",
    };
  }
  if (kind === "period-items") {
    const period: FilterTargetExpression = {
      kind: "periods",
      collection: { kind: "entity-root", entity: "event" },
      interval: { kind: "duration", amount: 1, unit: "w" },
    };
    const countedItems: FilterTargetExpression = {
      kind: "reducer",
      reducer: "count",
      input: target,
    };
    return {
      kind: "condition",
      target: {
        kind: "selector",
        collection: { kind: "entity-root", entity: "session" },
        predicate: {
          kind: "condition",
          target: {
            kind: "selector",
            collection: period,
            predicate: {
              kind: "condition",
              target: countedItems,
              operator: "gte",
              value: 1,
            },
          },
          operator: "exists",
        },
      },
      operator: "exists",
    };
  }
  if (kind === "sequence" || kind === "adjacent" || kind === "without")
    return {
      kind: "condition",
      target: {
        kind: "selector",
        collection: { kind: "entity-root", entity: "session" },
        predicate: {
          kind: "condition",
          target,
          operator: "exists",
        },
      },
      operator: "exists",
    };
  if (kind === "time" || kind === "time-anchor" || kind === "occurrence-time")
    return {
      kind: "condition",
      target,
      operator: "gte",
      value:
        kind === "occurrence-time"
          ? {
              kind: "time-anchor",
              anchor: "now",
              offset: { kind: "duration", amount: -14, unit: "d" },
            }
          : "",
    };
  if (kind === "bucket")
    return {
      kind: "condition",
      target: { kind: "reducer", reducer: "countDistinct", input: target },
      operator: "gte",
      value: 1,
    };
  if (kind === "duration")
    return {
      kind: "condition",
      target,
      operator: "gte",
      value: { kind: "duration", amount: 1, unit: "d" },
    };
  if (kind === "reducer" || kind === "arithmetic")
    return { kind: "condition", target, operator: "gte", value: 1 };
  if (kind === "member")
    return { kind: "condition", target, operator: "exists" };
  return { kind: "condition", target, operator: "exists" };
}

export function createFilterPickerTargetCondition(
  selection: FilterPickerTargetSelection,
  audience: FilterPanelAudience,
): FilterCondition {
  if (selection.kind === "entity-root") {
    return {
      kind: "condition",
      target: { kind: "entity-root", entity: selection.entity },
      operator: "exists",
    };
  }
  if (selection.kind === "target") {
    return createAdvancedFilterCondition(selection.targetKind, audience);
  }
  if (selection.kind === "reducer") {
    const defaultReducer = createDefaultFilterTarget("reducer", audience);
    if (defaultReducer.kind !== "reducer")
      throw new Error("invalid_reducer_default");
    const input =
      selection.reducer === "sum" ||
      selection.reducer === "avg" ||
      selection.reducer === "min" ||
      selection.reducer === "max"
        ? {
            kind: "projection" as const,
            collection: {
              kind: "entity-root" as const,
              entity: "page" as const,
            },
            member: "durationMs",
          }
        : defaultReducer.input;
    const target = {
      ...defaultReducer,
      input,
      reducer: selection.reducer,
      ...(selection.reducer === "nth" ? { index: 1 } : {}),
    };
    const isScalarSelection =
      selection.reducer === "first" ||
      selection.reducer === "last" ||
      selection.reducer === "nth";
    return {
      kind: "condition",
      target,
      operator: isScalarSelection ? "exists" : "gte",
      ...(isScalarSelection ? {} : { value: 1 }),
    };
  }

  const input = createDefaultFilterTarget("arithmetic", audience);
  if (input.kind !== "arithmetic")
    throw new Error("invalid_arithmetic_default");
  return {
    kind: "condition",
    target: { ...input, operator: selection.operator },
    operator: "gte",
    value: 1,
  };
}
