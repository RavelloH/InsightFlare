import type {
  BoundedAdmissionEvidence,
  BoundedAdmissionIncomingEdge,
} from "./bounded-admission-reuse";
import {
  type ClosedStableSubtreeEvidence,
  inspectClosedStableSubtree,
} from "./complete-keyed-lookup-reuse";
import type { SqlExpression } from "./expression";
import type { AggregateNode, LogicalQueryNode, QuerySource } from "./plan";

export interface BoundedFactLocalReuseEvidence {
  readonly owner: AggregateNode;
  readonly candidateKind:
    "carrier" | "global-admission-join" | "grouped-summary";
}

export interface BoundedFactLocalReuseInput {
  readonly root: LogicalQueryNode;
  readonly nodes: readonly LogicalQueryNode[];
  readonly incomingCounts: ReadonlyMap<LogicalQueryNode, number>;
  readonly incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly BoundedAdmissionIncomingEdge[]
  >;
  readonly completeFacts: ReadonlySet<LogicalQueryNode>;
  readonly boundedAdmissions: ReadonlyMap<
    LogicalQueryNode,
    BoundedAdmissionEvidence
  >;
  /** Every already selected shared relation is a hard boundary. */
  readonly sharedBoundaries: ReadonlySet<LogicalQueryNode>;
  readonly maximumFields: number;
}

function relationChildren(node: LogicalQueryNode): readonly LogicalQueryNode[] {
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
      return [node.input.node];
    case "recursive-closure":
      return [node.seed.node, node.candidates.node];
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return [node.left.node, node.right.node];
  }
}

function nodeExpressions(node: LogicalQueryNode): readonly SqlExpression[] {
  switch (node.kind) {
    case "filter":
      return [node.predicate];
    case "project":
      return node.projections.map(({ expression }) => expression);
    case "join":
    case "semi-join":
    case "anti-join":
      return [node.condition];
    case "aggregate":
      return [
        ...node.groups.map(({ expression }) => expression),
        ...node.aggregates.map(({ expression }) => expression),
      ];
    case "window":
      return node.windows.flatMap(({ specification }) => [
        ...specification.partitionBy,
        ...(specification.kind === "row-number"
          ? specification.orderBy.map(({ expression }) => expression)
          : []),
      ]);
    case "sort":
      return node.keys.map(({ expression }) => expression);
    case "limit":
      return [node.count, ...(node.offset ? [node.offset] : [])];
    case "recursive-closure":
      return [node.predicate];
    case "scan":
    case "values-relation":
    case "json-scalar-array":
    case "distinct":
    case "union":
      return [];
  }
}

function expressionHasUnsafeEagerEvaluation(
  expression: SqlExpression,
): boolean {
  switch (expression.kind) {
    case "binary":
    case "distinct-from":
      return (
        expressionHasUnsafeEagerEvaluation(expression.left) ||
        expressionHasUnsafeEagerEvaluation(expression.right)
      );
    case "boolean":
      return expression.expressions.some(expressionHasUnsafeEagerEvaluation);
    case "not":
    case "null-check":
    case "in-list":
    case "cast-integer":
    case "cast-real":
    case "cast-text":
      return expressionHasUnsafeEagerEvaluation(expression.expression);
    case "text-position":
      return (
        expressionHasUnsafeEagerEvaluation(expression.text) ||
        expressionHasUnsafeEagerEvaluation(expression.needle)
      );
    case "text-substring":
      return (
        expressionHasUnsafeEagerEvaluation(expression.text) ||
        expressionHasUnsafeEagerEvaluation(expression.start) ||
        (expression.length !== undefined &&
          expressionHasUnsafeEagerEvaluation(expression.length))
      );
    case "text-like":
      return (
        expressionHasUnsafeEagerEvaluation(expression.text) ||
        expressionHasUnsafeEagerEvaluation(expression.pattern)
      );
    case "function":
      return (
        expression.name === "abs" ||
        expression.arguments.some(expressionHasUnsafeEagerEvaluation)
      );
    case "aggregate":
      return (
        expression.expression !== undefined &&
        expressionHasUnsafeEagerEvaluation(expression.expression)
      );
    case "coalesce":
      return expression.expressions.some(expressionHasUnsafeEagerEvaluation);
    case "case":
      return (
        expression.branches.some(
          ({ when, then }) =>
            expressionHasUnsafeEagerEvaluation(when) ||
            expressionHasUnsafeEagerEvaluation(then),
        ) ||
        (expression.else !== undefined &&
          expressionHasUnsafeEagerEvaluation(expression.else))
      );
    case "in-subquery":
    case "scalar-subquery":
      return true;
    case "column":
    case "parameter":
    case "excluded":
    case "constant":
    case "unixepoch":
      return false;
  }
}

