import type {
  AnalysisResultNode,
  DistinctNode,
  FilterNode,
  ProjectNode,
  SourceMembershipInput,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";

export interface ProgramMembershipConstantFold {
  readonly imported: AnalysisResultNode;
  readonly role: SourceMembershipInput["role"];
  /** Actual visible operators implemented by this single physical fold. */
  readonly logicalNodes: readonly (
    AnalysisResultNode | FilterNode | ProjectNode | DistinctNode
  )[];
}

/** A constant fold of actual visible IR, not an alternative Source resolver.
 * Only identity Project and a complete pair Distinct may follow the literal
 * kind Filter. The entity-only two-column producer needs no kind operation.
 * Unknown expressions remain unsupported; no expression is evaluated here. */
export function matchProgramMembershipConstantFold(
  plan: ValidatedLogicalPlan,
  edge: SourceMembershipInput,
): ProgramMembershipConstantFold | undefined {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const distinct = nodes.get(edge.input);
  if (
    distinct?.kind !== "distinct" ||
    distinct.excludeNull ||
    distinct.keys.length !== 2 ||
    distinct.output.length !== 2 ||
    distinct.keys[0]?.output !== edge.siteId ||
    distinct.keys[1]?.output !== edge.memberId
  )
    return undefined;
  const projected = nodes.get(distinct.input);
  if (projected?.kind !== "project") return undefined;
  // Even hidden grain projections must be plain visible slot identities.
  if (projected.projections.some((item) => item.expression.kind !== "slot"))
    return undefined;
  const siteProjection = projected.projections.find(
    (item) => item.slot === distinct.keys[0]!.input,
  );
  const idProjection = projected.projections.find(
    (item) => item.slot === distinct.keys[1]!.input,
  );
  if (
    siteProjection?.expression.kind !== "slot" ||
    idProjection?.expression.kind !== "slot"
  )
    return undefined;
  const predecessor = nodes.get(projected.input);
  const imported =
    predecessor?.kind === "filter" ? nodes.get(predecessor.input) : predecessor;
  if (imported?.kind !== "analysis-result" || imported.execution !== "program")
    return undefined;
  const output = imported.childPlan.outputs.find(
    (item) => item.id === imported.outputId,
  );
  if (!output) return undefined;
  const names = output.fields.map((item) => item.name).join("/");
  const kinded = names === "site_id/match_kind/match_id";
  if (!kinded && names !== "site_id/entity_id") return undefined;
  if (
    imported.mappings.length !== output.fields.length ||
    imported.output.length !== output.fields.length
  )
    return undefined;
  const mapped = (name: string) =>
    imported.mappings.find((item) => item.field === name)?.slot;
  const site = mapped("site_id"),
    id = mapped(kinded ? "match_id" : "entity_id");
  if (
    site === undefined ||
    id === undefined ||
    siteProjection.expression.slot !== site ||
    idProjection.expression.slot !== id
  )
    return undefined;
  // Discarded hidden slots may only preserve the actual imported grain.
  if (
    projected.projections.some(
      (item) =>
        item.expression.kind !== "slot" ||
        !imported.output.includes(item.expression.slot),
    )
  )
    return undefined;
  const declarations = new Map(
    imported.childPlan.slots.map((slot) => [slot.id, slot]),
  );
  if (
    output.fields.some((field) => {
      const slot = declarations.get(field.slot);
      return (
        !slot ||
        slot.nullable ||
        slot.type.kind !== "scalar" ||
        slot.type.scalar !== "string"
      );
    })
  )
    return undefined;
  if (kinded) {
    if (predecessor?.kind !== "filter") return undefined;
    const predicate = predecessor.predicate;
    if (
      predicate.kind !== "comparison" ||
      predicate.operator !== "eq" ||
      predicate.stringNormalization !== undefined ||
      predicate.left.kind !== "slot" ||
      predicate.left.slot !== mapped("match_kind") ||
      predicate.right.kind !== "literal" ||
      predicate.right.value !== edge.role ||
      predicate.right.valueType.kind !== "scalar" ||
      predicate.right.valueType.scalar !== "string"
    )
      return undefined;
  } else if (predecessor !== imported || edge.role !== "entity")
    return undefined;
  return Object.freeze({
    imported,
    role: edge.role,
    logicalNodes: Object.freeze(
      predecessor?.kind === "filter"
        ? [imported, predecessor, projected, distinct]
        : [imported, projected, distinct],
    ),
  });
}
