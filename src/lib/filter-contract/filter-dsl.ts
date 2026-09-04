import {
  type CanonicalJsonPath,
  FILTER_OPERATOR_IDS,
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterFieldId,
  type FilterFieldRegistry,
  type FilterOperator,
  type FilterTarget,
  FilterValidationError,
  type FilterValue,
  normalizeFilterDocument,
} from "@/lib/edge/analytics/contract/filters";

/** The version of the human-readable filter expression language. */
export const FILTER_DSL_VERSION = 1 as const;

/** Maximum UTF-16 source length accepted by persisted and API DSL inputs. */
export const FILTER_DSL_MAX_LENGTH = 65_536 as const;

/** Canonical operator spellings emitted by the DSL formatter. */
export const FILTER_DSL_OPERATOR_IDS = FILTER_OPERATOR_IDS;

/** Syntax guidance shared by API discovery and the dashboard editor. */
export const FILTER_DSL_SYNTAX = {
  condition: "<field> <operator> <value>",
  boolean:
    "Combine expressions with <expression> AND <expression> or <expression> OR <expression>; prefix an expression with NOT to negate it.",
  grouping:
    "Use parentheses for precedence, or use AND(<expression>) and OR(<expression>) for an explicit single-child group.",
  value: "A JSON string, number, boolean, or null.",
  list: "Use [<value>, ...] for in and notIn values.",
  payloadTarget:
    'Use event.payload("<json-pointer>") for event payload fields.',
  caseSensitivity:
    "Field identifiers are case-sensitive; operators and boolean keywords are case-insensitive.",
} as const;

/** Valid API-facing examples used in the analytics schema discovery response. */
export const FILTER_DSL_EXAMPLES = [
  'page.path eq "/pricing"',
  'geo.country in ["US", "GB"]',
  'NOT client.deviceType eq "mobile"',
  'page.path startsWith "/docs" AND referrer.domain eq "google.com"',
] as const;

const VALUELESS_OPERATORS = new Set<FilterOperator>([
  "exists",
  "notExists",
  "isNull",
  "notNull",
  "isEmpty",
  "notEmpty",
]);

const OPERATORS = new Map<string, FilterOperator>([
  ["eq", "eq"],
  ["neq", "neq"],
  ["in", "in"],
  ["notin", "notIn"],
  ["contains", "contains"],
  ["startswith", "startsWith"],
  ["endswith", "endsWith"],
  ["gt", "gt"],
  ["gte", "gte"],
  ["lt", "lt"],
  ["lte", "lte"],
  ["between", "between"],
  ["exists", "exists"],
  ["notexists", "notExists"],
  ["isnull", "isNull"],
  ["notnull", "notNull"],
  ["isempty", "isEmpty"],
  ["notempty", "notEmpty"],
]);

export interface FilterDslParseErrorDetails {
  readonly code: string;
  readonly offset: number;
  readonly length?: number;
  readonly expected?: string;
  readonly source?: string;
  readonly cause?: unknown;
}

/**
 * Error raised while parsing or validating a filter DSL document.
 *
 * `offset` is a UTF-16 source offset, matching JavaScript string indexing.
 * `length` is zero for errors reported at end-of-input.
 */
export class FilterDslParseError extends Error {
  readonly code: string;
  readonly offset: number;
  readonly length: number;
  readonly expected?: string;
  readonly source?: string;
  readonly cause?: unknown;