function subtreeHasUnsafeEagerEvaluation(
  root: LogicalQueryNode,
  boundedAdmissions: ReadonlyMap<LogicalQueryNode, BoundedAdmissionEvidence>,
  admissionCounters: ReadonlyMap<LogicalQueryNode, LogicalQueryNode>,
): boolean {
  const pending = [root];
  const visited = new Set<LogicalQueryNode>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (boundedAdmissions.has(node) || admissionCounters.has(node)) continue;
    if (nodeExpressions(node).some(expressionHasUnsafeEagerEvaluation))
      return true;
    pending.push(...relationChildren(node));
  }
  return false;
}

function relationSubtree(root: LogicalQueryNode): Set<LogicalQueryNode> {
  const result = new Set<LogicalQueryNode>();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (result.has(node)) continue;
    result.add(node);
    pending.push(...relationChildren(node));
  }
  return result;
}

function sameFieldsExactly(
  left: QuerySource["fields"],
  right: QuerySource["fields"],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (field, index) =>
        field.name === right[index]?.name &&
        field.affinity === right[index]?.affinity &&
        field.nullable === right[index]?.nullable,
    )
  );
}

function unionAllOutputFieldsMatch(
  node: Extract<LogicalQueryNode, { readonly kind: "union" }>,
): boolean {
  return (
    node.all &&
    node.fields.length === node.left.fields.length &&
    node.fields.length === node.right.fields.length &&
    node.fields.every((field, index) => {
      const left = node.left.fields[index];
      const right = node.right.fields[index];
      return (
        left !== undefined &&
        right !== undefined &&
        field.name === left.name &&
        field.name === right.name &&
        field.affinity !== "unknown" &&
        field.affinity === left.affinity &&
        field.affinity === right.affinity &&
        field.nullable === (left.nullable || right.nullable)
      );
    })
  );
}

function typedOne(expression: SqlExpression): boolean {
  return (
    (expression.kind === "constant" || expression.kind === "parameter") &&
    expression.value === 1 &&
    expression.resultType.affinity === "integer" &&
    expression.resultType.nullable === false
  );
}

function isGlobalTrueAdmissionJoin(
  node: LogicalQueryNode,
  boundedAdmissions: ReadonlyMap<LogicalQueryNode, BoundedAdmissionEvidence>,
): boolean {
  if (
    node.kind !== "join" ||
    node.joinType !== "inner" ||
    node.condition.kind !== "binary" ||
    node.condition.operator !== "=" ||
    !typedOne(node.condition.left) ||
    !typedOne(node.condition.right) ||
    node.condition.resultType.affinity !== "integer" ||
    node.condition.resultType.nullable
  )
    return false;
  const descendants = relationSubtree(node);
  return [...boundedAdmissions.values()].some(({ admissionFilter }) =>
    descendants.has(admissionFilter),
  );
}

function oneOfIntegerLiterals(expression: SqlExpression): boolean {
  return (
    (expression.kind === "constant" || expression.kind === "parameter") &&
    (expression.value === 0 || expression.value === 1) &&
    (expression.resultType.affinity === "integer" ||
      expression.resultType.affinity === "numeric") &&
    expression.resultType.nullable === false
  );
}

function rootControlSum(expression: SqlExpression): boolean {
  if (expression.kind !== "aggregate" || expression.name !== "SUM")
    return false;
  const value = expression.expression;
  return (
    value?.kind === "case" &&
    value.branches.length > 0 &&
    value.branches.every(({ then }) => oneOfIntegerLiterals(then)) &&
    (value.else === undefined || oneOfIntegerLiterals(value.else))
  );
}

function groupedSummary(node: LogicalQueryNode): node is AggregateNode {
  return (
    node.kind === "aggregate" &&
    node.groups.length > 0 &&
    node.aggregates.length > 0 &&
    node.fields.length === node.groups.length + node.aggregates.length &&
    node.aggregates.every(
      ({ expression }) =>
        expression.kind === "aggregate" &&
        (["COUNT", "MIN", "MAX"].includes(expression.name) ||
          rootControlSum(expression)),
    )
  );
}

