import type { GeneratedSchemaObject } from "@/lib/db/schema";
import type {
  SchemaColumnReference,
  SchemaColumnValue,
  SchemaObjectReference,
  SchemaRow,
} from "@/lib/db/schema/types";
import type { DatabaseBinding } from "@/lib/db/types";

import { DatabaseCompilerError } from "./errors";
import {
  type AnyExpression,
  type ColumnExpression,
  commonAffinity,
  type CommonExpressionAffinity,
  createColumnExpression,
  createRelationScope,
  type ExpressionAffinity,
  type ExpressionResultOf,
  type ExpressionResultType,
  type ExpressionValue,
  parameterExpression,
  type Predicate,
  rebindColumn,
  type RelationScope,
  type ScopedColumn,
  type SqlExpression,
} from "./expression";

export interface OutputField {
  readonly name: string;
  readonly affinity: ExpressionAffinity;
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
  readonly [K in keyof T["columns"]]: ScopedColumn<
    Extract<T["columns"][K], SchemaColumnReference>
  >;
};

export interface ScanNode extends QuerySourceBase {
  readonly kind: "scan";
  readonly table: SchemaObjectReference;
}

export interface TextRowRelationColumn {
  readonly name: string;
  readonly nullable: boolean;
}

/** A finite, value-only row source. Rows are ordered tuples in schema order. */
export interface ValuesRelationNode extends QuerySourceBase {
  readonly kind: "values-relation";
  readonly columns: readonly TextRowRelationColumn[];
  readonly rows: readonly (readonly (string | null)[])[];
}

