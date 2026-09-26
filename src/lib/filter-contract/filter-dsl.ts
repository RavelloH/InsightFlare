import {
  type CanonicalJsonPath,
  FILTER_OPERATOR_IDS,
  type FilterComparisonValue,
  type FilterCondition,
  type FilterDocument,
  type FilterDurationTarget,
  type FilterDurationUnit,
  type FilterExpression,
  type FilterFieldId,
  type FilterFieldRegistry,
  type FilterOperator,
  type FilterTargetExpression,
  type FilterTimeAnchorTarget,
  FilterValidationError,
  type FilterValue,
  normalizeFilterDocument,
} from "./filters";

/** The version of the human-readable filter expression language. */
export const FILTER_DSL_VERSION = 1 as const;

/** Maximum UTF-16 source length accepted by persisted and API DSL inputs. */
export const FILTER_DSL_MAX_LENGTH = 65_536 as const;

/** Canonical operator spellings emitted by the DSL formatter. */
export const FILTER_DSL_OPERATOR_IDS = FILTER_OPERATOR_IDS;

/** Syntax guidance shared by API discovery and the dashboard editor. */
export const FILTER_DSL_SYNTAX = {
  condition: "<target-expression> <operator> <condition-value>",
  targetExpression:
    "A registered field, entity root, selector, projection, reducer, arithmetic or temporal expression.",
  boolean:
    "Combine expressions with <expression> AND <expression> or <expression> OR <expression>; prefix an expression with NOT to negate it.",
  grouping:
    "Use parentheses for precedence, or use AND(<expression>) and OR(<expression>) for an explicit single-child group.",
  value:
    "A JSON scalar; temporal `between` ranges may use elapsed duration endpoints or @now/@range anchors with elapsed offsets.",
  list: "Use [<value>, ...] for in and notIn values.",
  selector: "Select a collection with <collection> { <filter-expression> }.",
  reducer:
    "Use count, first, last, nth, sum, avg, min, max, or countDistinct with a collection.",
  temporal:
    "Use bucket(collection.time, <calendar-period>), periods(collection, <calendar-period>), or window(collection, anchor, [<start-offset>, <end-offset>]).",
  relation:
    "Use sequence([...]), adjacent(sequence), and without(sequence, collection) with visitor or session query Scope, or inside an explicit session/visitor selector.",
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
  | (TokenBase & {
      readonly kind: "duration";
      readonly value: {
        readonly amount: number;
        readonly unit: FilterDurationUnit;
      };
    })
  | (TokenBase & {
      readonly kind: "time-anchor";
      readonly value: FilterTimeAnchorTarget;
    })
  | (TokenBase & { readonly kind: "boolean"; readonly value: boolean })
  | (TokenBase & {
      readonly kind:
        | "null"
        | "open"
        | "close"
        | "list-open"
        | "list-close"
        | "comma"
        | "dot"
        | "brace-open"
        | "brace-close"
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
  readonly target: FilterTargetExpression;
  readonly location: {
    readonly target: Span;
    readonly path?: Span;
  };
}

interface ParsedValue {
  readonly value: FilterCondition["value"];
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
    const timeAnchor = rest.match(
      /^@(now|range\.start|range\.end)(?:([+-])(\d+(?:\.\d+)?)(ms|mo|s|m|h|d|w|y))?/i,
    );
    if (timeAnchor) {
      const anchor =
        timeAnchor[1]!.toLowerCase() as FilterTimeAnchorTarget["anchor"];
      const sign = timeAnchor[2] === "-" ? -1 : 1;
      const amount = timeAnchor[3] ? Number(timeAnchor[3]) * sign : undefined;
      const unit = timeAnchor[4]?.toLowerCase() as
        FilterDurationUnit | undefined;
      const end = start + timeAnchor[0].length;
      tokens.push({
        kind: "time-anchor",
        value: {
          kind: "time-anchor",
          anchor,
          ...(amount === undefined || unit === undefined
            ? {}
            : { offset: { kind: "duration", amount, unit } }),
        },
        start,
        end,
      });
      index = end;
      continue;
    }
    const duration = rest.match(/^(-?\d+(?:\.\d+)?)(ms|mo|s|m|h|d|w|y)\b/i);
    if (duration) {
      tokens.push({
        kind: "duration",
        value: {
          amount: Number(duration[1]),
          unit: duration[2]!.toLowerCase() as FilterDurationUnit,
        },
        start,
        end: start + duration[0].length,
      });
      index += duration[0].length;
      continue;
    }
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
      | "open"
      | "close"
      | "list-open"
      | "list-close"
      | "comma"
      | "dot"
      | "brace-open"
      | "brace-close"
      | undefined
    > = {
      "(": "open",
      ")": "close",
      "[": "list-open",
      "]": "list-close",
      ",": "comma",
      ".": "dot",
      "{": "brace-open",
      "}": "brace-close",
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
    private readonly registry: FilterFieldRegistry,
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
    const fieldToken = this.current;
    const parsedTarget = this.targetExpression();
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

    const parsedValue = this.value(operator);
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

  private targetExpression(): ParsedTarget {
    const start = this.current.start;
    let target = this.primaryTarget();
    let path: Span | undefined = this.locations.get(target)?.path;
    let end = this.tokens[this.index - 1]?.end ?? start;
    for (;;) {
      if (this.consume("brace-open")) {
        const predicate = this.orExpression();
        const close = this.consume("brace-close");
        if (!close) {
          throw sourceError(
            this.source,
            "missing_selector_brace",
            this.current.start,
            "Missing closing brace for selector.",
            this.current.end - this.current.start,
            "`}`",
          );
        }
        target = { kind: "selector", collection: target, predicate };
        end = close.end;
        this.locations.set(target, { span: { start, end } });
        continue;
      }
      if (!this.consume("dot")) break;
      const member = this.expectIdentifier();
      end = member.end;
      if (member.value === "payload" && this.consume("open")) {
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
            "Missing closing parenthesis for the payload projection.",
            this.current.end - this.current.start,
            "`)`",
          );
        }
        target =
          target.kind === "entity-root" && target.entity === "event"
            ? {
                kind: "event-payload",
                path: pathToken.value as CanonicalJsonPath,
              }
            : {
                kind: "projection",
                collection: target,
                member: "payload",
                path: pathToken.value as CanonicalJsonPath,
              };
        path = spanFromToken(pathToken);
        end = close.end;
      } else {
        const parts = member.value.split(".");
        for (const part of parts) {
          target = { kind: "member", object: target, member: part };
        }
      }
      this.locations.set(target, {
        span: { start, end },
        ...(path ? { path } : {}),
      });
    }
    return {
      target,
      location: { target: { start, end }, ...(path ? { path } : {}) },
    };
  }

  private primaryTarget(): FilterTargetExpression {
    if (this.current.kind === "time-anchor") {
      const target = this.current.value;
      this.index += 1;
      return target;
    }
    if (this.current.kind === "duration") {
      const token = this.current;
      this.index += 1;
      return { kind: "duration", ...token.value };
    }
    if (this.current.kind !== "identifier") {
      throw tokenError(
        this.source,
        this.current.kind === "string"
          ? "expected_identifier"
          : "expected_target",
        this.current,
        this.current.kind === "string"
          ? "Expected a filter field or operator identifier."
          : "Expected a filter target expression.",
        this.current.kind === "string"
          ? "an identifier"
          : "a field, entity root, reducer, or temporal expression",
      );
    }
    const token = this.current;
    this.index += 1;
    const name = token.value;
    const normalized = name.toLowerCase();
    if (normalized === "event.payload" && this.consume("open")) {
      const payloadToken = this.tokens[this.index]!;
      if (payloadToken.kind !== "string") {
        throw tokenError(
          this.source,
          "expected_payload_path",
          payloadToken,
          "Expected a JSON pointer string for the event payload target.",
          'a JSON string such as `"/metadata/value"`',
        );
      }
      const pathToken = payloadToken;
      this.index += 1;
      const close = this.consume("close");
      if (!close) {
        throw sourceError(
          this.source,
          "missing_payload_parenthesis",
          this.tokens[this.index]!.start,
          "Missing closing parenthesis for the event payload target.",
          this.tokens[this.index]!.end - this.tokens[this.index]!.start,
          "`)`",
        );
      }
      const target: FilterTargetExpression = {
        kind: "event-payload",
        path: pathToken.value as CanonicalJsonPath,
      };
      this.locations.set(target, {
        span: { start: token.start, end: close.end },
        target: { start: token.start, end: close.end },
        path: spanFromToken(pathToken),
      });
      return target;
    }
    if (this.tokens[this.index]!.kind === "open") {
      return this.functionTarget(token);
    }
    if (["event", "page", "session", "visitor"].includes(normalized)) {
      return {
        kind: "entity-root",
        entity: normalized as "event" | "page" | "session" | "visitor",
      };
    }
    const contextMatch = /^(sequence|period|bucket)\.(.+)$/i.exec(name);
    if (contextMatch) {
      return contextMatch[2]!
        .split(".")
        .reduce<FilterTargetExpression>(
          (object, member) => ({ kind: "member", object, member }),
          {
            kind: "context-root",
            context: contextMatch[1]!.toLowerCase() as
              "sequence" | "period" | "bucket",
          },
        );
    }
    if (normalized === "time") {
      return {
        kind: "member",
        object: { kind: "context-root", context: "current" },
        member: "time",
      };
    }
    if (this.registry.has(name)) {
      return { kind: "field", field: name as FilterFieldId };
    }
    const entityMember = /^(event|page|session|visitor)\.(.+)$/i.exec(name);
    if (entityMember) {
      return entityMember[2]!
        .split(".")
        .reduce<FilterTargetExpression>(
          (object, member) => ({ kind: "member", object, member }),
          {
            kind: "entity-root",
            entity: entityMember[1]!.toLowerCase() as
              "event" | "page" | "session" | "visitor",
          },
        );
    }
    return { kind: "field", field: name as FilterFieldId };
  }

  private functionTarget(
    token: Token & { readonly kind: "identifier" },
  ): FilterTargetExpression {
    const name = token.value.toLowerCase();
    this.index += 1; // opening parenthesis
    if (name === "sequence") {
      if (!this.consume("list-open")) {
        throw tokenError(
          this.source,
          "expected_sequence_steps",
          this.current,
          "sequence requires a step list.",
          "`[` ",
        );
      }
      const steps: FilterTargetExpression[] = [];
      if (this.current.kind !== "list-close") {
        do {
          steps.push(this.targetExpression().target);
        } while (this.consume("comma"));
      }
      if (!this.consume("list-close") || !this.consume("close")) {
        throw sourceError(
          this.source,
          "invalid_sequence",
          this.current.start,
          "Expected `])` after sequence steps.",
          this.current.end - this.current.start,
          "`])`",
        );
      }
      return { kind: "sequence", steps };
    }
    if (name === "window") {
      const collection = this.targetExpression().target;
      if (!this.consume("comma"))
        throw tokenError(
          this.source,
          "expected_argument_separator",
          this.current,
          "window arguments must be separated by commas.",
          "`,`",
        );
      const anchor = this.targetExpression().target;
      if (!this.consume("comma") || !this.consume("list-open"))
        throw tokenError(
          this.source,
          "expected_duration_range",
          this.current,
          "window requires a two-value duration range.",
          "`[start, end]`",
        );
      const startOffset = this.requireDuration();
      if (!this.consume("comma"))
        throw tokenError(
          this.source,
          "expected_argument_separator",
          this.current,
          "Duration bounds must be separated by a comma.",
          "`,`",
        );
      const endOffset = this.requireDuration();
      if (!this.consume("list-close") || !this.consume("close"))
        throw tokenError(
          this.source,
          "invalid_window",
          this.current,
          "Expected `])` after window bounds.",
          "`])`",
        );
      return { kind: "window", collection, anchor, startOffset, endOffset };
    }
    if (name === "bucket" || name === "periods") {
      const collection = this.collectionArgument(
        this.targetExpression().target,
      );
      if (!this.consume("comma")) {
        throw tokenError(
          this.source,
          "expected_argument_separator",
          this.current,
          `${token.value} arguments must be separated by commas.`,
          "`,`",
        );
      }
      const interval = this.requireDuration();
      if (!this.consume("close")) {
        throw tokenError(
          this.source,
          "missing_closing_parenthesis",
          this.current,
          "Missing closing parenthesis.",
          "`)`",
        );
      }
      return name === "bucket"
        ? { kind: "bucket", input: collection, interval }
        : { kind: "periods", collection, interval };
    }
    const first = this.targetExpression().target;
    let second: FilterTargetExpression | undefined;
    if (this.consume("comma")) {
      if (name === "nth") {
        const index = this.current;
        if (
          index.kind !== "number" ||
          !Number.isSafeInteger(index.value) ||
          index.value < 1
        ) {
          throw tokenError(
            this.source,
            "invalid_index",
            index,
            "nth requires a positive integer index.",
            "a positive integer",
          );
        }
        this.index += 1;
        if (!this.consume("close"))
          throw tokenError(
            this.source,
            "missing_closing_parenthesis",
            this.current,
            "Missing closing parenthesis.",
            "`)`",
          );
        return {
          kind: "reducer",
          reducer: "nth",
          input: first,
          index: index.value,
        };
      }
      second = this.targetExpression().target;
    }
    if (!this.consume("close")) {
      throw tokenError(
        this.source,
        "missing_closing_parenthesis",
        this.current,
        "Missing closing parenthesis.",
        "`)`",
      );
    }
    if (
      [
        "count",
        "first",
        "last",
        "sum",
        "avg",
        "min",
        "max",
        "countdistinct",
      ].includes(name)
    ) {
      if (second)
        throw tokenError(
          this.source,
          "unexpected_argument",
          token,
          `${token.value} accepts one argument.`,
        );
      return {
        kind: "reducer",
        reducer:
          name === "countdistinct"
            ? "countDistinct"
            : (name as
                "count" | "first" | "last" | "sum" | "avg" | "min" | "max"),
        input: this.collectionArgument(first),
      };
    }
    if (["add", "sub", "mul", "div"].includes(name)) {
      if (!second)
        throw tokenError(
          this.source,
          "missing_argument",
          token,
          `${token.value} requires two arguments.`,
        );
      return {
        kind: "arithmetic",
        operator: name as "add" | "sub" | "mul" | "div",
        left: first,
        right: second,
      };
    }
    if (name === "adjacent") {
      if (second)
        throw tokenError(
          this.source,
          "unexpected_argument",
          token,
          "adjacent accepts one sequence.",
        );
      return { kind: "adjacent", sequence: first };
    }
    if (name === "without") {
      if (!second)
        throw tokenError(
          this.source,
          "missing_argument",
          token,
          "without requires a sequence and an excluded collection.",
        );
      return { kind: "without", sequence: first, excluded: second };
    }
    throw tokenError(
      this.source,
      "unknown_function",
      token,
      `Unknown filter expression function ${JSON.stringify(token.value)}.`,
    );
  }

  /** In a reducer argument, a legacy entity field names that field's ordered
   * collection across matching entities (for example page.path or
   * event.payload("/amount")). Bare v1 conditions keep their existing scalar
   * target and evaluation behavior. */
  private collectionArgument(
    target: FilterTargetExpression,
  ): FilterTargetExpression {
    if (target.kind === "event-payload") {
      return {
        kind: "projection",
        collection: { kind: "entity-root", entity: "event" },
        member: "payload",
        path: target.path,
      };
    }
    if (target.kind !== "field") return target;
    const [entity, ...members] = target.field.split(".");
    if (
      !members.length ||
      !["event", "page", "session", "visitor"].includes(entity!)
    )
      return target;
    return members.reduce<FilterTargetExpression>(
      (object, member) => ({ kind: "member", object, member }),
      {
        kind: "entity-root",
        entity: entity as "event" | "page" | "session" | "visitor",
      },
    );
  }

  private requireDuration(): FilterDurationTarget {
    if (this.current.kind !== "duration") {
      throw tokenError(
        this.source,
        "expected_duration",
        this.current,
        "Expected a duration literal.",
        "a duration such as `7d`",
      );
    }
    const token = this.current;
    this.index += 1;
    return { kind: "duration", ...token.value };
  }

  private value(operator: FilterOperator): ParsedValue {
    if (this.current.kind === "time-anchor") {
      const token = this.current;
      this.index += 1;
      return {
        value: token.value,
        span: spanFromToken(token),
        elements: [spanFromToken(token)],
      };
    }
    if (this.current.kind === "duration") {
      const token = this.current;
      this.index += 1;
      const value: FilterDurationTarget = {
        kind: "duration",
        ...token.value,
      };
      return {
        value,
        span: spanFromToken(token),
        elements: [spanFromToken(token)],
      };
    }
    const open = this.consume("list-open");
    if (open) {
      const values: Array<
        FilterValue | FilterTimeAnchorTarget | FilterDurationTarget
      > = [];
      const elements: Span[] = [];
      const close = this.consume("list-close");
      if (close) {
        return {
          value: [] as FilterValue[],
          span: { start: open.start, end: close.end },
          elements,
        };
      }

      do {
        if (operator === "between") {
          const parsed = this.comparisonRangeEndpoint();
          values.push(parsed.value);
          elements.push(parsed.span);
        } else {
          const parsed = this.scalarValue();
          values.push(parsed.value);
          elements.push(parsed.span);
        }
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
      if (operator === "between" && values.length !== 2) {
        throw sourceError(
          this.source,
          "invalid_range",
          open.start,
          "Between requires exactly two values.",
          closingBracket.end - open.start,
        );
      }
      return {
        value:
          operator === "between"
            ? ([
                values[0] as FilterComparisonValue,
                values[1] as FilterComparisonValue,
              ] as const)
            : (values as FilterValue[]),
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

  private comparisonRangeEndpoint(): {
    readonly value: FilterComparisonValue;
    readonly span: Span;
  } {
    if (this.current.kind === "time-anchor") {
      const token = this.current;
      this.index += 1;
      return { value: token.value, span: spanFromToken(token) };
    }
    if (this.current.kind === "duration") {
      const token = this.current;
      this.index += 1;
      return {
        value: { kind: "duration", ...token.value },
        span: spanFromToken(token),
      };
    }
    const scalar = this.scalarValue();
    return scalar;
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
  const root = new Parser(
    source,
    tokenize(source),
    locations,
    registry,
  ).parse();
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

function formatDuration(duration: {
  readonly amount: number;
  readonly unit: FilterDurationUnit;
}): string {
  return `${duration.amount}${duration.unit}`;
}

export function formatFilterTargetExpression(
  target: FilterTargetExpression,
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
      const object = formatFilterTargetExpression(target.object);
      return object ? `${object}.${target.member}` : target.member;
    }
    case "selector":
      return `${formatFilterTargetExpression(target.collection)} { ${formatExpression(target.predicate)} }`;
    case "projection":
      return `${formatFilterTargetExpression(target.collection)}.${target.member}${target.path === undefined ? "" : `(${JSON.stringify(target.path)})`}`;
    case "reducer":
      return target.reducer === "nth"
        ? `nth(${formatFilterTargetExpression(target.input)}, ${target.index})`
        : `${target.reducer}(${formatFilterTargetExpression(target.input)})`;
    case "arithmetic":
      return `${target.operator}(${formatFilterTargetExpression(target.left)}, ${formatFilterTargetExpression(target.right)})`;
    case "duration":
      return formatDuration(target);
    case "time-anchor": {
      if (!target.offset) return `@${target.anchor}`;
      const signed = `${target.offset.amount >= 0 ? "+" : ""}${formatDuration(target.offset)}`;
      return `@${target.anchor}${signed}`;
    }
    case "bucket":
      return `bucket(${formatFilterTargetExpression(target.input)}, ${formatDuration(target.interval)})`;
    case "window":
      return `window(${formatFilterTargetExpression(target.collection)}, ${formatFilterTargetExpression(target.anchor)}, [${formatDuration(target.startOffset)}, ${formatDuration(target.endOffset)}])`;
    case "periods":
      return `periods(${formatFilterTargetExpression(target.collection)}, ${formatDuration(target.interval)})`;
    case "sequence":
      return `sequence([${target.steps.map(formatFilterTargetExpression).join(", ")}])`;
    case "adjacent":
      return `adjacent(${formatFilterTargetExpression(target.sequence)})`;
    case "without":
      return `without(${formatFilterTargetExpression(target.sequence)}, ${formatFilterTargetExpression(target.excluded)})`;
  }
}

function formatConditionValue(value: FilterCondition["value"]): string {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value
  ) {
    return formatFilterTargetExpression(value as FilterTargetExpression);
  }
  if (Array.isArray(value))
    return `[${value
      .map((item) =>
        item && typeof item === "object" && "kind" in item
          ? formatFilterTargetExpression(item as FilterTargetExpression)
          : JSON.stringify(item),
      )
      .join(", ")}]`;
  return JSON.stringify(value);
}

function formatCondition(condition: FilterCondition): string {
  const target = formatFilterTargetExpression(condition.target);
  if (VALUELESS_OPERATORS.has(condition.operator)) {
    return `${target} ${condition.operator}`;
  }
  return `${target} ${condition.operator} ${formatConditionValue(condition.value)}`;
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
