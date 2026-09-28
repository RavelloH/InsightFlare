import { DatabaseCompilerError } from "@/lib/db/query/errors";
import {
  type AnyExpression,
  createColumnExpression,
  createRelationScope,
  parameterExpression,
  type Predicate,
  type RelationScope,
  type ScopedColumns,
  type SqlExpression,
} from "@/lib/db/query/expression";
import type { InsertRow, QuerySource } from "@/lib/db/query/plan";
import type { GeneratedSchemaTable } from "@/lib/db/schema";
import type {
  SchemaColumnReference,
  SchemaColumnValue,
  SchemaTableReference,
} from "@/lib/db/schema/types";
import type { DatabaseBinding } from "@/lib/db/types";

export type MutationValue<T> = T | DatabaseBinding | AnyExpression;

export interface MutationResultContract<Result = unknown> {
  readonly kind: "mutation-result";
  readonly description: string;
  readonly __result?: Result;
}

export interface InsertConflict {
  readonly target: readonly string[];
  readonly action: "nothing" | "update";
  readonly set?: readonly {
    readonly propertyName: string;
    readonly expression: SqlExpression;
  }[];
}

export interface InsertMutation<
  T extends SchemaTableReference = SchemaTableReference,
> {
  readonly kind: "insert";
  readonly table: T;
  readonly rows?: readonly (readonly SqlExpression[])[];
  readonly columns: readonly string[];
  readonly source?: QuerySource;
  readonly orIgnore: boolean;
  readonly conflict?: InsertConflict;
}

export interface UpdateMutation<
  T extends SchemaTableReference = SchemaTableReference,
> {
  readonly kind: "update";
  readonly table: T;
  readonly scope: RelationScope;
  readonly fields: readonly {
    readonly propertyName: string;
    readonly sqlName: string;
  }[];
  readonly set: readonly {
    readonly propertyName: string;
    readonly expression: SqlExpression;
  }[];
  readonly where: Predicate;
}

export interface DeleteMutation<
  T extends SchemaTableReference = SchemaTableReference,
> {
  readonly kind: "delete";
  readonly table: T;
  readonly scope: RelationScope;
  readonly fields: readonly {
    readonly propertyName: string;
    readonly sqlName: string;
  }[];
  readonly where: Predicate;
}

export type MutationNode = InsertMutation | UpdateMutation | DeleteMutation;

function isExpression(value: unknown): value is AnyExpression {
  return typeof value === "object" && value !== null && "kind" in value;
}

function expression(value: unknown): SqlExpression {
  return isExpression(value)
    ? value
    : parameterExpression(value as DatabaseBinding);
}

function orderedProperties<T extends SchemaTableReference>(table: T): string[] {
  return Object.keys(table.columns);
}

function buildInsertRows<T extends SchemaTableReference>(
  table: T,
  values: InsertRow<T> | readonly InsertRow<T>[],
) {
  const rows = Array.isArray(values) ? values : [values];
  if (rows.length === 0)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "INSERT requires at least one row",
    );
  const keys = Object.keys(rows[0] as object);
  const tableKeys = orderedProperties(table);
  for (const key of keys) {
    if (!tableKeys.includes(key))
      throw new DatabaseCompilerError(
        "invalid_plan",
        `INSERT column "${key}" is not in table "${table.name}"`,
      );
  }
  const orderedKeys = tableKeys.filter((key) => keys.includes(key));
  for (const row of rows) {
    const rowKeys = Object.keys(row as object);
    if (
      rowKeys.length !== keys.length ||
      rowKeys.some((key) => !keys.includes(key))
    ) {
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Multi-row INSERT values must have identical columns",
      );
    }
  }
  const compiledRows = rows.map((row) =>
    orderedKeys.map((key) => expression((row as Record<string, unknown>)[key])),
  );
  return { columns: orderedKeys, rows: compiledRows };
}

export function insert<T extends GeneratedSchemaTable>(
  table: T,
  values: InsertRow<T> | readonly InsertRow<T>[],
): InsertMutation<T> {
  const built = buildInsertRows(table, values);
  return { kind: "insert", table, ...built, orIgnore: false };
}

export function insertOrIgnore<T extends GeneratedSchemaTable>(
  table: T,
  values: InsertRow<T> | readonly InsertRow<T>[],
): InsertMutation<T> {
  return { ...insert(table, values), orIgnore: true };
}

