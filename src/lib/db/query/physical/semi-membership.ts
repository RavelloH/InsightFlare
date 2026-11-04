import type { RelationScope, SqlExpression } from "@/lib/db/query/expression";
import {
  isMaterializationSafeExpression,
  isMaterializationSafeNode,
} from "@/lib/db/query/materialization-safety";
import {
  isTextComparisonStorageClass,
  semiMembershipBinaryCollation,
  type SemiMembershipComparisonDomain,
  semiMembershipComparisonDomain,
} from "@/lib/db/query/physical/comparison-domains";
import type { PhysicalSharedRelationBoundaryEvidence } from "@/lib/db/query/physical/shared-relation-interfaces";
import type {
  LogicalQueryNode,
  QuerySource,
  SemiJoinNode,
} from "@/lib/db/query/plan";

/** Exact, freshly-derived positive SemiJoin membership shape. */
export interface PhysicalSemiMembershipChoice {
  readonly node: SemiJoinNode;
  readonly condition: SqlExpression;
  readonly left: QuerySource;
  readonly right: QuerySource;
  readonly leftKeyIndexes: readonly number[];
  readonly rightKeyIndexes: readonly number[];
  /** Materialized boundaries whose current, licensed interface is required. */
  readonly materializedStops: readonly LogicalQueryNode[];
}

type BoundaryEvidenceMap = ReadonlyMap<
  LogicalQueryNode,
  PhysicalSharedRelationBoundaryEvidence
>;

function expressionSources(expression: SqlExpression): QuerySource[] {
  const sources: QuerySource[] = [];
  const visit = (current: SqlExpression): void => {
    switch (current.kind) {
      case "binary":
      case "distinct-from":
        visit(current.left);
        visit(current.right);
        break;
      case "boolean":
        current.expressions.forEach(visit);
        break;
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-real":
      case "cast-text":
        visit(current.expression);
        break;
      case "text-position":
        visit(current.text);
        visit(current.needle);
        break;
      case "text-substring":
        visit(current.text);
        visit(current.start);
        if (current.length) visit(current.length);
        break;
      case "text-like":
        visit(current.text);
        visit(current.pattern);
        break;
      case "in-list":
        visit(current.expression);
        break;
      case "in-subquery":
        visit(current.expression);
        sources.push(current.query);
        break;
      case "function":
        current.arguments.forEach(visit);
        break;
      case "aggregate":
        if (current.expression) visit(current.expression);
        break;
      case "coalesce":
        current.expressions.forEach(visit);
        break;
      case "case":
        current.branches.forEach(({ when, then }) => {
          visit(when);
          visit(then);
        });
        if (current.else) visit(current.else);
        break;
      case "scalar-subquery":
        sources.push(current.query);
        break;
      case "column":
      case "parameter":
      case "excluded":
      case "unixepoch":
      case "constant":
        break;
    }
  };
  visit(expression);
  return sources;
}

function nodeExpressions(node: LogicalQueryNode): readonly SqlExpression[] {
  switch (node.kind) {
    case "filter":
    case "recursive-closure":
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
    case "sort":
      return node.keys.map(({ expression }) => expression);
    case "window":
      return node.windows.flatMap(({ specification }) => [
        ...specification.partitionBy,
        ...(specification.kind === "row-number"
          ? specification.orderBy.map(({ expression }) => expression)
          : []),
      ]);
    case "limit":
      return [node.count, ...(node.offset ? [node.offset] : [])];
    case "scan":
    case "values-relation":
    case "json-scalar-array":
    case "distinct":
    case "union":
      return [];
  }
}

function children(node: LogicalQueryNode): QuerySource[] {
  if (
    node.kind === "scan" ||
    node.kind === "values-relation" ||
    node.kind === "json-scalar-array"
  )
    return [];
  if (
    node.kind === "filter" ||
    node.kind === "project" ||
    node.kind === "aggregate" ||
    node.kind === "distinct" ||
    node.kind === "window" ||
    node.kind === "sort" ||
    node.kind === "limit"
  )
    return [node.input];
  if (node.kind === "recursive-closure") return [node.seed, node.candidates];
  return [node.left, node.right];
}

function allChildren(node: LogicalQueryNode): QuerySource[] {
  return [
    ...children(node),
    ...nodeExpressions(node).flatMap(expressionSources),
  ];
}

