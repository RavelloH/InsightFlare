import type {
  FilterFieldDefinition,
  FilterOperator,
  FilterValueKind,
} from "./filters";
import type { QueryAudience } from "./types";

export type FilterStorageProfile =
  | "case-folded-text"
  | "direct-referrer"
  | "event-payload"
  | "session-boundary"
  | "trimmed-text";

/**
 * Storage semantics are part of the field contract. Readers and compilers
 * must use these declarations instead of re-inventing NULL/empty handling.
 */
export type FilterFieldSource =
  "visit" | "event" | "session" | "visitor" | "payload";
export type FilterObservationKind = "visit" | "event";
export type FilterPresenceSemantics =
  "non-null-column" | "derived-session-value" | "json-pointer";
export type FilterEmptySemantics = "raw-empty-string" | "unsupported";
export type FilterComparisonSemantics = "case-sensitive" | "case-insensitive";
export type FilterEvaluation =
  "observation" | "session-fact" | "visitor-fact" | "event-payload" | "derived";
export type FilterNativeEntity = "visit" | "event" | "session" | "visitor";
export type FilterSuggestionMode = "discrete" | "search" | "boolean" | "none";
export type FilterFieldGroup =
  | "page"
  | "session"
  | "visitor"
  | "acquisition"
  | "device"
  | "geo"
  | "event"
  | "performance"
  | "user";

/**
 * Strategy keys are intentionally not SQL expressions. The compiler owns the
 * strategy implementation and the registry only selects one of these keys.
 */
export type FilterColumnStrategy =
  | "column.pathname"
  | "column.title"
  | "column.hostname"
  | "column.query_string"
  | "column.hash_fragment"
  | "column.referrer_host"
  | "column.referrer_url"
  | "column.utm_source"
  | "column.utm_medium"
  | "column.utm_campaign"
  | "column.utm_term"
  | "column.utm_content"
  | "column.browser"
  | "column.browser_version"
  | "column.os"
  | "column.device_type"
  | "column.language"
  | "column.country"
  | "column.region"
  | "column.city"
  | "column.continent"
  | "column.timezone"
  | "column.as_organization"
  | "column.duration_ms"
  | "column.perf_ttfb_ms"
  | "column.perf_fcp_ms"
  | "column.perf_lcp_ms"
  | "column.perf_cls"
  | "column.perf_inp_ms"
  | "column.user_id"
  | "column.user_name"
  | "column.screen_width"
  | "column.screen_height"
  | "column.is_eu"
  | "fact.session_duration_ms"
  | "fact.session_views"
  | "fact.session_events"
  | "fact.session_bounce"
  | "fact.visitor_sessions"
  | "fact.visitor_views"
  | "fact.visitor_events";

export type FilterCompilerStrategy =
  | FilterColumnStrategy
  | "derived.trafficChannel"
  | "derived.browserEngine"
  | "derived.osVersion"
  | "derived.screenSize"
  | "session.boundary.entry"
  | "session.boundary.exit"
  | "event.name"
  | "event.payload";

function readonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const set = new Set(values);
  const result: ReadonlySet<T> = {
    get size() {
      return set.size;
    },
    has: (value) => set.has(value),
    entries: () => set.entries(),
    keys: () => set.keys(),
    values: () => set.values(),
    forEach: (callback, thisArg) => set.forEach(callback, thisArg),
    [Symbol.iterator]: () => set[Symbol.iterator](),
  };
  return Object.freeze(result);
}

function readonlyMap<K, V>(
  entries: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
  const map = new Map(entries);
  const result: ReadonlyMap<K, V> = {
    get size() {
      return map.size;
    },
    get: (key) => map.get(key),
    has: (key) => map.has(key),
    entries: () => map.entries(),
    keys: () => map.keys(),
    values: () => map.values(),
    forEach: (callback, thisArg) => map.forEach(callback, thisArg),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  };
  return Object.freeze(result);
}

