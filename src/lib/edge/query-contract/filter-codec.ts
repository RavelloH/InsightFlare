import {
  type CanonicalJsonPath,
  DEFAULT_FILTER_LIMITS,
  FILTER_DOCUMENT_VERSION,
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterFieldId,
  type FilterFieldRegistry,
  type FilterOperator,
  FilterValidationError,
  type FilterValue,
  normalizeFilterDocument,
} from "./filters";

export class FilterCodecError extends Error {
  readonly code: string;
  readonly path: string;

  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "FilterCodecError";
    this.code = code;
    this.path = path;
  }
}

const OPERATOR_ALIASES: Readonly<Record<string, FilterOperator>> = {
  eq: "eq",
  ne: "neq",
  neq: "neq",
  in: "in",
  nin: "notIn",
  notIn: "notIn",
  c: "contains",
  contains: "contains",
  sw: "startsWith",
  startsWith: "startsWith",
  ew: "endsWith",
  endsWith: "endsWith",
  gt: "gt",
  gte: "gte",
  lt: "lt",
  lte: "lte",
  bt: "between",
  between: "between",
  ex: "exists",
  exists: "exists",
  nex: "notExists",
  notExists: "notExists",
  null: "isNull",
  isNull: "isNull",
  nnull: "notNull",
  notNull: "notNull",
  empty: "isEmpty",
  isEmpty: "isEmpty",
  nempty: "notEmpty",
  notEmpty: "notEmpty",
};

const VALUELESS = new Set<FilterOperator>([
  "exists",
  "notExists",
  "isNull",
  "notNull",
  "isEmpty",
  "notEmpty",
]);
const LIST = new Set<FilterOperator>(["in", "notIn"]);

export interface FilterCodecOptions {
  readonly limits?: Partial<typeof DEFAULT_FILTER_LIMITS>;
  readonly strictFilterKeys?: boolean;
}

type Scope = {
  readonly direct: FilterExpression[];
  readonly or: Map<string, Map<number, Scope>>;
  readonly not: Map<string, Scope>;
};

function fail(code: string, path: string, message: string): never {
  throw new FilterCodecError(code, path, message);
}

function scope(): Scope {
  return { direct: [], or: new Map(), not: new Map() };
}

function splitEscapedList(raw: string): string[] {
  const values: string[] = [];
  let value = "";
  let escaped = false;
  for (const character of raw) {
    if (escaped) {
      value +=
        character === "," || character === "\\" ? character : `\\${character}`;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === ",") {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  if (escaped) value += "\\";
  values.push(value);
  return values;
}

function escapeListValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(",", "\\,");
}

function parseInput(input: string | URL | URLSearchParams): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (input instanceof URL) return input.searchParams;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input))
    return new URL(input).searchParams;
  return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
}

function fieldDefinition(registry: FilterFieldRegistry, field: string) {
  const definition = registry.get(field);
  if (!definition)
    fail("unknown_field", field, `Unknown filter field: ${field}`);
  return definition;
}

function parseTypedValue(
  raw: string,
  definition: ReturnType<typeof fieldDefinition>,
  path: string,
): FilterValue {
  switch (definition.valueKind) {
    case "number": {
      if (raw.trim() === "")
        fail("invalid_number", path, "Expected a finite number.");
      const value = Number(raw);
      if (!Number.isFinite(value))
        fail("invalid_number", path, "Expected a finite number.");
      return value;
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return fail("invalid_boolean", path, "Expected true or false.");
    case "date":
    case "datetime":
    case "string":
    case "enum":
    case "json-scalar":
      return raw;
  }
}

function parsePayloadValue(raw: string, path: string): FilterValue {
  if (!raw.startsWith("json:")) return raw;
  try {
    const value: unknown = JSON.parse(raw.slice(5));
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      if (typeof value === "number" && !Number.isFinite(value)) {
        fail(
          "invalid_json_scalar",
          path,
          "Payload JSON numbers must be finite.",
        );
      }
      return value;
    }
  } catch {
    // The stable protocol error below intentionally hides JSON parser details.
  }
  fail("invalid_json_scalar", path, "Payload values must be JSON scalars.");
}

