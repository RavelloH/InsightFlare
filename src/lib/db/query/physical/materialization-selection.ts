import {
  type BalancedStageCut,
  selectBalancedStageCuts,
} from "@/lib/db/query/physical/balanced-stage-cuts";
import type {
  PhysicalMaterializationSelection,
  SharedRelationDefinition,
} from "@/lib/db/query/physical/contracts";
import type {
  LogicalQueryNode,
  ProjectNode,
  QuerySource,
} from "@/lib/db/query/plan";

export interface MaterializationConsumerEdge {
  readonly parent: LogicalQueryNode;
  readonly child: LogicalQueryNode;
  readonly source: QuerySource;
  readonly kind: "relation" | "expression";
}

export interface StrictRankStageShape {
  readonly node: ProjectNode;
  readonly filter: Extract<LogicalQueryNode, { readonly kind: "filter" }>;
  readonly window: Extract<LogicalQueryNode, { readonly kind: "window" }>;
  readonly rankOutputIndex: number;
}

export interface BalancedStageProof {
  readonly state: "selected" | "unsupported" | "zero-cuts";
  readonly selected: readonly StrictRankStageShape[];
  readonly candidateCount: number;
  readonly fixedWindowFloor: number;
  readonly segmentWeights: readonly number[];
  readonly objective: readonly number[];
  readonly diagnostics: {
    readonly consideredProjectCount: number;
    readonly shapeCandidateCount: number;
    readonly baselineShapeExcludedCount: number;
    readonly shapeRejectionCounts: Readonly<Record<string, number>>;
    readonly bodyPassedCount: number;
    readonly readerPassedCount: number;
    readonly candidateAssessments: readonly {
      readonly postorderIndex: number;
      readonly body: MaterializationProofAssessment;
      readonly readers: MaterializationProofAssessment;
      readonly eligible: boolean;
      readonly selectionEligible: boolean;
    }[];
    readonly selectionFailure?: string;
    readonly rejectionNodePostorderIndex?: number;
    readonly eligiblePostorderIndexes: readonly number[];
    readonly relationNeighbors?: readonly {
      readonly postorderIndex: number;
      readonly predecessorPostorderIndexes: readonly number[];
      readonly successorPostorderIndexes: readonly number[];
    }[];
    readonly windowCoverage?: {
      readonly totalWindowCount: number;
      readonly coveredWindowCount: number;
      readonly uncoveredWindowPostorderIndexes: readonly number[];
      readonly intervalsOverlap: boolean;
    };
    readonly dynamicProgram?: {
      readonly segmentWeights: readonly number[];
      readonly fixedWindowFloor: number;
      readonly eligiblePostorderIndexes: readonly number[];
      readonly selectedPostorderIndexes: readonly number[];
      readonly objective: readonly number[];
    };
    readonly branchingCandidatePostorderIndexes: readonly number[];
    readonly serialCandidatePostorderIndexes: readonly number[];
    readonly serialCutCandidatePostorderIndexes: readonly number[];
  };
}

