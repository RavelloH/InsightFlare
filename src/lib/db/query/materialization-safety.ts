import { hasSafeBoundedUnitSumInput } from "./bounded-unit-sum-proof";
import type { RelationScope, SqlExpression } from "./expression";
import type { LogicalQueryNode, QuerySource } from "./plan";
import { hasStableRowNumberOrdering } from "./relational-key-facts";

export interface SharedMembershipInputIncomingEdge {
  readonly parent: LogicalQueryNode;
  readonly kind: "relation" | "expression";
}

export interface SharedMembershipInputReuseInput {
  readonly nodes: readonly LogicalQueryNode[];
  readonly incomingCounts: ReadonlyMap<LogicalQueryNode, number>;
  readonly incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >;
  readonly forbiddenAncestors: ReadonlySet<LogicalQueryNode>;
  readonly expressionQueryEdges: ReadonlySet<LogicalQueryNode>;
  readonly boundedGroupSummaryCandidates: ReadonlySet<LogicalQueryNode>;
  readonly minimumFields: number;
  readonly maximumFields: number;
  readonly minimumReferences: number;
}

const TOTAL_FUNCTIONS = new Set([
  "concat-text",
  "length",
  "byte-length",
  "lower",
  "round",
  "storage-class",
  "text-contains",
  "text-ends-with",
  "text-starts-with",
  "trim",
  "trim-characters",
  "trim-spaces",
  "upper",
]);

