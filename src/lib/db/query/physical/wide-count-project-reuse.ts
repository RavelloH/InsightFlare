import type { SqlExpression } from "@/lib/db/query/expression";
import {
  isTextComparisonStorageClass,
  semiMembershipBinaryCollation,
  semiMembershipComparisonDomain,
} from "@/lib/db/query/physical/comparison-domains";
import type { CandidateFacts } from "@/lib/db/query/physical/materialization-context";
import { isCurrentDirectColumnProject } from "@/lib/db/query/physical/materialization-context";
import { isCurrentMaterializationInterface } from "@/lib/db/query/physical/materialization-reader-context";
import type { MaterializationConsumerEdge } from "@/lib/db/query/physical/materialization-selection";
import type { PhysicalSharedRelationBoundaryEvidence } from "@/lib/db/query/physical/shared-relation-interfaces";
import type {
  LogicalQueryNode,
  QuerySource,
  SemiJoinNode,
} from "@/lib/db/query/plan";

export interface CurrentBoundaryWideCountProjectInput {
  readonly root: LogicalQueryNode;
  readonly postorder: readonly LogicalQueryNode[];
  readonly incomingCounts: ReadonlyMap<LogicalQueryNode, number>;
  readonly edges: readonly MaterializationConsumerEdge[];
  readonly interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly sameFields: (
    left: QuerySource["fields"],
    right: QuerySource["fields"],
  ) => boolean;
  readonly candidateFacts: (
    node: LogicalQueryNode,
    boundaries: ReadonlyMap<
      LogicalQueryNode,
      PhysicalSharedRelationBoundaryEvidence
    >,
    readerWindowTotality?: (
      node: Extract<LogicalQueryNode, { kind: "window" }>,
    ) => boolean,
  ) => CandidateFacts;
  readonly candidateFactsAreClosed: (
    facts: CandidateFacts,
    boundaries: ReadonlyMap<
      LogicalQueryNode,
      PhysicalSharedRelationBoundaryEvidence
    >,
  ) => boolean;
  readonly isSafeWindow: (
    node: Extract<LogicalQueryNode, { kind: "window" }>,
  ) => boolean;
  readonly isTotalOrderedReaderWindow: (
    node: Extract<LogicalQueryNode, { kind: "window" }>,
  ) => boolean;
}

const MIN_WIDE_COUNT_PROJECT_FIELDS = 17;
const MAX_WIDE_COUNT_PROJECT_FIELDS = 32;
const MIN_WIDE_COUNT_PROJECT_READERS = 8;
const MIN_EXPENSIVE_PROJECT_READERS = 3;
const MIN_UNSHARED_BODY_WEIGHT = 256;

function currentSource(
  source: QuerySource,
  input: CurrentBoundaryWideCountProjectInput,
): boolean {
  return (
    source.node.scope === source.scope &&
    input.sameFields(source.node.fields, source.fields)
  );
}

function relationSources(node: LogicalQueryNode): readonly QuerySource[] {
  switch (node.kind) {
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return [];
    case "filter":
    case "project":
    case "aggregate":
    case "distinct":
    case "window":
    case "sort":
    case "limit":
      return [node.input];
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return [node.left, node.right];
    case "recursive-closure":
      return [node.seed, node.candidates];
  }
}

function hasExpensiveUnsharedBody(
  candidate: LogicalQueryNode,
  interfaces: CurrentBoundaryWideCountProjectInput["interfaces"],
): boolean {
  const visited = new Set<LogicalQueryNode>();
  const pending = [candidate];
  let weight = 0;
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node !== candidate && interfaces.has(node)) continue;
    weight += 1 + node.fields.length;
    if (weight >= MIN_UNSHARED_BODY_WEIGHT) return true;
    for (const source of relationSources(node)) pending.push(source.node);
  }
  return false;
}

function graphIsAcyclic(
  root: LogicalQueryNode,
  edges: readonly MaterializationConsumerEdge[],
): boolean {
  const children = new Map<LogicalQueryNode, LogicalQueryNode[]>();
  for (const edge of edges) {
    const values = children.get(edge.parent) ?? [];
    values.push(edge.child);
    children.set(edge.parent, values);
  }
  const active = new Set<LogicalQueryNode>();
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): boolean => {
    if (active.has(node)) return false;
    if (visited.has(node)) return true;
    active.add(node);
    for (const child of children.get(node) ?? [])
      if (!visit(child)) return false;
    active.delete(node);
    visited.add(node);
    return true;
  };
  return visit(root);
}

