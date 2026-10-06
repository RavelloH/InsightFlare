import {
  assertD1StatementBudget,
  D1_MAX_BOUND_PARAMETERS,
} from "@/lib/db/d1-budget";
import {
  concat,
  getParameterPlaceholderOffsets,
  join,
  parameter,
  parenthesize,
  type SqlFragment,
  text,
} from "@/lib/db/sql/fragment";
import { identifier } from "@/lib/db/sql/identifier";
import type {
  DatabasePhysicalPlanShape,
  DatabaseStatement,
} from "@/lib/db/types";

import type { CompiledQuery } from "./compiled";
import { DatabaseCompilerError } from "./errors";
import type {
  AnyExpression,
  AnyInListExpression,
  RelationScope,
  SqlExpression,
} from "./expression";
import {
  type ConstantFilterJoinProjection,
  hasSamePhysicalMembershipOptimization,
  lowerLogicalPlan,
  optimizePhysicalMembershipBudget,
  optimizePhysicalParameterSlots,
  type PassthroughProjectFusion,
  type PhysicalJoinOrderStrategy,
  type PhysicalMembershipUsage,
  type PhysicalParameterSlotLayout,
  type PhysicalQueryPlan,
  type PhysicalTextRowStrategy,
  type PhysicalTextRowUsage,
  type PositiveTupleMembershipCandidate,
  recursiveClosureCount,
  type SharedRelationDefinition,
  validatePhysicalQueryPlan,
} from "./physical-plan";
import type {
  JoinNode,
  JsonScalarArrayNode,
  LogicalQueryNode,
  QuerySource,
  Relation,
  ValuesRelationNode,
} from "./plan";
import type { ProjectNode } from "./plan";

export interface ScopeBinding {
  readonly alias: string;
  readonly fieldNames?: readonly string[];
}

interface RenderContext {
  scanAlias: number;
  queryAlias: number;
  leftAlias: number;
  rightAlias: number;
  recursiveCteAlias: number;
  readonly reservedIdentifiers: Set<string>;
  readonly sharedRelations: ReadonlyMap<LogicalQueryNode, string>;
  readonly directScanProjections: ReadonlyMap<
    ProjectNode,
    PhysicalQueryPlan<object>["directScanProjections"][number]
  >;
  readonly passthroughProjectFusions: ReadonlyMap<
    ProjectNode,
    PassthroughProjectFusion
  >;
  readonly constantFilterJoinProjections: ReadonlyMap<
    ProjectNode,
    ConstantFilterJoinProjection
  >;
  readonly sparseJoinOutputs: ReadonlyMap<JoinNode, ReadonlySet<number>>;
  readonly positiveTupleMemberships: ReadonlyMap<
    ProjectNode,
    PositiveTupleMembershipCandidate
  >;
  readonly joinOrderStrategies: ReadonlyMap<
    JoinNode,
    PhysicalJoinOrderStrategy
  >;
  readonly membershipStrategies?: ReadonlyMap<
    AnyInListExpression,
    { readonly strategy: "native" | "json-text"; readonly jsonText?: string }
  >;
  readonly membershipUsage?: Map<AnyInListExpression, number>;
  readonly textRowStrategies?: ReadonlyMap<
    ValuesRelationNode,
    {
      readonly strategy: "native" | "json-rows";
      readonly jsonSegments?: readonly string[];
    }
  >;
  readonly textRowUsage?: Map<ValuesRelationNode, number>;
  readonly projectionTransportSimplifications: boolean;
  bypassSharedNode?: LogicalQueryNode;
}

function nextAlias(
  context: RenderContext,
  prefix: "t" | "q" | "l" | "r",
): string {
  const key =
    prefix === "t"
      ? "scanAlias"
      : prefix === "q"
        ? "queryAlias"
        : prefix === "l"
          ? "leftAlias"
          : "rightAlias";
  const value = context[key];
  context[key]++;
  return `${prefix}${value}`;
}

function column(index: number, alias: string, fieldName?: string): SqlFragment {
  return concat(
    identifier(alias),
    text("."),
    identifier(fieldName ?? `_c${index}`),
  );
}

function outputList(
  context: RenderContext,
  width: number,
  alias: string,
  outputOffset = 0,
): SqlFragment[] {
  if (
    context.projectionTransportSimplifications &&
    width > 0 &&
    outputOffset === 0
  )
    return [concat(identifier(alias), text(".*"))];
  return Array.from({ length: width }, (_, index) =>
    concat(column(index, alias), text(` AS "_c${index + outputOffset}"`)),
  );
}

function isIdentityProject(node: LogicalQueryNode): node is ProjectNode {
  return (
    node.kind === "project" &&
    node.projections.length === node.input.fields.length &&
    node.projections.every(
      ({ expression }, index) =>
        expression.kind === "column" &&
        expression.scope === node.input.scope &&
        expression.index === index,
    )
  );
}

const MAX_D1_JSON_SCALAR_ARRAY_BYTES = 1_000_000;

function jsonScalarArraySegments(node: JsonScalarArrayNode): readonly string[] {
  const encoder = new TextEncoder();
  const segments: string[] = [];
  let cells: string[] = [];
  let bytes = 2; // []
  for (const value of node.values) {
    const cell = JSON.stringify(value);
    if (cell === undefined)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "JSON scalar array contains a non-serializable value",
      );
    const cellBytes = encoder.encode(cell).byteLength;
    if (cellBytes + 2 > MAX_D1_JSON_SCALAR_ARRAY_BYTES)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "A JSON scalar array value exceeds the per-segment encoding limit",
      );
    const nextBytes = bytes + (cells.length === 0 ? 0 : 1) + cellBytes;
    if (cells.length > 0 && nextBytes > MAX_D1_JSON_SCALAR_ARRAY_BYTES) {
      segments.push(`[${cells.join(",")}]`);
      cells = [];
      bytes = 2;
    }
    cells.push(cell);
    bytes += (cells.length === 1 ? 0 : 1) + cellBytes;
  }
  if (cells.length > 0) segments.push(`[${cells.join(",")}]`);
  return segments;
}

function constantSql(value: string | number | null): SqlFragment {
  if (value === null) return text("NULL");
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new DatabaseCompilerError(
        "invalid_plan",
        "SQL constants must be safe integers",
      );
    return text(Object.is(value, -0) ? "0" : String(value));
  }
  if (value.includes("\0"))
    throw new DatabaseCompilerError(
      "invalid_plan",
      "SQL text constants cannot contain NUL",
    );
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new DatabaseCompilerError(
          "invalid_plan",
          "SQL text constants must contain well-formed UTF-16",
        );
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new DatabaseCompilerError(
        "invalid_plan",
        "SQL text constants must contain well-formed UTF-16",
      );
    }
  }
  return text(`'${value.replaceAll("'", "''")}'`);
}