function safeBinding(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

/**
 * Check a complete expression tree without relying on declared determinism.
 * The closed scope map also proves that every referenced column belongs to a
 * direct input and is within that input's field list.
 */
export function isMaterializationSafeExpression(
  expression: SqlExpression,
  fieldsByScope: ReadonlyMap<RelationScope, number>,
): boolean {
  const active = new WeakSet<object>();
  const visit = (current: SqlExpression): boolean => {
    if (typeof current !== "object" || current === null || active.has(current))
      return false;
    active.add(current);
    let safe: boolean;
    switch (current.kind) {
      case "column": {
        const fieldCount = fieldsByScope.get(current.scope);
        safe =
          fieldCount !== undefined &&
          Number.isInteger(current.index) &&
          current.index >= 0 &&
          current.index < fieldCount;
        break;
      }
      case "parameter":
        safe = safeBinding(current.value);
        break;
      case "constant":
        safe =
          current.value === null ||
          typeof current.value === "string" ||
          (typeof current.value === "number" &&
            Number.isSafeInteger(current.value));
        break;
      case "binary":
      case "distinct-from":
        safe = visit(current.left) && visit(current.right);
        break;
      case "boolean":
        safe = current.expressions.every(visit);
        break;
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-real":
      case "cast-text":
        safe = visit(current.expression);
        break;
      case "text-position":
        safe = visit(current.text) && visit(current.needle);
        break;
      case "text-substring":
        safe =
          visit(current.text) &&
          visit(current.start) &&
          (current.length === undefined || visit(current.length));
        break;
      case "text-like":
        safe =
          visit(current.text) &&
          visit(current.pattern) &&
          (current.escape === undefined ||
            (typeof current.escape === "string" &&
              Array.from(current.escape).length === 1));
        break;
      case "in-list":
        safe = visit(current.expression) && current.values.every(safeBinding);
        break;
      case "function":
        safe =
          current.name !== "abs" &&
          TOTAL_FUNCTIONS.has(current.name) &&
          current.arguments.every(visit);
        break;
      case "coalesce":
        safe = current.expressions.every(visit);
        break;
      case "case":
        safe =
          current.branches.length > 0 &&
          current.branches.every(
            ({ when, then }) => visit(when) && visit(then),
          ) &&
          (current.else === undefined || visit(current.else));
        break;
      case "aggregate":
      case "excluded":
      case "in-subquery":
      case "scalar-subquery":
      case "unixepoch":
        safe = false;
        break;
      default: {
        // Fail closed: an expression kind this analysis does not know about
        // must never be treated as safe to materialize.
        const exhaustive: never = current;
        void exhaustive;
        safe = false;
      }
    }
    active.delete(current);
    return safe;
  };
  return visit(expression);
}

function safeLimit(
  node: Extract<LogicalQueryNode, { kind: "limit" }>,
): boolean {
  if (node.offset !== undefined) return false;
  if (node.count.kind !== "constant" && node.count.kind !== "parameter")
    return false;
  const value = node.count.value;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function totalLocal(expression: SqlExpression, source: QuerySource): boolean {
  const scope = source.scope;
  const fieldCount = source.fields.length;
  // Direct projections do not need a recursive-expression traversal. Keep
  // reading the scope and bounds on every proof; this is not a node cache.
  if (
    expression !== null &&
    typeof expression === "object" &&
    expression.kind === "column"
  )
    return (
      expression.scope === scope &&
      Number.isInteger(expression.index) &&
      expression.index >= 0 &&
      expression.index < fieldCount
    );
  return isMaterializationSafeExpression(
    expression,
    new Map([[scope, fieldCount]]),
  );
}

function totalJoinCondition(
  expression: SqlExpression,
  left: QuerySource,
  right: QuerySource,
): boolean {
  return isMaterializationSafeExpression(
    expression,
    new Map([
      [left.scope, left.fields.length],
      [right.scope, right.fields.length],
    ]),
  );
}

function boundedCountGroupInput(source: QuerySource): boolean {
  return source.node.kind === "limit" && safeLimit(source.node);
}

function countPartitionColumn(
  source: QuerySource,
  index: number,
  seen = new Map<LogicalQueryNode, Set<number>>(),
): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= source.fields.length)
    return false;
  let indexes = seen.get(source.node);
  if (!indexes) {
    indexes = new Set();
    seen.set(source.node, indexes);
  }
  if (indexes.has(index)) return false;
  indexes.add(index);
  const node = source.node;
  switch (node.kind) {
    case "project": {
      const expression = node.projections[index]?.expression;
      return (
        expression?.kind === "column" &&
        expression.scope === node.input.scope &&
        countPartitionColumn(node.input, expression.index, seen)
      );
    }
    case "filter":
    case "sort":
    case "limit":
    case "distinct":
      return countPartitionColumn(node.input, index, seen);
    case "window":
      return (
        index < node.input.fields.length &&
        countPartitionColumn(node.input, index, seen)
      );
    case "semi-join":
    case "anti-join":
      return countPartitionColumn(node.left, index, seen);
    case "aggregate": {
      if (index < node.groups.length || node.groups.length === 0) return false;
      const aggregate = node.aggregates[index - node.groups.length]?.expression;
      return (
        aggregate?.kind === "aggregate" &&
        boundedCountGroupInput(node.input) &&
        (aggregate.name === "COUNT" ||
          (aggregate.name === "SUM" &&
            aggregate.expression !== undefined &&
            unitBoundedNumericExpression(aggregate.expression, node.input)))
      );
    }
    case "scan":
    case "values-relation":
    case "json-scalar-array":
    case "join":
    case "union":
    case "recursive-closure":
      return false;
  }
}

