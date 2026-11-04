import {
  buildPhysicalParentIndex,
  proveDistinctUnionConsumerEquivalence,
} from "@/lib/db/query/physical/consumer-equivalence";
import type { SharedRelationDefinition } from "@/lib/db/query/physical/contracts";
import type { MaterializationConsumerEdge } from "@/lib/db/query/physical/materialization-selection";
import { proveSemiJoinMembershipObservation } from "@/lib/db/query/physical/membership-observation";
import type { PhysicalSharedRelationBoundaryEvidence } from "@/lib/db/query/physical/shared-relation-interfaces";
import type {
  LogicalQueryNode,
  QuerySource,
  UnionNode,
} from "@/lib/db/query/plan";

export interface MaterializationReaderContextProof {
  readonly passed: boolean;
  readonly readerContextCount: number;
  readonly relationReaderCount: number;
  readonly expressionReaderCount: number;
  readonly distinctRelationParentCount: number;
  readonly membershipObservationReaderCount: number;
  readonly allDirectRelationReadersMembershipObserved: boolean;
  readonly failureReasons: readonly string[];
  readonly readerPathFailures: readonly {
    readonly postorderIndex: number | null;
    readonly nodeKind: LogicalQueryNode["kind"];
    readonly definitionIndex: number | null;
    readonly hasCurrentInterface: boolean;
    readonly reason: string;
  }[];
  readonly readerContexts: readonly {
    readonly postorderIndex: number | null;
    readonly definitionIndex: number;
    readonly kind: "root-query" | "shared-definition";
    readonly relationPathEdgeCount: number;
    readonly expressionPathEdgeCount: number;
    readonly distinctUnionCount: number;
    readonly bodyPassed: boolean;
    readonly candidateBoundaryUsed: boolean;
    readonly bodyProof: "complete-producer-body" | "membership-observation";
    readonly membershipObservationTerminalCount: number;
    readonly allCandidatePathsClosed: boolean;
    readonly failureReasons: readonly string[];
    readonly passed: boolean;
  }[];
  readonly membershipObservationTerminals: readonly {
    readonly semiJoinPostorderIndex: number | null;
    readonly consumerContextPostorderIndex: number | null;
    readonly keyCount: number;
    readonly comparisonFamilies: readonly (
      "integer-rowid" | "binary-text-family"
    )[];
  }[];
  readonly membershipObservationRejections: readonly {
    readonly semiJoinPostorderIndex: number | null;
    readonly consumerContextPostorderIndex: number | null;
    readonly reason: string;
  }[];
  readonly distinctUnionContextCount: number;
  readonly distinctUnionProofs: readonly {
    readonly unionPostorderIndex: number | null;
    readonly consumerProducerPostorderIndex: number | null;
    readonly passed: boolean;
    readonly reason?: string;
  }[];
}

export function isCurrentMaterializationInterface(
  node: LogicalQueryNode,
  definition: SharedRelationDefinition | undefined,
  evidence: PhysicalSharedRelationBoundaryEvidence | undefined,
  sameFields: (
    left: QuerySource["fields"],
    right: QuerySource["fields"],
  ) => boolean,
): boolean {
  return Boolean(
    definition?.materialization === "materialized" &&
    definition.node === node &&
    definition.scope === node.scope &&
    sameFields(definition.fields, node.fields) &&
    evidence?.definition.name === definition.name &&
    evidence.definition.node === node &&
    evidence.definition.scope === node.scope &&
    sameFields(evidence.definition.fields, node.fields) &&
    evidence.definition.materializationSelection?.kind ===
      definition.materializationSelection?.kind &&
    evidence.definition.materializationSelection?.choiceIndex ===
      definition.materializationSelection?.choiceIndex &&
    evidence.boundary.kind === "materialized-relation" &&
    evidence.license.kind.length > 0 &&
    evidence.closure.kind === "scope-and-exported-columns-closed" &&
    evidence.totality.kind === "checked-through-current-boundaries",
  );
}

export function definitionsWithCurrentInterfaces(
  definitions: readonly SharedRelationDefinition[],
  interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >,
): readonly SharedRelationDefinition[] {
  return definitions.map(
    (definition) => interfaces.get(definition.node)?.definition ?? definition,
  );
}