function candidateKind(
  node: LogicalQueryNode,
  input: BoundedFactLocalReuseInput,
): BoundedFactLocalReuseEvidence["candidateKind"] | undefined {
  if (
    node.fields.length === 0 ||
    node.fields.length > input.maximumFields ||
    (input.incoming.get(node)?.length ?? 0) < 2 ||
    input.incoming.get(node)?.length !==
      (input.incomingCounts.get(node) ?? 0) ||
    input.incoming.get(node)?.some(({ kind }) => kind !== "relation")
  )
    return undefined;
  if (node.kind === "project") return "carrier";
  if (isGlobalTrueAdmissionJoin(node, input.boundedAdmissions))
    return "global-admission-join";
  if (groupedSummary(node)) return "grouped-summary";
  return undefined;
}

function isIdentityProjectOver(
  node: LogicalQueryNode,
  selected: LogicalQueryNode,
): boolean {
  return (
    node.kind === "project" &&
    node.input.node === selected &&
    node.projections.length === selected.fields.length &&
    node.projections.every(
      ({ expression }, index) =>
        expression.kind === "column" && expression.index === index,
    )
  );
}

function ownerContainsBoundedAdmission(
  owner: LogicalQueryNode,
  boundedAdmissions: ReadonlyMap<LogicalQueryNode, BoundedAdmissionEvidence>,
): boolean {
  const descendants = relationSubtree(owner);
  return [...boundedAdmissions.values()].some(
    ({ bounded, counter }) =>
      descendants.has(bounded) && descendants.has(counter),
  );
}

function safeAncestorNode(
  node: LogicalQueryNode,
  isClosedMembershipAncestor: (node: LogicalQueryNode) => boolean,
): boolean {
  switch (node.kind) {
    case "project":
    case "filter":
    case "aggregate":
      return true;
    case "join":
      return node.joinType === "inner" || node.joinType === "left";
    case "union":
      return unionAllOutputFieldsMatch(node);
    case "semi-join":
    case "anti-join":
      return (
        sameFieldsExactly(node.fields, node.left.fields) &&
        isClosedMembershipAncestor(node)
      );
    case "scan":
    case "values-relation":
    case "json-scalar-array":
    case "distinct":
    case "window":
    case "sort":
    case "limit":
    case "recursive-closure":
      return false;
  }
}

function everyAncestorPathFirstHitsOwner(
  candidate: LogicalQueryNode,
  owner: LogicalQueryNode,
  root: LogicalQueryNode,
  incoming: ReadonlyMap<
    LogicalQueryNode,
    readonly BoundedAdmissionIncomingEdge[]
  >,
  completeFacts: ReadonlySet<LogicalQueryNode>,
  sharedBoundaries: ReadonlySet<LogicalQueryNode>,
  isClosedMembershipAncestor: (node: LogicalQueryNode) => boolean,
): boolean {
  const active = new Set<LogicalQueryNode>();
  const memo = new Map<LogicalQueryNode, boolean>();
  const reachesOwner = (node: LogicalQueryNode): boolean => {
    if (node === owner) return true;
    if (
      node === root ||
      completeFacts.has(node) ||
      sharedBoundaries.has(node) ||
      !safeAncestorNode(node, isClosedMembershipAncestor)
    )
      return false;
    const known = memo.get(node);
    if (known !== undefined) return known;
    if (active.has(node)) return false;
    active.add(node);
    const parents = incoming.get(node) ?? [];
    const valid =
      parents.length > 0 &&
      parents.every(
        ({ parent, kind }) => kind === "relation" && reachesOwner(parent),
      );
    active.delete(node);
    memo.set(node, valid);
    return valid;
  };
  const consumers = incoming.get(candidate) ?? [];
  return (
    consumers.length >= 2 &&
    consumers.every(
      ({ parent, kind }) => kind === "relation" && reachesOwner(parent),
    )
  );
}

/**
 * Recompute the narrow, fact-local bag reuse license from the Generic graph.
 * It cannot create a global owner: every consumer path must meet one already
 * selected complete-keyed fact that contains an exact bounded admission pair.
 */