function compileSharedRelationDefinition(
  shared: SharedRelationDefinition,
  body: SqlFragment,
): SqlFragment {
  return concat(
    identifier(shared.name),
    text(
      shared.materialization === "materialized"
        ? " AS MATERIALIZED ("
        : " AS (",
    ),
    body,
    text(")"),
  );
}

function resolveColumn(
  expression: Extract<SqlExpression, { kind: "column" }>,
  scopes: ReadonlyMap<RelationScope, ScopeBinding>,
): SqlFragment {
  const binding = scopes.get(expression.scope);
  if (!binding)
    throw new DatabaseCompilerError(
      "invalid_plan",
      `No SQL scope is available for column "${expression.name}"`,
    );
  return column(
    expression.index,
    binding.alias,
    binding.fieldNames?.[expression.index],
  );
}

export function compileD1Expression(
  expression: SqlExpression,
  scopes: ReadonlyMap<RelationScope, ScopeBinding>,
  context: RenderContext = renderContext(new Map()),
): SqlFragment {
  switch (expression.kind) {
    case "column":
      return resolveColumn(expression, scopes);
    case "parameter":
      return parameter(expression.value);
    case "excluded":
      return concat(
        identifier("excluded"),
        text("."),
        identifier(expression.name),
      );
    case "binary":
      return parenthesize(
        concat(
          compileD1Expression(expression.left, scopes, context),
          text(` ${expression.operator} `),
          compileD1Expression(expression.right, scopes, context),
        ),
      );
    case "distinct-from":
      return parenthesize(
        concat(
          compileD1Expression(expression.left, scopes, context),
          text(" IS NOT "),
          compileD1Expression(expression.right, scopes, context),
        ),
      );
    case "cast-integer":
      return concat(
        text("CAST("),
        compileD1Expression(expression.expression, scopes, context),
        text(" AS INTEGER)"),
      );
    case "cast-real":
      return concat(
        text("CAST("),
        compileD1Expression(expression.expression, scopes, context),
        text(" AS REAL)"),
      );
    case "cast-text":
      return concat(
        text("CAST("),
        compileD1Expression(expression.expression, scopes, context),
        text(" AS TEXT)"),
      );
    case "text-position":
      return concat(
        text("INSTR("),
        compileD1Expression(expression.text, scopes, context),
        text(", "),
        compileD1Expression(expression.needle, scopes, context),
        text(")"),
      );
    case "text-substring":
      return concat(
        text("SUBSTR("),
        compileD1Expression(expression.text, scopes, context),
        text(", "),
        compileD1Expression(expression.start, scopes, context),
        ...(expression.length
          ? [
              text(", "),
              compileD1Expression(expression.length, scopes, context),
            ]
          : []),
        text(")"),
      );
    case "text-like":
      return parenthesize(
        concat(
          compileD1Expression(expression.text, scopes, context),
          text(" LIKE "),
          compileD1Expression(expression.pattern, scopes, context),
          ...(expression.escape === undefined
            ? []
            : [text(" ESCAPE "), parameter(expression.escape)]),
        ),
      );
    case "constant":
      return constantSql(expression.value);
    case "boolean":
      return parenthesize(
        join(
          expression.expressions.map((item) =>
            compileD1Expression(item, scopes, context),
          ),
          text(` ${expression.operator} `),
        ),
      );
    case "not":
      return concat(
        text("NOT "),
        parenthesize(
          compileD1Expression(expression.expression, scopes, context),
        ),
      );
    case "null-check":
      return concat(
        compileD1Expression(expression.expression, scopes, context),
        text(expression.not ? " IS NOT NULL" : " IS NULL"),
      );
    case "in-list": {
      if (expression.values.length === 0) return text("(0)");
      const operand = compileD1Expression(
        expression.expression,
        scopes,
        context,
      );
      if (context.membershipUsage)
        context.membershipUsage.set(
          expression,
          (context.membershipUsage.get(expression) ?? 0) + 1,
        );
      const strategy = context.membershipStrategies?.get(expression);
      if (strategy?.strategy === "json-text") {
        if (typeof strategy.jsonText !== "string")
          throw new DatabaseCompilerError(
            "invalid_plan",
            "JSON membership strategy is missing its encoded values",
          );
        return concat(
          operand,
          text(" IN (SELECT value FROM json_each("),
          parameter(strategy.jsonText),
          text("))"),
        );
      }
      return concat(
        operand,
        text(" IN ("),
        join(expression.values.map((value) => parameter(value))),
        text(")"),
      );
    }
    case "in-subquery":
      return concat(
        compileD1Expression(expression.expression, scopes, context),
        text(" IN ("),
        compileQuerySource(expression.query, context, scopes),
        text(")"),
      );
    case "function":
      if (expression.name === "concat-text") {
        return parenthesize(
          join(
            expression.arguments.map((item) =>
              compileD1Expression(item, scopes, context),
            ),
            text(" || "),
          ),
        );
      }
      if (
        expression.name === "text-contains" ||
        expression.name === "text-starts-with" ||
        expression.name === "text-ends-with"
      ) {
        const input = expression.arguments[0];
        const pattern = expression.arguments[1];
        if (
          expression.arguments.length !== 2 ||
          !input ||
          !pattern ||
          pattern.kind !== "parameter" ||
          typeof pattern.value !== "string"
        )
          throw new DatabaseCompilerError(
            "invalid_plan",
            `${expression.name}() must have a TEXT input and string parameter`,
          );

        // The empty literal is a match for every non-NULL string. Including
        // NULL in this OR expression preserves SQL's NULL result without
        // leaving an unused pattern binding in the compiled statement.
        if (pattern.value.length === 0)
          return parenthesize(
            concat(
              compileD1Expression(input, scopes, context),
              text(" IS NOT NULL OR NULL"),
            ),
          );

        const renderedInput = compileD1Expression(input, scopes, context);
        const renderedPattern = () =>
          compileD1Expression(pattern, scopes, context);
        if (expression.name === "text-ends-with")
          return parenthesize(
            concat(
              text("SUBSTR(CAST("),
              renderedInput,
              text(" AS BLOB), -LENGTH(CAST("),
              renderedPattern(),
              text(" AS BLOB))) = CAST("),
              renderedPattern(),
              text(" AS BLOB)"),
            ),
          );

        return parenthesize(
          concat(
            text("INSTR(CAST("),
            renderedInput,
            text(" AS BLOB), CAST("),
            renderedPattern(),
            text(" AS BLOB))"),
            text(expression.name === "text-contains" ? " > 0" : " = 1"),
          ),
        );
      }
      if (expression.name === "trim-spaces") {
        return concat(
          text("TRIM("),
          compileD1Expression(expression.arguments[0]!, scopes, context),
          text(")"),
        );
      }
      if (expression.name === "trim") {
        // Match ECMAScript String.prototype.trim(), used by Filter v1's
        // trimmed-text fields. SQLite's default TRIM() only removes U+0020.
        return concat(
          text("TRIM("),
          compileD1Expression(expression.arguments[0]!, scopes, context),
          text(
            ", char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279))",
          ),
        );
      }
      return concat(
        text(expression.name.toUpperCase()),
        text("("),
        join(
          expression.arguments.map((item) =>
            compileD1Expression(item, scopes, context),
          ),
        ),
        text(")"),
      );
    case "aggregate":
      return concat(
        text(expression.name),
        text("("),
        expression.distinct ? text("DISTINCT ") : text(""),
        expression.expression
          ? compileD1Expression(expression.expression, scopes, context)
          : text("*"),
        text(")"),
      );
    case "coalesce":
      return concat(
        text("COALESCE("),
        join(
          expression.expressions.map((item) =>
            compileD1Expression(item, scopes, context),
          ),
        ),
        text(")"),
      );
    case "case":
      return concat(
        text("CASE"),
        ...expression.branches.map((branch) =>
          concat(
            text(" WHEN "),
            compileD1Expression(branch.when, scopes, context),
            text(" THEN "),
            compileD1Expression(branch.then, scopes, context),
          ),
        ),
        ...(expression.else
          ? [
              concat(
                text(" ELSE "),
                compileD1Expression(expression.else, scopes, context),
              ),
            ]
          : []),
        text(" END"),
      );
    case "unixepoch":
      return text("unixepoch()");
    case "scalar-subquery":
      return parenthesize(
        compileQuerySource(expression.query, context, scopes),
      );
  }
}

