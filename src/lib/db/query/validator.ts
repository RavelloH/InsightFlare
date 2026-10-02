import { isGeneratedSchemaObject } from "@/lib/db/schema";

import { DatabaseCompilerError } from "./errors";
import {
  type AnyExpression,
  assertWellFormedTextPattern,
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
  RecursiveClosureNode,
  Relation,
  SortNode,
  UnionNode,
  ValuesRelationNode,
  WindowNode,
  WindowOrderKey,
  WindowSpecification,
} from "./plan";
import { hasOwnedRecursiveClosureScopes } from "./plan";

export type ExpressionScopeMetadata = ReadonlyMap<
  RelationScope,
  readonly OutputField[] | undefined
>;

function invalid(message: string): never {
  throw new DatabaseCompilerError("invalid_plan", message);
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function wellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function denseArray(value: unknown, length: number): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    Object.getPrototypeOf(value) !== Array.prototype
  )
    return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === length + 1 &&
    keys.includes("length") &&
    Array.from(
      { length },
      (_item, index) =>
        Object.getOwnPropertyDescriptor(value, String(index)) !== undefined &&
        "value" in Object.getOwnPropertyDescriptor(value, String(index))!,
    ).every(Boolean)
  );
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
    case "distinct-from":
      validateExpression(expression.left, scopes, activeSources, allowExcluded);
      validateExpression(
        expression.right,
        scopes,
        activeSources,
        allowExcluded,
      );
      if (
        !comparableAffinities(
          expression.left.resultType.affinity,
          expression.right.resultType.affinity,
        )
      )
        invalid("Comparison operands have incompatible SQL affinities");
      validateResultType(expression, "integer", false);
      return;
    case "cast-integer":
      validateExpression(
        expression.expression,
        scopes,
        activeSources,
        allowExcluded,
      );
      if (!isNumeric(expression.expression.resultType.affinity))
        invalid("CAST AS INTEGER requires a numeric or unknown expression");
      validateResultType(
        expression,
        "integer",
        expression.expression.resultType.nullable,
      );
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
      if (expression.name === "concat-text") {
        if (expression.arguments.length < 2)
          invalid("concatText() requires at least two arguments");
        expression.arguments.forEach((child) => {
          if (!child || typeof child !== "object")
            invalid("concatText() contains an invalid operand");
          validateExpression(child, scopes, activeSources, allowExcluded);
        });
        const accepted = new Set([
          "text",
          "integer",
          "real",
          "numeric",
          "unknown",
        ]);
        if (
          expression.arguments.some(
            (argument) => !accepted.has(argument.resultType.affinity),
          )
        )
          invalid("concatText() received an incompatible argument affinity");
        validateResultType(
          expression,
          "text",
          expression.arguments.some((argument) => argument.resultType.nullable),
        );
        return;
      }
      if (
        expression.name === "text-contains" ||
        expression.name === "text-starts-with" ||
        expression.name === "text-ends-with"
      ) {
        if (
          !Array.isArray(expression.arguments) ||
          expression.arguments.length !== 2
        )
          invalid(`${expression.name}() requires exactly two arguments`);
        const input = expression.arguments[0];
        const pattern = expression.arguments[1];
        if (
          !input ||
          typeof input !== "object" ||
          !pattern ||
          typeof pattern !== "object"
        )
          invalid(`${expression.name}() contains an invalid operand`);
        validateExpression(input, scopes, activeSources, allowExcluded);
        validateExpression(pattern, scopes, activeSources, allowExcluded);
        if (input.resultType.affinity !== "text")
          invalid(`${expression.name}() requires a TEXT input expression`);
        if (
          pattern.kind !== "parameter" ||
          typeof pattern.value !== "string" ||
          pattern.resultType.affinity !== "text" ||
          pattern.resultType.nullable
        )
          invalid(`${expression.name}() requires a non-NULL string parameter`);
        const publicName =
          expression.name === "text-contains"
            ? "textContains"
            : expression.name === "text-starts-with"
              ? "textStartsWith"
              : "textEndsWith";
        assertWellFormedTextPattern(publicName, pattern.value);
        validateResultType(expression, "integer", input.resultType.nullable);
        return;
      }
      if (
        ![
          "lower",
          "upper",
          "trim",
          "trim-spaces",
          "length",
          "abs",
          "round",
        ].includes(expression.name)
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
            expression.name === "trim" ||
            expression.name === "trim-spaces") &&
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
          expression.name === "trim" ||
          expression.name === "trim-spaces"
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