export interface JsonScalarArrayNode extends QuerySourceBase {
  readonly kind: "json-scalar-array";
  readonly valueKind: "text" | "numeric";
  readonly values: readonly (string | number)[];
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

export interface WindowOrderKey {
  readonly expression: SqlExpression;
  readonly direction: "ASC" | "DESC";
}

/** Rank-only window descriptor. It is intentionally not a SQL expression. */
export interface RowNumberWindowSpec {
  readonly kind: "row-number";
  readonly partitionBy: readonly SqlExpression[];
  readonly orderBy: readonly [WindowOrderKey, ...WindowOrderKey[]];
}

export interface WindowCountRowsSpec {
  readonly kind: "count-rows";
  readonly partitionBy: readonly SqlExpression[];
}

export type WindowSpecification = RowNumberWindowSpec | WindowCountRowsSpec;

export interface WindowNode extends QuerySourceBase {
  readonly kind: "window";
  readonly input: QuerySource;
  readonly windows: readonly {
    readonly name: string;
    readonly specification: WindowSpecification;
  }[];
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

export interface RecursiveClosureNode extends QuerySourceBase {
  readonly kind: "recursive-closure";
  readonly seed: QuerySource;
  readonly candidates: QuerySource;
  readonly currentScope: RelationScope;
  readonly candidateScope: RelationScope;
  readonly predicate: Predicate;
}

const recursiveClosureScopeOwners = new WeakMap<
  RecursiveClosureNode,
  { readonly current: RelationScope; readonly candidate: RelationScope }
>();

/** Internal validator guard: local working scopes must come from this constructor. */
export function hasOwnedRecursiveClosureScopes(
  node: RecursiveClosureNode,
): boolean {
  const scopes = recursiveClosureScopeOwners.get(node);
  return (
    !!scopes &&
    scopes.current === node.currentScope &&
    scopes.candidate === node.candidateScope
  );
}

export type LogicalQueryNode =
  | ScanNode
  | ValuesRelationNode
  | JsonScalarArrayNode
  | FilterNode
  | ProjectNode
  | JoinNode
  | SemiJoinNode
  | AggregateNode
  | DistinctNode
  | WindowNode
  | SortNode
  | LimitNode
  | UnionNode
  | RecursiveClosureNode;

function outputField(
  name: string,
  affinity: ExpressionAffinity,
  nullable: boolean,
): OutputField {
  return { name, affinity, nullable };
}

function expressionField(name: string, expression: SqlExpression): OutputField {
  return outputField(
    name,
    expression.resultType.affinity,
    expression.resultType.nullable,
  );
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
      rebindColumn(scope, index, field.name, {
        affinity: field.affinity,
        nullable: field.nullable,
      }),
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

export type TextRowRelationSchema = Readonly<
  Record<string, { readonly affinity: "text"; readonly nullable: boolean }>
>;

type TextRowValue<Field extends { readonly nullable: boolean }> =
  true extends Field["nullable"] ? string | null : string;

export type TextRowRelationRow<Schema extends TextRowRelationSchema> = {
  readonly [Key in keyof Schema]: TextRowValue<Schema[Key]>;
};

type TextRowRelationColumns<Schema extends TextRowRelationSchema> = {
  readonly [Key in keyof Schema]: ColumnExpression<
    TextRowValue<Schema[Key]>,
    ExpressionResultType<"text", Schema[Key]["nullable"]>
  >;
};

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Construct a finite text row relation with stable schema and bag semantics. */
export function valuesRelation<const Schema extends TextRowRelationSchema>(
  schema: Schema,
  rows: readonly TextRowRelationRow<Schema>[],
): Relation<TextRowRelationRow<Schema>, TextRowRelationColumns<Schema>> {
  if (
    !plainRecord(schema) ||
    Reflect.ownKeys(schema).some((key) => typeof key !== "string") ||
    Reflect.ownKeys(schema).length !== Object.keys(schema).length
  )
    throw new DatabaseCompilerError("invalid_plan", "Invalid text row schema");
  const columns = Object.keys(schema).map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(schema, name);
    const definition = descriptor?.value;
    const affinityDescriptor = plainRecord(definition)
      ? Object.getOwnPropertyDescriptor(definition, "affinity")
      : undefined;
    const nullableDescriptor = plainRecord(definition)
      ? Object.getOwnPropertyDescriptor(definition, "nullable")
      : undefined;
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !plainRecord(definition) ||
      Reflect.ownKeys(definition).length !== 2 ||
      Reflect.ownKeys(definition).some((key) => typeof key !== "string") ||
      !hasOnlyOwnKeys(definition, ["affinity", "nullable"]) ||
      !affinityDescriptor ||
      !("value" in affinityDescriptor) ||
      !nullableDescriptor ||
      !("value" in nullableDescriptor) ||
      affinityDescriptor.value !== "text" ||
      typeof nullableDescriptor.value !== "boolean"
    )
      throw new DatabaseCompilerError(
        "invalid_plan",
        `Invalid text row schema field: ${name}`,
      );
    return { name, nullable: nullableDescriptor!.value as boolean };
  });
  if (columns.length === 0)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Text row relation schema must contain at least one field",
    );
  const fields = columns.map(({ name, nullable }) =>
    outputField(name, "text", nullable),
  );
  assertFields(fields);
  if (!Array.isArray(rows))
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Text relation rows must be an array",
    );
  if (Reflect.ownKeys(rows).length !== rows.length + 1)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Text relation rows cannot be decorated",
    );
  const expectedNames = columns.map(({ name }) => name);
  const copiedRows: (readonly (string | null)[])[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (!Object.prototype.hasOwnProperty.call(rows, rowIndex))
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Text relation rows cannot be sparse",
      );
    const row = rows[rowIndex];
    if (
      !plainRecord(row) ||
      Reflect.ownKeys(row).length !== expectedNames.length ||
      Reflect.ownKeys(row).some((key) => typeof key !== "string") ||
      Object.keys(row).length !== expectedNames.length ||
      expectedNames.some(
        (name) => !Object.prototype.hasOwnProperty.call(row, name),
      )
    )
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Text relation row shape does not match its schema",
      );
    const tuple = expectedNames.map((name, columnIndex) => {
      const descriptor = Object.getOwnPropertyDescriptor(row, name);
      const value =
        descriptor && "value" in descriptor ? descriptor.value : undefined;
      const column = columns[columnIndex]!;
      if (
        !descriptor ||
        !("value" in descriptor) ||
        (typeof value !== "string" && value !== null) ||
        (value === null && !column.nullable) ||
        (typeof value === "string" && !hasWellFormedUtf16(value))
      )
        throw new DatabaseCompilerError(
          "invalid_plan",
          `Invalid text value for row field: ${name}`,
        );
      return value;
    });
    copiedRows.push(tuple);
  }
  const scope = createRelationScope();
  const node: ValuesRelationNode = {
    kind: "values-relation",
    columns,
    rows: copiedRows,
    scope,
    fields,
  };
  const expressions = Object.fromEntries(
    fields.map((field, index) => [
      field.name,
      rebindColumn(scope, index, field.name, {
        affinity: "text",
        nullable: field.nullable,
      }),
    ]),
  ) as unknown as TextRowRelationColumns<Schema>;
  return relation(node, scope, fields, expressions);
}

