import type { BoundedAdmissionEvidence } from "./bounded-admission-reuse";
import type { RelationScope, SqlExpression } from "./expression";
import {
  hasSafeMaterializationOrderingAncestors,
  isMaterializationSafeAggregateExpression,
  isMaterializationSafeExpression,
  isMaterializationSafeNode,
  type SharedMembershipInputIncomingEdge,
} from "./materialization-safety";
import type {
  AggregateNode,
  JoinNode,
  LogicalQueryNode,
  OutputField,
  ProjectNode,
  QuerySource,
} from "./plan";

export interface BoundedGroupSummaryReuseInput {
  readonly nodes: readonly LogicalQueryNode[];
  readonly incomingCounts: ReadonlyMap<LogicalQueryNode, number>;
  readonly incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >;
  readonly forbiddenAncestors: ReadonlySet<LogicalQueryNode>;
  readonly expressionQueryEdges: ReadonlySet<LogicalQueryNode>;
  readonly boundedAdmissionCandidates: ReadonlyMap<
    LogicalQueryNode,
    BoundedAdmissionEvidence
  >;
  readonly maximumFields: number;
}

function expressionFitsFields(
  expression: SqlExpression,
  allowedFields: ReadonlyMap<RelationScope, number>,
): boolean {
  return isMaterializationSafeExpression(expression, allowedFields);
}

function safeLimitCount(expression: SqlExpression): boolean {
  if (expression.kind !== "parameter" && expression.kind !== "constant")
    return false;
  const value = expression.value;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function safeBoundedInput(root: LogicalQueryNode): boolean {
  if (
    root.kind !== "limit" ||
    root.offset !== undefined ||
    !safeLimitCount(root.count)
  )
    return false;

  let hasSelectiveFilter = false;
  let hasJoin = false;
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): boolean => {
    if (visited.has(node)) return true;
    visited.add(node);
    switch (node.kind) {
      case "scan":
      case "values-relation":
        return true;
      case "project":
        return (
          node.projections.every(({ expression }) =>
            expressionFitsFields(
              expression,
              new Map([[node.input.scope, node.input.fields.length]]),
            ),
          ) && visit(node.input.node)
        );
      case "filter":
        hasSelectiveFilter = true;
        return (
          expressionFitsFields(
            node.predicate,
            new Map([[node.input.scope, node.input.fields.length]]),
          ) && visit(node.input.node)
        );
      case "join":
        if (node.joinType !== "inner" && node.joinType !== "left") return false;
        hasJoin = true;
        return (
          expressionFitsFields(
            node.condition,
            new Map([
              [node.left.scope, node.left.fields.length],
              [node.right.scope, node.right.fields.length],
            ]),
          ) &&
          visit(node.left.node) &&
          visit(node.right.node)
        );
      case "union":
        return node.all && visit(node.left.node) && visit(node.right.node);
      case "limit":
        return false;
      default:
        return false;
    }
  };

  return visit(root.input.node) && hasSelectiveFilter && hasJoin;
}

function exactAdmittedRowsProject(
  node: LogicalQueryNode,
  evidence: BoundedAdmissionEvidence,
  incomingCounts: ReadonlyMap<LogicalQueryNode, number>,
  incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >,
): boolean {
  const join = evidence.boundedRowsJoin;
  const bounded = evidence.bounded;
  if (
    node.kind !== "project" ||
    node.input.node !== join ||
    node.input.scope !== join.scope ||
    node.input.fields !== join.fields ||
    join.joinType !== "inner" ||
    join.left.node !== bounded ||
    join.left.scope !== bounded.scope ||
    join.left.fields !== bounded.fields ||
    join.right.node !== evidence.admittedGateInput.node ||
    join.right.scope !== evidence.admittedGateInput.scope ||
    join.right.fields !== evidence.admittedGateInput.fields ||
    join.right.fields.length !== 1 ||
    node.projections.length !== bounded.fields.length ||
    !sameFieldShape(node.fields, bounded.fields) ||
    join.fields.length !== bounded.fields.length + join.right.fields.length ||
    !samePrefixedFieldShape(
      join.fields.slice(0, bounded.fields.length),
      bounded.fields,
      "left",
    ) ||
    !samePrefixedFieldShape(
      join.fields.slice(bounded.fields.length),
      join.right.fields,
      "right",
    )
  )
    return false;

  const joinConsumers = incoming.get(join) ?? [];
  if (
    joinConsumers.length !== 1 ||
    joinConsumers.length !== (incomingCounts.get(join) ?? 0) ||
    joinConsumers[0]?.kind !== "relation" ||
    joinConsumers[0]?.parent !== node
  )
    return false;

  return node.projections.every(({ name, expression }, index) => {
    const source = bounded.fields[index];
    return (
      name === source?.name &&
      expression.kind === "column" &&
      expression.scope === node.input.scope &&
      expression.index === index &&
      expression.name === node.input.fields[index]?.name &&
      expression.resultType.affinity === source.affinity &&
      expression.resultType.nullable === source.nullable &&
      isMaterializationSafeExpression(
        expression,
        new Map([[node.input.scope, node.input.fields.length]]),
      )
    );
  });
}