export interface RegisteredFilterField extends FilterFieldDefinition {
  readonly profile: FilterStorageProfile;
  readonly source: FilterFieldSource;
  /** Observations on which this field has filter meaning. */
  readonly observationKinds: ReadonlySet<FilterObservationKind>;
  readonly presence: FilterPresenceSemantics;
  readonly empty: FilterEmptySemantics;
  readonly comparison: FilterComparisonSemantics;
  readonly group: FilterFieldGroup;
  readonly labelKey: string;
  readonly descriptionKey?: string;
  readonly evaluation: FilterEvaluation;
  readonly nativeEntity: FilterNativeEntity;
  readonly nullable: boolean;
  readonly unit?: "ms" | "px" | "ratio";
  readonly suggestionMode: FilterSuggestionMode;
  readonly compilerStrategy: FilterCompilerStrategy;
}

/** Canonical registry entries always carry the complete v4 metadata contract. */
export type AnalyticsFilterRegistryField = RegisteredFilterField;

const PUBLIC_AUDIENCES = readonlySet<QueryAudience>([
  "private-dashboard",
  "public-share",
  "api-v1",
]);
const PRIVATE_AUDIENCES = readonlySet<QueryAudience>([
  "private-dashboard",
  "api-v1",
]);
const VISIT_AND_EVENT_OBSERVATIONS = readonlySet<FilterObservationKind>([
  "visit",
  "event",
]);
const EVENT_OBSERVATIONS = readonlySet<FilterObservationKind>(["event"]);
const NO_OBSERVATIONS = readonlySet<FilterObservationKind>([]);

const OPERATORS_BY_VALUE_KIND: Readonly<
  Record<FilterValueKind, ReadonlySet<FilterOperator>>
> = {
  string: readonlySet([
    "eq",
    "neq",
    "in",
    "notIn",
    "contains",
    "startsWith",
    "endsWith",
    "exists",
    "notExists",
    "isNull",
    "notNull",
    "isEmpty",
    "notEmpty",
  ]),
  enum: readonlySet([
    "eq",
    "neq",
    "in",
    "notIn",
    "exists",
    "notExists",
    "isNull",
    "notNull",
    "isEmpty",
    "notEmpty",
  ]),
  number: readonlySet([
    "eq",
    "neq",
    "in",
    "notIn",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "exists",
    "notExists",
    "isNull",
    "notNull",
  ]),
  boolean: readonlySet([
    "eq",
    "neq",
    "exists",
    "notExists",
    "isNull",
    "notNull",
  ]),
  date: readonlySet([
    "eq",
    "neq",
    "in",
    "notIn",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "exists",
    "notExists",
    "isNull",
    "notNull",
  ]),
  datetime: readonlySet([
    "eq",
    "neq",
    "in",
    "notIn",
    "gt",
    "gte",
    "lt",
    "lte",
    "between",
    "exists",
    "notExists",
    "isNull",
    "notNull",
  ]),
  "json-scalar": readonlySet([
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
  ]),
};

function operatorsFor(
  valueKind: FilterValueKind,
  restrictTo?: readonly FilterOperator[],
): ReadonlySet<FilterOperator> {
  const base = OPERATORS_BY_VALUE_KIND[valueKind];
  return restrictTo
    ? readonlySet(restrictTo.filter((operator) => base.has(operator)))
    : base;
}

export function operatorsForValueKind(
  valueKind: FilterValueKind,
): ReadonlySet<FilterOperator> {
  return OPERATORS_BY_VALUE_KIND[valueKind];
}

function groupFor(id: string): FilterFieldGroup {
  if (id.startsWith("page.")) return "page";
  if (id.startsWith("session.")) return "session";
  if (id.startsWith("visitor.")) return "visitor";
  if (
    id.startsWith("utm.") ||
    id.startsWith("referrer.") ||
    id === "traffic.channel"
  )
    return "acquisition";
  if (id.startsWith("client.")) return "device";
  if (id.startsWith("geo.")) return "geo";
  if (id.startsWith("event.")) return "event";
  if (id.startsWith("performance.")) return "performance";
  if (id.startsWith("user.")) return "user";
  return "page";
}

type FieldMetadataOverrides = Partial<
  Pick<
    RegisteredFilterField,
    | "source"
    | "observationKinds"
    | "presence"
    | "empty"
    | "comparison"
    | "group"
    | "labelKey"
    | "descriptionKey"
    | "evaluation"
    | "nativeEntity"
    | "nullable"
    | "unit"
    | "suggestionMode"
  >
>;

type DefinedFilterField<Id extends string> = RegisteredFilterField & {
  readonly id: Id;
};

