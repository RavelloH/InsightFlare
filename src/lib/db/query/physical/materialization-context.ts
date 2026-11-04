import type { RelationScope, SqlExpression } from "@/lib/db/query/expression";
import {
  definitionsWithCurrentInterfaces,
  isCurrentMaterializationInterface,
  type MaterializationReaderContextProof,
  materializationReaderContextProof,
} from "@/lib/db/query/physical/materialization-reader-context";
export type { MaterializationReaderContextProof } from "@/lib/db/query/physical/materialization-reader-context";
import type {
  PhysicalMaterializationSelection,
  SharedRelationDefinition,
} from "@/lib/db/query/physical/contracts";
import type {
  FreshMaterializationLicense,
  FreshMaterializationLicenseMap,
  MaterializationConsumerEdge,
  MaterializationPromotionCandidate,
} from "@/lib/db/query/physical/materialization-selection";
import type {
  PhysicalSharedRelationBoundaryEvidence,
  PhysicalSharedRelationInterfaceVetoReason,
  PhysicalSharedRelationLicenseKind,
} from "@/lib/db/query/physical/shared-relation-interfaces";
import type {
  LogicalQueryNode,
  ProjectNode,
  QuerySource,
} from "@/lib/db/query/plan";

export interface CandidateFacts {
  readonly scopes: Set<RelationScope>;
  readonly referencedScopes: RelationScope[];
  readonly referencedColumns: {
    readonly scope: RelationScope;
    readonly index: number;
  }[];
  readonly materializedBoundariesUsed: Set<LogicalQueryNode>;
  selective: boolean;
  forbidden: boolean;
  unsafe: boolean;
  materializedBoundary: boolean;
  limitBarrier: boolean;
  sortBarrier: boolean;
  rowNumberWindow: boolean;
  ordinaryRowNumberWindow: boolean;
}

export interface MaterializedBoundaryContext {
  readonly interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly vetoes: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationInterfaceVetoReason
  >;
  readonly materializedDefinitionsChecked: number;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly promotedDefinitions: ReadonlyMap<
    LogicalQueryNode,
    SharedRelationDefinition
  >;
  readonly freshMaterializationLicenses: FreshMaterializationLicenseMap;
  readonly promotionDiagnostics: readonly {
    readonly postorderIndex: number;
    readonly definitionIndex: number;
    readonly kind: MaterializationPromotionCandidate["kind"];
    readonly accepted: boolean;
    readonly failureReasons: readonly string[];
    readonly body: Readonly<Record<string, unknown>>;
    readonly readers: Readonly<Record<string, unknown>>;
    readonly dependenciesAreEarlier: boolean;
    readonly dependenciesAreSelected?: boolean;
    readonly originalDefinitionConditionPassed: boolean;
  }[];
}

export interface StrictStageReaderContext {
  readonly definitions: readonly SharedRelationDefinition[];
  readonly interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly licensedBoundaryNodes: ReadonlySet<LogicalQueryNode>;
}

export interface MaterializationReaderAuditRound {
  readonly round: number;
  readonly readerContextInterfaceCount: number;
  readonly outputInterfaceCount: number;
  readonly interfacePostorderIndexes: readonly number[];
  readonly stable: boolean;
}

export function sameMaterializedBoundaryInterfaceSet(
  left: MaterializedBoundaryContext,
  right: MaterializedBoundaryContext,
): boolean {
  if (left.interfaces.size !== right.interfaces.size) return false;
  for (const [node, evidence] of left.interfaces) {
    const next = right.interfaces.get(node);
    if (
      !next ||
      evidence.license.kind !== next.license.kind ||
      evidence.definition.materializationSelection?.kind !==
        next.definition.materializationSelection?.kind ||
      evidence.definition.materializationSelection?.choiceIndex !==
        next.definition.materializationSelection?.choiceIndex
    )
      return false;
  }
  return true;
}

