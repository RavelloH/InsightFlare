import type {
  SchemaColumnReference,
  SchemaColumnValue,
  SqliteAffinity,
} from "@/lib/db/schema/types";
import type { SqlBinding } from "@/lib/db/types";

import { DatabaseCompilerError } from "./errors";
import type { QuerySource, Relation } from "./plan";

export type ExpressionAffinity = SqliteAffinity | "unknown";

export interface ExpressionResultType<
  Affinity extends ExpressionAffinity = ExpressionAffinity,
  Nullable extends boolean = boolean,
> {
  readonly affinity: Affinity;
  readonly nullable: Nullable;
}

interface ExpressionNode<
  T = unknown,
  Result extends ExpressionResultType = ExpressionResultType,
> {
  readonly resultType: Result;
  readonly __value?: T;
}

export interface RelationScope {
  readonly marker: symbol;
}

export function createRelationScope(): RelationScope {
  return { marker: Symbol("db-relation") };
}

export interface ColumnExpression<
  T = unknown,
  Result extends ExpressionResultType = ExpressionResultType,
> extends ExpressionNode<T, Result> {
  readonly kind: "column";
  readonly scope: RelationScope;
  readonly index: number;
  readonly name: string;
}

export interface ParameterExpression<
  T extends SqlBinding = SqlBinding,
  Result extends ExpressionResultType = ExpressionResultType,
> extends ExpressionNode<T, Result> {
  readonly kind: "parameter";
  readonly value: T;
}

export interface ExcludedExpression<
  T = unknown,
  Result extends ExpressionResultType = ExpressionResultType,
> extends ExpressionNode<T, Result> {
  readonly kind: "excluded";
  readonly name: string;
}

export interface BinaryExpression<
  T = unknown,
  Result extends ExpressionResultType = ExpressionResultType,
> extends ExpressionNode<T, Result> {
  readonly kind: "binary";
  readonly operator:
    "=" | "<>" | ">" | ">=" | "<" | "<=" | "+" | "-" | "*" | "/";
  readonly left: SqlExpression;
  readonly right: SqlExpression;
}

export interface BooleanExpression<
  T = boolean | null,
  Result extends ExpressionResultType = ExpressionResultType<
    "integer",
    boolean
  >,
> extends ExpressionNode<T, Result> {
  readonly kind: "boolean";
  readonly operator: "AND" | "OR";
  readonly expressions: readonly Predicate[];
}

export interface NotExpression<
  T = boolean | null,
  Result extends ExpressionResultType = ExpressionResultType<
    "integer",
    boolean
  >,
> extends ExpressionNode<T, Result> {
  readonly kind: "not";
  readonly expression: Predicate;
}

export interface NullCheckExpression<
  T = boolean,
  Result extends ExpressionResultType = ExpressionResultType<"integer", false>,
> extends ExpressionNode<T, Result> {
  readonly kind: "null-check";
  readonly expression: SqlExpression;
  readonly not: boolean;
}

export interface InListExpression<
  T = boolean | null,
  Result extends ExpressionResultType = ExpressionResultType<
    "integer",
    boolean
  >,
> extends ExpressionNode<T, Result> {
  readonly kind: "in-list";
  readonly expression: SqlExpression;
  readonly values: readonly SqlBinding[];
}

export type SqlFunctionName = "lower" | "upper" | "length" | "abs" | "round";

export interface FunctionExpression<
  T = unknown,
  Result extends ExpressionResultType = ExpressionResultType,
> extends ExpressionNode<T, Result> {
  readonly kind: "function";
  readonly name: SqlFunctionName;
  readonly arguments: readonly SqlExpression[];
}

export interface AggregateExpression<
  T = number,
  Result extends ExpressionResultType = ExpressionResultType,
> extends ExpressionNode<T, Result> {
  readonly kind: "aggregate";
  readonly name: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";
  readonly expression?: SqlExpression;
  readonly distinct?: boolean;
}

export interface CoalesceExpression<
  T = unknown,
  Result extends ExpressionResultType = ExpressionResultType,
> extends ExpressionNode<T, Result> {
  readonly kind: "coalesce";
  readonly expressions: readonly [
    SqlExpression,
    SqlExpression,
    ...SqlExpression[],
  ];
}

export interface UnixepochExpression<
  T = number,
  Result extends ExpressionResultType = ExpressionResultType<"integer", false>,
