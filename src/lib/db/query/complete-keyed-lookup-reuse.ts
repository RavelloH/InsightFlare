import type {
  AggregateExpression,
  RelationScope,
  SqlExpression,
} from "./expression";
import type {
  AggregateNode,
  FilterNode,
  JoinNode,
  LogicalQueryNode,
  ProjectNode,
  QuerySource,
  RecursiveClosureNode,
} from "./plan";
import { hasOwnedRecursiveClosureScopes } from "./plan";

type EdgeKind = "relation" | "expression";

interface ConsumerEdge {
  readonly parent: LogicalQueryNode;
  readonly kind: EdgeKind;
}

const stableFunctions = new Set([
  "lower",
  "upper",
  "trim",
  "trim-characters",
  "trim-spaces",
  "concat-text",
  "text-contains",
  "text-starts-with",
  "text-ends-with",
  "length",
  "storage-class",
  "abs",
  "round",
]);

function relationChildren(node: LogicalQueryNode): QuerySource[] {
  switch (node.kind) {
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return [];
    case "filter":
    case "project":
    case "aggregate":
    case "distinct":
    case "window":
    case "sort":
    case "limit":
      return [node.input];
    case "recursive-closure":
      return [node.seed, node.candidates];
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return [node.left, node.right];
    default:
      return [];
  }
}

function nodeExpressions(node: LogicalQueryNode): SqlExpression[] {
  switch (node.kind) {
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return [];
    case "filter":
      return [node.predicate];
    case "project":
      return node.projections.map(({ expression }) => expression);
    case "join":
    case "semi-join":
    case "anti-join":
      return [node.condition];
    case "aggregate":
      return [
        ...node.groups.map(({ expression }) => expression),
        ...node.aggregates.map(({ expression }) => expression),
      ];
    case "distinct":
    case "recursive-closure":
      return node.kind === "recursive-closure" ? [node.predicate] : [];
    case "window":
      return node.windows.flatMap(({ specification }) =>
        specification.kind === "row-number"
          ? [
              ...specification.partitionBy,
              ...specification.orderBy.map(({ expression }) => expression),
            ]
          : specification.partitionBy,
      );
    case "sort":
      return node.keys.map(({ expression }) => expression);
    case "limit":
      return [node.count, ...(node.offset ? [node.offset] : [])];
    case "union":
      return [];
    default:
      return [];
  }
}

function expressionChildren(expression: SqlExpression): SqlExpression[] {
  switch (expression.kind) {
    case "binary":
    case "distinct-from":
      return [expression.left, expression.right];
    case "boolean":
      return [...expression.expressions];
    case "not":
    case "null-check":
    case "in-list":
    case "cast-integer":
    case "cast-real":
    case "cast-text":
      return [expression.expression];
    case "text-position":
      return [expression.text, expression.needle];
    case "text-substring":
      return [
        expression.text,
        expression.start,
        ...(expression.length ? [expression.length] : []),
      ];
    case "text-like":
      return [expression.text, expression.pattern];
    case "in-subquery":
      return [expression.expression];
    case "function":
      return [...expression.arguments];
    case "aggregate":
      return expression.expression ? [expression.expression] : [];
    case "coalesce":
      return [...expression.expressions];
    case "case":
      return [
        ...expression.branches.flatMap(({ when, then }) => [when, then]),
        ...(expression.else ? [expression.else] : []),
      ];
    case "column":
    case "parameter":
    case "excluded":
    case "unixepoch":
    case "constant":
    case "scalar-subquery":
      return [];
    default:
      return [];
  }
}

function expressionSources(expression: SqlExpression): QuerySource[] {
  const sources: QuerySource[] = [];
  const active = new WeakSet<object>();
  const visit = (current: SqlExpression): void => {
    if (active.has(current)) return;
    active.add(current);
    if (current.kind === "scalar-subquery") sources.push(current.query);
    else if (current.kind === "in-subquery") sources.push(current.query);
    for (const child of expressionChildren(current)) visit(child);
    active.delete(current);
  };
  visit(expression);
  return sources;
}

