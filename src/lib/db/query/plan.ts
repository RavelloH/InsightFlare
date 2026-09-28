import type { GeneratedSchemaObject } from "@/lib/db/schema";
import type {
  SchemaColumnReference,
  SchemaColumnValue,
  SchemaObjectReference,
  SchemaRow,
  SchemaTableReference,
  SqliteAffinity,
} from "@/lib/db/schema/types";
import type { DatabaseBinding } from "@/lib/db/types";

import { DatabaseCompilerError } from "./errors";
import {
  type AnyExpression,
  type ColumnExpression,
  createColumnExpression,
  createRelationScope,
  type ExpressionValue,
  parameterExpression,
  type Predicate,
  rebindColumn,
  type RelationScope,
  type ScopedColumns,
  type SqlExpression,
} from "./expression";

export interface OutputField {
  readonly name: string;
  readonly affinity: SqliteAffinity;
  readonly nullable: boolean;
}

export interface QuerySource {
  readonly node: LogicalQueryNode;
  readonly scope: RelationScope;
  readonly fields: readonly OutputField[];
}

export interface Relation<
  Row extends object = Record<string, unknown>,
  Columns extends Readonly<Record<string, AnyExpression>> = Readonly<
    Record<string, AnyExpression>
  >,
> extends QuerySource {
  readonly kind: "relation";
  readonly columns: Columns;
  readonly __row?: Row;
}

export type RelationRow<
  Columns extends Readonly<Record<string, AnyExpression>>,
> = {
  readonly [K in keyof Columns]: ExpressionValue<Columns[K]>;
};

type ColumnExpressions<T extends SchemaObjectReference> = {
  readonly [K in keyof T["columns"]]: ColumnExpression<
    SchemaColumnValue<T["columns"][K]>
  >;
};

export interface ScanNode extends QuerySourceBase {
  readonly kind: "scan";
  readonly table: SchemaObjectReference;
}

interface QuerySourceBase {
  readonly scope: RelationScope;
  readonly fields: readonly OutputField[];
}

export interface FilterNode extends QuerySourceBase {
  readonly kind: "filter";
  readonly input: QuerySource;
  readonly predicate: Predicate;
}

export interface ProjectNode extends QuerySourceBase {
  readonly kind: "project";
  readonly input: QuerySource;
  readonly projections: readonly {
    readonly name: string;
    readonly expression: SqlExpression;
  }[];
}

export interface JoinNode extends QuerySourceBase {
  readonly kind: "join";
  readonly joinType: "inner" | "left";
  readonly left: QuerySource;
  readonly right: QuerySource;
  readonly condition: Predicate;
}

export interface SemiJoinNode extends QuerySourceBase {
  readonly kind: "semi-join" | "anti-join";
  readonly left: QuerySource;
  readonly right: QuerySource;
  readonly condition: Predicate;
}

export interface AggregateNode extends QuerySourceBase {
  readonly kind: "aggregate";
  readonly input: QuerySource;
  readonly groups: readonly {
    readonly name: string;
    readonly expression: SqlExpression;
  }[];
  readonly aggregates: readonly {
    readonly name: string;
    readonly expression: SqlExpression;
  }[];
}

export interface DistinctNode extends QuerySourceBase {
  readonly kind: "distinct";
  readonly input: QuerySource;
}

export interface SortNode extends QuerySourceBase {
  readonly kind: "sort";
  readonly input: QuerySource;
  readonly keys: readonly {
    readonly expression: SqlExpression;
    readonly direction: "ASC" | "DESC";
  }[];
}

export interface LimitNode extends QuerySourceBase {
  readonly kind: "limit";
  readonly input: QuerySource;
  readonly count: SqlExpression<number>;
  readonly offset?: SqlExpression<number>;
}

export interface UnionNode extends QuerySourceBase {
  readonly kind: "union";
  readonly all: boolean;
  readonly left: QuerySource;
  readonly right: QuerySource;
}

export type LogicalQueryNode =
  | ScanNode
  | FilterNode
  | ProjectNode
  | JoinNode
  | SemiJoinNode
  | AggregateNode
  | DistinctNode
  | SortNode
  | LimitNode
  | UnionNode;

function outputField(
  name: string,
  affinity: SqliteAffinity,
  nullable: boolean,
): OutputField {
  return { name, affinity, nullable };
}