export function boundedFactLocalReuseCandidates(
  input: BoundedFactLocalReuseInput,
): ReadonlyMap<LogicalQueryNode, BoundedFactLocalReuseEvidence> {
  const admissionLeaves = new Map<
    LogicalQueryNode,
    ClosedStableSubtreeEvidence
  >(
    [...input.boundedAdmissions].map(([bounded, evidence]) => [
      bounded,
      { containsRecursiveClosure: evidence.containsRecursiveClosure },
    ]),
  );
  const admissionCounters = new Map<LogicalQueryNode, LogicalQueryNode>(
    [...input.boundedAdmissions.values()].map(({ counter, bounded }) => [
      counter,
      bounded,
    ]),
  );
  const candidates = new Map<LogicalQueryNode, BoundedFactLocalReuseEvidence>();
  for (const candidate of input.nodes) {
    const kind = candidateKind(candidate, input);
    if (!kind) continue;
    const closure = inspectClosedStableSubtree(candidate, admissionLeaves, {
      admissionCounters,
      allowRootControlledSum: kind === "grouped-summary",
    });
    const unsafeEvaluation = subtreeHasUnsafeEagerEvaluation(
      candidate,
      input.boundedAdmissions,
      admissionCounters,
    );
    if (!closure || unsafeEvaluation) continue;
    const membershipAncestorProofs = new Map<LogicalQueryNode, boolean>();
    const isClosedMembershipAncestor = (node: LogicalQueryNode): boolean => {
      if (node.kind !== "semi-join" && node.kind !== "anti-join") return false;
      const cached = membershipAncestorProofs.get(node);
      if (cached !== undefined) return cached;
      const membershipClosure =
        sameFieldsExactly(node.fields, node.left.fields) &&
        inspectClosedStableSubtree(node, admissionLeaves, {
          admissionCounters,
          allowRootControlledSum: kind === "grouped-summary",
        }) !== undefined;
      membershipAncestorProofs.set(node, membershipClosure);
      return membershipClosure;
    };
    const descendants = relationSubtree(candidate);
    const owners = [...input.completeFacts].filter(
      (owner) =>
        owner.kind === "aggregate" &&
        descendants.has(owner) === false &&
        relationSubtree(owner).has(candidate) &&
        ownerContainsBoundedAdmission(owner, input.boundedAdmissions) &&
        everyAncestorPathFirstHitsOwner(
          candidate,
          owner,
          input.root,
          input.incoming,
          input.completeFacts,
          input.sharedBoundaries,
          isClosedMembershipAncestor,
        ),
    );
    if (owners.length === 1)
      candidates.set(candidate, {
        owner: owners[0] as AggregateNode,
        candidateKind: kind,
      });
  }

  // Prefer grouped summaries, then admission joins, then narrow projections.
  // Nested candidates can coexist only when their independently recomputed
  // closed-bag proofs select the exact same original complete-fact owner.
  const priority: Record<
    BoundedFactLocalReuseEvidence["candidateKind"],
    number
  > = {
    "grouped-summary": 0,
    "global-admission-join": 1,
    carrier: 2,
  };
  const relationSubtrees = new Map<LogicalQueryNode, Set<LogicalQueryNode>>();
  const descendantsOf = (node: LogicalQueryNode): Set<LogicalQueryNode> => {
    const cached = relationSubtrees.get(node);
    if (cached) return cached;
    const descendants = relationSubtree(node);
    relationSubtrees.set(node, descendants);
    return descendants;
  };
  const selected = new Map<LogicalQueryNode, BoundedFactLocalReuseEvidence>();
  const orderedCandidates = [...candidates].sort(
    ([left, leftEvidence], [right, rightEvidence]) =>
      priority[leftEvidence.candidateKind] -
        priority[rightEvidence.candidateKind] ||
      input.nodes.indexOf(left) - input.nodes.indexOf(right),
  );
  for (const [candidate, evidence] of orderedCandidates) {
    const candidateDescendants = descendantsOf(candidate);
    const overlapping = [...selected].filter(
      ([selectedNode]) =>
        candidateDescendants.has(selectedNode) ||
        descendantsOf(selectedNode).has(candidate),
    );
    if (
      overlapping.some(
        ([, selectedEvidence]) => selectedEvidence.owner !== evidence.owner,
      )
    )
      continue;
    if (
      overlapping.some(([selectedNode]) =>
        isIdentityProjectOver(candidate, selectedNode),
      )
    )
      continue;
    selected.set(candidate, evidence);
  }
  return selected;
}