type JsonScalarArrayValue<Kind extends "text" | "numeric"> = Kind extends "text"
  ? string
  : number;
type JsonScalarArrayRow<Kind extends "text" | "numeric"> = {
  readonly value: JsonScalarArrayValue<Kind>;
};
type JsonScalarArrayColumns<Kind extends "text" | "numeric"> = {
  readonly value: ColumnExpression<
    JsonScalarArrayValue<Kind>,
    ExpressionResultType<Kind extends "text" ? "text" : "numeric", false>
  >;
};

/**
 * Construct a copied one-column scalar relation lowered through SQLite JSON.
 * Text cells intentionally retain lone UTF-16 surrogates for JSON decoding.
 */
export function jsonScalarArray<const Kind extends "text" | "numeric">(
  valueKind: Kind,
  values: readonly JsonScalarArrayValue<Kind>[],
): Relation<JsonScalarArrayRow<Kind>, JsonScalarArrayColumns<Kind>> {
  if (valueKind !== "text" && valueKind !== "numeric")
    throw new DatabaseCompilerError(
      "invalid_plan",
      "jsonScalarArray() requires a text or numeric value kind",
    );
  if (
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    Reflect.ownKeys(values).length !== values.length + 1 ||
    !Reflect.ownKeys(values).includes("length")
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "jsonScalarArray() values must be a dense, undecorated array",
    );
  const copiedValues: (string | number)[] = [];
  for (let index = 0; index < values.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "jsonScalarArray() values cannot be sparse or use accessors",
      );
    const value = descriptor.value;
    if (
      (valueKind === "text" && typeof value !== "string") ||
      (valueKind === "numeric" &&
        (typeof value !== "number" || !Number.isFinite(value)))
    )
      throw new DatabaseCompilerError(
        "invalid_plan",
        `jsonScalarArray() requires homogeneous ${valueKind} scalars`,
      );
    copiedValues.push(value as string | number);
  }
  Object.freeze(copiedValues);
  const affinity = valueKind === "text" ? "text" : "numeric";
  const fields = [outputField("value", affinity, false)];
  const scope = createRelationScope();
  const node: JsonScalarArrayNode = {
    kind: "json-scalar-array",
    valueKind,
    values: copiedValues,
    scope,
    fields,
  };
  const columns = {
    value: rebindColumn(scope, 0, "value", {
      affinity,
      nullable: false,
    }),
  } as JsonScalarArrayColumns<Kind>;
  return relation(node, scope, fields, columns);
}

function hasOnlyOwnKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => allowed.has(key))
  );
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
  readonly [K in keyof P]: ColumnExpression<
    ExpressionValue<P[K]>,
    ExpressionResultOf<P[K]>
  >;
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

export function rowNumber(spec: {
  readonly partitionBy?: readonly SqlExpression[];
  readonly orderBy: readonly [WindowOrderKey, ...WindowOrderKey[]];
}): RowNumberWindowSpec {
  if (!spec || !Array.isArray(spec.orderBy) || spec.orderBy.length === 0)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "rowNumber() requires at least one ordering key",
    );
  if (
    Object.keys(spec).some((key) => key !== "partitionBy" && key !== "orderBy")
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "rowNumber() does not support frame or other options",
    );
  if (spec.partitionBy !== undefined && !Array.isArray(spec.partitionBy))
    throw new DatabaseCompilerError(
      "invalid_plan",
      "rowNumber() partitionBy must be an array",
    );
  return {
    kind: "row-number",
    partitionBy: [...(spec.partitionBy ?? [])],
    orderBy: spec.orderBy.map((key) => ({ ...key })) as [
      WindowOrderKey,
      ...WindowOrderKey[],
    ],
  };
}

