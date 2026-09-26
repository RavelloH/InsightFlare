import {
  formatFilterDsl,
  formatFilterTargetExpression,
  parseFilterDsl,
} from "./filter-dsl";
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
  type FilterTargetExpression,
  FilterValidationError,
  type FilterValue,
  isLegacyFilterTarget,
  legacyConditionValue,
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
type SelectorReferenceKind =
  | "event"
  | "page"
  | "session"
  | "visitor"
  | "period"
  | "bucket"
  | "sequence"
  | "value";

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

function parseComplexCondition(
  target: string,
  raw: string,
  registry: FilterFieldRegistry,
  key: string,
  resolveSelector?: (reference: string) => FilterTargetExpression,
): FilterCondition {
  const parse = (source: string) => {
    const prepared = prepareSelectorReferences(source, resolveSelector);
    const document = parseFilterDsl(prepared.source, registry);
    if (!document.root || document.root.kind !== "condition") {
      fail(
        "invalid_complex_filter",
        key,
        "Expected one condition for the complex filter target.",
      );
    }
    return {
      ...document.root,
      target: replaceSelectorMarkers(
        document.root.target,
        prepared.markers,
        resolveSelector,
      ),
    };
  };
  // Canonical DSL suffixes (emitted by this codec) keep computed literal
  // types intact. The operator:value spelling also remains accepted for the
  // compact form documented by Filter v1.
  if (
    /^(?:eq|neq|in|notIn|contains|startsWith|endsWith|gt|gte|lt|lte|between|exists|notExists|isNull|notNull|isEmpty|notEmpty)(?:\s|$)/i.test(
      raw,
    )
  ) {
    return parse(`${target} ${raw}`);
  }
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const alias = raw.slice(0, colon);
    const operand = raw.slice(colon + 1);
    const operator = OPERATOR_ALIASES[alias];
    if (operator) {
      if (VALUELESS.has(operator)) return parse(`${target} ${operator}`);
      const untyped = `${target} ${operator} ${operand}`;
      try {
        return parse(untyped);
      } catch {
        return parse(`${target} ${operator} ${JSON.stringify(operand)}`);
      }
    }
  }
  return parse(`${target} ${raw}`);
}

const SELECTOR_REFERENCE =
  /\b(event|page|session|visitor|period|bucket|sequence|value):(\d+)\b/giu;

function selectorReferenceParts(reference: string): {
  readonly entity: SelectorReferenceKind;
  readonly index: number;
} | null {
  const match =
    /^(event|page|session|visitor|period|bucket|sequence|value):(\d+)$/iu.exec(
      reference,
    );
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return {
    entity: match[1]!.toLowerCase() as SelectorReferenceKind,
    index: Number(match[2]),
  };
}

function replaceSelectorReferencesOutsideStrings(
  source: string,
  getMarker: (reference: string) => string,
): string {
  let result = "";
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length;) {
    const character = source[index]!;
    if (quoted) {
      result += character;
      index += 1;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      result += character;
      index += 1;
      continue;
    }
    const match =
      /^(event|page|session|visitor|period|bucket|sequence|value):(\d+)\b/iu.exec(
        source.slice(index),
      );
    if (match) {
      const reference = `${match[1]!.toLowerCase()}:${Number(match[2])}`;
      result += getMarker(reference);
      index += match[0].length;
    } else {
      result += character;
      index += 1;
    }
  }
  return result;
}

function prepareSelectorReferences(
  source: string,
  resolveSelector?: (reference: string) => FilterTargetExpression,
): { readonly source: string; readonly markers: ReadonlyMap<string, string> } {
  const markers = new Map<string, string>();
  SELECTOR_REFERENCE.lastIndex = 0;
  const hasReferences = SELECTOR_REFERENCE.test(source);
  SELECTOR_REFERENCE.lastIndex = 0;
  if (!resolveSelector || !hasReferences) {
    return { source, markers };
  }
  let index = 0;
  const rewritten = replaceSelectorReferencesOutsideStrings(
    source,
    (reference) => {
      let marker = `__insightflare_filter_url_ref_${index}__`;
      while (source.includes(marker)) marker += "_";
      markers.set(marker, reference);
      index += 1;
      return `event { event.name eq ${JSON.stringify(marker)} }`;
    },
  );
  return { source: rewritten, markers };
}