function unitBoundedNumericExpression(
  expression: SqlExpression,
  input: QuerySource,
  active = new Map<LogicalQueryNode, Set<number>>(),
): boolean {
  if (!totalLocal(expression, input)) return false;
  switch (expression.kind) {
    case "constant":
    case "parameter":
      return (
        expression.value === null ||
        typeof expression.value === "boolean" ||
        (typeof expression.value === "number" &&
          Number.isSafeInteger(expression.value) &&
          expression.value >= -1 &&
          expression.value <= 1)
      );
    case "column":
      return (
        expression.scope === input.scope &&
        unitBoundedNumericField(input, expression.index, active)
      );
    case "binary":
      return (
        ["=", "<>", ">", ">=", "<", "<="].includes(expression.operator) &&
        totalLocal(expression.left, input) &&
        totalLocal(expression.right, input)
      );
    case "distinct-from":
    case "boolean":
    case "not":
    case "null-check":
    case "in-list":
    case "text-like":
      return true;
    case "cast-integer":
      return unitBoundedNumericExpression(expression.expression, input, active);
    case "coalesce":
      return expression.expressions.every((child) =>
        unitBoundedNumericExpression(child, input, active),
      );
    case "case":
      return (
        expression.branches.length > 0 &&
        expression.branches.every(
          ({ when, then }) =>
            totalLocal(when, input) &&
            unitBoundedNumericExpression(then, input, active),
        ) &&
        (expression.else === undefined ||
          unitBoundedNumericExpression(expression.else, input, active))
      );
    case "cast-real":
    case "cast-text":
    case "text-position":
    case "text-substring":
    case "function":
    case "aggregate":
    case "excluded":
    case "in-subquery":
    case "scalar-subquery":
    case "unixepoch":
      return false;
  }
}

function unitBoundedNumericField(
  source: QuerySource,
  index: number,
  active = new Map<LogicalQueryNode, Set<number>>(),
): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= source.fields.length)
    return false;
  let indexes = active.get(source.node);
  if (!indexes) {
    indexes = new Set();
    active.set(source.node, indexes);
  }
  if (indexes.has(index)) return false;
  indexes.add(index);
  const node = source.node;
  let safe: boolean;
  switch (node.kind) {
    case "project":
      safe = unitBoundedNumericExpression(
        node.projections[index]!.expression,
        node.input,
        active,
      );
      break;
    case "filter":
    case "sort":
    case "limit":
    case "distinct":
      safe = unitBoundedNumericField(node.input, index, active);
      break;
    case "window":
      safe =
        index < node.input.fields.length &&
        unitBoundedNumericField(node.input, index, active);
      break;
    case "join":
      safe =
        index < node.left.fields.length
          ? unitBoundedNumericField(node.left, index, active)
          : unitBoundedNumericField(
              node.right,
              index - node.left.fields.length,
              active,
            );
      break;
    case "semi-join":
    case "anti-join":
      safe = unitBoundedNumericField(node.left, index, active);
      break;
    case "union":
      safe =
        node.all &&
        unitBoundedNumericField(node.left, index, active) &&
        unitBoundedNumericField(node.right, index, active);
      break;
    case "aggregate": {
      if (index < node.groups.length) {
        safe = unitBoundedNumericExpression(
          node.groups[index]!.expression,
          node.input,
          active,
        );
        break;
      }
      const aggregate = node.aggregates[index - node.groups.length]?.expression;
      safe =
        boundedCountGroupInput(node.input) &&
        aggregate?.kind === "aggregate" &&
        (aggregate.name === "COUNT" ||
          (aggregate.name === "SUM" &&
            aggregate.expression !== undefined &&
            unitBoundedNumericExpression(
              aggregate.expression,
              node.input,
              active,
            )));
      break;
    }
    case "json-scalar-array":
      safe =
        node.valueKind === "numeric" &&
        node.values.every(
          (value) =>
            typeof value === "number" &&
            Number.isSafeInteger(value) &&
            value >= -1 &&
            value <= 1,
        );
      break;
    case "scan":
    case "values-relation":
    case "recursive-closure":
      safe = false;
      break;
  }
  indexes.delete(index);
  return safe;
}

