import type {
  SchemaColumnReference,
  SchemaColumnValue,
  SqliteAffinity,
} from "@/lib/db/schema/types";
import type { DatabaseBinding } from "@/lib/db/types";

export interface RelationScope {
  readonly marker: symbol;
}

export function createRelationScope(): RelationScope {
  return { marker: Symbol("db-relation") };
}

export interface ColumnExpression<T = unknown> {
  readonly kind: "column";
  readonly scope: RelationScope;
  readonly index: number;
  readonly name: string;
  readonly affinity: SqliteAffinity;
  readonly nullable: boolean;
  readonly __value?: T;
}

export interface ParameterExpression<
  T extends DatabaseBinding = DatabaseBinding,
> {
  readonly kind: "parameter";
  readonly value: T;
  readonly __value?: T;
}

export interface ExcludedExpression<T = unknown> {
  readonly kind: "excluded";
  readonly name: string;
  readonly __value?: T;
}

export interface BinaryExpression<T = unknown> {
  readonly kind: "binary";
  readonly operator:
    "=" | "<>" | ">" | ">=" | "<" | "<=" | "+" | "-" | "*" | "/";
  readonly left: SqlExpression;
  readonly right: SqlExpression;
  readonly __value?: T;
}

export interface BooleanExpression {
  readonly kind: "boolean";
  readonly operator: "AND" | "OR";
  readonly expressions: readonly Predicate[];
}

export interface NotExpression {
  readonly kind: "not";
  readonly expression: Predicate;
}

export interface NullCheckExpression {
  readonly kind: "null-check";
  readonly expression: SqlExpression;
  readonly not: boolean;
}

export interface InListExpression {
  readonly kind: "in-list";
  readonly expression: SqlExpression;
  readonly values: readonly DatabaseBinding[];
}

export interface FunctionExpression<T = unknown> {
  readonly kind: "function";
  readonly name: SqlFunctionName;
  readonly arguments: readonly SqlExpression[];
  readonly __value?: T;
}

export interface AggregateExpression<T = number> {
  readonly kind: "aggregate";
  readonly name: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";
  readonly expression?: SqlExpression;
  readonly distinct?: boolean;
  readonly __value?: T;
}

export interface CoalesceExpression<T = unknown> {
  readonly kind: "coalesce";
  readonly expressions: readonly [SqlExpression, ...SqlExpression[]];
  readonly __value?: T;
}

export type SqlExpression<T = unknown> =
  | ColumnExpression<T>
  | ParameterExpression<T extends DatabaseBinding ? T : DatabaseBinding>
  | ExcludedExpression<T>
  | BinaryExpression<T>
  | BooleanExpression
  | NotExpression
  | NullCheckExpression
  | InListExpression
  | FunctionExpression<T>
  | AggregateExpression<T>
  | CoalesceExpression<T>;

export type AnyExpression = SqlExpression<unknown>;
export type Predicate = SqlExpression<boolean>;
export type ExpressionValue<E> = E extends SqlExpression<infer T> ? T : never;
export type ScalarValue =
  string | number | boolean | ArrayBuffer | ArrayBufferView | null;

type Comparable<A, B> = [Extract<Exclude<A, null>, Exclude<B, null>>] extends [
  never,
]
  ? never
  : unknown;
type OrderedComparable<A, B> = [Exclude<A, null>] extends [string | number]
  ? [Exclude<B, null>] extends [string | number]
    ? Comparable<A, B>
    : never
  : never;

export type ScopedColumn<C extends SchemaColumnReference> = ColumnExpression<
  SchemaColumnValue<C>
>;
export type ScopedColumns<
  T extends {
    readonly columns: Readonly<Record<string, SchemaColumnReference>>;
  },
> = {
  readonly [K in keyof T["columns"]]: ScopedColumn<T["columns"][K]>;
};

export function parameterExpression<T extends DatabaseBinding>(
  value: T,
): ParameterExpression<T> {
  return { kind: "parameter", value };
}

export const param = parameterExpression;

export function createColumnExpression<C extends SchemaColumnReference>(
  scope: RelationScope,
  index: number,
  column: C,
  nullable = column.nullable,
): ColumnExpression<SchemaColumnValue<C>> {
  return {
    kind: "column",
    scope,
    index,
    name: column.sqlName,
    affinity: column.affinity,
    nullable,
  };
}

export function rebindColumn<T>(
  scope: RelationScope,
  index: number,
  name: string,
  affinity: SqliteAffinity,
  nullable: boolean,
): ColumnExpression<T> {
  return { kind: "column", scope, index, name, affinity, nullable };
}

export function eq<A, B>(
  left: SqlExpression<A>,
  right: SqlExpression<B> & Comparable<A, B>,
): Predicate {
  return { kind: "binary", operator: "=", left, right };
}