function hasExpressionQueryEdge(
  node: LogicalQueryNode,
  edges: readonly MaterializationConsumerEdge[],
): boolean {
  return edges.some(
    (edge) => edge.parent === node && edge.kind === "expression",
  );
}

function relationSubtreeIsAdmissible(
  root: LogicalQueryNode,
  currentNodes: ReadonlySet<LogicalQueryNode>,
  edges: readonly MaterializationConsumerEdge[],
  input: CurrentBoundaryWideCountProjectInput,
): boolean {
  const active = new Set<LogicalQueryNode>();
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): boolean => {
    if (!currentNodes.has(node) || active.has(node)) return false;
    if (visited.has(node)) return true;
    if (node !== root && input.interfaces.has(node)) {
      visited.add(node);
      return true;
    }
    if (hasExpressionQueryEdge(node, edges)) return false;
    if (node.kind === "window" && !input.isSafeWindow(node)) return false;
    active.add(node);
    for (const source of relationSources(node)) {
      if (
        source.node.scope !== source.scope ||
        !input.sameFields(source.node.fields, source.fields) ||
        !visit(source.node)
      )
        return false;
    }
    active.delete(node);
    visited.add(node);
    return true;
  };
  return visit(root);
}

function edgeMatchesCurrentSource(
  edge: MaterializationConsumerEdge,
  input: CurrentBoundaryWideCountProjectInput,
  currentNodes: ReadonlySet<LogicalQueryNode>,
): boolean {
  return (
    edge.kind === "relation" &&
    currentNodes.has(edge.parent) &&
    currentNodes.has(edge.child) &&
    edge.source.node === edge.child &&
    currentSource(edge.source, input) &&
    relationSources(edge.parent).some((source) => source === edge.source)
  );
}

interface CandidateWindowDependency {
  readonly valid: boolean;
  readonly rowData: boolean;
  readonly membership: boolean;
}

function windowInputHasOnlyCandidateMembership(
  root: LogicalQueryNode,
  candidate: LogicalQueryNode,
  currentNodes: ReadonlySet<LogicalQueryNode>,
  parents: ReadonlyMap<
    LogicalQueryNode,
    readonly MaterializationConsumerEdge[]
  >,
  input: CurrentBoundaryWideCountProjectInput,
  memo: Map<LogicalQueryNode, CandidateWindowDependency>,
): boolean {
  const active = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): CandidateWindowDependency => {
    if (node === candidate)
      return {
        valid: currentNodes.has(node),
        rowData: true,
        membership: false,
      };
    if (!currentNodes.has(node) || active.has(node))
      return { valid: false, rowData: false, membership: false };
    const cached = memo.get(node);
    if (cached) return cached;
    if (hasExpressionQueryEdge(node, input.edges))
      return { valid: false, rowData: false, membership: false };

    active.add(node);
    const dependencies: CandidateWindowDependency[] = [];
    for (const source of relationSources(node)) {
      const matchingEdges = (parents.get(source.node) ?? []).filter(
        (edge) => edge.parent === node && edge.source === source,
      );
      if (
        !currentSource(source, input) ||
        matchingEdges.length !== 1 ||
        !edgeMatchesCurrentSource(matchingEdges[0]!, input, currentNodes)
      ) {
        active.delete(node);
        return { valid: false, rowData: false, membership: false };
      }
      dependencies.push(visit(source.node));
    }
    active.delete(node);
    if (dependencies.some(({ valid }) => !valid))
      return { valid: false, rowData: false, membership: false };

    let result: CandidateWindowDependency;
    if (node.kind === "semi-join" || node.kind === "anti-join") {
      if (
        node.left === node.right ||
        node.left.node === node.right.node ||
        node.left.scope === node.right.scope ||
        !input.sameFields(node.fields, node.left.fields)
      )
        return { valid: false, rowData: false, membership: false };
      const [left, right] = dependencies;
      if (!left || !right)
        return { valid: false, rowData: false, membership: false };
      result = {
        valid: true,
        rowData: left.rowData,
        membership: left.membership || right.rowData || right.membership,
      };
    } else {
      result = {
        valid: true,
        rowData: dependencies.some(({ rowData }) => rowData),
        membership: dependencies.some(({ membership }) => membership),
      };
    }
    memo.set(node, result);
    return result;
  };

  const dependency = visit(root);
  return dependency.valid && !dependency.rowData && dependency.membership;
}

