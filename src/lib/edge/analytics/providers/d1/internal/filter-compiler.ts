import { buildTrafficChannelSqlExpression } from "@/lib/analytics/traffic-channel-rules";
import { browserEngineCaseSql } from "@/lib/browser-engine";
import {
  analyticsFilterDefinition,
  analyticsFilterRegistry,
  type FilterColumnStrategy,
  type FilterCompilerStrategy,
  type RegisteredFilterField,
} from "@/lib/filter-contract/filter-registry";
import {
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterOperator,
  type FilterValue,
  isLegacyFilterTarget,
  legacyConditionValue,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

import { compileExactJsonPointerPredicate } from "./filter-json-pointer";
import { JSON_EACH_SET_THRESHOLD } from "./filter-sql-set";

export { JSON_EACH_SET_THRESHOLD } from "./filter-sql-set";
export type FilterSqlBinding = string | number;

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

function stringMatchExpression(
  left: string,
  right: string,
  operator: "contains" | "startsWith" | "endsWith",
): string {
  if (operator === "contains") return `INSTR(${left}, ${right}) > 0`;
  if (operator === "startsWith")
    return `SUBSTR(${left}, 1, LENGTH(${right})) = ${right}`;
  return `(LENGTH(${right}) = 0 OR SUBSTR(${left}, -LENGTH(${right})) = ${right})`;
}

function boundStringMatch(
  compiler: Compiler,
  left: string,
  value: string,
  operator: "contains" | "startsWith" | "endsWith",
): string {
  if (operator === "contains")
    return `INSTR(${left}, ${push(compiler, value)}) > 0`;
  if (operator === "startsWith") {
    const lengthValue = push(compiler, value);
    const compareValue = push(compiler, value);
    return `SUBSTR(${left}, 1, LENGTH(${lengthValue})) = ${compareValue}`;
  }
  const emptyValue = push(compiler, value);
  const lengthValue = push(compiler, value);
  const compareValue = push(compiler, value);
  return `(LENGTH(${emptyValue}) = 0 OR SUBSTR(${left}, -LENGTH(${lengthValue})) = ${compareValue})`;
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
  operator: FilterOperator,
): string | number {
  return field.profile === "direct-referrer" &&
    value === "__direct__" &&
    ["eq", "neq", "in", "notIn"].includes(operator)
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
    value: storedComparisonValue(field, item.value, item.operator),
  };
}

function vectorKey(item: OrVectorCondition): string {
  return `${item.field.id}\u0000${item.operator}`;
}

function jsonOrStringComparison(
  compiler: Compiler,
  item: OrVectorCondition,
  values: readonly string[],
): string {
  if (item.operator === "eq")
    throw new TypeError("Equality uses the scalar JSON set comparison.");
  const normalized = normalizedColumn(item.field, item.source);
  const alias = `filter_or_like_${compiler.orLikeIndex}`;
  compiler.orLikeIndex += 1;
  const value =
    item.field.comparison === "case-insensitive"
      ? `LOWER(TRIM(${alias}.value))`
      : `TRIM(${alias}.value)`;
  return `EXISTS (
    SELECT 1
    FROM json_each(${push(compiler, JSON.stringify(values))}) AS ${alias}
    WHERE ${stringMatchExpression(normalized, value, item.operator)}
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
  return jsonOrStringComparison(compiler, item, values as readonly string[]);
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
  if (operator === "isEmpty") return `${source} IS NOT NULL AND ${source} = ''`;
  if (operator === "notEmpty")
    return `${source} IS NOT NULL AND ${source} != ''`;
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
    return boundStringMatch(compiler, normalized, String(binding), operator);
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
    legacyConditionValue(condition.value),
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

/** Route ordinary Event Payloads through the same exact node-navigation SQL
 * as advanced Filter conditions. Path dictionaries normalize array indices and
 * scalar value tables omit containers; neither can implement RFC 6901 alone.
 */
function payloadComparison(
  compiler: Compiler,
  condition: FilterCondition,
): string {
  if (condition.target.kind !== "event-payload") {
    throw new TypeError("Payload compiler requires an event-payload target.");
  }
  const result = compileExactJsonPointerPredicate(
    condition,
    compiler.eventAlias,
  );
  compiler.bindings.push(...result.bindings);
  return result.sql;
}

function condition(compiler: Compiler, item: FilterCondition): string {
  if (!isLegacyFilterTarget(item.target)) {
    throw new TypeError("unsupported_filter_expression");
  }
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
    legacyConditionValue(item.value),
  );
}

function expression(compiler: Compiler, item: FilterExpression): string {
  if (item.kind === "condition") return condition(compiler, item);
  if (item.kind === "not") return `(NOT (${expression(compiler, item.child)}))`;
  if (item.kind === "or") return orExpression(compiler, item.children);
  const operator = item.kind === "and" ? " AND " : " OR ";
  return `(${item.children.map((child) => expression(compiler, child)).join(operator)})`;
}

/**
 * Return a registered Field's scalar SQL expression for a locally bound row.
 * The caller is responsible for providing the appropriate source relation,
 * applicability and entity identity; this does not compile an entire query.
 */
export function compileRegisteredFieldScalar(
  fieldId: string,
  alias: string,
): string {
  const field = analyticsFilterDefinition(fieldId);
  if (!field) throw new TypeError(`Unknown registered Field: ${fieldId}.`);
  const valid = validAlias(alias, "Scalar row alias");
  const compiler: Compiler = {
    alias: valid,
    eventAlias: valid,
    sessionSource: "scope_raw_visits",
    bindings: [],
    payloadIndex: 0,
    orLikeIndex: 0,
  };
  return directColumn(compiler, compilerStrategyFor(field));
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