  constructor(message: string, details: FilterDslParseErrorDetails) {
    const location =
      details.length === 0 || details.offset >= (details.source?.length ?? 0)
        ? `at offset ${details.offset} (end of input)`
        : `at offset ${details.offset}`;
    super(`${message} [${details.code}] ${location}.`);
    this.name = "FilterDslParseError";
    this.code = details.code;
    this.offset = details.offset;
    this.length = details.length ?? 1;
    this.expected = details.expected;
    this.source = details.source;
    this.cause = details.cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface TokenBase {
  readonly start: number;
  readonly end: number;
}

type Token =
  | (TokenBase & { readonly kind: "identifier"; readonly value: string })
  | (TokenBase & { readonly kind: "string"; readonly value: string })
  | (TokenBase & { readonly kind: "number"; readonly value: number })
  | (TokenBase & { readonly kind: "boolean"; readonly value: boolean })
  | (TokenBase & {
      readonly kind:
        | "null"
        | "open"
        | "close"
        | "list-open"
        | "list-close"
        | "comma"
        | "end";
    });

interface Span {
  readonly start: number;
  readonly end: number;
}

interface NodeLocation {
  readonly span: Span;
  readonly field?: Span;
  readonly target?: Span;
  readonly path?: Span;
  readonly operator?: Span;
  readonly value?: Span;
  readonly valueElements?: readonly Span[];
}

interface ParsedTarget {
  readonly target: FilterTarget;
  readonly location: {
    readonly target: Span;
    readonly path?: Span;
  };
}

interface ParsedValue {
  readonly value: FilterValue | readonly FilterValue[];
  readonly span: Span;
  readonly elements: readonly Span[];
}

function spanFromToken(token: Token): Span {
  return { start: token.start, end: token.end };
}

function tokenError(
  source: string,
  code: string,
  token: Token,
  message: string,
  expected?: string,
): FilterDslParseError {
  return new FilterDslParseError(message, {
    code,
    offset: token.start,
    length: token.end - token.start,
    expected,
    source,
  });
}

function sourceError(
  source: string,
  code: string,
  offset: number,
  message: string,
  length = 1,
  expected?: string,
): FilterDslParseError {
  return new FilterDslParseError(message, {
    code,
    offset,
    length,
    expected,
    source,
  });
}

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }

    const start = index;
    const character = source[index]!;
    if (character === '"') {
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === '"') break;
        end += 1;
      }
      if (source[end] !== '"') {
        throw sourceError(
          source,
          "unterminated_string",
          start,
          "Unterminated JSON string.",
          source.length - start,
          'a closing `"`',
        );
      }
      const raw = source.slice(start, end + 1);
      try {
        const value = JSON.parse(raw);
        if (typeof value !== "string") throw new Error();
        tokens.push({
          kind: "string",
          value,
          start,
          end: end + 1,
        });
      } catch {
        throw sourceError(
          source,
          "invalid_string",
          start,
          "Invalid JSON string literal.",
          end + 1 - start,
          "a valid JSON string",
        );
      }
      index = end + 1;
      continue;
    }

    const number = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      const raw = number[0]!;
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw sourceError(
          source,
          "invalid_number",
          start,
          "JSON number is outside the supported finite range.",
          raw.length,
          "a finite JSON number",
        );
      }
      tokens.push({
        kind: "number",
        value,
        start,
        end: start + raw.length,
      });
      index += raw.length;
      continue;
    }

    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9._-]*/);
    if (identifier) {
      const value = identifier[0]!;
      const normalized = value.toLowerCase();
      if (normalized === "true" || normalized === "false") {
        tokens.push({
          kind: "boolean",
          value: normalized === "true",
          start,
          end: start + value.length,
        });
      } else if (normalized === "null") {
        tokens.push({
          kind: "null",
          start,
          end: start + value.length,
        });
      } else {
        tokens.push({
          kind: "identifier",
          value,
          start,
          end: start + value.length,
        });
      }
      index += value.length;
      continue;
    }

    const punctuation: Record<
      string,
      "open" | "close" | "list-open" | "list-close" | "comma" | undefined
    > = {
      "(": "open",
      ")": "close",
      "[": "list-open",
      "]": "list-close",
      ",": "comma",
    };
    const kind = punctuation[character];
    if (kind) {
      tokens.push({ kind, start, end: start + 1 });
      index += 1;
      continue;
    }

    throw sourceError(
      source,
      "invalid_token",
      start,
      `Unexpected character ${JSON.stringify(character)}.`,
    );
  }
  return [...tokens, { kind: "end", start: source.length, end: source.length }];
}

class Parser {
  private index = 0;

  constructor(
    private readonly source: string,
    private readonly tokens: readonly Token[],
    private readonly locations: WeakMap<object, NodeLocation>,
  ) {}

  parse(): FilterExpression {
    const expression = this.orExpression();
    if (this.current.kind !== "end") {
      throw tokenError(
        this.source,
        "unexpected_token",
        this.current,
        "Unexpected token after the filter expression.",
      );
    }
    return expression;
  }

  private get current(): Token {
    return this.tokens[this.index]!;
  }

  private consume(kind: Token["kind"]): Token | undefined {
    if (this.current.kind !== kind) return undefined;
    const token = this.current;
    this.index += 1;
    return token;
  }

