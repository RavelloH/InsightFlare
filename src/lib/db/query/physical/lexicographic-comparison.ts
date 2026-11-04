import type {
  BinaryExpression,
  ColumnExpression,
  RelationScope,
  SqlExpression,
} from "@/lib/db/query/expression";
import type {
  LogicalQueryNode,
  OutputField,
  QuerySource,
} from "@/lib/db/query/plan";

type BooleanPredicateExpression = Extract<SqlExpression, { kind: "boolean" }>;

/** A strict, same-direction lexicographic comparison found in a predicate. */
export interface PhysicalLexicographicComparisonChoice {
  readonly expression: BooleanPredicateExpression;
  readonly direction: ">" | "<";
  readonly components: readonly {
    readonly left: ColumnExpression;
    readonly right: ColumnExpression;
    readonly equalityGuard?: BinaryExpression;
  }[];
}

function nodeExpressions(node: LogicalQueryNode): readonly SqlExpression[] {
  switch (node.kind) {
    case "filter":
      return [node.predicate];
    case "project":
      return node.projections.map(({ expression }) => expression);
    case "join":
    case "semi-join":
    case "anti-join":
      return [node.condition];
    case "aggregate":
      return [
        ...node.groups.map(({ expression }) => expression),
        ...node.aggregates.map(({ expression }) => expression),
      ];
    case "sort":
      return node.keys.map(({ expression }) => expression);
    case "window":
      return node.windows.flatMap(({ specification }) => [
        ...specification.partitionBy,
        ...(specification.kind === "row-number"
          ? specification.orderBy.map(({ expression }) => expression)
          : []),
      ]);
    case "limit":
      return [node.count, ...(node.offset ? [node.offset] : [])];
    case "recursive-closure":
      return [node.predicate];
    case "scan":
    case "values-relation":
    case "json-scalar-array":
    case "distinct":
    case "union":
      return [];
  }
}

function nodeChildren(node: LogicalQueryNode): QuerySource[] {
  return node.kind === "scan" ||
    node.kind === "values-relation" ||
    node.kind === "json-scalar-array"
    ? []
    : node.kind === "filter" ||
        node.kind === "project" ||
        node.kind === "aggregate" ||
        node.kind === "distinct" ||
        node.kind === "window" ||
        node.kind === "sort" ||
        node.kind === "limit"
      ? [node.input]
      : node.kind === "recursive-closure"
        ? [node.seed, node.candidates]
        : [node.left, node.right];
}

function visitExpressionQuerySources(
  expression: SqlExpression,
  visitSource: (source: QuerySource) => void,
): void {
  const visit = (current: SqlExpression): void => {
    switch (current.kind) {
      case "binary":
      case "distinct-from":
        visit(current.left);
        visit(current.right);
        break;
      case "boolean":
        current.expressions.forEach(visit);
        break;
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-real":
      case "cast-text":
        visit(current.expression);
        break;
      case "text-position":
        visit(current.text);
        visit(current.needle);
        break;
      case "text-substring":
        visit(current.text);
        visit(current.start);
        if (current.length) visit(current.length);
        break;
      case "text-like":
        visit(current.text);
        visit(current.pattern);
        break;
      case "in-list":
        visit(current.expression);
        break;
      case "in-subquery":
        visit(current.expression);
        visitSource(current.query);
        break;
      case "function":
        current.arguments.forEach(visit);
        break;
      case "aggregate":
        if (current.expression) visit(current.expression);
        break;
      case "coalesce":
        current.expressions.forEach(visit);
        break;
      case "case":
        current.branches.forEach((branch) => {
          visit(branch.when);
          visit(branch.then);
        });
        if (current.else) visit(current.else);
        break;
      case "scalar-subquery":
        visitSource(current.query);
        break;
      case "column":
      case "parameter":
      case "excluded":
      case "unixepoch":
      case "constant":
        break;
    }
  };
  visit(expression);
}