function currentColumnIndex(
  expression: SqlExpression,
  source: QuerySource,
  input: CurrentBoundaryWideCountProjectInput,
): number | undefined {
  if (
    expression.kind !== "column" ||
    expression.scope !== source.scope ||
    !Number.isSafeInteger(expression.index) ||
    expression.index < 0 ||
    expression.index >= source.fields.length
  )
    return undefined;
  const field = source.fields[expression.index];
  if (
    !field ||
    field.name !== expression.name ||
    field.affinity !== expression.resultType.affinity ||
    field.nullable !== expression.resultType.nullable ||
    source.node.scope !== source.scope ||
    !input.sameFields(source.node.fields, source.fields)
  )
    return undefined;
  return expression.index;
}

interface MembershipEqualityPair {
  readonly leftIndex: number;
  readonly rightIndex: number;
}

function directMembershipEqualityPairs(
  node: SemiJoinNode,
  input: CurrentBoundaryWideCountProjectInput,
): readonly MembershipEqualityPair[] | undefined {
  if (
    node.left === node.right ||
    node.left.node === node.right.node ||
    node.left.scope === node.right.scope ||
    !currentSource(node.left, input) ||
    !currentSource(node.right, input) ||
    !input.sameFields(node.fields, node.left.fields)
  )
    return undefined;

  const pairs: MembershipEqualityPair[] = [];
  const visit = (expression: SqlExpression): boolean => {
    if (expression.kind === "boolean") {
      if (expression.operator !== "AND" || expression.expressions.length === 0)
        return false;
      return expression.expressions.every(visit);
    }
    if (expression.kind !== "binary" || expression.operator !== "=")
      return false;
    const leftFromLeft = currentColumnIndex(expression.left, node.left, input);
    const rightFromRight = currentColumnIndex(
      expression.right,
      node.right,
      input,
    );
    if (leftFromLeft !== undefined && rightFromRight !== undefined) {
      pairs.push({ leftIndex: leftFromLeft, rightIndex: rightFromRight });
      return true;
    }
    const leftFromRight = currentColumnIndex(
      expression.left,
      node.right,
      input,
    );
    const rightFromLeft = currentColumnIndex(
      expression.right,
      node.left,
      input,
    );
    if (leftFromRight !== undefined && rightFromLeft !== undefined) {
      pairs.push({ leftIndex: rightFromLeft, rightIndex: leftFromRight });
      return true;
    }
    return false;
  };

  return visit(node.condition) && pairs.length > 0 ? pairs : undefined;
}

function membershipComparisonDomainIsTextAndBinary(
  node: SemiJoinNode,
  pair: MembershipEqualityPair,
): boolean {
  for (const [source, index] of [
    [node.left, pair.leftIndex],
    [node.right, pair.rightIndex],
  ] as const) {
    const domain = semiMembershipComparisonDomain(source, index);
    const collation = semiMembershipBinaryCollation(source, index);
    if (
      domain.kind !== "proven" ||
      domain.domain.affinity !== "text" ||
      !domain.domain.storageClasses.every(isTextComparisonStorageClass) ||
      collation.kind !== "binary"
    )
      return false;
  }
  return true;
}

function membershipObservation(
  edge: MaterializationConsumerEdge,
  currentNodes: ReadonlySet<LogicalQueryNode>,
  parents: ReadonlyMap<
    LogicalQueryNode,
    readonly MaterializationConsumerEdge[]
  >,
  input: CurrentBoundaryWideCountProjectInput,
  factsFor: (node: LogicalQueryNode) => CandidateFacts,
  requireTextBinaryDomain: boolean,
): boolean {
  const { parent, source, child } = edge;
  if (
    edge.kind !== "relation" ||
    (parent.kind !== "semi-join" && parent.kind !== "anti-join") ||
    source !== parent.right ||
    parent.right.node !== child ||
    !currentNodes.has(parent) ||
    !currentNodes.has(child) ||
    !currentSource(parent.left, input) ||
    !currentSource(parent.right, input) ||
    parent.left === parent.right ||
    parent.left.node === parent.right.node ||
    parent.left.scope === parent.right.scope ||
    !input.sameFields(parent.fields, parent.left.fields) ||
    hasExpressionQueryEdge(parent, input.edges)
  )
    return false;

  const facts = factsFor(parent);
  if (facts.unsafe || !input.candidateFactsAreClosed(facts, input.interfaces))
    return false;

  const pairs = directMembershipEqualityPairs(parent, input);
  return Boolean(
    pairs &&
    (!requireTextBinaryDomain ||
      pairs.every((pair) =>
        membershipComparisonDomainIsTextAndBinary(parent, pair),
      )) &&
    (parents.get(child) ?? []).some((reader) => reader === edge),
  );
}

