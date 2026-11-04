import type { SharedRelationDefinition } from "@/lib/db/query/physical/contracts";
import type { SelfMembershipDerivationContext } from "@/lib/db/query/physical/self-membership";
import type { PhysicalSharedRelationBoundaryEvidence } from "@/lib/db/query/physical/shared-relation-interfaces";
import type {
  LogicalQueryNode,
  ProjectNode,
  QuerySource,
} from "@/lib/db/query/plan";

export function createSelfMembershipDerivationContext(input: {
  readonly root: LogicalQueryNode;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly boundaries: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly sourcesOf: (node: LogicalQueryNode) => readonly QuerySource[];
  readonly sameFields: (
    left: QuerySource["fields"],
    right: QuerySource["fields"],
  ) => boolean;
  readonly isSafeNode: (node: LogicalQueryNode) => boolean;
}): SelfMembershipDerivationContext {
  const definitionIndex = new Map(
    input.definitions.map(({ node }, index) => [node, index] as const),
  );
  const producers = [
    ...input.definitions.map(({ node }, index) => ({ node, index })),
    { node: input.root, index: input.definitions.length },
  ];
  const isCurrentBoundary = (node: LogicalQueryNode): boolean => {
    const definition = input.definitions[definitionIndex.get(node) ?? -1];
    const evidence = input.boundaries.get(node);
    return Boolean(
      definition?.materialization === "materialized" &&
      definition.node === node &&
      definition.scope === node.scope &&
      input.sameFields(definition.fields, node.fields) &&
      evidence?.definition.name === definition.name &&
      evidence.definition.node === node &&
      evidence.definition.scope === node.scope &&
      input.sameFields(evidence.definition.fields, node.fields) &&
      evidence.boundary.kind === "materialized-relation" &&
      evidence.license.kind.length > 0 &&
      evidence.closure.kind === "scope-and-exported-columns-closed" &&
      evidence.totality.kind === "checked-through-current-boundaries",
    );
  };

  const reachedProjectsByProducer = new Map<
    LogicalQueryNode,
    ReadonlySet<ProjectNode>
  >();
  for (const producer of producers) {
    const reached = new Set<ProjectNode>();
    const active = new Set<LogicalQueryNode>();
    const visited = new Set<LogicalQueryNode>();
    let sourceMetadataIsCurrent = true;
    const visit = (node: LogicalQueryNode): void => {
      if (active.has(node) || visited.has(node)) return;
      active.add(node);
      if (node.kind === "project") reached.add(node);
      const boundaryIndex = definitionIndex.get(node);
      if (
        node !== producer.node &&
        boundaryIndex !== undefined &&
        boundaryIndex < producer.index &&
        isCurrentBoundary(node)
      ) {
        active.delete(node);
        visited.add(node);
        return;
      }
      for (const source of input.sourcesOf(node)) {
        if (
          source.scope !== source.node.scope ||
          !input.sameFields(source.fields, source.node.fields)
        ) {
          sourceMetadataIsCurrent = false;
          continue;
        }
        visit(source.node);
      }
      active.delete(node);
      visited.add(node);
    };
    visit(producer.node);
    reachedProjectsByProducer.set(
      producer.node,
      sourceMetadataIsCurrent ? reached : new Set(),
    );
  }

  return {
    definitions: input.definitions,
    boundaries: input.boundaries,
    producerFor: (project) => {
      const contexts = producers.filter(({ node }) =>
        reachedProjectsByProducer.get(node)?.has(project),
      );
      return contexts.length === 1 ? contexts[0] : undefined;
    },
    safeFilter: (node) => node.kind === "filter" && input.isSafeNode(node),
    safeInnerJoin: (node) =>
      node.kind === "join" &&
      node.joinType === "inner" &&
      input.isSafeNode(node),
  };
}