function parseCondition(
  field: string,
  payloadPath: string | undefined,
  raw: string,
  registry: FilterFieldRegistry,
  limits: typeof DEFAULT_FILTER_LIMITS,
): FilterCondition {
  const definition = fieldDefinition(registry, field);
  let operator: FilterOperator = "eq";
  let operand = raw;
  const unary = OPERATOR_ALIASES[raw];
  if (unary && VALUELESS.has(unary)) operator = unary;
  else {
    const colon = raw.indexOf(":");
    if (colon > 0 && OPERATOR_ALIASES[raw.slice(0, colon)]) {
      operator = OPERATOR_ALIASES[raw.slice(0, colon)]!;
      operand = raw.slice(colon + 1);
    }
  }
  if (!definition.operators.has(operator)) {
    fail(
      "operator_not_allowed",
      field,
      `Operator ${operator} is not allowed for ${field}.`,
    );
  }
  const target = payloadPath
    ? { kind: "event-payload" as const, path: payloadPath as CanonicalJsonPath }
    : { kind: "field" as const, field: definition.id as FilterFieldId };
  if (VALUELESS.has(operator)) return { kind: "condition", target, operator };
  if (LIST.has(operator) || operator === "between") {
    const values = splitEscapedList(operand);
    if (
      LIST.has(operator) &&
      (values.length === 0 || values.length > limits.maxSetValues)
    ) {
      fail("invalid_set", field, "Set filter has an invalid number of values.");
    }
    if (operator === "between" && values.length !== 2) {
      fail("invalid_range", field, "between requires exactly two values.");
    }
    return {
      kind: "condition",
      target,
      operator,
      value: values.map((value, index) =>
        field === "event.payload"
          ? parsePayloadValue(value, `${field}[${index}]`)
          : parseTypedValue(value, definition, `${field}[${index}]`),
      ),
    };
  }
  return {
    kind: "condition",
    target,
    operator,
    value:
      field === "event.payload"
        ? parsePayloadValue(operand, field)
        : parseTypedValue(operand, definition, field),
  };
}

