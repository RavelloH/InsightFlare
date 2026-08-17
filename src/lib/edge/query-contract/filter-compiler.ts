import { browserEngineCaseSql } from "@/lib/browser-engine";

import {
  analyticsFilterDefinition,
  analyticsFilterRegistry,
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
};

const FIELD_COLUMNS: Readonly<Record<string, string>> = {
  "page.path": "pathname",
  "page.title": "title",
  "page.hostname": "hostname",
  "page.query": "query_string",
  "page.hash": "hash_fragment",
  "referrer.domain": "referrer_host",
  "referrer.url": "referrer_url",
  "utm.source": "utm_source",
  "utm.medium": "utm_medium",
  "utm.campaign": "utm_campaign",
  "utm.term": "utm_term",
  "utm.content": "utm_content",
  "client.browser": "browser",
  "client.browserVersion": "browser_version",
  "client.os": "os",
  "client.deviceType": "device_type",
  "client.language": "language",
  "geo.country": "country",
  "geo.region": "region",
  "geo.city": "city",
  "geo.continent": "continent",
  "geo.timeZone": "timezone",
  "geo.organization": "as_organization",
  "event.name": "event_name",
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

function directColumn(compiler: Compiler, fieldId: string): string {
  if (fieldId === "event.name") return `${compiler.eventAlias}.event_name`;
  if (fieldId === "client.browserEngine") {
    return browserEngineCaseSql(
      column(compiler, "browser"),
      column(compiler, "os"),
    );
  }
  if (fieldId === "client.osVersion") {
    return `TRIM(CASE WHEN ${column(compiler, "os")} != '' AND ${column(compiler, "os_version")} != '' THEN ${column(compiler, "os")} || ' ' || ${column(compiler, "os_version")} WHEN ${column(compiler, "os")} != '' THEN ${column(compiler, "os")} WHEN ${column(compiler, "os_version")} != '' THEN ${column(compiler, "os_version")} ELSE '' END)`;
  }
  if (fieldId === "client.screenSize") {
    return `CASE WHEN ${column(compiler, "screen_width")} IS NOT NULL AND ${column(compiler, "screen_height")} IS NOT NULL THEN CAST(${column(compiler, "screen_width")} AS TEXT) || 'x' || CAST(${column(compiler, "screen_height")} AS TEXT) ELSE '' END`;
  }
  const name = FIELD_COLUMNS[fieldId];
  if (!name)
    throw new TypeError(`No SQL column strategy registered for ${fieldId}.`);
  return column(compiler, name);
}

function normalizedColumn(
  field: RegisteredFilterField,
  expression: string,
): string {
  const trimmed = `TRIM(COALESCE(${expression}, ''))`;
  return field.comparison === "case-insensitive"
    ? `LOWER(${trimmed})`
    : trimmed;
}

function push(compiler: Compiler, value: FilterSqlBinding): string {
  compiler.bindings.push(value);
  return "?";
}

function scalar(value: FilterValue): FilterSqlBinding {
  if (value === null || typeof value === "boolean") {
    throw new TypeError(
      "This SQL predicate requires a non-null scalar binding.",
    );
  }
  return value;
}

function escapedLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
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
      return `${normalized} BETWEEN ${push(compiler, scalar(value[0]!))} AND ${push(compiler, scalar(value[1]!))}`;
    }
    const placeholders = value
      .map((item) => push(compiler, scalar(item)))
      .join(", ");
    return `${normalized} ${operator === "notIn" ? "NOT IN" : "IN"} (${placeholders})`;
  }
  const binding = scalar(value as FilterValue);
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
  return `${column(compiler, "session_id")} IN (
    SELECT session_id FROM (
      SELECT session_id, MAX(CASE WHEN ${rank} = 1 THEN pathname END) AS ${boundary}
      FROM (
        SELECT edge.session_id, edge.pathname,
          ROW_NUMBER() OVER (PARTITION BY edge.session_id ORDER BY edge.started_at ${rankOrder}, edge.visit_id ${rankOrder}) AS ${rank}
        FROM ${compiler.sessionSource} edge
        WHERE TRIM(COALESCE(edge.session_id, '')) != ''
      ) session_edges
      GROUP BY session_id
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
  const base = `${valueAlias}.event_pk = ${compiler.eventAlias}.event_pk AND ${valueAlias}.site_id = ${compiler.eventAlias}.site_id AND ${pathAlias}.path = ${push(compiler, condition.target.path)}`;
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
  if (field.id === "session.entryPath")
    return sessionBoundary(compiler, item, "entry");
  if (field.id === "session.exitPath")
    return sessionBoundary(compiler, item, "exit");
  return comparison(
    compiler,
    field,
    directColumn(compiler, field.id),
    item.operator,
    item.value,
  );
}

function expression(compiler: Compiler, item: FilterExpression): string {
  if (item.kind === "condition") return condition(compiler, item);
  if (item.kind === "not") return `(NOT (${expression(compiler, item.child)}))`;
  const operator = item.kind === "and" ? " AND " : " OR ";
  return `(${item.children.map((child) => expression(compiler, child)).join(operator)})`;
}

export function compileFilterDocument(
  document: FilterDocument,
  options: FilterCompilerOptions = {},
): FilterSql {
  const normalized = normalizeFilterDocument(document, analyticsFilterRegistry);
  if (!normalized.root) return { clause: "", bindings: [] };
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
  };
  return {
    clause: `WHERE ${expression(compiler, normalized.root)}`,
    bindings: compiler.bindings,
  };
}