export function auditMaterializedBoundaryFixedPoint(input: {
  readonly initialBoundaryContext: MaterializedBoundaryContext;
  readonly initialReaderContext: StrictStageReaderContext;
  readonly postorder: readonly LogicalQueryNode[];
  readonly maximumRounds: number;
  readonly rebuild: (
    readerContext: StrictStageReaderContext,
  ) => MaterializedBoundaryContext;
}): {
  readonly finalBoundaryContext: MaterializedBoundaryContext;
  readonly stable: boolean;
  readonly rounds: readonly MaterializationReaderAuditRound[];
} {
  let finalBoundaryContext = input.initialBoundaryContext;
  let readerContext = input.initialReaderContext;
  let stable = false;
  const rounds: MaterializationReaderAuditRound[] = [];
  for (let round = 1; round <= input.maximumRounds && !stable; round++) {
    const auditedBoundaryContext = input.rebuild(readerContext);
    stable = sameMaterializedBoundaryInterfaceSet(
      finalBoundaryContext,
      auditedBoundaryContext,
    );
    finalBoundaryContext = auditedBoundaryContext;
    rounds.push({
      round,
      readerContextInterfaceCount: readerContext.interfaces.size,
      outputInterfaceCount: auditedBoundaryContext.interfaces.size,
      interfacePostorderIndexes: [...auditedBoundaryContext.interfaces.keys()]
        .map((node) => input.postorder.indexOf(node))
        .sort((left, right) => left - right),
      stable,
    });
    readerContext = {
      definitions: auditedBoundaryContext.definitions,
      interfaces: auditedBoundaryContext.interfaces,
      licensedBoundaryNodes: new Set(auditedBoundaryContext.interfaces.keys()),
    };
  }
  return { finalBoundaryContext, stable, rounds };
}

/** No reader proof is attempted when an earlier admission condition failed. */
function unassessedMaterializationReaders(
  relationEdges: readonly MaterializationConsumerEdge[],
  expressionReaderCount: number,
): MaterializationReaderContextProof {
  return {
    passed: false,
    readerContextCount: 0,
    relationReaderCount: relationEdges.length,
    expressionReaderCount,
    distinctRelationParentCount: new Set(
      relationEdges.map(({ parent }) => parent),
    ).size,
    membershipObservationReaderCount: 0,
    allDirectRelationReadersMembershipObserved: false,
    failureReasons: ["auto-prerequisites-failed-reader-proof-not-run"],
    readerPathFailures: [],
    readerContexts: [],
    membershipObservationTerminals: [],
    membershipObservationRejections: [],
    distinctUnionContextCount: 0,
    distinctUnionProofs: [],
  };
}

function freshCandidateReaderContextProof(input: {
  readonly node: LogicalQueryNode;
  readonly definition: SharedRelationDefinition;
  readonly facts: CandidateFacts;
  readonly selection: PhysicalMaterializationSelection;
  readonly root: LogicalQueryNode;
  readonly baseline: readonly SharedRelationDefinition[];
  readonly closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>;
  readonly edges: readonly MaterializationConsumerEdge[];
  readonly postorder: readonly LogicalQueryNode[];
  readonly interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly readerContext?: StrictStageReaderContext;
  readonly sameFields: (
    left: QuerySource["fields"],
    right: QuerySource["fields"],
  ) => boolean;
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
  readonly isSafeReader: (node: LogicalQueryNode) => boolean;
}): MaterializationReaderContextProof {
  const definition = {
    ...input.definition,
    materialization: "materialized" as const,
    materializationSelection: input.selection,
  };
  const candidateEvidence: PhysicalSharedRelationBoundaryEvidence = {
    definition,
    selective: input.facts.selective,
    boundary: { kind: "materialized-relation" },
    license: { kind: input.selection.kind },
    closure: {
      kind: "scope-and-exported-columns-closed",
      scopeCount: input.facts.scopes.size,
      referencedScopeCount: new Set(input.facts.referencedScopes).size,
      referencedColumnCount: input.facts.referencedColumns.length,
    },
    totality: {
      kind: "checked-through-current-boundaries",
      stoppedAt: [...input.facts.materializedBoundariesUsed],
    },
  };
  const licensedBoundaryNodes = new Set(
    input.readerContext?.licensedBoundaryNodes ?? input.interfaces.keys(),
  );
  const candidateInterfaces = new Map([
    ...(input.readerContext?.interfaces ?? []),
    ...input.interfaces,
  ]);
  candidateInterfaces.set(input.node, candidateEvidence);
  const interfaces = new Map(
    [...candidateInterfaces].filter(
      ([node]) => node === input.node || licensedBoundaryNodes.has(node),
    ),
  );
  const definitions = definitionsWithCurrentInterfaces(
    input.readerContext?.definitions ?? input.baseline,
    interfaces,
  );
  return materializationReaderContextProof({
    node: input.node,
    root: input.root,
    definitions,
    edges: input.edges,
    postorder: input.postorder,
    interfaces,
    licensedBoundaryNodes,
    sameFields: input.sameFields,
    isSafeReader: input.isSafeReader,
    proveReaderBody: (context, contextInterfaces, candidate) => {
      const facts = input.candidateFacts(
        context,
        input.closedWindowScopeMemo,
        contextInterfaces,
        true,
        true,
      );
      const closed = input.candidateFactsAreClosed(facts, contextInterfaces);
      // A reader's output sort does not alter the candidate relation below it.
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
    },
  });
}