function nodeSources(node: LogicalQueryNode): QuerySource[] {
  return [
    ...relationChildren(node),
    ...nodeExpressions(node).flatMap(expressionSources),
  ];
}

/** ABS(INT64_MIN) raises in SQLite and can become observable when a closed
 * membership subtree is evaluated earlier by materialization. Keep that
 * subtree out of eager reuse while leaving legacy no-membership proofs alone. */
function membershipSubtreeHasThrowingFunction(root: LogicalQueryNode): boolean {
  const active = new Set<LogicalQueryNode>();
  const visited = new Set<LogicalQueryNode>();
  let containsMembership = false;
  let containsThrowingFunction = false;
  const activeExpressions = new WeakSet<object>();
  const inspectExpression = (expression: SqlExpression): void => {
    if (activeExpressions.has(expression)) return;
    activeExpressions.add(expression);
    if (expression.kind === "function" && expression.name === "abs")
      containsThrowingFunction = true;
    for (const child of expressionChildren(expression))
      inspectExpression(child);
    activeExpressions.delete(expression);
  };
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node) || active.has(node)) return;
    active.add(node);
    if (node.kind === "semi-join" || node.kind === "anti-join")
      containsMembership = true;
    for (const expression of nodeExpressions(node))
      inspectExpression(expression);
    for (const source of nodeSources(node)) visit(source.node);
    active.delete(node);
    visited.add(node);
  };
  visit(root);
  return containsMembership && containsThrowingFunction;
}

function expressionIsStableAndLocal(
  expression: SqlExpression,
  scopes: ReadonlyMap<RelationScope, number>,
): boolean {
  const active = new WeakSet<object>();
  const visit = (current: SqlExpression): boolean => {
    if (active.has(current)) return false;
    active.add(current);
    let valid: boolean;
    switch (current.kind) {
      case "column": {
        const fieldCount = scopes.get(current.scope);
        valid =
          fieldCount !== undefined &&
          Number.isInteger(current.index) &&
          current.index >= 0 &&
          current.index < fieldCount;
        break;
      }
      case "parameter":
        valid =
          current.value === null ||
          typeof current.value === "string" ||
          typeof current.value === "boolean" ||
          (typeof current.value === "number" && Number.isFinite(current.value));
        break;
      case "constant":
        valid =
          current.value === null ||
          typeof current.value === "string" ||
          (typeof current.value === "number" && Number.isFinite(current.value));
        break;
      case "function":
        valid =
          stableFunctions.has(current.name) && current.arguments.every(visit);
        break;
      case "boolean":
        valid =
          (current.operator === "AND" || current.operator === "OR") &&
          current.expressions.length > 0 &&
          current.expressions.every(visit);
        break;
      case "in-list":
        valid =
          current.values.every(
            (value) =>
              value === null ||
              typeof value === "string" ||
              typeof value === "boolean" ||
              (typeof value === "number" && Number.isFinite(value)),
          ) && visit(current.expression);
        break;
      case "binary":
      case "distinct-from":
        valid = visit(current.left) && visit(current.right);
        break;
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-real":
      case "cast-text":
        valid = visit(current.expression);
        break;
      case "text-position":
        valid = visit(current.text) && visit(current.needle);
        break;
      case "text-substring":
        valid =
          visit(current.text) &&
          visit(current.start) &&
          (!current.length || visit(current.length));
        break;
      case "text-like":
        valid = visit(current.text) && visit(current.pattern);
        break;
      case "coalesce":
        valid =
          current.expressions.length >= 2 && current.expressions.every(visit);
        break;
      case "case":
        valid =
          current.branches.length > 0 &&
          current.branches.every(
            ({ when, then }) => visit(when) && visit(then),
          ) &&
          (!current.else || visit(current.else));
        break;
      case "aggregate":
      case "scalar-subquery":
      case "in-subquery":
      case "unixepoch":
      case "excluded":
        valid = false;
        break;
    }
    active.delete(current);
    return valid;
  };
  return visit(expression);
}

