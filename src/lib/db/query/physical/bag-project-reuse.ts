import { hasSafeBoundedUnitSumInput } from "@/lib/db/query/bounded-unit-sum-proof";
import type { CandidateFacts } from "@/lib/db/query/physical/materialization-context";
import { isCurrentDirectColumnProject } from "@/lib/db/query/physical/materialization-context";
import { isCurrentMaterializationInterface } from "@/lib/db/query/physical/materialization-reader-context";
import type { MaterializationConsumerEdge } from "@/lib/db/query/physical/materialization-selection";
import type { PhysicalSharedRelationBoundaryEvidence } from "@/lib/db/query/physical/shared-relation-interfaces";
import type { LogicalQueryNode, QuerySource } from "@/lib/db/query/plan";

export interface CurrentBoundaryBagProjectInput {
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
  ) => CandidateFacts;
  readonly candidateFactsAreClosed: (
    facts: CandidateFacts,
    boundaries: ReadonlyMap<
      LogicalQueryNode,
      PhysicalSharedRelationBoundaryEvidence
    >,
  ) => boolean;
}

const MAX_BAG_PROJECT_FIELDS = 16;

function currentSource(
  source: QuerySource,
  input: CurrentBoundaryBagProjectInput,
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

function aggregateIsOrderIndependent(
  node: Extract<LogicalQueryNode, { readonly kind: "aggregate" }>,
): boolean {
  return (
    node.aggregates.length > 0 &&
    node.aggregates.every(
      ({ expression }) =>
        expression.kind === "aggregate" &&
        (expression.name === "COUNT" ||
          (expression.name === "SUM" &&
            hasSafeBoundedUnitSumInput(expression, node.input))),
    )
  );
}

function membershipObservation(
  edge: MaterializationConsumerEdge,
  currentNodes: ReadonlySet<LogicalQueryNode>,
  input: CurrentBoundaryBagProjectInput,
): boolean {
  const { parent, source, child } = edge;
  if (
    edge.kind !== "relation" ||
    (parent.kind !== "semi-join" && parent.kind !== "anti-join") ||
    source !== parent.right ||
    parent.left === parent.right ||
    parent.right.node !== child ||
    !currentNodes.has(parent) ||
    !currentNodes.has(child) ||
    !currentSource(parent.left, input) ||
    !currentSource(parent.right, input) ||
    !input.sameFields(parent.fields, parent.left.fields)
  )
    return false;

  // Reader-local safety and whole-branch closure are checked before this
  // membership terminal. The compiler keeps the original EXISTS condition.
  return true;
}

function edgeMatchesCurrentSource(
  edge: MaterializationConsumerEdge,
  input: CurrentBoundaryBagProjectInput,
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

function readerPathsAreOrderIndependent(
  candidate: LogicalQueryNode,
  directReaders: readonly MaterializationConsumerEdge[],
  parents: ReadonlyMap<
    LogicalQueryNode,
    readonly MaterializationConsumerEdge[]
  >,
  currentNodes: ReadonlySet<LogicalQueryNode>,
  input: CurrentBoundaryBagProjectInput,
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
    if (facts.unsafe || !input.candidateFactsAreClosed(facts, input.interfaces))
      return false;

    if (node.kind === "aggregate") {
      const passed =
        edge.source === node.input && aggregateIsOrderIndependent(node);
      completedEdges.set(edge, passed);
      return passed;
    }
    if (
      (node.kind === "semi-join" || node.kind === "anti-join") &&
      edge.source === node.right
    ) {
      const passed = membershipObservation(edge, currentNodes, input);
      completedEdges.set(edge, passed);
      return passed;
    }

    if (
      (node.kind === "semi-join" || node.kind === "anti-join") &&
      edge.source !== node.left
    )
      return false;
    if (node.kind === "project" || node.kind === "filter") {
      if (edge.source !== node.input) return false;
    } else if (node.kind === "join") {
      if (
        (node.joinType !== "inner" && node.joinType !== "left") ||
        (edge.source !== node.left && edge.source !== node.right)
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
    } else if (node.kind !== "semi-join" && node.kind !== "anti-join") {
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
 * Selects fresh direct-column Projects whose authenticated body and every
 * actual data reader are closed before any order-sensitive boundary.
 */
export function currentBoundaryBagProjectCandidates(
  input: CurrentBoundaryBagProjectInput,
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
      !isCurrentDirectColumnProject(node) ||
      node.fields.length < 1 ||
      node.fields.length > MAX_BAG_PROJECT_FIELDS
    )
      continue;

    const directReaders = parents.get(node) ?? [];
    const distinctParents = new Set(directReaders.map(({ parent }) => parent));
    if (
      directReaders.length !== (input.incomingCounts.get(node) ?? 0) ||
      directReaders.length < 2 ||
      directReaders.some(({ kind }) => kind !== "relation") ||
      distinctParents.size < 2 ||
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
      body.rowNumberWindow ||
      !input.candidateFactsAreClosed(body, input.interfaces)
    )
      continue;

    if (
      readerPathsAreOrderIndependent(
        node,
        directReaders,
        parents,
        currentNodes,
        input,
        factsFor,
      )
    )
      candidates.add(node);
  }
  return candidates;
}