function distinctOnlyFeedsMembershipRight(
  node: Extract<LogicalQueryNode, { kind: "distinct" }>,
  root: LogicalQueryNode,
  currentNodes: ReadonlySet<LogicalQueryNode>,
  parents: ReadonlyMap<
    LogicalQueryNode,
    readonly MaterializationConsumerEdge[]
  >,
  input: CurrentBoundaryWideCountProjectInput,
  factsFor: (node: LogicalQueryNode) => CandidateFacts,
): boolean {
  const readers = parents.get(node) ?? [];
  return (
    node !== root &&
    input.sameFields(node.fields, node.input.fields) &&
    readers.length > 0 &&
    new Set(readers.map(({ parent }) => parent)).size === readers.length &&
    readers.every((edge) =>
      membershipObservation(edge, currentNodes, parents, input, factsFor, true),
    )
  );
}

function aggregateIsCountOnly(
  node: Extract<LogicalQueryNode, { kind: "aggregate" }>,
): boolean {
  return (
    node.aggregates.length > 0 &&
    node.aggregates.every(
      ({ expression }) =>
        expression.kind === "aggregate" && expression.name === "COUNT",
    )
  );
}

function readerPathsEndAtCountOrExists(
  candidate: LogicalQueryNode,
  directReaders: readonly MaterializationConsumerEdge[],
  parents: ReadonlyMap<
    LogicalQueryNode,
    readonly MaterializationConsumerEdge[]
  >,
  currentNodes: ReadonlySet<LogicalQueryNode>,
  input: CurrentBoundaryWideCountProjectInput,
  factsFor: (node: LogicalQueryNode) => CandidateFacts,
): boolean {
  const active = new Set<LogicalQueryNode>();
  const completedEdges = new Map<MaterializationConsumerEdge, boolean>();

  const visit = (edge: MaterializationConsumerEdge): boolean => {
    const cached = completedEdges.get(edge);
    if (cached !== undefined) return cached;
    if (edge.child !== candidate && !currentNodes.has(edge.child)) return false;
    if (!edgeMatchesCurrentSource(edge, input, currentNodes)) return false;

    const node = edge.parent;
    if (active.has(node)) return false;
    const facts = factsFor(node);
    if (
      facts.unsafe ||
      !input.candidateFactsAreClosed(facts, input.interfaces) ||
      hasExpressionQueryEdge(node, input.edges)
    )
      return false;

    if (node.kind === "aggregate") {
      const passed = edge.source === node.input && aggregateIsCountOnly(node);
      completedEdges.set(edge, passed);
      return passed;
    }
    if (node.kind === "distinct") {
      const passed =
        edge.source === node.input &&
        currentSource(node.input, input) &&
        distinctOnlyFeedsMembershipRight(
          node,
          input.root,
          currentNodes,
          parents,
          input,
          factsFor,
        );
      completedEdges.set(edge, passed);
      return passed;
    }
    if (
      (node.kind === "semi-join" || node.kind === "anti-join") &&
      edge.source === node.right
    ) {
      const passed = membershipObservation(
        edge,
        currentNodes,
        parents,
        input,
        factsFor,
        false,
      );
      completedEdges.set(edge, passed);
      return passed;
    }

    if (
      (node.kind === "semi-join" || node.kind === "anti-join") &&
      edge.source !== node.left
    )
      return false;
    if (node.kind === "project") {
      if (edge.source !== node.input || !currentSource(node.input, input))
        return false;
    } else if (node.kind === "filter") {
      if (edge.source !== node.input || !currentSource(node.input, input))
        return false;
    } else if (node.kind === "join") {
      if (
        (node.joinType !== "inner" && node.joinType !== "left") ||
        (edge.source !== node.left && edge.source !== node.right) ||
        !currentSource(node.left, input) ||
        !currentSource(node.right, input)
      )
        return false;
    } else if (node.kind === "union") {
      if (
        !node.all ||
        !input.sameFields(node.left.fields, node.right.fields) ||
        !input.sameFields(node.fields, node.left.fields) ||
        (edge.source !== node.left && edge.source !== node.right)
      )
        return false;
    } else if (node.kind === "window") {
      if (
        edge.source !== node.input ||
        !currentSource(node.input, input) ||
        !input.isSafeWindow(node)
      )
        return false;
    } else if (node.kind === "semi-join" || node.kind === "anti-join") {
      if (
        edge.source !== node.left ||
        !currentSource(node.left, input) ||
        !currentSource(node.right, input) ||
        node.left === node.right ||
        node.left.node === node.right.node ||
        node.left.scope === node.right.scope ||
        !input.sameFields(node.fields, node.left.fields)
      )
        return false;
    } else {
      return false;
    }

    if (node === input.root) return false;
    const next = parents.get(node) ?? [];
    if (next.length === 0 || next.some(({ kind }) => kind !== "relation"))
      return false;
    active.add(node);
    const passed = next.every(visit);
    active.delete(node);
    completedEdges.set(edge, passed);
    return passed;
  };

  return directReaders.every(visit);
}