function boundaryIsSufficient(
  node: LogicalQueryNode,
  evidence: PhysicalSharedRelationBoundaryEvidence,
  boundaries: BoundaryEvidenceMap,
): boolean {
  const stoppedAt = evidence.totality?.stoppedAt;
  return (
    evidence.definition.node === node &&
    evidence.definition.materialization === "materialized" &&
    evidence.definition.scope === node.scope &&
    evidence.definition.fields.length === node.fields.length &&
    evidence.definition.fields.every(
      (field, index) =>
        field.name === node.fields[index]?.name &&
        field.affinity === node.fields[index]?.affinity &&
        field.nullable === node.fields[index]?.nullable,
    ) &&
    evidence.boundary?.kind === "materialized-relation" &&
    evidence.license !== undefined &&
    evidence.closure?.kind === "scope-and-exported-columns-closed" &&
    evidence.totality?.kind === "checked-through-current-boundaries" &&
    Array.isArray(stoppedAt) &&
    stoppedAt.every(
      (dependency) => dependency !== node && boundaries.has(dependency),
    )
  );
}

interface TotalityVeto {
  readonly reason: string;
  readonly nodeKind: LogicalQueryNode["kind"];
  readonly producer: string;
  readonly path: readonly string[];
  readonly materializedBoundary: "none" | "current-but-not-sufficient";
}

interface TotalityAnalysis {
  readonly kind: "proven" | "rejected";
  readonly stops: ReadonlySet<LogicalQueryNode>;
  readonly veto?: TotalityVeto;
}

function nodeProducer(node: LogicalQueryNode): string {
  if (node.kind === "scan") return `scan(${node.table.name})`;
  const firstField = node.fields[0]?.name ?? "<no-output>";
  return `${node.kind}(${firstField})`;
}

function childEdgeLabels(node: LogicalQueryNode): string[] {
  let structural: string[];
  if (
    node.kind === "scan" ||
    node.kind === "values-relation" ||
    node.kind === "json-scalar-array"
  ) {
    structural = [];
  } else if (
    node.kind === "filter" ||
    node.kind === "project" ||
    node.kind === "aggregate" ||
    node.kind === "distinct" ||
    node.kind === "window" ||
    node.kind === "sort" ||
    node.kind === "limit"
  ) {
    structural = [`${node.kind}.input`];
  } else if (node.kind === "recursive-closure") {
    structural = ["recursive-closure.seed", "recursive-closure.candidates"];
  } else {
    structural = [`${node.kind}.left`, `${node.kind}.right`];
  }
  const expressionChildCount = allChildren(node).length - children(node).length;
  return [
    ...structural,
    ...Array.from(
      { length: expressionChildCount },
      (_unused, index) => `${node.kind}.expression-subquery[${index}]`,
    ),
  ];
}

function totalAndClosedInput(
  root: LogicalQueryNode,
  boundaries: BoundaryEvidenceMap,
  active: Set<LogicalQueryNode>,
  visited: Set<LogicalQueryNode>,
  stops: Set<LogicalQueryNode>,
  path: readonly string[] = [],
): TotalityAnalysis {
  const veto = (
    reason: string,
    materializedBoundary: TotalityVeto["materializedBoundary"] = "none",
  ): TotalityAnalysis => ({
    kind: "rejected",
    stops,
    veto: {
      reason,
      nodeKind: root.kind,
      producer: nodeProducer(root),
      path,
      materializedBoundary,
    },
  });
  if (active.has(root)) return veto("cycle encountered while proving totality");
  if (visited.has(root)) return { kind: "proven", stops };
  const boundary = boundaries.get(root);
  if (boundary && boundaryIsSufficient(root, boundary, boundaries)) {
    stops.add(root);
    visited.add(root);
    return { kind: "proven", stops };
  }

  // These node families can hide errors, correlation, ordering, or a
  // difference between materialized and streamed evaluation. Keep EXISTS.
  const currentBoundary = boundary ? "current-but-not-sufficient" : "none";
  if (root.kind === "window")
    return veto(
      "Window is forbidden in an unbounded membership input",
      currentBoundary,
    );
  if (root.kind === "sort")
    return veto(
      "Sort is forbidden in an unbounded membership input",
      currentBoundary,
    );
  if (root.kind === "limit")
    return veto(
      "Limit is forbidden in an unbounded membership input",
      currentBoundary,
    );
  if (root.kind === "recursive-closure")
    return veto(
      "recursive closure is forbidden in a membership input",
      currentBoundary,
    );
  if (root.kind === "semi-join" || root.kind === "anti-join")
    return veto(
      "nested membership input is not totality-closed",
      currentBoundary,
    );
  if (root.kind === "union" && !root.all)
    return veto(
      "UNION DISTINCT is forbidden in a membership input",
      currentBoundary,
    );
  if (!isMaterializationSafeNode(root))
    return veto(
      "node is not certified as materialization-safe",
      currentBoundary,
    );

  const inputScopes = new Map<RelationScope, number>(
    children(root).map((source) => [source.scope, source.fields.length]),
  );
  const expressions = nodeExpressions(root);
  for (let index = 0; index < expressions.length; index++)
    if (!isMaterializationSafeExpression(expressions[index]!, inputScopes))
      return veto(
        `expression[${index}] is not certified as materialization-safe`,
        currentBoundary,
      );

  active.add(root);
  const sources = allChildren(root);
  const edges = childEdgeLabels(root);
  for (let index = 0; index < sources.length; index++) {
    const childResult = totalAndClosedInput(
      sources[index]!.node,
      boundaries,
      active,
      visited,
      stops,
      [...path, edges[index] ?? `${root.kind}.child[${index}]`],
    );
    if (childResult.kind === "rejected") {
      active.delete(root);
      return childResult;
    }
  }
  active.delete(root);
  visited.add(root);
  return { kind: "proven", stops };
}

