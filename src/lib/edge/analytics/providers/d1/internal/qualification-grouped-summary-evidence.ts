import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";

interface LogicalSummaryNode {
  readonly id: RelationId;
  readonly kind: string;
  readonly input?: RelationId;
  readonly groups?: readonly unknown[];
}

interface LoweredSummaryRelation {
  readonly node: {
    readonly kind: string;
    readonly groups?: readonly unknown[];
  };
  readonly fields: readonly unknown[];
}

interface PhysicalSharedRelation {
  readonly node: object;
  readonly materialization: string;
  readonly fields: readonly unknown[];
}

export interface GroupedSummaryRelationEvidence {
  readonly relationId: RelationId;
  readonly lowered?: LoweredSummaryRelation;
  readonly nodeKind: string | null;
  readonly groupKeyCount: number | null;
  readonly fieldCount: number | null;
  readonly matchingSharedRelationCount: number;
  readonly materialization: string | null;
  readonly sharedRelations: readonly {
    readonly nodeKind: string;
    readonly materialization: string;
    readonly fieldCount: number;
    readonly sameNode: boolean;
  }[];
  readonly validShape: boolean;
  readonly materialized: boolean;
}

/**
 * Prove each bounded grouped summary against both the logical graph and the
 * physical shared-relation graph. Event-candidate reports use two summaries;
 * the same checks keep their admission evidence aligned across compilers.
 */
export function proveGroupedSummaryRelations(input: {
  readonly relationIds: readonly RelationId[];
  readonly planNodes: readonly LogicalSummaryNode[];
  readonly physicalSharedRelations: readonly PhysicalSharedRelation[];
  readonly lowerRelation: (
    relationId: RelationId,
  ) => LoweredSummaryRelation | undefined;
}): {
  readonly valid: boolean;
  readonly entries: readonly GroupedSummaryRelationEvidence[];
} {
  const uniqueIds = new Set(input.relationIds);
  const entries = input.relationIds.map((relationId) => {
    const node = input.planNodes.find(
      (candidate) => candidate.id === relationId,
    );
    const inputNode =
      node?.kind === "aggregate" && node.input !== undefined
        ? input.planNodes.find((candidate) => candidate.id === node.input)
        : undefined;
    const lowered = input.lowerRelation(relationId);
    const matching = lowered
      ? input.physicalSharedRelations.filter(
          (relation) => relation.node === lowered.node,
        )
      : [];
    const validShape =
      node?.kind === "aggregate" &&
      node.groups?.length === 2 &&
      inputNode?.kind === "limit" &&
      lowered?.node.kind === "aggregate" &&
      lowered.node.groups?.length === 2 &&
      lowered.fields.length <= 16;
    const materialized =
      matching.length === 1 &&
      matching[0]!.materialization === "materialized" &&
      matching[0]!.fields.length <= 16;

    return Object.freeze({
      relationId,
      ...(lowered ? { lowered } : {}),
      nodeKind: lowered?.node.kind ?? null,
      groupKeyCount:
        lowered?.node.kind === "aggregate"
          ? (lowered.node.groups?.length ?? null)
          : null,
      fieldCount: lowered?.fields.length ?? null,
      matchingSharedRelationCount: matching.length,
      materialization:
        matching.length === 1 ? matching[0]!.materialization : null,
      sharedRelations: Object.freeze(
        input.physicalSharedRelations.map((relation) =>
          Object.freeze({
            nodeKind:
              (relation.node as { readonly kind?: string }).kind ?? "unknown",
            materialization: relation.materialization,
            fieldCount: relation.fields.length,
            sameNode: relation.node === lowered?.node,
          }),
        ),
      ),
      validShape,
      materialized,
    });
  });

  return Object.freeze({
    valid:
      input.relationIds.length > 0 &&
      uniqueIds.size === input.relationIds.length &&
      entries.every(
        ({ validShape, materialized }) => validShape && materialized,
      ),
    entries: Object.freeze(entries),
  });
}