function expressionField(name: string, expression: SqlExpression): OutputField {
  if (expression.kind === "column")
    return outputField(name, expression.affinity, expression.nullable);
  if (expression.kind === "parameter")
    return outputField(name, "numeric", expression.value === null);
  if (expression.kind === "aggregate") {
    const affinity = expression.name === "COUNT" ? "integer" : "numeric";
    return outputField(name, affinity, expression.name !== "COUNT");
  }
  if (expression.kind === "function") {
    return outputField(
      name,
      expression.name === "length" ||
        expression.name === "abs" ||
        expression.name === "round"
        ? "numeric"
        : "text",
      false,
    );
  }
  if (expression.kind === "binary") {
    const nullable =
      expression.kind === "binary" &&
      ((expression.left.kind === "column" && expression.left.nullable) ||
        (expression.right.kind === "column" && expression.right.nullable));
    return outputField(name, "numeric", nullable);
  }
  return outputField(name, "numeric", true);
}

function relation<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(
  node: LogicalQueryNode,
  scope: RelationScope,
  fields: readonly OutputField[],
  columns: Columns,
): Relation<Row, Columns> {
  return { kind: "relation", node, scope, fields, columns };
}

function sourceOf(value: QuerySource): QuerySource {
  return { node: value.node, scope: value.scope, fields: value.fields };
}

function assertFields(fields: readonly OutputField[]): void {
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field.name || field.name.includes("\0")) {
      throw new DatabaseCompilerError(
        "invalid_identifier",
        `Invalid output field: ${JSON.stringify(field.name)}`,
      );
    }
    if (seen.has(field.name)) {
      throw new DatabaseCompilerError(
        "invalid_plan",
        `Duplicate output field: ${field.name}`,
      );
    }
    seen.add(field.name);
  }
}

function outputColumns(
  fields: readonly OutputField[],
  scope: RelationScope,
): Record<string, ColumnExpression> {
  return Object.fromEntries(
    fields.map((field, index) => [
      field.name,
      rebindColumn(scope, index, field.name, field.affinity, field.nullable),
    ]),
  );
}

export function scan<T extends GeneratedSchemaObject>(
  table: T,
): Relation<SchemaRow<T>, ColumnExpressions<T>> {
  const scope = createRelationScope();
  const columns = Object.entries(table.columns) as Array<
    [string, SchemaColumnReference]
  >;
  const fields = columns.map(([propertyName, column]) =>
    outputField(propertyName, column.affinity, column.nullable),
  );
  assertFields(fields);
  const expressions = Object.fromEntries(
    columns.map(([propertyName, column], index) => [
      propertyName,
      createColumnExpression(scope, index, column),
    ]),
  ) as ColumnExpressions<T>;
  const node: ScanNode = { kind: "scan", table, scope, fields };
  return relation(node, scope, fields, expressions);
}

export function filter<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(input: Relation<Row, Columns>, predicate: Predicate): Relation<Row, Columns> {
  const scope = createRelationScope();
  const node: FilterNode = {
    kind: "filter",
    input: sourceOf(input),
    predicate,
    scope,
    fields: input.fields,
  };
  const columns = outputColumns(input.fields, scope) as unknown as Columns;
  return relation(node, scope, input.fields, columns);
}

type Projection = Readonly<Record<string, AnyExpression>>;
type ProjectionColumns<P extends Projection> = {
  readonly [K in keyof P]: ColumnExpression<ExpressionValue<P[K]>>;
};
type ProjectionRow<P extends Projection> = {
  readonly [K in keyof P]: ExpressionValue<P[K]>;
};

export function project<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
  P extends Projection,
>(
  input: Relation<Row, Columns>,
  projections: P,
): Relation<ProjectionRow<P>, ProjectionColumns<P>> {
  const entries = Object.entries(projections) as Array<[string, SqlExpression]>;
  if (entries.length === 0)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "project() requires at least one output field",
    );
  const scope = createRelationScope();
  const fields = entries.map(([name, expression]) =>
    expressionField(name, expression),
  );
  assertFields(fields);
  const node: ProjectNode = {
    kind: "project",
    input: sourceOf(input),
    projections: entries.map(([name, expression]) => ({ name, expression })),
    scope,
    fields,
  };
  const columns = outputColumns(fields, scope) as ProjectionColumns<P>;
  return relation(node, scope, fields, columns);
}

type PrefixRow<
  Row extends object,
  Prefix extends string,
  Nullable extends boolean = false,
> = {
  readonly [
    K in keyof Row as K extends string ? `${Prefix}_${K}` : never
  ]: Nullable extends true ? Row[K] | null : Row[K];
};
type JoinColumns<
  L extends Readonly<Record<string, AnyExpression>>,
  R extends Readonly<Record<string, AnyExpression>>,
  Kind extends "inner" | "left",