function sameColumnIdentity(
  left: ColumnExpression,
  right: ColumnExpression,
): boolean {
  return (
    left.scope === right.scope &&
    left.index === right.index &&
    left.name === right.name &&
    left.resultType.affinity === right.resultType.affinity &&
    left.resultType.nullable === right.resultType.nullable
  );
}

function directColumnComparison(
  expression: SqlExpression,
  operator: ">" | "<" | "=",
): BinaryExpression | undefined {
  return expression.kind === "binary" &&
    expression.operator === operator &&
    expression.left.kind === "column" &&
    expression.right.kind === "column"
    ? expression
    : undefined;
}

function scopeFields(
  root: LogicalQueryNode,
): ReadonlyMap<RelationScope, readonly OutputField[]> {
  const scopes = new Map<RelationScope, readonly OutputField[]>();
  const visited = new Set<LogicalQueryNode>();
  const visit = (source: QuerySource): void => {
    if (visited.has(source.node)) return;
    visited.add(source.node);
    scopes.set(source.scope, source.fields);
    for (const child of nodeChildren(source.node)) visit(child);
    for (const expression of nodeExpressions(source.node))
      visitExpressionQuerySources(expression, visit);
  };
  visit({ node: root, scope: root.scope, fields: root.fields });
  return scopes;
}

function columnMatchesFields(
  column: ColumnExpression,
  fieldsByScope: ReadonlyMap<RelationScope, readonly OutputField[]>,
): boolean {
  const fields = fieldsByScope.get(column.scope);
  if (!fields || !Number.isInteger(column.index) || column.index < 0)
    return false;
  const field = fields[column.index];
  return (
    field !== undefined &&
    field.name === column.name &&
    field.affinity === column.resultType.affinity &&
    field.nullable === column.resultType.nullable
  );
}

function matchAtRoot(
  expression: BooleanPredicateExpression,
  fieldsByScope: ReadonlyMap<RelationScope, readonly OutputField[]>,
): PhysicalLexicographicComparisonChoice | undefined {
  if (expression.operator !== "OR" || expression.expressions.length !== 2)
    return undefined;
  const components: PhysicalLexicographicComparisonChoice["components"][number][] =
    [];
  let direction: ">" | "<" | undefined;
  let current: SqlExpression = expression;
  while (current.kind === "boolean") {
    if (current.operator !== "OR" || current.expressions.length !== 2)
      return undefined;
    const strict =
      directColumnComparison(current.expressions[0]!, direction ?? ">") ??
      (direction === undefined
        ? directColumnComparison(current.expressions[0]!, "<")
        : undefined);
    if (!strict) return undefined;
    const strictDirection = strict.operator as ">" | "<";
    if (direction !== undefined && strictDirection !== direction)
      return undefined;
    direction = strictDirection;
    const left = strict.left as ColumnExpression;
    const right = strict.right as ColumnExpression;
    if (
      !columnMatchesFields(left, fieldsByScope) ||
      !columnMatchesFields(right, fieldsByScope)
    )
      return undefined;
    const tail: SqlExpression = current.expressions[1]!;
    if (
      tail.kind !== "boolean" ||
      tail.operator !== "AND" ||
      tail.expressions.length !== 2
    )
      return undefined;
    const equality = directColumnComparison(tail.expressions[0]!, "=");
    if (
      !equality ||
      !sameColumnIdentity(equality.left as ColumnExpression, left) ||
      !sameColumnIdentity(equality.right as ColumnExpression, right) ||
      !columnMatchesFields(equality.left as ColumnExpression, fieldsByScope) ||
      !columnMatchesFields(equality.right as ColumnExpression, fieldsByScope)
    )
      return undefined;
    components.push({ left, right, equalityGuard: equality });
    const next: SqlExpression = tail.expressions[1]!;
    if (next.kind === "boolean" && next.operator === "OR") {
      current = next;
      continue;
    }
    const last = directColumnComparison(next, strictDirection);
    if (
      !last ||
      !columnMatchesFields(last.left as ColumnExpression, fieldsByScope) ||
      !columnMatchesFields(last.right as ColumnExpression, fieldsByScope)
    )
      return undefined;
    components.push({
      left: last.left as ColumnExpression,
      right: last.right as ColumnExpression,
    });
    break;
  }
  if (!direction || components.length < 2) return undefined;
  return { expression, direction, components };
}