export function windowCountRows(
  spec: {
    readonly partitionBy?: readonly SqlExpression[];
  } = {},
): WindowCountRowsSpec {
  if (
    !spec ||
    typeof spec !== "object" ||
    Object.keys(spec).some((key) => key !== "partitionBy")
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "windowCountRows() only supports partitionBy",
    );
  if (spec.partitionBy !== undefined && !Array.isArray(spec.partitionBy))
    throw new DatabaseCompilerError(
      "invalid_plan",
      "windowCountRows() partitionBy must be an array",
    );
  return {
    kind: "count-rows",
    partitionBy: [...(spec.partitionBy ?? [])],
  };
}

type WindowSpecMap = Readonly<Record<string, WindowSpecification>>;
type WindowNameConflict<
  Columns extends Readonly<Record<string, AnyExpression>>,
  Windows extends WindowSpecMap,
> = Extract<keyof Columns, keyof Windows> extends never ? unknown : never;
type WindowRow<Row extends object, Windows extends WindowSpecMap> = Row & {
  readonly [K in keyof Windows]: number;
};
type WindowColumns<
  Columns extends Readonly<Record<string, AnyExpression>>,
  Windows extends WindowSpecMap,
> = Columns & {
  readonly [K in keyof Windows]: ColumnExpression<
    number,
    ExpressionResultType<"integer", false>
  >;
};

export function window<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
  Windows extends WindowSpecMap,