> = {
  readonly [
    K in keyof L as K extends string ? `left_${K}` : never
  ]: ColumnExpression<ExpressionValue<L[K]>>;
} & {
  readonly [
    K in keyof R as K extends string ? `right_${K}` : never
  ]: ColumnExpression<
    ExpressionValue<R[K]> | (Kind extends "left" ? null : never)
  >;
};

export function join<
  LR extends object,
  LC extends Readonly<Record<string, AnyExpression>>,
  RR extends object,
  RC extends Readonly<Record<string, AnyExpression>>,
  Kind extends "inner" | "left" = "inner",
>(
  left: Relation<LR, LC>,
  right: Relation<RR, RC>,
  condition: Predicate,
  joinType: Kind = "inner" as Kind,
): Relation<
  PrefixRow<LR, "left"> &
    PrefixRow<RR, "right", Kind extends "left" ? true : false>,
  JoinColumns<LC, RC, Kind>
> {
  const fields = [
    ...left.fields.map((field) =>
      outputField(`left_${field.name}`, field.affinity, field.nullable),
    ),
    ...right.fields.map((field) =>
      outputField(
        `right_${field.name}`,
        field.affinity,
        joinType === "left" || field.nullable,
      ),
    ),
  ];
  assertFields(fields);
  const scope = createRelationScope();
  const node: JoinNode = {
    kind: "join",
    joinType,
    left: sourceOf(left),
    right: sourceOf(right),
    condition,
    scope,
    fields,
  };
  const columns = outputColumns(fields, scope) as JoinColumns<LC, RC, Kind>;
  return relation(node, scope, fields, columns);
}

export function semiJoin<
  LR extends object,
  LC extends Readonly<Record<string, AnyExpression>>,
  RR extends object,
  RC extends Readonly<Record<string, AnyExpression>>,
>(
  left: Relation<LR, LC>,
  right: Relation<RR, RC>,
  condition: Predicate,
): Relation<LR, LC> {
  return membershipJoin("semi-join", left, right, condition);
}

export function antiJoin<
  LR extends object,
  LC extends Readonly<Record<string, AnyExpression>>,
  RR extends object,
  RC extends Readonly<Record<string, AnyExpression>>,
>(
  left: Relation<LR, LC>,
  right: Relation<RR, RC>,
  condition: Predicate,
): Relation<LR, LC> {
  return membershipJoin("anti-join", left, right, condition);
}

function membershipJoin<
  LR extends object,
  LC extends Readonly<Record<string, AnyExpression>>,
  RR extends object,
  RC extends Readonly<Record<string, AnyExpression>>,
>(
  kind: "semi-join" | "anti-join",
  left: Relation<LR, LC>,
  right: Relation<RR, RC>,
  condition: Predicate,
): Relation<LR, LC> {
  const scope = createRelationScope();
  const node: SemiJoinNode = {
    kind,
    left: sourceOf(left),
    right: sourceOf(right),
    condition,
    scope,
    fields: left.fields,
  };
  return relation(
    node,
    scope,
    left.fields,
    outputColumns(left.fields, scope) as unknown as LC,
  );
}

type ExprMap = Readonly<Record<string, AnyExpression>>;
type ExprMapRow<T extends ExprMap> = {
  readonly [K in keyof T]: ExpressionValue<T[K]>;
};
type ExprMapColumns<T extends ExprMap> = {
  readonly [K in keyof T]: ColumnExpression<ExpressionValue<T[K]>>;
};

export function aggregate<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
  G extends ExprMap,
  A extends ExprMap,
>(
  input: Relation<Row, Columns>,
  spec: { readonly groupBy: G; readonly aggregates: A },
): Relation<
  ExprMapRow<G> & ExprMapRow<A>,
  ExprMapColumns<G> & ExprMapColumns<A>