function safeDirectFieldProject(node: LogicalQueryNode): node is ProjectNode {
  if (node.kind !== "project" || node.projections.length !== node.fields.length)
    return false;
  const indexes = new Set<number>();
  return node.projections.every(({ name, expression }, index) => {
    const inputIndex = directColumnIndex(expression, node.input);
    const inputField =
      inputIndex === undefined ? undefined : node.input.fields[inputIndex];
    const output = node.fields[index];
    if (
      output?.name !== name ||
      name !== inputField?.name ||
      output.affinity !== expression.resultType.affinity ||
      output.nullable !== expression.resultType.nullable ||
      inputIndex === undefined ||
      indexes.has(inputIndex)
    )
      return false;
    indexes.add(inputIndex);
    return true;
  });
}

function hasExactAdmittedRowsProject(
  root: LogicalQueryNode,
  evidence: BoundedAdmissionEvidence,
  incomingCounts: ReadonlyMap<LogicalQueryNode, number>,
  incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >,
): boolean {
  if (exactAdmittedRowsProject(root, evidence, incomingCounts, incoming))
    return true;
  if (!safeDirectFieldProject(root)) return false;
  return exactAdmittedRowsProject(
    root.input.node,
    evidence,
    incomingCounts,
    incoming,
  );
}

function safeAdmittedRowsInput(
  root: LogicalQueryNode,
  evidence: BoundedAdmissionEvidence,
  incomingCounts: ReadonlyMap<LogicalQueryNode, number>,
  incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >,
): boolean {
  return (
    hasExactAdmittedRowsProject(root, evidence, incomingCounts, incoming) &&
    isMaterializationSafeNode(evidence.boundedRowsJoin) &&
    isMaterializationSafeNode(evidence.admittedGateInput.node) &&
    isMaterializationSafeNode(evidence.admissionFilter) &&
    isMaterializationSafeNode(evidence.counter) &&
    safeBoundedInput(evidence.bounded)
  );
}

function unitIndicator(expression: SqlExpression): boolean {
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
      expression.branches.every(({ then }) => unitIndicator(then)) &&
      expression.else !== undefined &&
      unitIndicator(expression.else)
    );
  if (expression.kind === "coalesce")
    return (
      expression.expressions.length > 0 &&
      expression.expressions.every(unitIndicator)
    );
  return false;
}

function safeBoundedAdmissionSum(
  expression: SqlExpression,
  input: QuerySource,
  evidence: BoundedAdmissionEvidence,
): boolean {
  if (
    expression.kind !== "aggregate" ||
    expression.name !== "SUM" ||
    !expression.expression ||
    !Number.isSafeInteger(evidence.maximumRows) ||
    evidence.maximumRows < 1 ||
    evidence.limitRows !== evidence.maximumRows + 1
  )
    return false;
  return (
    isMaterializationSafeExpression(
      expression.expression,
      new Map([[input.scope, input.fields.length]]),
    ) && unitIndicator(expression.expression)
  );
}

