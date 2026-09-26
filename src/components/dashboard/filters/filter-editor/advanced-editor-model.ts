import {
  analyticsFilterRegistry,
  FILTER_OPERATOR_IDS,
  type FilterCondition,
  type FilterDurationTarget,
  type FilterExpression,
  type FilterOperator,
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
        input: {
          kind: "member",
          object: { kind: "entity-root", entity: "event" },
          member: "time",
        },
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

export function filterValueKindForTarget(
  target: FilterTargetExpression,
): FilterValueKind {
  if (target.kind === "field")
    return (
      analyticsFilterRegistry.get(target.field)?.valueKind ?? "json-scalar"
    );
  if (target.kind === "event-payload") return "json-scalar";
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
    const member = target.member;
    const root = rootEntity(target.object);
    const field = root
      ? analyticsFilterRegistry.get(`${root}.${member}`)
      : undefined;
    return field?.valueKind ?? (member === "time" ? "datetime" : "json-scalar");
  }
  return "json-scalar";
}

export function filterOperatorsForTarget(
  target: FilterTargetExpression,
): readonly FilterOperator[] {
  if (target.kind === "time-anchor" || isCurrentTimeTarget(target))
    return DATETIME_OPERATORS;
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
  if (kind === "time" || kind === "time-anchor")
    return {
      kind: "condition",
      target,
      operator: "gte",
      value: "",
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