function scopedFields(source: QuerySource): ReadonlyMap<RelationScope, number> {
  return new Map([[source.scope, source.fields.length]]);
}

function isZeroOrOneLiteral(expression: SqlExpression): boolean {
  return (
    (expression.kind === "parameter" || expression.kind === "constant") &&
    (expression.value === 0 || expression.value === 1)
  );
}

function isIntegerControlExpression(expression: SqlExpression): boolean {
  if (isZeroOrOneLiteral(expression)) return true;
  if (expression.kind === "cast-integer")
    return isIntegerControlExpression(expression.expression);
  if (expression.kind === "coalesce")
    return expression.expressions.every(isIntegerControlExpression);
  return (
    expression.kind === "case" &&
    expression.branches.length > 0 &&
    expression.branches.every(({ then }) => isZeroOrOneLiteral(then)) &&
    (!expression.else || isZeroOrOneLiteral(expression.else))
  );
}

function aggregateExpressionIsSafe(
  expression: SqlExpression,
  input: QuerySource,
): expression is AggregateExpression {
  if (expression.kind !== "aggregate") return false;
  if (
    expression.distinct !== undefined &&
    typeof expression.distinct !== "boolean"
  )
    return false;
  if (expression.name === "COUNT")
    return (
      expression.expression === undefined ||
      expressionIsStableAndLocal(expression.expression, scopedFields(input))
    );
  if (expression.name === "MIN" || expression.name === "MAX")
    return (
      expression.expression !== undefined &&
      expressionIsStableAndLocal(expression.expression, scopedFields(input))
    );
  if (expression.name === "SUM")
    return (
      expression.expression !== undefined &&
      isIntegerControlExpression(expression.expression) &&
      expressionIsStableAndLocal(expression.expression, scopedFields(input))
    );
  return false;
}

function aggregateNodeIsSafe(
  node: AggregateNode,
  requireGroups: boolean,
  enforceMaximumWidth = false,
  requireKeyedRootAggregateWhitelist = false,
): boolean {
  if (
    (requireGroups && node.groups.length === 0) ||
    node.fields.length === 0 ||
    (enforceMaximumWidth && node.fields.length > 16) ||
    node.fields.length !== node.groups.length + node.aggregates.length
  )
    return false;
  const scopes = scopedFields(node.input);
  return (
    node.groups.every(({ expression }) =>
      expressionIsStableAndLocal(expression, scopes),
    ) &&
    node.aggregates.every(
      ({ expression }) =>
        (!requireKeyedRootAggregateWhitelist ||
          (expression.kind === "aggregate" &&
            ["COUNT", "MIN", "MAX"].includes(expression.name))) &&
        aggregateExpressionIsSafe(expression, node.input),
    )
  );
}

function sameFields(
  left: QuerySource["fields"],
  right: QuerySource["fields"],
  requireKnownAffinity = false,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (field, index) =>
        field.name === right[index]?.name &&
        field.affinity === right[index]?.affinity &&
        (!requireKnownAffinity || field.affinity !== "unknown"),
    )
  );
}

function outputMatchesUnionFields(
  output: QuerySource["fields"],
  left: QuerySource["fields"],
  right: QuerySource["fields"],
): boolean {
  return (
    sameFields(output, left) &&
    sameFields(output, right) &&
    output.every(
      (field, index) =>
        field.nullable === (left[index]!.nullable || right[index]!.nullable),
    )
  );
}