export interface MaterializationProofAssessment {
  readonly passed: boolean;
  readonly reason?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type MaterializationPromotionCandidate =
  | {
      readonly kind: "strict-serial-rank-stage";
      readonly choiceIndex: number;
    }
  | { readonly kind: "auto-candidate"; readonly choiceIndex: number };

export function autoMaterializationPromotionCandidates(
  definitions: readonly SharedRelationDefinition[],
  postorder: readonly LogicalQueryNode[],
): ReadonlyMap<LogicalQueryNode, MaterializationPromotionCandidate> {
  return new Map(
    definitions.flatMap((definition) =>
      definition.materialization === "auto"
        ? [
            [
              definition.node,
              {
                kind: "auto-candidate" as const,
                choiceIndex: postorder.indexOf(definition.node),
              },
            ] as const,
          ]
        : [],
    ),
  );
}

function normalizeAssessment(
  assessment: boolean | MaterializationProofAssessment,
): MaterializationProofAssessment {
  return typeof assessment === "boolean" ? { passed: assessment } : assessment;
}

function strictRankStageShape(
  node: LogicalQueryNode,
):
  | { readonly shape: StrictRankStageShape; readonly reason?: never }
  | { readonly shape?: never; readonly reason: string } {
  if (node.kind !== "project") return { reason: "not-project" };
  const filterNode = node.input.node;
  if (filterNode.kind !== "filter")
    return { reason: "project-input-not-filter" };
  const windowNode = filterNode.input.node;
  if (windowNode.kind !== "window")
    return { reason: "filter-input-not-window" };
  const filter = filterNode as Extract<
    LogicalQueryNode,
    { readonly kind: "filter" }
  >;
  const window = windowNode as Extract<
    LogicalQueryNode,
    { readonly kind: "window" }
  >;
  const predicate = filter.predicate;
  if (window.windows.length !== 1) return { reason: "window-count-is-not-one" };
  if (window.windows[0]?.specification.kind !== "row-number")
    return { reason: "window-is-not-row-number" };
  if (
    predicate.kind !== "binary" ||
    predicate.operator !== "=" ||
    predicate.left.kind !== "column" ||
    predicate.right.kind !== "constant" ||
    predicate.right.value !== 1 ||
    !Number.isSafeInteger(predicate.right.value)
  )
    return { reason: "filter-is-not-rank-equals-one" };
  if (predicate.left.scope !== filter.input.scope)
    return { reason: "rank-predicate-scope-is-not-current" };

  const rankOutputIndex = predicate.left.index;
  const rankField = filter.fields[rankOutputIndex];
  const windowName = window.windows[0]!.name;
  const windowOutputIndex = window.input.fields.length;
  const exactWindowExport =
    window.fields.length === window.input.fields.length + 1 &&
    window.input.fields.every(
      (field, index) =>
        field.name === window.fields[index]?.name &&
        field.affinity === window.fields[index]?.affinity &&
        field.nullable === window.fields[index]?.nullable,
    );
  const exactRankIdentity =
    rankOutputIndex === windowOutputIndex &&
    rankField?.name === windowName &&
    window.fields[rankOutputIndex]?.name === windowName &&
    predicate.left.name === windowName &&
    predicate.left.resultType.affinity === rankField.affinity &&
    predicate.left.resultType.nullable === rankField.nullable;
  const exactProjection =
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
      const input = node.input.fields[expression.index];
      return Boolean(
        input &&
        input.name === expression.name &&
        expression.resultType.affinity === output.affinity &&
        expression.resultType.nullable === output.nullable &&
        input.affinity === output.affinity &&
        input.nullable === output.nullable,
      );
    });
  if (!exactWindowExport)
    return { reason: "window-export-does-not-match-input-plus-rank" };
  if (!exactRankIdentity)
    return { reason: "rank-output-identity-does-not-match-window" };
  if (!exactProjection)
    return { reason: "project-is-not-an-exact-column-export" };
  return { shape: { node, filter, window, rankOutputIndex } };
}

function nearestCandidates(
  start: LogicalQueryNode,
  adjacency: ReadonlyMap<LogicalQueryNode, readonly LogicalQueryNode[]>,
  boundaries: ReadonlySet<LogicalQueryNode>,
  candidates: ReadonlySet<LogicalQueryNode>,
): ReadonlySet<LogicalQueryNode> {
  const found = new Set<LogicalQueryNode>();
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (boundaries.has(node)) return;
    if (candidates.has(node)) {
      found.add(node);
      return;
    }
    if (active.has(node) || visited.has(node)) return;
    active.add(node);
    for (const next of adjacency.get(node) ?? []) visit(next);
    active.delete(node);
    visited.add(node);
  };
  for (const next of adjacency.get(start) ?? []) visit(next);
  return found;
}

interface WindowSummary {
  readonly depth: number;
  readonly windows: ReadonlySet<LogicalQueryNode>;
  readonly cycle: boolean;
}