  private consumeKeyword(keyword: "and" | "or" | "not"): Token | undefined {
    if (
      this.current.kind !== "identifier" ||
      this.current.value.toLowerCase() !== keyword
    ) {
      return undefined;
    }
    const token = this.current;
    this.index += 1;
    return token;
  }

  private expectIdentifier(): Token & {
    readonly kind: "identifier";
  } {
    if (this.current.kind !== "identifier") {
      throw tokenError(
        this.source,
        "expected_identifier",
        this.current,
        "Expected a filter field or operator identifier.",
        "an identifier",
      );
    }
    const token = this.current;
    this.index += 1;
    return token;
  }

  private orExpression(): FilterExpression {
    const children = [this.andExpression()];
    while (this.consumeKeyword("or")) {
      children.push(this.andExpression());
    }
    if (children.length === 1) return children[0]!;
    const expression: FilterExpression = { kind: "or", children };
    this.locations.set(expression, {
      span: {
        start: this.spanOf(children[0]!).start,
        end: this.spanOf(children[children.length - 1]!).end,
      },
    });
    return expression;
  }

  private andExpression(): FilterExpression {
    const children = [this.unaryExpression()];
    while (this.consumeKeyword("and")) {
      children.push(this.unaryExpression());
    }
    if (children.length === 1) return children[0]!;
    const expression: FilterExpression = { kind: "and", children };
    this.locations.set(expression, {
      span: {
        start: this.spanOf(children[0]!).start,
        end: this.spanOf(children[children.length - 1]!).end,
      },
    });
    return expression;
  }

  private unaryExpression(): FilterExpression {
    const notToken = this.consumeKeyword("not");
    if (notToken) {
      const child = this.unaryExpression();
      const expression: FilterExpression = { kind: "not", child };
      this.locations.set(expression, {
        span: { start: notToken.start, end: this.spanOf(child).end },
      });
      return expression;
    }

    const explicitGroup =
      this.current.kind === "identifier" &&
      (this.current.value.toLowerCase() === "and" ||
        this.current.value.toLowerCase() === "or") &&
      this.tokens[this.index + 1]?.kind === "open"
        ? (this.current.value.toLowerCase() as "and" | "or")
        : null;
    if (explicitGroup) {
      const groupToken = this.current;
      this.index += 2;
      const child = this.orExpression();
      const close = this.consume("close");
      if (!close) {
        throw sourceError(
          this.source,
          "missing_closing_parenthesis",
          this.current.start,
          "Missing closing parenthesis for boolean group.",
          this.current.end - this.current.start,
          "`)`",
        );
      }
      const expression: FilterExpression = {
        kind: explicitGroup,
        children: [child],
      };
      this.locations.set(expression, {
        span: { start: groupToken.start, end: close.end },
      });
      return expression;
    }

    const open = this.consume("open");
    if (open) {
      const expression = this.orExpression();
      const close = this.consume("close");
      if (!close) {
        throw sourceError(
          this.source,
          "missing_closing_parenthesis",
          this.current.start,
          "Missing closing parenthesis.",
          this.current.end - this.current.start,
          "`)`",
        );
      }
      // Parentheses are syntax, not AST nodes. Keep the span on the parsed
      // expression so validation errors inside the group still have a useful
      // fallback location.
      const location = this.locations.get(expression);
      this.locations.set(expression, {
        ...(location ?? { span: this.spanOf(expression) }),
        span: { start: open.start, end: close.end },
      });
      return expression;
    }
    return this.condition();
  }

  private condition(): FilterCondition {
    const fieldToken = this.expectIdentifier();
    const parsedTarget = this.target(fieldToken);
    const operatorToken = this.expectIdentifier();
    const operator = OPERATORS.get(operatorToken.value.toLowerCase());
    if (!operator) {
      throw tokenError(
        this.source,
        "unknown_operator",
        operatorToken,
        `Unknown filter operator ${JSON.stringify(operatorToken.value)}.`,
        "a supported filter operator",
      );
    }

    if (VALUELESS_OPERATORS.has(operator)) {
      const expression: FilterCondition = {
        kind: "condition",
        target: parsedTarget.target,
        operator,
      };
      this.locations.set(expression, {
        span: { start: fieldToken.start, end: operatorToken.end },
        field: spanFromToken(fieldToken),
        target: parsedTarget.location.target,
        path: parsedTarget.location.path,
        operator: spanFromToken(operatorToken),
      });
      return expression;
    }

    const parsedValue = this.value();
    const expression: FilterCondition = {
      kind: "condition",
      target: parsedTarget.target,
      operator,
      value: parsedValue.value,
    };
    this.locations.set(expression, {
      span: { start: fieldToken.start, end: parsedValue.span.end },
      field: spanFromToken(fieldToken),
      target: parsedTarget.location.target,
      path: parsedTarget.location.path,
      operator: spanFromToken(operatorToken),
      value: parsedValue.span,
      valueElements: parsedValue.elements,
    });
    return expression;
  }

