import {
  concat,
  join,
  parameter,
  parenthesize,
  type SqlFragment,
  text,
} from "@/lib/db/sql/fragment";
import { identifier } from "@/lib/db/sql/identifier";
import type { DatabaseStatement } from "@/lib/db/types";

import type { CompiledQuery } from "./compiled";
import { DatabaseCompilerError } from "./errors";
import type { AnyExpression, RelationScope, SqlExpression } from "./expression";
import type { PhysicalQueryPlan } from "./physical-plan";
import type { LogicalQueryNode, QuerySource, Relation } from "./plan";
import { validateLogicalQueryPlan } from "./validator";

export interface ScopeBinding {
  readonly alias: string;
  readonly fieldNames?: readonly string[];
}

interface RenderContext {
  scanAlias: number;
  queryAlias: number;
  leftAlias: number;
  rightAlias: number;
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
  width: number,
  alias: string,
  outputOffset = 0,
): SqlFragment[] {
  return Array.from({ length: width }, (_, index) =>
    concat(column(index, alias), text(` AS "_c${index + outputOffset}"`)),
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
          compileD1Expression(expression.left, scopes),
          text(` ${expression.operator} `),
          compileD1Expression(expression.right, scopes),
        ),
      );
    case "boolean":
      return parenthesize(
        join(
          expression.expressions.map((item) =>
            compileD1Expression(item, scopes),
          ),
          text(` ${expression.operator} `),
        ),
      );
    case "not":
      return concat(
        text("NOT "),
        parenthesize(compileD1Expression(expression.expression, scopes)),
      );
    case "null-check":
      return concat(
        compileD1Expression(expression.expression, scopes),
        text(expression.not ? " IS NOT NULL" : " IS NULL"),
      );
    case "in-list":
      if (expression.values.length === 0) return text("(0)");
      return concat(
        compileD1Expression(expression.expression, scopes),
        text(" IN ("),
        join(expression.values.map((value) => parameter(value))),
        text(")"),
      );
    case "function":
      return concat(
        text(expression.name.toUpperCase()),
        text("("),
        join(
          expression.arguments.map((item) => compileD1Expression(item, scopes)),
        ),
        text(")"),
      );
    case "aggregate":
      return concat(
        text(expression.name),
        text("("),
        expression.distinct ? text("DISTINCT ") : text(""),
        expression.expression
          ? compileD1Expression(expression.expression, scopes)
          : text("*"),
        text(")"),
      );
    case "coalesce":
      return concat(
        text("COALESCE("),
        join(
          expression.expressions.map((item) =>
            compileD1Expression(item, scopes),
          ),
        ),
        text(")"),
      );
  }
}