function recursiveClosureIsSafe(node: RecursiveClosureNode): boolean {
  return (
    hasOwnedRecursiveClosureScopes(node) &&
    node.fields.length > 0 &&
    sameFields(node.seed.fields, node.candidates.fields, true) &&
    sameFields(node.fields, node.seed.fields, true) &&
    node.fields.every(
      (field, index) =>
        field.nullable ===
        (node.seed.fields[index]!.nullable ||
          node.candidates.fields[index]!.nullable),
    ) &&
    expressionIsStableAndLocal(
      node.predicate,
      new Map([
        [node.currentScope, node.fields.length],
        [node.candidateScope, node.fields.length],
      ]),
    )
  );
}

export interface ClosedStableSubtreeEvidence {
  readonly containsRecursiveClosure: boolean;
}

export interface ClosedStableSubtreeOptions {
  /** Exact COUNT(*) counters over an independently licensed bounded input. */
  readonly admissionCounters?: ReadonlyMap<LogicalQueryNode, LogicalQueryNode>;
  /** Local fact reuse may retain its proven integer 0/1 CASE control SUM. */
  readonly allowRootControlledSum?: boolean;
}

function sameOutputSchemaExactly(
  left: QuerySource["fields"],
  right: QuerySource["fields"],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (field, index) =>
        field.name === right[index]?.name &&
        field.affinity === right[index]?.affinity &&
        field.nullable === right[index]?.nullable,
    )
  );
}

function exactCountStarOver(
  node: LogicalQueryNode,
  bounded: LogicalQueryNode,
): node is AggregateNode {
  if (
    node.kind !== "aggregate" ||
    node.input.node !== bounded ||
    bounded.kind !== "limit" ||
    bounded.offset !== undefined ||
    !isSafeBoundedAdmissionLimit(bounded) ||
    node.groups.length !== 0 ||
    node.aggregates.length !== 1 ||
    node.fields.length !== 1 ||
    node.fields[0]?.affinity !== "integer" ||
    node.fields[0]?.nullable !== false ||
    !sameOutputSchemaExactly(node.input.fields, bounded.fields)
  )
    return false;
  const expression = node.aggregates[0]!.expression;
  return (
    expression.kind === "aggregate" &&
    expression.name === "COUNT" &&
    expression.expression === undefined &&
    expression.distinct !== true &&
    expression.resultType.affinity === "integer" &&
    expression.resultType.nullable === false
  );
}

/** Prove a closed, stable subtree, optionally treating independently proven
 * bounded admission roots as leaves whose complete input proof is supplied. */
