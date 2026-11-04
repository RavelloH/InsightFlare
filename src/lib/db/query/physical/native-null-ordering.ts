import type { SqlExpression } from "@/lib/db/query/expression";
import { collectPhysicalSubtreeNodes } from "@/lib/db/query/physical/consumer-equivalence";
import type { PhysicalNativeNullOrderingChoice } from "@/lib/db/query/physical/contracts";
import type {
  LogicalQueryNode,
  QuerySource,
  WindowNode,
} from "@/lib/db/query/plan";

function directColumnMatchesSource(
  expression: SqlExpression,
  source: QuerySource,
): expression is Extract<SqlExpression, { readonly kind: "column" }> {
  if (expression.kind !== "column" || expression.scope !== source.scope)
    return false;
  const field = source.fields[expression.index];
  return (
    Number.isSafeInteger(expression.index) &&
    expression.index >= 0 &&
    expression.index < source.fields.length &&
    field !== undefined &&
    field.name === expression.name &&
    field.affinity === expression.resultType.affinity &&
    field.nullable === expression.resultType.nullable
  );
}

function sameColumn(
  left: SqlExpression,
  right: SqlExpression,
): left is Extract<SqlExpression, { readonly kind: "column" }> {
  return (
    left.kind === "column" &&
    right.kind === "column" &&
    left.scope === right.scope &&
    left.index === right.index &&
    left.name === right.name &&
    left.resultType.affinity === right.resultType.affinity &&
    left.resultType.nullable === right.resultType.nullable
  );
}

export function nativeNullPlacement(
  guardIsNot: boolean,
  guardDirection: "ASC" | "DESC",
): "FIRST" | "LAST" {
  const nullsFirst = guardIsNot === (guardDirection === "ASC");
  return nullsFirst ? "FIRST" : "LAST";
}

function choicesForWindow(
  window: WindowNode,
): readonly PhysicalNativeNullOrderingChoice[] {
  const choices: PhysicalNativeNullOrderingChoice[] = [];
  window.windows.forEach(({ specification }, windowIndex) => {
    if (specification.kind !== "row-number") return;
    const occupiedKeys = new Set<number>();
    const keys = specification.orderBy;
    for (let pairIndex = 0; pairIndex + 1 < keys.length; pairIndex += 1) {
      if (occupiedKeys.has(pairIndex) || occupiedKeys.has(pairIndex + 1))
        continue;
      const guardKey = keys[pairIndex];
      const valueKey = keys[pairIndex + 1];
      if (!guardKey || !valueKey || guardKey.expression.kind !== "null-check")
        continue;
      const guardedColumn = guardKey.expression.expression;
      const valueColumn = valueKey.expression;
      if (
        !directColumnMatchesSource(guardedColumn, window.input) ||
        !directColumnMatchesSource(valueColumn, window.input) ||
        !sameColumn(guardedColumn, valueColumn)
      )
        continue;
      choices.push({
        window,
        windowIndex,
        pairIndex,
        input: window.input,
        guardKey,
        valueKey,
        columnIndex: guardedColumn.index,
        columnName: guardedColumn.name,
        guardDirection: guardKey.direction,
        valueDirection: valueKey.direction,
        nullPlacement: nativeNullPlacement(
          guardKey.expression.not,
          guardKey.direction,
        ),
      });
      occupiedKeys.add(pairIndex);
      occupiedKeys.add(pairIndex + 1);
    }
  });
  return choices;
}

/** Re-derive every eligible pair from the typed logical graph, including nested query sources. */
export function analyzeNativeNullOrdering(
  root: LogicalQueryNode,
): readonly PhysicalNativeNullOrderingChoice[] {
  return [...collectPhysicalSubtreeNodes(root)].flatMap((node) =>
    node.kind === "window" ? choicesForWindow(node) : [],
  );
}

export function sameNativeNullOrderingChoices(
  actual: readonly PhysicalNativeNullOrderingChoice[],
  expected: readonly PhysicalNativeNullOrderingChoice[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const candidate = expected[index];
      return (
        candidate !== undefined &&
        choice.window === candidate.window &&
        choice.windowIndex === candidate.windowIndex &&
        choice.pairIndex === candidate.pairIndex &&
        choice.input === candidate.input &&
        choice.guardKey === candidate.guardKey &&
        choice.valueKey === candidate.valueKey &&
        choice.columnIndex === candidate.columnIndex &&
        choice.columnName === candidate.columnName &&
        choice.guardDirection === candidate.guardDirection &&
        choice.valueDirection === candidate.valueDirection &&
        choice.nullPlacement === candidate.nullPlacement
      );
    })
  );
}
