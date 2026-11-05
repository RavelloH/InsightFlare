import type { SqlExpression } from "./expression";
import type { LogicalQueryNode, QuerySource } from "./plan";

function currentSource(source: QuerySource): boolean {
  if (!source || typeof source !== "object") return false;
  const node = source.node;
  if (
    !node ||
    typeof node !== "object" ||
    source.scope !== node.scope ||
    !source.scope ||
    typeof source.scope.marker !== "symbol" ||
    !Array.isArray(source.fields) ||
    !Array.isArray(node.fields) ||
    source.fields.length !== node.fields.length
  )
    return false;
  return source.fields.every((field, index) => {
    const nodeField = node.fields[index];
    return (
      !!field &&
      !!nodeField &&
      field.name === nodeField.name &&
      field.affinity === nodeField.affinity &&
      field.nullable === nodeField.nullable
    );
  });
}

function safeLimitCount(
  node: Extract<LogicalQueryNode, { kind: "limit" }>,
): number | undefined {
  const expression = node.count;
  const resultType = expression?.resultType;
  if (
    node.offset !== undefined ||
    !resultType ||
    (expression.kind !== "parameter" && expression.kind !== "constant") ||
    (resultType.affinity !== "integer" && resultType.affinity !== "numeric") ||
    resultType.nullable ||
    typeof expression.value !== "number" ||
    !Number.isSafeInteger(expression.value) ||
    expression.value <= 0
  )
    return undefined;
  return expression.value;
}

function rowUpperBound(
  source: QuerySource,
  memo: Map<LogicalQueryNode, number | null>,
  active: Set<LogicalQueryNode>,
  cycleDetected: { value: boolean },
): number | undefined {
  if (!currentSource(source)) return undefined;
  const node = source.node;
  const cached = memo.get(node);
  if (cached !== undefined) return cached ?? undefined;
  if (active.has(node)) {
    cycleDetected.value = true;
    return undefined;
  }
  active.add(node);

  let result: number | undefined;
  switch (node.kind) {
    case "limit": {
      const cap = safeLimitCount(node);
      if (cap === undefined) break;
      const input = rowUpperBound(node.input, memo, active, cycleDetected);
      result = input === undefined ? cap : Math.min(input, cap);
      break;
    }
    case "project":
    case "filter":
      result = rowUpperBound(node.input, memo, active, cycleDetected);
      break;
    case "aggregate":
      if (node.groups.length === 0 && node.aggregates.length > 0) result = 1;
      break;
    case "join": {
      if (node.joinType !== "inner" && node.joinType !== "left") break;
      const left = rowUpperBound(node.left, memo, active, cycleDetected);
      const right = rowUpperBound(node.right, memo, active, cycleDetected);
      if (node.joinType === "left") {
        if (left !== undefined && right !== undefined && right <= 1)
          result = left;
      } else if (left !== undefined && right !== undefined) {
        if (right <= 1) result = left;
        else if (left <= 1) result = right;
      }
      break;
    }
    default:
      break;
  }

  active.delete(node);
  memo.set(node, result ?? null);
  return result;
}

/** Proves a conservative finite row count without granting reuse permission. */
export function finiteRelationRowUpperBound(
  source: QuerySource,
): number | undefined {
  const cycleDetected = { value: false };
  const result = rowUpperBound(source, new Map(), new Set(), cycleDetected);
  return cycleDetected.value ? undefined : result;
}

/** The values are restricted; callers separately prove local expression totality. */
export function isUnitIndicator(expression: SqlExpression): boolean {
  if (
    (expression.kind === "parameter" || expression.kind === "constant") &&
    (expression.resultType.affinity === "integer" ||
      expression.resultType.affinity === "numeric") &&
    !expression.resultType.nullable &&
    typeof expression.value === "number" &&
    Number.isSafeInteger(expression.value) &&
    (expression.value === 0 || expression.value === 1)
  )
    return true;
  if (expression.kind === "case")
    return (
      expression.branches.length > 0 &&
      expression.branches.every(({ then }) => isUnitIndicator(then)) &&
      expression.else !== undefined &&
      isUnitIndicator(expression.else)
    );
  if (expression.kind === "coalesce")
    return (
      expression.expressions.length > 0 &&
      expression.expressions.every(isUnitIndicator)
    );
  return false;
}

/** Numeric safety proof only; materialization still needs a fresh license. */
export function hasSafeBoundedUnitSumInput(
  expression: SqlExpression,
  input: QuerySource,
): boolean {
  if (
    expression.kind !== "aggregate" ||
    expression.name !== "SUM" ||
    !expression.expression ||
    !isUnitIndicator(expression.expression)
  )
    return false;
  const maximumRows = finiteRelationRowUpperBound(input);
  return (
    maximumRows !== undefined &&
    Number.isSafeInteger(maximumRows) &&
    maximumRows >= 0 &&
    maximumRows <= Number.MAX_SAFE_INTEGER
  );
}