function extendScopes(
  outerScopes: ReadonlyMap<RelationScope, ScopeBinding>,
  bindings: readonly (readonly [RelationScope, ScopeBinding])[],
): Map<RelationScope, ScopeBinding> {
  return new Map([...outerScopes, ...bindings]);
}

function compileNode(
  node: LogicalQueryNode,
  context: RenderContext,
  outerScopes: ReadonlyMap<RelationScope, ScopeBinding>,
): SqlFragment {
  const sharedName = context.sharedRelations.get(node);
  if (sharedName && context.bypassSharedNode !== node) {
    const alias = nextAlias(context, "q");
    return concat(
      text("SELECT "),
      join(outputList(context, node.fields.length, alias)),
      text(" FROM "),
      identifier(sharedName),
      text(" AS "),
      identifier(alias),
    );
  }
  switch (node.kind) {
    case "json-scalar-array": {
      if (node.values.length === 0) return text('SELECT NULL AS "_c0" WHERE 0');
      const segments = jsonScalarArraySegments(node);
      return join(
        segments.map((segment) =>
          concat(
            text('SELECT "_json_scalar".value AS "_c0" FROM json_each('),
            parameter(segment),
            text(') AS "_json_scalar"'),
          ),
        ),
        text(" UNION ALL "),
      );
    }
    case "values-relation": {
      if (context.textRowUsage)
        context.textRowUsage.set(
          node,
          (context.textRowUsage.get(node) ?? 0) + 1,
        );
      const strategy = context.textRowStrategies?.get(node);
      const selections = node.fields.map((_field, index) =>
        concat(
          strategy?.strategy === "json-rows"
            ? concat(
                text('json_extract("_tuple".value, \'$['),
                text(String(index)),
                text("]')"),
              )
            : concat(
                identifier("_values"),
                text("."),
                identifier(`column${index + 1}`),
              ),
          text(` AS "_c${index}"`),
        ),
      );
      if (node.rows.length === 0)
        return concat(
          text("SELECT "),
          join(
            node.fields.map((_field, index) =>
              concat(text("NULL"), text(` AS "_c${index}"`)),
            ),
          ),
          text(" WHERE 0"),
        );
      if (strategy?.strategy === "json-rows") {
        const segments = strategy.jsonSegments ?? [];
        return concat(
          text("SELECT "),
          join(selections),
          text(" FROM (VALUES "),
          join(
            segments.map((segment) =>
              concat(text("("), parameter(segment), text(")")),
            ),
          ),
          text(
            ') AS "_segments" JOIN json_each("_segments".column1) AS "_tuple"',
          ),
        );
      }
      return concat(
        text("SELECT "),
        join(selections),
        text(" FROM (VALUES "),
        join(
          node.rows.map((row) =>
            concat(
              text("("),
              join(row.map((value) => parameter(value))),
              text(")"),
            ),
          ),
        ),
        text(') AS "_values"'),
      );
    }
    case "scan": {
      const alias = nextAlias(context, "t");
      const columns = Object.values(node.table.columns);
      const selections = columns.map((item, index) =>
        concat(
          identifier(alias),
          text("."),
          identifier(item.sqlName),
          text(` AS "_c${index}"`),
        ),
      );
      return concat(
        text("SELECT "),
        join(selections),
        text(" FROM "),
        identifier(node.table.name),
        text(" AS "),
        identifier(alias),
      );
    }
    case "filter": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, alias)),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
        text(" WHERE "),
        compileD1Expression(node.predicate, scopes, context),
      );
    }
    case "project": {
      if (context.projectionTransportSimplifications && isIdentityProject(node))
        return compileNode(node.input.node, context, outerScopes);
      const directScanProjection = context.directScanProjections.get(node);
      if (directScanProjection) {
        const alias = nextAlias(context, "t");
        const selections = directScanProjection.sqlColumnNames.map(
          (sqlColumnName, index) =>
            concat(
              identifier(alias),
              text("."),
              identifier(sqlColumnName),
              text(` AS "_c${index}"`),
            ),
        );
        return concat(
          text("SELECT "),
          join(selections),
          text(" FROM "),
          identifier(directScanProjection.scan.table.name),
          text(" AS "),
          identifier(alias),
        );
      }
      const constantFilterJoin =
        context.constantFilterJoinProjections.get(node);
      if (constantFilterJoin) {
        const source = compileNode(
          constantFilterJoin.join,
          context,
          outerScopes,
        );
        const alias = nextAlias(context, "q");
        const scopes = extendScopes(outerScopes, [
          [constantFilterJoin.filter.input.scope, { alias }],
        ]);
        return concat(
          text("SELECT "),
          join(
            node.projections.map((projection, index) =>
              concat(
                compileD1Expression(projection.expression, scopes, context),
                text(` AS "_c${index}"`),
              ),
            ),
          ),
          text(" FROM "),
          parenthesize(source),
          text(" AS "),
          identifier(alias),
          text(" WHERE "),
          compileD1Expression(
            constantFilterJoin.filter.predicate,
            scopes,
            context,
          ),
        );
      }
      const positiveTupleMembership =
        context.positiveTupleMemberships.get(node);
      if (positiveTupleMembership) {
        const joinNode = positiveTupleMembership.join;
        const leftSource = compileNode(
          joinNode.left.node,
          context,
          outerScopes,
        );
        const rightSource = compileNode(
          joinNode.right.node,
          context,
          outerScopes,
        );
        const leftAlias = nextAlias(context, "q");
        const rightAlias = nextAlias(context, "q");
        const leftScopes = extendScopes(outerScopes, [
          [joinNode.scope, { alias: leftAlias }],
        ]);
        const leftTuple = positiveTupleMembership.leftKeyIndexes.map((index) =>
          column(index, leftAlias),
        );
        const rightTuple = positiveTupleMembership.rightKeyIndexes.map(
          (index) => column(index, rightAlias),
        );
        const selections = node.projections.map((projection, index) =>
          concat(
            compileD1Expression(projection.expression, leftScopes, context),
            text(` AS "_c${index}"`),
          ),
        );
        return concat(
          text("SELECT "),
          join(selections),
          text(" FROM "),
          parenthesize(leftSource),
          text(" AS "),
          identifier(leftAlias),
          text(" WHERE "),
          parenthesize(join(leftTuple)),
          text(" IN (SELECT "),
          join(rightTuple),
          text(" FROM "),
          parenthesize(rightSource),
          text(" AS "),
          identifier(rightAlias),
          text(")"),
        );
      }
      const fusedInput = context.passthroughProjectFusions.get(node)?.input;
      const input = fusedInput ?? node.input;
      const source = compileNode(input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[input.scope, { alias }]]);
      const selections = node.projections.map((projection, index) =>
        concat(
          compileD1Expression(projection.expression, scopes, context),
          text(` AS "_c${index}"`),
        ),
      );
      return concat(
        text("SELECT "),
        join(selections),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
      );
    }
    case "join": {
      const leftSql = compileNode(node.left.node, context, outerScopes);
      const rightSql = compileNode(node.right.node, context, outerScopes);
      const leftAlias = nextAlias(context, "l");
      const rightAlias = nextAlias(context, "r");
      const scopes = extendScopes(outerScopes, [
        [node.left.scope, { alias: leftAlias }],
        [node.right.scope, { alias: rightAlias }],
      ]);
      const sparseOutputs = context.sparseJoinOutputs.get(node);
      const selections = sparseOutputs
        ? node.fields.map((_field, index) => {
            if (!sparseOutputs.has(index)) return text(`NULL AS "_c${index}"`);
            return index < node.left.fields.length
              ? concat(column(index, leftAlias), text(` AS "_c${index}"`))
              : concat(
                  column(index - node.left.fields.length, rightAlias),
                  text(` AS "_c${index}"`),
                );
          })
        : [
            ...outputList(context, node.left.fields.length, leftAlias),
            ...outputList(
              context,
              node.right.fields.length,
              rightAlias,
              node.left.fields.length,
            ),
          ];
      return concat(
        text("SELECT "),
        join(selections),
        text(" FROM "),
        context.joinOrderStrategies.has(node)
          ? concat(
              parenthesize(rightSql),
              text(" AS "),
              identifier(rightAlias),
              text(" CROSS JOIN "),
              parenthesize(leftSql),
              text(" AS "),
              identifier(leftAlias),
              text(" WHERE "),
              compileD1Expression(node.condition, scopes, context),
            )
          : concat(
              parenthesize(leftSql),
              text(" AS "),
              identifier(leftAlias),
              text(node.joinType === "left" ? " LEFT JOIN " : " INNER JOIN "),
              parenthesize(rightSql),
              text(" AS "),
              identifier(rightAlias),
              text(" ON "),
              compileD1Expression(node.condition, scopes, context),
            ),
      );
    }
    case "semi-join":
    case "anti-join": {
      const leftSql = compileNode(node.left.node, context, outerScopes);
      const rightSql = compileNode(node.right.node, context, outerScopes);
      const leftAlias = nextAlias(context, "l");
      const rightAlias = nextAlias(context, "r");
      const scopes = extendScopes(outerScopes, [
        [node.left.scope, { alias: leftAlias }],
        [node.right.scope, { alias: rightAlias }],
      ]);
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, leftAlias)),
        text(" FROM "),
        parenthesize(leftSql),
        text(" AS "),
        identifier(leftAlias),
        text(
          node.kind === "semi-join"
            ? " WHERE EXISTS (SELECT 1 FROM "
            : " WHERE NOT EXISTS (SELECT 1 FROM ",
        ),
        parenthesize(rightSql),
        text(" AS "),
        identifier(rightAlias),
        text(" WHERE "),
        compileD1Expression(node.condition, scopes, context),
        text(")"),
      );
    }
    case "aggregate": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
      const projected = [...node.groups, ...node.aggregates].map(
        (projection, index) =>
          concat(
            compileD1Expression(projection.expression, scopes, context),
            text(` AS "_c${index}"`),
          ),
      );
      return concat(
        text("SELECT "),
        join(projected),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
        ...(node.groups.length === 0
          ? []
          : [
              text(" GROUP BY "),
              join(
                node.groups.map((group) =>
                  compileD1Expression(group.expression, scopes, context),
                ),
              ),
            ]),
      );
    }
    case "distinct": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      return concat(
        text("SELECT DISTINCT "),
        join(outputList(context, node.fields.length, alias)),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
      );
    }
    case "window": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
      const selections = node.windows.map(({ specification }, index) => {
        const partitions = specification.partitionBy;
        const partition =
          partitions.length === 0
            ? []
            : [
                text("PARTITION BY "),
                join(
                  partitions.map((expression) =>
                    compileD1Expression(expression, scopes, context),
                  ),
                ),
              ];
        const functionSql =
          specification.kind === "row-number"
            ? concat(
                text("ROW_NUMBER()"),
                text(" OVER ("),
                ...partition,
                ...(partitions.length > 0 ? [text(" ")] : []),
                text("ORDER BY "),
                join(
                  specification.orderBy.map((key) =>
                    concat(
                      compileD1Expression(key.expression, scopes, context),
                      text(` ${key.direction}`),
                    ),
                  ),
                ),
                text(")"),
              )
            : concat(text("COUNT(*) OVER ("), ...partition, text(")"));
        return concat(
          functionSql,
          text(` AS "_c${node.input.fields.length + index}"`),
        );
      });
      return concat(
        text("SELECT "),
        join([
          ...outputList(context, node.input.fields.length, alias),
          ...selections,
        ]),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
      );
    }
    case "sort": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, alias)),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
        text(" ORDER BY "),
        join(
          node.keys.map((key) =>
            concat(
              compileD1Expression(key.expression, scopes, context),
              text(` ${key.direction}`),
            ),
          ),
        ),
      );
    }
    case "limit": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, alias)),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
        text(" LIMIT "),
        compileD1Expression(node.count, outerScopes, context),
        ...(node.offset
          ? [
              text(" OFFSET "),
              compileD1Expression(node.offset, outerScopes, context),
            ]
          : []),
      );
    }
    case "union": {
      const leftSql = compileNode(node.left.node, context, outerScopes);
      const rightSql = compileNode(node.right.node, context, outerScopes);
      const leftAlias = nextAlias(context, "l");
      const rightAlias = nextAlias(context, "r");
      return concat(
        text("SELECT "),
        join(outputList(context, node.fields.length, leftAlias)),
        text(" FROM "),
        parenthesize(leftSql),
        text(" AS "),
        identifier(leftAlias),
        text(node.all ? " UNION ALL " : " UNION "),
        text("SELECT "),
        join(outputList(context, node.fields.length, rightAlias)),
        text(" FROM "),
        parenthesize(rightSql),
        text(" AS "),
        identifier(rightAlias),
      );
    }
    case "recursive-closure":
      return compileRecursiveClosure(node, context);
  }
}