function replaceSelectorMarkers(
  target: FilterTargetExpression,
  markers: ReadonlyMap<string, string>,
  resolveSelector?: (reference: string) => FilterTargetExpression,
): FilterTargetExpression {
  if (target.kind === "selector" && target.predicate.kind === "condition") {
    const condition = target.predicate;
    const marker =
      condition.target.kind === "field" &&
      condition.target.field === "event.name" &&
      condition.operator === "eq" &&
      typeof condition.value === "string"
        ? condition.value
        : null;
    const reference = marker ? markers.get(marker) : undefined;
    if (reference && resolveSelector) return resolveSelector(reference);
  }
  switch (target.kind) {
    case "member":
      return {
        ...target,
        object: replaceSelectorMarkers(target.object, markers, resolveSelector),
      };
    case "selector":
      return {
        ...target,
        collection: replaceSelectorMarkers(
          target.collection,
          markers,
          resolveSelector,
        ),
        predicate: replaceSelectorMarkersExpression(
          target.predicate,
          markers,
          resolveSelector,
        ),
      };
    case "projection":
      return {
        ...target,
        collection: replaceSelectorMarkers(
          target.collection,
          markers,
          resolveSelector,
        ),
      };
    case "reducer":
      return {
        ...target,
        input: replaceSelectorMarkers(target.input, markers, resolveSelector),
      };
    case "arithmetic":
      return {
        ...target,
        left: replaceSelectorMarkers(target.left, markers, resolveSelector),
        right: replaceSelectorMarkers(target.right, markers, resolveSelector),
      };
    case "bucket":
      return {
        ...target,
        input: replaceSelectorMarkers(target.input, markers, resolveSelector),
      };
    case "window":
      return {
        ...target,
        collection: replaceSelectorMarkers(
          target.collection,
          markers,
          resolveSelector,
        ),
        anchor: replaceSelectorMarkers(target.anchor, markers, resolveSelector),
      };
    case "periods":
      return {
        ...target,
        collection: replaceSelectorMarkers(
          target.collection,
          markers,
          resolveSelector,
        ),
      };
    case "sequence":
      return {
        ...target,
        steps: target.steps.map((step) =>
          replaceSelectorMarkers(step, markers, resolveSelector),
        ),
      };
    case "adjacent":
      return {
        ...target,
        sequence: replaceSelectorMarkers(
          target.sequence,
          markers,
          resolveSelector,
        ),
      };
    case "without":
      return {
        ...target,
        sequence: replaceSelectorMarkers(
          target.sequence,
          markers,
          resolveSelector,
        ),
        excluded: replaceSelectorMarkers(
          target.excluded,
          markers,
          resolveSelector,
        ),
      };
    default:
      return target;
  }
}

function replaceSelectorMarkersExpression(
  expression: FilterExpression,
  markers: ReadonlyMap<string, string>,
  resolveSelector?: (reference: string) => FilterTargetExpression,
): FilterExpression {
  if (expression.kind === "condition")
    return {
      ...expression,
      target: replaceSelectorMarkers(
        expression.target,
        markers,
        resolveSelector,
      ),
    };
  if (expression.kind === "not")
    return {
      ...expression,
      child: replaceSelectorMarkersExpression(
        expression.child,
        markers,
        resolveSelector,
      ),
    };
  return {
    ...expression,
    children: expression.children.map((child) =>
      replaceSelectorMarkersExpression(child, markers, resolveSelector),
    ),
  };
}

