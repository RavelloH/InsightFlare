import {
  hasSafeMaterializationOrderingAncestors,
  isMaterializationSafeNode,
  isTotalMaterializationSubtree,
  type SharedMembershipInputReuseInput,
} from "./materialization-safety";
import type { LogicalQueryNode, QuerySource } from "./plan";

function relationChildren(node: LogicalQueryNode): readonly QuerySource[] {
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
  }
}
function safeConsumer(
  parent: LogicalQueryNode,
  child: LogicalQueryNode,
  expressionQueryEdges: ReadonlySet<LogicalQueryNode>,
): boolean {
  if (expressionQueryEdges.has(parent)) return false;
  if (
    (parent.kind === "project" ||
      parent.kind === "filter" ||
      parent.kind === "aggregate" ||
      parent.kind === "window") &&
    parent.input.node === child
  )
    return isMaterializationSafeNode(parent);
  if (
    parent.kind === "join" &&
    (parent.left.node === child || parent.right.node === child)
  )
    return isMaterializationSafeNode(parent);
  return false;
}

function boundedMembershipSemiJoin(
  root: LogicalQueryNode,
  expressionQueryEdges: ReadonlySet<LogicalQueryNode>,
): (LogicalQueryNode & { readonly kind: "semi-join" }) | undefined {
  let current = root;
  while (current.kind === "project" || current.kind === "filter") {
    if (
      expressionQueryEdges.has(current) ||
      !isMaterializationSafeNode(current)
    )
      return undefined;
    current = current.input.node;
  }
  if (
    current.kind !== "semi-join" ||
    expressionQueryEdges.has(current) ||
    !isMaterializationSafeNode(current)
  )
    return undefined;
  return current as LogicalQueryNode & { readonly kind: "semi-join" };
}

function containsBoundedGroupSummary(
  root: LogicalQueryNode,
  candidates: ReadonlySet<LogicalQueryNode>,
  seen = new Set<LogicalQueryNode>(),
): boolean {
  if (candidates.has(root)) return true;
  if (seen.has(root)) return false;
  seen.add(root);
  return relationChildren(root).some(({ node }) =>
    containsBoundedGroupSummary(node, candidates, seen),
  );
}

/**
 * Admit only a closed, total shared projection over semi-join membership whose
 * Count-side bounded group was independently proved by the bounded-summary
 * recognizer. This right-side proof does not assert a row bound for the left
 * report bag.
 */
export function sharedMembershipInputReuseCandidates({
  nodes,
  incomingCounts,
  incoming,
  forbiddenAncestors,
  expressionQueryEdges,
  boundedGroupSummaryCandidates,
  minimumFields,
  maximumFields,
  minimumReferences,
}: SharedMembershipInputReuseInput): ReadonlySet<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    const membership =
      node.kind === "project"
        ? boundedMembershipSemiJoin(node, expressionQueryEdges)
        : undefined;
    if (
      node.kind !== "project" ||
      node.fields.length < minimumFields ||
      node.fields.length > maximumFields ||
      !membership ||
      expressionQueryEdges.has(node) ||
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
      !isMaterializationSafeNode(node) ||
      !containsBoundedGroupSummary(
        membership.right.node,
        boundedGroupSummaryCandidates,
      ) ||
      !isTotalMaterializationSubtree(membership, boundedGroupSummaryCandidates)
    )
      continue;

    const consumers = incoming.get(node) ?? [];
    if (
      consumers.length < minimumReferences ||
      consumers.length !== (incomingCounts.get(node) ?? 0) ||
      new Set(consumers.map(({ parent }) => parent)).size !==
        consumers.length ||
      consumers.some(
        ({ kind, parent }) =>
          kind !== "relation" ||
          !safeConsumer(parent, node, expressionQueryEdges),
      )
    )
      continue;

    candidates.add(node);
  }
  return candidates;
}
