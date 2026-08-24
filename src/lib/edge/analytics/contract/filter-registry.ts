import type {
  FilterFieldDefinition,
  FilterFieldRegistry,
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
 * Storage semantics are part of the field contract.  Readers and compilers
 * must use these declarations instead of re-inventing NULL/empty handling.
 */
export type FilterFieldSource = "visit" | "event" | "session" | "payload";
export type FilterPresenceSemantics =
  | "non-null-column"
  | "derived-session-value"
  | "json-pointer";
export type FilterEmptySemantics = "raw-empty-string" | "unsupported";
export type FilterComparisonSemantics = "case-sensitive" | "case-insensitive";

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
  readonly presence: FilterPresenceSemantics;
  readonly empty: FilterEmptySemantics;
  readonly comparison: FilterComparisonSemantics;
}

/**
 * Public, canonical IDs.  This tuple is intentionally hand-authored rather
 * than inferred from the registry so changes are visible in review and can be
 * treated as a protocol change.
 */
export const ANALYTICS_FILTER_FIELD_IDS = [
  "page.path",
  "page.title",
  "page.hostname",
  "page.query",
  "page.hash",
  "session.entryPath",
  "session.exitPath",
  "referrer.domain",
  "referrer.url",
  "traffic.channel",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "utm.term",
  "utm.content",
  "client.browser",
  "client.browserVersion",
  "client.browserEngine",
  "client.os",
  "client.osVersion",
  "client.deviceType",
  "client.language",
  "client.screenSize",
  "geo.country",
  "geo.region",
  "geo.city",
  "geo.continent",
  "geo.timeZone",
  "geo.organization",
  "event.name",
  "event.payload",
] as const;

export type AnalyticsFilterFieldId =
  (typeof ANALYTICS_FILTER_FIELD_IDS)[number];

/** Bump when canonical IDs, value kinds, or operator semantics change. */
export const ANALYTICS_FILTER_REGISTRY_REVISION = "analytics-filter-v2";

const PUBLIC_AUDIENCES = readonlySet<QueryAudience>([
  "private-dashboard",
  "public-share",
  "api-v1",
]);
const PRIVATE_AUDIENCES = readonlySet<QueryAudience>([
  "private-dashboard",
  "api-v1",
]);
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

function text(
  id: string,
  audiences: ReadonlySet<QueryAudience>,
  profile: "trimmed-text" | "case-folded-text" = "trimmed-text",
  options: Partial<
    Pick<RegisteredFilterField, "source" | "presence" | "empty" | "comparison">
  > = {},
): RegisteredFilterField {
  return {
    id,
    valueKind: "string",
    operators: operatorsFor("string"),
    audiences,
    profile,
    singletonSetEquivalent: true,
    source: options.source ?? "visit",
    presence: options.presence ?? "non-null-column",
    empty: options.empty ?? "raw-empty-string",
    comparison:
      options.comparison ??
      (profile === "case-folded-text" ? "case-insensitive" : "case-sensitive"),
    canonicalize: (value) =>
      profile === "case-folded-text"
        ? String(value).trim().toLowerCase()
        : String(value).trim(),
  };
}

function enumField(
  id: string,
  audiences: ReadonlySet<QueryAudience>,
  options: Partial<
    Pick<RegisteredFilterField, "source" | "presence" | "empty" | "comparison">
  > = {},
): RegisteredFilterField {
  return {
    ...text(id, audiences, "case-folded-text", options),
    valueKind: "enum",
    operators: operatorsFor("enum"),
  };
}

