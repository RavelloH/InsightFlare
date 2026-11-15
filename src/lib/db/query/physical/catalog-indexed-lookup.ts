import type { SqlExpression } from "@/lib/db/query/expression";
import type { LogicalQueryNode, QuerySource } from "@/lib/db/query/plan";

interface LookupAccess {
  readonly uniqueKeys: readonly (readonly number[])[];
  // A base unique seek remains available even when an outer join can multiply its output.
  readonly pointLookupKeys: readonly (readonly number[])[];
  readonly lookupPrefixes: readonly (readonly number[])[];
}

/** Preserve only catalog lookups exposed through ordinary, flattenable inputs. */
export function hasExposedCatalogIndexedLookup(
  source: QuerySource,
  equalityIndexes: readonly number[],
  materialized: { has(node: LogicalQueryNode): boolean },
  allowPreservedSideLookup = false,
): boolean {
  const active = new Set<LogicalQueryNode>();
  const direct = (
    expression: SqlExpression | undefined,
    input: QuerySource,
  ): number | undefined =>
    expression?.kind === "column" &&
    expression.scope === input.scope &&
    input.fields[expression.index]?.name === expression.name
      ? expression.index
      : undefined;
  const covers = (
    indexes: readonly number[],
    keys: LookupAccess["uniqueKeys"],
  ): boolean =>
    keys.some(
      (key) => key.length > 0 && key.every((index) => indexes.includes(index)),
    );
  const analyze = (input: QuerySource): LookupAccess | undefined => {
    const node = input.node;
    if (active.has(node) || materialized.has(node)) return undefined;
    active.add(node);
    let result: LookupAccess | undefined;
    if (node.kind === "scan" && node.table.kind === "table") {
      const names = Object.values(node.table.columns).map(
        (column) => column.sqlName,
      );
      const indexes = node.table.indexes.filter(
        (index) =>
          !index.partial &&
          index.rawExpressionSql === undefined &&
          index.columns.every((name) => name !== null),
      );
      const mapped = (
        key: readonly (string | null)[],
      ): readonly number[] | undefined =>
        key.length > 0 &&
        key.every((name) => name !== null && names.includes(name))
          ? key.map((name) => names.indexOf(name!))
          : undefined;
      const uniqueKeys = [
        node.table.primaryKey,
        ...indexes
          .filter((index) => index.unique)
          .map((index) => index.columns),
      ]
        .map(mapped)
        .filter((key): key is readonly number[] => key !== undefined);
      const lookupPrefixes = [
        node.table.primaryKey,
        ...indexes.map((index) => index.columns),
      ]
        .map(mapped)
        .filter((key): key is readonly number[] => key !== undefined)
        .flatMap((key) => key.map((_column, index) => key.slice(0, index + 1)));
      result = { uniqueKeys, pointLookupKeys: uniqueKeys, lookupPrefixes };
    } else if (node.kind === "filter") {
      result = analyze(node.input);
    } else if (node.kind === "project") {
      const indexes = node.projections.map(({ expression }) =>
        direct(expression, node.input),
      );
      const child = analyze(node.input);
      if (child) {
        const mapped = (keys: LookupAccess["uniqueKeys"]) =>
          keys
            .filter((key) => key.every((index) => indexes.includes(index)))
            .map((key) => key.map((index) => indexes.indexOf(index)));
        result = {
          uniqueKeys: mapped(child.uniqueKeys),
          pointLookupKeys: mapped(child.pointLookupKeys),
          lookupPrefixes: mapped(child.lookupPrefixes),
        };
      }
    } else if (
      node.kind === "join" &&
      node.joinType === "left" &&
      allowPreservedSideLookup
    ) {
      const left = analyze(node.left);
      if (left)
        result = {
          uniqueKeys: [],
          pointLookupKeys: left.pointLookupKeys,
          lookupPrefixes: left.lookupPrefixes,
        };
    } else if (node.kind === "join" && node.joinType === "inner") {
      const leftIndexes: number[] = [],
        rightIndexes: number[] = [];
      const condition = (expression: SqlExpression): boolean => {
        if (expression.kind === "boolean")
          return (
            expression.operator === "AND" &&
            expression.expressions.length > 0 &&
            expression.expressions.every(condition)
          );
        if (expression.kind !== "binary" || expression.operator !== "=")
          return false;
        const left = direct(expression.left, node.left),
          right = direct(expression.right, node.right);
        if (left === undefined || right === undefined) return false;
        leftIndexes.push(left);
        rightIndexes.push(right);
        return true;
      };
      if (condition(node.condition)) {
        const left = analyze(node.left),
          right = analyze(node.right);
        if (left && right) {
          const preserveLeft = covers(rightIndexes, right.uniqueKeys);
          const preserveRight = covers(leftIndexes, left.uniqueKeys);
          const merged = (field: keyof LookupAccess) => [
            ...(preserveLeft ? left[field] : []),
            ...(preserveRight
              ? right[field].map((key) =>
                  key.map((index) => index + node.left.fields.length),
                )
              : []),
          ];
          result = {
            uniqueKeys: merged("uniqueKeys"),
            pointLookupKeys: merged("pointLookupKeys"),
            lookupPrefixes: merged("lookupPrefixes"),
          };
        }
      }
    }
    active.delete(node);
    return result;
  };
  const access = analyze(source);
  const keyCount = new Set(equalityIndexes).size;
  return (
    access !== undefined &&
    (covers(equalityIndexes, access.pointLookupKeys) ||
      access.lookupPrefixes.some(
        (prefix) =>
          prefix.length === keyCount &&
          prefix.every((index) => equalityIndexes.includes(index)),
      ))
  );
}
