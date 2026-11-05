import {
  type ClosedStableSubtreeEvidence,
  inspectClosedStableSubtree,
} from "./complete-keyed-lookup-reuse";
import type { RelationScope, SqlExpression } from "./expression";
import type {
  AggregateNode,
  FilterNode,
  JoinNode,
  LimitNode,
  LogicalQueryNode,
  ProjectNode,
  QuerySource,
} from "./plan";

export interface BoundedAdmissionIncomingEdge {
  readonly parent: LogicalQueryNode;
  readonly kind: "relation" | "expression";
}

export interface BoundedAdmissionEvidence extends ClosedStableSubtreeEvidence {
  readonly bounded: LimitNode;
  readonly counter: AggregateNode;
  readonly admissionFilter: FilterNode;
  readonly boundedRowsJoin: JoinNode;
  readonly admittedGateInput: QuerySource;
  readonly otherRowsJoins: readonly JoinNode[];
  readonly limitRows: number;
  readonly maximumRows: number;
}

export interface BoundedAdmissionReuseInput {
  readonly nodes: readonly LogicalQueryNode[];
  readonly incomingCounts: ReadonlyMap<LogicalQueryNode, number>;
  readonly incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly BoundedAdmissionIncomingEdge[]
  >;
  readonly maximumFields: number;
  readonly inspectLocalStableExpression: (
    expression: SqlExpression,
    allowedScopes: ReadonlySet<RelationScope>,
  ) => {
    readonly valid: boolean;
    readonly columns: readonly {
      readonly scope: RelationScope;
      readonly index: number;
    }[];
  };
}

function sameFields(
  left: readonly {
    readonly name: string;
    readonly affinity: string;
    readonly nullable: boolean;
  }[],
  right: readonly {
    readonly name: string;
    readonly affinity: string;
    readonly nullable: boolean;
  }[],
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

function positiveSafeInteger(
  expression: SqlExpression,
  minimum: number,
): number | undefined {
  if (
    (expression.kind !== "parameter" && expression.kind !== "constant") ||
    (expression.resultType.affinity !== "integer" &&
      expression.resultType.affinity !== "numeric") ||
    expression.resultType.nullable ||
    typeof expression.value !== "number" ||
    !Number.isSafeInteger(expression.value) ||
    expression.value < minimum
  )
    return undefined;
  return expression.value;
}

function positiveSafeLimitRows(expression: SqlExpression): number | undefined {
  if (
    (expression.kind !== "parameter" && expression.kind !== "constant") ||
    (expression.resultType.affinity !== "numeric" &&
      expression.resultType.affinity !== "integer") ||
    expression.resultType.nullable ||
    typeof expression.value !== "number" ||
    !Number.isSafeInteger(expression.value) ||
    expression.value <= 1
  )
    return undefined;
  return expression.value;
}

function zeroOrOneSafeInteger(
  expression: SqlExpression,
  expected: 0 | 1,
): boolean {
  return (
    (expression.kind === "parameter" || expression.kind === "constant") &&
    (expression.resultType.affinity === "integer" ||
      expression.resultType.affinity === "numeric") &&
    !expression.resultType.nullable &&
    typeof expression.value === "number" &&
    Number.isSafeInteger(expression.value) &&
    expression.value === expected
  );
}

function constantControlValue(expression: SqlExpression): boolean {
  return (
    (expression.kind === "parameter" || expression.kind === "constant") &&
    expression.resultType.nullable === (expression.value === null) &&
    ((typeof expression.value === "number" &&
      Number.isSafeInteger(expression.value)) ||
      typeof expression.value === "string" ||
      typeof expression.value === "boolean" ||
      expression.value === null)
  );
}

function localColumn(
  expression: SqlExpression,
  scope: RelationScope,
  index: number,
): boolean {
  return (
    expression.kind === "column" &&
    expression.scope === scope &&
    expression.index === index &&
    expression.resultType.affinity !== "unknown"
  );
}

function globalTrueJoin(node: JoinNode): boolean {
  const condition = node.condition;
  return (
    node.joinType === "inner" &&
    condition.kind === "binary" &&
    condition.operator === "=" &&
    zeroOrOneSafeInteger(condition.left, 1) &&
    zeroOrOneSafeInteger(condition.right, 1) &&
    condition.resultType.affinity === "integer" &&
    !condition.resultType.nullable
  );
}

function exactAdmissionMarkerProject(
  node: LogicalQueryNode,
  admissionFilter: FilterNode,
): node is ProjectNode {
  if (
    node.kind !== "project" ||
    node.input.node !== admissionFilter ||
    node.input.scope !== admissionFilter.scope ||
    node.input.fields !== admissionFilter.fields ||
    node.fields.length !== node.projections.length ||
    node.fields.length !== 1 ||
    node.projections.length !== 1
  )
    return false;
  const field = node.fields[0]!;
  const projection = node.projections[0]!;
  return (
    field.name === projection.name &&
    field.affinity === projection.expression.resultType.affinity &&
    field.nullable === projection.expression.resultType.nullable &&
    zeroOrOneSafeInteger(projection.expression, 1)
  );
}

function relationChildren(node: LogicalQueryNode): readonly LogicalQueryNode[] {
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
      return [node.input.node];
    case "recursive-closure":
      return [node.seed.node, node.candidates.node];
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return [node.left.node, node.right.node];
  }
}