function compileRecursiveClosure(
  node: Extract<LogicalQueryNode, { kind: "recursive-closure" }>,
  context: RenderContext,
): SqlFragment {
  const cteName = recursiveCteName(context);
  const recursiveAlias = nextAlias(context, "r");
  const candidateAlias = nextAlias(context, "l");
  const outputAlias = nextAlias(context, "q");
  const cteColumns = node.fields.map((_field, index) => `_c${index}`);
  const anchor = compileQuerySource(node.seed, context, new Map());
  const candidate = compileQuerySource(node.candidates, context, new Map());
  const predicateScopes = extendScopes(new Map(), [
    [node.currentScope, { alias: recursiveAlias, fieldNames: cteColumns }],
    [
      node.candidateScope,
      {
        alias: candidateAlias,
        fieldNames: node.candidates.fields.map(({ name }) => name),
      },
    ],
  ]);
  const recursiveStep = concat(
    text("SELECT "),
    join(
      node.candidates.fields.map((field, index) =>
        concat(
          column(index, candidateAlias, field.name),
          text(` AS "_c${index}"`),
        ),
      ),
    ),
    text(" FROM "),
    identifier(cteName),
    text(" AS "),
    identifier(recursiveAlias),
    text(" INNER JOIN "),
    parenthesize(candidate),
    text(" AS "),
    identifier(candidateAlias),
    text(" ON "),
    compileD1Expression(node.predicate, predicateScopes, context),
  );
  return concat(
    text("WITH RECURSIVE "),
    identifier(cteName),
    text(" ("),
    join(cteColumns.map(identifier)),
    text(") AS ("),
    anchor,
    text(" UNION "),
    recursiveStep,
    text(") SELECT "),
    join(outputList(context, node.fields.length, outputAlias)),
    text(" FROM "),
    identifier(cteName),
    text(" AS "),
    identifier(outputAlias),
  );
}

