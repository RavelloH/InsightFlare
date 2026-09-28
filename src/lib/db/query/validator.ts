import { isGeneratedSchemaObject } from "@/lib/db/schema";

import { DatabaseCompilerError } from "./errors";
import type {
  AnyExpression,
  Predicate,
  RelationScope,
  SqlExpression,
} from "./expression";
import type {
  AggregateNode,
  LogicalQueryNode,
  QuerySource,
  Relation,
  SortNode,
  UnionNode,
} from "./plan";

function invalid(message: string): never {
  throw new DatabaseCompilerError("invalid_plan", message);
}

function validateIdentifier(value: string): void {
  if (!value || value.includes("\0")) {
    throw new DatabaseCompilerError(
      "invalid_identifier",
      `Invalid SQL identifier: ${JSON.stringify(value)}`,
    );
  }
}

function validateExpression(
  expression: SqlExpression,
  scopes: ReadonlySet<RelationScope>,
  allowExcluded = false,
): void {
  switch (expression.kind) {
    case "column":
      if (!scopes.has(expression.scope))
        invalid(
          `Column "${expression.name}" is outside the visible relation scope`,
        );
      if (!Number.isInteger(expression.index) || expression.index < 0)
        invalid(`Invalid column index for "${expression.name}"`);
      validateIdentifier(expression.name);
      return;
    case "parameter":
      return;
    case "excluded":
      if (!allowExcluded)
        invalid("excluded() is only valid in an INSERT conflict update");
      validateIdentifier(expression.name);
      return;
    case "binary":
      if (
        !["=", "<>", ">", ">=", "<", "<=", "+", "-", "*", "/"].includes(
          expression.operator,
        )
      ) {
        invalid(`Unsupported binary operator: ${String(expression.operator)}`);
      }
      validateExpression(expression.left, scopes, allowExcluded);
      validateExpression(expression.right, scopes, allowExcluded);
      return;
    case "boolean":
      if (expression.expressions.length < 2)
        invalid(`${expression.operator} requires at least two predicates`);
      expression.expressions.forEach((child) =>
        validateExpression(child, scopes, allowExcluded),
      );
      return;
    case "not":
      validateExpression(expression.expression, scopes, allowExcluded);
      return;
    case "null-check":
      validateExpression(expression.expression, scopes, allowExcluded);
      return;
    case "in-list":
      validateExpression(expression.expression, scopes, allowExcluded);
      return;
    case "function":
      if (
        !["lower", "upper", "length", "abs", "round"].includes(expression.name)
      ) {
        throw new DatabaseCompilerError(
          "unsupported_expression",
          `Unsupported SQL function: ${String(expression.name)}`,
        );
      }
      expression.arguments.forEach((child) =>
        validateExpression(child, scopes, allowExcluded),
      );
      return;
    case "aggregate":
      if (!["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(expression.name)) {
        throw new DatabaseCompilerError(
          "unsupported_expression",
          `Unsupported aggregate: ${String(expression.name)}`,
        );
      }
      if (expression.expression)
        validateExpression(expression.expression, scopes, allowExcluded);
      return;
    case "coalesce":
      if (expression.expressions.length < 2)
        invalid("coalesce requires at least two expressions");
      expression.expressions.forEach((child) =>
        validateExpression(child, scopes, allowExcluded),
      );
      return;
    default: {
      const exhaustive: never = expression;
      throw new DatabaseCompilerError(
        "unsupported_expression",
        `Unsupported expression: ${String(exhaustive)}`,
      );
    }
  }
}

function sourceOf(node: LogicalQueryNode): QuerySource {
  return { node, scope: node.scope, fields: node.fields };
}

function validateSource(
  source: QuerySource,
  visited: Set<LogicalQueryNode>,
): void {
  if (visited.has(source.node)) return;
  visited.add(source.node);
  const node = source.node;
  node.fields.forEach((field) => validateIdentifier(field.name));
  const validateChild = (child: QuerySource) => validateSource(child, visited);
  const scopes = (...items: RelationScope[]) => new Set(items);
  switch (node.kind) {
    case "scan":
      if (!isGeneratedSchemaObject(node.table))
        invalid(
          "Scan requires a table or view from the generated schema catalog",
        );
      validateIdentifier(node.table.name);
      if (node.table.columns === null || typeof node.table.columns !== "object")
        invalid("Scan requires a generated table or view reference");
      for (const column of Object.values(node.table.columns))
        validateIdentifier(column.sqlName);
      if (node.fields.length !== Object.keys(node.table.columns).length)
        invalid("Scan output does not match catalog columns");
      return;
    case "filter": {
      validateChild(node.input);
      if (node.fields.length !== node.input.fields.length)
        invalid("Filter must preserve its input row shape");
      validateExpression(node.predicate, scopes(node.input.scope));
      return;
    }
    case "project": {
      validateChild(node.input);
      if (node.projections.length !== node.fields.length)
        invalid("Project output does not match its projection list");
      node.projections.forEach((projection, index) => {
        validateIdentifier(projection.name);
        if (projection.name !== node.fields[index]?.name)
          invalid("Project fields must match the projection list order");
        validateExpression(projection.expression, scopes(node.input.scope));
      });
      return;
    }
    case "join": {
      validateChild(node.left);
      validateChild(node.right);
      validateExpression(
        node.condition,
        scopes(node.left.scope, node.right.scope),
      );
      if (
        node.fields.length !==
        node.left.fields.length + node.right.fields.length
      )
        invalid("Join output does not match its input row shapes");
      return;
    }
    case "semi-join":
    case "anti-join": {
      validateChild(node.left);
      validateChild(node.right);
      validateExpression(
        node.condition,
        scopes(node.left.scope, node.right.scope),
      );
      if (node.fields.length !== node.left.fields.length)
        invalid(`${node.kind} must preserve the left row shape`);
      return;
    }
    case "aggregate": {
      const aggregate = node as AggregateNode;
      validateChild(aggregate.input);
      const expected = [...aggregate.groups, ...aggregate.aggregates];
      if (expected.length !== node.fields.length)
        invalid(
          "Aggregate output does not match its group and aggregate expressions",
        );
      for (const { name, expression } of expected) {
        validateIdentifier(name);
        validateExpression(expression, scopes(aggregate.input.scope));
      }
      if (
        aggregate.aggregates.some(
          ({ expression }) => expression.kind !== "aggregate",
        )
      )
        invalid("Aggregate outputs must be aggregate expressions");
      return;
    }
    case "distinct":
      validateChild(node.input);
      if (node.fields.length !== node.input.fields.length)
        invalid("Distinct must preserve its input row shape");
      return;
    case "sort": {
      const sort = node as SortNode;
      validateChild(sort.input);
      if (sort.keys.length === 0) invalid("Sort requires at least one key");
      sort.keys.forEach(({ expression }) =>
        validateExpression(expression, scopes(sort.input.scope)),
      );
      return;
    }
    case "limit":
      validateChild(node.input);
      validateExpression(node.count, scopes());
      if (node.offset) validateExpression(node.offset, scopes());
      if (
        node.count.kind !== "parameter" ||
        typeof node.count.value !== "number" ||
        node.count.value < 0 ||
        !Number.isSafeInteger(node.count.value)
      )
        invalid("Limit count must be a non-negative integer parameter");
      if (
        node.offset &&
        (node.offset.kind !== "parameter" ||
          typeof node.offset.value !== "number" ||
          node.offset.value < 0 ||
          !Number.isSafeInteger(node.offset.value))
      )
        invalid("Limit offset must be a non-negative integer parameter");
      return;
    case "union": {
      const union = node as UnionNode;
      validateChild(union.left);
      validateChild(union.right);
      if (
        union.left.fields.length !== union.right.fields.length ||
        union.left.fields.length !== node.fields.length
      )
        invalid("UNION inputs must have compatible row shapes");
      for (let i = 0; i < union.left.fields.length; i++) {
        if (union.left.fields[i]?.name !== union.right.fields[i]?.name)
          invalid(
            "UNION inputs must have matching output field names and order",
          );
      }
      return;
    }
  }
}

export function validateLogicalQueryPlan(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | LogicalQueryNode,
): void {
  const root = "node" in plan ? plan.node : plan;
  validateSource(sourceOf(root), new Set());
}

export function validatePredicate(
  predicate: Predicate,
  allowedScopes: readonly RelationScope[],
): void {
  validateExpression(predicate, new Set(allowedScopes));
}

export function validateMutationExpression(
  expression: SqlExpression,
  allowedScopes: readonly RelationScope[],
  allowExcluded = false,
): void {
  validateExpression(expression, new Set(allowedScopes), allowExcluded);
}

export function validateProjectionFields(
  fields: readonly { readonly name: string }[],
): void {
  const names = new Set<string>();
  for (const field of fields) {
    validateIdentifier(field.name);
    if (names.has(field.name)) invalid(`Duplicate output field: ${field.name}`);
    names.add(field.name);
  }
}