function text<const Id extends string>(
  id: Id,
  audiences: ReadonlySet<QueryAudience>,
  compilerStrategy: FilterCompilerStrategy,
  profile: "trimmed-text" | "case-folded-text" = "trimmed-text",
  options: FieldMetadataOverrides = {},
): DefinedFilterField<Id> {
  const source = options.source ?? "visit";
  const nativeEntity =
    options.nativeEntity ??
    (source === "event"
      ? "event"
      : source === "session"
        ? "session"
        : source === "visitor"
          ? "visitor"
          : "visit");
  return {
    id,
    valueKind: "string",
    operators: operatorsFor("string"),
    audiences,
    profile,
    singletonSetEquivalent: true,
    source,
    observationKinds: options.observationKinds ?? VISIT_AND_EVENT_OBSERVATIONS,
    presence: options.presence ?? "non-null-column",
    empty: options.empty ?? "raw-empty-string",
    comparison:
      options.comparison ??
      (profile === "case-folded-text" ? "case-insensitive" : "case-sensitive"),
    group: options.group ?? groupFor(id),
    labelKey: options.labelKey ?? `analytics.filters.fields.${id}`,
    ...(options.descriptionKey
      ? { descriptionKey: options.descriptionKey }
      : {}),
    evaluation:
      options.evaluation ??
      (source === "session" || source === "visitor"
        ? "derived"
        : "observation"),
    nativeEntity,
    nullable: options.nullable ?? true,
    ...(options.unit ? { unit: options.unit } : {}),
    suggestionMode: options.suggestionMode ?? "search",
    compilerStrategy,
    canonicalize: (value) =>
      profile === "case-folded-text"
        ? String(value).trim().toLowerCase()
        : String(value).trim(),
  };
}

function enumField<const Id extends string>(
  id: Id,
  audiences: ReadonlySet<QueryAudience>,
  compilerStrategy: FilterCompilerStrategy,
  options: FieldMetadataOverrides = {},
): DefinedFilterField<Id> {
  return {
    ...text(id, audiences, compilerStrategy, "case-folded-text", options),
    valueKind: "enum",
    operators: operatorsFor("enum"),
  };
}

type NumericOptions = FieldMetadataOverrides & {
  readonly number?: FilterFieldDefinition["number"];
};

function numeric<const Id extends string>(
  id: Id,
  audiences: ReadonlySet<QueryAudience>,
  compilerStrategy: FilterCompilerStrategy,
  options: NumericOptions = {},
): DefinedFilterField<Id> {
  const evaluation = options.evaluation ?? "observation";
  const nativeEntity = options.nativeEntity ?? "visit";
  const source = options.source ?? nativeEntity;
  return {
    id,
    valueKind: "number",
    operators: operatorsFor("number"),
    audiences,
    profile: "trimmed-text",
    source,
    observationKinds:
      options.observationKinds ??
      (evaluation === "observation"
        ? VISIT_AND_EVENT_OBSERVATIONS
        : NO_OBSERVATIONS),
    presence: options.presence ?? "non-null-column",
    empty: options.empty ?? "unsupported",
    comparison: options.comparison ?? "case-sensitive",
    group: options.group ?? groupFor(id),
    labelKey: options.labelKey ?? `analytics.filters.fields.${id}`,
    ...(options.descriptionKey
      ? { descriptionKey: options.descriptionKey }
      : {}),
    evaluation,
    nativeEntity,
    nullable: options.nullable ?? true,
    ...(options.unit ? { unit: options.unit } : {}),
    suggestionMode: options.suggestionMode ?? "none",
    compilerStrategy,
    ...(options.number ? { number: options.number } : {}),
  };
}

function booleanField<const Id extends string>(
  id: Id,
  audiences: ReadonlySet<QueryAudience>,
  compilerStrategy: FilterCompilerStrategy,
  options: NumericOptions = {},
): DefinedFilterField<Id> {
  return {
    ...numeric(id, audiences, compilerStrategy, options),
    valueKind: "boolean",
    operators: operatorsFor("boolean"),
    suggestionMode: options.suggestionMode ?? "boolean",
  };
}

