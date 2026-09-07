import { buildTrafficChannelSqlExpression } from "@/lib/analytics/traffic-channel-rules";
import { browserEngineCaseSql } from "@/lib/browser-engine";

import {
  analyticsFilterDefinition,
  analyticsFilterRegistry,
  type FilterColumnStrategy,
  type FilterCompilerStrategy,
  type RegisteredFilterField,
} from "./filter-registry";
import {
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterOperator,
  type FilterValue,
  normalizeFilterDocument,
} from "./filters";

export type FilterSqlBinding = string | number;

/** Keep small predicates simple; use one JSON binding when the set is large. */
export const JSON_EACH_SET_THRESHOLD = 8;

export interface FilterSql {
  readonly clause: string;
  readonly bindings: readonly FilterSqlBinding[];
}

export interface FilterCompilerOptions {
  readonly alias?: string;
  readonly sessionSource?: string;
  readonly eventAlias?: string;
}

type Compiler = {
  readonly alias: string;
  readonly sessionSource: string;
  readonly eventAlias: string;
  readonly bindings: FilterSqlBinding[];
  payloadIndex: number;
  orLikeIndex: number;
};

const FILTER_SQL_CACHE = new WeakMap<FilterDocument, Map<string, FilterSql>>();

const COLUMN_STRATEGY_COLUMNS: Readonly<Record<FilterColumnStrategy, string>> =
  {
    "column.pathname": "pathname",
    "column.title": "title",
    "column.hostname": "hostname",
    "column.query_string": "query_string",
    "column.hash_fragment": "hash_fragment",
    "column.referrer_host": "referrer_host",
    "column.referrer_url": "referrer_url",
    "column.utm_source": "utm_source",
    "column.utm_medium": "utm_medium",
    "column.utm_campaign": "utm_campaign",
    "column.utm_term": "utm_term",
    "column.utm_content": "utm_content",
    "column.browser": "browser",
    "column.browser_version": "browser_version",
    "column.os": "os",
    "column.device_type": "device_type",
    "column.language": "language",
    "column.country": "country",
    "column.region": "region",
    "column.city": "city",
    "column.continent": "continent",
    "column.timezone": "timezone",
    "column.as_organization": "as_organization",
    "column.duration_ms": "duration_ms",
    "column.perf_ttfb_ms": "perf_ttfb_ms",
    "column.perf_fcp_ms": "perf_fcp_ms",
    "column.perf_lcp_ms": "perf_lcp_ms",
    "column.perf_cls": "perf_cls",
    "column.perf_inp_ms": "perf_inp_ms",
    "column.user_id": "user_id",
    "column.user_name": "user_name",
    "column.screen_width": "screen_width",
    "column.screen_height": "screen_height",
    "column.is_eu": "is_eu",
    "fact.session_duration_ms": "session_duration_ms",
    "fact.session_views": "session_views",
    "fact.session_events": "session_events",
    "fact.session_bounce": "session_bounce",
    "fact.visitor_sessions": "visitor_sessions",
    "fact.visitor_views": "visitor_views",
    "fact.visitor_events": "visitor_events",
  };

function validAlias(value: string, label: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError(`${label} must be an internal SQL identifier.`);
  }
  return value;
}

function column(compiler: Compiler, name: string): string {
  return `${compiler.alias}.${name}`;
}

function compilerStrategyFor(
  field: RegisteredFilterField,
): FilterCompilerStrategy {
  if (!field.compilerStrategy) {
    throw new TypeError(`No compiler strategy registered for ${field.id}.`);
  }
  return field.compilerStrategy;
}

function directColumn(
  compiler: Compiler,
  strategy: FilterCompilerStrategy,
): string {
  if (strategy === "event.name") return `${compiler.eventAlias}.event_name`;
  if (strategy === "derived.trafficChannel") {
    return buildTrafficChannelSqlExpression({
      referrerHost: column(compiler, "referrer_host"),
      utmSource: column(compiler, "utm_source"),
      utmMedium: column(compiler, "utm_medium"),
      utmCampaign: column(compiler, "utm_campaign"),
    });
  }
  if (strategy === "derived.browserEngine") {
    return browserEngineCaseSql(
      column(compiler, "browser"),
      column(compiler, "os"),
    );
  }
  if (strategy === "derived.osVersion") {
    return `TRIM(CASE WHEN ${column(compiler, "os")} != '' AND ${column(compiler, "os_version")} != '' THEN ${column(compiler, "os")} || ' ' || ${column(compiler, "os_version")} WHEN ${column(compiler, "os")} != '' THEN ${column(compiler, "os")} WHEN ${column(compiler, "os_version")} != '' THEN ${column(compiler, "os_version")} ELSE '' END)`;
  }
  if (strategy === "derived.screenSize") {
    return `CASE WHEN ${column(compiler, "screen_width")} IS NOT NULL AND ${column(compiler, "screen_height")} IS NOT NULL THEN CAST(${column(compiler, "screen_width")} AS TEXT) || 'x' || CAST(${column(compiler, "screen_height")} AS TEXT) ELSE '' END`;
  }
  const name = COLUMN_STRATEGY_COLUMNS[strategy as FilterColumnStrategy];
  if (!name)
    throw new TypeError(`No SQL column strategy registered for ${strategy}.`);
  return column(compiler, name);
}