function stableAggregateExpressions(
  node: Extract<LogicalQueryNode, { kind: "aggregate" }>,
  boundedAdmission?: BoundedAdmissionEvidence,
): boolean {
  const allowedFields = new Map([[node.input.scope, node.input.fields.length]]);
  return (
    node.groups.every(({ expression }) =>
      expressionFitsFields(expression, allowedFields),
    ) &&
    node.aggregates.every(
      ({ expression }) =>
        isMaterializationSafeAggregateExpression(expression, node.input) ||
        (boundedAdmission !== undefined &&
          safeBoundedAdmissionSum(expression, node.input, boundedAdmission)),
    )
  );
}

function validConsumer(
  edge: SharedMembershipInputIncomingEdge,
  candidate: Extract<LogicalQueryNode, { kind: "aggregate" }>,
): boolean {
  if (edge.kind !== "relation") return false;
  const { parent } = edge;
  if (parent.kind === "aggregate" && parent.input.node === candidate) {
    if (parent.groups.length !== 0 || parent.aggregates.length === 0)
      return false;
    return parent.aggregates.every(({ expression }) =>
      isMaterializationSafeAggregateExpression(expression, parent.input),
    );
  }
  if (parent.kind === "filter" && parent.input.node === candidate)
    return expressionFitsFields(
      parent.predicate,
      new Map([[parent.input.scope, parent.input.fields.length]]),
    );
  return false;
}

function isNodeOutput(source: QuerySource): boolean {
  return (
    source.scope === source.node.scope && source.fields === source.node.fields
  );
}

function directColumnIndex(
  expression: SqlExpression,
  source: QuerySource,
): number | undefined {
  // Key identity follows the source field through this exact scope. A matching
  // name or affinity alone is not evidence that two lookup keys are the same.
  if (
    expression.kind !== "column" ||
    expression.scope !== source.scope ||
    !Number.isInteger(expression.index) ||
    expression.index < 0 ||
    expression.index >= source.fields.length
  )
    return undefined;
  const field = source.fields[expression.index];
  if (
    !field ||
    expression.name !== field.name ||
    expression.resultType.affinity !== field.affinity ||
    expression.resultType.nullable !== field.nullable
  )
    return undefined;
  return expression.index;
}