function compileNode(
  node: LogicalQueryNode,
  context: RenderContext,
): SqlFragment {
  switch (node.kind) {
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
      const source = compileNode(node.input.node, context);
      const alias = nextAlias(context, "q");
      const scopes = new Map([[node.input.scope, { alias }]]);
      return concat(
        text("SELECT "),
        join(outputList(node.fields.length, alias)),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
        text(" WHERE "),
        compileD1Expression(node.predicate, scopes),
      );
    }
    case "project": {
      const source = compileNode(node.input.node, context);
      const alias = nextAlias(context, "q");
      const scopes = new Map([[node.input.scope, { alias }]]);
      const selections = node.projections.map((projection, index) =>
        concat(
          compileD1Expression(projection.expression, scopes),
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
      const leftSql = compileNode(node.left.node, context);
      const rightSql = compileNode(node.right.node, context);
      const leftAlias = nextAlias(context, "l");
      const rightAlias = nextAlias(context, "r");
      const scopes = new Map<RelationScope, ScopeBinding>([
        [node.left.scope, { alias: leftAlias }],
        [node.right.scope, { alias: rightAlias }],
      ]);
      const selections = [
        ...outputList(node.left.fields.length, leftAlias),
        ...outputList(
          node.right.fields.length,
          rightAlias,
          node.left.fields.length,
        ),
      ];
      void scopes;
      return concat(
        text("SELECT "),
        join(selections),
        text(" FROM "),
        parenthesize(leftSql),
        text(" AS "),
        identifier(leftAlias),
        text(node.joinType === "left" ? " LEFT JOIN " : " INNER JOIN "),
        parenthesize(rightSql),
        text(" AS "),
        identifier(rightAlias),
        text(" ON "),
        compileD1Expression(node.condition, scopes),
      );
    }
    case "semi-join":
    case "anti-join": {
      const leftSql = compileNode(node.left.node, context);
      const rightSql = compileNode(node.right.node, context);
      const leftAlias = nextAlias(context, "l");
      const rightAlias = nextAlias(context, "r");
      const scopes = new Map<RelationScope, ScopeBinding>([
        [node.left.scope, { alias: leftAlias }],
        [node.right.scope, { alias: rightAlias }],
      ]);
      return concat(
        text("SELECT "),
        join(outputList(node.fields.length, leftAlias)),
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
        compileD1Expression(node.condition, scopes),
        text(")"),
      );
    }
    case "aggregate": {
      const source = compileNode(node.input.node, context);
      const alias = nextAlias(context, "q");
      const scopes = new Map([[node.input.scope, { alias }]]);
      const projected = [...node.groups, ...node.aggregates].map(
        (projection, index) =>
          concat(
            compileD1Expression(projection.expression, scopes),
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
                  compileD1Expression(group.expression, scopes),
                ),
              ),
            ]),
      );
    }
    case "distinct": {
      const source = compileNode(node.input.node, context);
      const alias = nextAlias(context, "q");
      return concat(
        text("SELECT DISTINCT "),
        join(outputList(node.fields.length, alias)),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
      );
    }
    case "sort": {
      const source = compileNode(node.input.node, context);
      const alias = nextAlias(context, "q");
      const scopes = new Map([[node.input.scope, { alias }]]);
      return concat(
        text("SELECT "),
        join(outputList(node.fields.length, alias)),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
        text(" ORDER BY "),
        join(
          node.keys.map((key) =>
            concat(
              compileD1Expression(key.expression, scopes),
              text(` ${key.direction}`),
            ),
          ),
        ),
      );
    }
    case "limit": {
      const source = compileNode(node.input.node, context);
      const alias = nextAlias(context, "q");
      return concat(
        text("SELECT "),
        join(outputList(node.fields.length, alias)),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
        text(" LIMIT "),
        compileD1Expression(node.count, new Map()),
        ...(node.offset
          ? [text(" OFFSET "), compileD1Expression(node.offset, new Map())]
          : []),
      );
    }
    case "union": {
      const leftSql = compileNode(node.left.node, context);
      const rightSql = compileNode(node.right.node, context);
      const leftAlias = nextAlias(context, "l");
      const rightAlias = nextAlias(context, "r");
      return concat(
        text("SELECT "),
        join(outputList(node.fields.length, leftAlias)),
        text(" FROM "),
        parenthesize(leftSql),
        text(" AS "),
        identifier(leftAlias),
        text(node.all ? " UNION ALL " : " UNION "),
        text("SELECT "),
        join(outputList(node.fields.length, rightAlias)),
        text(" FROM "),
        parenthesize(rightSql),
        text(" AS "),
        identifier(rightAlias),
      );
    }
  }
}

function renderContext(): RenderContext {
  return { scanAlias: 0, queryAlias: 0, leftAlias: 0, rightAlias: 0 };
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
  const source: QuerySource =
    "kind" in plan && plan.kind === "physical-query"
      ? { node: plan.root, scope: plan.scope, fields: plan.fields }
      : plan;
  validateLogicalQueryPlan(source.node);
  const inner = compileNode(source.node, renderContext());
  const alias = "q0";
  const projections = source.fields.map((field, index) =>
    concat(column(index, alias), text(" AS "), identifier(field.name)),
  );
  const statement: DatabaseStatement = {
    sql: concat(
      text("SELECT "),
      join(projections),
      text(" FROM "),
      parenthesize(inner),
      text(" AS "),
      identifier(alias),
    ).text,
    bindings: inner.bindings,
    ...(options.tag === undefined ? {} : { tag: options.tag }),
  };
  return { ...statement, kind: "query" };
}
