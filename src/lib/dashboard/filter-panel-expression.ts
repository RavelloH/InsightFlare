import {
  type CanonicalJsonPath,
  FILTER_DOCUMENT_VERSION,
  type FilterCondition,
  type FilterDocument,
  type FilterExpression,
  type FilterFieldId,
  type FilterFieldRegistry,
  type FilterOperator,
  type FilterValue,
  normalizeFilterDocument,
} from "@/lib/filter-contract";

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

export class FilterPanelExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterPanelExpressionError";
  }
}

type Token =
  | { readonly kind: "identifier"; readonly value: string }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | {
      readonly kind:
        | "null"
        | "open"
        | "close"
        | "list-open"
        | "list-close"
        | "comma"
        | "end";
    };

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
        throw new FilterPanelExpressionError("unterminated_string");
      }
      try {
        const value = JSON.parse(source.slice(index, end + 1));
        if (typeof value !== "string") throw new Error();
        tokens.push({ kind: "string", value });
      } catch {
        throw new FilterPanelExpressionError("invalid_string");
      }
      index = end + 1;
      continue;
    }
    const number = rest.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_][A-Za-z0-9._-]*/);
    if (identifier) {
      const value = identifier[0]!;
      const normalized = value.toLowerCase();
      if (normalized === "true" || normalized === "false") {
        tokens.push({ kind: "boolean", value: normalized === "true" });
      } else if (normalized === "null") {
        tokens.push({ kind: "null" });
      } else {
        tokens.push({ kind: "identifier", value });
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
      tokens.push({ kind });
      index += 1;
      continue;
    }
    throw new FilterPanelExpressionError("invalid_token");
  }
  return [...tokens, { kind: "end" }];
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private readonly registry: FilterFieldRegistry,
  ) {}

  parse(): FilterExpression {
    const expression = this.orExpression();
    if (this.current.kind !== "end") {
      throw new FilterPanelExpressionError("unexpected_token");
    }
    return expression;
  }

  private get current(): Token {
    return this.tokens[this.index]!;
  }

  private consume(kind: Token["kind"]): boolean {
    if (this.current.kind !== kind) return false;
    this.index += 1;
    return true;
  }

  private consumeKeyword(keyword: "and" | "or" | "not"): boolean {
    if (
      this.current.kind !== "identifier" ||
      this.current.value.toLowerCase() !== keyword
    ) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private expectIdentifier(): string {
    if (this.current.kind !== "identifier") {
      throw new FilterPanelExpressionError("expected_identifier");
    }
    const value = this.current.value;
    this.index += 1;
    return value;
  }

  private orExpression(): FilterExpression {
    const children = [this.andExpression()];
    while (this.consumeKeyword("or")) {
      children.push(this.andExpression());
    }
    return children.length === 1 ? children[0]! : { kind: "or", children };
  }

  private andExpression(): FilterExpression {
    const children = [this.unaryExpression()];
    while (this.consumeKeyword("and")) {
      children.push(this.unaryExpression());
    }
    return children.length === 1 ? children[0]! : { kind: "and", children };
  }

  private unaryExpression(): FilterExpression {
    if (this.consumeKeyword("not")) {
      return { kind: "not", child: this.unaryExpression() };
    }
    const explicitGroup =
      this.current.kind === "identifier" &&
      (this.current.value.toLowerCase() === "and" ||
        this.current.value.toLowerCase() === "or") &&
      this.tokens[this.index + 1]?.kind === "open"
        ? (this.current.value.toLowerCase() as "and" | "or")
        : null;
    if (explicitGroup) {
      this.index += 2;
      const child = this.orExpression();
      if (!this.consume("close")) {
        throw new FilterPanelExpressionError("missing_closing_parenthesis");
      }
      return { kind: explicitGroup, children: [child] };
    }
    if (this.consume("open")) {
      const expression = this.orExpression();
      if (!this.consume("close")) {
        throw new FilterPanelExpressionError("missing_closing_parenthesis");
      }
      return expression;
    }
    return this.condition();
  }

  private condition(): FilterCondition {
    const field = this.expectIdentifier();
    const target = this.target(field);
    const operator = OPERATORS.get(this.expectIdentifier().toLowerCase());
    if (!operator) throw new FilterPanelExpressionError("unknown_operator");
    if (VALUELESS_OPERATORS.has(operator)) {
      return { kind: "condition", target, operator };
    }
    return {
      kind: "condition",
      target,
      operator,
      value: this.value(),
    };
  }

  private target(field: string): FilterCondition["target"] {
    if (field === "event.payload" && this.consume("open")) {
      if (this.current.kind !== "string") {
        throw new FilterPanelExpressionError("expected_payload_path");
      }
      const path = this.current.value;
      this.index += 1;
      if (!this.consume("close")) {
        throw new FilterPanelExpressionError("missing_payload_parenthesis");
      }
      return { kind: "event-payload", path: path as CanonicalJsonPath };
    }
    return { kind: "field", field: field as FilterFieldId };
  }

  private value(): FilterValue | readonly FilterValue[] {
    if (this.consume("list-open")) {
      const values: FilterValue[] = [];
      if (this.consume("list-close")) return values;
      do {
        const value = this.scalarValue();
        values.push(value);
      } while (this.consume("comma"));
      if (!this.consume("list-close")) {
        throw new FilterPanelExpressionError("missing_list_bracket");
      }
      return values;
    }
    return this.scalarValue();
  }

  private scalarValue(): FilterValue {
    if (this.current.kind === "string") {
      const value = this.current.value;
      this.index += 1;
      return value;
    }
    if (this.current.kind === "number") {
      const value = this.current.value;
      this.index += 1;
      return value;
    }
    if (this.current.kind === "boolean") {
      const value = this.current.value;
      this.index += 1;
      return value;
    }
    if (this.consume("null")) return null;
    throw new FilterPanelExpressionError("expected_value");
  }
}

export function parseFilterPanelExpression(
  source: string,
  registry: FilterFieldRegistry,
): FilterDocument {
  if (!source.trim()) {
    return { version: FILTER_DOCUMENT_VERSION, root: null };
  }
  const root = new Parser(tokenize(source), registry).parse();

  // Validation intentionally happens on a separate pass. The normalized
  // document is ideal for transport and query fingerprints, but it also sorts
  // and deduplicates groups. The panel needs the pasted expression's ordering
  // and explicit boolean structure so its visual editor remains faithful to
  // what the user entered.
  normalizeFilterDocument(
    {
      version: FILTER_DOCUMENT_VERSION,
      root,
    },
    registry,
  );
  return { version: FILTER_DOCUMENT_VERSION, root };
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

export function formatFilterPanelExpression(document: FilterDocument): string {
  return document.root ? formatExpression(document.root) : "";
}