export function inspectClosedStableSubtree(
  root: LogicalQueryNode,
  boundedAdmissionLeaves: ReadonlyMap<
    LogicalQueryNode,
    ClosedStableSubtreeEvidence
  > = new Map(),
  options: ClosedStableSubtreeOptions = {},
): ClosedStableSubtreeEvidence | undefined {
  if (membershipSubtreeHasThrowingFunction(root)) return undefined;
  const active = new Set<LogicalQueryNode>();
  const visited = new Set<LogicalQueryNode>();
  let valid = true;
  let sawRecursiveClosure = false;
  const visit = (node: LogicalQueryNode): void => {
    if (!valid) return;
    if (active.has(node)) {
      valid = false;
      return;
    }
    if (visited.has(node)) return;
    active.add(node);
    const boundedCounterInput = options.admissionCounters?.get(node);
    if (boundedCounterInput !== undefined) {
      const counterValid =
        boundedAdmissionLeaves.has(boundedCounterInput) &&
        exactCountStarOver(node, boundedCounterInput);
      if (!counterValid) valid = false;
      else {
        const evidence = boundedAdmissionLeaves.get(boundedCounterInput)!;
        sawRecursiveClosure ||= evidence.containsRecursiveClosure;
      }
      active.delete(node);
      visited.add(node);
      return;
    }
    const boundedEvidence = boundedAdmissionLeaves.get(node);
    if (boundedEvidence !== undefined) {
      if (
        node.kind !== "limit" ||
        node.offset !== undefined ||
        !isSafeBoundedAdmissionLimit(node)
      )
        valid = false;
      else sawRecursiveClosure ||= boundedEvidence.containsRecursiveClosure;
      active.delete(node);
      visited.add(node);
      return;
    }
    switch (node.kind) {
      case "scan":
        break;
      case "project":
        if (
          !node.projections.every(({ expression }) =>
            expressionIsStableAndLocal(expression, scopedFields(node.input)),
          )
        ) {
          valid = false;
        }
        break;
      case "filter":
        if (
          !expressionIsStableAndLocal(node.predicate, scopedFields(node.input))
        ) {
          valid = false;
        }
        break;
      case "join":
        if (
          (node.joinType !== "inner" && node.joinType !== "left") ||
          !expressionIsStableAndLocal(
            node.condition,
            new Map([
              [node.left.scope, node.left.fields.length],
              [node.right.scope, node.right.fields.length],
            ]),
          )
        ) {
          valid = false;
        }
        break;
      case "semi-join":
      case "anti-join":
        if (
          !sameOutputSchemaExactly(node.fields, node.left.fields) ||
          !expressionIsStableAndLocal(
            node.condition,
            new Map([
              [node.left.scope, node.left.fields.length],
              [node.right.scope, node.right.fields.length],
            ]),
          )
        )
          valid = false;
        break;
      case "aggregate":
        if (
          !aggregateNodeIsSafe(
            node,
            node === root,
            false,
            node === root && options.allowRootControlledSum !== true,
          )
        )
          valid = false;
        break;
      case "recursive-closure":
        sawRecursiveClosure = true;
        if (!recursiveClosureIsSafe(node)) valid = false;
        break;
      case "union":
        if (
          !node.all ||
          !outputMatchesUnionFields(
            node.fields,
            node.left.fields,
            node.right.fields,
          )
        ) {
          valid = false;
        }
        break;
      case "values-relation":
      case "json-scalar-array":
      case "distinct":
      case "window":
      case "sort":
      case "limit":
        valid = false;
        break;
      default:
        valid = false;
        break;
    }
    for (const source of nodeSources(node)) visit(source.node);
    active.delete(node);
    visited.add(node);
  };
  visit(root);
  return valid ? { containsRecursiveClosure: sawRecursiveClosure } : undefined;
}

function closedStableSubtree(
  root: AggregateNode,
  boundedAdmissionLeaves: ReadonlyMap<
    LogicalQueryNode,
    ClosedStableSubtreeEvidence
  > = new Map(),
  options: ClosedStableSubtreeOptions = {},
): boolean {
  return (
    inspectClosedStableSubtree(root, boundedAdmissionLeaves, options)
      ?.containsRecursiveClosure === true
  );
}

function pureProject(
  node: LogicalQueryNode,
  child: LogicalQueryNode,
): node is ProjectNode {
  return (
    node.kind === "project" &&
    node.input.node === child &&
    node.projections.every(({ expression }) =>
      expressionIsStableAndLocal(expression, scopedFields(node.input)),
    )
  );
}

function stableFilter(
  node: LogicalQueryNode,
  child: LogicalQueryNode,
): node is FilterNode {
  return (
    node.kind === "filter" &&
    node.input.node === child &&
    expressionIsStableAndLocal(node.predicate, scopedFields(node.input))
  );
}

function equalityPairs(
  expression: SqlExpression,
): readonly (readonly [SqlExpression, SqlExpression])[] | undefined {
  if (
    expression.kind === "boolean" &&
    expression.operator === "AND" &&
    expression.expressions.length > 0
  ) {
    const pairs: (readonly [SqlExpression, SqlExpression])[] = [];
    for (const child of expression.expressions) {
      const nested = equalityPairs(child);
      if (!nested) return undefined;
      pairs.push(...nested);
    }
    return pairs;
  }
  return expression.kind === "binary" && expression.operator === "="
    ? [[expression.left, expression.right]]
    : undefined;
}