export function neq<A, B>(
  left: SqlExpression<A>,
  right: SqlExpression<B> & Comparable<A, B>,
): Predicate {
  return { kind: "binary", operator: "<>", left, right };
}

function comparison<A, B>(
  operator: ">" | ">=" | "<" | "<=",
  left: SqlExpression<A>,
  right: SqlExpression<B> & OrderedComparable<A, B>,
): Predicate {
  return { kind: "binary", operator, left, right };
}

export const gt = <A, B>(
  left: SqlExpression<A>,
  right: SqlExpression<B> & OrderedComparable<A, B>,
) => comparison(">", left, right);
export const gte = <A, B>(
  left: SqlExpression<A>,
  right: SqlExpression<B> & OrderedComparable<A, B>,
) => comparison(">=", left, right);
export const lt = <A, B>(
  left: SqlExpression<A>,
  right: SqlExpression<B> & OrderedComparable<A, B>,
) => comparison("<", left, right);
export const lte = <A, B>(
  left: SqlExpression<A>,
  right: SqlExpression<B> & OrderedComparable<A, B>,
) => comparison("<=", left, right);

export function and(
  first: Predicate,
  ...rest: readonly Predicate[]
): Predicate {
  return { kind: "boolean", operator: "AND", expressions: [first, ...rest] };
}

export function or(first: Predicate, ...rest: readonly Predicate[]): Predicate {
  return { kind: "boolean", operator: "OR", expressions: [first, ...rest] };
}

export function not(expression: Predicate): Predicate {
  return { kind: "not", expression };
}

export function isNull(expression: SqlExpression): Predicate {
  return { kind: "null-check", expression, not: false };
}

export function isNotNull(expression: SqlExpression): Predicate {
  return { kind: "null-check", expression, not: true };
}

export function inList<T>(
  expression: SqlExpression<T>,
  values: readonly Exclude<T, null>[],
): Predicate {
  return {
    kind: "in-list",
    expression,
    values: values as readonly DatabaseBinding[],
  };
}

function arithmetic<A extends number | null, B extends number | null>(
  operator: "+" | "-" | "*" | "/",
  left: SqlExpression<A>,
  right: SqlExpression<B>,
): SqlExpression<null extends A | B ? number | null : number> {
  return { kind: "binary", operator, left, right };
}

export const add = <A extends number | null, B extends number | null>(
  left: SqlExpression<A>,
  right: SqlExpression<B>,
) => arithmetic("+", left, right);
export const sub = <A extends number | null, B extends number | null>(
  left: SqlExpression<A>,
  right: SqlExpression<B>,
) => arithmetic("-", left, right);
export const mul = <A extends number | null, B extends number | null>(
  left: SqlExpression<A>,
  right: SqlExpression<B>,
) => arithmetic("*", left, right);
export const div = <A extends number | null, B extends number | null>(
  left: SqlExpression<A>,
  right: SqlExpression<B>,
) => arithmetic("/", left, right);

export type SqlFunctionName = "lower" | "upper" | "length" | "abs" | "round";

export function callFunction(
  name: "lower" | "upper",
  ...args: readonly [SqlExpression<string>]
): SqlExpression<string>;
export function callFunction(
  name: "length" | "abs" | "round",
  ...args: readonly [SqlExpression<number>]
): SqlExpression<number>;
export function callFunction(
  name: SqlFunctionName,
  ...args: readonly SqlExpression[]
): SqlExpression<string | number> {
  return { kind: "function", name, arguments: args };
}

export function coalesce<A, B>(
  first: SqlExpression<A>,
  second: SqlExpression<B>,
): SqlExpression<Exclude<A | B, null>> {
  return { kind: "coalesce", expressions: [first, second] };
}

export function count(expression?: SqlExpression): AggregateExpression<number> {
  return {
    kind: "aggregate",
    name: "COUNT",
    ...(expression ? { expression } : {}),
  };
}

export function countDistinct(
  expression: SqlExpression,
): AggregateExpression<number> {
  return { kind: "aggregate", name: "COUNT", expression, distinct: true };
}

export function sum(
  expression: SqlExpression<number | null>,
): AggregateExpression<number | null> {
  return { kind: "aggregate", name: "SUM", expression };
}

export function avg(
  expression: SqlExpression<number | null>,
): AggregateExpression<number | null> {
  return { kind: "aggregate", name: "AVG", expression };
}

export function min<T>(
  expression: SqlExpression<T>,
): AggregateExpression<T | null> {
  return { kind: "aggregate", name: "MIN", expression };
}

export function max<T>(
  expression: SqlExpression<T>,
): AggregateExpression<T | null> {
  return { kind: "aggregate", name: "MAX", expression };
}

export function excluded<C extends SchemaColumnReference>(
  column: C,
): ExcludedExpression<SchemaColumnValue<C>> {
  return { kind: "excluded", name: column.sqlName };
}
