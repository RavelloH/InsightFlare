import { isGeneratedSchemaObject } from "@/lib/db/schema";

import { DatabaseCompilerError } from "./errors";
import {
  type AnyExpression,
  coalesceResultAffinity,
  commonAffinity,
  parameterResultType,
  type Predicate,
  type RelationScope,
  type SqlExpression,
} from "./expression";
import type {
  AggregateNode,
  LogicalQueryNode,
  OutputField,
  QuerySource,
  Relation,
  SortNode,
  UnionNode,
} from "./plan";

export type ExpressionScopeMetadata = ReadonlyMap<
  RelationScope,
  readonly OutputField[] | undefined
>;

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

function validateResultType(
  expression: SqlExpression,
  affinity: OutputField["affinity"],
  nullable: boolean,
): void {
  if (
    expression.resultType.affinity !== affinity ||
    expression.resultType.nullable !== nullable
  )
    invalid(`${expression.kind} result metadata does not match its SQL result`);
}

function isNumeric(affinity: OutputField["affinity"]): boolean {
  return ["integer", "real", "numeric", "unknown"].includes(affinity);
}

function comparableAffinities(
  left: OutputField["affinity"],
  right: OutputField["affinity"],
): boolean {
  if (left === "unknown" || right === "unknown" || left === right) return true;
  return isNumeric(left) && isNumeric(right);
}