function parseKey(
  key: string,
): { field: string; payloadPath?: string; parts: string[] } | null {
  if (!key.startsWith("filter[")) return null;
  const readBracket = (
    start: number,
  ): { value: string; end: number } | null => {
    if (key[start] !== "[") return null;
    let depth = 1;
    let quoted = false;
    let escaped = false;
    for (let index = start + 1; index < key.length; index += 1) {
      const character = key[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "[") depth += 1;
      else if (character === "]") {
        depth -= 1;
        if (depth === 0)
          return { value: key.slice(start + 1, index), end: index + 1 };
      }
    }
    return null;
  };
  const targetPart = readBracket("filter".length);
  if (!targetPart) return null;
  const field = targetPart.value;
  let cursor = targetPart.end;
  const parts: string[] = [];
  while (cursor < key.length) {
    const part = readBracket(cursor);
    if (!part) fail("invalid_filter_key", key, "Malformed filter key.");
    parts.push(part.value);
    cursor = part.end;
  }
  let payloadPath: string | undefined;
  if (field === "event.payload" && parts[0]?.startsWith("/")) {
    payloadPath = parts.shift();
  }
  return { field, ...(payloadPath ? { payloadPath } : {}), parts };
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
  const entries: Array<{
    readonly key: string;
    readonly value: string;
    readonly parsed: NonNullable<ReturnType<typeof parseKey>>;
  }> = [];
  const references = new Map<string, SelectorReferenceKind>();
  const addReference = (reference: string) => {
    const parsed = selectorReferenceParts(reference);
    if (!parsed) return;
    const canonicalReference = `${parsed.entity}:${parsed.index}`;
    const existing = references.get(canonicalReference);
    if (existing && existing !== parsed.entity)
      fail(
        "invalid_selector_reference",
        reference,
        "Selector reference entity conflicts.",
      );
    references.set(canonicalReference, parsed.entity);
  };
  for (const [key, value] of parseInput(input).entries()) {
    const parsed = parseKey(key);
    if (!parsed) {
      if (key.startsWith("filter[") && options.strictFilterKeys !== false)
        fail("invalid_filter_key", key, "Malformed filter key.");
      continue;
    }
    entries.push({ key, value, parsed });
    addReference(parsed.field);
    for (const part of parsed.parts) addReference(part);
    for (const match of parsed.field.matchAll(
      /\b(event|page|session|visitor|period|bucket|sequence|value):(\d+)\b/giu,
    ))
      addReference(`${match[1]!.toLowerCase()}:${Number(match[2])}`);
    if (selectorReferenceParts(parsed.field) && parsed.parts[0] === "source")
      replaceSelectorReferencesOutsideStrings(value, (reference) => {
        addReference(reference);
        return reference;
      });
  }

  const selectorScopes = new Map<string, Scope>();
  const selectorTargets = new Map<string, FilterTargetExpression>();
  for (const [reference, entity] of references) {
    selectorScopes.set(reference, scope());
    selectorTargets.set(reference, {
      kind: "selector",
      collection: {
        kind: "entity-root",
        entity:
          entity === "page" || entity === "session" || entity === "visitor"
            ? entity
            : "event",
      },
      predicate: {
        kind: "condition",
        target: { kind: "context-root", context: "current" },
        operator: "exists",
      },
    });
  }
  const resolveSelector = (reference: string): FilterTargetExpression => {
    const parsed = selectorReferenceParts(reference);
    const canonicalReference = parsed
      ? `${parsed.entity}:${parsed.index}`
      : reference;
    const target = selectorTargets.get(canonicalReference);
    if (!target)
      fail(
        "unbound_selector_reference",
        canonicalReference,
        "Selector reference is not declared in this filter URL.",
      );
    return target;
  };
  const parseScopedCondition = (
    target: string,
    payloadPath: string | undefined,
    raw: string,
    key: string,
  ): FilterCondition => {
    if (registry.has(target) || target === "event.payload")
      return parseCondition(target, payloadPath, raw, registry, limits);
    try {
      return parseComplexCondition(target, raw, registry, key, resolveSelector);
    } catch (error) {
      if (error instanceof FilterCodecError) throw error;
      fail(
        "invalid_complex_filter",
        key,
        "Invalid complex filter target or value.",
      );
    }
  };
  const insertInSelector = (
    reference: string,
    target: string,
    payloadPath: string | undefined,
    logic: string,
    raw: string,
    key: string,
  ) => {
    const selectorScope = selectorScopes.get(reference);
    if (!selectorScope)
      fail(
        "unbound_selector_reference",
        reference,
        "Selector reference is not declared.",
      );
    if (raw.length > limits.maxValueLength)
      fail("value_too_long", key, "Filter value is too long.");
    const condition = parseScopedCondition(target, payloadPath, raw, key);
    insert(selectorScope, parseLogic(logic, limits.maxDepth), condition);
  };

  for (const { key, value, parsed } of entries) {
    const reference = selectorReferenceParts(parsed.field);
    if (!reference || parsed.parts[0] !== "source") continue;
    if (parsed.parts.length !== 1)
      fail(
        "invalid_filter_key",
        key,
        "A selector source declaration has an invalid path.",
      );
    const sourceCondition = parseComplexCondition(
      value,
      "exists",
      registry,
      key,
      resolveSelector,
    );
    const target = selectorTargets.get(parsed.field);
    if (!target || target.kind !== "selector")
      fail(
        "invalid_selector_reference",
        parsed.field,
        "Invalid selector source.",
      );
    (target as { collection: FilterTargetExpression }).collection =
      sourceCondition.target;
  }

  // First pass declares all selector predicates. Nested selector paths are
  // lexical: a child selector's predicate is stored under its own reference.
  for (const { key, value, parsed } of entries) {
    const parent = selectorReferenceParts(parsed.field);
    if (!parent || parsed.parts.length === 0) continue;
    const first = parsed.parts[0]!;
    if (first === "source") continue;
    const child = selectorReferenceParts(first);
    if (child) {
      if (parsed.parts.length === 1) {
        insertInSelector(parsed.field, first, undefined, "", value, key);
        continue;
      }
      const target = parsed.parts[1]!;
      const payloadPath =
        target === "event.payload" && parsed.parts[2]?.startsWith("/")
          ? parsed.parts[2]
          : undefined;
      const logicIndex = payloadPath ? 3 : 2;
      const logicParts = parsed.parts.slice(logicIndex);
      if (logicParts.length > 1)
        fail(
          "invalid_filter_key",
          key,
          "A selector filter may have one logic path.",
        );
      insertInSelector(
        first,
        target,
        payloadPath,
        logicParts[0] ?? "",
        value,
        key,
      );
      continue;
    }
    const target = first;
    const payloadPath =
      target === "event.payload" && parsed.parts[1]?.startsWith("/")
        ? parsed.parts[1]
        : undefined;
    const logicIndex = payloadPath ? 2 : 1;
    const logicParts = parsed.parts.slice(logicIndex);
    if (logicParts.length > 1)
      fail(
        "invalid_filter_key",
        key,
        "A selector filter may have one logic path.",
      );
    insertInSelector(
      parsed.field,
      target,
      payloadPath,
      logicParts[0] ?? "",
      value,
      key,
    );
  }
  for (const [reference, selector] of selectorTargets) {
    const predicate = scopeExpression(selectorScopes.get(reference)!);
    if (!predicate)
      fail(
        "unbound_selector_reference",
        reference,
        "Selector reference has no predicate declaration.",
      );
    (selector as { predicate: FilterExpression }).predicate = predicate;
  }

  const root = scope();
  let conditions = 0;
  for (const { key, value, parsed } of entries) {
    const topSelector = selectorReferenceParts(parsed.field);
    if (topSelector && parsed.parts.length > 0) continue;
    if (
      parsed.field === "event.payload" &&
      !parsed.payloadPath &&
      !selectorReferenceParts(parsed.field)
    ) {
      fail(
        "invalid_target",
        key,
        "event.payload requires a JSON Pointer path.",
      );
    }
    if (value.length > limits.maxValueLength)
      fail("value_too_long", key, "Filter value is too long.");
    const logic = parsed.parts.length === 1 ? parsed.parts[0]! : "";
    if (parsed.parts.length > 1)
      fail("invalid_filter_key", key, "A filter key may have one logic path.");
    const condition = parseScopedCondition(
      parsed.field,
      parsed.payloadPath,
      value,
      key,
    );
    insert(root, parseLogic(logic, limits.maxDepth), condition);
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

function selectorOutputKind(
  target: FilterTargetExpression,
): SelectorReferenceKind {
  if (target.kind === "entity-root") return target.entity;
  if (target.kind === "periods") return "period";
  if (target.kind === "bucket") return "bucket";
  if (
    target.kind === "sequence" ||
    target.kind === "adjacent" ||
    target.kind === "without"
  )
    return "sequence";
  if (target.kind === "selector") return selectorOutputKind(target.collection);
  if (target.kind === "projection") return "value";
  if (target.kind === "window") return selectorOutputKind(target.collection);
  if (target.kind === "member") return selectorOutputKind(target.object);
  if (target.kind === "reducer") return selectorOutputKind(target.input);
  if (target.kind === "arithmetic") return "value";
  return "value";
}

function collectSelectorReferences(
  document: FilterDocument,
): WeakMap<FilterTargetExpression, string> {
  const references = new WeakMap<FilterTargetExpression, string>();
  const counters = new Map<SelectorReferenceKind, number>();
  const visitTarget = (target: FilterTargetExpression): void => {
    if (target.kind === "selector") {
      if (!references.has(target)) {
        const kind = selectorOutputKind(target.collection);
        const index = counters.get(kind) ?? 0;
        counters.set(kind, index + 1);
        references.set(target, `${kind}:${index}`);
      }
      visitTarget(target.collection);
      visitExpression(target.predicate);
      return;
    }
    switch (target.kind) {
      case "member":
        visitTarget(target.object);
        break;
      case "projection":
        visitTarget(target.collection);
        break;
      case "reducer":
        visitTarget(target.input);
        break;
      case "arithmetic":
        visitTarget(target.left);
        visitTarget(target.right);
        break;
      case "bucket":
        visitTarget(target.input);
        break;
      case "window":
        visitTarget(target.collection);
        visitTarget(target.anchor);
        break;
      case "periods":
        visitTarget(target.collection);
        break;
      case "sequence":
        target.steps.forEach(visitTarget);
        break;
      case "adjacent":
        visitTarget(target.sequence);
        break;
      case "without":
        visitTarget(target.sequence);
        visitTarget(target.excluded);
        break;
    }
  };
  const visitExpression = (expression: FilterExpression): void => {
    if (expression.kind === "condition") {
      visitTarget(expression.target);
      return;
    }
    if (expression.kind === "not") {
      visitExpression(expression.child);
      return;
    }
    expression.children.forEach(visitExpression);
  };
  if (document.root) visitExpression(document.root);
  return references;
}

function formatFilterUrlTarget(
  target: FilterTargetExpression,
  references: WeakMap<FilterTargetExpression, string>,
): string {
  switch (target.kind) {
    case "field":
      return target.field;
    case "event-payload":
      return `event.payload(${JSON.stringify(target.path)})`;
    case "entity-root":
      return target.entity;
    case "context-root":
      return target.context === "current" ? "" : target.context;
    case "member": {
      const object = formatFilterUrlTarget(target.object, references);
      return object ? `${object}.${target.member}` : target.member;
    }
    case "selector": {
      const reference = references.get(target);
      if (!reference)
        fail(
          "invalid_selector_reference",
          "target",
          "Selector has no stable URL reference.",
        );
      return reference;
    }
    case "projection":
      return `${formatFilterUrlTarget(target.collection, references)}.${target.member}${target.path === undefined ? "" : `(${JSON.stringify(target.path)})`}`;
    case "reducer":
      return target.reducer === "nth"
        ? `nth(${formatFilterUrlTarget(target.input, references)},${target.index})`
        : `${target.reducer}(${formatFilterUrlTarget(target.input, references)})`;
    case "arithmetic":
      return `${target.operator}(${formatFilterUrlTarget(target.left, references)},${formatFilterUrlTarget(target.right, references)})`;
    case "duration":
      return `${target.amount}${target.unit}`;
    case "time-anchor":
      return `@${target.anchor}${target.offset ? `${target.offset.amount >= 0 ? "+" : ""}${target.offset.amount}${target.offset.unit}` : ""}`;
    case "bucket":
      return `bucket(${formatFilterUrlTarget(target.input, references)},${target.interval.amount}${target.interval.unit})`;
    case "window":
      return `window(${formatFilterUrlTarget(target.collection, references)},${formatFilterUrlTarget(target.anchor, references)},[${target.startOffset.amount}${target.startOffset.unit},${target.endOffset.amount}${target.endOffset.unit}])`;
    case "periods":
      return `periods(${formatFilterUrlTarget(target.collection, references)},${target.interval.amount}${target.interval.unit})`;
    case "sequence":
      return `sequence([${target.steps.map((step) => formatFilterUrlTarget(step, references)).join(",")}])`;
    case "adjacent":
      return `adjacent(${formatFilterUrlTarget(target.sequence, references)})`;
    case "without":
      return `without(${formatFilterUrlTarget(target.sequence, references)},${formatFilterUrlTarget(target.excluded, references)})`;
  }
}

function appendKey(parts: readonly string[]): string {
  return `filter[${parts.join("][")}]`;
}

function serializeExpression(
  expression: FilterExpression,
  selectorPath: string[],
  logicPath: string[],
  pairs: Array<[string, string]>,
  registry: FilterFieldRegistry,
  references: WeakMap<FilterTargetExpression, string>,
  declared: Set<FilterTargetExpression>,
): void {
  const children =
    expression.kind === "and" ? expression.children : [expression];
  const orGroups = children.filter((child) => child.kind === "or");
  const notGroups = children.filter((child) => child.kind === "not");
  const serializeDeclarations = (target: FilterTargetExpression): void => {
    if (target.kind === "selector") {
      if (declared.has(target)) return;
      declared.add(target);
      const reference = references.get(target);
      if (!reference)
        fail(
          "invalid_selector_reference",
          "target",
          "Selector has no stable URL reference.",
        );
      if (target.collection.kind !== "entity-root") {
        serializeDeclarations(target.collection);
        pairs.push([
          appendKey([...selectorPath, reference, "source"]),
          formatFilterUrlTarget(target.collection, references),
        ]);
      }
      serializeExpression(
        target.predicate,
        [...selectorPath, reference],
        [],
        pairs,
        registry,
        references,
        declared,
      );
      return;
    }
    switch (target.kind) {
      case "member":
        serializeDeclarations(target.object);
        break;
      case "projection":
        serializeDeclarations(target.collection);
        break;
      case "reducer":
        serializeDeclarations(target.input);
        break;
      case "arithmetic":
        serializeDeclarations(target.left);
        serializeDeclarations(target.right);
        break;
      case "bucket":
        serializeDeclarations(target.input);
        break;
      case "window":
        serializeDeclarations(target.collection);
        serializeDeclarations(target.anchor);
        break;
      case "periods":
        serializeDeclarations(target.collection);
        break;
      case "sequence":
        target.steps.forEach(serializeDeclarations);
        break;
      case "adjacent":
        serializeDeclarations(target.sequence);
        break;
      case "without":
        serializeDeclarations(target.sequence);
        serializeDeclarations(target.excluded);
        break;
    }
  };
  for (const child of children) {
    if (child.kind === "condition") {
      serializeDeclarations(child.target);
      if (!isLegacyFilterTarget(child.target)) {
        const urlTarget = formatFilterUrlTarget(child.target, references);
        const humanTarget = formatFilterTargetExpression(child.target);
        const expressionText = formatFilterDsl({
          version: FILTER_DOCUMENT_VERSION,
          root: child,
        });
        const rawValue = expressionText.slice(humanTarget.length).trimStart();
        pairs.push([
          appendKey([
            ...selectorPath,
            urlTarget,
            ...(logicPath.length ? [logicPath.join(".")] : []),
          ]),
          rawValue,
        ]);
        continue;
      }
      const field =
        child.target.kind === "field" ? child.target.field : "event.payload";
      const parts = [...selectorPath, field];
      if (child.target.kind === "event-payload") parts.push(child.target.path);
      if (logicPath.length) parts.push(logicPath.join("."));
      const isTypeless = registry.get(field)?.valueKind === "json-scalar";
      pairs.push([
        appendKey(parts),
        conditionValue(
          legacyConditionValue(child.value),
          child.operator,
          isTypeless,
        ),
      ]);
    } else if (child.kind === "not") {
      const index = notGroups.indexOf(child);
      const token = notGroups.length === 1 ? "not" : `not:${index}`;
      serializeExpression(
        child.child,
        selectorPath,
        [...logicPath, token],
        pairs,
        registry,
        references,
        declared,
      );
    } else {
      const index = orGroups.indexOf(child);
      const token = orGroups.length === 1 ? "or" : `or:${index}`;
      child.children.forEach((branch, branchIndex) =>
        serializeExpression(
          branch,
          selectorPath,
          [...logicPath, token, String(branchIndex)],
          pairs,
          registry,
          references,
          declared,
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
    serializeExpression(
      normalized.root,
      [],
      [],
      pairs,
      registry,
      collectSelectorReferences(normalized),
      new Set(),
    );
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