function realValueField(
  source: QuerySource,
  index: number,
  seen = new Map<LogicalQueryNode, Set<number>>(),
): boolean {
  if (!Number.isInteger(index) || index < 0 || index >= source.fields.length)
    return false;
  let indexes = seen.get(source.node);
  if (!indexes) {
    indexes = new Set();
    seen.set(source.node, indexes);
  }
  if (indexes.has(index)) return false;
  indexes.add(index);
  const node = source.node;
  switch (node.kind) {
    case "scan":
      return (
        node.table.kind === "table" && node.fields[index]?.affinity === "real"
      );
    case "project":
      return realValueExpression(
        node.projections[index]!.expression,
        node.input,
      );
    case "filter":
    case "sort":
    case "limit":
    case "distinct":
      return realValueField(node.input, index, seen);
    case "window":
      return (
        index < node.input.fields.length &&
        realValueField(node.input, index, seen)
      );
    case "join":
      return index < node.left.fields.length
        ? realValueField(node.left, index, seen)
        : realValueField(node.right, index - node.left.fields.length, seen);
    case "semi-join":
    case "anti-join":
      return realValueField(node.left, index, seen);
    case "union":
      return (
        realValueField(node.left, index, seen) &&
        realValueField(node.right, index, seen)
      );
    case "aggregate":
      if (index < node.groups.length)
        return realValueExpression(node.groups[index]!.expression, node.input);
      return realAggregateOutput(
        node.aggregates[index - node.groups.length]!.expression,
        node.input,
      );
    case "values-relation":
    case "json-scalar-array":
    case "recursive-closure":
      return false;
  }
}

function realValueExpression(
  expression: SqlExpression,
  input: QuerySource,
): boolean {
  if (!totalLocal(expression, input)) return false;
  switch (expression.kind) {
    case "cast-real":
      return true;
    case "column":
      return (
        expression.scope === input.scope &&
        realValueField(input, expression.index)
      );
    case "function":
      return (
        expression.name === "round" &&
        realValueExpression(expression.arguments[0]!, input)
      );
    case "coalesce":
      return expression.expressions.every((child) =>
        realValueExpression(child, input),
      );
    case "case":
      return (
        expression.branches.every(({ then }) =>
          realValueExpression(then, input),
        ) &&
        expression.else !== undefined &&
        realValueExpression(expression.else, input)
      );
    case "binary":
      return (
        ["+", "-", "*", "/"].includes(expression.operator) &&
        (realValueExpression(expression.left, input) ||
          realValueExpression(expression.right, input))
      );
    default:
      return false;
  }
}

function realAggregateOutput(
  expression: SqlExpression,
  input: QuerySource,
): boolean {
  if (expression.kind !== "aggregate" || !expression.expression) return false;
  if (expression.name === "MIN" || expression.name === "MAX")
    return realValueExpression(expression.expression, input);
  if (expression.name === "SUM" || expression.name === "AVG")
    return realValueExpression(expression.expression, input);
  return false;
}

export function isMaterializationSafeAggregateExpression(
  expression: SqlExpression,
  input: QuerySource,
): boolean {
  if (expression.kind !== "aggregate") return false;
  if (expression.name === "COUNT")
    return (
      expression.expression === undefined ||
      totalLocal(expression.expression, input)
    );
  if (!expression.expression || !totalLocal(expression.expression, input))
    return false;
  if (expression.name === "MIN" || expression.name === "MAX") return true;
  return (
    realValueExpression(expression.expression, input) ||
    (expression.name === "SUM" &&
      boundedCountGroupInput(input) &&
      unitBoundedNumericExpression(expression.expression, input)) ||
    (expression.name === "SUM" &&
      hasSafeBoundedUnitSumInput(expression, input)) ||
    (expression.name === "SUM" &&
      expression.expression.kind === "column" &&
      expression.expression.scope === input.scope &&
      countPartitionColumn(input, expression.expression.index))
  );
}

/** Totality alone does not make floating aggregation or integer cancellation
 * independent of input order. Keep this proof separate from reuse totality. */
export function isOrderStableSumExpression(
  expression: SqlExpression,
  input: QuerySource,
): boolean {
  if (expression.kind !== "aggregate") return false;
  if (
    expression.name !== "SUM" ||
    !expression.expression ||
    !totalLocal(expression.expression, input)
  )
    return false;
  return (
    (boundedCountGroupInput(input) &&
      unitBoundedNumericExpression(expression.expression, input)) ||
    hasSafeBoundedUnitSumInput(expression, input) ||
    (expression.expression.kind === "column" &&
      expression.expression.scope === input.scope &&
      countPartitionColumn(input, expression.expression.index))
  );
}