function closureExpressionSources(expression: SqlExpression): QuerySource[] {
  switch (expression.kind) {
    case "binary":
    case "distinct-from":
      return [
        ...closureExpressionSources(expression.left),
        ...closureExpressionSources(expression.right),
      ];
    case "boolean":
      return expression.expressions.flatMap(closureExpressionSources);
    case "not":
    case "null-check":
    case "cast-integer":
      return closureExpressionSources(expression.expression);
    case "in-list":
      return closureExpressionSources(expression.expression);
    case "in-subquery":
      return [
        ...closureExpressionSources(expression.expression),
        expression.query,
      ];
    case "function":
      return expression.arguments.flatMap(closureExpressionSources);
    case "aggregate":
      return expression.expression
        ? closureExpressionSources(expression.expression)
        : [];
    case "coalesce":
      return expression.expressions.flatMap(closureExpressionSources);
    case "case":
      return [
        ...expression.branches.flatMap((branch) => [
          ...closureExpressionSources(branch.when),
          ...closureExpressionSources(branch.then),
        ]),
        ...(expression.else ? closureExpressionSources(expression.else) : []),
      ];
    case "scalar-subquery":
      return [expression.query];
    case "column":
    case "parameter":
    case "excluded":
    case "unixepoch":
      return [];
  }
}

function closureNodeSources(node: LogicalQueryNode): QuerySource[] {
  const children =
    node.kind === "scan" || node.kind === "values-relation"
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
  const expressions: readonly SqlExpression[] =
    node.kind === "filter"
      ? [node.predicate]
      : node.kind === "project"
        ? node.projections.map(({ expression }) => expression)
        : node.kind === "join" ||
            node.kind === "semi-join" ||
            node.kind === "anti-join"
          ? [node.condition]
          : node.kind === "aggregate"
            ? [
                ...node.groups.map(({ expression }) => expression),
                ...node.aggregates.map(({ expression }) => expression),
              ]
            : node.kind === "sort"
              ? node.keys.map(({ expression }) => expression)
              : node.kind === "window"
                ? node.windows.flatMap(({ specification }) => [
                    ...specification.partitionBy,
                    ...(specification.kind === "row-number"
                      ? specification.orderBy.map(
                          ({ expression }) => expression,
                        )
                      : []),
                  ])
                : node.kind === "limit"
                  ? [node.count, ...(node.offset ? [node.offset] : [])]
                  : node.kind === "recursive-closure"
                    ? [node.predicate]
                    : [];
  return [...children, ...expressions.flatMap(closureExpressionSources)];
}

function containsRecursiveClosure(source: QuerySource): boolean {
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): boolean => {
    if (node.kind === "recursive-closure") return true;
    if (visited.has(node)) return false;
    visited.add(node);
    return closureNodeSources(node).some((child) => visit(child.node));
  };
  return visit(source.node);
}

function validRelationScope(scope: RelationScope): boolean {
  return (
    !!scope &&
    typeof scope === "object" &&
    !Array.isArray(scope) &&
    typeof scope.marker === "symbol" &&
    Reflect.ownKeys(scope).length === 1 &&
    hasOnlyKeys(scope, ["marker"])
  );
}