export function materializationConsumerEdges(
  nodes: readonly LogicalQueryNode[],
  nodeChildren: (node: LogicalQueryNode) => readonly QuerySource[],
  nodeExpressions: (node: LogicalQueryNode) => readonly SqlExpression[],
  expressionSources: (expression: SqlExpression) => readonly QuerySource[],
): readonly MaterializationConsumerEdge[] {
  const edges: MaterializationConsumerEdge[] = [];
  for (const parent of nodes) {
    for (const source of nodeChildren(parent))
      edges.push({ parent, child: source.node, source, kind: "relation" });
    for (const expression of nodeExpressions(parent))
      for (const source of expressionSources(expression))
        edges.push({ parent, child: source.node, source, kind: "expression" });
  }
  return edges;
}

export function isCurrentDirectColumnProject(
  node: LogicalQueryNode,
): node is ProjectNode {
  return (
    node.kind === "project" &&
    node.projections.length > 0 &&
    node.projections.length === node.fields.length &&
    node.projections.every((projection, index) => {
      const expression = projection.expression;
      const output = node.fields[index];
      if (
        expression.kind !== "column" ||
        expression.scope !== node.input.scope ||
        !Number.isSafeInteger(expression.index) ||
        expression.index < 0 ||
        expression.index >= node.input.fields.length ||
        !output ||
        projection.name !== output.name
      )
        return false;
      const source = node.input.fields[expression.index];
      return Boolean(
        source &&
        source.name === expression.name &&
        source.affinity === output.affinity &&
        source.nullable === output.nullable &&
        expression.resultType.affinity === output.affinity &&
        expression.resultType.nullable === output.nullable,
      );
    })
  );
}

export function sharedDefinitionDependenciesMatch(
  definition: SharedRelationDefinition,
  definitions: readonly SharedRelationDefinition[],
  postorder: readonly LogicalQueryNode[],
  sourcesOf: (node: LogicalQueryNode) => readonly QuerySource[],
): boolean {
  const names = new Map(
    definitions.map(({ node, name }) => [node, name] as const),
  );
  const postorderIndexes = new Map(
    postorder.map((node, index) => [node, index] as const),
  );
  const dependencies = new Set<string>();
  const descendants = new Set<LogicalQueryNode>();
  const collect = (node: LogicalQueryNode): void => {
    if (descendants.has(node)) return;
    descendants.add(node);
    for (const source of sourcesOf(node)) {
      const dependency = names.get(source.node);
      if (dependency) dependencies.add(dependency);
      collect(source.node);
    }
  };
  collect(definition.node);
  dependencies.delete(definition.name);
  const orderedDependencies = [...dependencies].sort((left, right) => {
    const leftNode = definitions.find(({ name }) => name === left)?.node;
    const rightNode = definitions.find(({ name }) => name === right)?.node;
    return (
      (postorderIndexes.get(leftNode!) ?? Number.MAX_SAFE_INTEGER) -
      (postorderIndexes.get(rightNode!) ?? Number.MAX_SAFE_INTEGER)
    );
  });
  return (
    definition.dependencies.length === orderedDependencies.length &&
    definition.dependencies.every(
      (dependency, index) => dependency === orderedDependencies[index],
    )
  );
}