export function isMaterializationSafeNode(node: LogicalQueryNode): boolean {
  switch (node.kind) {
    case "scan":
    case "values-relation":
    case "json-scalar-array":
    case "distinct":
    case "union":
      return true;
    case "filter":
      return totalLocal(node.predicate, node.input);
    case "project":
      return node.projections.every(({ expression }) =>
        totalLocal(expression, node.input),
      );
    case "join":
    case "semi-join":
    case "anti-join":
      return totalJoinCondition(node.condition, node.left, node.right);
    case "aggregate":
      return (
        node.groups.every(({ expression }) =>
          totalLocal(expression, node.input),
        ) &&
        node.aggregates.every(({ expression }) =>
          isMaterializationSafeAggregateExpression(expression, node.input),
        )
      );
    case "sort":
      return (
        node.keys.length > 0 &&
        node.keys.every(
          ({ expression, direction }) =>
            (direction === "ASC" || direction === "DESC") &&
            totalLocal(expression, node.input),
        )
      );
    case "window":
      return safeRowNumberWindow(node);
    case "limit":
      return safeLimit(node);
    case "recursive-closure":
      return false;
  }
}

export interface TotalMaterializationSubtreeOptions {
  readonly allowUnionAll?: boolean;
  readonly expressionQueryEdges?: ReadonlySet<LogicalQueryNode>;
}

export type TotalMaterializationSubtreeResult =
  | { readonly safe: true }
  | {
      readonly safe: false;
      readonly blocker: LogicalQueryNode;
      readonly reason: string;
    };

/**
 * Recheck a full relation subtree for closed, total expressions and forbidden
 * evaluation barriers. Trusted grouped-summary anchors retain their existing
 * independently validated proof; every other input branch is visited.
 */
export function inspectTotalMaterializationSubtree(
  root: LogicalQueryNode,
  trustedBoundedGroups: ReadonlySet<LogicalQueryNode>,
  options: TotalMaterializationSubtreeOptions = {},
): TotalMaterializationSubtreeResult {
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  const allowUnionAll = options.allowUnionAll !== false;
  const visit = (node: LogicalQueryNode): TotalMaterializationSubtreeResult => {
    if (trustedBoundedGroups.has(node) || visited.has(node))
      return { safe: true };
    if (active.has(node))
      return { safe: false, blocker: node, reason: "relation-cycle" };
    if (options.expressionQueryEdges?.has(node))
      return { safe: false, blocker: node, reason: "expression-query-edge" };
    if (!isMaterializationSafeNode(node))
      return { safe: false, blocker: node, reason: "unsafe-local-expression" };

    active.add(node);
    let result: TotalMaterializationSubtreeResult = { safe: true };
    const check = (child: QuerySource): TotalMaterializationSubtreeResult =>
      visit(child.node);
    switch (node.kind) {
      case "sort":
        result = { safe: false, blocker: node, reason: "sort-barrier" };
        break;
      case "limit":
        result = { safe: false, blocker: node, reason: "limit-barrier" };
        break;
      case "window":
        result = { safe: false, blocker: node, reason: "window-barrier" };
        break;
      case "recursive-closure":
        result = {
          safe: false,
          blocker: node,
          reason: "recursive-closure-barrier",
        };
        break;
      case "scan":
      case "values-relation":
      case "json-scalar-array":
        break;
      case "filter":
      case "project":
      case "aggregate":
      case "distinct":
        result = check(node.input);
        break;
      case "join":
      case "semi-join":
      case "anti-join": {
        result = check(node.left);
        if (result.safe) result = check(node.right);
        break;
      }
      case "union":
        if (!allowUnionAll) {
          result = { safe: false, blocker: node, reason: "union-forbidden" };
          break;
        }
        if (!node.all) {
          result = {
            safe: false,
            blocker: node,
            reason: "distinct-union-barrier",
          };
          break;
        }
        result = check(node.left);
        if (result.safe) result = check(node.right);
        break;
    }
    active.delete(node);
    if (result.safe) visited.add(node);
    return result;
  };
  return visit(root);
}