function expressionContainsUnsafeEarlyEvaluation(
  expression: SqlExpression,
): boolean {
  switch (expression.kind) {
    case "binary":
    case "distinct-from":
      return (
        expressionContainsUnsafeEarlyEvaluation(expression.left) ||
        expressionContainsUnsafeEarlyEvaluation(expression.right)
      );
    case "cast-integer":
    case "cast-real":
    case "cast-text":
    case "null-check":
    case "not":
    case "in-list":
      return expressionContainsUnsafeEarlyEvaluation(expression.expression);
    case "text-position":
      return (
        expressionContainsUnsafeEarlyEvaluation(expression.text) ||
        expressionContainsUnsafeEarlyEvaluation(expression.needle)
      );
    case "text-substring":
      return (
        expressionContainsUnsafeEarlyEvaluation(expression.text) ||
        expressionContainsUnsafeEarlyEvaluation(expression.start) ||
        (expression.length !== undefined &&
          expressionContainsUnsafeEarlyEvaluation(expression.length))
      );
    case "text-like":
      return (
        expressionContainsUnsafeEarlyEvaluation(expression.text) ||
        expressionContainsUnsafeEarlyEvaluation(expression.pattern)
      );
    case "boolean":
      return expression.expressions.some(
        expressionContainsUnsafeEarlyEvaluation,
      );
    case "function":
      return (
        expression.name === "abs" ||
        expression.arguments.some(expressionContainsUnsafeEarlyEvaluation)
      );
    case "aggregate":
      return (
        expression.expression !== undefined &&
        expressionContainsUnsafeEarlyEvaluation(expression.expression)
      );
    case "coalesce":
      return expression.expressions.some(
        expressionContainsUnsafeEarlyEvaluation,
      );
    case "case":
      return (
        expression.branches.some(
          ({ when, then }) =>
            expressionContainsUnsafeEarlyEvaluation(when) ||
            expressionContainsUnsafeEarlyEvaluation(then),
        ) ||
        (expression.else !== undefined &&
          expressionContainsUnsafeEarlyEvaluation(expression.else))
      );
    case "in-subquery":
    case "scalar-subquery":
      // Closed-subtree proof rejects subqueries. Keep the local early-evaluation
      // guard conservative if that proof is widened later.
      return true;
    case "column":
    case "parameter":
    case "excluded":
    case "constant":
    case "unixepoch":
      return false;
  }
}

function nodeContainsUnsafeEarlyEvaluation(node: LogicalQueryNode): boolean {
  switch (node.kind) {
    case "scan":
    case "values-relation":
    case "json-scalar-array":
    case "distinct":
    case "union":
      return false;
    case "filter":
      return expressionContainsUnsafeEarlyEvaluation(node.predicate);
    case "project":
      return node.projections.some(({ expression }) =>
        expressionContainsUnsafeEarlyEvaluation(expression),
      );
    case "join":
    case "semi-join":
    case "anti-join":
      return expressionContainsUnsafeEarlyEvaluation(node.condition);
    case "aggregate":
      return (
        node.groups.some(({ expression }) =>
          expressionContainsUnsafeEarlyEvaluation(expression),
        ) ||
        node.aggregates.some(({ expression }) =>
          expressionContainsUnsafeEarlyEvaluation(expression),
        )
      );
    case "window":
      return node.windows.some(({ specification }) =>
        specification.kind === "row-number"
          ? [
              ...specification.partitionBy,
              ...specification.orderBy.map(({ expression }) => expression),
            ].some(expressionContainsUnsafeEarlyEvaluation)
          : specification.partitionBy.some(
              expressionContainsUnsafeEarlyEvaluation,
            ),
      );
    case "sort":
      return node.keys.some(({ expression }) =>
        expressionContainsUnsafeEarlyEvaluation(expression),
      );
    case "limit":
      return (
        expressionContainsUnsafeEarlyEvaluation(node.count) ||
        (node.offset !== undefined &&
          expressionContainsUnsafeEarlyEvaluation(node.offset))
      );
    case "recursive-closure":
      return expressionContainsUnsafeEarlyEvaluation(node.predicate);
  }
}