> extends ExpressionNode<T, Result> {
  readonly kind: "unixepoch";
}

export interface ScalarSubqueryExpression<
  T = unknown,
  Result extends ExpressionResultType = ExpressionResultType,
> extends ExpressionNode<T, Result> {
  readonly kind: "scalar-subquery";
  readonly query: QuerySource;
}

export interface InSubqueryExpression<
  T = boolean | null,
  Result extends ExpressionResultType = ExpressionResultType<
    "integer",
    boolean
  >,
> extends ExpressionNode<T, Result> {
  readonly kind: "in-subquery";
  readonly expression: SqlExpression;
  readonly query: QuerySource;
}

export type SqlExpression<
  T = unknown,
  Result extends ExpressionResultType = ExpressionResultType,
> =
  | ColumnExpression<T, Result>
  | ParameterExpression<T extends SqlBinding ? T : SqlBinding, Result>
  | ExcludedExpression<T, Result>
  | BinaryExpression<T, Result>
  | BooleanExpression<T, Result>
  | NotExpression<T, Result>
  | NullCheckExpression<T, Result>
  | InListExpression<T, Result>
  | FunctionExpression<T, Result>
  | AggregateExpression<T, Result>
  | CoalesceExpression<T, Result>
  | UnixepochExpression<T, Result>
  | ScalarSubqueryExpression<T, Result>
  | InSubqueryExpression<T, Result>;

export type AnyExpression = SqlExpression<unknown, ExpressionResultType>;
export type Predicate<Nullable extends boolean = boolean> = SqlExpression<
  Nullable extends true ? boolean | null : boolean,
  ExpressionResultType<"integer", Nullable>
>;
export type ExpressionValue<E> = E extends {
  readonly __value?: infer Value;
}
  ? Value
  : never;
export type ExpressionResultOf<E> = E extends {
  readonly resultType: infer Result extends ExpressionResultType;
}
  ? Result
  : never;
export type ScalarValue =
  string | number | boolean | ArrayBuffer | ArrayBufferView | null;

type NullableOf<E extends AnyExpression> = ExpressionResultOf<E>["nullable"];
type AffinityOf<E extends AnyExpression> = ExpressionResultOf<E>["affinity"];
type OrNullable<A extends boolean, B extends boolean> = true extends A | B
  ? true
  : false;
type ComparisonNullable<
  Left extends AnyExpression,
  Right extends AnyExpression,
> = OrNullable<NullableOf<Left>, NullableOf<Right>>;
type NumericAffinity = "integer" | "real" | "numeric";
type AffinitiesComparable<Left, Right> = [Left] extends ["unknown"]
  ? true
  : [Right] extends ["unknown"]
    ? true
    : [Left] extends [Right]
      ? true
      : [Left] extends [NumericAffinity]
        ? [Right] extends [NumericAffinity]
          ? true
          : false
        : false;
type RequireComparable<
  Left extends AnyExpression,
  Right extends AnyExpression,
> =
  AffinitiesComparable<AffinityOf<Left>, AffinityOf<Right>> extends true
    ? unknown
    : never;
type AnyNullable<Expressions extends readonly SqlExpression[]> =
  true extends NullableOf<Expressions[number]> ? true : false;

type BindingAffinity<T> = T extends string
  ? "text"
  : T extends number
    ? "numeric"
    : T extends boolean
      ? "integer"
      : T extends ArrayBuffer | ArrayBufferView
        ? "blob"
        : T extends null
          ? "unknown"
          : "unknown";
type BindingResult<T> = ExpressionResultType<
  BindingAffinity<T>,
  null extends T ? true : false
>;

export type ScopedColumn<C extends SchemaColumnReference> = ColumnExpression<
  SchemaColumnValue<C>,
  ExpressionResultType<C["affinity"], C["nullable"]>
>;
export type ScopedColumns<
  T extends {
    readonly columns: Readonly<Record<string, SchemaColumnReference>>;
  },
> = {
  readonly [K in keyof T["columns"]]: ScopedColumn<T["columns"][K]>;
};

export function expressionResultType(
  expression: SqlExpression,
): ExpressionResultType {
  return expression.resultType;
}

export function commonAffinity(
  left: ExpressionAffinity,
  right: ExpressionAffinity,
): ExpressionAffinity | undefined {
  if (left === "unknown") return right;
  if (right === "unknown") return left;
  if (left === right) return left;
  const numeric = new Set<ExpressionAffinity>(["integer", "real", "numeric"]);
  return numeric.has(left) && numeric.has(right) ? "numeric" : undefined;
}