/**
 * Selects fresh 17–32-column direct Projects with complete reader proofs.
 * Eight readers suffice; three suffice for a substantial unshared body.
 */
export function currentBoundaryWideCountProjectCandidates(
  input: CurrentBoundaryWideCountProjectInput,
): ReadonlySet<LogicalQueryNode> {
  const currentNodes = new Set(input.postorder);
  if (
    input.interfaces.size === 0 ||
    !currentNodes.has(input.root) ||
    !graphIsAcyclic(input.root, input.edges)
  )
    return new Set();
  for (const [node, evidence] of input.interfaces) {
    if (
      !currentNodes.has(node) ||
      !isCurrentMaterializationInterface(
        node,
        evidence.definition,
        evidence,
        input.sameFields,
      )
    )
      return new Set();
  }

  const parents = new Map<LogicalQueryNode, MaterializationConsumerEdge[]>();
  for (const edge of input.edges) {
    const values = parents.get(edge.child) ?? [];
    values.push(edge);
    parents.set(edge.child, values);
  }
  const factsMemo = new Map<LogicalQueryNode, CandidateFacts>();
  const factsFor = (node: LogicalQueryNode): CandidateFacts => {
    let facts = factsMemo.get(node);
    if (!facts) {
      facts = input.candidateFacts(node, input.interfaces);
      factsMemo.set(node, facts);
    }
    return facts;
  };

  const candidates = new Set<LogicalQueryNode>();
  for (const node of input.postorder) {
    if (
      node === input.root ||
      !isCurrentDirectColumnProject(node) ||
      node.fields.length < MIN_WIDE_COUNT_PROJECT_FIELDS ||
      node.fields.length > MAX_WIDE_COUNT_PROJECT_FIELDS ||
      !relationSubtreeIsAdmissible(node, currentNodes, input.edges, input)
    )
      continue;

    const directReaders = parents.get(node) ?? [];
    if (
      directReaders.length !== (input.incomingCounts.get(node) ?? 0) ||
      directReaders.length < MIN_EXPENSIVE_PROJECT_READERS ||
      directReaders.some(({ kind }) => kind !== "relation") ||
      new Set(directReaders.map(({ parent }) => parent)).size !==
        directReaders.length ||
      directReaders.some(
        (edge) => !edgeMatchesCurrentSource(edge, input, currentNodes),
      )
    )
      continue;

    const body = factsFor(node);
    if (
      !body.selective ||
      !body.materializedBoundary ||
      body.materializedBoundariesUsed.size === 0 ||
      body.forbidden ||
      body.unsafe ||
      !input.candidateFactsAreClosed(body, input.interfaces)
    )
      continue;
    if (
      directReaders.length < MIN_WIDE_COUNT_PROJECT_READERS &&
      !hasExpensiveUnsharedBody(node, input.interfaces)
    )
      continue;

    const readerFactsMemo = new Map<LogicalQueryNode, CandidateFacts>();
    const candidateWindowDependencies = new Map<
      LogicalQueryNode,
      CandidateWindowDependency
    >();
    const factsForReader = (reader: LogicalQueryNode): CandidateFacts => {
      let facts = readerFactsMemo.get(reader);
      if (!facts) {
        facts = input.candidateFacts(
          reader,
          input.interfaces,
          (windowNode) =>
            input.isTotalOrderedReaderWindow(windowNode) &&
            windowInputHasOnlyCandidateMembership(
              windowNode.input.node,
              node,
              currentNodes,
              parents,
              input,
              candidateWindowDependencies,
            ),
        );
        readerFactsMemo.set(reader, facts);
      }
      return facts;
    };

    if (
      readerPathsEndAtCountOrExists(
        node,
        directReaders,
        parents,
        currentNodes,
        input,
        factsForReader,
      )
    )
      candidates.add(node);
  }
  return candidates;
}
