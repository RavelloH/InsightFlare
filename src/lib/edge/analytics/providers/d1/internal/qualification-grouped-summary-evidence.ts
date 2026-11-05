import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalNode } from "@/lib/edge/analytics/engine/logical/nodes";

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

function isAdmittedRowsProject(
  projectId: RelationId,
  nodes: readonly LogicalNode[],
): boolean {
  const project = nodes.find((node) => node.id === projectId);
  if (project?.kind !== "project") return false;
  const join = nodes.find((node) => node.id === project.input);
  if (
    join?.kind !== "join" ||
    join.joinType !== "inner" ||
    join.keys.length !== 0
  )
    return false;
  const bounded = nodes.find((node) => node.id === join.left);
  const admitted = nodes.find((node) => node.id === join.right);
  if (bounded?.kind !== "limit" || !admitted) return false;
  let gate: LogicalNode | undefined;
  if (admitted.kind === "filter") {
    gate = admitted;
  } else if (admitted.kind === "project") {
    const [marker] = admitted.projections;
    if (
      admitted.output.length !== 1 ||
      admitted.projections.length !== 1 ||
      marker?.slot !== admitted.output[0] ||
      marker.expression.kind !== "literal" ||
      marker.expression.value !== 1 ||
      marker.expression.valueType.kind !== "scalar" ||
      marker.expression.valueType.scalar !== "number"
    )
      return false;
    gate = nodes.find((node) => node.id === admitted.input);
  }
  if (gate?.kind !== "filter") return false;
  const counter = nodes.find((node) => node.id === gate.input);
  if (counter?.kind !== "aggregate") return false;
  const countMeasure = counter.measures[0];
  if (
    counter.input !== bounded.id ||
    counter.groups.length !== 0 ||
    counter.measures.length !== 1 ||
    countMeasure?.kind !== "count-rows" ||
    counter.output.length !== 1 ||
    counter.output[0] !== countMeasure.output ||
    gate.output.length !== counter.output.length ||
    gate.output[0] !== counter.output[0]
  )
    return false;

  const predicate = gate.predicate;
  if (
    !Number.isSafeInteger(bounded.count) ||
    bounded.count <= 1 ||
    predicate.kind !== "comparison" ||
    predicate.operator !== "lte" ||
    predicate.left.kind !== "slot" ||
    predicate.left.slot !== countMeasure.output ||
    predicate.right.kind !== "literal" ||
    typeof predicate.right.value !== "number" ||
    !Number.isSafeInteger(predicate.right.value) ||
    predicate.right.value !== bounded.count - 1 ||
    join.output.length !== bounded.output.length + admitted.output.length ||
    join.output
      .slice(0, bounded.output.length)
      .some((slot, index) => slot !== bounded.output[index]) ||
    join.output
      .slice(bounded.output.length)
      .some((slot, index) => slot !== admitted.output[index]) ||
    project.projections.length !== bounded.output.length ||
    project.output.length !== bounded.output.length ||
    project.projections.some(
      ({ slot, expression }, index) =>
        slot !== project.output[index] ||
        expression.kind !== "slot" ||
        expression.slot !== bounded.output[index],
    )
  )
    return false;
  return true;
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
  readonly planNodes: readonly LogicalNode[];
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
      (inputNode?.kind === "limit" ||
        (inputNode?.kind === "project" &&
          isAdmittedRowsProject(inputNode.id, input.planNodes))) &&
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