export function coalesceResultAffinity(
  expressions: readonly SqlExpression[],
): ExpressionAffinity {
  let affinity: ExpressionAffinity | undefined;
  for (const expression of expressions) {
    const next = expression.resultType.affinity;
    if (next === "unknown") continue;
    if (affinity === undefined) {
      affinity = next;
      continue;
    }
    const common = commonAffinity(affinity, next);
    if (!common) return "unknown";
    affinity = common;
  }
  return affinity ?? "unknown";
}

export type CommonExpressionAffinity<
  Left extends ExpressionAffinity,
  Right extends ExpressionAffinity,
> = Left extends "unknown"
  ? Right
  : Right extends "unknown"
    ? Left
    : Left extends Right
      ? Left
      : Left extends "integer" | "real" | "numeric"
        ? Right extends "integer" | "real" | "numeric"
          ? "numeric"
          : "unknown"
        : "unknown";

function affinityOfBinding(value: SqlBinding): ExpressionAffinity {
  if (value === null) return "unknown";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "numeric";
  if (typeof value === "boolean") return "integer";
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "blob";
  return "unknown";
}

export function parameterResultType(value: SqlBinding): ExpressionResultType {
  return {
    affinity: affinityOfBinding(value),
    nullable: value === null,
  };
}

export function parameterExpression<T extends SqlBinding>(
  value: T,
): ParameterExpression<T, BindingResult<T>> {
  return {
    kind: "parameter",
    value,
    resultType: parameterResultType(value) as BindingResult<T>,
  };
}

export const param = parameterExpression;

export function createColumnExpression<C extends SchemaColumnReference>(
  scope: RelationScope,
  index: number,
  column: C,
): ScopedColumn<C> {
  return {
    kind: "column",
    scope,
    index,
    name: column.sqlName,
    resultType: { affinity: column.affinity, nullable: column.nullable },
  };
}

export function rebindColumn<T, Result extends ExpressionResultType>(
  scope: RelationScope,
  index: number,
  name: string,
  resultType: Result,
): ColumnExpression<T, Result> {
  return { kind: "column", scope, index, name, resultType };
}

function comparison<Left extends AnyExpression, Right extends AnyExpression>(
  operator: "=" | "<>" | ">" | ">=" | "<" | "<=",
  left: Left,
  right: Right,
): Predicate<ComparisonNullable<Left, Right>> {
  const resultType = {
    affinity: "integer",
    nullable: left.resultType.nullable || right.resultType.nullable,
  } as ExpressionResultType<"integer", ComparisonNullable<Left, Right>>;
  return { kind: "binary", operator, left, right, resultType } as Predicate<
    ComparisonNullable<Left, Right>
  >;
}

export function eq<Left extends AnyExpression, Right extends AnyExpression>(
  left: Left,
  right: Right & RequireComparable<Left, Right>,
): Predicate<ComparisonNullable<Left, Right>> {
  return comparison("=", left, right);
}

export function neq<Left extends AnyExpression, Right extends AnyExpression>(
  left: Left,
  right: Right & RequireComparable<Left, Right>,
): Predicate<ComparisonNullable<Left, Right>> {
  return comparison("<>", left, right);
}

function orderedComparison<
  Left extends AnyExpression,
  Right extends AnyExpression,
>(
  operator: ">" | ">=" | "<" | "<=",
  left: Left,
  right: Right & RequireComparable<Left, Right>,
): Predicate<ComparisonNullable<Left, Right>> {
  return comparison(operator, left, right);
}

export const gt = <Left extends AnyExpression, Right extends AnyExpression>(
  left: Left,
  right: Right & RequireComparable<Left, Right>,
) => orderedComparison(">", left, right);
export const gte = <Left extends AnyExpression, Right extends AnyExpression>(
  left: Left,
  right: Right & RequireComparable<Left, Right>,
) => orderedComparison(">=", left, right);
export const lt = <Left extends AnyExpression, Right extends AnyExpression>(
  left: Left,
  right: Right & RequireComparable<Left, Right>,
) => orderedComparison("<", left, right);
export const lte = <Left extends AnyExpression, Right extends AnyExpression>(
  left: Left,
  right: Right & RequireComparable<Left, Right>,
) => orderedComparison("<=", left, right);