function parseKey(
  key: string,
): { field: string; payloadPath?: string; logic: string } | null {
  const match = /^filter\[([^[]+?)\](.*)$/.exec(key);
  if (!match) return null;
  const field = match[1]!;
  const rest = match[2]!;
  const parts: string[] = [];
  const pattern = /\[([^[]*?)\]/g;
  let cursor = 0;
  let item: RegExpExecArray | null;
  while ((item = pattern.exec(rest))) {
    if (item.index !== cursor)
      fail("invalid_filter_key", key, "Malformed filter key.");
    parts.push(item[1]!);
    cursor = pattern.lastIndex;
  }
  if (cursor !== rest.length)
    fail("invalid_filter_key", key, "Malformed filter key.");
  let payloadPath: string | undefined;
  let logic = "";
  if (field === "event.payload" && parts[0]?.startsWith("/")) {
    payloadPath = parts.shift();
  }
  if (parts.length > 1)
    fail("invalid_filter_key", key, "A filter key may have one logic path.");
  logic = parts[0] ?? "";
  return { field, ...(payloadPath ? { payloadPath } : {}), logic };
}

function parseLogic(
  logic: string,
  maxDepth: number,
): Array<{ kind: "or" | "not"; group: string; branch?: number }> {
  if (!logic) return [];
  const tokens = logic.split(".");
  const result: Array<{ kind: "or" | "not"; group: string; branch?: number }> =
    [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const or = /^or(?::(\d+))?$/.exec(token);
    if (or) {
      const branch = tokens[++index];
      if (
        !branch ||
        !/^\d+$/.test(branch) ||
        Number(branch) > Number.MAX_SAFE_INTEGER
      ) {
        fail(
          "invalid_logic_path",
          logic,
          "or must be followed by a safe branch index.",
        );
      }
      result.push({
        kind: "or",
        group: or[1] ?? "default",
        branch: Number(branch),
      });
      continue;
    }
    const not = /^not(?::(\d+))?$/.exec(token);
    if (not) {
      result.push({ kind: "not", group: not[1] ?? "default" });
      continue;
    }
    fail("invalid_logic_path", logic, `Invalid logic token: ${token}`);
  }
  if (result.length > maxDepth)
    fail("too_deep", logic, "Filter logic is nested too deeply.");
  return result;
}

function insert(
  root: Scope,
  steps: ReturnType<typeof parseLogic>,
  condition: FilterCondition,
): void {
  let current = root;
  for (const step of steps) {
    if (step.kind === "or") {
      let groups = current.or.get(step.group);
      if (!groups) current.or.set(step.group, (groups = new Map()));
      let branch = groups.get(step.branch!);
      if (!branch) groups.set(step.branch!, (branch = scope()));
      current = branch;
    } else {
      let nested = current.not.get(step.group);
      if (!nested) current.not.set(step.group, (nested = scope()));
      current = nested;
    }
  }
  current.direct.push(condition);
}

function scopeExpression(value: Scope): FilterExpression | null {
  const children: FilterExpression[] = [...value.direct];
  for (const groups of value.or.values()) {
    const branches = [...groups.values()]
      .map(scopeExpression)
      .filter(Boolean) as FilterExpression[];
    if (branches.length === 1) children.push(branches[0]!);
    else if (branches.length > 1)
      children.push({ kind: "or", children: branches });
  }
  for (const nested of value.not.values()) {
    const child = scopeExpression(nested);
    if (child) children.push({ kind: "not", child });
  }
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { kind: "and", children };
}

export function parseFilterParams(
  input: string | URL | URLSearchParams,
  registry: FilterFieldRegistry,
  options: FilterCodecOptions = {},
): FilterDocument {
  const limits = { ...DEFAULT_FILTER_LIMITS, ...(options.limits ?? {}) };
  const root = scope();
  let conditions = 0;
  for (const [key, value] of parseInput(input).entries()) {
    const parsed = parseKey(key);
    if (!parsed) {
      if (key.startsWith("filter[") && options.strictFilterKeys !== false) {
        fail("invalid_filter_key", key, "Malformed filter key.");
      }
      continue;
    }
    if (parsed.field === "event.payload" && !parsed.payloadPath) {
      fail(
        "invalid_target",
        key,
        "event.payload requires a JSON Pointer path.",
      );
    }
    if (value.length > limits.maxValueLength)
      fail("value_too_long", key, "Filter value is too long.");
    insert(
      root,
      parseLogic(parsed.logic, limits.maxDepth),
      parseCondition(parsed.field, parsed.payloadPath, value, registry, limits),
    );
    conditions += 1;
    if (conditions > limits.maxConditions)
      fail("too_many_conditions", key, "Filter condition limit exceeded.");
  }
  try {
    return normalizeFilterDocument(
      { version: FILTER_DOCUMENT_VERSION, root: scopeExpression(root) },
      registry,
      limits,
    );
  } catch (error) {
    if (error instanceof FilterValidationError)
      throw new FilterCodecError(error.code, error.path, error.message);
    throw error;
  }
}

function conditionValue(
  value: FilterValue | readonly FilterValue[] | undefined,
  operator: FilterOperator,
  isTypeless: boolean,
): string {
  if (VALUELESS.has(operator))
    return operator === "exists"
      ? "ex"
      : operator === "notExists"
        ? "nex"
        : operator === "isEmpty"
          ? "empty"
          : operator === "notEmpty"
            ? "nempty"
            : operator === "isNull"
              ? "null"
              : "nnull";
  const values = Array.isArray(value) ? value : [value];
  const needsListEscaping = LIST.has(operator) || operator === "between";
  const encodeItem = (item: FilterValue): string => {
    let wire: string;
    if (isTypeless) {
      // json-scalar fields have no declared value kind, so values carry an
      // explicit json: marker. Strings are quoted (JSON string literal) so a
      // literal string value that itself begins with "json:" is never
      // mistaken for a marker on reparse.
      wire =
        typeof item === "string" && !item.startsWith("json:")
          ? item
          : `json:${JSON.stringify(item)}`;
    } else {
      // Typed fields know their value kind, so values are plain text and the
      // parser converts them via the field definition on reparse.
      wire = item === null ? "" : String(item);
    }
    return needsListEscaping ? escapeListValue(wire) : wire;
  };
  const encoded = values.map(encodeItem);
  const alias =
    Object.entries(OPERATOR_ALIASES).find(
      ([, candidate]) => candidate === operator,
    )?.[0] ?? operator;
  if (operator === "eq") {
    const raw = encoded[0]!;
    const colon = raw.indexOf(":");
    const looksLikeDsl =
      Boolean(OPERATOR_ALIASES[raw]) ||
      (colon > 0 && Boolean(OPERATOR_ALIASES[raw.slice(0, colon)]));
    return looksLikeDsl ? `eq:${raw}` : raw;
  }
  return `${alias}:${encoded.join(",")}`;
}

function serializeExpression(
  expression: FilterExpression,
  path: string[],
  pairs: Array<[string, string]>,
  registry: FilterFieldRegistry,
): void {
  const children =
    expression.kind === "and" ? expression.children : [expression];
  const orGroups = children.filter((child) => child.kind === "or");
  const notGroups = children.filter((child) => child.kind === "not");
  for (const child of children) {
    if (child.kind === "condition") {
      const field =
        child.target.kind === "field" ? child.target.field : "event.payload";
      const targetPath =
        child.target.kind === "event-payload" ? `[${child.target.path}]` : "";
      const isTypeless = registry.get(field)?.valueKind === "json-scalar";
      pairs.push([
        `filter[${field}]${targetPath}${path.length ? `[${path.join(".")}]` : ""}`,
        conditionValue(child.value, child.operator, isTypeless),
      ]);
    } else if (child.kind === "not") {
      const index = notGroups.indexOf(child);
      const token = notGroups.length === 1 ? "not" : `not:${index}`;
      serializeExpression(child.child, [...path, token], pairs, registry);
    } else {
      const index = orGroups.indexOf(child);
      const token = orGroups.length === 1 ? "or" : `or:${index}`;
      child.children.forEach((branch, branchIndex) =>
        serializeExpression(
          branch,
          [...path, token, String(branchIndex)],
          pairs,
          registry,
        ),
      );
    }
  }
}

export function serializeFilterParams(
  document: FilterDocument,
  registry: FilterFieldRegistry,
): URLSearchParams {
  const normalized = normalizeFilterDocument(document, registry);
  const pairs: Array<[string, string]> = [];
  if (normalized.root)
    serializeExpression(normalized.root, [], pairs, registry);
  pairs.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  const params = new URLSearchParams();
  for (const [key, value] of pairs) params.append(key, value);
  return params;
}

export function serializeFilterQuery(
  document: FilterDocument,
  registry: FilterFieldRegistry,
): string {
  return serializeFilterParams(document, registry).toString();
}

export function applyFiltersToUrl(
  input: string | URL,
  document: FilterDocument,
  registry: FilterFieldRegistry,
): URL {
  const url = new URL(String(input));
  for (const key of [...url.searchParams.keys()])
    if (key.startsWith("filter[")) url.searchParams.delete(key);
  for (const [key, value] of serializeFilterParams(document, registry))
    url.searchParams.append(key, value);
  return url;
}