function normalizedColumn(
  field: RegisteredFilterField,
  expression: string,
): string {
  if (field.valueKind === "number" || field.valueKind === "boolean") {
    return expression;
  }
  const trimmed = `TRIM(COALESCE(${expression}, ''))`;
  return field.comparison === "case-insensitive"
    ? `LOWER(${trimmed})`
    : trimmed;
}

function push(compiler: Compiler, value: FilterSqlBinding): string {
  compiler.bindings.push(value);
  return "?";
}

function jsonSet(values: readonly FilterValue[]): string {
  const encoded = JSON.stringify(values.map((value) => scalar(value)));
  if (encoded === undefined) {
    throw new TypeError("Filter set values must be JSON serializable.");
  }
  return encoded;
}

function jsonBindingSet(values: readonly FilterSqlBinding[]): string {
  const encoded = JSON.stringify(values);
  if (encoded === undefined) {
    throw new TypeError("Filter set values must be JSON serializable.");
  }
  return encoded;
}

function setComparison(
  compiler: Compiler,
  normalized: string,
  operator: FilterOperator,
  values: readonly FilterSqlBinding[],
): string {
  const sqlOperator = operator === "notIn" ? "NOT IN" : "IN";
  if (values.length >= JSON_EACH_SET_THRESHOLD) {
    return `${normalized} ${sqlOperator} (SELECT value FROM json_each(${push(compiler, jsonBindingSet(values))}))`;
  }
  const placeholders = values.map((item) => push(compiler, item)).join(", ");
  return `${normalized} ${sqlOperator} (${placeholders})`;
}

function scalar(value: FilterValue): FilterSqlBinding {
  if (value === null || typeof value === "boolean") {
    throw new TypeError(
      "This SQL predicate requires a non-null scalar binding.",
    );
  }
  return value;
}

function fieldScalar(
  field: RegisteredFilterField,
  value: FilterValue,
): FilterSqlBinding {
  if (value === null) {
    throw new TypeError(
      "This SQL predicate requires a non-null scalar binding.",
    );
  }
  if (field.valueKind === "boolean") {
    if (typeof value !== "boolean")
      throw new TypeError("Boolean filter values must be boolean.");
    return value ? 1 : 0;
  }
  if (field.valueKind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new TypeError("Numeric filter values must be finite numbers.");
    return value;
  }
  return scalar(value);
}

function escapedLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

type OrVectorOperator = "eq" | "contains" | "startsWith" | "endsWith";

type OrVectorCondition = {
  readonly field: RegisteredFilterField;
  readonly source: string;
  readonly operator: OrVectorOperator;
  readonly value: string | number;
};

function storedComparisonValue(
  field: RegisteredFilterField,
  value: string | number,
): string | number {
  return field.profile === "direct-referrer" && value === "__direct__"
    ? ""
    : value;
}

function orVectorCondition(
  compiler: Compiler,
  item: FilterExpression,
): OrVectorCondition | undefined {
  if (item.kind !== "condition" || item.target.kind !== "field") {
    return undefined;
  }
  const field = analyticsFilterDefinition(item.target.field);
  if (
    !field ||
    field.profile === "session-boundary" ||
    (item.operator !== "eq" &&
      item.operator !== "contains" &&
      item.operator !== "startsWith" &&
      item.operator !== "endsWith") ||
    Array.isArray(item.value) ||
    (typeof item.value !== "string" && typeof item.value !== "number")
  ) {
    return undefined;
  }
  if (item.operator !== "eq" && typeof item.value !== "string") {
    return undefined;
  }
  return {
    field,
    source: directColumn(compiler, compilerStrategyFor(field)),
    operator: item.operator,
    value: storedComparisonValue(field, item.value),
  };
}

function vectorKey(item: OrVectorCondition): string {
  return `${item.field.id}\u0000${item.operator}`;
}