function forwardWindowSummary(
  start: LogicalQueryNode,
  sources: ReadonlyMap<LogicalQueryNode, readonly LogicalQueryNode[]>,
  stops: ReadonlySet<LogicalQueryNode>,
): WindowSummary {
  const active = new Set<LogicalQueryNode>();
  const memo = new Map<LogicalQueryNode, WindowSummary>();
  const visit = (node: LogicalQueryNode, isStart: boolean): WindowSummary => {
    if (!isStart && stops.has(node))
      return { depth: 0, windows: new Set(), cycle: false };
    const cached = memo.get(node);
    if (cached) return cached;
    if (active.has(node)) return { depth: 0, windows: new Set(), cycle: true };
    active.add(node);
    const windows = new Set<LogicalQueryNode>();
    if (node.kind === "window") windows.add(node);
    let childDepth = 0;
    let cycle = false;
    for (const child of sources.get(node) ?? []) {
      const summary = visit(child, false);
      childDepth = Math.max(childDepth, summary.depth);
      cycle ||= summary.cycle;
      summary.windows.forEach((window) => windows.add(window));
    }
    active.delete(node);
    const result = {
      depth: (node.kind === "window" ? 1 : 0) + childDepth,
      windows,
      cycle,
    };
    memo.set(node, result);
    return result;
  };
  return visit(start, true);
}

function reverseWindowSummary(
  start: LogicalQueryNode,
  parents: ReadonlyMap<LogicalQueryNode, readonly LogicalQueryNode[]>,
  stops: ReadonlySet<LogicalQueryNode>,
): WindowSummary {
  const active = new Set<LogicalQueryNode>();
  const memo = new Map<LogicalQueryNode, WindowSummary>();
  const visit = (node: LogicalQueryNode, isStart: boolean): WindowSummary => {
    if (!isStart && stops.has(node))
      return { depth: 0, windows: new Set(), cycle: false };
    const cached = memo.get(node);
    if (cached) return cached;
    if (active.has(node)) return { depth: 0, windows: new Set(), cycle: true };
    active.add(node);
    const windows = new Set<LogicalQueryNode>();
    let depth = 0;
    let cycle = false;
    for (const parent of parents.get(node) ?? []) {
      const summary = visit(parent, false);
      depth = Math.max(depth, summary.depth);
      cycle ||= summary.cycle;
      summary.windows.forEach((window) => windows.add(window));
    }
    if (!isStart && node.kind === "window") windows.add(node);
    active.delete(node);
    const result = {
      depth: depth + (isStart || node.kind !== "window" ? 0 : 1),
      windows,
      cycle,
    };
    memo.set(node, result);
    return result;
  };
  const summary = visit(start, true);
  return summary;
}

function pushUnique(
  map: Map<LogicalQueryNode, LogicalQueryNode[]>,
  node: LogicalQueryNode,
  value: LogicalQueryNode,
): void {
  const values = map.get(node) ?? [];
  values.push(value);
  map.set(node, values);
}

/**
 * Selects fresh cuts only for one fully covered serial region. The callbacks
 * are current-root totality and reader proofs supplied by the physical planner.
 */
