import type { SqlExpression } from "@/lib/db/query/expression";
import { isMaterializationSafeExpression } from "@/lib/db/query/materialization-safety";
import type {
  LogicalQueryNode,
  QuerySource,
  ScanNode,
} from "@/lib/db/query/plan";

import { hasOrderStableConsumers } from "./consumer-order-stability";

interface SingletonLookupBody {
  readonly scan: ScanNode;
  readonly origins: readonly number[];
  readonly bound: ReadonlySet<number>;
}

/** A direct, closed catalog unique seek returns at most one original row.
 * No grouping, casts, DISTINCT, or new storage-representative proof is used. */
export function isSingletonCatalogLookup(node: LogicalQueryNode): boolean {
  const active = new Set<LogicalQueryNode>();
  const analyze = (source: QuerySource): SingletonLookupBody | undefined => {
    const current = source.node;
    if (
      active.has(current) ||
      current.scope !== source.scope ||
      current.fields.length !== source.fields.length
    )
      return undefined;
    active.add(current);
    let result: SingletonLookupBody | undefined;
    if (
      current.kind === "scan" &&
      current.table.kind === "table" &&
      current.table.defaultCollation === "BINARY"
    ) {
      const columns = Object.values(current.table.columns);
      if (
        columns.length === current.fields.length &&
        columns.every(
          (column, index) =>
            column.table === current.table.name &&
            column.propertyName === current.fields[index]?.name &&
            column.affinity === current.fields[index]?.affinity &&
            column.nullable === current.fields[index]?.nullable,
        )
      )
        result = {
          scan: current,
          origins: columns.map((_column, index) => index),
          bound: new Set(),
        };
    } else if (current.kind === "project") {
      const input = analyze(current.input);
      const origins = current.projections.map(({ expression }, index) =>
        expression.kind === "column" &&
        expression.scope === current.input.scope &&
        expression.name === current.input.fields[expression.index]?.name &&
        expression.resultType.affinity ===
          current.input.fields[expression.index]?.affinity &&
        expression.resultType.nullable ===
          current.input.fields[expression.index]?.nullable &&
        current.fields[index]?.affinity === expression.resultType.affinity &&
        current.fields[index]?.nullable === expression.resultType.nullable
          ? input?.origins[expression.index]
          : undefined,
      );
      if (
        input &&
        origins.length === current.fields.length &&
        origins.every((origin): origin is number => origin !== undefined)
      )
        result = { ...input, origins };
    } else if (current.kind === "filter") {
      const input = analyze(current.input);
      const fields = new Map([
        [current.input.scope, current.input.fields.length],
      ]);
      if (
        input &&
        current.fields.every(
          (field, index) =>
            field.name === current.input.fields[index]?.name &&
            field.affinity === current.input.fields[index]?.affinity &&
            field.nullable === current.input.fields[index]?.nullable,
        ) &&
        isMaterializationSafeExpression(current.predicate, fields)
      ) {
        const bound = new Set(input.bound);
        const direct = (expression: SqlExpression) =>
          expression.kind === "column" &&
          expression.scope === current.input.scope &&
          expression.name === current.input.fields[expression.index]?.name
            ? input.origins[expression.index]
            : undefined;
        const literal = (expression: SqlExpression) =>
          expression.kind === "constant" || expression.kind === "parameter";
        const collect = (expression: SqlExpression): void => {
          if (expression.kind === "boolean" && expression.operator === "AND")
            expression.expressions.forEach(collect);
          else if (
            expression.kind === "binary" &&
            expression.operator === "="
          ) {
            const left = direct(expression.left),
              right = direct(expression.right);
            if (left !== undefined && literal(expression.right))
              bound.add(left);
            if (right !== undefined && literal(expression.left))
              bound.add(right);
          } else if (
            expression.kind === "in-list" &&
            expression.values.length === 1
          ) {
            const origin = direct(expression.expression);
            if (origin !== undefined) bound.add(origin);
          }
        };
        collect(current.predicate);
        result = { ...input, bound };
      }
    }
    active.delete(current);
    return result;
  };
  const body = analyze({ node, scope: node.scope, fields: node.fields });
  if (!body) return false;
  const columns = Object.values(body.scan.table.columns).map(
    (column) => column.sqlName,
  );
  const keys = [
    body.scan.table.primaryKey,
    ...body.scan.table.indexes
      .filter(
        (index) =>
          index.unique &&
          !index.partial &&
          index.rawExpressionSql === undefined &&
          (index.collations === undefined ||
            index.collations.every((collation) => collation === "BINARY")),
      )
      .map((index) => index.columns),
  ];
  return keys.some(
    (key) =>
      key.length > 0 &&
      key.every(
        (name) =>
          name !== null &&
          columns.includes(name) &&
          body.bound.has(columns.indexOf(name)),
      ),
  );
}

/** Cost opportunity: the same singleton owner feeds both an ordinary input and
 * its grouped-key lookup. Inlining the owner can make SQLite repeatedly scan
 * the computed group result; materializing only this tiny seek restores probes. */
export function sharedSingletonLookupReuse(
  candidate: LogicalQueryNode,
  root: LogicalQueryNode,
): boolean {
  if (!isSingletonCatalogLookup(candidate)) return false;
  const containsMemo = new Map<LogicalQueryNode, boolean>();
  const children = (node: LogicalQueryNode): readonly QuerySource[] =>
    "input" in node
      ? [node.input]
      : "left" in node && "right" in node
        ? [node.left, node.right]
        : node.kind === "recursive-closure"
          ? [node.seed, node.candidates]
          : [];
  const contains = (node: LogicalQueryNode): boolean => {
    if (node === candidate) return true;
    const prior = containsMemo.get(node);
    if (prior !== undefined) return prior;
    containsMemo.set(node, false);
    const result = children(node).some((source) => contains(source.node));
    containsMemo.set(node, result);
    return result;
  };
  const visited = new Set<LogicalQueryNode>();
  const opportunity = (node: LogicalQueryNode): boolean => {
    if (visited.has(node)) return false;
    visited.add(node);
    if (
      node.kind === "join" &&
      node.joinType === "inner" &&
      node.right.node.kind === "aggregate" &&
      node.right.node.groups.length > 0 &&
      contains(node.left.node) &&
      contains(node.right.node)
    ) {
      const grouped = node.right.node;
      const groups = new Set<number>();
      const equalities = (expression: SqlExpression): boolean => {
        if (expression.kind === "boolean")
          return (
            expression.operator === "AND" &&
            expression.expressions.length > 0 &&
            expression.expressions.every(equalities)
          );
        if (expression.kind !== "binary" || expression.operator !== "=")
          return false;
        const pair = (left: SqlExpression, right: SqlExpression) =>
          left.kind === "column" &&
          left.scope === node.left.scope &&
          left.name === node.left.fields[left.index]?.name &&
          right.kind === "column" &&
          right.scope === node.right.scope &&
          right.name === node.right.fields[right.index]?.name &&
          right.index < grouped.groups.length
            ? right.index
            : undefined;
        const index =
          pair(expression.left, expression.right) ??
          pair(expression.right, expression.left);
        if (index === undefined) return false;
        groups.add(index);
        return true;
      };
      if (
        equalities(node.condition) &&
        groups.size === node.right.node.groups.length
      )
        return true;
    }
    return children(node).some((source) => opportunity(source.node));
  };
  // A total singleton body alone does not license a different consumer order:
  // keep the existing SUM/float/representative/selection safety proof intact.
  return opportunity(root) && hasOrderStableConsumers(candidate, root);
}
