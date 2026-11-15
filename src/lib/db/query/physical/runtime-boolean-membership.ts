import type { SqlExpression } from "@/lib/db/query/expression";
import type { PhysicalQueryPlan } from "@/lib/db/query/physical/contracts";
import {
  analyzeSemiMembershipKeyCondition,
  type PhysicalSemiMembershipChoice,
} from "@/lib/db/query/physical/semi-membership";
import type {
  LogicalQueryNode,
  QuerySource,
  WindowNode,
} from "@/lib/db/query/plan";

import {
  deriveRuntimeWindowCertificate,
  relationInputs,
  totalRuntimeGuardProducer,
} from "./runtime-window-certificate";

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

/** Private-fast-only choices; these are never returned as unconditional static
 * semiMembershipChoices or passed to the ordinary compiler/physical validator. */
export interface RuntimeBooleanMembershipChoice {
  readonly choice: PhysicalSemiMembershipChoice;
  readonly windowDependencies: readonly WindowNode[];
  readonly comparisonLaw: "existing-complete-key-condition-proof";
  readonly observation:
    "positive-boolean-membership" | "negative-boolean-membership";
}
export function deriveRuntimeBooleanMembership(
  plan: PhysicalQueryPlan<object>,
): readonly RuntimeBooleanMembershipChoice[] {
  // Re-derive complete current-root obligations instead of accepting a caller
  // supplied window set or trusting an old runtime guard on another graph.
  const proof = deriveRuntimeWindowCertificate(plan);
  if (!proof.eligible) return [];
  const certified = new Set(proof.certificate.windows.map((w) => w.window));
  const seen = new Set<LogicalQueryNode>(),
    nodes: LogicalQueryNode[] = [];
  const visit = (n: LogicalQueryNode) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const s of relationInputs(n)) visit(s.node);
    nodes.push(n);
  };
  visit(plan.root);
  const subtreeWindows = (root: LogicalQueryNode): WindowNode[] => {
    const walked = new Set<LogicalQueryNode>(),
      windows: WindowNode[] = [];
    const walk = (n: LogicalQueryNode) => {
      if (walked.has(n)) return;
      walked.add(n);
      if (n.kind === "window") windows.push(n);
      for (const s of relationInputs(n)) walk(s.node);
    };
    walk(root);
    return windows;
  };
  const choices: RuntimeBooleanMembershipChoice[] = [];
  for (const node of nodes) {
    if (node.kind !== "semi-join" && node.kind !== "anti-join") continue;
    const rightWindows = subtreeWindows(node.right.node);
    if (!rightWindows.length) continue;
    const dependencies = [
      ...new Set([...subtreeWindows(node.left.node), ...rightWindows]),
    ];
    if (dependencies.some((w) => !certified.has(w))) continue;
    // IN can eagerly read rows that correlated EXISTS would not consume.
    // Both exact closed inputs must be total, independently of determination.
    if (
      totalRuntimeGuardProducer(node.left.node) ||
      totalRuntimeGuardProducer(node.right.node)
    )
      continue;
    const keys = analyzeSemiMembershipKeyCondition(node);
    if (keys.kind !== "proven") continue;
    choices.push({
      choice: {
        node,
        condition: node.condition,
        left: node.left,
        right: node.right,
        leftKeyIndexes: keys.left,
        rightKeyIndexes: keys.right,
        materializedStops: [],
      },
      windowDependencies: dependencies,
      comparisonLaw: "existing-complete-key-condition-proof",
      observation:
        node.kind === "anti-join"
          ? "negative-boolean-membership"
          : "positive-boolean-membership",
    });
  }
  // Expression-owned query edges are outside the relation-only consumer proof.
  // Decline the additional anti rewrite for any such observer, including a
  // sibling scalar query, rather than claiming a complete changed-input closure.
  const anti = choices.filter(
    (c) => c.observation === "negative-boolean-membership",
  );
  if (
    anti.length &&
    (nodes.some((node) =>
      nodeExpressions(node).some((e) => expressionSources(e).length > 0),
    ) ||
      !deriveRuntimeWindowCertificate(
        plan,
        anti.map((c) => c.choice.node),
      ).eligible)
  )
    return choices.filter(
      (c) => c.observation === "positive-boolean-membership",
    );
  return choices;
}