export function selectStrictRankStages(args: {
  readonly root: LogicalQueryNode;
  readonly nodes: readonly LogicalQueryNode[];
  readonly baseDefinitions: readonly SharedRelationDefinition[];
  readonly edges: readonly MaterializationConsumerEdge[];
  readonly sourcesOf: (node: LogicalQueryNode) => readonly QuerySource[];
  readonly proveBody: (
    node: LogicalQueryNode,
  ) => boolean | MaterializationProofAssessment;
  readonly proveReaders: (
    node: LogicalQueryNode,
  ) => boolean | MaterializationProofAssessment;
  /** Prepare a body-certified producer context before testing reader paths. */
  readonly prepareReaderContext?: (
    bodyQualifiedNodes: readonly LogicalQueryNode[],
  ) => void;
}): BalancedStageProof {
  const postorderIndex = new Map(
    args.nodes.map((node, index) => [node, index]),
  );
  const relationParents = new Map<LogicalQueryNode, LogicalQueryNode[]>();
  const relationChildren = new Map<LogicalQueryNode, LogicalQueryNode[]>();
  const allParents = new Map<LogicalQueryNode, LogicalQueryNode[]>();
  const allSources = new Map<LogicalQueryNode, LogicalQueryNode[]>();
  for (const node of args.nodes) {
    const sources = [...args.sourcesOf(node)].map(({ node: source }) => source);
    allSources.set(node, sources);
    for (const child of sources) pushUnique(allParents, child, node);
  }
  for (const edge of args.edges) {
    if (edge.kind !== "relation") continue;
    pushUnique(relationParents, edge.child, edge.parent);
    pushUnique(relationChildren, edge.parent, edge.child);
  }

  const baseDefinitionNodes = new Set(
    args.baseDefinitions.map(({ node }) => node),
  );
  const shapeRejections = new Map<string, number>();
  const shapeCandidates: Array<{
    readonly shape: StrictRankStageShape;
    readonly postorderIndex: number;
  }> = [];
  let consideredProjectCount = 0;
  let baselineShapeExcludedCount = 0;
  args.nodes.forEach((node, index) => {
    if (node.kind !== "project") return;
    consideredProjectCount++;
    const result = strictRankStageShape(node);
    if (!result.shape) {
      shapeRejections.set(
        result.reason,
        (shapeRejections.get(result.reason) ?? 0) + 1,
      );
      return;
    }
    if (baseDefinitionNodes.has(node)) {
      baselineShapeExcludedCount++;
      return;
    }
    shapeCandidates.push({ shape: result.shape, postorderIndex: index });
  });
  const bodyAssessments = shapeCandidates.map(({ shape, postorderIndex }) => {
    const body = normalizeAssessment(args.proveBody(shape.node));
    return { shape, postorderIndex, body };
  });
  args.prepareReaderContext?.(
    bodyAssessments
      .filter(({ body }) => body.passed)
      .map(({ shape }) => shape.node),
  );
  const candidateAssessments = bodyAssessments.map(
    ({ shape, postorderIndex, body }) => {
      const readers = body.passed
        ? normalizeAssessment(args.proveReaders(shape.node))
        : {
            passed: false,
            reason: "body-proof-failed-before-reader-proof",
          };
      const eligible = body.passed && readers.passed;
      return {
        shape,
        postorderIndex,
        body,
        readers,
        eligible,
        selectionEligible: eligible,
      };
    },
  );
  const bodyCandidates = candidateAssessments.filter(({ body }) => body.passed);
  const selectionCandidates = candidateAssessments
    .filter(({ selectionEligible }) => selectionEligible)
    .map(({ shape }) => shape);
  const candidateNodes = new Set(selectionCandidates.map(({ node }) => node));
  const readerPassedCandidates = candidateAssessments.filter(
    ({ readers }) => readers.passed,
  );
  const diagnosticsBase: BalancedStageProof["diagnostics"] = {
    consideredProjectCount,
    shapeCandidateCount: shapeCandidates.length,
    baselineShapeExcludedCount,
    shapeRejectionCounts: Object.fromEntries(shapeRejections),
    bodyPassedCount: bodyCandidates.length,
    readerPassedCount: readerPassedCandidates.length,
    candidateAssessments: candidateAssessments.map(
      ({ postorderIndex, body, readers, eligible, selectionEligible }) => ({
        postorderIndex,
        body,
        readers,
        eligible,
        selectionEligible,
      }),
    ),
    eligiblePostorderIndexes: selectionCandidates.flatMap(({ node }) => {
      const index = postorderIndex.get(node);
      return index === undefined ? [] : [index];
    }),
    branchingCandidatePostorderIndexes: [],
    serialCandidatePostorderIndexes: [],
    serialCutCandidatePostorderIndexes: [],
  };
  const makeProof = (
    state: BalancedStageProof["state"],
    selected: readonly StrictRankStageShape[] = [],
    candidateCount = candidateNodes.size,
    fixedWindowFloor = 0,
    segmentWeights: readonly number[] = [],
    objective: readonly number[] = [],
    diagnosticDetails: Partial<BalancedStageProof["diagnostics"]> = {},
  ): BalancedStageProof => ({
    state,
    selected,
    candidateCount,
    fixedWindowFloor,
    segmentWeights,
    objective,
    diagnostics: { ...diagnosticsBase, ...diagnosticDetails },
  });
  const unsupported = (
    reason: string,
    candidateCount = candidateNodes.size,
    fixedWindowFloor = 0,
    diagnosticDetails: Partial<BalancedStageProof["diagnostics"]> = {},
  ) =>
    makeProof("unsupported", [], candidateCount, fixedWindowFloor, [], [], {
      ...diagnosticDetails,
      selectionFailure: reason,
    });
  if (candidateNodes.size === 0) {
    const reason =
      shapeCandidates.length === 0
        ? "no-strict-rank-stage-shapes"
        : bodyCandidates.length === 0
          ? "all-stage-body-proofs-rejected"
          : "all-stage-reader-proofs-rejected";
    return unsupported(reason, 0);
  }

  const neighbors = new Map<
    LogicalQueryNode,
    {
      readonly predecessors: readonly LogicalQueryNode[];
      readonly successors: readonly LogicalQueryNode[];
    }
  >();
  const neighborDiagnostics = () =>
    [...neighbors.entries()].map(([node, current]) => ({
      postorderIndex: postorderIndex.get(node) ?? -1,
      predecessorPostorderIndexes: current.predecessors.map(
        (neighbor) => postorderIndex.get(neighbor) ?? -1,
      ),
      successorPostorderIndexes: current.successors.map(
        (neighbor) => postorderIndex.get(neighbor) ?? -1,
      ),
    }));
  const branchingCandidates = new Set<LogicalQueryNode>();
  for (const candidate of candidateNodes) {
    const predecessors = nearestCandidates(
      candidate,
      relationChildren,
      baseDefinitionNodes,
      candidateNodes,
    );
    const successors = nearestCandidates(
      candidate,
      relationParents,
      baseDefinitionNodes,
      candidateNodes,
    );
    if (predecessors.size > 1 || successors.size > 1)
      branchingCandidates.add(candidate);
    neighbors.set(candidate, {
      predecessors: [...predecessors],
      successors: [...successors],
    });
  }

  const branchPostorderIndexes = [...branchingCandidates].map(
    (node) => postorderIndex.get(node) ?? -1,
  );
  const betterPath = (
    candidate: readonly LogicalQueryNode[],
    current: readonly LogicalQueryNode[] | undefined,
  ): boolean => {
    if (!current || candidate.length !== current.length)
      return !current || candidate.length > current.length;
    for (let index = 0; index < candidate.length; index += 1) {
      const candidateIndex = postorderIndex.get(candidate[index]!) ?? -1;
      const currentIndex = postorderIndex.get(current[index]!) ?? -1;
      if (candidateIndex !== currentIndex) return candidateIndex < currentIndex;
    }
    return false;
  };
  const longestPathEndingAt = new Map<
    LogicalQueryNode,
    readonly LogicalQueryNode[]
  >();
  const orderedCandidates = [...candidateNodes].sort(
    (left, right) => postorderIndex.get(left)! - postorderIndex.get(right)!,
  );
  for (const node of orderedCandidates) {
    const predecessors = neighbors.get(node)?.predecessors ?? [];
    let prefix: readonly LogicalQueryNode[] = [];
    for (const predecessor of predecessors) {
      const candidatePrefix = longestPathEndingAt.get(predecessor);
      if (candidatePrefix && betterPath(candidatePrefix, prefix))
        prefix = candidatePrefix;
    }
    longestPathEndingAt.set(node, [...prefix, node]);
  }
  let serialPath: readonly LogicalQueryNode[] = [];
  for (const path of longestPathEndingAt.values())
    if (betterPath(path, serialPath)) serialPath = path;
  const serialPostorderIndexes = serialPath.map(
    (node) => postorderIndex.get(node) ?? -1,
  );
  const selectionCandidateByNode = new Map<
    LogicalQueryNode,
    (typeof selectionCandidates)[number]
  >(
    selectionCandidates.map(
      (candidate) => [candidate.node, candidate] as const,
    ),
  );
  // Only internal nodes separate two proven rank regions. The source and
  // consumer endpoints describe the existing boundaries of the serial chain;
  // selecting either endpoint would turn a boundary into a new stage without
  // splitting two rank segments.
  const serialCuts = serialPath.slice(1, -1).flatMap((node) => {
    const candidate = selectionCandidateByNode.get(node);
    return candidate ? [candidate] : [];
  });
  if (serialCuts.length === 0)
    return unsupported(
      "no-eligible-stage-is-in-a-current-producer-chain",
      candidateNodes.size,
      0,
      {
        relationNeighbors: neighborDiagnostics(),
        branchingCandidatePostorderIndexes: branchPostorderIndexes,
        serialCandidatePostorderIndexes: serialPostorderIndexes,
      },
    );

  const serialCutNodes = new Set(serialCuts.map(({ node }) => node));
  const serialCutPostorderIndexes = serialCuts.map(
    ({ node }) => postorderIndex.get(node) ?? -1,
  );
  const topologyDiagnostics = {
    relationNeighbors: [...neighborDiagnostics()],
    branchingCandidatePostorderIndexes: branchPostorderIndexes,
    serialCandidatePostorderIndexes: serialPostorderIndexes,
    serialCutCandidatePostorderIndexes: serialCutPostorderIndexes,
  };
  // Derive the serial-cut order from the already-stable postorder index.
  const ordered = [...serialCuts].sort(
    (left, right) =>
      postorderIndex.get(left.node)! - postorderIndex.get(right.node)!,
  );
  if (ordered.length !== serialCutNodes.size)
    return unsupported(
      "eligible-stage-order-is-not-unique",
      candidateNodes.size,
      0,
      topologyDiagnostics,
    );
  for (let index = 0; index < ordered.length; index++) {
    const previous = nearestCandidates(
      ordered[index]!.node,
      relationChildren,
      baseDefinitionNodes,
      serialCutNodes,
    );
    const next = nearestCandidates(
      ordered[index]!.node,
      relationParents,
      baseDefinitionNodes,
      serialCutNodes,
    );
    const expectedPrevious = index > 0 ? ordered[index - 1]!.node : undefined;
    const expectedNext =
      index + 1 < ordered.length ? ordered[index + 1]!.node : undefined;
    if (
      previous.size !== (expectedPrevious ? 1 : 0) ||
      (expectedPrevious && !previous.has(expectedPrevious)) ||
      next.size !== (expectedNext ? 1 : 0) ||
      (expectedNext && !next.has(expectedNext))
    )
      return unsupported(
        "eligible-stage-relation-order-is-not-a-single-serial-chain",
        candidateNodes.size,
        0,
        {
          ...topologyDiagnostics,
        },
      );
  }

  const intervalSummaries: WindowSummary[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const stops = new Set(baseDefinitionNodes);
    if (index > 0) stops.add(ordered[index - 1]!.node);
    const summary = forwardWindowSummary(
      ordered[index]!.node,
      allSources,
      stops,
    );
    if (summary.cycle)
      return unsupported(
        "cycle-in-stage-window-segment",
        candidateNodes.size,
        0,
        {
          relationNeighbors: neighborDiagnostics(),
          rejectionNodePostorderIndex:
            postorderIndex.get(ordered[index]!.node) ?? -1,
        },
      );
    intervalSummaries.push(summary);
  }

  const internalCutSet = new Set(ordered.map(({ node }) => node));
  const suffixStops = new Set([...baseDefinitionNodes, ...internalCutSet]);
  suffixStops.delete(ordered[ordered.length - 1]!.node);
  const suffix = reverseWindowSummary(
    ordered[ordered.length - 1]!.node,
    allParents,
    suffixStops,
  );
  if (suffix.cycle)
    return unsupported(
      "cycle-in-stage-suffix-window-summary",
      candidateNodes.size,
      0,
      { relationNeighbors: neighborDiagnostics() },
    );

  const fixedStops = new Set([...baseDefinitionNodes, ...internalCutSet]);
  const fixedRoots = [
    args.root,
    ...args.baseDefinitions.map(({ node }) => node),
  ];
  let fixedWindowFloor = 0;
  const covered = new Set<LogicalQueryNode>();
  for (const producer of fixedRoots) {
    const summary = forwardWindowSummary(producer, allSources, fixedStops);
    if (summary.cycle)
      return unsupported(
        "cycle-in-fixed-producer-window-summary",
        candidateNodes.size,
        0,
        {
          relationNeighbors: neighborDiagnostics(),
          rejectionNodePostorderIndex: postorderIndex.get(producer) ?? -1,
        },
      );
    fixedWindowFloor = Math.max(fixedWindowFloor, summary.depth);
    summary.windows.forEach((window) => covered.add(window));
  }
  const intervalOwners = new Map<LogicalQueryNode, number[]>();
  intervalSummaries.forEach((summary, segmentIndex) => {
    summary.windows.forEach((window) => {
      const owners = intervalOwners.get(window) ?? [];
      owners.push(segmentIndex);
      intervalOwners.set(window, owners);
      covered.add(window);
    });
  });
  suffix.windows.forEach((window) => covered.add(window));
  const overlapping = [...intervalOwners.values()].some(
    (owners) => owners.length > 1,
  );
  const allWindowNodes = args.nodes.filter((node) => node.kind === "window");
  const unaccountedWindows = allWindowNodes.filter(
    (window) => !covered.has(window),
  );
  const windowCoverage = {
    totalWindowCount: allWindowNodes.length,
    coveredWindowCount: allWindowNodes.length - unaccountedWindows.length,
    uncoveredWindowPostorderIndexes: unaccountedWindows.map(
      (window) => postorderIndex.get(window) ?? -1,
    ),
    intervalsOverlap: overlapping,
  };
  if (overlapping || unaccountedWindows.length > 0)
    return unsupported(
      overlapping
        ? "stage-window-intervals-overlap"
        : "some-windows-are-not-covered-by-fixed-or-stage-segments",
      candidateNodes.size,
      fixedWindowFloor,
      {
        relationNeighbors: neighborDiagnostics(),
        windowCoverage,
      },
    );

  const cuts: BalancedStageCut[] = ordered.map(({ node }) => ({
    node,
    postorderIndex: postorderIndex.get(node)!,
    eligible: true,
  }));
  const segmentWeights = [
    ...intervalSummaries.map(({ depth }) => depth),
    suffix.depth,
  ];
  const selection = selectBalancedStageCuts({
    segmentWeights,
    cuts,
    fixedWindowFloor,
  });
  const selected = selection.selected.flatMap((cut) => {
    const shape = ordered.find(({ node }) => node === cut.node);
    return shape ? [shape] : [];
  });
  return makeProof(
    selection.selected.length === 0 ? "zero-cuts" : "selected",
    selected,
    candidateNodes.size,
    fixedWindowFloor,
    segmentWeights,
    selection.objective,
    {
      ...topologyDiagnostics,
      windowCoverage,
      dynamicProgram: {
        segmentWeights,
        fixedWindowFloor,
        eligiblePostorderIndexes: cuts.map((cut) => cut.postorderIndex),
        selectedPostorderIndexes: selection.selected.map(
          (cut) => cut.postorderIndex,
        ),
        objective: selection.objective,
      },
      ...(selection.selected.length === 0
        ? { selectionFailure: "balanced-dp-selected-zero-cuts" }
        : {}),
    },
  );
}

/** Fresh base licenses are preserved while selected boundary evidence is reissued. */
export interface FreshMaterializationLicense {
  readonly definition: SharedRelationDefinition;
  readonly license:
    | "strict-serial-rank-stage"
    | "stage-derived-auto"
    | "current-boundary-derived-auto";
  readonly selection: PhysicalMaterializationSelection;
  readonly proof: {
    readonly kind: "fresh-body-and-reader-proof";
    readonly bodyTotalAndClosed: true;
    readonly readerContextsTotal: true;
    readonly readerContextCount: number;
    readonly stoppedAt: readonly LogicalQueryNode[];
  };
}

export type FreshMaterializationLicenseMap = ReadonlyMap<
  LogicalQueryNode,
  FreshMaterializationLicense
>;