export function and<First extends Predicate, Rest extends readonly Predicate[]>(
  first: First,
  ...rest: Rest
): Predicate<AnyNullable<readonly [First, ...Rest]>> {
  const expressions = [first, ...rest];
  return {
    kind: "boolean",
    operator: "AND",
    expressions,
    resultType: {
      affinity: "integer",
      nullable: expressions.some((item) => item.resultType.nullable),
    } as ExpressionResultType<
      "integer",
      AnyNullable<readonly [First, ...Rest]>
    >,
  };
}

export function or<First extends Predicate, Rest extends readonly Predicate[]>(
  first: First,
  ...rest: Rest
): Predicate<AnyNullable<readonly [First, ...Rest]>> {
  const expressions = [first, ...rest];
  return {
    kind: "boolean",
    operator: "OR",
    expressions,
    resultType: {
      affinity: "integer",
      nullable: expressions.some((item) => item.resultType.nullable),
    } as ExpressionResultType<
      "integer",
      AnyNullable<readonly [First, ...Rest]>
    >,
  };
}

export function not<E extends Predicate>(
  expression: E,
): Predicate<NullableOf<E>> {
  return {
    kind: "not",
    expression,
    resultType: {
      affinity: "integer",
      nullable: expression.resultType.nullable,
    } as ExpressionResultType<"integer", NullableOf<E>>,
  };
}

export function isNull(expression: SqlExpression): Predicate<false> {
  return {
    kind: "null-check",
    expression,
    not: false,
    resultType: { affinity: "integer", nullable: false },
  };
}

export function isNotNull(expression: SqlExpression): Predicate<false> {
  return {
    kind: "null-check",
    expression,
    not: true,
    resultType: { affinity: "integer", nullable: false },
  };
}

export function inList<
  E extends SqlExpression,
  Values extends readonly Exclude<ExpressionValue<E>, null>[],
>(
  expression: E,
  values: Values,
): Predicate<Values extends readonly [] ? false : NullableOf<E>> {
  const nullable =
    expression.resultType.nullable || values.includes(null as never);
  return {
    kind: "in-list",
    expression,
    values: values as readonly SqlBinding[],
    resultType: {
      affinity: "integer",
      nullable: values.length === 0 ? false : nullable,
    } as ExpressionResultType<
      "integer",
      Values extends readonly [] ? false : NullableOf<E>
    >,
  } as Predicate<Values extends readonly [] ? false : NullableOf<E>>;
}

type MembershipNullable<
  Left extends AnyExpression,
  Right extends AnyExpression,
> = OrNullable<NullableOf<Left>, NullableOf<Right>>;
type MembershipValue<Nullable extends boolean> = Nullable extends true
  ? boolean | null
  : boolean;

export function inSubquery<
  Left extends AnyExpression,
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(
  expression: Left,
  relation: Relation<Row, Columns> &
    RequireComparable<Left, Columns[keyof Columns]>,
): InSubqueryExpression<
  MembershipValue<MembershipNullable<Left, Columns[keyof Columns]>>,
  ExpressionResultType<
    "integer",
    MembershipNullable<Left, Columns[keyof Columns]>
  >
> {
  if (relation.fields.length !== 1) {
    throw new DatabaseCompilerError(
      "invalid_plan",
      "inSubquery() requires a query with exactly one output field",
    );
  }
  const field = relation.fields[0]!;
  return {
    kind: "in-subquery",
    expression,
    query: {
      node: relation.node,
      scope: relation.scope,
      fields: relation.fields,
    },
    resultType: {
      affinity: "integer",
      nullable: expression.resultType.nullable || field.nullable,
    } as ExpressionResultType<
      "integer",
      MembershipNullable<Left, Columns[keyof Columns]>
    >,
  };
}

type ArithmeticValue<
  A,
  B,
  Operator extends "+" | "-" | "*" | "/",
> = Operator extends "/"
  ? number | null
  : null extends A | B
    ? number | null
    : number;

function arithmetic<
  A extends number | null,
  B extends number | null,
  L extends ExpressionResultType,
  R extends ExpressionResultType,
  Operator extends "+" | "-" | "*" | "/",
>(
  operator: Operator,
  left: SqlExpression<A, L>,
  right: SqlExpression<B, R>,
): BinaryExpression<
  ArithmeticValue<A, B, Operator>,
  ExpressionResultType<
    "numeric",
    Operator extends "/" ? true : OrNullable<L["nullable"], R["nullable"]>
  >
