import {
  type FilterHistoryRange,
  isFilterTimeLeaf,
  resolveFilterTimeEndpointMs,
} from "@/lib/filter-contract/filter-history";
import type {
  FilterCondition,
  FilterExpression,
} from "@/lib/filter-contract/filters";

/** Query-time facts a top-level `time` leaf needs to become literal bounds. */
export interface CountTimeLeafContext {
  readonly candidateRange: FilterHistoryRange;
  readonly capturedAtMs: number;
}

export interface CountTimeLeaf {
  readonly operator: "gt" | "gte" | "lt" | "lte" | "between";
  /** One bound, or the inclusive lower and upper bound of `between`. */
  readonly values: readonly number[];
}

export { isFilterTimeLeaf as isCountTimeLeafCondition };

/**
 * A top-level `time` leaf is existential over the anchor's loaded Page and Event
 * activities. The SQL slice supports ordered comparisons against safe-integer or
 * elapsed-offset anchors, which the Core evaluator resolves identically.
 */
export function countTimeLeaf(
  condition: FilterCondition,
  context: CountTimeLeafContext,
): CountTimeLeaf | undefined {
  if (!isFilterTimeLeaf(condition)) return undefined;
  const operator = condition.operator;
  if (
    operator !== "gt" &&
    operator !== "gte" &&
    operator !== "lt" &&
    operator !== "lte" &&
    operator !== "between"
  )
    return undefined;
  const raw = Array.isArray(condition.value)
    ? condition.value
    : condition.value === undefined
      ? []
      : [condition.value];
  if (raw.length !== (operator === "between" ? 2 : 1)) return undefined;
  const values: number[] = [];
  for (const value of raw) {
    const resolved = resolveFilterTimeEndpointMs(
      value,
      context.candidateRange,
      context.capturedAtMs,
    );
    if (resolved === null) return undefined;
    values.push(resolved);
  }
  return { operator, values };
}

/** Every top-level `time` leaf of the tree, in tree order. */
export function countTimeLeafConditions(
  root: FilterExpression,
): readonly FilterCondition[] {
  const result: FilterCondition[] = [];
  const visit = (expression: FilterExpression): void => {
    if (expression.kind === "not") return visit(expression.child);
    if (expression.kind === "and" || expression.kind === "or")
      return expression.children.forEach(visit);
    if (expression.kind === "condition" && isFilterTimeLeaf(expression))
      result.push(expression);
  };
  visit(root);
  return result;
}
