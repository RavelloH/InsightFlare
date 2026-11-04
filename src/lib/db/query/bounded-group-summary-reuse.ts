import type { RelationScope, SqlExpression } from "./expression";
import {
  hasSafeMaterializationOrderingAncestors,
  isMaterializationSafeAggregateExpression,
  isMaterializationSafeExpression,
  type SharedMembershipInputIncomingEdge,
} from "./materialization-safety";
import type { LogicalQueryNode } from "./plan";

export interface BoundedGroupSummaryReuseInput {
  readonly nodes: readonly LogicalQueryNode[];
  readonly incomingCounts: ReadonlyMap<LogicalQueryNode, number>;
  readonly incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >;
  readonly forbiddenAncestors: ReadonlySet<LogicalQueryNode>;
  readonly expressionQueryEdges: ReadonlySet<LogicalQueryNode>;
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

function stableAggregateExpressions(
  node: Extract<LogicalQueryNode, { kind: "aggregate" }>,
): boolean {
  const allowedFields = new Map([[node.input.scope, node.input.fields.length]]);
  return (
    node.groups.every(({ expression }) =>
      expressionFitsFields(expression, allowedFields),
    ) &&
    node.aggregates.every(({ expression }) =>
      isMaterializationSafeAggregateExpression(expression, node.input),
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

/**
 * Admit only a complete, bounded grouped result with one summary and one
 * filter consumer. This analysis deliberately does not relax general sharing
 * facts or candidate-width limits.
 */
export function boundedGroupSummaryReuseCandidates({
  nodes,
  incomingCounts,
  incoming,
  forbiddenAncestors,
  expressionQueryEdges,
  maximumFields,
}: BoundedGroupSummaryReuseInput): ReadonlySet<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of nodes) {
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
      !safeBoundedInput(node.input.node) ||
      !stableAggregateExpressions(node)
    )
      continue;

    const consumers = incoming.get(node) ?? [];
    if (
      consumers.length !== 2 ||
      consumers.length !== (incomingCounts.get(node) ?? 0) ||
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
