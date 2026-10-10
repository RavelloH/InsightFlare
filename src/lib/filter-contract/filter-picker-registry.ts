import type {
  AnalyticsFilterFieldId,
  FilterFieldGroup,
} from "./filter-registry";
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
        | "occurrence-time"
        | "bucket"
        | "window"
        | "periods"
        | "period-items"
        | "sequence"
        | "sequence-span"
        | "sequence-gap"
        | "sequence-same"
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

const targetValue = (kind: string, variant?: string) =>
  `${FILTER_PICKER_TARGET_VALUE_PREFIX}${kind}${variant ? `:${variant}` : ""}`;

/**
 * Fields and nested collections that can be edited inside each entity-root
 * predicate. Keep this separate from the analytics field registry: these are
 * visual-builder capabilities, not additional DSL fields.
 */
export interface FilterEntityRootRegistration<Entity extends FilterEntityRoot> {
  readonly fields: readonly Extract<
    AnalyticsFilterFieldId,
    `${Entity}.${string}`
  >[];
  readonly collections: readonly Exclude<FilterEntityRoot, Entity>[];
}

export type FilterEntityRootRegistry = {
  readonly [Entity in FilterEntityRoot]: FilterEntityRootRegistration<Entity>;
};

export const FILTER_ENTITY_ROOT_REGISTRY = {
  page: {
    fields: [
      "page.path",
      "page.title",
      "page.hostname",
      "page.durationMs",
      "page.query",
      "page.hash",
    ],
    collections: ["session", "visitor"],
  },
  event: {
    fields: ["event.name", "event.payload"],
    collections: ["session", "visitor"],
  },
  session: {
    fields: [
      "session.entryPath",
      "session.exitPath",
      "session.durationMs",
      "session.views",
      "session.events",
      "session.bounce",
    ],
    collections: ["page", "event", "visitor"],
  },
  visitor: {
    fields: ["visitor.sessions", "visitor.views", "visitor.events"],
    collections: ["session", "page", "event"],
  },
} as const satisfies FilterEntityRootRegistry;

const entityRootPickerTargets: readonly FilterPickerTargetRegistration[] = (
  Object.keys(FILTER_ENTITY_ROOT_REGISTRY) as FilterEntityRoot[]
).map((entity) => ({
  id: entity,
  group: entity,
  labelKey: `${entity}.collection`,
  value: targetValue("entity-root", entity),
  selection: { kind: "entity-root" as const, entity },
}));

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

/**
 * Non-column entries offered by the filter field picker. These describe AST
 * targets and constructors; they deliberately do not enter the analytics
 * field registry used by DSL field validation or the D1 column compiler.
 */
export const FILTER_PICKER_TARGET_REGISTRY = [
  ...entityRootPickerTargets,
  {
    id: "time",
    group: "time",
    labelKey: "time",
    value: targetValue("time"),
    selection: { kind: "target", targetKind: "time" },
  },
  {
    id: "time(...)",
    group: "time",
    labelKey: "time(...)",
    value: targetValue("occurrence-time"),
    selection: { kind: "target", targetKind: "occurrence-time" },
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
  {
    id: "$items",
    group: "aggregation",
    labelKey: "$items",
    value: targetValue("period-items"),
    selection: { kind: "target", targetKind: "period-items" },
  },
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
  {
    id: "$span",
    group: "relation",
    labelKey: "$span",
    value: targetValue("sequence-span"),
    selection: { kind: "target", targetKind: "sequence-span" },
  },
  {
    id: "$gap(...)",
    group: "relation",
    labelKey: "$gap(...)",
    value: targetValue("sequence-gap"),
    selection: { kind: "target", targetKind: "sequence-gap" },
  },
  {
    id: "$same(...)",
    group: "relation",
    labelKey: "$same(...)",
    value: targetValue("sequence-same"),
    selection: { kind: "target", targetKind: "sequence-same" },
  },
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
