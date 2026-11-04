import type { SharedRelationDefinition } from "@/lib/db/query/physical/contracts";
import type {
  CandidateFacts,
  MaterializedBoundaryContext,
  StrictStageReaderContext,
} from "@/lib/db/query/physical/materialization-context";
import { sharedRelationLayoutWithStagePlaceholders } from "@/lib/db/query/physical/materialization-context";
import { materializationReaderContextProof } from "@/lib/db/query/physical/materialization-reader-context";
import {
  type MaterializationProofAssessment,
  selectStrictRankStages,
} from "@/lib/db/query/physical/materialization-selection";
import type { PhysicalSharedRelationBoundaryEvidence } from "@/lib/db/query/physical/shared-relation-interfaces";
import type { LogicalQueryNode, QuerySource } from "@/lib/db/query/plan";

export interface StrictRankStageReviewResult {
  readonly stageProof: ReturnType<typeof selectStrictRankStages>;
  readonly selectedStageNodes: readonly LogicalQueryNode[];
  readonly provisionalDefinitions: readonly SharedRelationDefinition[];
  readonly strictStageReaderContext: StrictStageReaderContext;
}

export function reviewStrictRankStages(input: {
  readonly root: LogicalQueryNode;
  readonly postorder: readonly LogicalQueryNode[];
  readonly closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>;
  readonly stageBaseDefinitions: readonly SharedRelationDefinition[];
  readonly edges: Parameters<typeof selectStrictRankStages>[0]["edges"];
  readonly sourcesOf: (node: LogicalQueryNode) => readonly QuerySource[];
  readonly independentAutoBoundaryContext: Pick<
    MaterializedBoundaryContext,
    "interfaces"
  >;
  readonly candidateFacts: (
    node: LogicalQueryNode,
    closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>,
    boundaries: ReadonlyMap<
      LogicalQueryNode,
      PhysicalSharedRelationBoundaryEvidence
    >,
    requireTotalExpressions: boolean,
    allowRankOnePartitionedRowNumberProof: boolean,
  ) => CandidateFacts;
  readonly candidateFactsAreClosed: (
    facts: CandidateFacts,
    boundaries: ReadonlyMap<
      LogicalQueryNode,
      PhysicalSharedRelationBoundaryEvidence
    >,
  ) => boolean;
  readonly sameFields: (
    left: QuerySource["fields"],
    right: QuerySource["fields"],
  ) => boolean;
  readonly isSafeReader: (node: LogicalQueryNode) => boolean;
}): StrictRankStageReviewResult {
  const stageBodyFacts = new Map<LogicalQueryNode, CandidateFacts>();
  const proveMaterializationReaderBody = (
    context: LogicalQueryNode,
    boundaries: ReadonlyMap<
      LogicalQueryNode,
      PhysicalSharedRelationBoundaryEvidence
    >,
    candidate: LogicalQueryNode,
  ) => {
    const facts = input.candidateFacts(
      context,
      input.closedWindowScopeMemo,
      boundaries,
      true,
      true,
    );
    const closed = input.candidateFactsAreClosed(facts, boundaries);
    // An output sort is a consumer of the stage, not part of its body.
    const forbiddenReaderShape =
      facts.forbidden &&
      (facts.unsafe || !facts.sortBarrier || facts.limitBarrier);
    const failureReasons = [
      ...(forbiddenReaderShape
        ? ["reader-context-body-has-forbidden-boundary"]
        : []),
      ...(facts.unsafe ? ["reader-context-body-is-not-total"] : []),
      ...(!closed ? ["reader-context-body-is-not-closed"] : []),
    ];
    return {
      passed: !forbiddenReaderShape && !facts.unsafe && closed,
      candidateBoundaryUsed: facts.materializedBoundariesUsed.has(candidate),
      failureReasons,
    };
  };
  const makeReaderContext = (
    stageNodes: readonly LogicalQueryNode[],
    licensedStageNodes: readonly LogicalQueryNode[] = [],
  ): StrictStageReaderContext => {
    const stageNodeSet = new Set(stageNodes);
    const placeholderDefinitions = sharedRelationLayoutWithStagePlaceholders(
      input.postorder,
      input.stageBaseDefinitions,
      stageNodes,
      input.sourcesOf,
    );
    const definitions = placeholderDefinitions.map((definition) =>
      stageNodeSet.has(definition.node)
        ? {
            ...definition,
            materialization: "materialized" as const,
            materializationSelection: {
              kind: "strict-serial-rank-stage" as const,
              choiceIndex: input.postorder.indexOf(definition.node),
            },
          }
        : definition,
    );
    const interfaces = new Map(input.independentAutoBoundaryContext.interfaces);
    for (const definition of definitions) {
      if (!stageNodeSet.has(definition.node)) continue;
      const facts = stageBodyFacts.get(definition.node);
      if (!facts) continue;
      interfaces.set(definition.node, {
        definition,
        selective: facts.selective,
        boundary: { kind: "materialized-relation" },
        license: { kind: "strict-serial-rank-stage" },
        closure: {
          kind: "scope-and-exported-columns-closed",
          scopeCount: facts.scopes.size,
          referencedScopeCount: new Set(facts.referencedScopes).size,
          referencedColumnCount: facts.referencedColumns.length,
        },
        totality: {
          kind: "checked-through-current-boundaries",
          stoppedAt: [...facts.materializedBoundariesUsed],
        },
      });
    }
    const licensedBoundaryNodes = new Set(
      input.independentAutoBoundaryContext.interfaces.keys(),
    );
    for (const node of licensedStageNodes)
      if (interfaces.has(node)) licensedBoundaryNodes.add(node);
    return { definitions, interfaces, licensedBoundaryNodes };
  };

  let bodyQualifiedReaderContext: StrictStageReaderContext | undefined;
  const stageProof = selectStrictRankStages({
    root: input.root,
    nodes: input.postorder,
    baseDefinitions: input.stageBaseDefinitions,
    edges: input.edges,
    sourcesOf: input.sourcesOf,
    prepareReaderContext: (bodyQualifiedNodes) => {
      // Candidate cuts may bound provisional proof paths during DP selection.
      // The selected subset is freshly revalidated in the final boundary pass.
      bodyQualifiedReaderContext = makeReaderContext(
        bodyQualifiedNodes,
        bodyQualifiedNodes,
      );
    },
    proveBody: (node) => {
      const facts = input.candidateFacts(
        node,
        input.closedWindowScopeMemo,
        input.independentAutoBoundaryContext.interfaces,
        true,
        true,
      );
      stageBodyFacts.set(node, facts);
      const closed = input.candidateFactsAreClosed(
        facts,
        input.independentAutoBoundaryContext.interfaces,
      );
      const failureReasons = [
        ...(!facts.selective ? ["body-is-not-selective"] : []),
        ...(facts.forbidden ? ["body-has-forbidden-boundary"] : []),
        ...(facts.unsafe
          ? ["body-is-not-total-through-current-boundaries"]
          : []),
        ...(!closed ? ["body-scope-or-exported-columns-are-not-closed"] : []),
      ];
      const passed =
        facts.selective && !facts.forbidden && !facts.unsafe && closed;
      return {
        passed,
        ...(failureReasons[0] ? { reason: failureReasons[0] } : {}),
        details: {
          selective: facts.selective,
          forbidden: facts.forbidden,
          unsafe: facts.unsafe,
          closed,
          materializedBoundaryCount: facts.materializedBoundariesUsed.size,
          scopeCount: facts.scopes.size,
          referencedScopeCount: new Set(facts.referencedScopes).size,
          referencedColumnCount: facts.referencedColumns.length,
          failureReasons,
        },
      } satisfies MaterializationProofAssessment;
    },
    proveReaders: (node) => {
      if (!bodyQualifiedReaderContext)
        return {
          passed: false,
          reason: "body-qualified-reader-context-was-not-prepared",
        };
      const proof = materializationReaderContextProof({
        node,
        root: input.root,
        definitions: bodyQualifiedReaderContext.definitions,
        edges: input.edges,
        postorder: input.postorder,
        interfaces: bodyQualifiedReaderContext.interfaces,
        licensedBoundaryNodes: bodyQualifiedReaderContext.licensedBoundaryNodes,
        sameFields: input.sameFields,
        proveReaderBody: proveMaterializationReaderBody,
        isSafeReader: input.isSafeReader,
      });
      const relationReadersAreCovered =
        proof.relationReaderCount === 1 ||
        proof.allDirectRelationReadersMembershipObserved;
      const passed =
        proof.passed &&
        relationReadersAreCovered &&
        proof.expressionReaderCount === 0;
      const failureReasons = [
        ...proof.failureReasons,
        ...(!relationReadersAreCovered
          ? [
              proof.relationReaderCount > 1
                ? "strict-stage-has-unobserved-multiple-relation-readers"
                : "strict-stage-requires-one-relation-reader",
            ]
          : []),
        ...(proof.expressionReaderCount !== 0
          ? ["strict-stage-has-expression-query-reader"]
          : []),
      ];
      return {
        passed,
        ...(failureReasons[0] ? { reason: failureReasons[0] } : {}),
        details: {
          readerContextCount: proof.readerContextCount,
          relationReaderCount: proof.relationReaderCount,
          expressionReaderCount: proof.expressionReaderCount,
          distinctRelationParentCount: proof.distinctRelationParentCount,
          membershipObservationReaderCount:
            proof.membershipObservationReaderCount,
          allDirectRelationReadersMembershipObserved:
            proof.allDirectRelationReadersMembershipObserved,
          failureReasons,
          readerPathFailures: proof.readerPathFailures,
          readerContexts: proof.readerContexts,
          distinctUnionContextCount: proof.distinctUnionContextCount,
          distinctUnionProofs: proof.distinctUnionProofs,
          membershipObservationTerminals: proof.membershipObservationTerminals,
          membershipObservationRejections:
            proof.membershipObservationRejections,
        },
      } satisfies MaterializationProofAssessment;
    },
  });
  const selectedStageNodes = stageProof.selected.map(({ node }) => node);
  const provisionalDefinitions = sharedRelationLayoutWithStagePlaceholders(
    input.postorder,
    input.stageBaseDefinitions,
    selectedStageNodes,
    input.sourcesOf,
  );
  const strictStageReaderContext = makeReaderContext(
    selectedStageNodes,
    selectedStageNodes,
  );
  return {
    stageProof,
    selectedStageNodes,
    provisionalDefinitions,
    strictStageReaderContext,
  };
}
