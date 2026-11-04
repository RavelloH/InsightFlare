import type { MaterializationConsumerEdge } from "@/lib/db/query/physical/materialization-selection";
import {
  analyzeSemiMembershipKeyCondition,
  type SemiMembershipComparisonPairProof,
} from "@/lib/db/query/physical/semi-membership";
import type {
  LogicalQueryNode,
  QuerySource,
  SemiJoinNode,
} from "@/lib/db/query/plan";

/** A current SemiJoin right edge whose raw member rows are not observable. */
export interface SemiJoinMembershipObservationCertificate {
  readonly kind: "semi-join-right-membership-observation";
  readonly semiJoin: SemiJoinNode;
  readonly rightSource: QuerySource;
  readonly condition: SemiJoinNode["condition"];
  readonly leftKeyIndexes: readonly number[];
  readonly rightKeyIndexes: readonly number[];
  readonly comparisons: readonly SemiMembershipComparisonPairProof[];
}

export type SemiJoinMembershipObservationProof =
  | {
      readonly kind: "not-applicable";
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
    }
  | {
      readonly kind: "proved";
      readonly certificate: SemiJoinMembershipObservationCertificate;
    };

function sourceIsCurrent(
  source: QuerySource,
  sameFields: (
    left: QuerySource["fields"],
    right: QuerySource["fields"],
  ) => boolean,
): boolean {
  return (
    source.scope === source.node.scope &&
    sameFields(source.fields, source.node.fields)
  );
}

/**
 * Prove that one current relation edge is observed only as positive
 * SemiJoin-right membership. The certificate is deliberately not a physical
 * materialization interface and says nothing about other consumer paths.
 */
export function proveSemiJoinMembershipObservation(input: {
  readonly edge: MaterializationConsumerEdge;
  readonly currentNodes: ReadonlySet<LogicalQueryNode>;
  readonly sameFields: (
    left: QuerySource["fields"],
    right: QuerySource["fields"],
  ) => boolean;
}): SemiJoinMembershipObservationProof {
  const { edge } = input;
  if (
    edge.kind !== "relation" ||
    edge.parent.kind !== "semi-join" ||
    edge.parent.right.node !== edge.child
  )
    return { kind: "not-applicable" };

  const semiJoin = edge.parent;
  if (
    !input.currentNodes.has(semiJoin) ||
    !input.currentNodes.has(semiJoin.left.node) ||
    !input.currentNodes.has(edge.child)
  )
    return { kind: "rejected", reason: "semi-join-edge-is-not-current" };
  if (semiJoin.left.node === edge.child)
    return {
      kind: "rejected",
      reason: "semi-join-source-is-ambiguous-between-left-and-right",
    };
  if (
    edge.source !== semiJoin.right ||
    semiJoin.right.node !== edge.child ||
    !sourceIsCurrent(edge.source, input.sameFields) ||
    !sourceIsCurrent(semiJoin.left, input.sameFields) ||
    semiJoin.fields.length !== semiJoin.left.fields.length ||
    !input.sameFields(semiJoin.fields, semiJoin.left.fields)
  )
    return {
      kind: "rejected",
      reason: "semi-join-membership-source-or-left-output-is-stale",
    };

  const keys = analyzeSemiMembershipKeyCondition(semiJoin);
  if (keys.kind === "rejected")
    return {
      kind: "rejected",
      reason: `semi-join-membership-${keys.phase}-rejected: ${keys.reason}`,
    };

  return {
    kind: "proved",
    certificate: {
      kind: "semi-join-right-membership-observation",
      semiJoin,
      rightSource: semiJoin.right,
      condition: semiJoin.condition,
      leftKeyIndexes: keys.left,
      rightKeyIndexes: keys.right,
      comparisons: keys.comparisons,
    },
  };
}