function sameFieldShape(
  left: readonly OutputField[],
  right: readonly OutputField[],
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

function samePrefixedFieldShape(
  output: readonly OutputField[],
  input: readonly OutputField[],
  prefix: "left" | "right",
): boolean {
  return (
    output.length === input.length &&
    output.every(
      (field, index) =>
        field.name === `${prefix}_${input[index]?.name}` &&
        field.affinity === input[index]?.affinity &&
        field.nullable === input[index]?.nullable,
    )
  );
}

function sourceFieldLineage(
  source: QuerySource,
  target: LogicalQueryNode,
  targetLineage: readonly (number | undefined)[],
  active = new Set<LogicalQueryNode>(),
): readonly (number | undefined)[] | undefined {
  if (!isNodeOutput(source) || active.has(source.node)) return undefined;
  if (source.node === target)
    return targetLineage.length === source.fields.length
      ? targetLineage
      : undefined;

  active.add(source.node);
  let lineage: readonly (number | undefined)[] | undefined;
  if (source.node.kind === "filter") {
    const node = source.node;
    if (
      sameFieldShape(node.fields, node.input.fields) &&
      expressionFitsFields(
        node.predicate,
        new Map([[node.input.scope, node.input.fields.length]]),
      )
    )
      lineage = sourceFieldLineage(node.input, target, targetLineage, active);
  } else if (source.node.kind === "project") {
    const node = source.node;
    if (
      node.projections.length === node.fields.length &&
      node.projections.every(
        ({ expression }, index) =>
          expressionFitsFields(
            expression,
            new Map([[node.input.scope, node.input.fields.length]]),
          ) &&
          node.fields[index]?.name === node.projections[index]?.name &&
          node.fields[index]?.affinity === expression.resultType.affinity &&
          node.fields[index]?.nullable === expression.resultType.nullable,
      )
    ) {
      const inputLineage = sourceFieldLineage(
        node.input,
        target,
        targetLineage,
        active,
      );
      if (inputLineage) {
        // Only a direct column projection preserves key and collation lineage.
        lineage = node.projections.map(({ expression }) => {
          const inputIndex = directColumnIndex(expression, node.input);
          return inputIndex === undefined
            ? undefined
            : inputLineage[inputIndex];
        });
      }
    }
  }
  active.delete(source.node);
  return lineage;
}

function aggregateGroupInputIndexes(
  candidate: AggregateNode,
): readonly number[] | undefined {
  if (
    (candidate.input.node.kind !== "limit" &&
      candidate.input.node.kind !== "project") ||
    candidate.input.scope !== candidate.input.node.scope ||
    candidate.input.fields !== candidate.input.node.fields ||
    candidate.groups.length === 0 ||
    candidate.fields.length !==
      candidate.groups.length + candidate.aggregates.length
  )
    return undefined;

  const indexes: number[] = [];
  for (const [position, group] of candidate.groups.entries()) {
    const index = directColumnIndex(group.expression, candidate.input);
    const output = candidate.fields[position];
    if (
      index === undefined ||
      indexes.includes(index) ||
      output?.name !== group.name ||
      output.affinity !== group.expression.resultType.affinity ||
      output.nullable !== group.expression.resultType.nullable
    )
      return undefined;
    indexes.push(index);
  }
  return indexes;
}

function relationReferenceCount(
  parent: LogicalQueryNode,
  child: LogicalQueryNode,
): number {
  switch (parent.kind) {
    case "filter":
    case "project":
    case "aggregate":
    case "distinct":
    case "window":
    case "sort":
    case "limit":
      return Number(parent.input.node === child);
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return (
        Number(parent.left.node === child) + Number(parent.right.node === child)
      );
    case "recursive-closure":
      return (
        Number(parent.seed.node === child) +
        Number(parent.candidates.node === child)
      );
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return 0;
  }
}

function safeLookupJoin(candidate: AggregateNode, join: JoinNode): boolean {
  if (
    !isNodeOutput(join.left) ||
    !isNodeOutput(join.right) ||
    join.left.scope === join.right.scope ||
    (join.right.node.kind !== "aggregate" &&
      join.right.node.kind !== "filter" &&
      join.right.node.kind !== "project")
  )
    return false;

  const groupIndexes = aggregateGroupInputIndexes(candidate);
  if (!groupIndexes) return false;
  const summaryKeyIndexes = candidate.groups.map((_group, index) => index);
  const summaryLineage = sourceFieldLineage(join.right, candidate, [
    ...summaryKeyIndexes,
    ...candidate.aggregates.map(() => undefined),
  ]);
  const boundedLineage = candidate.input.fields.map((_field, index) => index);
  const candidateLineage = sourceFieldLineage(
    join.left,
    candidate.input.node,
    boundedLineage,
  );
  if (!summaryLineage || !candidateLineage) return false;

  let rightHasFilter = false;
  let rightNode: LogicalQueryNode = join.right.node;
  const rightSeen = new Set<LogicalQueryNode>();
  while (rightNode !== candidate) {
    if (rightSeen.has(rightNode)) return false;
    rightSeen.add(rightNode);
    if (rightNode.kind === "filter") {
      rightHasFilter = true;
      rightNode = rightNode.input.node;
    } else if (rightNode.kind === "project") {
      rightNode = rightNode.input.node;
    } else {
      return false;
    }
  }
  if (join.joinType === "inner" && rightHasFilter) return false;

  const allowedScopes = new Map([
    [join.left.scope, join.left.fields.length],
    [join.right.scope, join.right.fields.length],
  ]);
  if (!expressionFitsFields(join.condition, allowedScopes)) return false;
  const equalities: {
    readonly leftIndex: number;
    readonly rightIndex: number;
  }[] = [];
  let validCondition = true;
  const collect = (expression: SqlExpression): void => {
    if (expression.kind === "boolean" && expression.operator === "AND") {
      if (expression.expressions.length === 0) validCondition = false;
      for (const child of expression.expressions) collect(child);
      return;
    }
    if (expression.kind !== "binary" || expression.operator !== "=") {
      validCondition = false;
      return;
    }
    const orientations = [
      [expression.left, expression.right],
      [expression.right, expression.left],
    ] as const;
    for (const [leftExpression, rightExpression] of orientations) {
      const leftIndex = directColumnIndex(leftExpression, join.left);
      const rightIndex = directColumnIndex(rightExpression, join.right);
      if (leftIndex !== undefined && rightIndex !== undefined) {
        equalities.push({ leftIndex, rightIndex });
        return;
      }
    }
    validCondition = false;
  };
  collect(join.condition);
  if (!validCondition || equalities.length !== groupIndexes.length)
    return false;

  const matchedGroupIndexes = new Set<number>();
  const matchedLeftIndexes = new Set<number>();
  for (const { leftIndex, rightIndex } of equalities) {
    const groupIndex = summaryLineage[rightIndex];
    const leftInputIndex = candidateLineage[leftIndex];
    if (
      groupIndex === undefined ||
      leftInputIndex === undefined ||
      leftInputIndex !== groupIndexes[groupIndex] ||
      matchedGroupIndexes.has(groupIndex) ||
      matchedLeftIndexes.has(leftIndex)
    )
      return false;
    const expected = candidate.input.fields[groupIndexes[groupIndex]!];
    const leftField = join.left.fields[leftIndex];
    const rightField = join.right.fields[rightIndex];
    if (
      !expected ||
      !leftField ||
      !rightField ||
      expected.affinity === "unknown" ||
      leftField.affinity !== expected.affinity ||
      rightField.affinity !== expected.affinity ||
      leftField.nullable !== expected.nullable ||
      rightField.nullable !== expected.nullable
    )
      return false;
    if (join.joinType === "inner" && expected.nullable) return false;
    matchedGroupIndexes.add(groupIndex);
    matchedLeftIndexes.add(leftIndex);
  }
  // Both sides resolve to the same field of the exact bounded input. This
  // preserves the grouping and equality comparison domain across aliases.
  return matchedGroupIndexes.size === groupIndexes.length;
}

function transparentConsumer(
  parent: LogicalQueryNode,
  child: LogicalQueryNode,
): boolean {
  if (parent.kind === "project")
    return parent.input.node === child && isMaterializationSafeNode(parent);
  if (parent.kind === "filter")
    return parent.input.node === child && isMaterializationSafeNode(parent);
  if (parent.kind === "union")
    return (
      parent.all &&
      (parent.left.node === child || parent.right.node === child) &&
      parent.fields.length > 0 &&
      sameFieldShape(parent.fields, parent.left.fields) &&
      sameFieldShape(parent.fields, parent.right.fields)
    );
  return false;
}

function activeRelationConsumer(
  parent: LogicalQueryNode,
  child: LogicalQueryNode,
): boolean {
  if (parent.kind === "project" || parent.kind === "filter")
    return parent.input.node === child && isMaterializationSafeNode(parent);
  if (parent.kind === "union")
    return (
      parent.all &&
      (parent.left.node === child || parent.right.node === child) &&
      parent.fields.length > 0 &&
      sameFieldShape(parent.fields, parent.left.fields) &&
      sameFieldShape(parent.fields, parent.right.fields)
    );
  if (parent.kind === "semi-join" || parent.kind === "anti-join")
    return parent.left.node === child && isMaterializationSafeNode(parent);
  if (parent.kind === "aggregate" || parent.kind === "join")
    return isMaterializationSafeNode(parent);
  return false;
}

function hasRepeatedTransparentLookupUse(
  start: LogicalQueryNode,
  incomingCounts: ReadonlyMap<LogicalQueryNode, number>,
  incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >,
  expressionQueryEdges: ReadonlySet<LogicalQueryNode>,
): boolean {
  const pending = [start];
  const visited = new Set<LogicalQueryNode>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current) || expressionQueryEdges.has(current)) continue;
    visited.add(current);
    const edges: readonly SharedMembershipInputIncomingEdge[] =
      incoming.get(current) ?? [];
    if (edges.length !== (incomingCounts.get(current) ?? 0)) continue;
    const parents = new Set(edges.map(({ parent }) => parent));
    // Count distinct parents, not duplicate references from one join/union.
    const safeParents = [...parents].filter((parent) => {
      const parentEdges = edges.filter((edge) => edge.parent === parent);
      return (
        parentEdges.length === 1 &&
        parentEdges[0]?.kind === "relation" &&
        relationReferenceCount(parent, current) === 1 &&
        !expressionQueryEdges.has(parent) &&
        activeRelationConsumer(parent, current)
      );
    });
    if (safeParents.length >= 2) return true;
    for (const parent of safeParents)
      if (transparentConsumer(parent, current)) pending.push(parent);
  }
  return false;
}

