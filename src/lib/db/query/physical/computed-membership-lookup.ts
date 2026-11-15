import type { SqlExpression } from "@/lib/db/query/expression";
import type {
  LogicalQueryNode,
  ProjectNode,
  QuerySource,
} from "@/lib/db/query/plan";

import { hasExposedCatalogIndexedLookup } from "./catalog-indexed-lookup";
import type { PhysicalJoinOrderStrategy } from "./contracts";
import { isTotalAndClosedMembershipInput } from "./semi-membership";
import type { PhysicalSharedRelationBoundaryEvidence } from "./shared-relation-interfaces";

/**
 * Fence an already DISTINCT, complete computed keyset with an idempotent GROUP
 * BY. The same direct output columns retain affinity and collation, and each
 * group already has exactly one row, so its representative cannot change.
 * Keep the original INNER JOIN condition and bag: no IN/domain/unique rewrite.
 */
export function computedMembershipLookupStrategy(
  project: ProjectNode,
  boundaries: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >,
  tupleMembershipProjects: ReadonlySet<LogicalQueryNode> = new Set(),
  allowPreservedSideLookup = false,
): PhysicalJoinOrderStrategy | undefined {
  const join = project.input.node;
  if (join.kind !== "join" || join.joinType !== "inner") return undefined;
  if (
    project.input.scope !== join.scope ||
    project.projections.length !== join.left.fields.length ||
    project.fields.length !== join.left.fields.length ||
    !project.projections.every(({ name, expression }, index) => {
      const field = join.fields[index];
      const output = project.fields[index];
      const left = join.left.fields[index];
      return (
        expression.kind === "column" &&
        expression.scope === join.scope &&
        expression.index === index &&
        expression.name === field?.name &&
        output?.name === name &&
        expression.resultType.affinity === left?.affinity &&
        expression.resultType.nullable === left?.nullable &&
        output?.affinity === left?.affinity &&
        output?.nullable === left?.nullable
      );
    })
  )
    return undefined;

  const right = join.right.node;
  if (right.kind !== "distinct" || right.fields.length === 0) return undefined;

  const containsComputedMembershipBarrier = (
    node: LogicalQueryNode,
    visited = new Set<LogicalQueryNode>(),
  ): boolean => {
    if (visited.has(node)) return false;
    visited.add(node);
    if (
      (node.kind === "union" && !node.all) ||
      node.kind === "semi-join" ||
      node.kind === "anti-join" ||
      tupleMembershipProjects.has(node)
    )
      return true;
    if ("input" in node)
      return containsComputedMembershipBarrier(node.input.node, visited);
    if ("left" in node && "right" in node)
      return (
        containsComputedMembershipBarrier(node.left.node, visited) ||
        containsComputedMembershipBarrier(node.right.node, visited)
      );
    return false;
  };
  if (!containsComputedMembershipBarrier(right)) return undefined;
  // Compound SELECT affinity is only stable when every arm agrees. The
  // additional wrapper must not let SQLite choose a different arm's affinity.
  const alignedAffinities = (
    node: LogicalQueryNode,
    visited = new Set<LogicalQueryNode>(),
  ): boolean => {
    if (visited.has(node)) return true;
    visited.add(node);
    if (
      node.kind === "union" &&
      (node.fields.length !== node.left.fields.length ||
        node.fields.length !== node.right.fields.length ||
        !node.fields.every(
          (field, index) =>
            field.affinity === node.left.fields[index]?.affinity &&
            field.affinity === node.right.fields[index]?.affinity,
        ))
    )
      return false;
    if ("input" in node) return alignedAffinities(node.input.node, visited);
    if ("left" in node && "right" in node)
      return (
        alignedAffinities(node.left.node, visited) &&
        alignedAffinities(node.right.node, visited)
      );
    return true;
  };
  if (!alignedAffinities(right)) return undefined;
  const rightIndexes: number[] = [];
  const leftIndexes: number[] = [];
  const columnIndex = (
    expression: SqlExpression,
    source: QuerySource,
  ): number | undefined => {
    if (expression.kind !== "column" || expression.scope !== source.scope)
      return undefined;
    const field = source.fields[expression.index];
    return Number.isSafeInteger(expression.index) &&
      expression.index >= 0 &&
      field &&
      expression.name === field.name &&
      expression.resultType.affinity === field.affinity &&
      expression.resultType.nullable === field.nullable
      ? expression.index
      : undefined;
  };
  const equalityTuple = (expression: SqlExpression): boolean => {
    if (expression.kind === "boolean")
      return (
        expression.operator === "AND" &&
        expression.expressions.length > 0 &&
        expression.expressions.every(equalityTuple)
      );
    if (expression.kind !== "binary" || expression.operator !== "=")
      return false;
    const leftIndex = columnIndex(expression.left, join.left);
    if (leftIndex === undefined) return false;
    leftIndexes.push(leftIndex);
    const index = columnIndex(expression.right, join.right);
    if (index === undefined) return false;
    rightIndexes.push(index);
    return true;
  };
  if (
    !equalityTuple(join.condition) ||
    rightIndexes.length !== right.fields.length ||
    new Set(rightIndexes).size !== right.fields.length ||
    !isTotalAndClosedMembershipInput(join.left.node, boundaries) ||
    !isTotalAndClosedMembershipInput(join.right.node, boundaries)
  )
    return undefined;
  // Keep an existing complete catalog seek. A preserved outer-join side may
  // expose such a seek only when no DISTINCT consumer changes the join's
  // cardinality estimates; it never proves uniqueness of the joined output.
  if (
    hasExposedCatalogIndexedLookup(
      join.left,
      leftIndexes,
      boundaries,
      allowPreservedSideLookup,
    )
  )
    return undefined;
  return { kind: "computed-key-lookup", join, driver: "preserve" };
}
