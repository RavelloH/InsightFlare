import {
  assertD1StatementBudget,
  D1_MAX_BOUND_PARAMETERS,
} from "@/lib/db/d1-budget";
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
import type {
  AnyExpression,
  AnyInListExpression,
  RelationScope,
  SqlExpression,
} from "./expression";
import {
  hasSamePhysicalMembershipOptimization,
  lowerLogicalPlan,
  optimizePhysicalMembershipBudget,
  type PhysicalMembershipUsage,
  type PhysicalQueryPlan,
  validatePhysicalQueryPlan,
} from "./physical-plan";
import type { LogicalQueryNode, QuerySource, Relation } from "./plan";

export interface ScopeBinding {
  readonly alias: string;
  readonly fieldNames?: readonly string[];
}

interface RenderContext {
  scanAlias: number;
  queryAlias: number;
  leftAlias: number;
  rightAlias: number;
  readonly sharedRelations: ReadonlyMap<LogicalQueryNode, string>;
  readonly membershipStrategies?: ReadonlyMap<
    AnyInListExpression,
    { readonly strategy: "native" | "json-text"; readonly jsonText?: string }
  >;
  readonly membershipUsage?: Map<AnyInListExpression, number>;
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
      join(outputList(node.fields.length, alias)),
      text(" FROM "),
      identifier(sharedName),
      text(" AS "),
      identifier(alias),
    );
  }
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
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
      return concat(
        text("SELECT "),
        join(outputList(node.fields.length, alias)),
        text(" FROM "),
        parenthesize(source),
        text(" AS "),
        identifier(alias),
        text(" WHERE "),
        compileD1Expression(node.predicate, scopes, context),
      );
    }
    case "project": {
      const source = compileNode(node.input.node, context, outerScopes);
      const alias = nextAlias(context, "q");
      const scopes = extendScopes(outerScopes, [[node.input.scope, { alias }]]);
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
      const selections = [
        ...outputList(node.left.fields.length, leftAlias),
        ...outputList(
          node.right.fields.length,
          rightAlias,
          node.left.fields.length,
        ),
      ];
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
        compileD1Expression(node.condition, scopes, context),
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
        join(outputList(node.fields.length, alias)),
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
        join(outputList(node.fields.length, alias)),
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
        join(outputList(node.fields.length, alias)),
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
): RenderContext {
  return {
    scanAlias: 0,
    queryAlias: 0,
    leftAlias: 0,
    rightAlias: 0,
    sharedRelations,
    ...(membershipStrategies ? { membershipStrategies } : {}),
    ...(membershipUsage ? { membershipUsage } : {}),
  };
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

function compileD1QueryInternal(
  plan:
    | Relation<object, Readonly<Record<string, AnyExpression>>>
    | PhysicalQueryPlan<object>,
  options: D1CompileOptions,
  includeSharedRelations: boolean,
): CompiledQuery<object> {
  const physical: PhysicalQueryPlan<object> =
    "kind" in plan && plan.kind === "physical-query"
      ? plan
      : lowerLogicalPlan(plan);
  validatePhysicalQueryPlan(physical);
  const { physical: canonicalPhysical, nativeQuery } =
    optimizeForFinalShape(physical);
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
    const hasJsonStrategy = membershipOptimization.strategies.some(
      (strategy) => strategy.strategy === "json-text",
    );
    if (!hasJsonStrategy) return compileAndBudget(nativeQuery, options);
    return renderAndBudget(
      canonicalPhysical,
      options,
      true,
      membershipOptimization.strategies,
      membershipOptimization.selectedBindingCount,
    );
  }

  return renderAndBudget(physical, options, false);
}

function optimizeForFinalShape(physical: PhysicalQueryPlan<object>): {
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
  const membershipUsage = new Map<AnyInListExpression, number>();
  const context = renderContext(sharedNames, undefined, membershipUsage);
  const definitions = sharedRelations.map((shared) => {
    context.bypassSharedNode = shared.node;
    const body = compileNode(shared.node, context, new Map());
    context.bypassSharedNode = undefined;
    return concat(identifier(shared.name), text(" AS ("), body, text(")"));
  });
  const main = compileQuerySource(source, context, new Map());
  const query =
    definitions.length === 0
      ? main
      : concat(text("WITH "), join(definitions, text(", ")), text(" "), main);
  return {
    physical: optimizePhysicalMembershipBudget(
      physical,
      {
        nativeBindingCount: query.bindings.length,
        usage: [...membershipUsage].map(
          ([expression, occurrences]) =>
            ({
              expression,
              occurrences,
            }) satisfies PhysicalMembershipUsage,
        ),
      },
      D1_MAX_BOUND_PARAMETERS,
    ),
    nativeQuery: query,
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
  const context = renderContext(sharedNames, membershipStrategies);
  const definitions = sharedRelations.map((shared) => {
    context.bypassSharedNode = shared.node;
    const body = compileNode(shared.node, context, new Map());
    context.bypassSharedNode = undefined;
    return concat(identifier(shared.name), text(" AS ("), body, text(")"));
  });
  const main = compileQuerySource(source, context, new Map());
  const query =
    definitions.length === 0
      ? main
      : concat(text("WITH "), join(definitions, text(", ")), text(" "), main);
  return compileAndBudget(query, options, expectedBindingCount);
}

function compileAndBudget(
  query: SqlFragment,
  options: D1CompileOptions,
  expectedBindingCount?: number,
): CompiledQuery<object> {
  if (
    expectedBindingCount !== undefined &&
    query.bindings.length !== expectedBindingCount
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical membership strategy binding cost does not match its SQL",
    );
  const statement: DatabaseStatement = {
    sql: query.text,
    bindings: query.bindings,
    ...(options.tag === undefined ? {} : { tag: options.tag }),
  };
  assertD1StatementBudget(statement);
  return { ...statement, kind: "query" };
}
