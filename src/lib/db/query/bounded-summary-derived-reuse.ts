import {
  hasSafeMaterializationOrderingAncestors,
  isMaterializationSafeNode,
  type SharedMembershipInputIncomingEdge,
} from "./materialization-safety";
import type { LogicalQueryNode } from "./plan";

export interface BoundedSummaryDerivedReuseInput {
  readonly nodes: readonly LogicalQueryNode[];
  readonly incomingCounts: ReadonlyMap<LogicalQueryNode, number>;
  readonly incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly SharedMembershipInputIncomingEdge[]
  >;
  readonly forbiddenAncestors: ReadonlySet<LogicalQueryNode>;
  readonly expressionQueryEdges: ReadonlySet<LogicalQueryNode>;
  readonly boundedGroupSummaryCandidates: ReadonlySet<LogicalQueryNode>;
  readonly maximumFields: number;
  readonly minimumReferences: number;
}

interface BoundedSourceProof {
  readonly anchor: LogicalQueryNode;
  readonly maximumRows: number;
}

function boundedAnchorRowLimit(anchor: LogicalQueryNode): number | undefined {
  if (
    anchor.kind !== "aggregate" ||
    anchor.groups.length === 0 ||
    anchor.input.node.kind !== "limit"
  )
    return undefined;

  const limit = anchor.input.node;
  if (
    limit.offset !== undefined ||
    (limit.count.kind !== "constant" && limit.count.kind !== "parameter")
  )
    return undefined;
  const maximumRows = limit.count.value;
  return typeof maximumRows === "number" &&
    Number.isSafeInteger(maximumRows) &&
    maximumRows > 0
    ? maximumRows
    : undefined;
}

function boundedSourceProof(
  node: LogicalQueryNode,
  boundedGroupSummaryCandidates: ReadonlySet<LogicalQueryNode>,
  expressionQueryEdges: ReadonlySet<LogicalQueryNode>,
  memo: Map<LogicalQueryNode, BoundedSourceProof | null>,
  active: Set<LogicalQueryNode>,
): BoundedSourceProof | undefined {
  if (boundedGroupSummaryCandidates.has(node)) {
    const maximumRows = boundedAnchorRowLimit(node);
    return maximumRows === undefined
      ? undefined
      : { anchor: node, maximumRows };
  }
  if (memo.has(node)) return memo.get(node) ?? undefined;
  if (
    active.has(node) ||
    expressionQueryEdges.has(node) ||
    !isMaterializationSafeNode(node)
  )
    return undefined;

  active.add(node);
  let proof: BoundedSourceProof | undefined;
  switch (node.kind) {
    case "project":
    case "filter":
      proof = boundedSourceProof(
        node.input.node,
        boundedGroupSummaryCandidates,
        expressionQueryEdges,
        memo,
        active,
      );
      break;
    case "aggregate": {
      const input = boundedSourceProof(
        node.input.node,
        boundedGroupSummaryCandidates,
        expressionQueryEdges,
        memo,
        active,
      );
      if (input) {
        proof = {
          anchor: input.anchor,
          maximumRows: node.groups.length === 0 ? 1 : input.maximumRows,
        };
      }
      break;
    }
    case "join": {
      const left = boundedSourceProof(
        node.left.node,
        boundedGroupSummaryCandidates,
        expressionQueryEdges,
        memo,
        active,
      );
      const right = boundedSourceProof(
        node.right.node,
        boundedGroupSummaryCandidates,
        expressionQueryEdges,
        memo,
        active,
      );
      if (
        left &&
        right &&
        left.anchor === right.anchor &&
        (left.maximumRows <= 1 || right.maximumRows <= 1)
      ) {
        // Requiring a proven scalar side bounds the product. Two independently
        // grouped bags from the same anchor cannot become an arbitrary cross join.
        proof = {
          anchor: left.anchor,
          maximumRows: Math.max(left.maximumRows, right.maximumRows),
        };
      }
      break;
    }
    default:
      // Derived closures may contain only local Project/Filter/Aggregate/Join
      // nodes. Their only permitted leaf is the trusted bounded summary above.
      proof = undefined;
  }
  active.delete(node);
  memo.set(node, proof ?? null);
  return proof;
}

/**
 * Share only narrow, multiply referenced relations whose complete source is a
 * single freshly recognized bounded group summary. Each derived Join must
 * have a structurally proven scalar side, and all local expressions must pass
 * the existing totality, closed-scope, and ordering checks.
 */
export function boundedSummaryDerivedReuseCandidates({
  nodes,
  incomingCounts,
  incoming,
  forbiddenAncestors,
  expressionQueryEdges,
  boundedGroupSummaryCandidates,
  maximumFields,
  minimumReferences,
}: BoundedSummaryDerivedReuseInput): ReadonlySet<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    if (
      (node.kind !== "project" && node.kind !== "filter") ||
      node.fields.length === 0 ||
      node.fields.length > maximumFields ||
      expressionQueryEdges.has(node) ||
      !isMaterializationSafeNode(node) ||
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
        ))
    )
      continue;

    const consumers = incoming.get(node) ?? [];
    if (
      consumers.length < minimumReferences ||
      consumers.length !== (incomingCounts.get(node) ?? 0) ||
      consumers.some(({ kind }) => kind !== "relation") ||
      new Set(consumers.map(({ parent }) => parent)).size !== consumers.length
    )
      continue;

    if (
      boundedSourceProof(
        node,
        boundedGroupSummaryCandidates,
        expressionQueryEdges,
        new Map(),
        new Set(),
      )
    )
      candidates.add(node);
  }
  return candidates;
}