/** The only hand-maintained field list. All public IDs and registry entries derive from it. */
const FIELDS = [
  text("page.path", PUBLIC_AUDIENCES, "column.pathname"),
  text("page.title", PUBLIC_AUDIENCES, "column.title"),
  text(
    "page.hostname",
    PUBLIC_AUDIENCES,
    "column.hostname",
    "case-folded-text",
  ),
  text("page.query", PRIVATE_AUDIENCES, "column.query_string"),
  text("page.hash", PRIVATE_AUDIENCES, "column.hash_fragment"),
  {
    ...text(
      "session.entryPath",
      PUBLIC_AUDIENCES,
      "session.boundary.entry",
      "trimmed-text",
      {
        source: "session",
        presence: "derived-session-value",
        empty: "unsupported",
        evaluation: "derived",
        nativeEntity: "session",
        suggestionMode: "search",
      },
    ),
    operators: operatorsFor("string", ["eq", "neq", "in", "notIn"]),
    profile: "session-boundary" as const,
  },
  {
    ...text(
      "session.exitPath",
      PUBLIC_AUDIENCES,
      "session.boundary.exit",
      "trimmed-text",
      {
        source: "session",
        presence: "derived-session-value",
        empty: "unsupported",
        evaluation: "derived",
        nativeEntity: "session",
        suggestionMode: "search",
      },
    ),
    operators: operatorsFor("string", ["eq", "neq", "in", "notIn"]),
    profile: "session-boundary" as const,
  },
  {
    ...text(
      "referrer.domain",
      PUBLIC_AUDIENCES,
      "column.referrer_host",
      "case-folded-text",
    ),
    profile: "direct-referrer" as const,
    suggestionMode: "search" as const,
  },
  {
    ...text(
      "referrer.url",
      PRIVATE_AUDIENCES,
      "column.referrer_url",
      "case-folded-text",
    ),
    profile: "direct-referrer" as const,
    suggestionMode: "search" as const,
  },
  enumField("traffic.channel", PUBLIC_AUDIENCES, "derived.trafficChannel", {
    suggestionMode: "discrete",
  }),
  text("utm.source", PUBLIC_AUDIENCES, "column.utm_source", "trimmed-text", {
    suggestionMode: "discrete",
  }),
  text("utm.medium", PUBLIC_AUDIENCES, "column.utm_medium", "trimmed-text", {
    suggestionMode: "discrete",
  }),
  text(
    "utm.campaign",
    PUBLIC_AUDIENCES,
    "column.utm_campaign",
    "trimmed-text",
    { suggestionMode: "discrete" },
  ),
  text("utm.term", PUBLIC_AUDIENCES, "column.utm_term", "trimmed-text", {
    suggestionMode: "discrete",
  }),
  text("utm.content", PUBLIC_AUDIENCES, "column.utm_content", "trimmed-text", {
    suggestionMode: "discrete",
  }),
  text("client.browser", PUBLIC_AUDIENCES, "column.browser", "trimmed-text", {
    suggestionMode: "discrete",
  }),
  text(
    "client.browserVersion",
    PUBLIC_AUDIENCES,
    "column.browser_version",
    "trimmed-text",
    { suggestionMode: "search" },
  ),
  text(
    "client.browserEngine",
    PUBLIC_AUDIENCES,
    "derived.browserEngine",
    "trimmed-text",
    { suggestionMode: "discrete" },
  ),
  text("client.os", PUBLIC_AUDIENCES, "column.os", "trimmed-text", {
    suggestionMode: "discrete",
  }),
  text(
    "client.osVersion",
    PUBLIC_AUDIENCES,
    "derived.osVersion",
    "trimmed-text",
    { suggestionMode: "search" },
  ),
  enumField("client.deviceType", PUBLIC_AUDIENCES, "column.device_type", {
    suggestionMode: "discrete",
  }),
  text("client.language", PUBLIC_AUDIENCES, "column.language", "trimmed-text", {
    suggestionMode: "discrete",
  }),
  text(
    "client.screenSize",
    PUBLIC_AUDIENCES,
    "derived.screenSize",
    "trimmed-text",
    { suggestionMode: "discrete" },
  ),
  enumField("geo.country", PUBLIC_AUDIENCES, "column.country", {
    suggestionMode: "discrete",
  }),
  text("geo.region", PRIVATE_AUDIENCES, "column.region", "case-folded-text"),
  text("geo.city", PRIVATE_AUDIENCES, "column.city", "case-folded-text"),
  enumField("geo.continent", PUBLIC_AUDIENCES, "column.continent", {
    suggestionMode: "discrete",
  }),
  text("geo.timeZone", PUBLIC_AUDIENCES, "column.timezone", "trimmed-text", {
    suggestionMode: "discrete",
  }),
  text("geo.organization", PRIVATE_AUDIENCES, "column.as_organization"),
  text("event.name", PRIVATE_AUDIENCES, "event.name", "trimmed-text", {
    source: "event",
    observationKinds: EVENT_OBSERVATIONS,
    nativeEntity: "event",
    suggestionMode: "search",
    nullable: false,
  }),
  {
    id: "event.payload" as const,
    valueKind: "json-scalar" as const,
    operators: operatorsFor("json-scalar"),
    audiences: PRIVATE_AUDIENCES,
    profile: "event-payload" as const,
    source: "payload" as const,
    observationKinds: EVENT_OBSERVATIONS,
    presence: "json-pointer" as const,
    empty: "raw-empty-string" as const,
    comparison: "case-sensitive" as const,
    group: "event" as const,
    labelKey: "analytics.filters.fields.event.payload",
    evaluation: "event-payload" as const,
    nativeEntity: "event" as const,
    nullable: true,
    suggestionMode: "none" as const,
    compilerStrategy: "event.payload" as const,
  },
  numeric("page.durationMs", PUBLIC_AUDIENCES, "column.duration_ms", {
    unit: "ms",
    number: { min: 0 },
  }),
  numeric("session.durationMs", PUBLIC_AUDIENCES, "fact.session_duration_ms", {
    source: "session",
    evaluation: "session-fact",
    nativeEntity: "session",
    nullable: false,
    unit: "ms",
    number: { min: 0 },
  }),
  numeric("session.views", PUBLIC_AUDIENCES, "fact.session_views", {
    source: "session",
    evaluation: "session-fact",
    nativeEntity: "session",
    nullable: false,
    number: { min: 0, step: 1 },
  }),
  numeric("session.events", PUBLIC_AUDIENCES, "fact.session_events", {
    source: "session",
    evaluation: "session-fact",
    nativeEntity: "session",
    nullable: false,
    number: { min: 0, step: 1 },
  }),
  booleanField("session.bounce", PUBLIC_AUDIENCES, "fact.session_bounce", {
    source: "session",
    evaluation: "session-fact",
    nativeEntity: "session",
    nullable: false,
  }),
  numeric("visitor.sessions", PUBLIC_AUDIENCES, "fact.visitor_sessions", {
    source: "visitor",
    evaluation: "visitor-fact",
    nativeEntity: "visitor",
    nullable: false,
    number: { min: 0, step: 1 },
  }),
  numeric("visitor.views", PUBLIC_AUDIENCES, "fact.visitor_views", {
    source: "visitor",
    evaluation: "visitor-fact",
    nativeEntity: "visitor",
    nullable: false,
    number: { min: 0, step: 1 },
  }),
  numeric("visitor.events", PUBLIC_AUDIENCES, "fact.visitor_events", {
    source: "visitor",
    evaluation: "visitor-fact",
    nativeEntity: "visitor",
    nullable: false,
    number: { min: 0, step: 1 },
  }),
  numeric("performance.ttfbMs", PUBLIC_AUDIENCES, "column.perf_ttfb_ms", {
    unit: "ms",
    number: { min: 0 },
  }),
  numeric("performance.fcpMs", PUBLIC_AUDIENCES, "column.perf_fcp_ms", {
    unit: "ms",
    number: { min: 0 },
  }),
  numeric("performance.lcpMs", PUBLIC_AUDIENCES, "column.perf_lcp_ms", {
    unit: "ms",
    number: { min: 0 },
  }),
  numeric("performance.cls", PUBLIC_AUDIENCES, "column.perf_cls", {
    unit: "ratio",
    number: { min: 0 },
  }),
  numeric("performance.inpMs", PUBLIC_AUDIENCES, "column.perf_inp_ms", {
    unit: "ms",
    number: { min: 0 },
  }),
  text("user.id", PRIVATE_AUDIENCES, "column.user_id", "trimmed-text", {
    suggestionMode: "search",
  }),
  text("user.name", PRIVATE_AUDIENCES, "column.user_name", "trimmed-text", {
    suggestionMode: "search",
  }),
  numeric("client.screenWidth", PUBLIC_AUDIENCES, "column.screen_width", {
    unit: "px",
    number: { min: 0, step: 1 },
  }),
  numeric("client.screenHeight", PUBLIC_AUDIENCES, "column.screen_height", {
    unit: "px",
    number: { min: 0, step: 1 },
  }),
  booleanField("geo.isEU", PUBLIC_AUDIENCES, "column.is_eu", {
    nullable: false,
  }),
] as const satisfies readonly RegisteredFilterField[];