function completeLookupJoin(candidate: AggregateNode, join: JoinNode): boolean {
  if (
    join.joinType !== "left" ||
    join.right.node !== candidate ||
    join.left.node === candidate ||
    candidate.groups.length === 0
  )
    return false;
  const pairs = equalityPairs(join.condition);
  if (!pairs || pairs.length !== candidate.groups.length) return false;
  const matchedRight = new Set<number>();
  for (const [first, second] of pairs) {
    const leftColumn =
      first.kind === "column" && first.scope === join.left.scope
        ? first
        : second.kind === "column" && second.scope === join.left.scope
          ? second
          : undefined;
    const rightColumn =
      first.kind === "column" && first.scope === join.right.scope
        ? first
        : second.kind === "column" && second.scope === join.right.scope
          ? second
          : undefined;
    if (
      !leftColumn ||
      !rightColumn ||
      leftColumn.index < 0 ||
      leftColumn.index >= join.left.fields.length ||
      rightColumn.index < 0 ||
      rightColumn.index >= join.right.fields.length ||
      rightColumn.index >= candidate.groups.length ||
      matchedRight.has(rightColumn.index)
    )
      return false;
    const leftField = join.left.fields[leftColumn.index]!;
    const rightField = join.right.fields[rightColumn.index]!;
    if (
      leftField.affinity === "unknown" ||
      leftField.affinity !== rightField.affinity
    )
      return false;
    matchedRight.add(rightColumn.index);
  }
  return matchedRight.size === candidate.groups.length;
}

function isPositiveLiteralLimit(
  node: LogicalQueryNode,
): node is Extract<LogicalQueryNode, { kind: "limit" }> {
  return (
    node.kind === "limit" &&
    node.offset === undefined &&
    node.count.kind === "parameter" &&
    typeof node.count.value === "number" &&
    Number.isSafeInteger(node.count.value) &&
    node.count.value > 0
  );
}

function isSafeBoundedAdmissionLimit(
  node: LogicalQueryNode,
): node is Extract<LogicalQueryNode, { kind: "limit" }> {
  return (
    node.kind === "limit" &&
    node.offset === undefined &&
    (node.count.kind === "parameter" || node.count.kind === "constant") &&
    (node.count.resultType.affinity === "numeric" ||
      node.count.resultType.affinity === "integer") &&
    !node.count.resultType.nullable &&
    typeof node.count.value === "number" &&
    Number.isSafeInteger(node.count.value) &&
    node.count.value > 1
  );
}

function scalarAggregate(node: LogicalQueryNode): boolean {
  return (
    node.kind === "aggregate" &&
    node.groups.length === 0 &&
    aggregatePathNodeIsStable(node)
  );
}

function transparentScalarAggregate(node: LogicalQueryNode): boolean {
  if (node.kind === "project")
    return (
      pureProject(node, node.input.node) &&
      transparentScalarAggregate(node.input.node)
    );
  return (
    node.kind === "aggregate" &&
    node.aggregates.length > 0 &&
    scalarAggregate(node)
  );
}

function alwaysTruePredicate(expression: SqlExpression): boolean {
  if (expression.kind === "constant") return expression.value === 1;
  if (
    expression.kind !== "binary" ||
    expression.operator !== "=" ||
    expression.left.kind !== "constant" ||
    expression.right.kind !== "constant"
  )
    return false;
  const { value: left } = expression.left;
  const { value: right } = expression.right;
  return (
    left !== null &&
    right !== null &&
    (typeof left === "number" || typeof left === "string") &&
    left === right
  );
}

/** A cross join with a transparent scalar aggregate cannot gate or multiply
 * the other input, so it is a safe control-path carrier. */
function crossJoinWithSingleton(
  node: LogicalQueryNode,
  carriedNode?: LogicalQueryNode,
): boolean {
  if (node.kind !== "join" || !carriedNode) return false;
  const opposite =
    node.left.node === carriedNode
      ? node.right.node
      : node.right.node === carriedNode
        ? node.left.node
        : undefined;
  return (
    node.joinType === "inner" &&
    alwaysTruePredicate(node.condition) &&
    opposite !== undefined &&
    transparentScalarAggregate(opposite)
  );
}