function compileQuerySource(
  source: QuerySource,
  context: RenderContext,
  outerScopes: ReadonlyMap<RelationScope, ScopeBinding>,
): SqlFragment {
  const inner = compileNode(source.node, context, outerScopes);
  const alias = nextAlias(context, "q");
  const projections = source.fields.map((field, index) =>
    concat(column(index, alias), text(" AS "), identifier(field.name)),
  );
  return concat(
    text("SELECT "),
    join(projections),
    text(" FROM "),
    parenthesize(inner),
    text(" AS "),
    identifier(alias),
  );
}

function renderContext(
  sharedRelations: ReadonlyMap<LogicalQueryNode, string>,
  membershipStrategies?: RenderContext["membershipStrategies"],
  membershipUsage?: RenderContext["membershipUsage"],
  directScanProjections: RenderContext["directScanProjections"] = new Map(),
  reservedIdentifiers: ReadonlySet<string> = new Set(),
  textRowStrategies?: RenderContext["textRowStrategies"],
  textRowUsage?: RenderContext["textRowUsage"],
  passthroughProjectFusions: RenderContext["passthroughProjectFusions"] = new Map(),
  constantFilterJoinProjections: RenderContext["constantFilterJoinProjections"] = new Map(),
  sparseJoinOutputs: RenderContext["sparseJoinOutputs"] = new Map(),
  positiveTupleMemberships: RenderContext["positiveTupleMemberships"] = new Map(),
  projectionTransportSimplifications = true,
  joinOrderStrategies: RenderContext["joinOrderStrategies"] = new Map(),
): RenderContext {
  return {
    scanAlias: 0,
    queryAlias: 0,
    leftAlias: 0,
    rightAlias: 0,
    recursiveCteAlias: 0,
    reservedIdentifiers: new Set(reservedIdentifiers),
    sharedRelations,
    directScanProjections,
    passthroughProjectFusions,
    constantFilterJoinProjections,
    sparseJoinOutputs,
    positiveTupleMemberships,
    joinOrderStrategies,
    projectionTransportSimplifications,
    ...(membershipStrategies ? { membershipStrategies } : {}),
    ...(membershipUsage ? { membershipUsage } : {}),
    ...(textRowStrategies ? { textRowStrategies } : {}),
    ...(textRowUsage ? { textRowUsage } : {}),
  };
}