function validSingleLookupConsumer(
  candidate: AggregateNode,
  incomingCounts: ReadonlyMap<LogicalQueryNode, number>,
  incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >,
  forbiddenAncestors: ReadonlySet<LogicalQueryNode>,
  expressionQueryEdges: ReadonlySet<LogicalQueryNode>,
): boolean {
  let current: LogicalQueryNode = candidate;
  const visited = new Set<LogicalQueryNode>();
  while (!visited.has(current)) {
    visited.add(current);
    if (expressionQueryEdges.has(current)) return false;
    const edges: readonly SharedMembershipInputIncomingEdge[] =
      incoming.get(current) ?? [];
    if (
      edges.length !== 1 ||
      edges.length !== (incomingCounts.get(current) ?? 0) ||
      edges[0]?.kind !== "relation"
    )
      return false;
    const parent: LogicalQueryNode = edges[0]!.parent;
    if (relationReferenceCount(parent, current) !== 1) return false;
    if (
      (parent.kind === "project" || parent.kind === "filter") &&
      !forbiddenAncestors.has(parent) &&
      isMaterializationSafeNode(parent) &&
      parent.input.node === current
    ) {
      current = parent;
      continue;
    }
    if (
      parent.kind !== "join" ||
      parent.right.node !== current ||
      forbiddenAncestors.has(parent) ||
      expressionQueryEdges.has(parent) ||
      !safeLookupJoin(candidate, parent)
    )
      return false;
    return hasRepeatedTransparentLookupUse(
      parent,
      incomingCounts,
      incoming,
      expressionQueryEdges,
    );
  }
  return false;
}