>(
  input: Relation<Row, Columns>,
  windows: Windows & WindowNameConflict<Columns, Windows>,
): Relation<WindowRow<Row, Windows>, WindowColumns<Columns, Windows>> {
  const entries = Object.entries(windows) as Array<
    [string, WindowSpecification]
  >;
  if (entries.length === 0)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "window() requires at least one window output",
    );
  const fields = [
    ...input.fields,
    ...entries.map(([name]) => outputField(name, "integer", false)),
  ];
  assertFields(fields);
  const scope = createRelationScope();
  const node: WindowNode = {
    kind: "window",
    input: sourceOf(input),
    windows: entries.map(([name, specification]) => ({
      name,
      specification,
    })),
    scope,
    fields,
  };
  const columns = outputColumns(fields, scope) as WindowColumns<
    Columns,
    Windows
  >;
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
  ]: ColumnExpression<ExpressionValue<L[K]>, ExpressionResultOf<L[K]>>;
} & {
  readonly [
    K in keyof R as K extends string ? `right_${K}` : never
  ]: ColumnExpression<
    ExpressionValue<R[K]> | (Kind extends "left" ? null : never),
    ExpressionResultType<
      ExpressionResultOf<R[K]>["affinity"],
      Kind extends "left" ? true : ExpressionResultOf<R[K]>["nullable"]
    >
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
  readonly [K in keyof T]: ColumnExpression<
    ExpressionValue<T[K]>,
    ExpressionResultOf<T[K]>
  >;
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

type UnionResultNullable<Left, Right> = true extends
  ExpressionResultOf<Left>["nullable"] | ExpressionResultOf<Right>["nullable"]
  ? true
  : false;
type UnionResultAffinity<Left, Right> = CommonExpressionAffinity<
  ExpressionResultOf<Left>["affinity"],
  ExpressionResultOf<Right>["affinity"]
>;
type UnionRow<
  LeftColumns extends Readonly<Record<string, AnyExpression>>,
  RightColumns extends Readonly<Record<keyof LeftColumns, AnyExpression>>,
> = {
  readonly [K in keyof LeftColumns]:
    ExpressionValue<LeftColumns[K]> | ExpressionValue<RightColumns[K]>;
};
type UnionColumns<
  LeftColumns extends Readonly<Record<string, AnyExpression>>,
  RightColumns extends Readonly<Record<keyof LeftColumns, AnyExpression>>,
> = {
  readonly [K in keyof LeftColumns]: ColumnExpression<
    ExpressionValue<LeftColumns[K]> | ExpressionValue<RightColumns[K]>,
    ExpressionResultType<
      UnionResultAffinity<LeftColumns[K], RightColumns[K]>,
      UnionResultNullable<LeftColumns[K], RightColumns[K]>
    >
  >;
};

type ClosureResultNullable<Left, Right> = true extends
  ExpressionResultOf<Left>["nullable"] | ExpressionResultOf<Right>["nullable"]
  ? true
  : false;
type ClosureResultAffinity<Left, Right> = CommonExpressionAffinity<
  ExpressionResultOf<Left>["affinity"],
  ExpressionResultOf<Right>["affinity"]
>;
type ClosureRow<
  SeedColumns extends Readonly<Record<string, AnyExpression>>,
  CandidateColumns extends Readonly<Record<keyof SeedColumns, AnyExpression>>,
> = {
  readonly [K in keyof SeedColumns]:
    ExpressionValue<SeedColumns[K]> | ExpressionValue<CandidateColumns[K]>;
};
type ClosureColumns<
  SeedColumns extends Readonly<Record<string, AnyExpression>>,
  CandidateColumns extends Readonly<Record<keyof SeedColumns, AnyExpression>>,
> = {
  readonly [K in keyof SeedColumns]: ColumnExpression<
    ExpressionValue<SeedColumns[K]> | ExpressionValue<CandidateColumns[K]>,
    ExpressionResultType<
      ClosureResultAffinity<SeedColumns[K], CandidateColumns[K]>,
      ClosureResultNullable<SeedColumns[K], CandidateColumns[K]>
    >
  >;
};
type NoAdditionalClosureFields<
  SeedColumns extends Readonly<Record<string, AnyExpression>>,
  CandidateColumns extends Readonly<Record<string, AnyExpression>>,
> =
  Exclude<keyof CandidateColumns, keyof SeedColumns> extends never
    ? unknown
    : never;
type ClosureAffinityCompatible<Left, Right> =
  ExpressionResultOf<Left>["affinity"] extends "unknown"
    ? true
    : ExpressionResultOf<Right>["affinity"] extends "unknown"
      ? true
      : [ExpressionResultOf<Left>["affinity"]] extends [
            ExpressionResultOf<Right>["affinity"],
          ]
        ? true
        : [ExpressionResultOf<Left>["affinity"]] extends [
              "integer" | "real" | "numeric",
            ]
          ? [ExpressionResultOf<Right>["affinity"]] extends [
              "integer" | "real" | "numeric",
            ]
            ? true
            : false
          : false;
type IncompatibleClosureFieldKeys<
  SeedColumns extends Readonly<Record<string, AnyExpression>>,
  CandidateColumns extends Readonly<Record<keyof SeedColumns, AnyExpression>>,
> = {
  readonly [K in keyof SeedColumns]: ClosureAffinityCompatible<
    SeedColumns[K],
    CandidateColumns[K]
  > extends true
    ? never
    : K;
}[keyof SeedColumns];
type CompatibleClosureAffinities<
  SeedColumns extends Readonly<Record<string, AnyExpression>>,
  CandidateColumns extends Readonly<Record<keyof SeedColumns, AnyExpression>>,
> =
  IncompatibleClosureFieldKeys<SeedColumns, CandidateColumns> extends never
    ? unknown
    : never;

/**
 * Repeatedly adds matching candidates to a finite, set-valued relation until
 * no new complete rows are produced. The callback sees only local typed
 * current-work and candidate columns; it cannot refer to source SQL or CTEs.
 */
export function recursiveClosure<
  SeedRow extends object,
  SeedColumns extends Readonly<Record<string, AnyExpression>>,
  CandidateRow extends object,
  CandidateColumns extends Readonly<Record<keyof SeedColumns, AnyExpression>> &
    Readonly<Record<string, AnyExpression>>,
>(
  seed: Relation<SeedRow, SeedColumns>,
  candidates: Relation<CandidateRow, CandidateColumns> &
    NoAdditionalClosureFields<SeedColumns, CandidateColumns> &
    CompatibleClosureAffinities<SeedColumns, CandidateColumns>,
  predicateBuilder: (
    current: ClosureColumns<SeedColumns, CandidateColumns>,
    candidate: ClosureColumns<SeedColumns, CandidateColumns>,
  ) => Predicate,
): Relation<
  ClosureRow<SeedColumns, CandidateColumns>,
  ClosureColumns<SeedColumns, CandidateColumns>
> {
  if (
    !Array.isArray(seed.fields) ||
    !Array.isArray(candidates.fields) ||
    seed.fields.length === 0 ||
    seed.fields.length !== candidates.fields.length ||
    seed.fields.some(
      (field, index) =>
        field.name !== candidates.fields[index]?.name ||
        commonAffinity(field.affinity, candidates.fields[index]!.affinity) ===
          undefined,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Recursive closure inputs must have matching fields and compatible affinities",
    );

  const fields = seed.fields.map((field, index) => {
    const candidateField = candidates.fields[index]!;
    const affinity = commonAffinity(field.affinity, candidateField.affinity);
    if (affinity === undefined)
      throw new DatabaseCompilerError(
        "invalid_plan",
        `Recursive closure field "${field.name}" has incompatible affinities ${field.affinity} and ${candidateField.affinity}`,
      );
    return outputField(
      field.name,
      affinity,
      field.nullable || candidateField.nullable,
    );
  });
  assertFields(fields);

  const scope = createRelationScope();
  const currentScope = createRelationScope();
  const candidateScope = createRelationScope();
  const current = outputColumns(fields, currentScope) as ClosureColumns<
    SeedColumns,
    CandidateColumns
  >;
  const candidate = outputColumns(fields, candidateScope) as ClosureColumns<
    SeedColumns,
    CandidateColumns
  >;
  const predicate = predicateBuilder(current, candidate);
  const node: RecursiveClosureNode = {
    kind: "recursive-closure",
    seed: sourceOf(seed),
    candidates: sourceOf(candidates),
    currentScope,
    candidateScope,
    predicate,
    scope,
    fields,
  };
  recursiveClosureScopeOwners.set(node, {
    current: currentScope,
    candidate: candidateScope,
  });
  return relation(
    node,
    scope,
    fields,
    outputColumns(fields, scope) as ClosureColumns<
      SeedColumns,
      CandidateColumns
    >,
  );
}

export function union<
  LeftRow extends object,
  LeftColumns extends Readonly<Record<string, AnyExpression>>,
  RightRow extends object,
  RightColumns extends Readonly<Record<string, AnyExpression>> &
    Readonly<Record<keyof LeftColumns, AnyExpression>>,
>(
  left: Relation<LeftRow, LeftColumns>,
  right: Relation<RightRow, RightColumns>,
  all = false,
): Relation<
  UnionRow<LeftColumns, RightColumns>,
  UnionColumns<LeftColumns, RightColumns>
> {
  if (
    left.fields.length !== right.fields.length ||
    left.fields.some((field, index) => field.name !== right.fields[index]?.name)
  ) {
    throw new DatabaseCompilerError(
      "invalid_plan",
      "UNION inputs must have matching output fields",
    );
  }
  const fields = left.fields.map((field, index) => {
    const rightField = right.fields[index]!;
    const affinity = commonAffinity(field.affinity, rightField.affinity);
    if (!affinity) {
      throw new DatabaseCompilerError(
        "invalid_plan",
        `UNION field "${field.name}" has incompatible affinities ${field.affinity} and ${rightField.affinity}`,
      );
    }
    return outputField(
      field.name,
      affinity,
      field.nullable || rightField.nullable,
    );
  });
  const scope = createRelationScope();
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
    outputColumns(fields, scope) as UnionColumns<LeftColumns, RightColumns>,
  );
}

export type InsertRequiredKeys<T extends SchemaObjectReference> = {
  [K in keyof T["columns"]]: T["columns"][K]["rowidAlias"] extends true
    ? never
    : T["columns"][K]["nullable"] extends true
      ? never
      : T["columns"][K]["defaultSql"] extends null
        ? T["columns"][K]["generated"] extends true
          ? never
          : T["columns"][K]["hidden"] extends 0
            ? K
            : never
        : never;
}[keyof T["columns"]];

type InsertColumnInput<C extends SchemaColumnReference> =
  SchemaColumnValue<C> | (C["rowidAlias"] extends true ? null : never);

type InsertColumnValue<C extends SchemaColumnReference> =
  InsertColumnInput<C> | SqlExpression<InsertColumnInput<C>>;

export type InsertRow<T extends SchemaObjectReference> = {
  readonly [
    K in InsertRequiredKeys<T>
  ]: T["columns"][K] extends SchemaColumnReference
    ? InsertColumnValue<T["columns"][K]>
    : never;
} & {
  readonly [
    K in Exclude<keyof T["columns"], InsertRequiredKeys<T>>
  ]?: T["columns"][K] extends SchemaColumnReference
    ? InsertColumnValue<T["columns"][K]>
    : never;
};

export type { DatabaseBinding };
