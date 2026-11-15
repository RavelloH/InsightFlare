import type { SqlExpression } from "@/lib/db/query/expression";
import { isMaterializationSafeExpression } from "@/lib/db/query/materialization-safety";
import type {
  AggregateNode,
  LogicalQueryNode,
  QuerySource,
} from "@/lib/db/query/plan";

export const MAXIMUM_OWNER_ROWS = 1_000_000;
export const MAXIMUM_SUM_MAGNITUDE = Math.floor(
  Number.MAX_SAFE_INTEGER / MAXIMUM_OWNER_ROWS,
);

/** Proposed conditional obligations only. Neither INTEGER affinity nor this
 * return value permits execution: compiler must check every raw value and exact
 * input count in the SAME statement before the aggregate branch is evaluated.
 * The caller must separately prove this exact owner producer total and all
 * window choices determined. No bound transfers across joins, filters or sets. */
export interface OwnerAggregateObligation {
  readonly aggregate: AggregateNode;
  readonly input: QuerySource;
  readonly sumIndexes: readonly number[];
  readonly extremaIndexes: readonly number[];
  readonly canonicalOutputIndexes: readonly number[];
  readonly accepted: readonly SqlExpression[];
}

export function deriveOwnerAggregateObligation(
  n: AggregateNode,
  owner: LogicalQueryNode,
): OwnerAggregateObligation | undefined {
  if (n.input.node !== owner) return undefined;
  const source = n.input;
  if (
    source.scope !== owner.scope ||
    source.fields.length !== owner.fields.length ||
    source.fields.some(
      (f, i) =>
        f.name !== owner.fields[i]!.name ||
        f.affinity !== owner.fields[i]!.affinity ||
        f.nullable !== owner.fields[i]!.nullable,
    )
  )
    return undefined;
  const scopes = new Map([[source.scope, source.fields.length]]);
  const sumIndexes = new Set<number>();
  const extremaIndexes = new Set<number>();
  const accepted: SqlExpression[] = [];
  const canonicalOutputIndexes: number[] = [];
  const column = (e: SqlExpression): number | undefined => {
    if (
      e.kind !== "column" ||
      e.scope !== source.scope ||
      !Number.isInteger(e.index)
    )
      return;
    const f = source.fields[e.index];
    if (
      !f ||
      e.name !== f.name ||
      e.resultType.affinity !== f.affinity ||
      e.resultType.nullable !== f.nullable
    )
      return;
    return e.index;
  };
  const extrema = (e: SqlExpression): number[] | undefined => {
    const i = column(e);
    if (i !== undefined) return [i];
    if (e.kind !== "coalesce" || e.expressions.length === 0) return;
    const values = e.expressions.map(extrema);
    if (values.some((v) => v === undefined)) return;
    return values.flatMap((v) => v!);
  };
  const uniformIndicator = (e: SqlExpression): boolean => {
    const kinds = new Set<string>();
    const visit = (v: SqlExpression): boolean => {
      if (v.kind === "parameter" || v.kind === "constant") {
        kinds.add(v.kind);
        return v.value === 0 || v.value === 1;
      }
      return (
        v.kind === "case" &&
        v.branches.length > 0 &&
        v.branches.every(
          (b) =>
            isMaterializationSafeExpression(b.when, scopes) && visit(b.then),
        ) &&
        v.else !== undefined &&
        visit(v.else)
      );
    };
    return visit(e) && kinds.size === 1;
  };
  for (const [position, a] of n.aggregates.entries()) {
    const e = a.expression;
    if (e.kind !== "aggregate" || e.distinct || !e.expression) continue;
    if (
      e.name === "SUM" &&
      e.expression.kind === "coalesce" &&
      e.expression.expressions.length === 2
    ) {
      const [raw, zero] = e.expression.expressions;
      const i = column(raw!);
      if (
        i !== undefined &&
        (zero!.kind === "parameter" || zero!.kind === "constant") &&
        zero!.value === 0
      ) {
        sumIndexes.add(i);
        accepted.push(e);
        continue;
      }
    }
    if (e.name === "MIN" || e.name === "MAX") {
      const indexes = extrema(e.expression);
      if (indexes) {
        indexes.forEach((i) => extremaIndexes.add(i));
        canonicalOutputIndexes.push(n.groups.length + position);
        accepted.push(e);
        continue;
      }
      // Same construction means every non-NULL result has identical storage
      // class, rather than assuming bound numbers use SQLITE_INTEGER.
      if (e.name === "MAX" && uniformIndicator(e.expression)) accepted.push(e);
    }
  }
  return accepted.length
    ? {
        aggregate: n,
        input: source,
        sumIndexes: [...sumIndexes],
        extremaIndexes: [...extremaIndexes],
        canonicalOutputIndexes,
        accepted,
      }
    : undefined;
}