  private target(
    fieldToken: Token & { readonly kind: "identifier" },
  ): ParsedTarget {
    if (fieldToken.value === "event.payload") {
      const open = this.consume("open");
      if (open) {
        if (this.current.kind !== "string") {
          throw tokenError(
            this.source,
            "expected_payload_path",
            this.current,
            "Expected a JSON pointer string for the event payload target.",
            'a JSON string such as `"/metadata/value"`',
          );
        }
        const pathToken = this.current;
        this.index += 1;
        const close = this.consume("close");
        if (!close) {
          throw sourceError(
            this.source,
            "missing_payload_parenthesis",
            this.current.start,
            "Missing closing parenthesis for the event payload target.",
            this.current.end - this.current.start,
            "`)`",
          );
        }
        return {
          target: {
            kind: "event-payload",
            path: pathToken.value as CanonicalJsonPath,
          },
          location: {
            target: { start: fieldToken.start, end: close.end },
            path: spanFromToken(pathToken),
          },
        };
      }
    }
    return {
      target: { kind: "field", field: fieldToken.value as FilterFieldId },
      location: {
        target: spanFromToken(fieldToken),
      },
    };
  }

  private value(): ParsedValue {
    const open = this.consume("list-open");
    if (open) {
      const values: FilterValue[] = [];
      const elements: Span[] = [];
      const close = this.consume("list-close");
      if (close) {
        return {
          value: values,
          span: { start: open.start, end: close.end },
          elements,
        };
      }

      do {
        const parsed = this.scalarValue();
        values.push(parsed.value);
        elements.push(parsed.span);
      } while (this.consume("comma"));

      const closingBracket = this.consume("list-close");
      if (!closingBracket) {
        throw sourceError(
          this.source,
          "missing_list_bracket",
          this.current.start,
          "Missing closing bracket for value list.",
          this.current.end - this.current.start,
          "`]`",
        );
      }
      return {
        value: values,
        span: { start: open.start, end: closingBracket.end },
        elements,
      };
    }

    const scalar = this.scalarValue();
    return {
      value: scalar.value,
      span: scalar.span,
      elements: [scalar.span],
    };
  }

  private scalarValue(): { readonly value: FilterValue; readonly span: Span } {
    if (
      this.current.kind === "string" ||
      this.current.kind === "number" ||
      this.current.kind === "boolean"
    ) {
      const token = this.current;
      this.index += 1;
      return { value: token.value, span: spanFromToken(token) };
    }
    const nullToken = this.consume("null");
    if (nullToken) return { value: null, span: spanFromToken(nullToken) };
    throw tokenError(
      this.source,
      "expected_value",
      this.current,
      "Expected a JSON string, number, boolean, or null value.",
      "a JSON scalar value",
    );
  }

  private spanOf(expression: FilterExpression): Span {
    return (
      this.locations.get(expression)?.span ?? {
        start: this.current.start,
        end: this.current.start,
      }
    );
  }
}

function fallbackLocation(source: string): Span {
  return { start: source.length, end: source.length };
}

