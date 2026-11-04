import type { SharedRelationDefinition } from "@/lib/db/query/physical/contracts";
import type { MaterializedBoundaryContext } from "@/lib/db/query/physical/materialization-context";
import type { BalancedStageProof } from "@/lib/db/query/physical/materialization-selection";
import type { LogicalQueryNode } from "@/lib/db/query/plan";

export type MaterializationDiagnosticSink = (
  diagnostic: Readonly<Record<string, unknown>>,
) => void;

export interface MaterializationReaderAuditRound {
  readonly round: number;
  readonly readerContextInterfaceCount: number;
  readonly outputInterfaceCount: number;
  readonly interfacePostorderIndexes: readonly number[];
  readonly stable: boolean;
}

function countBy(values: readonly string[]): Readonly<Record<string, number>> {
  return Object.fromEntries(
    [...new Set(values)]
      .sort()
      .map((value) => [value, values.filter((item) => item === value).length]),
  );
}

function definitionSummary(definitions: readonly SharedRelationDefinition[]) {
  return {
    total: definitions.length,
    materialized: definitions.filter(
      ({ materialization }) => materialization === "materialized",
    ).length,
    automatic: definitions.filter(
      ({ materialization }) => materialization === "auto",
    ).length,
  };
}

function boundarySummary(context: MaterializedBoundaryContext) {
  return {
    interfaceCount: context.interfaces.size,
    checkedDefinitionCount: context.materializedDefinitionsChecked,
    licenses: countBy(
      [...context.interfaces.values()].map(({ license }) => license.kind),
    ),
    vetoes: countBy([...context.vetoes.values()]),
    promotionDiagnostics: context.promotionDiagnostics,
  };
}

export function emitMaterializationDiagnostic(input: {
  readonly sink?: MaterializationDiagnosticSink;
  readonly logicalPostorderNodeCount: number;
  readonly postorder: readonly LogicalQueryNode[];
  readonly initialDefinitions: readonly SharedRelationDefinition[];
  readonly baseDefinitions: readonly SharedRelationDefinition[];
  readonly stageBaseDefinitions: readonly SharedRelationDefinition[];
  readonly initialBoundary: MaterializedBoundaryContext;
  readonly independentAutoBoundary: MaterializedBoundaryContext;
  readonly stageProof: BalancedStageProof;
  readonly selectedStageNodes: readonly LogicalQueryNode[];
  readonly provisionalBoundary: MaterializedBoundaryContext;
  readonly acceptedStageCount: number;
  readonly finalReaderAuditStable: boolean;
  readonly finalReaderAuditRounds: readonly MaterializationReaderAuditRound[];
  readonly fallbackTriggered: boolean;
  readonly fallbackBoundary?: MaterializedBoundaryContext;
  readonly finalBoundary: MaterializedBoundaryContext;
}): void {
  if (!input.sink) return;
  input.sink({
    kind: "shared-relation-materialization-production-diagnostic-v1",
    logicalPostorderNodeCount: input.logicalPostorderNodeCount,
    initialDefinitions: definitionSummary(input.initialDefinitions),
    baseDefinitions: definitionSummary(input.baseDefinitions),
    stageBaseDefinitions: definitionSummary(input.stageBaseDefinitions),
    initialBoundary: boundarySummary(input.initialBoundary),
    independentAutoBoundary: boundarySummary(input.independentAutoBoundary),
    stageSelection: {
      state: input.stageProof.state,
      candidateCount: input.stageProof.candidateCount,
      fixedWindowFloor: input.stageProof.fixedWindowFloor,
      segmentWeights: input.stageProof.segmentWeights,
      objective: input.stageProof.objective,
      selectedPostorderIndexes: input.selectedStageNodes.map((node) =>
        input.postorder.indexOf(node),
      ),
      diagnostics: input.stageProof.diagnostics,
    },
    provisionalBoundary: {
      ...boundarySummary(input.provisionalBoundary),
      acceptedStageCount: input.acceptedStageCount,
      selectedStageCount: input.selectedStageNodes.length,
    },
    finalReaderAudit: {
      stable: input.finalReaderAuditStable,
      rounds: input.finalReaderAuditRounds,
    },
    fallback: {
      triggered: input.fallbackTriggered,
      reason: input.fallbackTriggered
        ? !input.finalReaderAuditStable
          ? "final-reader-audit-did-not-stabilize"
          : "accepted-strict-stage-count-does-not-match-selected-count"
        : undefined,
      ...(input.fallbackBoundary
        ? { boundary: boundarySummary(input.fallbackBoundary) }
        : {}),
    },
    finalDefinitions: definitionSummary(input.finalBoundary.definitions),
    finalBoundary: boundarySummary(input.finalBoundary),
  });
}