export interface SemiMembershipComparisonPairProof {
  readonly leftIndex: number;
  readonly rightIndex: number;
  readonly compatibility: "integer-rowid" | "binary-text-family";
  readonly leftDomain: SemiMembershipComparisonDomain;
  readonly rightDomain: SemiMembershipComparisonDomain;
}

export type SemiMembershipKeyConditionAnalysis =
  | {
      readonly kind: "proven";
      readonly left: readonly number[];
      readonly right: readonly number[];
      readonly comparisons: readonly SemiMembershipComparisonPairProof[];
    }
  | {
      readonly kind: "rejected";
      readonly phase: "key-condition" | "comparison-domain";
      readonly reason: string;
      readonly pair?: {
        readonly leftIndex: number;
        readonly rightIndex: number;
        readonly leftDomain: ReturnType<typeof semiMembershipComparisonDomain>;
        readonly rightDomain: ReturnType<typeof semiMembershipComparisonDomain>;
        readonly leftCollation: ReturnType<
          typeof semiMembershipBinaryCollation
        >;
        readonly rightCollation: ReturnType<
          typeof semiMembershipBinaryCollation
        >;
      };
    };

function analyzeComparisonPair(
  node: SemiJoinNode,
  leftIndex: number,
  rightIndex: number,
):
  | {
      readonly kind: "proven";
      readonly proof: SemiMembershipComparisonPairProof;
    }
  | Extract<SemiMembershipKeyConditionAnalysis, { kind: "rejected" }> {
  const leftField = node.left.fields[leftIndex];
  const rightField = node.right.fields[rightIndex];
  const leftDomain = semiMembershipComparisonDomain(node.left, leftIndex);
  const rightDomain = semiMembershipComparisonDomain(node.right, rightIndex);
  const leftCollation = semiMembershipBinaryCollation(node.left, leftIndex);
  const rightCollation = semiMembershipBinaryCollation(node.right, rightIndex);
  const diagnostic = {
    leftIndex,
    rightIndex,
    leftDomain,
    rightDomain,
    leftCollation,
    rightCollation,
  };

  if (leftDomain.kind === "rejected")
    return {
      kind: "rejected",
      phase: "comparison-domain",
      reason: `left key domain rejected at ${leftDomain.at.nodeKind}[${leftDomain.at.outputIndex}]: ${leftDomain.reason}`,
      pair: diagnostic,
    };
  if (rightDomain.kind === "rejected")
    return {
      kind: "rejected",
      phase: "comparison-domain",
      reason: `right key domain rejected at ${rightDomain.at.nodeKind}[${rightDomain.at.outputIndex}]: ${rightDomain.reason}`,
      pair: diagnostic,
    };
  if (leftCollation.kind === "rejected")
    return {
      kind: "rejected",
      phase: "comparison-domain",
      reason: `left key collation rejected at ${leftCollation.at.nodeKind}[${leftCollation.at.outputIndex}]: ${leftCollation.reason}`,
      pair: diagnostic,
    };
  if (rightCollation.kind === "rejected")
    return {
      kind: "rejected",
      phase: "comparison-domain",
      reason: `right key collation rejected at ${rightCollation.at.nodeKind}[${rightCollation.at.outputIndex}]: ${rightCollation.reason}`,
      pair: diagnostic,
    };

  const leftClasses = leftDomain.domain.storageClasses;
  const rightClasses = rightDomain.domain.storageClasses;
  const integerRowids =
    leftField?.affinity === "integer" &&
    rightField?.affinity === "integer" &&
    leftClasses.length === 1 &&
    rightClasses.length === 1 &&
    leftClasses[0] === "integer" &&
    rightClasses[0] === "integer";
  if (integerRowids)
    return {
      kind: "proven",
      proof: {
        leftIndex,
        rightIndex,
        compatibility: "integer-rowid",
        leftDomain: leftDomain.domain,
        rightDomain: rightDomain.domain,
      },
    };

  const textComparison =
    (leftField?.affinity === "text" || leftField?.affinity === "unknown") &&
    (rightField?.affinity === "text" || rightField?.affinity === "unknown") &&
    leftClasses.every(isTextComparisonStorageClass) &&
    rightClasses.every(isTextComparisonStorageClass);
  if (textComparison)
    return {
      kind: "proven",
      proof: {
        leftIndex,
        rightIndex,
        compatibility: "binary-text-family",
        leftDomain: leftDomain.domain,
        rightDomain: rightDomain.domain,
      },
    };

  return {
    kind: "rejected",
    phase: "comparison-domain",
    reason:
      "proven storage classes and modeled affinities are outside the exact INTEGER-rowid or BINARY TEXT/BLOB/NULL comparison families",
    pair: diagnostic,
  };
}