> {
  const nullable =
    operator === "/" || left.resultType.nullable || right.resultType.nullable;
  return {
    kind: "binary",
    operator,
    left,
    right,
    resultType: {
      affinity: "numeric",
      nullable,
    } as ExpressionResultType<
      "numeric",
      Operator extends "/" ? true : OrNullable<L["nullable"], R["nullable"]>
    >,
  };
}

export const add = <
  A extends number | null,
  B extends number | null,
  L extends ExpressionResultType,
  R extends ExpressionResultType,
>(
  left: SqlExpression<A, L>,
  right: SqlExpression<B, R>,
) => arithmetic("+", left, right);
export const sub = <
  A extends number | null,
  B extends number | null,
  L extends ExpressionResultType,
  R extends ExpressionResultType,
>(
  left: SqlExpression<A, L>,
  right: SqlExpression<B, R>,
) => arithmetic("-", left, right);
export const mul = <
  A extends number | null,
  B extends number | null,
  L extends ExpressionResultType,
  R extends ExpressionResultType,
>(
  left: SqlExpression<A, L>,
  right: SqlExpression<B, R>,
) => arithmetic("*", left, right);
export const div = <
  A extends number | null,
  B extends number | null,
  L extends ExpressionResultType,
  R extends ExpressionResultType,
>(
  left: SqlExpression<A, L>,
  right: SqlExpression<B, R>,
) => arithmetic("/", left, right);

type NullableValue<E extends AnyExpression, Value> =
  NullableOf<E> extends true ? Value | null : Value;

export function callFunction<
  E extends SqlExpression<string | null>,
  Result extends ExpressionResultType,
>(
  name: "lower" | "upper",
  expression: SqlExpression<ExpressionValue<E>, Result> & E,
): FunctionExpression<
  NullableValue<E, string>,
  ExpressionResultType<"text", NullableOf<E>>
>;
export function callFunction<
  E extends SqlExpression<string | ArrayBuffer | ArrayBufferView | null>,
  Result extends ExpressionResultType,
>(
  name: "length",
  expression: SqlExpression<ExpressionValue<E>, Result> & E,
): FunctionExpression<
  NullableValue<E, number>,
  ExpressionResultType<"integer", NullableOf<E>>
>;
export function callFunction<
  E extends SqlExpression<number | null>,
  Result extends ExpressionResultType,
>(
  name: "abs" | "round",
  expression: SqlExpression<ExpressionValue<E>, Result> & E,
): FunctionExpression<
  NullableValue<E, number>,
  ExpressionResultType<"numeric", NullableOf<E>>
>;
export function callFunction(
  name: SqlFunctionName,
  expression: SqlExpression,
): FunctionExpression {
  let affinity: ExpressionAffinity;
  switch (name) {
    case "lower":
    case "upper":
      affinity = "text";
      break;
    case "length":
      affinity = "integer";
      break;
    case "abs":
    case "round":
      affinity = "numeric";
      break;
  }
  return {
    kind: "function",
    name,
    arguments: [expression],
    resultType: {
      affinity,
      nullable: expression.resultType.nullable,
    },
  };
}

type AllNullable<Expressions extends readonly SqlExpression[]> =
  Expressions extends readonly [
    infer First extends SqlExpression,
    ...infer Rest extends SqlExpression[],
  ]
    ? NullableOf<First> extends true
      ? Rest extends []
        ? true
        : AllNullable<Rest>
      : false
    : true;
type CoalesceAffinityStep<
  Current extends ExpressionAffinity | "unseen" | "conflict",
  Incoming extends ExpressionAffinity,
> = Incoming extends "unknown"
  ? Current
  : Current extends "unseen"
    ? Incoming
    : Current extends "conflict"
      ? "conflict"
      : CommonExpressionAffinity<
            Extract<Current, ExpressionAffinity>,
            Incoming
          > extends infer Common extends ExpressionAffinity
        ? Common extends "unknown"
          ? "conflict"
          : Common
        : "conflict";
type CoalesceAffinity<
  Expressions extends readonly SqlExpression[],
  Current extends ExpressionAffinity | "unseen" | "conflict" = "unseen",
> = Expressions extends readonly [
  infer First extends SqlExpression,
  ...infer Rest extends SqlExpression[],
]
  ? CoalesceAffinity<
      Rest,
      CoalesceAffinityStep<Current, ExpressionResultOf<First>["affinity"]>
    >
  : Current extends ExpressionAffinity
    ? Current
    : "unknown";