export function sharedRelationLayoutWithStagePlaceholders(
  postorder: readonly LogicalQueryNode[],
  baseDefinitions: readonly SharedRelationDefinition[],
  stageNodes: readonly LogicalQueryNode[],
  sourcesOf: (node: LogicalQueryNode) => readonly QuerySource[],
): readonly SharedRelationDefinition[] {
  const byNode = new Map(
    baseDefinitions.map((definition) => [definition.node, definition] as const),
  );
  const reserved = new Set<string>([
    ...baseDefinitions.map(({ name }) => name.toLowerCase()),
    ...postorder.flatMap((node) =>
      node.kind === "scan" ? [node.table.name.toLowerCase()] : [],
    ),
  ]);
  let nextName = 0;
  for (const node of stageNodes) {
    if (byNode.has(node)) continue;
    let name = `_d1_shared_${nextName}`;
    while (reserved.has(name.toLowerCase())) {
      nextName++;
      name = `_d1_shared_${nextName}`;
    }
    nextName++;
    reserved.add(name.toLowerCase());
    byNode.set(node, {
      name,
      node,
      scope: node.scope,
      fields: node.fields,
      dependencies: [],
      materialization: "auto",
    });
  }
  const orderedNodes = postorder.filter((node) => byNode.has(node));
  const names = new Map(
    orderedNodes.map((node) => [node, byNode.get(node)!.name] as const),
  );
  const orderIndex = new Map(
    postorder.map((node, index) => [node, index] as const),
  );
  return orderedNodes.map((node) => {
    const definition = byNode.get(node)!;
    const dependencies = new Set<string>();
    const visited = new Set<LogicalQueryNode>();
    const collect = (current: LogicalQueryNode): void => {
      if (visited.has(current)) return;
      visited.add(current);
      for (const source of sourcesOf(current)) {
        const dependency = names.get(source.node);
        if (dependency) dependencies.add(dependency);
        collect(source.node);
      }
    };
    collect(node);
    dependencies.delete(definition.name);
    const orderedDependencies = [...dependencies].sort((left, right) => {
      const leftNode = orderedNodes.find(
        (candidate) => names.get(candidate) === left,
      )!;
      const rightNode = orderedNodes.find(
        (candidate) => names.get(candidate) === right,
      )!;
      return orderIndex.get(leftNode)! - orderIndex.get(rightNode)!;
    });
    return { ...definition, dependencies: orderedDependencies };
  });
}

