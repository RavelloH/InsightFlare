import { describe, expect, it } from "vitest";

import { eq, or, param, semiJoin, valuesRelation } from "@/lib/db";
import type { MaterializationConsumerEdge } from "@/lib/db/query/physical/materialization-selection";
import { proveSemiJoinMembershipObservation } from "@/lib/db/query/physical/membership-observation";
import type { QuerySource, SemiJoinNode } from "@/lib/db/query/plan";

function sameFields(
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

function membershipFixture() {
  const left = valuesRelation(
    { member: { affinity: "text", nullable: true } },
    [{ member: "a" }, { member: null }],
  );
  const right = valuesRelation(
    { member: { affinity: "text", nullable: true } },
    [{ member: "a" }, { member: "a" }, { member: null }],
  );
  const result = semiJoin(
    left,
    right,
    eq(left.columns.member!, right.columns.member!),
  );
  return { left, right, semiJoin: result.node as SemiJoinNode };
}

function rightEdge(
  parent: SemiJoinNode,
  source: QuerySource = parent.right,
): MaterializationConsumerEdge {
  return { parent, child: source.node, source, kind: "relation" };
}

describe("SemiJoin membership observation terminal", () => {
  it("proves only the exact current right membership edge, preserving NULL and bag semantics", () => {
    const { semiJoin: currentSemiJoin } = membershipFixture();
    const proof = proveSemiJoinMembershipObservation({
      edge: rightEdge(currentSemiJoin),
      currentNodes: new Set([
        currentSemiJoin,
        currentSemiJoin.left.node,
        currentSemiJoin.right.node,
      ]),
      sameFields,
    });

    expect(proof).toMatchObject({
      kind: "proved",
      certificate: {
        kind: "semi-join-right-membership-observation",
        semiJoin: currentSemiJoin,
        rightSource: currentSemiJoin.right,
        condition: currentSemiJoin.condition,
        leftKeyIndexes: [0],
        rightKeyIndexes: [0],
        comparisons: [
          {
            compatibility: "binary-text-family",
            leftDomain: {
              storageClasses: expect.arrayContaining(["text", "null"]),
            },
            rightDomain: {
              storageClasses: expect.arrayContaining(["text", "null"]),
            },
          },
        ],
      },
    });
  });

  it("rejects stale source metadata, a missing current consumer, and left/right ambiguity", () => {
    const { left, semiJoin: currentSemiJoin } = membershipFixture();
    const staleSource = {
      ...currentSemiJoin.right,
      fields: currentSemiJoin.right.fields.slice(1),
    } as QuerySource;
    expect(
      proveSemiJoinMembershipObservation({
        edge: rightEdge(currentSemiJoin, staleSource),
        currentNodes: new Set([
          currentSemiJoin,
          currentSemiJoin.left.node,
          currentSemiJoin.right.node,
        ]),
        sameFields,
      }),
    ).toMatchObject({ kind: "rejected" });
    expect(
      proveSemiJoinMembershipObservation({
        edge: rightEdge(currentSemiJoin),
        currentNodes: new Set([currentSemiJoin.right.node]),
        sameFields,
      }),
    ).toMatchObject({ kind: "rejected" });

    const ambiguous = semiJoin(
      left,
      left,
      eq(left.columns.member!, left.columns.member!),
    );
    expect(
      proveSemiJoinMembershipObservation({
        edge: rightEdge(ambiguous.node as SemiJoinNode),
        currentNodes: new Set([ambiguous.node as SemiJoinNode, left.node]),
        sameFields,
      }),
    ).toMatchObject({ kind: "rejected" });
  });

  it("does not certify disjunctions or other non-tuple conditions", () => {
    const { left, right } = membershipFixture();
    const result = semiJoin(
      left,
      right,
      or(
        eq(left.columns.member!, right.columns.member!),
        eq(left.columns.member!, param("other")),
      ),
    );
    expect(
      proveSemiJoinMembershipObservation({
        edge: rightEdge(result.node as SemiJoinNode),
        currentNodes: new Set([result.node, left.node, right.node]),
        sameFields,
      }),
    ).toMatchObject({ kind: "rejected" });
  });
});