function aggregatePathNodeIsStable(node: AggregateNode): boolean {
  const inputScopes = scopedFields(node.input);
  return (
    node.fields.length === node.groups.length + node.aggregates.length &&
    node.groups.every(({ expression }) =>
      expressionIsStableAndLocal(expression, inputScopes),
    ) &&
    node.aggregates.every(({ expression }) => {
      if (
        expression.kind !== "aggregate" ||
        !["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(expression.name) ||
        (expression.distinct !== undefined &&
          typeof expression.distinct !== "boolean")
      )
        return false;
      return (
        expression.expression === undefined ||
        expressionIsStableAndLocal(expression.expression, inputScopes)
      );
    })
  );
}

function rootAncestorPathIsSafe(
  node: LogicalQueryNode,
  path: "control" | "lookup",
  afterLimit: boolean,
  carriedNode?: LogicalQueryNode,
): boolean {
  if (node.kind === "project") return pureProject(node, node.input.node);
  if (node.kind === "filter") return false;
  if (path === "control")
    return (
      (node.kind === "union" && node.all) ||
      scalarAggregate(node) ||
      crossJoinWithSingleton(node, carriedNode)
    );
  return (
    afterLimit &&
    ((node.kind === "union" && node.all) ||
      (node.kind === "aggregate" && aggregatePathNodeIsStable(node)))
  );
}

function hasSafeAncestorPaths(
  root: LogicalQueryNode,
  candidate: AggregateNode,
  control: ProjectNode,
  lookup: JoinNode,
  incoming: ReadonlyMap<LogicalQueryNode, readonly ConsumerEdge[]>,
): boolean {
  const active = new Map<LogicalQueryNode, Set<string>>();
  const visited = new Map<LogicalQueryNode, Set<string>>();
  const visit = (
    node: LogicalQueryNode,
    path: "control" | "lookup",
    afterLimit: boolean,
    carriedNode?: LogicalQueryNode,
  ): boolean => {
    if (node === root) {
      const safe = rootAncestorPathIsSafe(node, path, afterLimit, carriedNode);
      return safe;
    }
    const state = `${path}:${afterLimit}`;
    const activeStates = active.get(node) ?? new Set<string>();
    const visitedStates = visited.get(node) ?? new Set<string>();
    if (activeStates.has(state)) return false;
    if (visitedStates.has(state)) return true;
    activeStates.add(state);
    active.set(node, activeStates);
    const parents = incoming.get(node) ?? [];
    if (parents.length === 0) {
      return false;
    }
    for (const edge of parents) {
      if (edge.kind !== "relation") {
        return false;
      }
      const parent = edge.parent;
      if (node === candidate) {
        if (parent === control) {
          if (
            !pureProject(parent, candidate) ||
            !visit(parent, "control", false)
          )
            return false;
          continue;
        }
        if (
          parent === lookup &&
          completeLookupJoin(candidate, parent) &&
          visit(parent, "lookup", false)
        )
          continue;
        return false;
      }
      if (path === "control") {
        if (stableFilter(parent, node)) {
          if (!visit(parent, path, false)) return false;
        } else if (pureProject(parent, node)) {
          if (!visit(parent, path, false)) return false;
        } else if (
          parent.kind === "union" &&
          parent.all &&
          (parent.left.node === node || parent.right.node === node)
        ) {
          if (!visit(parent, path, false)) return false;
        } else if (crossJoinWithSingleton(parent, node)) {
          if (!visit(parent, path, false, node)) return false;
        } else if (
          parent.kind === "aggregate" &&
          parent.input.node === node &&
          scalarAggregate(parent) &&
          !visit(parent, path, false)
        )
          return false;
        else if (
          parent.kind !== "aggregate" ||
          parent.input.node !== node ||
          !scalarAggregate(parent)
        ) {
          return false;
        }
      } else if (!afterLimit) {
        if (stableFilter(parent, node)) {
          if (!visit(parent, path, false)) return false;
        } else if (pureProject(parent, node)) {
          if (!visit(parent, path, false)) return false;
        } else if (
          isPositiveLiteralLimit(parent) &&
          parent.input.node === node
        ) {
          if (!visit(parent, path, true)) return false;
        } else {
          return false;
        }
      } else if (stableFilter(parent, node)) {
        if (!visit(parent, path, true)) return false;
      } else if (pureProject(parent, node)) {
        if (!visit(parent, path, true)) return false;
      } else if (
        parent.kind === "union" &&
        parent.all &&
        (parent.left.node === node || parent.right.node === node)
      ) {
        if (!visit(parent, path, true)) return false;
      } else if (
        parent.kind === "aggregate" &&
        parent.input.node === node &&
        aggregatePathNodeIsStable(parent)
      ) {
        if (!visit(parent, path, true)) return false;
      } else {
        return false;
      }
    }
    activeStates.delete(state);
    visitedStates.add(state);
    visited.set(node, visitedStates);
    return true;
  };

  const parents = incoming.get(candidate) ?? [];
  return (
    parents.length === 2 &&
    parents.every(({ kind }) => kind === "relation") &&
    parents.some(({ parent }) => parent === control) &&
    parents.some(({ parent }) => parent === lookup) &&
    visit(candidate, "control", false)
  );
}

/**
 * Find complete grouped facts that are both fully consumed as controls and
 * probed only as a complete-key LEFT JOIN lookup. This proof is intentionally
 * independent of application or query names.
 */
export function completeKeyedLookupReuseCandidates(
  root: LogicalQueryNode,
  boundedAdmissionLeaves: ReadonlyMap<
    LogicalQueryNode,
    ClosedStableSubtreeEvidence
  > = new Map(),
  admissionCounters: ReadonlyMap<
    LogicalQueryNode,
    LogicalQueryNode
  > = new Map(),
): ReadonlySet<LogicalQueryNode> {
  const nodes: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  let graphIsAcyclic = true;
  const collect = (node: LogicalQueryNode): void => {
    if (active.has(node)) {
      graphIsAcyclic = false;
      return;
    }
    if (visited.has(node)) return;
    active.add(node);
    for (const source of nodeSources(node)) collect(source.node);
    active.delete(node);
    visited.add(node);
    nodes.push(node);
  };
  collect(root);
  if (!graphIsAcyclic) return new Set();

  const incoming = new Map<LogicalQueryNode, ConsumerEdge[]>();
  for (const parent of nodes) {
    for (const source of relationChildren(parent))
      incoming.set(source.node, [
        ...(incoming.get(source.node) ?? []),
        { parent, kind: "relation" },
      ]);
    for (const expression of nodeExpressions(parent))
      for (const source of expressionSources(expression))
        incoming.set(source.node, [
          ...(incoming.get(source.node) ?? []),
          { parent, kind: "expression" },
        ]);
  }

  const result = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    if (
      node.kind !== "aggregate" ||
      !aggregateNodeIsSafe(node, true, true, true) ||
      !closedStableSubtree(node, boundedAdmissionLeaves, { admissionCounters })
    )
      continue;
    const parents = incoming.get(node) ?? [];
    if (parents.length !== 2 || parents.some(({ kind }) => kind !== "relation"))
      continue;
    const controls = parents.filter(({ parent }) => pureProject(parent, node));
    const lookups = parents.filter(
      ({ parent }) =>
        parent.kind === "join" && completeLookupJoin(node, parent),
    );
    const safeAncestorPaths =
      controls.length === 1 &&
      lookups.length === 1 &&
      hasSafeAncestorPaths(
        root,
        node,
        controls[0]!.parent as ProjectNode,
        lookups[0]!.parent as JoinNode,
        incoming,
      );
    if (!safeAncestorPaths) continue;
    result.add(node);
  }
  return result;
}