/** Freshly derives canonical choices from every logical expression location. */
export function lexicographicComparisonChoices(
  root: LogicalQueryNode,
): readonly PhysicalLexicographicComparisonChoice[] {
  const fieldsByScope = scopeFields(root);
  const choices: PhysicalLexicographicComparisonChoice[] = [];
  const seenNodes = new Set<LogicalQueryNode>();
  const seenExpressions = new Set<SqlExpression>();
  const visitExpression = (expression: SqlExpression): void => {
    if (seenExpressions.has(expression)) return;
    seenExpressions.add(expression);
    if (expression.kind === "boolean") {
      const choice = matchAtRoot(expression, fieldsByScope);
      if (choice) choices.push(choice);
      expression.expressions.forEach(visitExpression);
      return;
    }
    switch (expression.kind) {
      case "binary":
      case "distinct-from":
        visitExpression(expression.left);
        visitExpression(expression.right);
        break;
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-real":
      case "cast-text":
      case "in-list":
        visitExpression(expression.expression);
        break;
      case "text-position":
        visitExpression(expression.text);
        visitExpression(expression.needle);
        break;
      case "text-substring":
        visitExpression(expression.text);
        visitExpression(expression.start);
        if (expression.length) visitExpression(expression.length);
        break;
      case "text-like":
        visitExpression(expression.text);
        visitExpression(expression.pattern);
        break;
      case "in-subquery":
        visitExpression(expression.expression);
        visitSource(expression.query);
        break;
      case "function":
        expression.arguments.forEach(visitExpression);
        break;
      case "aggregate":
        if (expression.expression) visitExpression(expression.expression);
        break;
      case "coalesce":
        expression.expressions.forEach(visitExpression);
        break;
      case "case":
        expression.branches.forEach((branch) => {
          visitExpression(branch.when);
          visitExpression(branch.then);
        });
        if (expression.else) visitExpression(expression.else);
        break;
      case "scalar-subquery":
        visitSource(expression.query);
        break;
      case "column":
      case "parameter":
      case "excluded":
      case "unixepoch":
      case "constant":
        break;
    }
  };
  const visitSource = (source: QuerySource): void => {
    if (seenNodes.has(source.node)) return;
    seenNodes.add(source.node);
    for (const child of nodeChildren(source.node)) visitSource(child);
    for (const expression of nodeExpressions(source.node))
      visitExpression(expression);
  };
  visitSource({ node: root, scope: root.scope, fields: root.fields });
  return choices;
}

export function sameLexicographicComparisonChoices(
  actual: readonly PhysicalLexicographicComparisonChoice[],
  expected: readonly PhysicalLexicographicComparisonChoice[],
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  // Array iteration skips holes. A missing component must not silently remove
  // a lexicographic key from the SQL tuple while passing physical validation.
  for (let index = 0; index < expected.length; index += 1) {
    if (!Object.hasOwn(actual, index)) return false;
    const choice = actual[index];
    const canonical = expected[index];
    if (
      !choice ||
      typeof choice !== "object" ||
      !canonical ||
      choice.expression !== canonical.expression ||
      choice.direction !== canonical.direction ||
      !Array.isArray(choice.components) ||
      choice.components.length !== canonical.components.length
    )
      return false;
    for (
      let componentIndex = 0;
      componentIndex < canonical.components.length;
      componentIndex += 1
    ) {
      if (!Object.hasOwn(choice.components, componentIndex)) return false;
      const component = choice.components[componentIndex];
      const expectedComponent = canonical.components[componentIndex];
      if (
        !component ||
        typeof component !== "object" ||
        !expectedComponent ||
        component.left !== expectedComponent.left ||
        component.right !== expectedComponent.right ||
        component.equalityGuard !== expectedComponent.equalityGuard
      )
        return false;
    }
  }
  return true;
}