/**
 * Freshly prove the exact direct-column equality tuple and comparison domains
 * used by a SemiJoin. This deliberately excludes membership-input totality;
 * callers that need that contract must prove it separately.
 */
export function analyzeSemiMembershipKeyCondition(
  node: SemiJoinNode,
): SemiMembershipKeyConditionAnalysis {
  const pairs: { left: number; right: number }[] = [];
  let conditionFailure: string | undefined;
  const visit = (expression: SqlExpression, path: string): boolean => {
    if (expression.kind === "boolean") {
      if (
        expression.operator !== "AND" ||
        expression.expressions.length === 0
      ) {
        conditionFailure = `${path}: only a non-empty conjunction can be represented as tuple membership`;
        return false;
      }
      for (let index = 0; index < expression.expressions.length; index++)
        if (!visit(expression.expressions[index]!, `${path}.and[${index}]`))
          return false;
      return true;
    }
    if (
      expression.kind !== "binary" ||
      expression.operator !== "=" ||
      expression.left.kind !== "column" ||
      expression.right.kind !== "column"
    ) {
      conditionFailure = `${path}: equality leaf is not binary '=' between two direct columns`;
      return false;
    }
    const left = expression.left;
    const right = expression.right;
    if (
      left.scope !== node.left.scope ||
      right.scope !== node.right.scope ||
      !Number.isSafeInteger(left.index) ||
      !Number.isSafeInteger(right.index) ||
      left.index < 0 ||
      right.index < 0
    ) {
      conditionFailure = `${path}: equality columns do not reference valid output indexes in their respective SemiJoin scopes`;
      return false;
    }
    const leftField = node.left.fields[left.index];
    const rightField = node.right.fields[right.index];
    if (
      !leftField ||
      !rightField ||
      left.name !== leftField.name ||
      right.name !== rightField.name ||
      left.resultType.affinity !== leftField.affinity ||
      right.resultType.affinity !== rightField.affinity ||
      left.resultType.nullable !== leftField.nullable ||
      right.resultType.nullable !== rightField.nullable
    ) {
      conditionFailure = `${path}: equality column names/result metadata do not match the current SemiJoin output fields`;
      return false;
    }
    pairs.push({ left: left.index, right: right.index });
    return true;
  };
  if (!visit(node.condition, "condition") || pairs.length === 0)
    return {
      kind: "rejected",
      phase: "key-condition",
      reason: conditionFailure ?? "condition has no direct equality keys",
    };

  const comparisons: SemiMembershipComparisonPairProof[] = [];
  for (const { left, right } of pairs) {
    const analyzed = analyzeComparisonPair(node, left, right);
    if (analyzed.kind === "rejected") return analyzed;
    comparisons.push(analyzed.proof);
  }
  return {
    kind: "proven",
    left: pairs.map(({ left }) => left),
    right: pairs.map(({ right }) => right),
    comparisons,
  };
}

export interface SemiMembershipCandidateAnalysis {
  readonly candidateIndex: number;
  readonly node: SemiJoinNode;
  readonly kind: "eligible" | "rejected";
  readonly phase?: "key-condition" | "comparison-domain" | "totality";
  readonly reason?: string;
  readonly inputSide?: "left" | "right";
  readonly totalityVeto?: TotalityVeto;
  readonly comparisons?: readonly SemiMembershipComparisonPairProof[];
  readonly choice?: PhysicalSemiMembershipChoice;
}