type CoalesceValue<Expressions extends readonly SqlExpression[]> =
  | Exclude<ExpressionValue<Expressions[number]>, null>
  | (AllNullable<Expressions> extends true ? null : never);

export function coalesce<
  Expressions extends readonly [
    SqlExpression,
    SqlExpression,
    ...SqlExpression[],
  ],
>(
  ...expressions: Expressions
): CoalesceExpression<
  CoalesceValue<Expressions>,
  ExpressionResultType<CoalesceAffinity<Expressions>, AllNullable<Expressions>>
> {
  const affinity = coalesceResultAffinity(expressions);
  return {
    kind: "coalesce",
    expressions,
    resultType: {
      affinity,
      nullable: expressions.every(
        (expression) => expression.resultType.nullable,
      ),
    } as ExpressionResultType<
      CoalesceAffinity<Expressions>,
      AllNullable<Expressions>
    >,
  };
}

export function count(
  expression?: SqlExpression,
): AggregateExpression<number, ExpressionResultType<"integer", false>> {
  return {
    kind: "aggregate",
    name: "COUNT",
    ...(expression ? { expression } : {}),
    resultType: { affinity: "integer", nullable: false },
  };
}

export function countDistinct(
  expression: SqlExpression,
): AggregateExpression<number, ExpressionResultType<"integer", false>> {
  return {
    kind: "aggregate",
    name: "COUNT",
    expression,
    distinct: true,
    resultType: { affinity: "integer", nullable: false },
  };
}

export function sum(
  expression: SqlExpression<number | null>,
): AggregateExpression<number | null, ExpressionResultType<"numeric", true>> {
  return {
    kind: "aggregate",
    name: "SUM",
    expression,
    resultType: { affinity: "numeric", nullable: true },
  };
}

export function avg(
  expression: SqlExpression<number | null>,
): AggregateExpression<number | null, ExpressionResultType<"numeric", true>> {
  return {
    kind: "aggregate",
    name: "AVG",
    expression,
    resultType: { affinity: "numeric", nullable: true },
  };
}

export function min<T, Result extends ExpressionResultType>(
  expression: SqlExpression<T, Result>,
): AggregateExpression<
  T | null,
  ExpressionResultType<Result["affinity"], true>
> {
  return {
    kind: "aggregate",
    name: "MIN",
    expression,
    resultType: { affinity: expression.resultType.affinity, nullable: true },
  };
}

export function max<T, Result extends ExpressionResultType>(
  expression: SqlExpression<T, Result>,
): AggregateExpression<
  T | null,
  ExpressionResultType<Result["affinity"], true>
> {
  return {
    kind: "aggregate",
    name: "MAX",
    expression,
    resultType: { affinity: expression.resultType.affinity, nullable: true },
  };
}

export function excluded<C extends SchemaColumnReference>(
  column: C,
): ExcludedExpression<
  SchemaColumnValue<C>,
  ExpressionResultType<C["affinity"], C["nullable"]>
> {
  return {
    kind: "excluded",
    name: column.sqlName,
    resultType: { affinity: column.affinity, nullable: column.nullable },
  };
}

export function unixepoch(): UnixepochExpression {
  return {
    kind: "unixepoch",
    resultType: { affinity: "integer", nullable: false },
  };
}

type ScalarColumnValue<
  Columns extends Readonly<Record<string, AnyExpression>>,
> = ExpressionValue<Columns[keyof Columns]> | null;
type ScalarAffinity<Columns extends Readonly<Record<string, AnyExpression>>> =
  ExpressionResultOf<Columns[keyof Columns]>["affinity"];

export function scalar<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(
  relation: Relation<Row, Columns>,
): ScalarSubqueryExpression<
  ScalarColumnValue<Columns>,
  ExpressionResultType<ScalarAffinity<Columns>, true>
> {
  if (relation.fields.length !== 1) {
    throw new DatabaseCompilerError(
      "invalid_plan",
      "scalar() requires a query with exactly one output field",
    );
  }
  const field = relation.fields[0]!;
  return {
    kind: "scalar-subquery",
    query: {
      node: relation.node,
      scope: relation.scope,
      fields: relation.fields,
    },
    resultType: {
      affinity: field.affinity,
      nullable: true,
    } as ExpressionResultType<ScalarAffinity<Columns>, true>,
  };
}