function jsonOrLikeComparison(
  compiler: Compiler,
  item: OrVectorCondition,
  values: readonly string[],
): string {
  const normalized = normalizedColumn(item.field, item.source);
  const alias = `filter_or_like_${compiler.orLikeIndex}`;
  compiler.orLikeIndex += 1;
  // This mirrors escapedLike() for values read from json_each at SQL runtime.
  const escaped = `REPLACE(REPLACE(REPLACE(${alias}.value, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;
  const pattern =
    item.operator === "contains"
      ? `'%' || ${escaped} || '%'`
      : item.operator === "startsWith"
        ? `${escaped} || '%'`
        : `'%' || ${escaped}`;
  return `EXISTS (
    SELECT 1
    FROM json_each(${push(compiler, JSON.stringify(values))}) AS ${alias}
    WHERE ${normalized} LIKE ${pattern} ESCAPE '\\'
  )`;
}

function vectorOrComparison(
  compiler: Compiler,
  item: OrVectorCondition,
  values: readonly (string | number)[],
): string {
  const normalized = normalizedColumn(item.field, item.source);
  if (item.operator === "eq") {
    return `${normalized} IN (SELECT value FROM json_each(${push(compiler, jsonSet(values))}))`;
  }
  return jsonOrLikeComparison(compiler, item, values as readonly string[]);
}

function orExpression(
  compiler: Compiler,
  children: readonly FilterExpression[],
): string {
  const vectors = children.map((child) => orVectorCondition(compiler, child));
  const groups = new Map<string, number[]>();
  for (const [index, vector] of vectors.entries()) {
    if (!vector) continue;
    const key = vectorKey(vector);
    const entries = groups.get(key) ?? [];
    entries.push(index);
    groups.set(key, entries);
  }
  const groupedIndexes = new Set(
    [...groups.values()].flatMap((indexes) =>
      indexes.length > 1 ? indexes.slice(1) : [],
    ),
  );
  const clauses: string[] = [];
  for (const [index, child] of children.entries()) {
    if (groupedIndexes.has(index)) continue;
    const vector = vectors[index];
    const indexes = vector ? groups.get(vectorKey(vector)) : undefined;
    if (vector && indexes && indexes.length > 1) {
      clauses.push(
        vectorOrComparison(
          compiler,
          vector,
          indexes.map((itemIndex) => vectors[itemIndex]!.value),
        ),
      );
    } else {
      clauses.push(expression(compiler, child));
    }
  }
  return `(${clauses.join(" OR ")})`;
}

function comparison(
  compiler: Compiler,
  field: RegisteredFilterField,
  source: string,
  operator: FilterOperator,
  value: FilterValue | readonly FilterValue[] | undefined,
): string {
  const normalized = normalizedColumn(field, source);
  if (
    field.profile === "direct-referrer" &&
    typeof value === "string" &&
    value === "__direct__" &&
    (operator === "eq" || operator === "neq")
  ) {
    return `${normalized} ${operator === "eq" ? "=" : "!="} ''`;
  }
  if (operator === "exists" || operator === "notNull")
    return `${source} IS NOT NULL`;
  if (operator === "notExists" || operator === "isNull")
    return `${source} IS NULL`;
  if (operator === "isEmpty")
    return `${source} IS NOT NULL AND ${normalized} = ''`;
  if (operator === "notEmpty")
    return `${source} IS NOT NULL AND ${normalized} != ''`;
  if (Array.isArray(value)) {
    if (operator === "between") {
      return `${normalized} BETWEEN ${push(compiler, fieldScalar(field, value[0]!))} AND ${push(compiler, fieldScalar(field, value[1]!))}`;
    }
    const storedValues =
      field.profile === "direct-referrer"
        ? value.map((item) => (item === "__direct__" ? "" : item))
        : value;
    return setComparison(
      compiler,
      normalized,
      operator,
      storedValues.map((item) => fieldScalar(field, item)),
    );
  }
  const binding = fieldScalar(field, value as FilterValue);
  if (
    operator === "contains" ||
    operator === "startsWith" ||
    operator === "endsWith"
  ) {
    const pattern = escapedLike(String(binding));
    const like =
      operator === "contains"
        ? `%${pattern}%`
        : operator === "startsWith"
          ? `${pattern}%`
          : `%${pattern}`;
    return `${normalized} LIKE ${push(compiler, like)} ESCAPE '\\'`;
  }
  const sqlOperator: Record<string, string> = {
    eq: "=",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  };
  return `${normalized} ${sqlOperator[operator]!} ${push(compiler, binding)}`;
}

function sessionBoundary(
  compiler: Compiler,
  condition: FilterCondition,
  kind: "entry" | "exit",
): string {
  const field = analyticsFilterDefinition(
    kind === "entry" ? "session.entryPath" : "session.exitPath",
  )!;
  const rankOrder = kind === "entry" ? "ASC" : "DESC";
  const rank = kind === "entry" ? "entry_rank" : "exit_rank";
  const boundary = kind === "entry" ? "entry_path" : "exit_path";
  const predicate = comparison(
    compiler,
    field,
    boundary,
    condition.operator,
    condition.value,
  );
  return `(${column(compiler, "site_pk")}, ${column(compiler, "session_id")}) IN (
    SELECT site_pk, session_id FROM (
      SELECT site_pk, session_id, MAX(CASE WHEN ${rank} = 1 THEN pathname END) AS ${boundary}
      FROM (
        SELECT edge.site_pk, edge.session_id, edge.pathname,
          ROW_NUMBER() OVER (PARTITION BY edge.site_pk, edge.session_id ORDER BY edge.started_at ${rankOrder}, edge.visit_id ${rankOrder}) AS ${rank}
        FROM ${compiler.sessionSource} edge
        WHERE TRIM(COALESCE(edge.site_pk, '')) != ''
          AND TRIM(COALESCE(edge.session_id, '')) != ''
      ) session_edges
      GROUP BY site_pk, session_id
    ) session_boundaries
    WHERE ${predicate}
  )`;
}

function payloadValueType(value: FilterValue): number {
  if (value === null) return 0;
  if (typeof value === "string") return 1;
  if (typeof value === "number") return 2;
  if (typeof value === "boolean") return 3;
  throw new TypeError("Event payload values must be JSON scalars.");
}

function payloadValueColumn(alias: string, value: FilterValue): string {
  if (typeof value === "string") return `${alias}.string_value`;
  if (typeof value === "number") return `${alias}.number_value`;
  if (typeof value === "boolean") return `${alias}.boolean_value`;
  return `${alias}.value_type`;
}

function payloadComparison(
  compiler: Compiler,
  condition: FilterCondition,
): string {
  if (condition.target.kind !== "event-payload")
    throw new TypeError("Payload compiler requires an event-payload target.");
  const valueAlias = `filter_payload_value_${compiler.payloadIndex}`;
  const pathAlias = `filter_payload_path_${compiler.payloadIndex}`;
  compiler.payloadIndex += 1;
  const base = `${valueAlias}.event_pk = ${compiler.eventAlias}.event_pk AND ${valueAlias}.site_pk = ${compiler.eventAlias}.site_pk AND ${pathAlias}.site_pk = ${compiler.eventAlias}.site_pk AND ${pathAlias}.path = ${push(compiler, condition.target.path)}`;
  const exists = (extra = "") =>
    `EXISTS (SELECT 1 FROM custom_event_json_values ${valueAlias} INNER JOIN custom_event_json_paths ${pathAlias} ON ${pathAlias}.id = ${valueAlias}.path_id WHERE ${base}${extra})`;
  if (condition.operator === "exists") return exists();
  if (condition.operator === "notExists") return `NOT ${exists()}`;
  if (condition.operator === "isNull")
    return exists(` AND ${valueAlias}.value_type = 0`);
  if (condition.operator === "notNull")
    return exists(` AND ${valueAlias}.value_type != 0`);
  if (condition.operator === "isEmpty")
    return exists(
      ` AND ${valueAlias}.value_type = 1 AND ${valueAlias}.string_value = ''`,
    );
  if (condition.operator === "notEmpty")
    return exists(
      ` AND ${valueAlias}.value_type = 1 AND ${valueAlias}.string_value != ''`,
    );
  const values = Array.isArray(condition.value)
    ? condition.value
    : [condition.value!];
  const types = [...new Set(values.map(payloadValueType))];
  if (types.length !== 1)
    throw new TypeError("Payload set filters require values of one JSON type.");
  const type = types[0]!;
  const valueColumn = payloadValueColumn(valueAlias, values[0]!);
  if (condition.operator === "between") {
    return exists(
      ` AND ${valueAlias}.value_type = ${push(compiler, type)} AND ${valueColumn} BETWEEN ${push(compiler, scalar(values[0]!))} AND ${push(compiler, scalar(values[1]!))}`,
    );
  }
  if (condition.operator === "in" || condition.operator === "notIn") {
    if (values.length >= JSON_EACH_SET_THRESHOLD) {
      const valueSet = push(compiler, jsonSet(values));
      const typeBinding = push(compiler, type);
      return exists(
        ` AND ${valueColumn} ${condition.operator === "in" ? "IN" : "NOT IN"} (SELECT value FROM json_each(${valueSet})) AND ${valueAlias}.value_type = ${typeBinding}`,
      );
    }
    const bindings = values
      .map((value) => push(compiler, scalar(value)))
      .join(", ");
    return exists(
      ` AND ${valueAlias}.value_type = ${push(compiler, type)} AND ${valueColumn} ${condition.operator === "in" ? "IN" : "NOT IN"} (${bindings})`,
    );
  }
  const value = values[0]!;
  if (
    condition.operator === "contains" ||
    condition.operator === "startsWith" ||
    condition.operator === "endsWith"
  ) {
    if (typeof value !== "string")
      throw new TypeError("Payload string matching requires a string.");
    const escaped = escapedLike(value);
    const pattern =
      condition.operator === "contains"
        ? `%${escaped}%`
        : condition.operator === "startsWith"
          ? `${escaped}%`
          : `%${escaped}`;
    return exists(
      ` AND ${valueAlias}.value_type = 1 AND ${valueAlias}.string_value LIKE ${push(compiler, pattern)} ESCAPE '\\'`,
    );
  }
  const operator: Record<string, string> = {
    eq: "=",
    neq: "!=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  };
  if (value === null)
    return exists(
      ` AND ${valueAlias}.value_type ${operator[condition.operator]!} ${push(compiler, 0)}`,
    );
  const binding = typeof value === "boolean" ? (value ? 1 : 0) : scalar(value);
  return exists(
    ` AND ${valueAlias}.value_type = ${push(compiler, type)} AND ${valueColumn} ${operator[condition.operator]!} ${push(compiler, binding)}`,
  );
}

function condition(compiler: Compiler, item: FilterCondition): string {
  if (item.target.kind === "event-payload")
    return payloadComparison(compiler, item);
  const field = analyticsFilterDefinition(item.target.field);
  if (!field)
    throw new TypeError(`No filter definition for ${item.target.field}.`);
  const strategy = compilerStrategyFor(field);
  if (strategy === "session.boundary.entry")
    return sessionBoundary(compiler, item, "entry");
  if (strategy === "session.boundary.exit")
    return sessionBoundary(compiler, item, "exit");
  return comparison(
    compiler,
    field,
    directColumn(compiler, strategy),
    item.operator,
    item.value,
  );
}

function expression(compiler: Compiler, item: FilterExpression): string {
  if (item.kind === "condition") return condition(compiler, item);
  if (item.kind === "not") return `(NOT (${expression(compiler, item.child)}))`;
  if (item.kind === "or") return orExpression(compiler, item.children);
  const operator = item.kind === "and" ? " AND " : " OR ";
  return `(${item.children.map((child) => expression(compiler, child)).join(operator)})`;
}

export function compileFilterDocument(
  document: FilterDocument,
  options: FilterCompilerOptions = {},
): FilterSql {
  const cacheKey = [
    options.alias ?? "visit_source",
    options.sessionSource ?? "visit_source",
    options.eventAlias ?? options.alias ?? "event_source",
  ].join("\u0000");
  const cachedByOptions = FILTER_SQL_CACHE.get(document);
  const cached = cachedByOptions?.get(cacheKey);
  if (cached) return cached;

  const normalized = normalizeFilterDocument(document, analyticsFilterRegistry);
  if (!normalized.root) {
    const result = { clause: "", bindings: [] } as const;
    (cachedByOptions ?? new Map()).set(cacheKey, result);
    if (!cachedByOptions)
      FILTER_SQL_CACHE.set(document, new Map([[cacheKey, result]]));
    return result;
  }
  const compiler: Compiler = {
    alias: validAlias(options.alias ?? "visit_source", "alias"),
    sessionSource: validAlias(
      options.sessionSource ?? "visit_source",
      "session source",
    ),
    eventAlias: validAlias(
      options.eventAlias ?? options.alias ?? "event_source",
      "event alias",
    ),
    bindings: [],
    payloadIndex: 0,
    orLikeIndex: 0,
  };
  const result = {
    clause: `WHERE ${expression(compiler, normalized.root)}`,
    bindings: compiler.bindings,
  };
  const optionsCache = cachedByOptions ?? new Map<string, FilterSql>();
  optionsCache.set(cacheKey, result);
  if (!cachedByOptions) FILTER_SQL_CACHE.set(document, optionsCache);
  return result;
}