export function isTotalMaterializationSubtree(
  root: LogicalQueryNode,
  trustedBoundedGroups: ReadonlySet<LogicalQueryNode>,
  options: TotalMaterializationSubtreeOptions = {},
): boolean {
  return inspectTotalMaterializationSubtree(root, trustedBoundedGroups, options)
    .safe;
}

function uniqueFieldSets(
  source: QuerySource,
  active = new Set<LogicalQueryNode>(),
): readonly (readonly number[])[] {
  if (active.has(source.node)) return [];
  active.add(source.node);
  const node = source.node;
  let result: readonly (readonly number[])[];
  switch (node.kind) {
    case "scan": {
      if (node.table.kind !== "table" || node.table.primaryKey.length === 0)
        result = [];
      else {
        const columns = Object.values(node.table.columns);
        const keyColumns = node.table.primaryKey.map((primaryKey) =>
          columns.find(
            (column) =>
              column.sqlName === primaryKey ||
              column.propertyName === primaryKey,
          ),
        );
        result = keyColumns.every(
          (column) => column !== undefined && !column.nullable,
        )
          ? [keyColumns.map((column) => columns.indexOf(column!))]
          : [];
      }
      break;
    }
    case "values-relation": {
      const rows = node.rows.map((row) => JSON.stringify(row));
      if (new Set(rows).size !== rows.length) result = [];
      else
        result =
          rows.length <= 1
            ? [[]]
            : [
                Array.from(
                  { length: node.fields.length },
                  (_value, index) => index,
                ),
              ];
      break;
    }
    case "aggregate":
      result = [
        Array.from({ length: node.groups.length }, (_value, index) => index),
      ];
      break;
    case "distinct":
      result = [
        Array.from({ length: node.fields.length }, (_value, index) => index),
      ];
      break;
    case "filter":
    case "sort":
    case "limit":
      result = uniqueFieldSets(node.input, active);
      break;
    case "project": {
      const output = node.projections;
      const projectedKeys = uniqueFieldSets(node.input, active);
      result = projectedKeys.flatMap((key) => {
        if (key.length === 0) return [[]];
        const mapped = key.map((inputIndex) =>
          output.findIndex(
            ({ expression }) =>
              expression.kind === "column" &&
              expression.scope === node.input.scope &&
              expression.index === inputIndex,
          ),
        );
        return mapped.every((index) => index >= 0) ? [mapped] : [];
      });
      break;
    }
    case "semi-join":
    case "anti-join":
      result = uniqueFieldSets(node.left, active);
      break;
    case "window":
      result = uniqueFieldSets(node.input, active);
      break;
    case "union":
      // SQLite comparison/coercion can make distinct JavaScript constants
      // compare equal, so a branch tag alone is not a proven unique key.
      result = [];
      break;
    case "json-scalar-array":
    case "join":
    case "recursive-closure":
      result = [];
      break;
  }
  active.delete(source.node);
  return result;
}

function safeRowNumberWindow(
  node: Extract<LogicalQueryNode, { kind: "window" }>,
  includePartitionColumns = false,
): boolean {
  if (node.windows.length === 0) return false;
  const uniqueKeys = uniqueFieldSets(node.input);
  if (uniqueKeys.length === 0) return false;
  return node.windows.every(({ specification }) => {
    if (
      specification.kind !== "row-number" ||
      specification.orderBy.length === 0 ||
      !specification.partitionBy.every((expression) =>
        totalLocal(expression, node.input),
      )
    )
      return false;
    const orderedColumns = new Set<number>();
    if (includePartitionColumns)
      for (const expression of specification.partitionBy) {
        if (
          expression.kind === "column" &&
          expression.scope === node.input.scope &&
          expression.index < node.input.fields.length
        )
          orderedColumns.add(expression.index);
      }
    for (const { expression, direction } of specification.orderBy) {
      if (
        (direction !== "ASC" && direction !== "DESC") ||
        !totalLocal(expression, node.input)
      )
        return false;
      if (
        expression.kind === "column" &&
        expression.scope === node.input.scope &&
        expression.index < node.input.fields.length
      )
        orderedColumns.add(expression.index);
    }
    return uniqueKeys.some((key) =>
      key.every((index) => orderedColumns.has(index)),
    );
  });
}