/**
 * Admit complete bounded summaries with either the established global-summary
 * and filter pair or a proven full-key lookup whose transparent consumer
 * closure has repeated real relation use. This analysis does not relax general
 * sharing facts or candidate-width limits.
 */
export function boundedGroupSummaryReuseCandidates({
  nodes,
  incomingCounts,
  incoming,
  forbiddenAncestors,
  expressionQueryEdges,
  boundedAdmissionCandidates,
  maximumFields,
}: BoundedGroupSummaryReuseInput): ReadonlySet<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    const input = node.kind === "aggregate" ? node.input.node : undefined;
    const boundedAdmission =
      input === undefined
        ? undefined
        : [...boundedAdmissionCandidates.values()].find((evidence) =>
            safeAdmittedRowsInput(input, evidence, incomingCounts, incoming),
          );
    const hasSafeInput =
      (input !== undefined && safeBoundedInput(input)) ||
      boundedAdmission !== undefined;
    if (
      node.kind !== "aggregate" ||
      node.groups.length === 0 ||
      node.fields.length === 0 ||
      node.fields.length > maximumFields ||
      !hasSafeMaterializationOrderingAncestors(
        node,
        incoming,
        expressionQueryEdges,
      ) ||
      (forbiddenAncestors.has(node) &&
        !hasSafeMaterializationOrderingAncestors(
          node,
          incoming,
          expressionQueryEdges,
          true,
        )) ||
      expressionQueryEdges.has(node) ||
      !hasSafeInput ||
      !stableAggregateExpressions(node, boundedAdmission)
    )
      continue;

    const consumers = incoming.get(node) ?? [];
    if (consumers.length !== (incomingCounts.get(node) ?? 0)) continue;

    if (
      validSingleLookupConsumer(
        node,
        incomingCounts,
        incoming,
        forbiddenAncestors,
        expressionQueryEdges,
      )
    ) {
      candidates.add(node);
      continue;
    }

    if (
      consumers.length !== 2 ||
      consumers[0]?.parent === consumers[1]?.parent ||
      !consumers.every((edge) => validConsumer(edge, node))
    )
      continue;

    const parents = consumers.map(({ parent }) => parent);
    const hasGlobalSummary = parents.some(
      (parent) =>
        parent.kind === "aggregate" &&
        parent.input.node === node &&
        parent.groups.length === 0,
    );
    const hasFilter = parents.some(
      (parent) => parent.kind === "filter" && parent.input.node === node,
    );
    if (hasGlobalSummary && hasFilter) candidates.add(node);
  }
  return candidates;
}