const FIELDS: readonly RegisteredFilterField[] = [
  text("page.path", PUBLIC_AUDIENCES),
  text("page.title", PUBLIC_AUDIENCES),
  text("page.hostname", PUBLIC_AUDIENCES, "case-folded-text"),
  text("page.query", PRIVATE_AUDIENCES),
  text("page.hash", PRIVATE_AUDIENCES),
  {
    ...text("session.entryPath", PUBLIC_AUDIENCES, "trimmed-text", {
      source: "session",
      presence: "derived-session-value",
      empty: "unsupported",
    }),
    operators: operatorsFor("string", ["eq", "neq", "in", "notIn"]),
    profile: "session-boundary",
  },
  {
    ...text("session.exitPath", PUBLIC_AUDIENCES, "trimmed-text", {
      source: "session",
      presence: "derived-session-value",
      empty: "unsupported",
    }),
    operators: operatorsFor("string", ["eq", "neq", "in", "notIn"]),
    profile: "session-boundary",
  },
  {
    ...text("referrer.domain", PUBLIC_AUDIENCES, "case-folded-text", {
      source: "visit",
    }),
    profile: "direct-referrer",
  },
  {
    ...text("referrer.url", PRIVATE_AUDIENCES, "case-folded-text", {
      source: "visit",
    }),
    profile: "direct-referrer",
  },
  enumField("traffic.channel", PUBLIC_AUDIENCES),
  text("utm.source", PUBLIC_AUDIENCES),
  text("utm.medium", PUBLIC_AUDIENCES),
  text("utm.campaign", PUBLIC_AUDIENCES),
  text("utm.term", PUBLIC_AUDIENCES),
  text("utm.content", PUBLIC_AUDIENCES),
  text("client.browser", PUBLIC_AUDIENCES),
  text("client.browserVersion", PUBLIC_AUDIENCES),
  text("client.browserEngine", PUBLIC_AUDIENCES),
  text("client.os", PUBLIC_AUDIENCES),
  text("client.osVersion", PUBLIC_AUDIENCES),
  enumField("client.deviceType", PUBLIC_AUDIENCES),
  text("client.language", PUBLIC_AUDIENCES),
  text("client.screenSize", PUBLIC_AUDIENCES),
  enumField("geo.country", PUBLIC_AUDIENCES),
  text("geo.region", PRIVATE_AUDIENCES, "case-folded-text"),
  text("geo.city", PRIVATE_AUDIENCES, "case-folded-text"),
  enumField("geo.continent", PUBLIC_AUDIENCES),
  text("geo.timeZone", PUBLIC_AUDIENCES),
  text("geo.organization", PRIVATE_AUDIENCES),
  text("event.name", PRIVATE_AUDIENCES, "trimmed-text", {
    source: "event",
  }),
  {
    id: "event.payload",
    valueKind: "json-scalar",
    operators: operatorsFor("json-scalar"),
    audiences: PRIVATE_AUDIENCES,
    profile: "event-payload",
    source: "payload",
    presence: "json-pointer",
    empty: "raw-empty-string",
    comparison: "case-sensitive",
  },
];

const REGISTERED_FIELDS: readonly RegisteredFilterField[] = FIELDS.map(
  (field) => Object.freeze(field),
);

export const analyticsFilterRegistry: FilterFieldRegistry = readonlyMap(
  REGISTERED_FIELDS.map((field) => [field.id, field] as const),
);

const CANONICAL_FIELD_ID_SET = new Set<string>(ANALYTICS_FILTER_FIELD_IDS);

if (
  REGISTERED_FIELDS.length !== ANALYTICS_FILTER_FIELD_IDS.length ||
  REGISTERED_FIELDS.some(
    (field, index) =>
      field.id !== ANALYTICS_FILTER_FIELD_IDS[index] ||
      !CANONICAL_FIELD_ID_SET.has(field.id),
  )
) {
  throw new Error(
    "Analytics filter registry does not match its canonical field IDs.",
  );
}

export function filterIdsForAudience(
  audience: QueryAudience,
): ReadonlySet<string> {
  return readonlySet(
    FIELDS.filter((field) => field.audiences.has(audience)).map(
      (field) => field.id,
    ),
  );
}

export function analyticsFilterDefinition(
  fieldId: string,
): RegisteredFilterField | undefined {
  return analyticsFilterRegistry.get(fieldId) as
    | RegisteredFilterField
    | undefined;
}

export function analyticsFilterOperators(
  fieldId: string,
): ReadonlySet<FilterOperator> | undefined {
  return analyticsFilterDefinition(fieldId)?.operators;
}