type FieldIdTuple<T extends readonly { readonly id: string }[]> = {
  readonly [K in keyof T]: T[K] extends { readonly id: infer Id } ? Id : never;
};

/** Derived from FIELDS so IDs cannot drift from their canonical definitions. */
export const ANALYTICS_FILTER_FIELD_IDS = FIELDS.map(
  (field) => field.id,
) as unknown as FieldIdTuple<typeof FIELDS>;

export type AnalyticsFilterFieldId =
  (typeof ANALYTICS_FILTER_FIELD_IDS)[number];

/** Stable product order for field selectors and expression help. */
export const ANALYTICS_FILTER_FIELD_DISPLAY_ORDER = [
  "referrer.domain",
  "referrer.url",
  "traffic.channel",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "utm.term",
  "utm.content",
  "page.path",
  "page.title",
  "page.hostname",
  "page.durationMs",
  "page.query",
  "page.hash",
  "event.name",
  "event.payload",
  "session.entryPath",
  "session.exitPath",
  "session.durationMs",
  "session.views",
  "session.events",
  "session.bounce",
  "visitor.sessions",
  "visitor.views",
  "visitor.events",
  "client.deviceType",
  "client.browser",
  "client.browserVersion",
  "client.browserEngine",
  "client.os",
  "client.osVersion",
  "client.language",
  "client.screenSize",
  "client.screenWidth",
  "client.screenHeight",
  "geo.country",
  "geo.region",
  "geo.city",
  "geo.continent",
  "geo.timeZone",
  "geo.organization",
  "geo.isEU",
  "performance.lcpMs",
  "performance.inpMs",
  "performance.cls",
  "performance.ttfbMs",
  "performance.fcpMs",
  "user.id",
  "user.name",
] as const satisfies readonly AnalyticsFilterFieldId[];