function validateClosurePredicateShape(expression: SqlExpression): void {
  if (expression.kind === "aggregate")
    invalid(
      "Recursive closure predicates cannot contain aggregate expressions",
    );
  if (
    expression.kind === "scalar-subquery" ||
    expression.kind === "in-subquery"
  )
    invalid("Recursive closure predicates cannot contain query expressions");
  switch (expression.kind) {
    case "binary":
    case "distinct-from":
      validateClosurePredicateShape(expression.left);
      validateClosurePredicateShape(expression.right);
      break;
    case "boolean":
      expression.expressions.forEach(validateClosurePredicateShape);
      break;
    case "not":
    case "null-check":
    case "cast-integer":
    case "in-list":
      validateClosurePredicateShape(expression.expression);
      break;
    case "function":
      expression.arguments.forEach(validateClosurePredicateShape);
      break;
    case "column":
    case "parameter":
    case "excluded":
    case "unixepoch":
      break;
    case "coalesce":
      expression.expressions.forEach(validateClosurePredicateShape);
      break;
    case "case":
      expression.branches.forEach((branch) => {
        validateClosurePredicateShape(branch.when);
        validateClosurePredicateShape(branch.then);
      });
      if (expression.else) validateClosurePredicateShape(expression.else);
      break;
  }
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
      case "values-relation": {
        const values = node as ValuesRelationNode;
        if (
          !hasOnlyKeys(values, [
            "kind",
            "columns",
            "rows",
            "scope",
            "fields",
          ]) ||
          !Array.isArray(values.columns) ||
          !denseArray(values.columns, values.columns.length) ||
          values.columns.length === 0 ||
          values.columns.length !== values.fields.length ||
          !Array.isArray(values.rows) ||
          !validRelationScope(values.scope)
        )
          invalid("Text row relation has invalid metadata");
        const columnNames = new Set<string>();
        const expectedFields = values.columns.map((column) => {
          const item = column as object;
          const nameDescriptor = item
            ? Object.getOwnPropertyDescriptor(item, "name")
            : undefined;
          const nullableDescriptor = item
            ? Object.getOwnPropertyDescriptor(item, "nullable")
            : undefined;
          if (
            !column ||
            typeof column !== "object" ||
            Reflect.ownKeys(column).length !== 2 ||
            !hasOnlyKeys(column, ["name", "nullable"]) ||
            !nameDescriptor ||
            !("value" in nameDescriptor) ||
            !nullableDescriptor ||
            !("value" in nullableDescriptor) ||
            typeof nameDescriptor.value !== "string" ||
            typeof nullableDescriptor.value !== "boolean"
          )
            invalid("Text row relation column metadata is invalid");
          const name = nameDescriptor.value;
          const nullable = nullableDescriptor.value;
          validateIdentifier(name);
          if (columnNames.has(name))
            invalid("Text row relation has duplicate schema fields");
          columnNames.add(name);
          return { name, affinity: "text", nullable };
        });
        if (
          values.fields.length !== expectedFields.length ||
          values.fields.some(
            (field, index) => !sameFieldMetadata(field, expectedFields[index]!),
          )
        )
          invalid("Text row relation fields do not match its schema");
        if (!denseArray(values.rows, values.rows.length))
          invalid("Text row relation rows cannot be sparse or decorated");
        for (let rowIndex = 0; rowIndex < values.rows.length; rowIndex++) {
          const row = values.rows[rowIndex];
          if (!denseArray(row, values.columns.length))
            invalid("Text row relation tuple does not match its schema");
          for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
            const value = row[columnIndex];
            const column = values.columns[columnIndex]!;
            if (
              (typeof value !== "string" && value !== null) ||
              (value === null && !column.nullable) ||
              (typeof value === "string" && !wellFormedUtf16(value))
            )
              invalid("Text row relation contains an invalid cell value");
          }
        }
        return;
      }
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
      case "window": {
        const windowNode = node as WindowNode;
        validateChild(windowNode.input);
        if (
          !Array.isArray(windowNode.windows) ||
          windowNode.windows.length === 0
        )
          invalid("Window requires at least one window output");
        const names = new Set(
          windowNode.input.fields.map((field) => field.name),
        );
        const expected = [...windowNode.input.fields];
        for (const item of windowNode.windows) {
          if (!item || typeof item !== "object")
            invalid("Window output descriptor is invalid");
          if (typeof item.name !== "string")
            invalid("Window output name must be a string");
          validateIdentifier(item.name);
          if (names.has(item.name))
            invalid(
              `Window output collides with an existing field: ${item.name}`,
            );
          names.add(item.name);
          const specification = item.specification;
          if (
            !specification ||
            typeof specification !== "object" ||
            !["row-number", "count-rows"].includes(specification.kind)
          )
            invalid("Window contains an unsupported specification");
          const spec = specification as WindowSpecification;
          if (
            spec.kind === "row-number" &&
            !hasOnlyKeys(spec, ["kind", "partitionBy", "orderBy"])
          )
            invalid("row-number specification contains unsupported options");
          if (
            spec.kind === "count-rows" &&
            !hasOnlyKeys(spec, ["kind", "partitionBy"])
          )
            invalid("count-rows specification contains unsupported options");
          if (
            !Array.isArray(spec.partitionBy) ||
            (spec.kind === "row-number" &&
              (!Array.isArray(spec.orderBy) || spec.orderBy.length === 0))
          )
            invalid(
              spec.kind === "row-number"
                ? "row-number requires at least one ordering key"
                : "count-rows partition keys must be an array",
            );
          const scopes = visibleScopes(windowNode.input);
          spec.partitionBy.forEach((expression: SqlExpression) => {
            if (!expression || typeof expression !== "object")
              invalid("window contains an invalid partition expression");
            validateExpression(expression, scopes, activeSources);
          });
          if (spec.kind === "row-number")
            spec.orderBy.forEach((key: WindowOrderKey) => {
              if (
                !key ||
                typeof key !== "object" ||
                !hasOnlyKeys(key, ["expression", "direction"]) ||
                (key.direction !== "ASC" && key.direction !== "DESC")
              )
                invalid("row-number ordering direction is invalid");
              if (!key.expression || typeof key.expression !== "object")
                invalid("row-number contains an invalid ordering expression");
              validateExpression(key.expression, scopes, activeSources);
            });
          expected.push({
            name: item.name,
            affinity: "integer",
            nullable: false,
          });
        }
        if (
          node.fields.length !== expected.length ||
          node.fields.some(
            (field, index) => !sameFieldMetadata(field, expected[index]!),
          )
        )
          invalid("Window output must append non-null integer rank fields");
        return;
      }
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
      case "recursive-closure": {
        const closure = node as RecursiveClosureNode;
        if (
          !hasOnlyKeys(closure, [
            "kind",
            "seed",
            "candidates",
            "currentScope",
            "candidateScope",
            "predicate",
            "scope",
            "fields",
          ])
        )
          invalid("Recursive closure contains unsupported node metadata");
        if (
          !hasOwnedRecursiveClosureScopes(closure) ||
          !validRelationScope(closure.scope) ||
          !validRelationScope(closure.currentScope) ||
          !validRelationScope(closure.candidateScope) ||
          closure.currentScope === closure.candidateScope ||
          closure.currentScope === closure.scope ||
          closure.candidateScope === closure.scope ||
          closure.currentScope === closure.seed.scope ||
          closure.currentScope === closure.candidates.scope ||
          closure.candidateScope === closure.seed.scope ||
          closure.candidateScope === closure.candidates.scope
        )
          invalid("Recursive closure has invalid or reused local scopes");
        if (
          containsRecursiveClosure(closure.seed) ||
          containsRecursiveClosure(closure.candidates)
        )
          invalid("Nested recursive closures are not supported");

        // Recursive inputs form an independent finite domain. They cannot
        // capture an enclosing relation, much less the local current row.
        validateSource(closure.seed, activeSources, new Map());
        validateSource(closure.candidates, activeSources, new Map());

        if (
          closure.seed.fields.length === 0 ||
          closure.seed.fields.length !== closure.candidates.fields.length ||
          closure.fields.length !== closure.seed.fields.length
        )
          invalid("Recursive closure inputs must have matching row shapes");
        const expectedFields = closure.seed.fields.map((field, index) => {
          const candidateField = closure.candidates.fields[index];
          if (!candidateField || field.name !== candidateField.name)
            invalid(
              "Recursive closure input fields must match in order and name",
            );
          const affinity = commonAffinity(
            field.affinity,
            candidateField.affinity,
          );
          if (!affinity)
            invalid(
              "Recursive closure input fields have incompatible affinities",
            );
          return {
            name: field.name,
            affinity,
            nullable: field.nullable || candidateField.nullable,
          };
        });
        if (
          closure.fields.length !== expectedFields.length ||
          closure.fields.some(
            (field, index) => !sameFieldMetadata(field, expectedFields[index]!),
          )
        )
          invalid(
            "Recursive closure output metadata must match its input tuple",
          );

        validateClosurePredicateShape(closure.predicate);
        const localScopes = new Map<RelationScope, readonly OutputField[]>([
          [closure.currentScope, expectedFields],
          [closure.candidateScope, expectedFields],
        ]);
        validateExpression(closure.predicate, localScopes, activeSources);
        const validateLocalColumnNames = (expression: SqlExpression): void => {
          if (expression.kind === "column") {
            if (
              expression.scope === closure.currentScope ||
              expression.scope === closure.candidateScope
            ) {
              if (expectedFields[expression.index]?.name !== expression.name)
                invalid(
                  "Recursive closure predicate column name does not match its field",
                );
            }
            return;
          }
          switch (expression.kind) {
            case "binary":
            case "distinct-from":
              validateLocalColumnNames(expression.left);
              validateLocalColumnNames(expression.right);
              return;
            case "boolean":
              expression.expressions.forEach(validateLocalColumnNames);
              return;
            case "not":
            case "null-check":
            case "cast-integer":
            case "in-list":
              validateLocalColumnNames(expression.expression);
              return;
            case "function":
              expression.arguments.forEach(validateLocalColumnNames);
              return;
            case "coalesce":
              expression.expressions.forEach(validateLocalColumnNames);
              return;
            case "case":
              expression.branches.forEach((branch) => {
                validateLocalColumnNames(branch.when);
                validateLocalColumnNames(branch.then);
              });
              if (expression.else) validateLocalColumnNames(expression.else);
              return;
            case "aggregate":
            case "scalar-subquery":
            case "in-subquery":
            case "parameter":
            case "excluded":
            case "unixepoch":
              return;
          }
        };
        validateLocalColumnNames(closure.predicate);
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
  if ("node" in plan && plan.node.kind === "values-relation") {
    const node = plan.node;
    if (
      !hasOnlyKeys(plan, ["kind", "node", "scope", "fields", "columns"]) ||
      Reflect.ownKeys(plan).length !== 5 ||
      plan.scope !== node.scope ||
      !Array.isArray(plan.fields) ||
      !sameFieldArray(plan.fields, node.fields) ||
      !plan.columns ||
      typeof plan.columns !== "object" ||
      Array.isArray(plan.columns)
    )
      invalid("Text row relation public metadata does not match its node");
    const names = Object.keys(plan.columns);
    if (
      Reflect.ownKeys(plan.columns).length !== node.columns.length ||
      names.length !== node.columns.length ||
      names.some((name, index) => name !== node.columns[index]?.name)
    )
      invalid("Text row relation columns do not match its schema order");
    node.columns.forEach((column, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        plan.columns,
        column.name,
      );
      const expression =
        descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (
        !expression ||
        typeof expression !== "object" ||
        expression.kind !== "column" ||
        expression.scope !== node.scope ||
        expression.index !== index ||
        expression.name !== column.name ||
        !expression.resultType ||
        expression.resultType.affinity !== "text" ||
        expression.resultType.nullable !== column.nullable
      )
        invalid("Text row relation column expression metadata is invalid");
    });
  }
}

function sameFieldArray(
  left: readonly OutputField[],
  right: readonly OutputField[],
): boolean {
  return (
    left.length === right.length &&
    left.every((field, index) => sameFieldMetadata(field, right[index]!))
  );
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