function validateExpression(
  expression: SqlExpression,
  scopes: ExpressionScopeMetadata,
  activeSources: Set<LogicalQueryNode>,
  allowExcluded = false,
): void {
  if (
    !expression.resultType ||
    !["integer", "real", "text", "blob", "numeric", "unknown"].includes(
      expression.resultType.affinity,
    ) ||
    typeof expression.resultType.nullable !== "boolean"
  )
    invalid(`${expression.kind} is missing valid result metadata`);
  switch (expression.kind) {
    case "column":
      if (!scopes.has(expression.scope))
        invalid(
          `Column "${expression.name}" is outside the visible relation scope`,
        );
      if (!Number.isInteger(expression.index) || expression.index < 0)
        invalid(`Invalid column index for "${expression.name}"`);
      validateIdentifier(expression.name);
      {
        const fields = scopes.get(expression.scope);
        if (fields !== undefined) {
          const field = fields[expression.index];
          if (!field)
            invalid(
              `Column index is outside the scope for "${expression.name}"`,
            );
          validateResultType(expression, field.affinity, field.nullable);
        }
      }
      return;
    case "parameter":
      {
        const result = parameterResultType(expression.value);
        validateResultType(expression, result.affinity, result.nullable);
      }
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
      validateExpression(expression.left, scopes, activeSources, allowExcluded);
      validateExpression(
        expression.right,
        scopes,
        activeSources,
        allowExcluded,
      );
      if (["=", "<>", ">", ">=", "<", "<="].includes(expression.operator)) {
        if (
          !comparableAffinities(
            expression.left.resultType.affinity,
            expression.right.resultType.affinity,
          )
        )
          invalid("Comparison operands have incompatible SQL affinities");
        validateResultType(
          expression,
          "integer",
          expression.left.resultType.nullable ||
            expression.right.resultType.nullable,
        );
      } else {
        if (
          !isNumeric(expression.left.resultType.affinity) ||
          !isNumeric(expression.right.resultType.affinity)
        )
          invalid("Arithmetic operands must have numeric or unknown affinity");
        validateResultType(
          expression,
          "numeric",
          expression.operator === "/" ||
            expression.left.resultType.nullable ||
            expression.right.resultType.nullable,
        );
      }
      return;
    case "boolean":
      if (expression.operator !== "AND" && expression.operator !== "OR")
        invalid(`Unsupported boolean operator: ${String(expression.operator)}`);
      if (expression.expressions.length < 2)
        invalid(`${expression.operator} requires at least two predicates`);
      expression.expressions.forEach((child) =>
        validateExpression(child, scopes, activeSources, allowExcluded),
      );
      validateResultType(
        expression,
        "integer",
        expression.expressions.some((child) => child.resultType.nullable),
      );
      return;
    case "not":
      validateExpression(
        expression.expression,
        scopes,
        activeSources,
        allowExcluded,
      );
      validateResultType(
        expression,
        "integer",
        expression.expression.resultType.nullable,
      );
      return;
    case "null-check":
      validateExpression(
        expression.expression,
        scopes,
        activeSources,
        allowExcluded,
      );
      validateResultType(expression, "integer", false);
      return;
    case "in-list":
      validateExpression(
        expression.expression,
        scopes,
        activeSources,
        allowExcluded,
      );
      validateResultType(
        expression,
        "integer",
        expression.values.length > 0 &&
          (expression.expression.resultType.nullable ||
            expression.values.includes(null)),
      );
      return;
    case "in-subquery": {
      validateExpression(
        expression.expression,
        scopes,
        activeSources,
        allowExcluded,
      );
      if (expression.query.fields.length !== 1)
        invalid("inSubquery() requires a query with exactly one output field");
      validateSource(expression.query, activeSources, scopes);
      const field = expression.query.fields[0]!;
      if (
        !comparableAffinities(
          expression.expression.resultType.affinity,
          field.affinity,
        )
      )
        invalid("IN operands have incompatible SQL affinities");
      validateResultType(
        expression,
        "integer",
        expression.expression.resultType.nullable || field.nullable,
      );
      return;
    }
    case "function":
      if (
        !["lower", "upper", "trim", "length", "abs", "round"].includes(
          expression.name,
        )
      ) {
        throw new DatabaseCompilerError(
          "unsupported_expression",
          `Unsupported SQL function: ${String(expression.name)}`,
        );
      }
      if (expression.arguments.length !== 1)
        invalid(`${expression.name}() requires exactly one argument`);
      expression.arguments.forEach((child) =>
        validateExpression(child, scopes, activeSources, allowExcluded),
      );
      {
        const argument = expression.arguments[0]!;
        const affinity = argument.resultType.affinity;
        if (
          ((expression.name === "lower" ||
            expression.name === "upper" ||
            expression.name === "trim") &&
            affinity !== "text" &&
            affinity !== "unknown") ||
          (expression.name === "length" &&
            affinity !== "text" &&
            affinity !== "blob" &&
            affinity !== "unknown") ||
          ((expression.name === "abs" || expression.name === "round") &&
            !isNumeric(affinity))
        )
          invalid(
            `${expression.name}() received an incompatible argument affinity`,
          );
        const resultAffinity =
          expression.name === "lower" ||
          expression.name === "upper" ||
          expression.name === "trim"
            ? "text"
            : expression.name === "length"
              ? "integer"
              : "numeric";
        validateResultType(
          expression,
          resultAffinity,
          argument.resultType.nullable,
        );
      }
      return;
    case "aggregate":
      if (!["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(expression.name)) {
        throw new DatabaseCompilerError(
          "unsupported_expression",
          `Unsupported aggregate: ${String(expression.name)}`,
        );
      }
      if (expression.expression)
        validateExpression(
          expression.expression,
          scopes,
          activeSources,
          allowExcluded,
        );
      if (expression.name === "COUNT") {
        validateResultType(expression, "integer", false);
      } else if (expression.name === "SUM" || expression.name === "AVG") {
        if (
          !expression.expression ||
          !isNumeric(expression.expression.resultType.affinity)
        )
          invalid(`${expression.name}() requires a numeric expression`);
        validateResultType(expression, "numeric", true);
      } else {
        if (!expression.expression)
          invalid(`${expression.name}() requires an expression`);
        validateResultType(
          expression,
          expression.expression.resultType.affinity,
          true,
        );
      }
      return;
    case "coalesce":
      if (expression.expressions.length < 2)
        invalid("coalesce requires at least two expressions");
      expression.expressions.forEach((child) =>
        validateExpression(child, scopes, activeSources, allowExcluded),
      );
      validateResultType(
        expression,
        coalesceResultAffinity(expression.expressions),
        expression.expressions.every((child) => child.resultType.nullable),
      );
      return;
    case "case": {
      if (!Array.isArray(expression.branches) || expression.branches.length < 1)
        invalid("caseWhen() requires at least one WHEN branch");

      const resultExpressions: SqlExpression[] = [];
      for (const branch of expression.branches) {
        if (
          !branch ||
          typeof branch !== "object" ||
          !branch.when ||
          typeof branch.when !== "object" ||
          !branch.then ||
          typeof branch.then !== "object"
        )
          invalid("CASE contains an invalid WHEN branch");
        validateExpression(branch.when, scopes, activeSources, allowExcluded);
        if (branch.when.resultType.affinity !== "integer")
          invalid("CASE WHEN expression must have integer predicate affinity");
        validateExpression(branch.then, scopes, activeSources, allowExcluded);
        resultExpressions.push(branch.then);
      }

      if (expression.else !== undefined) {
        if (!expression.else || typeof expression.else !== "object")
          invalid("CASE ELSE must be an expression");
        validateExpression(
          expression.else,
          scopes,
          activeSources,
          allowExcluded,
        );
        resultExpressions.push(expression.else);
      }

      let affinity: OutputField["affinity"] | undefined;
      for (const resultExpression of resultExpressions) {
        const common =
          affinity === undefined
            ? resultExpression.resultType.affinity
            : commonAffinity(affinity, resultExpression.resultType.affinity);
        if (common === undefined)
          invalid("CASE result branches have incompatible SQL affinities");
        affinity = common;
      }

      validateResultType(
        expression,
        affinity ?? "unknown",
        expression.else === undefined ||
          resultExpressions.some((item) => item.resultType.nullable),
      );
      return;
    }
    case "unixepoch":
      if (
        expression.resultType.affinity !== "integer" ||
        expression.resultType.nullable
      )
        invalid("unixepoch() result metadata must be integer and non-null");
      validateResultType(expression, "integer", false);
      return;
    case "scalar-subquery": {
      if (expression.query.fields.length !== 1)
        invalid("scalar() requires a query with exactly one output field");
      validateSource(expression.query, activeSources, scopes);
      const field = expression.query.fields[0]!;
      validateResultType(expression, field.affinity, true);
      return;
    }
  }
}

function sourceOf(node: LogicalQueryNode): QuerySource {
  return { node, scope: node.scope, fields: node.fields };
}

function sameFieldMetadata(
  left: {
    readonly name: string;
    readonly affinity: string;
    readonly nullable: boolean;
  },
  right: {
    readonly name: string;
    readonly affinity: string;
    readonly nullable: boolean;
  },
): boolean {
  return (
    left.name === right.name &&
    left.affinity === right.affinity &&
    left.nullable === right.nullable
  );
}

function validateSource(
  source: QuerySource,
  activeSources: Set<LogicalQueryNode>,
  outerScopes: ExpressionScopeMetadata = new Map(),
): void {
  if (activeSources.has(source.node)) invalid("Query plan contains a cycle");
  activeSources.add(source.node);
  try {
    const node = source.node;
    node.fields.forEach((field) => validateIdentifier(field.name));
    if (
      source.scope !== node.scope ||
      source.fields.length !== node.fields.length ||
      source.fields.some(
        (field, index) => !sameFieldMetadata(field, node.fields[index]!),
      )
    )
      invalid("Query source metadata does not match its logical node");
    const visibleScopes = (...items: QuerySource[]): ExpressionScopeMetadata =>
      new Map([
        ...outerScopes,
        ...items.map((item) => [item.scope, item.fields] as const),
      ]);
    const validateChild = (child: QuerySource) =>
      validateSource(child, activeSources, outerScopes);
    switch (node.kind) {
      case "scan": {
        if (!isGeneratedSchemaObject(node.table))
          invalid(
            "Scan requires a table or view from the generated schema catalog",
          );
        validateIdentifier(node.table.name);
        if (
          node.table.columns === null ||
          typeof node.table.columns !== "object"
        )
          invalid("Scan requires a generated table or view reference");
        const entries = Object.entries(node.table.columns);
        if (node.fields.length !== entries.length)
          invalid("Scan output does not match catalog columns");
        entries.forEach(([name, column], index) => {
          validateIdentifier(column.sqlName);
          const field = node.fields[index];
          if (
            !field ||
            field.name !== name ||
            field.affinity !== column.affinity ||
            field.nullable !== column.nullable
          )
            invalid("Scan output metadata must match the generated catalog");
        });
        return;
      }
      case "filter": {
        validateChild(node.input);
        if (
          node.fields.length !== node.input.fields.length ||
          node.fields.some(
            (field, index) =>
              !sameFieldMetadata(field, node.input.fields[index]!),
          )
        )
          invalid("Filter must preserve its input row shape and metadata");
        validateExpression(
          node.predicate,
          visibleScopes(node.input),
          activeSources,
        );
        return;
      }
      case "project": {
        validateChild(node.input);
        if (node.projections.length !== node.fields.length)
          invalid("Project output does not match its projection list");
        node.projections.forEach((projection, index) => {
          validateIdentifier(projection.name);
          const field = node.fields[index];
          if (projection.name !== field?.name)
            invalid("Project fields must match the projection list order");
          validateExpression(
            projection.expression,
            visibleScopes(node.input),
            activeSources,
          );
          if (
            field.affinity !== projection.expression.resultType.affinity ||
            field.nullable !== projection.expression.resultType.nullable
          )
            invalid("Project output metadata must match its expression");
        });
        return;
      }
      case "join": {
        validateChild(node.left);
        validateChild(node.right);
        validateExpression(
          node.condition,
          visibleScopes(node.left, node.right),
          activeSources,
        );
        const expected = [
          ...node.left.fields.map((field) => ({
            name: `left_${field.name}`,
            affinity: field.affinity,
            nullable: field.nullable,
          })),
          ...node.right.fields.map((field) => ({
            name: `right_${field.name}`,
            affinity: field.affinity,
            nullable: node.joinType === "left" || field.nullable,
          })),
        ];
        if (
          node.fields.length !== expected.length ||
          node.fields.some(
            (field, index) => !sameFieldMetadata(field, expected[index]!),
          )
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
          visibleScopes(node.left, node.right),
          activeSources,
        );
        if (
          node.fields.length !== node.left.fields.length ||
          node.fields.some(
            (field, index) =>
              !sameFieldMetadata(field, node.left.fields[index]!),
          )
        )
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
        expected.forEach(({ name, expression }, index) => {
          validateIdentifier(name);
          validateExpression(
            expression,
            visibleScopes(aggregate.input),
            activeSources,
          );
          const field = node.fields[index]!;
          if (
            field.name !== name ||
            field.affinity !== expression.resultType.affinity ||
            field.nullable !== expression.resultType.nullable
          )
            invalid("Aggregate output metadata must match its expression");
        });
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
        if (
          node.fields.length !== node.input.fields.length ||
          node.fields.some(
            (field, index) =>
              !sameFieldMetadata(field, node.input.fields[index]!),
          )
        )
          invalid("Distinct must preserve its input row shape");
        return;
      case "sort": {
        const sort = node as SortNode;
        validateChild(sort.input);
        if (sort.keys.length === 0) invalid("Sort requires at least one key");
        sort.keys.forEach(({ expression }) =>
          validateExpression(
            expression,
            visibleScopes(sort.input),
            activeSources,
          ),
        );
        if (
          node.fields.length !== sort.input.fields.length ||
          node.fields.some(
            (field, index) =>
              !sameFieldMetadata(field, sort.input.fields[index]!),
          )
        )
          invalid("Sort must preserve its input row shape");
        return;
      }
      case "limit":
        validateChild(node.input);
        validateExpression(node.count, outerScopes, activeSources);
        if (node.offset)
          validateExpression(node.offset, outerScopes, activeSources);
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
        if (
          node.fields.length !== node.input.fields.length ||
          node.fields.some(
            (field, index) =>
              !sameFieldMetadata(field, node.input.fields[index]!),
          )
        )
          invalid("Limit must preserve its input row shape");
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
        for (let index = 0; index < union.left.fields.length; index++) {
          const left = union.left.fields[index]!;
          const right = union.right.fields[index]!;
          const result = node.fields[index]!;
          const affinity = commonAffinity(left.affinity, right.affinity);
          if (!affinity)
            invalid(
              `UNION field "${left.name}" has incompatible affinities ${left.affinity} and ${right.affinity}`,
            );
          if (
            left.name !== right.name ||
            result.name !== left.name ||
            result.affinity !== affinity ||
            result.nullable !== (left.nullable || right.nullable)
          )
            invalid("UNION output metadata is not compatible with its inputs");
        }
        return;
      }
    }
  } finally {
    activeSources.delete(source.node);
  }
}

export function validateLogicalQueryPlan(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | LogicalQueryNode,
): void {
  const root = "node" in plan ? plan.node : plan;
  validateSource(sourceOf(root), new Set(), new Map());
}

export function validatePredicate(
  predicate: Predicate,
  allowedScopes: readonly RelationScope[],
  scopeFields?: ExpressionScopeMetadata,
): void {
  validateExpression(
    predicate,
    new Map(allowedScopes.map((scope) => [scope, scopeFields?.get(scope)])),
    new Set(),
  );
}

export function validateMutationExpression(
  expression: SqlExpression,
  allowedScopes: readonly RelationScope[],
  allowExcluded = false,
  scopeFields?: ExpressionScopeMetadata,
): void {
  validateExpression(
    expression,
    new Map(allowedScopes.map((scope) => [scope, scopeFields?.get(scope)])),
    new Set(),
    allowExcluded,
  );
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