function recursiveCteName(context: RenderContext): string {
  let name: string;
  do {
    name = `_d1_recursive_${context.recursiveCteAlias++}`;
  } while (context.reservedIdentifiers.has(name));
  context.reservedIdentifiers.add(name);
  return name;
}

function reservePlanIdentifiers(
  physical: PhysicalQueryPlan<object>,
): Set<string> {
  const identifiers = new Set(physical.sharedRelations.map(({ name }) => name));
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.kind === "scan") identifiers.add(node.table.name);
    const children =
      node.kind === "scan" ||
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
    for (const child of children) visit(child.node);
    const expressions =
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
    const visitExpressionQueries = (expression: SqlExpression): void => {
      switch (expression.kind) {
        case "binary":
        case "distinct-from":
          visitExpressionQueries(expression.left);
          visitExpressionQueries(expression.right);
          break;
        case "boolean":
          expression.expressions.forEach(visitExpressionQueries);
          break;
        case "not":
        case "null-check":
        case "cast-integer":
        case "cast-real":
        case "cast-text":
          visitExpressionQueries(expression.expression);
          break;
        case "text-position":
          visitExpressionQueries(expression.text);
          visitExpressionQueries(expression.needle);
          break;
        case "text-substring":
          visitExpressionQueries(expression.text);
          visitExpressionQueries(expression.start);
          if (expression.length) visitExpressionQueries(expression.length);
          break;
        case "text-like":
          visitExpressionQueries(expression.text);
          visitExpressionQueries(expression.pattern);
          break;
        case "in-list":
          visitExpressionQueries(expression.expression);
          break;
        case "in-subquery":
          visitExpressionQueries(expression.expression);
          visit(expression.query.node);
          break;
        case "function":
          expression.arguments.forEach(visitExpressionQueries);
          break;
        case "aggregate":
          if (expression.expression)
            visitExpressionQueries(expression.expression);
          break;
        case "coalesce":
          expression.expressions.forEach(visitExpressionQueries);
          break;
        case "case":
          expression.branches.forEach((branch) => {
            visitExpressionQueries(branch.when);
            visitExpressionQueries(branch.then);
          });
          if (expression.else) visitExpressionQueries(expression.else);
          break;
        case "scalar-subquery":
          visit(expression.query.node);
          break;
        case "column":
        case "parameter":
        case "excluded":
        case "unixepoch":
        case "constant":
          break;
      }
    };
    expressions.forEach(visitExpressionQueries);
  };
  visit(physical.root);
  return identifiers;
}

export interface D1CompileOptions {
  readonly tag?: string;
}

export function compileD1Query<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(
  relation: Relation<Row, Columns>,
  options?: D1CompileOptions,
): CompiledQuery<Row>;
export function compileD1Query<Row extends object>(
  plan: PhysicalQueryPlan<Row>,
  options?: D1CompileOptions,
): CompiledQuery<Row>;
export function compileD1Query(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): CompiledQuery<object> {
  return compileD1QueryInternal(plan, options, true);
}

/** Internal, budget-checked expansion path for compiler differential tests. */
export function compileD1QueryUnoptimizedForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): CompiledQuery<object> {
  return compileD1QueryInternal(plan, options, false);
}

/** Exercise the defensive non-tuple renderer for final-choice tests. */
export function compileD1QueryTupleMembershipFallbackForTest(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions = {},
): CompiledQuery<object> {
  return compileD1QueryInternal(plan, options, true, true, true, true);
}