function subtreeContainsUnsafeEarlyEvaluation(root: LogicalQueryNode): boolean {
  const pending = [root];
  const visited = new Set<LogicalQueryNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (nodeContainsUnsafeEarlyEvaluation(node)) return true;
    pending.push(...relationChildren(node));
  }
  return false;
}

function subtreeContains(
  root: LogicalQueryNode,
  target: LogicalQueryNode,
): boolean {
  const pending = [root];
  const visited = new Set<LogicalQueryNode>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...relationChildren(current));
  }
  return false;
}

function oneCountStarAggregate(node: LogicalQueryNode): node is AggregateNode {
  if (
    node.kind !== "aggregate" ||
    node.groups.length !== 0 ||
    node.aggregates.length !== 1 ||
    node.fields.length !== 1 ||
    node.fields[0]?.affinity !== "integer" ||
    node.fields[0]?.nullable !== false
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

function exactAdmissionFilter(
  node: LogicalQueryNode,
  counter: AggregateNode,
  maximumRows: number,
): node is FilterNode {
  if (
    node.kind !== "filter" ||
    node.input.node !== counter ||
    node.fields.length !== counter.fields.length ||
    !sameFields(node.fields, counter.fields)
  )
    return false;
  const predicate = node.predicate;
  return (
    predicate.kind === "binary" &&
    predicate.operator === "<=" &&
    localColumn(predicate.left, node.input.scope, 0) &&
    predicate.left.resultType.affinity === "integer" &&
    !predicate.left.resultType.nullable &&
    positiveSafeInteger(predicate.right, 1) === maximumRows &&
    predicate.resultType.affinity === "integer" &&
    !predicate.resultType.nullable
  );
}

function countControlProject(
  node: LogicalQueryNode,
  counter: AggregateNode,
): node is ProjectNode {
  if (node.kind !== "project" || node.input.node !== counter) return false;
  let forwardedCount = 0;
  for (const { expression } of node.projections) {
    if (localColumn(expression, node.input.scope, 0)) {
      forwardedCount += 1;
      continue;
    }
    if (!constantControlValue(expression)) return false;
  }
  return forwardedCount === 1;
}

function boundedRootCandidate(
  bounded: LogicalQueryNode,
  input: BoundedAdmissionReuseInput,
): BoundedAdmissionEvidence | undefined {
  if (
    bounded.kind !== "limit" ||
    bounded.offset !== undefined ||
    bounded.fields.length === 0 ||
    bounded.fields.length > input.maximumFields ||
    !sameFields(bounded.fields, bounded.input.fields)
  )
    return undefined;
  const limitRows = positiveSafeLimitRows(bounded.count);
  if (limitRows === undefined) return undefined;
  const maximumRows = limitRows - 1;
  if (!Number.isSafeInteger(maximumRows) || maximumRows <= 0) return undefined;

  const boundedConsumers = input.incoming.get(bounded) ?? [];
  if (
    boundedConsumers.length !== 2 ||
    boundedConsumers.length !== (input.incomingCounts.get(bounded) ?? 0) ||
    boundedConsumers.some(({ kind }) => kind !== "relation")
  )
    return undefined;
  const counter = boundedConsumers.find(
    ({ parent }) =>
      oneCountStarAggregate(parent) && parent.input.node === bounded,
  )?.parent;
  const nodesJoin = boundedConsumers.find(
    ({ parent }) =>
      parent.kind === "join" &&
      parent.left.node === bounded &&
      globalTrueJoin(parent),
  )?.parent;
  if (
    !counter ||
    !oneCountStarAggregate(counter) ||
    !nodesJoin ||
    counter.input.node !== bounded
  )
    return undefined;

  const counterConsumers = input.incoming.get(counter) ?? [];
  if (
    counterConsumers.length !== 2 ||
    counterConsumers.length !== (input.incomingCounts.get(counter) ?? 0) ||
    counterConsumers.some(({ kind }) => kind !== "relation")
  )
    return undefined;
  const filterConsumer = counterConsumers.find(({ parent }) =>
    exactAdmissionFilter(parent, counter, maximumRows),
  );
  const admissionFilter = filterConsumer?.parent;
  const projectConsumer = counterConsumers.find(({ parent }) =>
    countControlProject(parent, counter),
  );
  const controlProject = projectConsumer?.parent;
  if (
    !filterConsumer ||
    admissionFilter?.kind !== "filter" ||
    !projectConsumer ||
    controlProject?.kind !== "project"
  )
    return undefined;

  const admissionConsumers = input.incoming.get(admissionFilter) ?? [];
  if (
    admissionConsumers.length < 1 ||
    admissionConsumers.length !==
      (input.incomingCounts.get(admissionFilter) ?? 0) ||
    admissionConsumers.some(({ kind }) => kind !== "relation")
  )
    return undefined;
  const gatedJoins: JoinNode[] = [];
  for (const { parent } of admissionConsumers) {
    if (
      parent.kind === "join" &&
      parent.right.node === admissionFilter &&
      globalTrueJoin(parent)
    ) {
      gatedJoins.push(parent);
      continue;
    }
    if (!exactAdmissionMarkerProject(parent, admissionFilter)) return undefined;
    const markerConsumers = input.incoming.get(parent) ?? [];
    if (
      markerConsumers.length < 1 ||
      markerConsumers.length !== (input.incomingCounts.get(parent) ?? 0) ||
      markerConsumers.some(
        ({ kind, parent: consumer }) =>
          kind !== "relation" ||
          consumer.kind !== "join" ||
          consumer.right.node !== parent ||
          !globalTrueJoin(consumer),
      )
    )
      return undefined;
    gatedJoins.push(
      ...markerConsumers.map(({ parent: consumer }) => consumer as JoinNode),
    );
  }
  const boundedRowsJoins = gatedJoins.filter(
    (parent): parent is JoinNode =>
      parent.kind === "join" && parent.left.node === bounded,
  );
  const boundedRowsJoin = boundedRowsJoins[0];
  const otherRowsJoins = gatedJoins.filter(
    (parent): parent is JoinNode =>
      parent.kind === "join" && parent !== boundedRowsJoin,
  );
  const hasUnclassifiedBoundedReader = otherRowsJoins.some((parent) =>
    subtreeContains(parent.left.node, bounded),
  );
  if (
    boundedRowsJoins.length !== 1 ||
    !boundedRowsJoin ||
    hasUnclassifiedBoundedReader
  )
    return undefined;

  // SQLite ABS can throw for INT64_MIN. Sharing this LIMIT would evaluate the
  // selected expression while materializing rows, before the count can reject
  // the over-limit resource. Keep this rule's extra proof local; the older
  // complete-keyed reuse rules retain their existing stability contract.
  if (subtreeContainsUnsafeEarlyEvaluation(bounded.input.node))
    return undefined;
  const inputClosure = inspectClosedStableSubtree(bounded.input.node);
  if (!inputClosure) return undefined;
  return {
    bounded,
    counter,
    admissionFilter,
    boundedRowsJoin,
    admittedGateInput: boundedRowsJoin.right,
    otherRowsJoins,
    limitRows,
    maximumRows,
    containsRecursiveClosure: inputClosure.containsRecursiveClosure,
  };
}

/** Recompute the exact global-count gate proof from the Generic relation DAG. */
export function boundedAdmissionReuseCandidates(
  input: BoundedAdmissionReuseInput,
): ReadonlyMap<LogicalQueryNode, BoundedAdmissionEvidence> {
  const candidates = new Map<LogicalQueryNode, BoundedAdmissionEvidence>();
  for (const node of input.nodes) {
    const evidence = boundedRootCandidate(node, input);
    if (evidence) candidates.set(node, evidence);
  }
  return candidates;
}