const displayOrderIds = new Set(ANALYTICS_FILTER_FIELD_DISPLAY_ORDER);
if (
  displayOrderIds.size !== ANALYTICS_FILTER_FIELD_DISPLAY_ORDER.length ||
  displayOrderIds.size !== FIELDS.length ||
  FIELDS.some((field) => !displayOrderIds.has(field.id))
) {
  throw new Error(
    "Analytics filter display order is incomplete or duplicated.",
  );
}

export const analyticsFilterFieldDisplayOrder: ReadonlyMap<string, number> =
  readonlyMap(
    ANALYTICS_FILTER_FIELD_DISPLAY_ORDER.map(
      (field, index) => [field, index] as const,
    ),
  );

/** Bump when canonical IDs, value kinds, or operator semantics change. */
export const ANALYTICS_FILTER_REGISTRY_REVISION = "analytics-filter-v4";

const REGISTERED_FIELDS: readonly RegisteredFilterField[] = FIELDS.map(
  (field) => Object.freeze(field),
);
const registryEntries = REGISTERED_FIELDS.map(
  (field) => [field.id, field] as const,
);

if (
  new Set(REGISTERED_FIELDS.map((field) => field.id)).size !==
  REGISTERED_FIELDS.length
) {
  throw new Error("Analytics filter registry contains duplicate field IDs.");
}

export const analyticsFilterRegistry: ReadonlyMap<
  string,
  AnalyticsFilterRegistryField
> = readonlyMap(registryEntries);

export function filterIdsForAudience(
  audience: QueryAudience,
): ReadonlySet<string> {
  return readonlySet(
    REGISTERED_FIELDS.filter((field) => field.audiences.has(audience)).map(
      (field) => field.id,
    ),
  );
}

export function analyticsFilterDefinition(
  fieldId: string,
): RegisteredFilterField | undefined {
  return analyticsFilterRegistry.get(fieldId);
}

export function analyticsFilterOperators(
  fieldId: string,
): ReadonlySet<FilterOperator> | undefined {
  return analyticsFilterDefinition(fieldId)?.operators;
}