function compileD1QueryInternal(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions,
  includeSharedRelations: boolean,
  includePassthroughProjectFusions = includeSharedRelations,
  includeConstantFilterJoinProjections = includeSharedRelations,
  forceTupleMembershipFallbackForTest = false,
): CompiledQuery<object> {
  const physical: PhysicalQueryPlan<object> =
    "kind" in plan && plan.kind === "physical-query"
      ? plan
      : lowerLogicalPlan(plan);
  validatePhysicalQueryPlan(physical);
  const { physical: canonicalPhysical, nativeQuery } = optimizeForFinalShape(
    physical,
    includePassthroughProjectFusions,
    includeConstantFilterJoinProjections,
    includeSharedRelations,
    forceTupleMembershipFallbackForTest,
  );
  if (
    physical.membershipOptimization !== undefined &&
    !hasSamePhysicalMembershipOptimization(
      physical.membershipOptimization,
      canonicalPhysical.membershipOptimization!,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical query membership strategy does not match its measured budget",
    );

  if (includeSharedRelations) {
    const membershipOptimization = canonicalPhysical.membershipOptimization!;
    const hasJsonStrategy =
      membershipOptimization.strategies.some(
        (strategy) => strategy.strategy === "json-text",
      ) ||
      (membershipOptimization.rowStrategies ?? []).some(
        (strategy) => strategy.strategy === "json-rows",
      );
    if (!hasJsonStrategy)
      return compileAndBudget(
        nativeQuery,
        options,
        undefined,
        physicalPlanShape(canonicalPhysical, true),
      );
    return renderAndBudget(
      canonicalPhysical,
      options,
      true,
      membershipOptimization.strategies,
      membershipOptimization.selectedBindingCount,
      membershipOptimization.rowStrategies ?? [],
      includePassthroughProjectFusions,
      includeConstantFilterJoinProjections,
    );
  }

  return renderAndBudget(
    physical,
    options,
    false,
    undefined,
    undefined,
    [],
    includePassthroughProjectFusions,
    includeConstantFilterJoinProjections,
  );
}

function optimizeForFinalShape(
  physical: PhysicalQueryPlan<object>,
  includePassthroughProjectFusions: boolean,
  includeConstantFilterJoinProjections: boolean,
  includePositiveTupleMemberships = true,
  forceTupleMembershipFallbackForTest = false,
): {
  readonly physical: PhysicalQueryPlan<object>;
  readonly nativeQuery: SqlFragment;
} {
  const source: QuerySource = {
    node: physical.root,
    scope: physical.scope,
    fields: physical.fields,
  };
  const sharedRelations = physical.sharedRelations;
  const sharedNames = new Map(
    sharedRelations.map(({ node, name }) => [node, name] as const),
  );
  const directScanProjections = new Map(
    physical.directScanProjections.map(
      (choice) => [choice.project, choice] as const,
    ),
  );
  const passthroughProjectFusions = new Map(
    includePassthroughProjectFusions
      ? physical.passthroughProjectFusions.map(
          (choice) => [choice.project, choice] as const,
        )
      : [],
  );
  const constantFilterJoinProjections = new Map(
    includeConstantFilterJoinProjections
      ? physical.constantFilterJoinProjections.map(
          (choice) => [choice.project, choice] as const,
        )
      : [],
  );
  const sparseJoinOutputs = new Map(
    includeConstantFilterJoinProjections
      ? physical.constantFilterJoinProjections.map(
          ({ join, referencedOutputColumns }) =>
            [join, new Set(referencedOutputColumns)] as const,
        )
      : [],
  );
  const renderNative = (
    tupleMemberships: readonly PositiveTupleMembershipCandidate[] = [],
  ) => {
    const membershipUsage = new Map<AnyInListExpression, number>();
    const textRowUsage = new Map<ValuesRelationNode, number>();
    const context = renderContext(
      sharedNames,
      undefined,
      membershipUsage,
      directScanProjections,
      reservePlanIdentifiers(physical),
      undefined,
      textRowUsage,
      passthroughProjectFusions,
      constantFilterJoinProjections,
      sparseJoinOutputs,
      new Map(tupleMemberships.map((item) => [item.project, item] as const)),
      true,
      new Map(
        physical.joinOrderStrategies.map(
          (strategy) => [strategy.join, strategy] as const,
        ),
      ),
    );
    const definitions = sharedRelations.map((shared) => {
      context.bypassSharedNode = shared.node;
      const body = compileNode(shared.node, context, new Map());
      context.bypassSharedNode = undefined;
      return compileSharedRelationDefinition(shared, body);
    });
    const main = compileQuerySource(source, context, new Map());
    const query =
      definitions.length === 0
        ? main
        : concat(text("WITH "), join(definitions, text(", ")), text(" "), main);
    return {
      query,
      facts: {
        nativeBindingCount: query.bindings.length,
        usage: [...membershipUsage].map(
          ([expression, occurrences]) =>
            ({ expression, occurrences }) satisfies PhysicalMembershipUsage,
        ),
        rowUsage: [...textRowUsage].map(
          ([node, occurrences]) =>
            ({ node, occurrences }) satisfies PhysicalTextRowUsage,
        ),
      },
    };
  };

  const budgetPhysical = includePositiveTupleMemberships
    ? physical
    : { ...physical, positiveTupleMembershipCandidates: [] };
  const unselected = renderNative();
  const firstChoice = optimizePhysicalMembershipBudget(
    budgetPhysical,
    unselected.facts,
    D1_MAX_BOUND_PARAMETERS,
  );
  const tupleMemberships =
    firstChoice.membershipOptimization?.tupleMemberships ?? [];
  if (tupleMemberships.length === 0)
    return { physical: firstChoice, nativeQuery: unselected.query };

  // Re-measure the selected relational shape before finalizing packing metadata.
  const selected = renderNative(tupleMemberships);
  const finalChoice = optimizePhysicalMembershipBudget(
    budgetPhysical,
    selected.facts,
    D1_MAX_BOUND_PARAMETERS,
  );
  if (
    !forceTupleMembershipFallbackForTest &&
    hasSamePhysicalMembershipOptimization(
      finalChoice.membershipOptimization,
      firstChoice.membershipOptimization!,
    )
  )
    return { physical: finalChoice, nativeQuery: selected.query };

  // If a structural rewrite changes packed-choice costs, keep the measured
  // original Join plan rather than allowing choices to oscillate. The
  // test-only seam forces this path to verify final SQL and budget metadata.
  const fallbackOptimization = firstChoice.membershipOptimization;
  if (!fallbackOptimization)
    return { physical: firstChoice, nativeQuery: unselected.query };
  return {
    physical: {
      ...firstChoice,
      membershipOptimization: {
        ...fallbackOptimization,
        tupleMemberships: [],
      },
    },
    nativeQuery: unselected.query,
  };
}

function renderAndBudget(
  physical: PhysicalQueryPlan<object>,
  options: D1CompileOptions,
  includeSharedRelations: boolean,
  strategies?: NonNullable<
    PhysicalQueryPlan<object>["membershipOptimization"]
  >["strategies"],
  expectedBindingCount?: number,
  rowStrategies: readonly PhysicalTextRowStrategy[] = [],
  includePassthroughProjectFusions = true,
  includeConstantFilterJoinProjections = true,
): CompiledQuery<object> {
  const source: QuerySource = {
    node: physical.root,
    scope: physical.scope,
    fields: physical.fields,
  };
  const sharedRelations = includeSharedRelations
    ? physical.sharedRelations
    : [];
  const sharedNames = new Map(
    sharedRelations.map(({ node, name }) => [node, name] as const),
  );
  const directScanProjections = new Map(
    physical.directScanProjections.map(
      (choice) => [choice.project, choice] as const,
    ),
  );
  const passthroughProjectFusions = new Map(
    includePassthroughProjectFusions
      ? physical.passthroughProjectFusions.map(
          (choice) => [choice.project, choice] as const,
        )
      : [],
  );
  const constantFilterJoinProjections = new Map(
    includeConstantFilterJoinProjections
      ? physical.constantFilterJoinProjections.map(
          (choice) => [choice.project, choice] as const,
        )
      : [],
  );
  const sparseJoinOutputs = new Map(
    includeConstantFilterJoinProjections
      ? physical.constantFilterJoinProjections.map(
          ({ join, referencedOutputColumns }) =>
            [join, new Set(referencedOutputColumns)] as const,
        )
      : [],
  );
  const membershipStrategies = strategies
    ? new Map(
        strategies.map(
          (item) =>
            [
              item.expression,
              {
                strategy: item.strategy,
                ...(item.jsonText === undefined
                  ? {}
                  : { jsonText: item.jsonText }),
              },
            ] as const,
        ),
      )
    : undefined;
  const textRowStrategies =
    rowStrategies.length === 0
      ? undefined
      : new Map(
          rowStrategies.map(
            (item) =>
              [
                item.node,
                {
                  strategy: item.strategy,
                  ...(item.jsonSegments === undefined
                    ? {}
                    : {
                        jsonSegments: item.jsonSegments.map(
                          ({ jsonText }) => jsonText,
                        ),
                      }),
                },
              ] as const,
          ),
        );
  const positiveTupleMemberships = new Map(
    (physical.membershipOptimization?.tupleMemberships ?? []).map(
      (item) => [item.project, item] as const,
    ),
  );
  const context = includeSharedRelations
    ? renderContext(
        sharedNames,
        membershipStrategies,
        undefined,
        directScanProjections,
        reservePlanIdentifiers(physical),
        textRowStrategies,
        undefined,
        passthroughProjectFusions,
        constantFilterJoinProjections,
        sparseJoinOutputs,
        positiveTupleMemberships,
        includeSharedRelations,
        new Map(
          physical.joinOrderStrategies.map(
            (strategy) => [strategy.join, strategy] as const,
          ),
        ),
      )
    : renderContext(
        sharedNames,
        membershipStrategies,
        undefined,
        new Map(),
        reservePlanIdentifiers(physical),
        textRowStrategies,
        undefined,
        passthroughProjectFusions,
        constantFilterJoinProjections,
        sparseJoinOutputs,
        positiveTupleMemberships,
        includeSharedRelations,
        new Map(),
      );
  const definitions = sharedRelations.map((shared) => {
    context.bypassSharedNode = shared.node;
    const body = compileNode(shared.node, context, new Map());
    context.bypassSharedNode = undefined;
    return compileSharedRelationDefinition(shared, body);
  });
  const main = compileQuerySource(source, context, new Map());
  const query =
    definitions.length === 0
      ? main
      : concat(text("WITH "), join(definitions, text(", ")), text(" "), main);
  return compileAndBudget(
    query,
    options,
    expectedBindingCount,
    includeSharedRelations
      ? physicalPlanShape(physical, true, strategies)
      : undefined,
  );
}

function physicalPlanShape(
  physical: PhysicalQueryPlan<object>,
  includeSharedRelations: boolean,
  strategies = physical.membershipOptimization?.strategies ?? [],
): DatabasePhysicalPlanShape {
  let nativeMembershipCount = 0;
  let jsonMembershipCount = 0;
  let nativeRowRelationCount = 0;
  let jsonRowRelationCount = 0;
  for (const strategy of strategies) {
    if (strategy.strategy === "json-text") jsonMembershipCount += 1;
    else nativeMembershipCount += 1;
  }
  const common = {
    cteCount: includeSharedRelations
      ? physical.sharedRelations.length + recursiveClosureCount(physical.root)
      : recursiveClosureCount(physical.root),
    directScanProjectionCount: includeSharedRelations
      ? physical.directScanProjections.length
      : 0,
    nativeMembershipCount,
    jsonMembershipCount,
  };
  const rowStrategies = physical.membershipOptimization?.rowStrategies ?? [];
  for (const strategy of rowStrategies) {
    if (strategy.strategy === "json-rows") jsonRowRelationCount += 1;
    else nativeRowRelationCount += 1;
  }
  const rightAnchorJoinOrderCount = physical.joinOrderStrategies.filter(
    ({ kind }) => kind === "right-anchor",
  ).length;
  const uniqueLookupJoinOrderCount = physical.joinOrderStrategies.filter(
    ({ kind }) => kind === "unique-lookup",
  ).length;
  if (rightAnchorJoinOrderCount + uniqueLookupJoinOrderCount > 0)
    return {
      version: 4,
      ...common,
      nativeRowRelationCount,
      jsonRowRelationCount,
      rightAnchorJoinOrderCount,
      uniqueLookupJoinOrderCount,
    };
  return rowStrategies.length === 0
    ? { version: 1, ...common }
    : {
        version: 2,
        ...common,
        nativeRowRelationCount,
        jsonRowRelationCount,
      };
}

function compileAndBudget(
  query: SqlFragment,
  options: D1CompileOptions,
  expectedBindingCount?: number,
  shape?: DatabasePhysicalPlanShape,
): CompiledQuery<object> {
  if (
    expectedBindingCount !== undefined &&
    query.bindings.length !== expectedBindingCount
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical membership strategy binding cost does not match its SQL",
    );
  let finalQuery = query;
  let finalShape = shape;
  if (shape !== undefined) {
    const parameterLayout = optimizePhysicalParameterSlots(query.bindings);
    if (parameterLayout) {
      const numberedQuery = renderNumberedParameterSlots(
        query,
        parameterLayout,
      );
      if (numberedQuery) {
        finalQuery = numberedQuery;
        finalShape = withParameterSlotShape(shape, parameterLayout);
      }
    }
  }
  const statement: DatabaseStatement = {
    sql: finalQuery.text,
    bindings: finalQuery.bindings,
    ...(finalShape === undefined ? {} : { physicalPlanShape: finalShape }),
    ...(options.tag === undefined ? {} : { tag: options.tag }),
  };
  assertD1StatementBudget(statement);
  return { ...statement, kind: "query" };
}

function renderNumberedParameterSlots(
  query: SqlFragment,
  layout: PhysicalParameterSlotLayout,
): SqlFragment | undefined {
  const offsets = getParameterPlaceholderOffsets(query);
  if (
    offsets === undefined ||
    offsets.length !== query.bindings.length ||
    offsets.length !== layout.occurrenceSlots.length
  )
    return undefined;

  const sql: string[] = [];
  let copiedThrough = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index]!;
    if (
      !Number.isInteger(offset) ||
      offset < copiedThrough ||
      query.text[offset] !== "?"
    )
      return undefined;
    sql.push(query.text.slice(copiedThrough, offset));
    sql.push(`?${layout.occurrenceSlots[index]!}`);
    copiedThrough = offset + 1;
  }
  sql.push(query.text.slice(copiedThrough));
  return { text: sql.join(""), bindings: layout.bindings };
}

function withParameterSlotShape(
  shape: DatabasePhysicalPlanShape,
  layout: PhysicalParameterSlotLayout,
): DatabasePhysicalPlanShape {
  if (shape.version === 4)
    return {
      ...shape,
      parameterStrategy: layout.strategy,
      parameterOccurrenceCount: layout.occurrenceCount,
      parameterSlotCount: layout.slotCount,
    };
  return {
    version: 3,
    cteCount: shape.cteCount,
    directScanProjectionCount: shape.directScanProjectionCount,
    nativeMembershipCount: shape.nativeMembershipCount,
    jsonMembershipCount: shape.jsonMembershipCount,
    nativeRowRelationCount:
      shape.version === 1 ? 0 : shape.nativeRowRelationCount,
    jsonRowRelationCount: shape.version === 1 ? 0 : shape.jsonRowRelationCount,
    parameterStrategy: layout.strategy,
    parameterOccurrenceCount: layout.occurrenceCount,
    parameterSlotCount: layout.slotCount,
  };
}