export function materializedBoundaryContext(input: {
  readonly root: LogicalQueryNode;
  readonly postorder: readonly LogicalQueryNode[];
  readonly closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>;
  readonly baseline: readonly SharedRelationDefinition[];
  readonly initialInterfaces?: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly completeKeyedLookupCandidates: ReadonlySet<LogicalQueryNode>;
  readonly rankOneProjectCandidates: ReadonlySet<LogicalQueryNode>;
  readonly rankOneFactFilterCandidates: ReadonlySet<LogicalQueryNode>;
  readonly promotionCandidates?: ReadonlyMap<
    LogicalQueryNode,
    MaterializationPromotionCandidate
  >;
  readonly strictStageReaderContext?: StrictStageReaderContext;
  readonly originalDefinitions?: readonly SharedRelationDefinition[];
  readonly edges: readonly MaterializationConsumerEdge[];
  readonly sourcesOf: (node: LogicalQueryNode) => readonly QuerySource[];
  readonly sameFields: (
    left: QuerySource["fields"],
    right: QuerySource["fields"],
  ) => boolean;
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
  readonly licenseSourceFor: (
    node: LogicalQueryNode,
    facts: CandidateFacts,
  ) => PhysicalSharedRelationLicenseKind | undefined;
  readonly isSafeReader: (node: LogicalQueryNode) => boolean;
}): MaterializedBoundaryContext {
  const promotionCandidates = input.promotionCandidates ?? new Map();
  const originalDefinitions = input.originalDefinitions ?? input.baseline;
  const nodes = new Set(input.postorder);
  const licensedBoundaryNodes = new Set(
    input.strictStageReaderContext?.licensedBoundaryNodes ??
      input.initialInterfaces?.keys() ??
      [],
  );
  const interfaces = new Map<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >(input.initialInterfaces);
  const vetoes = new Map<
    LogicalQueryNode,
    PhysicalSharedRelationInterfaceVetoReason
  >();
  let materializedDefinitionsChecked = 0;
  const promotedDefinitions = new Map<
    LogicalQueryNode,
    SharedRelationDefinition
  >();
  const freshMaterializationLicenses = new Map<
    LogicalQueryNode,
    FreshMaterializationLicense
  >();
  const promotionDiagnostics: MaterializedBoundaryContext["promotionDiagnostics"][number][] =
    [];
  const originalByNode = new Map(
    originalDefinitions.map(
      (definition) => [definition.node, definition] as const,
    ),
  );
  const definitionIndexes = new Map(
    input.baseline.map(({ node }, index) => [node, index] as const),
  );

  for (const definition of input.baseline) {
    const { node } = definition;
    const promotion = promotionCandidates.get(node);
    const isPromotionCandidate = promotion !== undefined;
    const recordEarlyPromotionFailure = (reason: string): void => {
      if (!promotion) return;
      const original = originalByNode.get(node);
      promotionDiagnostics.push({
        postorderIndex: input.postorder.indexOf(node),
        definitionIndex: definitionIndexes.get(node) ?? -1,
        kind: promotion.kind,
        accepted: false,
        failureReasons: [reason],
        body: { evaluated: false },
        readers: { evaluated: false },
        dependenciesAreEarlier: false,
        originalDefinitionConditionPassed:
          promotion.kind === "strict-serial-rank-stage"
            ? original === undefined
            : original?.node === node && original.materialization === "auto",
      });
    };
    const seededInterface = input.initialInterfaces?.get(node);
    if (seededInterface) {
      if (
        !isCurrentMaterializationInterface(
          node,
          definition,
          seededInterface,
          input.sameFields,
        )
      ) {
        vetoes.set(node, "definition-metadata-mismatch");
        interfaces.delete(node);
        recordEarlyPromotionFailure("seeded-interface-is-not-current");
      } else {
        materializedDefinitionsChecked++;
        licensedBoundaryNodes.add(node);
      }
      continue;
    }
    if (
      definition.materialization !== "materialized" &&
      !isPromotionCandidate
    ) {
      vetoes.set(node, "automatic-materialization-is-not-a-license");
      continue;
    }
    if (!nodes.has(node)) {
      vetoes.set(node, "not-in-current-logical-graph");
      recordEarlyPromotionFailure("node-is-not-in-current-logical-graph");
      continue;
    }
    if (
      definition.scope !== node.scope ||
      !input.sameFields(definition.fields, node.fields)
    ) {
      vetoes.set(node, "definition-metadata-mismatch");
      recordEarlyPromotionFailure("definition-metadata-mismatch");
      continue;
    }
    if (
      !sharedDefinitionDependenciesMatch(
        definition,
        input.baseline,
        input.postorder,
        input.sourcesOf,
      )
    ) {
      vetoes.set(node, "dependency-layout-mismatch");
      recordEarlyPromotionFailure("dependency-layout-mismatch");
      continue;
    }
    materializedDefinitionsChecked++;
    const facts = input.candidateFacts(
      node,
      input.closedWindowScopeMemo,
      interfaces,
      true,
      isPromotionCandidate,
    );
    let licenseSource: PhysicalSharedRelationLicenseKind | undefined;
    let effectiveDefinition = definition;
    let selection: PhysicalMaterializationSelection | undefined;
    let readerProof: MaterializationReaderContextProof | undefined;

    if (promotion?.kind === "strict-serial-rank-stage") {
      readerProof = freshCandidateReaderContextProof({
        node,
        definition,
        facts,
        selection: {
          kind: "strict-serial-rank-stage",
          choiceIndex: promotion.choiceIndex,
        },
        root: input.root,
        baseline: input.baseline,
        closedWindowScopeMemo: input.closedWindowScopeMemo,
        edges: input.edges,
        postorder: input.postorder,
        interfaces: input.strictStageReaderContext?.interfaces ?? interfaces,
        readerContext: {
          definitions:
            input.strictStageReaderContext?.definitions ?? input.baseline,
          interfaces: input.strictStageReaderContext?.interfaces ?? interfaces,
          licensedBoundaryNodes,
        },
        sameFields: input.sameFields,
        candidateFacts: input.candidateFacts,
        candidateFactsAreClosed: input.candidateFactsAreClosed,
        isSafeReader: input.isSafeReader,
      });
      const original = originalByNode.get(node);
      const dependenciesAreEarlier = definition.dependencies.every((name) => {
        const dependency = input.baseline.find((item) => item.name === name);
        const dependencyIndex = dependency
          ? definitionIndexes.get(dependency.node)
          : undefined;
        return (
          dependencyIndex !== undefined &&
          dependencyIndex < definitionIndexes.get(node)!
        );
      });
      const bodyClosed = input.candidateFactsAreClosed(facts, interfaces);
      const bodyFailureReasons = [
        ...(!facts.selective ? ["body-is-not-selective"] : []),
        ...(facts.forbidden ? ["body-has-forbidden-boundary"] : []),
        ...(facts.unsafe
          ? ["body-is-not-total-through-current-boundaries"]
          : []),
        ...(!bodyClosed
          ? ["body-scope-or-exported-columns-are-not-closed"]
          : []),
      ];
      const bodyPassed =
        facts.selective && !facts.forbidden && !facts.unsafe && bodyClosed;
      const relationReadersAreCovered =
        readerProof.relationReaderCount === 1 ||
        readerProof.allDirectRelationReadersMembershipObserved;
      if (
        !original &&
        definition.materialization === "auto" &&
        bodyPassed &&
        readerProof.passed &&
        relationReadersAreCovered &&
        readerProof.expressionReaderCount === 0 &&
        dependenciesAreEarlier
      ) {
        licenseSource = "strict-serial-rank-stage";
        selection = {
          kind: "strict-serial-rank-stage",
          choiceIndex: promotion.choiceIndex,
        };
      }
      const originalDefinitionConditionPassed = original === undefined;
      const failureReasons = [
        ...(!originalDefinitionConditionPassed
          ? ["strict-stage-node-already-has-a-base-definition"]
          : []),
        ...(definition.materialization !== "auto"
          ? ["strict-stage-definition-is-not-auto"]
          : []),
        ...bodyFailureReasons,
        ...(!readerProof.passed
          ? readerProof.failureReasons.length > 0
            ? readerProof.failureReasons
            : ["reader-proof-failed"]
          : []),
        ...(!relationReadersAreCovered
          ? [
              readerProof.relationReaderCount > 1
                ? "strict-stage-has-unobserved-multiple-relation-readers"
                : "strict-stage-requires-one-relation-reader",
            ]
          : []),
        ...(readerProof.expressionReaderCount !== 0
          ? ["strict-stage-has-expression-query-reader"]
          : []),
        ...(!dependenciesAreEarlier
          ? ["strict-stage-dependency-is-not-earlier"]
          : []),
      ];
      promotionDiagnostics.push({
        postorderIndex: input.postorder.indexOf(node),
        definitionIndex: definitionIndexes.get(node) ?? -1,
        kind: promotion.kind,
        accepted: selection?.kind === "strict-serial-rank-stage",
        failureReasons,
        body: {
          selective: facts.selective,
          forbidden: facts.forbidden,
          unsafe: facts.unsafe,
          closed: bodyClosed,
          materializedBoundaryCount: facts.materializedBoundariesUsed.size,
          scopeCount: facts.scopes.size,
          referencedScopeCount: new Set(facts.referencedScopes).size,
          referencedColumnCount: facts.referencedColumns.length,
          failureReasons: bodyFailureReasons,
        },
        readers: {
          passed: readerProof.passed,
          readerContextCount: readerProof.readerContextCount,
          relationReaderCount: readerProof.relationReaderCount,
          expressionReaderCount: readerProof.expressionReaderCount,
          distinctRelationParentCount: readerProof.distinctRelationParentCount,
          membershipObservationReaderCount:
            readerProof.membershipObservationReaderCount,
          allDirectRelationReadersMembershipObserved:
            readerProof.allDirectRelationReadersMembershipObserved,
          failureReasons: readerProof.failureReasons,
          readerPathFailures: readerProof.readerPathFailures,
          readerContexts: readerProof.readerContexts,
          distinctUnionContextCount: readerProof.distinctUnionContextCount,
          distinctUnionProofs: readerProof.distinctUnionProofs,
          membershipObservationTerminals:
            readerProof.membershipObservationTerminals,
          membershipObservationRejections:
            readerProof.membershipObservationRejections,
        },
        dependenciesAreEarlier,
        originalDefinitionConditionPassed,
      });
    } else if (promotion?.kind === "auto-candidate") {
      const stageDerivedForReader = [...facts.materializedBoundariesUsed].some(
        (boundary) =>
          interfaces.get(boundary)?.license.kind === "strict-serial-rank-stage",
      );
      const readerSelection = {
        kind: stageDerivedForReader
          ? ("stage-derived-auto" as const)
          : ("current-boundary-derived-auto" as const),
        choiceIndex: promotion.choiceIndex,
      };
      const original = originalByNode.get(node);
      const currentIndex = definitionIndexes.get(node);
      const dependenciesAreEarlier = definition.dependencies.every((name) => {
        const dependency = input.baseline.find((item) => item.name === name);
        const dependencyIndex = dependency
          ? definitionIndexes.get(dependency.node)
          : undefined;
        return (
          dependencyIndex !== undefined &&
          currentIndex !== undefined &&
          dependencyIndex < currentIndex
        );
      });
      const dependenciesAreSelected = definition.dependencies.every((name) => {
        const dependency = input.baseline.find((item) => item.name === name);
        if (!dependency) return false;
        if (dependency.materialization !== "auto") return true;
        return interfaces.has(dependency.node);
      });
      const directColumnProject = isCurrentDirectColumnProject(node);
      const bodyClosed = input.candidateFactsAreClosed(facts, interfaces);
      const bodyFailureReasons = [
        ...(!directColumnProject
          ? ["auto-candidate-is-not-a-direct-column-project"]
          : []),
        ...(facts.forbidden ? ["body-has-forbidden-boundary"] : []),
        ...(facts.unsafe
          ? ["body-is-not-total-through-current-boundaries"]
          : []),
        ...(!bodyClosed
          ? ["body-scope-or-exported-columns-are-not-closed"]
          : []),
        ...(facts.materializedBoundariesUsed.size === 0
          ? ["body-does-not-use-a-current-materialized-boundary"]
          : []),
      ];
      const bodyPassed =
        directColumnProject &&
        !facts.forbidden &&
        !facts.unsafe &&
        bodyClosed &&
        facts.materializedBoundariesUsed.size > 0;
      const relationReaderEdges = input.edges.filter(
        (edge) => edge.child === node && edge.kind === "relation",
      );
      const expressionReaderCount = input.edges.filter(
        (edge) => edge.child === node && edge.kind === "expression",
      ).length;
      const originalDefinitionConditionPassed =
        original?.node === node &&
        original.materialization === "auto" &&
        original.scope === definition.scope &&
        input.sameFields(original.fields, definition.fields);
      const prerequisitesPassed =
        originalDefinitionConditionPassed &&
        definition.materialization === "auto" &&
        bodyPassed &&
        expressionReaderCount === 0 &&
        relationReaderEdges.length >= 2 &&
        new Set(relationReaderEdges.map(({ parent }) => parent)).size >= 2 &&
        dependenciesAreEarlier &&
        dependenciesAreSelected;
      readerProof = prerequisitesPassed
        ? freshCandidateReaderContextProof({
            node,
            definition,
            facts,
            selection: readerSelection,
            root: input.root,
            baseline: input.baseline,
            closedWindowScopeMemo: input.closedWindowScopeMemo,
            edges: input.edges,
            postorder: input.postorder,
            interfaces,
            readerContext: {
              definitions:
                input.strictStageReaderContext?.definitions ?? input.baseline,
              interfaces,
              licensedBoundaryNodes,
            },
            sameFields: input.sameFields,
            candidateFacts: input.candidateFacts,
            candidateFactsAreClosed: input.candidateFactsAreClosed,
            isSafeReader: input.isSafeReader,
          })
        : unassessedMaterializationReaders(
            relationReaderEdges,
            expressionReaderCount,
          );
      if (
        original?.node === node &&
        original.materialization === "auto" &&
        original.scope === definition.scope &&
        input.sameFields(original.fields, definition.fields) &&
        definition.materialization === "auto" &&
        bodyPassed &&
        readerProof.passed &&
        readerProof.expressionReaderCount === 0 &&
        expressionReaderCount === 0 &&
        relationReaderEdges.length >= 2 &&
        readerProof.distinctRelationParentCount >= 2 &&
        dependenciesAreEarlier &&
        dependenciesAreSelected
      ) {
        const stageDerived = [...facts.materializedBoundariesUsed].some(
          (boundary) =>
            interfaces.get(boundary)?.license.kind ===
            "strict-serial-rank-stage",
        );
        const autoLicenseKind = stageDerived
          ? "stage-derived-auto"
          : "current-boundary-derived-auto";
        licenseSource = autoLicenseKind;
        selection = {
          kind: autoLicenseKind,
          choiceIndex: promotion.choiceIndex,
        };
      }
      const failureReasons = [
        ...(!originalDefinitionConditionPassed
          ? ["auto-definition-does-not-match-current-baseline"]
          : []),
        ...(definition.materialization !== "auto"
          ? ["auto-candidate-definition-is-not-auto"]
          : []),
        ...bodyFailureReasons,
        ...(!readerProof.passed
          ? readerProof.failureReasons.length > 0
            ? readerProof.failureReasons
            : ["reader-proof-failed"]
          : []),
        ...(readerProof.expressionReaderCount !== 0 ||
        expressionReaderCount !== 0
          ? ["expression-query-reader-present"]
          : []),
        ...(relationReaderEdges.length < 2 ||
        readerProof.distinctRelationParentCount < 2
          ? ["fewer-than-two-distinct-relation-readers"]
          : []),
        ...(!dependenciesAreEarlier
          ? ["dependency-layout-is-not-earlier-first"]
          : []),
        ...(!dependenciesAreSelected
          ? ["auto-dependency-is-not-selected-or-independently-materialized"]
          : []),
      ];
      promotionDiagnostics.push({
        postorderIndex: input.postorder.indexOf(node),
        definitionIndex: currentIndex ?? -1,
        kind: promotion.kind,
        accepted:
          selection?.kind === "stage-derived-auto" ||
          selection?.kind === "current-boundary-derived-auto",
        failureReasons,
        body: {
          directColumnProject,
          forbidden: facts.forbidden,
          unsafe: facts.unsafe,
          closed: bodyClosed,
          materializedBoundaryCount: facts.materializedBoundariesUsed.size,
          scopeCount: facts.scopes.size,
          referencedScopeCount: new Set(facts.referencedScopes).size,
          referencedColumnCount: facts.referencedColumns.length,
          failureReasons: bodyFailureReasons,
        },
        readers: {
          passed: readerProof.passed,
          readerContextCount: readerProof.readerContextCount,
          relationReaderCount: readerProof.relationReaderCount,
          expressionReaderCount: readerProof.expressionReaderCount,
          distinctRelationParentCount: readerProof.distinctRelationParentCount,
          failureReasons: readerProof.failureReasons,
          readerPathFailures: readerProof.readerPathFailures,
          readerContexts: readerProof.readerContexts,
          distinctUnionContextCount: readerProof.distinctUnionContextCount,
          distinctUnionProofs: readerProof.distinctUnionProofs,
          membershipObservationTerminals:
            readerProof.membershipObservationTerminals,
          membershipObservationRejections:
            readerProof.membershipObservationRejections,
          directRelationReaderCount: relationReaderEdges.length,
          directExpressionReaderCount: expressionReaderCount,
        },
        dependenciesAreEarlier,
        dependenciesAreSelected,
        originalDefinitionConditionPassed,
      });
    } else {
      licenseSource = input.licenseSourceFor(node, facts);
    }

    if (licenseSource && selection && readerProof) {
      effectiveDefinition = {
        ...definition,
        materialization: "materialized",
        materializationSelection: selection,
      };
      promotedDefinitions.set(node, effectiveDefinition);
      freshMaterializationLicenses.set(node, {
        definition: effectiveDefinition,
        license: selection.kind,
        selection,
        proof: {
          kind: "fresh-body-and-reader-proof",
          bodyTotalAndClosed: true,
          readerContextsTotal: true,
          readerContextCount: readerProof.readerContextCount,
          stoppedAt: [...facts.materializedBoundariesUsed],
        },
      });
    }
    const licensedBoundedLimit =
      licenseSource === "bounded-group-summary" &&
      facts.limitBarrier &&
      !facts.sortBarrier;
    if (!licenseSource) {
      vetoes.set(node, "no-current-license");
      continue;
    }
    if (facts.unsafe) {
      vetoes.set(node, "not-total-through-certified-boundaries");
      continue;
    }
    if (facts.forbidden && !licensedBoundedLimit) {
      vetoes.set(node, "forbidden-boundary-shape");
      continue;
    }
    if (!input.candidateFactsAreClosed(facts, interfaces)) {
      vetoes.set(node, "scope-or-column-not-closed");
      continue;
    }
    interfaces.set(node, {
      definition: effectiveDefinition,
      selective: facts.selective,
      boundary: { kind: "materialized-relation" },
      license: { kind: licenseSource },
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
    licensedBoundaryNodes.add(node);
  }
  return {
    interfaces,
    vetoes,
    materializedDefinitionsChecked,
    promotedDefinitions,
    freshMaterializationLicenses,
    promotionDiagnostics,
    definitions: input.baseline.map(
      (definition) => promotedDefinitions.get(definition.node) ?? definition,
    ),
  };
}