/**
 * Recompute each positive SemiJoin decision with the exact production proof
 * used by lowering. The structured rejection is internal diagnostic evidence;
 * it is not a cached certificate and does not alter eligibility.
 */
export function analyzeSemiMembershipCandidates(
  root: LogicalQueryNode,
  boundaries: BoundaryEvidenceMap,
): readonly SemiMembershipCandidateAnalysis[] {
  const nodes: LogicalQueryNode[] = [];
  const visitedNodes = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visitedNodes.has(node)) return;
    visitedNodes.add(node);
    for (const source of allChildren(node)) visit(source.node);
    nodes.push(node);
  };
  visit(root);

  const analyses: SemiMembershipCandidateAnalysis[] = [];
  let candidateIndex = 0;
  for (const node of nodes) {
    if (node.kind !== "semi-join") continue;
    const index = candidateIndex++;
    const keys = analyzeSemiMembershipKeyCondition(node);
    if (keys.kind === "rejected") {
      analyses.push({
        candidateIndex: index,
        node,
        kind: "rejected",
        phase: keys.phase,
        reason: keys.reason,
      });
      continue;
    }
    const stops = new Set<LogicalQueryNode>();
    const leftTotality = totalAndClosedInput(
      node.left.node,
      boundaries,
      new Set(),
      new Set(),
      stops,
    );
    if (leftTotality.kind === "rejected") {
      analyses.push({
        candidateIndex: index,
        node,
        kind: "rejected",
        phase: "totality",
        reason: leftTotality.veto?.reason,
        inputSide: "left",
        totalityVeto: leftTotality.veto,
        comparisons: keys.comparisons,
      });
      continue;
    }
    const rightTotality = totalAndClosedInput(
      node.right.node,
      boundaries,
      new Set(),
      new Set(),
      stops,
    );
    if (rightTotality.kind === "rejected") {
      analyses.push({
        candidateIndex: index,
        node,
        kind: "rejected",
        phase: "totality",
        reason: rightTotality.veto?.reason,
        inputSide: "right",
        totalityVeto: rightTotality.veto,
        comparisons: keys.comparisons,
      });
      continue;
    }
    const choice: PhysicalSemiMembershipChoice = {
      node,
      condition: node.condition,
      left: node.left,
      right: node.right,
      leftKeyIndexes: keys.left,
      rightKeyIndexes: keys.right,
      materializedStops: [...stops],
    };
    analyses.push({
      candidateIndex: index,
      node,
      kind: "eligible",
      comparisons: keys.comparisons,
      choice,
    });
  }
  return analyses;
}

export function semiMembershipChoices(
  root: LogicalQueryNode,
  boundaries: BoundaryEvidenceMap,
): readonly PhysicalSemiMembershipChoice[] {
  return analyzeSemiMembershipCandidates(root, boundaries).flatMap(
    (analysis) => (analysis.choice ? [analysis.choice] : []),
  );
}

function denseValues(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value))
    return undefined;
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const item = Object.getOwnPropertyDescriptor(value, index);
    if (!item || !("value" in item)) return undefined;
    result.push(item.value);
  }
  return result;
}

function ownData(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

export function sameSemiMembershipChoices(
  actual: unknown,
  expected: readonly PhysicalSemiMembershipChoice[],
): boolean {
  const actualValues = denseValues(actual);
  if (!actualValues || actualValues.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    const left = actualValues[index];
    const right = expected[index];
    if (!left || typeof left !== "object" || !right) return false;
    const leftKeys = denseValues(ownData(left, "leftKeyIndexes"));
    const rightKeys = denseValues(ownData(left, "rightKeyIndexes"));
    const stops = denseValues(ownData(left, "materializedStops"));
    if (
      ownData(left, "node") !== right.node ||
      ownData(left, "condition") !== right.condition ||
      ownData(left, "left") !== right.left ||
      ownData(left, "right") !== right.right ||
      !leftKeys ||
      !rightKeys ||
      !stops ||
      leftKeys.length !== right.leftKeyIndexes.length ||
      rightKeys.length !== right.rightKeyIndexes.length ||
      stops.length !== right.materializedStops.length
    )
      return false;
    for (let key = 0; key < leftKeys.length; key++)
      if (
        leftKeys[key] !== right.leftKeyIndexes[key] ||
        rightKeys[key] !== right.rightKeyIndexes[key]
      )
        return false;
    for (let stop = 0; stop < stops.length; stop++)
      if (stops[stop] !== right.materializedStops[stop]) return false;
  }
  return true;
}