> {
  const groups = Object.entries(spec.groupBy) as Array<[string, SqlExpression]>;
  const aggregates = Object.entries(spec.aggregates) as Array<
    [string, SqlExpression]
  >;
  if (groups.length + aggregates.length === 0)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "aggregate() requires groups or aggregates",
    );
  if (aggregates.some(([, expression]) => expression.kind !== "aggregate")) {
    throw new DatabaseCompilerError(
      "invalid_plan",
      "aggregate() outputs must use aggregate expressions",
    );
  }
  const fields = [...groups, ...aggregates].map(([name, expression]) =>
    expressionField(name, expression),
  );
  assertFields(fields);
  const scope = createRelationScope();
  const node: AggregateNode = {
    kind: "aggregate",
    input: sourceOf(input),
    groups: groups.map(([name, expression]) => ({ name, expression })),
    aggregates: aggregates.map(([name, expression]) => ({ name, expression })),
    scope,
    fields,
  };
  const columns = outputColumns(fields, scope) as ExprMapColumns<G> &
    ExprMapColumns<A>;
  return relation(node, scope, fields, columns);
}

export function distinct<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(input: Relation<Row, Columns>): Relation<Row, Columns> {
  const scope = createRelationScope();
  const node: DistinctNode = {
    kind: "distinct",
    input: sourceOf(input),
    scope,
    fields: input.fields,
  };
  return relation(
    node,
    scope,
    input.fields,
    outputColumns(input.fields, scope) as unknown as Columns,
  );
}

export function sort<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(
  input: Relation<Row, Columns>,
  keys: readonly {
    readonly expression: SqlExpression;
    readonly direction: "ASC" | "DESC";
  }[],
): Relation<Row, Columns> {
  if (keys.length === 0)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "sort() requires at least one sort key",
    );
  const scope = createRelationScope();
  const node: SortNode = {
    kind: "sort",
    input: sourceOf(input),
    keys,
    scope,
    fields: input.fields,
  };
  return relation(
    node,
    scope,
    input.fields,
    outputColumns(input.fields, scope) as unknown as Columns,
  );
}

export function limit<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(
  input: Relation<Row, Columns>,
  count: number,
  offset?: number,
): Relation<Row, Columns> {
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
  ) {
    throw new DatabaseCompilerError(
      "invalid_plan",
      "limit() and offset must be non-negative safe integers",
    );
  }
  const scope = createRelationScope();
  const node: LimitNode = {
    kind: "limit",
    input: sourceOf(input),
    count: parameterExpression(count),
    ...(offset === undefined ? {} : { offset: parameterExpression(offset) }),
    scope,
    fields: input.fields,
  };
  return relation(
    node,
    scope,
    input.fields,
    outputColumns(input.fields, scope) as unknown as Columns,
  );
}

export function union<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(
  left: Relation<Row, Columns>,
  right: Relation<Row, Columns>,
  all = false,
): Relation<Row, Columns> {
  if (
    left.fields.length !== right.fields.length ||
    left.fields.some((field, index) => field.name !== right.fields[index]?.name)
  ) {
    throw new DatabaseCompilerError(
      "invalid_plan",
      "UNION inputs must have matching output fields",
    );
  }
  const scope = createRelationScope();
  const fields = left.fields.map((field, index) =>
    outputField(
      field.name,
      field.affinity,
      field.nullable || right.fields[index]!.nullable,
    ),
  );
  const node: UnionNode = {
    kind: "union",
    all,
    left: sourceOf(left),
    right: sourceOf(right),
    scope,
    fields,
  };
  return relation(
    node,
    scope,
    fields,
    outputColumns(fields, scope) as unknown as Columns,
  );
}

export function scopedTableColumns<T extends SchemaTableReference>(
  table: T,
): ScopedColumns<T> {
  const scope = createRelationScope();
  const columns = Object.entries(table.columns) as Array<
    [string, SchemaColumnReference]
  >;
  return Object.fromEntries(
    columns.map(([name, column], index) => [
      name,
      createColumnExpression(scope, index, column),
    ]),
  ) as ScopedColumns<T>;
}

export type InsertRequiredKeys<T extends SchemaObjectReference> = {
  [K in keyof T["columns"]]: T["columns"][K]["nullable"] extends true
    ? never
    : T["columns"][K]["defaultSql"] extends null
      ? T["columns"][K]["generated"] extends true
        ? never
        : T["columns"][K]["hidden"] extends 0
          ? K
          : never
      : never;
}[keyof T["columns"]];

export type InsertRow<T extends SchemaObjectReference> = {
  readonly [
    K in InsertRequiredKeys<T>
  ]: T["columns"][K] extends SchemaColumnReference
    ? SchemaColumnValue<T["columns"][K]>
    : never;
} & {
  readonly [
    K in Exclude<keyof T["columns"], InsertRequiredKeys<T>>
  ]?: T["columns"][K] extends SchemaColumnReference
    ? SchemaColumnValue<T["columns"][K]>
    : never;
};

export type { DatabaseBinding };
