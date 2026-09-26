import type { FilterFieldGroup } from "./filter-registry";
import type {
  FilterArithmeticTarget,
  FilterEntityRoot,
  FilterReducerTarget,
} from "./filters";

export type FilterPickerGroup =
  FilterFieldGroup | "time" | "aggregation" | "calculation" | "relation";

export type FilterPickerTargetSelection =
  | { readonly kind: "entity-root"; readonly entity: FilterEntityRoot }
  | {
      readonly kind: "target";
      readonly targetKind:
        | "time"
        | "bucket"
        | "window"
        | "periods"
        | "sequence"
        | "adjacent"
        | "without";
    }
  | {
      readonly kind: "reducer";
      readonly reducer: FilterReducerTarget["reducer"];
    }
  | {
      readonly kind: "arithmetic";
      readonly operator: FilterArithmeticTarget["operator"];
    };

export interface FilterPickerTargetRegistration {
  /** Stable picker identifier used for search and registration checks. */
  readonly id: string;
  /** Category shown in the filter field picker. */
  readonly group: FilterPickerGroup;
  /** Translation key within filterBuilder.fieldLabels. */
  readonly labelKey: string;
  /** Internal editor value; this is not a FilterFieldId. */
  readonly value: string;
  readonly selection: FilterPickerTargetSelection;
}

export const FILTER_PICKER_TARGET_VALUE_PREFIX = "__advanced__:";

export const FILTER_PICKER_GROUP_ORDER = [
  "page",
  "event",
  "session",
  "visitor",
  "acquisition",
  "device",
  "geo",
  "performance",
  "user",
  "time",
  "aggregation",
  "calculation",
  "relation",
] as const satisfies readonly FilterPickerGroup[];

const targetValue = (kind: string, variant?: string) =>
  `${FILTER_PICKER_TARGET_VALUE_PREFIX}${kind}${variant ? `:${variant}` : ""}`;

/**
 * Non-column entries offered by the filter field picker. These describe AST
 * targets and constructors; they deliberately do not enter the analytics
 * field registry used by DSL field validation or the D1 column compiler.
 */
export const FILTER_PICKER_TARGET_REGISTRY = [
  {
    id: "page",
    group: "page",
    labelKey: "page.collection",
    value: targetValue("entity-root", "page"),
    selection: { kind: "entity-root", entity: "page" },
  },
  {
    id: "event",
    group: "event",
    labelKey: "event.collection",
    value: targetValue("entity-root", "event"),
    selection: { kind: "entity-root", entity: "event" },
  },
  {
    id: "session",
    group: "session",
    labelKey: "session.collection",
    value: targetValue("entity-root", "session"),
    selection: { kind: "entity-root", entity: "session" },
  },
  {
    id: "visitor",
    group: "visitor",
    labelKey: "visitor.collection",
    value: targetValue("entity-root", "visitor"),
    selection: { kind: "entity-root", entity: "visitor" },
  },
  {
    id: "time",
    group: "time",
    labelKey: "time",
    value: targetValue("time"),
    selection: { kind: "target", targetKind: "time" },
  },
  {
    id: "bucket(...)",
    group: "time",
    labelKey: "bucket(...)",
    value: targetValue("bucket"),
    selection: { kind: "target", targetKind: "bucket" },
  },
  {
    id: "window(...)",
    group: "time",
    labelKey: "window(...)",
    value: targetValue("window"),
    selection: { kind: "target", targetKind: "window" },
  },
  {
    id: "periods(...)",
    group: "time",
    labelKey: "periods(...)",
    value: targetValue("periods"),
    selection: { kind: "target", targetKind: "periods" },
  },
  ...(
    [
      ["count", "count(...)"],
      ["first", "first(...)"],
      ["last", "last(...)"],
      ["nth", "nth(...)"],
      ["countDistinct", "countDistinct(...)"],
      ["sum", "sum(...)"],
      ["avg", "avg(...)"],
      ["min", "min(...)"],
      ["max", "max(...)"],
    ] as const satisfies readonly (readonly [
      FilterReducerTarget["reducer"],
      string,
    ])[]
  ).map(([reducer, id]) => ({
    id,
    group: "aggregation" as const,
    labelKey: id,
    value: targetValue("reducer", reducer),
    selection: { kind: "reducer" as const, reducer },
  })),
  ...(
    [
      ["add", "add(...)"],
      ["sub", "sub(...)"],
      ["mul", "mul(...)"],
      ["div", "div(...)"],
    ] as const satisfies readonly (readonly [
      FilterArithmeticTarget["operator"],
      string,
    ])[]
  ).map(([operator, id]) => ({
    id,
    group: "calculation" as const,
    labelKey: id,
    value: targetValue("arithmetic", operator),
    selection: { kind: "arithmetic" as const, operator },
  })),
  ...(
    [
      ["sequence", "sequence(...)"],
      ["adjacent", "adjacent(...)"],
      ["without", "without(...)"],
    ] as const satisfies readonly (readonly [
      "sequence" | "adjacent" | "without",
      string,
    ])[]
  ).map(([targetKind, id]) => ({
    id,
    group: "relation" as const,
    labelKey: id,
    value: targetValue(targetKind),
    selection: { kind: "target" as const, targetKind },
  })),
] as const satisfies readonly FilterPickerTargetRegistration[];

export function filterPickerTargetForValue(
  value: string,
): FilterPickerTargetRegistration | undefined {
  return FILTER_PICKER_TARGET_REGISTRY.find((target) => target.value === value);
}

export function filterPickerValueForSelection(
  selection: FilterPickerTargetSelection,
): string | undefined {
  return FILTER_PICKER_TARGET_REGISTRY.find((target) => {
    const registered = target.selection;
    if (registered.kind !== selection.kind) return false;
    if (registered.kind === "entity-root" && selection.kind === "entity-root")
      return registered.entity === selection.entity;
    if (registered.kind === "target" && selection.kind === "target")
      return registered.targetKind === selection.targetKind;
    if (registered.kind === "reducer" && selection.kind === "reducer")
      return registered.reducer === selection.reducer;
    if (registered.kind === "arithmetic" && selection.kind === "arithmetic")
      return registered.operator === selection.operator;
    return false;
  })?.value;
}