export function materializationReaderContextProof(input: {
  readonly node: LogicalQueryNode;
  readonly root: LogicalQueryNode;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly edges: readonly MaterializationConsumerEdge[];
  readonly postorder: readonly LogicalQueryNode[];
  readonly interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly licensedBoundaryNodes: ReadonlySet<LogicalQueryNode>;
  readonly sameFields: (
    left: QuerySource["fields"],
    right: QuerySource["fields"],
  ) => boolean;
  readonly isSafeReader: (node: LogicalQueryNode) => boolean;
  readonly proveReaderBody?: (
    context: LogicalQueryNode,
    interfaces: ReadonlyMap<
      LogicalQueryNode,
      PhysicalSharedRelationBoundaryEvidence
    >,
    candidate: LogicalQueryNode,
  ) => {
    readonly passed: boolean;
    readonly candidateBoundaryUsed: boolean;
    readonly failureReasons?: readonly string[];
  };
}): MaterializationReaderContextProof {
  const direct = input.edges.filter(({ child }) => child === input.node);
  const relationEdges = direct.filter(({ kind }) => kind === "relation");
  const expressionReaderCount = direct.length - relationEdges.length;
  const directSourcesMatch = relationEdges.every(
    ({ child, source }) =>
      source.node === child &&
      source.scope === child.scope &&
      input.sameFields(source.fields, child.fields),
  );
  const definitionIndexes = new Map(
    input.definitions.map(({ node }, index) => [node, index] as const),
  );
  const candidateIndex = definitionIndexes.get(input.node);
  const counts = {
    relationReaderCount: relationEdges.length,
    expressionReaderCount,
    distinctRelationParentCount: new Set(
      relationEdges.map(({ parent }) => parent),
    ).size,
  };
  if (candidateIndex === undefined)
    return {
      passed: false,
      readerContextCount: 0,
      ...counts,
      membershipObservationReaderCount: 0,
      allDirectRelationReadersMembershipObserved: false,
      failureReasons: ["candidate-missing-from-current-definition-layout"],
      readerPathFailures: [],
      readerContexts: [],
      distinctUnionContextCount: 0,
      distinctUnionProofs: [],
      membershipObservationTerminals: [],
      membershipObservationRejections: [],
    };

  const isCurrentLicensedBoundary = (
    node: LogicalQueryNode,
    contextDefinitionIndex: number,
  ): boolean => {
    const definitionIndex = definitionIndexes.get(node);
    return Boolean(
      definitionIndex !== undefined &&
      definitionIndex < contextDefinitionIndex &&
      input.licensedBoundaryNodes.has(node) &&
      isCurrentMaterializationInterface(
        node,
        input.definitions[definitionIndex],
        input.interfaces.get(node),
        input.sameFields,
      ),
    );
  };

  const parents = new Map<LogicalQueryNode, MaterializationConsumerEdge[]>();
  const children = new Map<LogicalQueryNode, MaterializationConsumerEdge[]>();
  for (const edge of input.edges) {
    const incoming = parents.get(edge.child) ?? [];
    incoming.push(edge);
    parents.set(edge.child, incoming);
    const outgoing = children.get(edge.parent) ?? [];
    outgoing.push(edge);
    children.set(edge.parent, outgoing);
  }
  const parentIndex = buildPhysicalParentIndex(input.root);
  const postorderIndexes = new Map(
    input.postorder.map((node, index) => [node, index] as const),
  );
  const currentNodes = new Set(input.postorder);
  const membershipObservationReaderCount = relationEdges.filter(
    (edge) =>
      proveSemiJoinMembershipObservation({
        edge,
        currentNodes,
        sameFields: input.sameFields,
      }).kind === "proved",
  ).length;
  const allDirectRelationReadersMembershipObserved =
    relationEdges.length > 1 &&
    expressionReaderCount === 0 &&
    membershipObservationReaderCount === relationEdges.length;
  const readerPathFailures: MaterializationReaderContextProof["readerPathFailures"][number][] =
    [];
  const readerContexts: MaterializationReaderContextProof["readerContexts"][number][] =
    [];
  const distinctUnionContexts = new Map<UnionNode, Set<LogicalQueryNode>>();
  const recordReaderPathFailure = (
    node: LogicalQueryNode,
    reason: string,
  ): void => {
    const postorderIndex = postorderIndexes.get(node) ?? null;
    const definitionIndex = definitionIndexes.get(node) ?? null;
    if (
      !readerPathFailures.some(
        (failure) =>
          failure.postorderIndex === postorderIndex &&
          failure.reason === reason,
      )
    )
      readerPathFailures.push({
        postorderIndex,
        nodeKind: node.kind,
        definitionIndex,
        hasCurrentInterface: input.interfaces.has(node),
        reason,
      });
  };
  const failureReasons: string[] = [];
  if (!directSourcesMatch)
    failureReasons.push("reader-source-scope-or-fields-mismatch");
  if (relationEdges.length === 0)
    failureReasons.push("no-relation-reader-context");
  if (expressionReaderCount !== 0)
    failureReasons.push("expression-query-reader-present");
  let passed =
    directSourcesMatch &&
    relationEdges.length > 0 &&
    expressionReaderCount === 0;
  const membershipObservationTerminals: MaterializationReaderContextProof["membershipObservationTerminals"][number][] =
    [];
  const membershipObservationRejections: MaterializationReaderContextProof["membershipObservationRejections"][number][] =
    [];
  const contexts = [
    {
      node: input.root,
      kind: "root-query" as const,
      definitionIndex: input.definitions.length,
    },
    ...input.definitions.flatMap((definition, definitionIndex) =>
      definition.node !== input.node && definitionIndex > candidateIndex
        ? [
            {
              node: definition.node,
              kind: "shared-definition" as const,
              definitionIndex,
            },
          ]
        : [],
    ),
  ];
  for (const context of contexts) {
    const reachable = new Set<LogicalQueryNode>([context.node]);
    const pending = [context.node];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const edge of children.get(current) ?? []) {
        const child = edge.child;
        if (
          child !== input.node &&
          isCurrentLicensedBoundary(child, context.definitionIndex)
        )
          continue;
        if (reachable.has(child)) continue;
        reachable.add(child);
        pending.push(child);
      }
    }
    if (!reachable.has(input.node)) continue;

    const readerInterfaces = new Map<
      LogicalQueryNode,
      PhysicalSharedRelationBoundaryEvidence
    >();
    for (const [boundary, evidence] of input.interfaces) {
      const boundaryIndex = definitionIndexes.get(boundary);
      if (
        boundaryIndex !== undefined &&
        boundaryIndex < context.definitionIndex &&
        (boundary === input.node ||
          isCurrentLicensedBoundary(boundary, context.definitionIndex))
      )
        readerInterfaces.set(boundary, evidence);
    }
    const ancestorEdges = new Set<MaterializationConsumerEdge>();
    const ancestorNodes = new Set<LogicalQueryNode>([input.node]);
    const expandedAncestors = new Set<LogicalQueryNode>([input.node]);
    const terminalEdges = new Set<MaterializationConsumerEdge>();
    const reverse = [input.node];
    let reachesProducerBody = false;
    while (reverse.length > 0) {
      const child = reverse.pop()!;
      for (const edge of parents.get(child) ?? []) {
        const parent = edge.parent;
        if (!reachable.has(parent)) continue;
        if (
          parent !== context.node &&
          parent !== input.node &&
          isCurrentLicensedBoundary(parent, context.definitionIndex)
        )
          continue;
        const observation = proveSemiJoinMembershipObservation({
          edge,
          currentNodes,
          sameFields: input.sameFields,
        });
        if (observation.kind === "proved") {
          ancestorEdges.add(edge);
          terminalEdges.add(edge);
          membershipObservationTerminals.push({
            semiJoinPostorderIndex:
              postorderIndexes.get(observation.certificate.semiJoin) ?? null,
            consumerContextPostorderIndex:
              postorderIndexes.get(context.node) ?? null,
            keyCount: observation.certificate.leftKeyIndexes.length,
            comparisonFamilies: observation.certificate.comparisons.map(
              ({ compatibility }) => compatibility,
            ),
          });
          continue;
        }
        if (observation.kind === "rejected")
          membershipObservationRejections.push({
            semiJoinPostorderIndex: postorderIndexes.get(edge.parent) ?? null,
            consumerContextPostorderIndex:
              postorderIndexes.get(context.node) ?? null,
            reason: observation.reason,
          });
        ancestorEdges.add(edge);
        ancestorNodes.add(parent);
        if (parent === context.node) {
          reachesProducerBody = true;
          continue;
        }
        if (expandedAncestors.has(parent)) continue;
        expandedAncestors.add(parent);
        reverse.push(parent);
      }
    }
    const contextFailureReasons: string[] = [];
    for (const edge of ancestorEdges) {
      if (edge.kind !== "relation") {
        contextFailureReasons.push(
          "expression-query-edge-is-not-a-relation-reader",
        );
        recordReaderPathFailure(
          edge.parent,
          "expression-query-edge-is-not-a-relation-reader",
        );
      }
      if (
        edge.source.node !== edge.child ||
        edge.source.scope !== edge.child.scope ||
        !input.sameFields(edge.source.fields, edge.child.fields)
      ) {
        contextFailureReasons.push("reader-source-scope-or-fields-mismatch");
        recordReaderPathFailure(
          edge.parent,
          "reader-source-scope-or-fields-mismatch",
        );
      }
      if (
        !terminalEdges.has(edge) &&
        edge.parent !== context.node &&
        !input.isSafeReader(edge.parent)
      ) {
        contextFailureReasons.push("reader-path-node-is-not-total-and-closed");
        recordReaderPathFailure(
          edge.parent,
          "reader-path-node-is-not-total-and-closed",
        );
      }
    }
    for (const reader of ancestorNodes) {
      if (
        reader === input.node ||
        reader === context.node ||
        isCurrentLicensedBoundary(reader, context.definitionIndex)
      )
        continue;
      if (!input.isSafeReader(reader)) continue;
      if (!input.proveReaderBody) continue;
      const pathBody = input.proveReaderBody(
        reader,
        readerInterfaces,
        input.node,
      );
      if (!pathBody.passed) {
        contextFailureReasons.push(
          ...(pathBody.failureReasons?.length
            ? pathBody.failureReasons
            : ["reader-path-body-is-not-total-and-closed"]),
        );
        recordReaderPathFailure(
          reader,
          pathBody.failureReasons?.[0] ??
            "reader-path-body-is-not-total-and-closed",
        );
      }
      if (!pathBody.candidateBoundaryUsed) {
        contextFailureReasons.push(
          "reader-path-body-does-not-use-current-candidate-boundary",
        );
        recordReaderPathFailure(
          reader,
          "reader-path-body-does-not-use-current-candidate-boundary",
        );
      }
    }
    const allCandidatePathsClosed =
      terminalEdges.size > 0 && !reachesProducerBody;
    const bodyProof = allCandidatePathsClosed
      ? "membership-observation"
      : "complete-producer-body";
    const body =
      bodyProof === "membership-observation"
        ? {
            passed: false,
            candidateBoundaryUsed: false,
            failureReasons: [] as readonly string[],
          }
        : input.proveReaderBody
          ? input.proveReaderBody(context.node, readerInterfaces, input.node)
          : {
              passed: input.isSafeReader(context.node),
              candidateBoundaryUsed: true,
              failureReasons: [] as readonly string[],
            };
    if (!allCandidatePathsClosed && !body.passed) {
      contextFailureReasons.push(
        ...(body.failureReasons?.length
          ? body.failureReasons
          : ["reader-context-body-is-not-total-and-closed"]),
      );
      recordReaderPathFailure(
        context.node,
        body.failureReasons?.[0] ??
          "reader-context-body-is-not-total-and-closed",
      );
    }
    if (!allCandidatePathsClosed && !body.candidateBoundaryUsed) {
      contextFailureReasons.push(
        "candidate-is-not-a-current-boundary-in-reader-context",
      );
      recordReaderPathFailure(
        context.node,
        "candidate-is-not-a-current-boundary-in-reader-context",
      );
    }
    const unions = [...ancestorNodes].filter(
      (node): node is UnionNode => node.kind === "union" && !node.all,
    );
    for (const union of unions) {
      const unionContexts = distinctUnionContexts.get(union) ?? new Set();
      unionContexts.add(context.node);
      distinctUnionContexts.set(union, unionContexts);
    }
    const contextPassed =
      contextFailureReasons.length === 0 &&
      (allCandidatePathsClosed || (body.passed && body.candidateBoundaryUsed));
    passed &&= contextPassed;
    if (!contextPassed)
      failureReasons.push("reader-path-does-not-reach-a-current-producer");
    readerContexts.push({
      postorderIndex: postorderIndexes.get(context.node) ?? null,
      definitionIndex: context.definitionIndex,
      kind: context.kind,
      relationPathEdgeCount: [...ancestorEdges].filter(
        (edge) => edge.kind === "relation",
      ).length,
      expressionPathEdgeCount: [...ancestorEdges].filter(
        (edge) => edge.kind === "expression",
      ).length,
      distinctUnionCount: unions.length,
      bodyPassed: body.passed,
      candidateBoundaryUsed: body.candidateBoundaryUsed,
      bodyProof,
      membershipObservationTerminalCount: terminalEdges.size,
      allCandidatePathsClosed,
      failureReasons: [...new Set(contextFailureReasons)],
      passed: contextPassed,
    });
  }
  if (readerContexts.length === 0) {
    passed = false;
    failureReasons.push("reader-context-has-no-current-producer");
  }

  const distinctUnionProofs: MaterializationReaderContextProof["distinctUnionProofs"][number][] =
    [];
  for (const [union, unionContexts] of distinctUnionContexts) {
    for (const producer of unionContexts) {
      const consumerProducerIndex =
        producer === input.root
          ? input.definitions.length
          : definitionIndexes.get(producer);
      if (consumerProducerIndex === undefined) {
        passed = false;
        failureReasons.push("distinct-union-consumer-context-is-not-current");
        distinctUnionProofs.push({
          unionPostorderIndex: postorderIndexes.get(union) ?? null,
          consumerProducerPostorderIndex:
            postorderIndexes.get(producer) ?? null,
          passed: false,
          reason: "consumer-context-is-not-current",
        });
        continue;
      }
      const contextInterfaces = new Map<
        LogicalQueryNode,
        PhysicalSharedRelationBoundaryEvidence
      >();
      for (const [boundary, evidence] of input.interfaces) {
        const boundaryIndex = definitionIndexes.get(boundary);
        if (
          boundaryIndex !== undefined &&
          boundaryIndex < consumerProducerIndex &&
          (boundary === input.node ||
            isCurrentLicensedBoundary(boundary, consumerProducerIndex))
        )
          contextInterfaces.set(boundary, evidence);
      }
      const proof = proveDistinctUnionConsumerEquivalence({
        root: input.root,
        union,
        definitions: definitionsWithCurrentInterfaces(
          input.definitions,
          contextInterfaces,
        ),
        interfaces: contextInterfaces,
        consumerProducer: producer,
        consumerProducerIndex,
        index: parentIndex,
      });
      passed &&= proof.passed;
      if (!proof.passed)
        failureReasons.push(
          proof.reason ?? "distinct-union-consumer-equivalence-failed",
        );
      distinctUnionProofs.push({
        unionPostorderIndex: postorderIndexes.get(union) ?? null,
        consumerProducerPostorderIndex: postorderIndexes.get(producer) ?? null,
        passed: proof.passed,
        ...(!proof.passed && proof.reason ? { reason: proof.reason } : {}),
      });
    }
  }
  return {
    passed,
    readerContextCount: readerContexts.length,
    ...counts,
    membershipObservationReaderCount,
    allDirectRelationReadersMembershipObserved,
    failureReasons: [...new Set(failureReasons)],
    readerPathFailures,
    readerContexts,
    distinctUnionContextCount: distinctUnionContexts.size,
    distinctUnionProofs,
    membershipObservationTerminals,
    membershipObservationRejections,
  };
}