export function onConflictDoNothing<T extends GeneratedSchemaTable>(
  mutation: InsertMutation<T>,
  target: readonly (keyof T["columns"] & string)[],
): InsertMutation<T> {
  return { ...mutation, conflict: { target, action: "nothing" } };
}

type ConflictSet<T extends SchemaTableReference> = Partial<{
  readonly [K in keyof T["columns"]]:
    SchemaColumnValue<T["columns"][K]> | AnyExpression;
}>;

export function onConflictDoUpdate<T extends GeneratedSchemaTable>(
  mutation: InsertMutation<T>,
  target: readonly (keyof T["columns"] & string)[],
  set: ConflictSet<T>,
): InsertMutation<T> {
  const fields = Object.entries(set) as Array<[string, unknown]>;
  return {
    ...mutation,
    conflict: {
      target,
      action: "update",
      set: fields.map(([propertyName, value]) => ({
        propertyName,
        expression: expression(value),
      })),
    },
  };
}

export function insertFromQuery<T extends GeneratedSchemaTable>(
  table: T,
  columns: readonly (keyof T["columns"] & string)[],
  query: QuerySource,
): InsertMutation<T> {
  return { kind: "insert", table, columns, source: query, orIgnore: false };
}

export type UpdateSet<T extends SchemaTableReference> = Partial<{
  readonly [K in keyof T["columns"]]:
    SchemaColumnValue<T["columns"][K]> | AnyExpression;
}>;

export interface UpdateDraft<T extends SchemaTableReference> {
  readonly set: UpdateSet<T>;
  readonly where: Predicate;
}

function targetColumns<T extends SchemaTableReference>(table: T) {
  const scope = createRelationScope();
  const entries = Object.entries(table.columns) as Array<
    [string, SchemaColumnReference]
  >;
  const columns = Object.fromEntries(
    entries.map(([name, column], index) => [
      name,
      createColumnExpression(scope, index, column),
    ]),
  ) as ScopedColumns<T>;
  return { scope, columns, entries };
}

export function update<T extends GeneratedSchemaTable>(
  table: T,
  build: (columns: ScopedColumns<T>) => UpdateDraft<T>,
): UpdateMutation<T> {
  const target = targetColumns(table);
  const draft = build(target.columns);
  const setEntries = Object.entries(draft.set) as Array<[string, unknown]>;
  if (setEntries.length === 0)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "UPDATE requires at least one assignment",
    );
  const available = new Set(target.entries.map(([name]) => name));
  for (const [name] of setEntries) {
    if (!available.has(name))
      throw new DatabaseCompilerError(
        "invalid_plan",
        `UPDATE column "${name}" is not in table "${table.name}"`,
      );
  }
  return {
    kind: "update",
    table,
    scope: target.scope,
    fields: target.entries.map(([propertyName, column]) => ({
      propertyName,
      sqlName: column.sqlName,
    })),
    set: setEntries.map(([propertyName, value]) => ({
      propertyName,
      expression: expression(value),
    })),
    where: draft.where,
  };
}

export function deleteFrom<T extends GeneratedSchemaTable>(
  table: T,
  where: (columns: ScopedColumns<T>) => Predicate,
): DeleteMutation<T> {
  const target = targetColumns(table);
  return {
    kind: "delete",
    table,
    scope: target.scope,
    fields: target.entries.map(([propertyName, column]) => ({
      propertyName,
      sqlName: column.sqlName,
    })),
    where: where(target.columns),
  };
}

export interface CompiledMutation<Result = D1Result> {
  readonly sql: string;
  readonly bindings?: readonly DatabaseBinding[];
  readonly tag?: string;
  readonly kind: "mutation";
  readonly resultContract?: MutationResultContract<Result>;
  readonly __resultType?: Result;
}

export function mutationResultContract<Result>(
  description: string,
): MutationResultContract<Result> {
  return { kind: "mutation-result", description };
}

export function unsafeRawMutation<Result>(
  sql: string,
  bindings: readonly DatabaseBinding[],
  resultContract: MutationResultContract<Result>,
): CompiledMutation<Result> {
  return { sql, bindings: [...bindings], kind: "mutation", resultContract };
}