function safeProvenPartitionedRowNumberWindow(
  node: Extract<LogicalQueryNode, { kind: "window" }>,
): boolean {
  return (
    node.windows.length > 0 &&
    node.windows.every(
      ({ specification }) =>
        specification.kind === "row-number" &&
        specification.orderBy.length > 0 &&
        specification.partitionBy.every((expression) =>
          totalLocal(expression, node.input),
        ) &&
        specification.orderBy.every(
          ({ expression, direction }) =>
            (direction === "ASC" || direction === "DESC") &&
            totalLocal(expression, node.input),
        ) &&
        hasStableRowNumberOrdering(node.input, specification),
    )
  );
}

/**
 * The legacy partition-aware rule only sees the existing narrow field-key
 * summary. Keep it on its original contract for correlated-existence users.
 */
export function isMaterializationSafePartitionedRowNumberWindow(
  node: LogicalQueryNode,
): boolean {
  return node.kind === "window" && safeRowNumberWindow(node, true);
}

/** Use the fresh relational-key proof only on explicitly authorized paths. */
export function isMaterializationSafeProvenPartitionedRowNumberWindow(
  node: LogicalQueryNode,
): boolean {
  return node.kind === "window" && safeProvenPartitionedRowNumberWindow(node);
}

export interface ProvenPartitionedRowNumberWindowAnalysisContext {
  isSafe(node: LogicalQueryNode): boolean;
}

/**
 * Reuse a window's pure logical-graph proof only inside one fresh analysis.
 * Callers must create a new context for each lowering or validation pass.
 */
export function createProvenPartitionedRowNumberWindowAnalysisContext(
  onAnalyze?: (node: Extract<LogicalQueryNode, { kind: "window" }>) => void,
): ProvenPartitionedRowNumberWindowAnalysisContext {
  const results = new WeakMap<LogicalQueryNode, boolean>();
  return {
    isSafe(node) {
      if (node.kind !== "window") return false;
      if (results.has(node)) return results.get(node)!;
      onAnalyze?.(node);
      const result = safeProvenPartitionedRowNumberWindow(node);
      results.set(node, result);
      return result;
    },
  };
}

/**
 * Recompute ordering dependencies from the logical graph. A semi/anti join's
 * right input is membership-only; left and ordinary join inputs remain row
 * data dependencies. Expression edges and selection barriers stay strict.
 */
export function hasSafeMaterializationOrderingAncestors(
  start: LogicalQueryNode,
  incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >,
  expressionQueryEdges: ReadonlySet<LogicalQueryNode>,
  requireOrderingAncestor = false,
): boolean {
  const pending = [start];
  const seen = new Set<LogicalQueryNode>();
  let hasRelevantAncestor = false;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (
      current.kind === "limit" ||
      current.kind === "recursive-closure" ||
      expressionQueryEdges.has(current)
    )
      return false;
    if (current.kind === "sort" || current.kind === "window") {
      hasRelevantAncestor = true;
      if (!isMaterializationSafeNode(current)) return false;
    }
    for (const edge of incoming.get(current) ?? []) {
      if (edge.kind !== "relation") return false;
      const parent = edge.parent;
      const isRightMembershipInput =
        (parent.kind === "semi-join" || parent.kind === "anti-join") &&
        parent.right.node === current &&
        parent.left.node !== current;
      if (isRightMembershipInput) {
        // This relation supplies only EXISTS/NOT EXISTS truth. The operator's
        // output columns and multiplicity still come from its left input, so
        // higher windows are not row-data consumers of this branch.
        hasRelevantAncestor = true;
        continue;
      }
      pending.push(parent);
    }
  }
  return !requireOrderingAncestor || hasRelevantAncestor;
}