function validationLocation(
  path: string,
  root: FilterExpression,
  locations: WeakMap<object, NodeLocation>,
  source: string,
): Span {
  const parts = path.split(".");
  if (parts[0] !== "root") return fallbackLocation(source);

  let expression: FilterExpression = root;
  let location = locations.get(expression);
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index]!;
    if (part === "child" && expression.kind === "not") {
      expression = expression.child;
      location = locations.get(expression);
      continue;
    }

    const childMatch = /^children(?:\[(\d+)\])?$/.exec(part);
    if (childMatch) {
      if (!childMatch[1]) return location?.span ?? fallbackLocation(source);
      if (expression.kind !== "and" && expression.kind !== "or") {
        return location?.span ?? fallbackLocation(source);
      }
      const child = expression.children[Number(childMatch[1])];
      if (!child) return location?.span ?? fallbackLocation(source);
      expression = child;
      location = locations.get(expression);
      continue;
    }

    if (part === "target") {
      const targetPart = parts[index + 1];
      if (targetPart === "field") {
        return (
          location?.field ??
          location?.target ??
          location?.span ??
          fallbackLocation(source)
        );
      }
      if (targetPart === "path") {
        return (
          location?.path ??
          location?.target ??
          location?.span ??
          fallbackLocation(source)
        );
      }
      return location?.target ?? location?.span ?? fallbackLocation(source);
    }
    if (part === "operator") {
      return location?.operator ?? location?.span ?? fallbackLocation(source);
    }
    const valueMatch = /^value(?:\[(\d+)\])?$/.exec(part);
    if (valueMatch) {
      if (valueMatch[1] && location?.valueElements) {
        return (
          location.valueElements[Number(valueMatch[1])] ??
          location.value ??
          location.span
        );
      }
      return location?.value ?? location?.span ?? fallbackLocation(source);
    }
    if (part === "kind" || part === "field" || part === "path") {
      if (part === "field") {
        return (
          location?.field ??
          location?.target ??
          location?.span ??
          fallbackLocation(source)
        );
      }
      if (part === "path")
        return (
          location?.path ??
          location?.target ??
          location?.span ??
          fallbackLocation(source)
        );
      return location?.span ?? fallbackLocation(source);
    }
  }
  return location?.span ?? fallbackLocation(source);
}

function rethrowValidationError(
  error: FilterValidationError,
  source: string,
  root: FilterExpression,
  locations: WeakMap<object, NodeLocation>,
): never {
  const location = validationLocation(error.path, root, locations, source);
  throw new FilterDslParseError(error.message, {
    code: error.code,
    offset: location.start,
    length: location.end - location.start,
    source,
    cause: error,
  });
}

/**
 * Parse a DSL v1 expression and validate it against the supplied field
 * registry. Parsing intentionally preserves the source expression's boolean
 * grouping and condition order; registry normalization is used only as a
 * validation pass, matching the dashboard editor's behavior.
 */
export function parseFilterDsl(
  source: string,
  registry: FilterFieldRegistry,
): FilterDocument {
  if (!source.trim()) {
    return { version: FILTER_DSL_VERSION, root: null };
  }

  const locations = new WeakMap<object, NodeLocation>();
  const root = new Parser(source, tokenize(source), locations).parse();
  try {
    normalizeFilterDocument(
      {
        version: FILTER_DSL_VERSION,
        root,
      },
      registry,
    );
  } catch (error) {
    if (error instanceof FilterValidationError) {
      rethrowValidationError(error, source, root, locations);
    }
    throw error;
  }
  return { version: FILTER_DSL_VERSION, root };
}

const PRECEDENCE: Readonly<Record<FilterExpression["kind"], number>> = {
  condition: 4,
  not: 3,
  and: 2,
  or: 1,
};

function formatCondition(condition: FilterCondition): string {
  const target =
    condition.target.kind === "event-payload"
      ? `event.payload(${JSON.stringify(condition.target.path)})`
      : condition.target.field;
  if (VALUELESS_OPERATORS.has(condition.operator)) {
    return `${target} ${condition.operator}`;
  }
  return `${target} ${condition.operator} ${JSON.stringify(condition.value)}`;
}

function formatExpression(
  expression: FilterExpression,
  parentPrecedence = 0,
  parentGroupKind?: "and" | "or",
): string {
  const precedence = PRECEDENCE[expression.kind];
  const source =
    expression.kind === "condition"
      ? formatCondition(expression)
      : expression.kind === "not"
        ? `NOT ${formatExpression(expression.child, precedence)}`
        : expression.children.length === 1
          ? `${expression.kind.toUpperCase()}(${formatExpression(expression.children[0]!)})`
          : expression.children
              .map((child) =>
                formatExpression(child, precedence, expression.kind),
              )
              .join(` ${expression.kind.toUpperCase()} `);
  return precedence < parentPrecedence || expression.kind === parentGroupKind
    ? `(${source})`
    : source;
}

/** Format a filter document using the canonical DSL v1 surface syntax. */
export function formatFilterDsl(document: FilterDocument): string {
  return document.root ? formatExpression(document.root) : "";
}
