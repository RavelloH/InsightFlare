import type {
  SchemaColumnReference,
  SchemaObjectReference,
} from "@/lib/db/schema/types";

import {
  assertCurrentPhysicalCompileOrderPolicy,
  derivePhysicalCompileOrderPolicy,
} from "./physical/compile-order";
import {
  analyzeConditionalLookupChoices,
  sameConditionalLookupChoices,
} from "./physical/conditional-lookup";
import type {
  ConstantFilterJoinProjection,
  DirectScanProjectionChoice,
  PassthroughProjectFusion,
  PhysicalJoinOrderStrategy,
  PhysicalQueryPlan,
  PositiveTupleMembershipCandidate,
  SharedRelationDefinition,
} from "./physical/contracts";
import {
  lexicographicComparisonChoices,
  sameLexicographicComparisonChoices,
} from "./physical/lexicographic-comparison";
import {
  auditMaterializedBoundaryFixedPoint,
  type CandidateFacts,
  materializationConsumerEdges,
  type MaterializedBoundaryContext,
  materializedBoundaryContext,
  type StrictStageReaderContext,
} from "./physical/materialization-context";
import {
  emitMaterializationDiagnostic,
  type MaterializationDiagnosticSink,
} from "./physical/materialization-diagnostics";
import {
  autoMaterializationPromotionCandidates,
  type MaterializationPromotionCandidate,
} from "./physical/materialization-selection";
import {
  analyzeNativeNullOrdering,
  sameNativeNullOrderingChoices,
} from "./physical/native-null-ordering";
import {
  rowPipelineChoices,
  sameRowPipelineChoices,
} from "./physical/row-pipeline";
import {
  partitionSelfMembershipCandidates,
  type PhysicalSelfMembershipChoice,
} from "./physical/self-membership";
import { createSelfMembershipDerivationContext } from "./physical/self-membership-context";
import {
  analyzeSemiMembershipCandidates,
  sameSemiMembershipChoices,
  semiMembershipChoices,
} from "./physical/semi-membership";
import {
  sameSemiMembershipCostSelections,
  semiMembershipCostSelections,
} from "./physical/semi-membership-cost";
import {
  createPhysicalSharedRelationInterfaceView,
  type PhysicalSharedRelationBoundaryEvidence,
  type PhysicalSharedRelationInterfaceView,
  type PhysicalSharedRelationLicenseKind,
  samePhysicalSharedRelationDefinitionIdentity,
  snapshotPhysicalSharedRelationLayout,
} from "./physical/shared-relation-interfaces";
import {
  analyzeSingletonRankChoices,
  sameSingletonRankChoices,
} from "./physical/singleton-rank";
import { reviewStrictRankStages } from "./physical/strict-rank-stage-review";
import {
  type BoundedAdmissionEvidence,
  boundedAdmissionReuseCandidates,
} from "./bounded-admission-reuse";
import {
  boundedFactLocalReuseCandidates,
  type BoundedFactLocalReuseEvidence,
} from "./bounded-fact-local-reuse";
import { boundedGroupSummaryReuseCandidates } from "./bounded-group-summary-reuse";
import { boundedSummaryDerivedReuseCandidates } from "./bounded-summary-derived-reuse";
import { completeKeyedLookupReuseCandidates } from "./complete-keyed-lookup-reuse";
import { DatabaseCompilerError } from "./errors";
import type { AnyExpression, RelationScope, SqlExpression } from "./expression";
import {
  createProvenPartitionedRowNumberWindowAnalysisContext,
  isMaterializationSafeExpression,
  isMaterializationSafeNode,
  isMaterializationSafePartitionedRowNumberWindow,
  isMaterializationSafeProvenPartitionedRowNumberWindow,
} from "./materialization-safety";
import {
  correlatedConstantExistenceOuterScopes,
  isConstantExistenceQuery,
  sharedOrdinaryFilterFanoutCandidates,
} from "./ordinary-filter-fanout";
import type {
  JoinNode,
  LogicalQueryNode,
  OutputField,
  ProjectNode,
  QuerySource,
  Relation,
  ScanNode,
  ValuesRelationNode,
} from "./plan";
import { sharedMembershipInputReuseCandidates } from "./shared-membership-input-reuse";
import {
  isScalarCountRows,
  sharedScalarCountReuseCandidates,
} from "./shared-scalar-count-reuse";
import { validateLogicalQueryPlan } from "./validator";
export type {
  ConstantFilterJoinProjection,
  DirectScanProjectionChoice,
  PassthroughProjectFusion,
  PhysicalJoinOrderStrategy,
  PhysicalLexicographicComparisonChoice,
  PhysicalMembershipOptimization,
  PhysicalMembershipOptimizationFacts,
  PhysicalMembershipStrategy,
  PhysicalMembershipUsage,
  PhysicalParameterSlotLayout,
  PhysicalQueryPlan,
  PhysicalRowPipelineChoice,
  PhysicalSemiMembershipChoice,
  PhysicalSemiMembershipCostSelection,
  PhysicalTextRowJsonSegment,
  PhysicalTextRowStrategy,
  PhysicalTextRowUsage,
  PositiveTupleMembershipCandidate,
  SharedRelationDefinition,
} from "./physical/contracts";
export {
  hasSamePhysicalMembershipOptimization,
  MAX_D1_JSON_MEMBERSHIP_BYTES,
  optimizePhysicalMembershipBudget,
} from "./physical/membership";
export { optimizePhysicalParameterSlots } from "./physical/parameter-layout";
export type {
  PhysicalSharedRelationBoundaryEvidence,
  PhysicalSharedRelationDefinitionIdentity,
  PhysicalSharedRelationInterface,
  PhysicalSharedRelationInterfaceAnalysisCounts,
  PhysicalSharedRelationInterfaceVetoReason,
  PhysicalSharedRelationInterfaceView,
  PhysicalSharedRelationLicenseKind,
  PhysicalSharedRelationUnlicensedDefinition,
} from "./physical/shared-relation-interfaces";

const MAX_SHARED_RELATION_FIELDS = 4;
const MAX_MATERIALIZED_SHARED_RELATION_FIELDS = 16;
const MIN_REPEATED_WINDOW_INPUT_PROJECT_FIELDS = 17;
const MAX_REPEATED_WINDOW_INPUT_PROJECT_FIELDS = 32;
const MIN_REPEATED_WINDOW_INPUT_PROJECT_REFERENCES = 8;
const MIN_MATERIALIZED_BOUNDARY_PROJECT_FIELDS = MAX_SHARED_RELATION_FIELDS + 1;
const MIN_MATERIALIZED_BOUNDARY_PROJECT_REFERENCES = 2;

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

type ExpressionQuerySourceKind = "scalar-subquery" | "in-subquery";

function visitExpressionQuerySources(
  expression: SqlExpression,
  visitSource: (source: QuerySource, kind: ExpressionQuerySourceKind) => void,
): void {
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
        visitSource(current.query, "in-subquery");
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
        current.branches.forEach((branch) => {
          visit(branch.when);
          visit(branch.then);
        });
        if (current.else) visit(current.else);
        break;
      case "scalar-subquery":
        visitSource(current.query, "scalar-subquery");
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
}

function expressionSources(expression: SqlExpression): QuerySource[] {
  const result: QuerySource[] = [];
  visitExpressionQuerySources(expression, (source) => result.push(source));
  return result;
}

function nodeChildren(node: LogicalQueryNode): QuerySource[] {
  return node.kind === "scan" ||
    node.kind === "values-relation" ||
    node.kind === "json-scalar-array"
    ? []
    : node.kind === "filter" ||
        node.kind === "project" ||
        node.kind === "aggregate" ||
        node.kind === "distinct" ||
        node.kind === "window" ||
        node.kind === "sort" ||
        node.kind === "limit"
      ? [node.input]
      : node.kind === "recursive-closure"
        ? [node.seed, node.candidates]
        : [node.left, node.right];
}

function nodeSources(node: LogicalQueryNode): QuerySource[] {
  return [
    ...nodeChildren(node),
    ...nodeExpressions(node).flatMap(expressionSources),
  ];
}

function directScanProjectionChoices(
  root: LogicalQueryNode,
): readonly DirectScanProjectionChoice[] {
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) visit(source.node);
    postorder.push(node);
  };
  visit(root);

  const choices: DirectScanProjectionChoice[] = [];
  for (const node of postorder) {
    if (node.kind !== "project" || node.input.node.kind !== "scan") continue;
    const scan = node.input.node;
    const columns = Object.values(scan.table.columns);
    const sqlColumnNames: string[] = [];
    let eligible = true;
    for (const projection of node.projections) {
      const expression = projection.expression;
      if (
        expression.kind !== "column" ||
        expression.scope !== node.input.scope ||
        !Number.isInteger(expression.index) ||
        expression.index < 0
      ) {
        eligible = false;
        break;
      }
      // Callers validate the logical plan first, which guarantees that this
      // column scope and index belong to the generated Scan input.
      sqlColumnNames.push(columns[expression.index]!.sqlName);
    }
    if (eligible) choices.push({ project: node, scan, sqlColumnNames });
  }
  return choices;
}

function sameDirectScanProjectionChoices(
  actual: readonly DirectScanProjectionChoice[],
  expected: readonly DirectScanProjectionChoice[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        choice.project === canonical.project &&
        choice.scan === canonical.scan &&
        Array.isArray(choice.sqlColumnNames) &&
        choice.sqlColumnNames.length === canonical.sqlColumnNames.length &&
        choice.sqlColumnNames.every(
          (name, columnIndex) => name === canonical.sqlColumnNames[columnIndex],
        )
      );
    })
  );
}

function expressionReferencesScope(
  expression: SqlExpression,
  target: RelationScope,
  visitedNodes: Set<LogicalQueryNode>,
): boolean {
  const inspectNode = (node: LogicalQueryNode): boolean => {
    if (visitedNodes.has(node)) return false;
    visitedNodes.add(node);
    return (
      nodeExpressions(node).some((child) =>
        expressionReferencesScope(child, target, visitedNodes),
      ) || nodeChildren(node).some((source) => inspectNode(source.node))
    );
  };
  const inspect = (current: SqlExpression): boolean => {
    if (current.kind === "column" && current.scope === target) return true;
    switch (current.kind) {
      case "binary":
      case "distinct-from":
        if (inspect(current.left) || inspect(current.right)) return true;
        break;
      case "boolean":
        if (current.expressions.some(inspect)) return true;
        break;
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-real":
      case "cast-text":
      case "in-list":
        if (inspect(current.expression)) return true;
        break;
      case "text-position":
        if (inspect(current.text) || inspect(current.needle)) return true;
        break;
      case "text-substring":
        if (
          inspect(current.text) ||
          inspect(current.start) ||
          (current.length && inspect(current.length))
        )
          return true;
        break;
      case "text-like":
        if (inspect(current.text) || inspect(current.pattern)) return true;
        break;
      case "in-subquery":
        if (inspect(current.expression)) return true;
        break;
      case "function":
        if (current.arguments.some(inspect)) return true;
        break;
      case "aggregate":
        if (current.expression && inspect(current.expression)) return true;
        break;
      case "coalesce":
        if (current.expressions.some(inspect)) return true;
        break;
      case "case":
        if (
          current.branches.some(
            (branch) => inspect(branch.when) || inspect(branch.then),
          ) ||
          (current.else && inspect(current.else))
        )
          return true;
        break;
      case "scalar-subquery":
        break;
      case "column":
      case "parameter":
      case "excluded":
      case "unixepoch":
      case "constant":
        break;
    }
    return expressionSources(current).some((source) =>
      inspectNode(source.node),
    );
  };
  return inspect(expression);
}

function passthroughProjectFusions(
  root: LogicalQueryNode,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
): readonly PassthroughProjectFusion[] {
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) visit(source.node);
    postorder.push(node);
  };
  visit(root);

  const choices: PassthroughProjectFusion[] = [];
  for (const node of postorder) {
    if (node.kind !== "project" || node.input.node.kind !== "project") continue;
    const passthrough = node.input.node;
    // This is the relational identity Project(parent, Project(columns, R))
    // = Project(parent, R) only when the inner Project has no computed values
    // and the parent does not read its scope. Keep shared nodes intact so
    // bypassing one reference cannot change CTE reuse/evaluation behavior.
    if (
      passthrough.input.node.kind === "scan" ||
      sharedNodes.has(passthrough) ||
      !passthrough.projections.every(
        ({ expression }) =>
          expression.kind === "column" &&
          expression.scope === passthrough.input.scope &&
          Number.isInteger(expression.index) &&
          expression.index >= 0 &&
          expression.index < passthrough.input.fields.length,
      ) ||
      node.projections.some(({ expression }) =>
        expressionReferencesScope(expression, passthrough.scope, new Set()),
      )
    )
      continue;
    choices.push({ project: node, input: passthrough.input });
  }
  return choices;
}

function samePassthroughProjectFusions(
  actual: readonly PassthroughProjectFusion[],
  expected: readonly PassthroughProjectFusion[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        choice.project === canonical.project &&
        choice.input.node === canonical.input.node &&
        choice.input.scope === canonical.input.scope &&
        sameFields(choice.input.fields, canonical.input.fields)
      );
    })
  );
}

function canonicalProjectRendererBoundaries(
  directScan: readonly DirectScanProjectionChoice[],
  passthrough: readonly PassthroughProjectFusion[],
  constantFilterJoin: readonly ConstantFilterJoinProjection[],
  positiveTupleMembership: readonly PositiveTupleMembershipCandidate[],
  selfMembership: readonly PhysicalSelfMembershipChoice[],
): ReadonlySet<LogicalQueryNode> {
  return new Set([
    ...directScan.map(({ project }) => project),
    ...passthrough.map(({ project }) => project),
    ...constantFilterJoin.map(({ project }) => project),
    ...positiveTupleMembership.map(({ project }) => project),
    ...selfMembership.map(({ project }) => project),
  ]);
}

function expressionColumnIndexes(
  expression: SqlExpression,
  target: RelationScope,
): readonly number[] | undefined {
  const indexes = new Set<number>();
  const visit = (current: SqlExpression): boolean => {
    switch (current.kind) {
      case "column":
        if (current.scope === target) indexes.add(current.index);
        return true;
      case "binary":
      case "distinct-from":
        return visit(current.left) && visit(current.right);
      case "boolean":
        return current.expressions.every(visit);
      case "not":
      case "null-check":
      case "cast-integer":
      case "cast-real":
      case "cast-text":
      case "in-list":
        return visit(current.expression);
      case "text-position":
        return visit(current.text) && visit(current.needle);
      case "text-substring":
        return (
          visit(current.text) &&
          visit(current.start) &&
          (!current.length || visit(current.length))
        );
      case "text-like":
        return visit(current.text) && visit(current.pattern);
      case "function":
        return current.arguments.every(visit);
      case "aggregate":
        return !current.expression || visit(current.expression);
      case "coalesce":
        return current.expressions.every(visit);
      case "case":
        return (
          current.branches.every(
            (branch) => visit(branch.when) && visit(branch.then),
          ) &&
          (!current.else || visit(current.else))
        );
      // Query expressions may refer to the Join output from a correlated
      // subquery, so this narrow projection rule leaves them untouched.
      case "in-subquery":
      case "scalar-subquery":
        return false;
      case "parameter":
      case "excluded":
      case "unixepoch":
      case "constant":
        return true;
    }
  };
  return visit(expression)
    ? [...indexes].sort((left, right) => left - right)
    : undefined;
}

function incomingNodeCounts(
  root: LogicalQueryNode,
): Map<LogicalQueryNode, number> {
  const incoming = new Map<LogicalQueryNode, number>([[root, 1]]);
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) {
      incoming.set(source.node, (incoming.get(source.node) ?? 0) + 1);
      visit(source.node);
    }
  };
  visit(root);
  return incoming;
}

/**
 * Relations in a common outer input path for at least two distinct Window
 * nodes. Expression-subquery edges are intentionally excluded from this
 * physical sharing eligibility proof.
 */
function multiWindowInputs(
  root: LogicalQueryNode,
): ReadonlySet<LogicalQueryNode> {
  const owners = new Map<LogicalQueryNode, Set<LogicalQueryNode>>();
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.kind === "window") {
      const inputs = new Set<LogicalQueryNode>();
      const collect = (input: LogicalQueryNode): void => {
        if (inputs.has(input)) return;
        inputs.add(input);
        const set = owners.get(input) ?? new Set<LogicalQueryNode>();
        set.add(node);
        owners.set(input, set);
        nodeChildren(input).forEach((child) => collect(child.node));
      };
      collect(node.input.node);
    }
    nodeChildren(node).forEach((child) => visit(child.node));
  };
  visit(root);
  return new Set(
    [...owners]
      .filter(([, windows]) => windows.size >= 2)
      .map(([node]) => node),
  );
}

function directColumnIndex(
  expression: SqlExpression,
  scope: RelationScope,
): number | undefined {
  return expression.kind === "column" && expression.scope === scope
    ? expression.index
    : undefined;
}

function expressionUsesOnlyScope(
  expression: SqlExpression,
  scope: RelationScope,
): boolean {
  switch (expression.kind) {
    case "column":
      return expression.scope === scope;
    case "binary":
    case "distinct-from":
      return (
        expressionUsesOnlyScope(expression.left, scope) &&
        expressionUsesOnlyScope(expression.right, scope)
      );
    case "boolean":
      return expression.expressions.every((item) =>
        expressionUsesOnlyScope(item, scope),
      );
    case "not":
    case "null-check":
    case "cast-integer":
    case "cast-real":
    case "cast-text":
    case "in-list":
      return expressionUsesOnlyScope(expression.expression, scope);
    case "text-position":
      return (
        expressionUsesOnlyScope(expression.text, scope) &&
        expressionUsesOnlyScope(expression.needle, scope)
      );
    case "text-substring":
      return (
        expressionUsesOnlyScope(expression.text, scope) &&
        expressionUsesOnlyScope(expression.start, scope) &&
        (!expression.length ||
          expressionUsesOnlyScope(expression.length, scope))
      );
    case "text-like":
      return (
        expressionUsesOnlyScope(expression.text, scope) &&
        expressionUsesOnlyScope(expression.pattern, scope)
      );
    case "function":
      return expression.arguments.every((item) =>
        expressionUsesOnlyScope(item, scope),
      );
    case "aggregate":
      return (
        !expression.expression ||
        expressionUsesOnlyScope(expression.expression, scope)
      );
    case "coalesce":
      return expression.expressions.every((item) =>
        expressionUsesOnlyScope(item, scope),
      );
    case "case":
      return (
        expression.branches.every(
          (branch) =>
            expressionUsesOnlyScope(branch.when, scope) &&
            expressionUsesOnlyScope(branch.then, scope),
        ) &&
        (!expression.else || expressionUsesOnlyScope(expression.else, scope))
      );
    case "in-subquery":
    case "scalar-subquery":
      return false;
    case "parameter":
    case "excluded":
    case "unixepoch":
    case "constant":
      return true;
  }
}

function equalityPairs(
  expression: SqlExpression,
  leftScope: RelationScope,
  rightScope: RelationScope,
): { readonly left: number; readonly right: number }[] | undefined {
  if (
    expression.kind === "boolean" &&
    expression.operator === "AND" &&
    expression.expressions.length > 0
  ) {
    const pairs: { readonly left: number; readonly right: number }[] = [];
    for (const child of expression.expressions) {
      const nested = equalityPairs(child, leftScope, rightScope);
      if (!nested) return undefined;
      pairs.push(...nested);
    }
    return pairs;
  }
  if (expression.kind !== "binary" || expression.operator !== "=")
    return undefined;
  const leftIndex = directColumnIndex(expression.left, leftScope);
  const rightIndex = directColumnIndex(expression.right, rightScope);
  return leftIndex === undefined || rightIndex === undefined
    ? undefined
    : [{ left: leftIndex, right: rightIndex }];
}

function safeFinitePredicate(expression: SqlExpression): boolean {
  switch (expression.kind) {
    case "binary":
      return (
        ["=", "<>", ">", ">=", "<", "<="].includes(expression.operator) &&
        (expression.left.kind === "column" ||
          expression.left.kind === "parameter" ||
          expression.left.kind === "constant") &&
        (expression.right.kind === "column" ||
          expression.right.kind === "parameter" ||
          expression.right.kind === "constant")
      );
    case "boolean":
      return (
        expression.operator === "AND" &&
        expression.expressions.length > 0 &&
        expression.expressions.every(safeFinitePredicate)
      );
    case "in-list":
      return (
        expression.expression.kind === "column" &&
        Array.isArray(expression.values) &&
        Reflect.ownKeys(expression.values).length ===
          expression.values.length + 1 &&
        expression.values.every(
          (value, index) =>
            Object.prototype.hasOwnProperty.call(expression.values, index) &&
            (value === null ||
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"),
        )
      );
    case "column":
    case "parameter":
    case "constant":
      return true;
    default:
      return false;
  }
}

function safeEqualityCondition(
  expression: SqlExpression,
  leftScope: RelationScope,
  rightScope: RelationScope,
  leftFields: readonly OutputField[],
  rightFields: readonly OutputField[],
): boolean {
  const pairs = equalityPairs(expression, leftScope, rightScope);
  return (
    !!pairs &&
    pairs.length > 0 &&
    pairs.every(
      ({ left, right }) =>
        left >= 0 &&
        left < leftFields.length &&
        right >= 0 &&
        right < rightFields.length,
    )
  );
}

/**
 * Shared inputs remain CTE references; inspect only to prove they are pure,
 * local, read-only generated-schema lookups before treating them as a boundary.
 */
function isSafeSharedLookup(root: LogicalQueryNode): boolean {
  const visited = new Set<LogicalQueryNode>();
  let hasGeneratedScan = false;
  const visit = (node: LogicalQueryNode): boolean => {
    if (visited.has(node)) return true;
    visited.add(node);
    switch (node.kind) {
      case "scan":
        hasGeneratedScan = true;
        return true;
      case "filter":
        return (
          safeFinitePredicate(node.predicate) &&
          expressionUsesOnlyScope(node.predicate, node.input.scope) &&
          visit(node.input.node)
        );
      case "project":
        return (
          node.projections.every(({ expression }) => {
            const index = directColumnIndex(expression, node.input.scope);
            return (
              index !== undefined &&
              index >= 0 &&
              index < node.input.fields.length
            );
          }) && visit(node.input.node)
        );
      case "join":
        return (
          node.joinType === "inner" &&
          safeEqualityCondition(
            node.condition,
            node.left.scope,
            node.right.scope,
            node.left.fields,
            node.right.fields,
          ) &&
          visit(node.left.node) &&
          visit(node.right.node)
        );
      default:
        return false;
    }
  };
  return visit(root) && hasGeneratedScan;
}

/**
 * The current generated catalog and ValuesRelation have only default BINARY
 * columns; the validated expression algebra has no COLLATE or raw-SQL node.
 * Trace direct fields only, so future/unknown computed sources opt out.
 */
function hasKnownBinaryColumnSource(
  source: QuerySource,
  index: number,
  visited = new Set<LogicalQueryNode>(),
): boolean {
  if (index < 0 || index >= source.fields.length || visited.has(source.node))
    return false;
  const node = source.node;
  visited.add(node);
  switch (node.kind) {
    case "scan":
    case "values-relation":
      return true;
    case "filter":
    case "distinct":
      return hasKnownBinaryColumnSource(node.input, index, visited);
    case "window":
      return hasKnownBinaryColumnSource(node.input, index, visited);
    case "project": {
      const inputIndex = directColumnIndex(
        node.projections[index]!.expression,
        node.input.scope,
      );
      return (
        inputIndex !== undefined &&
        hasKnownBinaryColumnSource(node.input, inputIndex, visited)
      );
    }
    case "join": {
      if (index < node.left.fields.length)
        return hasKnownBinaryColumnSource(node.left, index, visited);
      return hasKnownBinaryColumnSource(
        node.right,
        index - node.left.fields.length,
        visited,
      );
    }
    case "semi-join":
    case "anti-join":
      return hasKnownBinaryColumnSource(node.left, index, visited);
    default:
      return false;
  }
}

function hasSafeFiniteValuesAncestor(
  root: QuerySource,
): ValuesRelationNode | undefined {
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  const values = new Set<ValuesRelationNode>();
  const visit = (node: LogicalQueryNode): boolean => {
    if (active.has(node)) return false;
    if (visited.has(node)) return true;
    active.add(node);
    const safe = (() => {
      switch (node.kind) {
        case "values-relation":
          values.add(node);
          return true;
        case "scan":
          return true;
        case "filter":
          return (
            safeFinitePredicate(node.predicate) &&
            expressionUsesOnlyScope(node.predicate, node.input.scope) &&
            visit(node.input.node)
          );
        case "project":
          return (
            node.projections.every(
              ({ expression }) =>
                expression.kind === "column" &&
                expression.scope === node.input.scope,
            ) && visit(node.input.node)
          );
        case "join":
          return (
            node.joinType === "inner" &&
            safeEqualityCondition(
              node.condition,
              node.left.scope,
              node.right.scope,
              node.left.fields,
              node.right.fields,
            ) &&
            visit(node.left.node) &&
            visit(node.right.node)
          );
        default:
          return false;
      }
    })();
    active.delete(node);
    if (safe) visited.add(node);
    // Repeated nodes are fully walked before being memoized. A shared CTE is
    // therefore accepted only when its entire lookup body stays in this safe
    // finite Values algebra; it is never treated as an opaque name/boundary.
    return safe;
  };
  return visit(root.node) && values.size === 1
    ? values.values().next().value
    : undefined;
}

function isStableTupleMembershipSource(
  root: QuerySource,
  licensedMaterializedBoundaries: ReadonlySet<LogicalQueryNode>,
): boolean {
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): boolean => {
    if (node !== root.node && licensedMaterializedBoundaries.has(node))
      return true;
    if (active.has(node)) return false;
    if (visited.has(node)) return true;
    active.add(node);
    const safe = (() => {
      switch (node.kind) {
        case "scan":
        case "values-relation":
          return true;
        case "filter":
          return (
            safeFinitePredicate(node.predicate) &&
            expressionUsesOnlyScope(node.predicate, node.input.scope) &&
            visit(node.input.node)
          );
        case "project":
          return (
            node.projections.every(
              ({ expression }) =>
                expression.kind === "column" &&
                expression.scope === node.input.scope,
            ) && visit(node.input.node)
          );
        case "distinct":
          return visit(node.input.node);
        case "join":
          return (
            (node.joinType === "inner" || node.joinType === "left") &&
            safeEqualityCondition(
              node.condition,
              node.left.scope,
              node.right.scope,
              node.left.fields,
              node.right.fields,
            ) &&
            visit(node.left.node) &&
            visit(node.right.node)
          );
        default:
          return false;
      }
    })();
    active.delete(node);
    if (safe) visited.add(node);
    // Walk through shared DAG/CTE nodes and prove their complete stable body.
    // Compilation still references their original shared definition.
    return safe;
  };
  return visit(root.node);
}

function positiveTupleMembershipCandidates(
  root: LogicalQueryNode,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
  licensedMaterializedBoundaries: ReadonlySet<LogicalQueryNode> = new Set(),
): readonly PositiveTupleMembershipCandidate[] {
  const incoming = incomingNodeCounts(root);
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) visit(source.node);
    postorder.push(node);
  };
  visit(root);

  const candidates: PositiveTupleMembershipCandidate[] = [];
  for (const node of postorder) {
    if (
      node.kind !== "project" ||
      node.input.node.kind !== "join" ||
      node.projections.length === 0
    )
      continue;
    const join = node.input.node;
    if (
      join.joinType !== "inner" ||
      sharedNodes.has(node) ||
      sharedNodes.has(join) ||
      incoming.get(node) !== 1 ||
      incoming.get(join) !== 1 ||
      !node.projections.every(({ expression }) => {
        const index = directColumnIndex(expression, join.scope);
        return index !== undefined && index < join.left.fields.length;
      }) ||
      join.right.node.kind !== "distinct"
    )
      continue;

    const distinct = join.right.node;
    if (distinct.input.node.kind !== "project") continue;
    const keyProjection = distinct.input.node;
    const keyCount = distinct.fields.length;
    if (
      keyCount === 0 ||
      distinct.fields.length !== distinct.input.fields.length ||
      keyProjection.projections.length !== keyCount
    )
      continue;

    const rightKeyIndexes: number[] = [];
    const uniqueSourceIndexes = new Set<number>();
    let validKeys = true;
    for (let index = 0; index < keyCount; index++) {
      const expression = keyProjection.projections[index]!.expression;
      const sourceIndex = directColumnIndex(
        expression,
        keyProjection.input.scope,
      );
      if (
        sourceIndex === undefined ||
        sourceIndex < 0 ||
        sourceIndex >= keyProjection.input.fields.length ||
        uniqueSourceIndexes.has(sourceIndex) ||
        !hasKnownBinaryColumnSource(keyProjection.input, sourceIndex)
      ) {
        validKeys = false;
        break;
      }
      uniqueSourceIndexes.add(sourceIndex);
      rightKeyIndexes.push(index);
    }
    if (!validKeys) continue;

    const pairs = equalityPairs(
      join.condition,
      join.left.scope,
      join.right.scope,
    );
    if (
      !pairs ||
      pairs.length !== keyCount ||
      new Set(pairs.map(({ right }) => right)).size !== keyCount ||
      pairs.some(({ right }) => right < 0 || right >= keyCount)
    )
      continue;
    const leftKeyIndexes: number[] = [];
    for (const right of rightKeyIndexes) {
      const pair = pairs.find((item) => item.right === right);
      if (
        !pair ||
        pair.left < 0 ||
        pair.left >= join.left.fields.length ||
        join.left.fields[pair.left]!.affinity === "unknown" ||
        join.right.fields[right]!.affinity === "unknown" ||
        join.left.fields[pair.left]!.affinity !==
          join.right.fields[right]!.affinity ||
        !hasKnownBinaryColumnSource(join.left, pair.left)
      ) {
        validKeys = false;
        break;
      }
      leftKeyIndexes.push(pair.left);
    }
    if (!validKeys) continue;

    const valuesRelation = hasSafeFiniteValuesAncestor(distinct.input);
    const membershipSource = valuesRelation
      ? "finite-values"
      : "dynamic-distinct";
    if (
      !valuesRelation &&
      !isStableTupleMembershipSource(
        distinct.input,
        licensedMaterializedBoundaries,
      )
    ) {
      continue;
    }
    candidates.push({
      project: node,
      join,
      membershipSource,
      ...(valuesRelation ? { valuesRelation } : {}),
      leftKeyIndexes,
      rightKeyIndexes,
    });
  }
  return candidates;
}

function constantFilterJoinProjections(
  root: LogicalQueryNode,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
  fusions: readonly PassthroughProjectFusion[],
): readonly ConstantFilterJoinProjection[] {
  const incoming = incomingNodeCounts(root);
  const fusedInputs = new Map(
    fusions.map((fusion) => [fusion.project, fusion.input] as const),
  );
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) visit(source.node);
    postorder.push(node);
  };
  visit(root);

  const choices: ConstantFilterJoinProjection[] = [];
  for (const node of postorder) {
    if (
      node.kind !== "project" ||
      node.projections.length === 0 ||
      !node.projections.every(
        ({ expression }) => expression.kind === "constant",
      )
    )
      continue;
    const input = fusedInputs.get(node) ?? node.input;
    if (input.node.kind !== "filter") continue;
    const filter = input.node;
    if (filter.input.node.kind !== "join") continue;
    const join = filter.input.node;
    if (
      sharedNodes.has(node) ||
      sharedNodes.has(filter) ||
      sharedNodes.has(join) ||
      incoming.get(filter) !== 1 ||
      incoming.get(join) !== 1
    )
      continue;
    const referencedOutputColumns = expressionColumnIndexes(
      filter.predicate,
      join.scope,
    );
    if (
      referencedOutputColumns === undefined ||
      referencedOutputColumns.some(
        (index) => index < 0 || index >= join.fields.length,
      )
    )
      continue;
    choices.push({ project: node, filter, join, referencedOutputColumns });
  }
  return choices;
}

function sameConstantFilterJoinProjections(
  actual: readonly ConstantFilterJoinProjection[],
  expected: readonly ConstantFilterJoinProjection[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        choice.project === canonical.project &&
        choice.filter === canonical.filter &&
        choice.join === canonical.join &&
        choice.referencedOutputColumns.length ===
          canonical.referencedOutputColumns.length &&
        choice.referencedOutputColumns.every(
          (column, columnIndex) =>
            column === canonical.referencedOutputColumns[columnIndex],
        )
      );
    })
  );
}

function samePositiveTupleMembershipCandidates(
  actual: readonly PositiveTupleMembershipCandidate[],
  expected: readonly PositiveTupleMembershipCandidate[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((candidate, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        candidate.project === canonical.project &&
        candidate.join === canonical.join &&
        candidate.membershipSource === canonical.membershipSource &&
        candidate.valuesRelation === canonical.valuesRelation &&
        candidate.leftKeyIndexes.length === canonical.leftKeyIndexes.length &&
        candidate.leftKeyIndexes.every(
          (column, columnIndex) =>
            column === canonical.leftKeyIndexes[columnIndex],
        ) &&
        candidate.rightKeyIndexes.length === canonical.rightKeyIndexes.length &&
        candidate.rightKeyIndexes.every(
          (column, columnIndex) =>
            column === canonical.rightKeyIndexes[columnIndex],
        )
      );
    })
  );
}

function sameSelfMembershipChoices(
  actual: readonly PhysicalSelfMembershipChoice[],
  expected: readonly PhysicalSelfMembershipChoice[],
): boolean {
  const sameIndexes = (
    left: readonly number[],
    right: readonly number[],
  ): boolean =>
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
  const sameWitness = (
    left: PhysicalSelfMembershipChoice["witness"],
    right: PhysicalSelfMembershipChoice["witness"],
  ): boolean => {
    if (!left || !right) return left === right;
    return (
      left.source.node === right.source.node &&
      left.source.scope === right.source.scope &&
      sameFields(left.source.fields, right.source.fields) &&
      left.definition.node === right.definition.node &&
      left.definition.name === right.definition.name &&
      left.definition.scope === right.definition.scope &&
      left.definition.materialization === right.definition.materialization &&
      sameFields(left.definition.fields, right.definition.fields) &&
      left.definitionIndex === right.definitionIndex &&
      left.producer === right.producer &&
      left.producerIndex === right.producerIndex &&
      sameIndexes(left.sourceKeyIndexes, right.sourceKeyIndexes) &&
      sameIndexes(
        left.rightProjectInputIndexes,
        right.rightProjectInputIndexes,
      ) &&
      left.path.length === right.path.length &&
      left.path.every((step, index) => {
        const canonical = right.path[index];
        if (
          !canonical ||
          step.kind !== canonical.kind ||
          step.node !== canonical.node
        )
          return false;
        if (step.kind === "inner-join" && canonical.kind === "inner-join")
          return (
            step.side === canonical.side &&
            sameIndexes(step.outputIndexes, canonical.outputIndexes) &&
            sameIndexes(step.inputIndexes, canonical.inputIndexes)
          );
        return (
          step.kind !== "inner-join" &&
          canonical.kind !== "inner-join" &&
          sameIndexes(step.outputIndexes, canonical.outputIndexes) &&
          sameIndexes(step.inputIndexes, canonical.inputIndexes)
        );
      }) &&
      left.boundary.definition.node === right.boundary.definition.node &&
      left.boundary.definition.name === right.boundary.definition.name &&
      left.boundary.license.kind === right.boundary.license.kind &&
      left.boundary.boundary.kind === right.boundary.boundary.kind &&
      left.boundary.closure.kind === right.boundary.closure.kind &&
      left.boundary.closure.scopeCount === right.boundary.closure.scopeCount &&
      left.boundary.closure.referencedScopeCount ===
        right.boundary.closure.referencedScopeCount &&
      left.boundary.closure.referencedColumnCount ===
        right.boundary.closure.referencedColumnCount &&
      left.boundary.totality.kind === right.boundary.totality.kind &&
      left.boundary.totality.stoppedAt.length ===
        right.boundary.totality.stoppedAt.length &&
      left.boundary.totality.stoppedAt.every(
        (node, index) => node === right.boundary.totality.stoppedAt[index],
      )
    );
  };
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        choice.project === canonical.project &&
        choice.join === canonical.join &&
        choice.membershipSource === canonical.membershipSource &&
        choice.tupleCandidate.project === canonical.tupleCandidate.project &&
        choice.tupleCandidate.join === canonical.tupleCandidate.join &&
        choice.tupleCandidate.membershipSource ===
          canonical.tupleCandidate.membershipSource &&
        choice.tupleCandidate.valuesRelation ===
          canonical.tupleCandidate.valuesRelation &&
        choice.leftKeyIndexes.length === canonical.leftKeyIndexes.length &&
        sameIndexes(choice.leftKeyIndexes, canonical.leftKeyIndexes) &&
        sameIndexes(choice.rightKeyIndexes, canonical.rightKeyIndexes) &&
        sameIndexes(
          choice.tupleCandidate.leftKeyIndexes,
          canonical.tupleCandidate.leftKeyIndexes,
        ) &&
        sameIndexes(
          choice.tupleCandidate.rightKeyIndexes,
          canonical.tupleCandidate.rightKeyIndexes,
        ) &&
        choice.nullableKeyIndexes.length ===
          canonical.nullableKeyIndexes.length &&
        sameIndexes(choice.nullableKeyIndexes, canonical.nullableKeyIndexes) &&
        sameWitness(choice.witness, canonical.witness)
      );
    })
  );
}

interface UniqueLookupProof {
  readonly scan: ScanNode;
  readonly columnIndex: number;
  readonly uniqueKey: string;
}

function nonNullLookupValue(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean")
  );
}

function generatedUniqueKey(
  scan: ScanNode,
  columnIndex: number,
): string | undefined {
  const column = Object.values(scan.table.columns)[columnIndex];
  if (!column) return undefined;
  if (
    scan.table.primaryKey.length === 1 &&
    scan.table.primaryKey[0] === column.sqlName
  )
    return `primary:${scan.table.name}:${column.sqlName}`;
  const index = scan.table.indexes.find(
    (candidate) =>
      candidate.unique &&
      !candidate.partial &&
      candidate.rawExpressionSql === undefined &&
      candidate.columns.length === 1 &&
      candidate.columns[0] === column.sqlName,
  );
  return index ? `index:${index.name}` : undefined;
}

function scanColumnForOutput(
  source: QuerySource,
  outputIndex: number,
): { readonly scan: ScanNode; readonly columnIndex: number } | undefined {
  let current = source;
  let index = outputIndex;
  const visited = new Set<LogicalQueryNode>();
  while (current.node.kind === "project" || current.node.kind === "filter") {
    if (visited.has(current.node)) return undefined;
    visited.add(current.node);
    if (current.node.kind === "project") {
      const childIndex = directColumnIndex(
        current.node.projections[index]?.expression,
        current.node.input.scope,
      );
      if (childIndex === undefined) return undefined;
      index = childIndex;
    }
    current = current.node.input;
  }
  return current.node.kind === "scan"
    ? { scan: current.node, columnIndex: index }
    : undefined;
}

function singleValueUniqueLookup(
  source: QuerySource,
): UniqueLookupProof | undefined {
  let current = source;
  let pureProjectCount = 0;
  const visited = new Set<LogicalQueryNode>();
  while (current.node.kind === "project") {
    if (visited.has(current.node) || !isPureLocalColumnProject(current.node))
      return undefined;
    visited.add(current.node);
    pureProjectCount++;
    current = current.node.input;
  }
  if (
    pureProjectCount === 0 ||
    current.node.kind !== "filter" ||
    !safeFinitePredicate(current.node.predicate) ||
    !expressionUsesOnlyScope(current.node.predicate, current.node.input.scope)
  )
    return undefined;
  const predicate = current.node.predicate;
  let columnIndex: number | undefined;
  if (predicate.kind === "binary" && predicate.operator === "=") {
    const lookup =
      predicate.left.kind === "column"
        ? { column: predicate.left, value: predicate.right }
        : predicate.right.kind === "column"
          ? { column: predicate.right, value: predicate.left }
          : undefined;
    if (
      lookup &&
      (lookup.value.kind === "parameter" || lookup.value.kind === "constant") &&
      nonNullLookupValue(lookup.value.value)
    )
      columnIndex = directColumnIndex(lookup.column, current.node.input.scope);
  } else if (
    predicate.kind === "in-list" &&
    predicate.values.length === 1 &&
    nonNullLookupValue(predicate.values[0])
  ) {
    columnIndex = directColumnIndex(
      predicate.expression,
      current.node.input.scope,
    );
  }
  if (columnIndex === undefined || current.node.input.node.kind !== "scan")
    return undefined;
  const scan = current.node.input.node;
  const uniqueKey = generatedUniqueKey(scan, columnIndex);
  return uniqueKey === undefined ? undefined : { scan, columnIndex, uniqueKey };
}

function rightUniqueJoinKey(
  join: JoinNode,
): { readonly uniqueKey: string } | undefined {
  const pairs = equalityPairs(
    join.condition,
    join.left.scope,
    join.right.scope,
  );
  if (!pairs) return undefined;
  for (const pair of pairs) {
    const mapped = scanColumnForOutput(join.right, pair.right);
    if (!mapped) continue;
    const uniqueKey = generatedUniqueKey(mapped.scan, mapped.columnIndex);
    if (uniqueKey) return { uniqueKey };
  }
  const filtered = singleValueUniqueLookup(join.right);
  return filtered ? { uniqueKey: filtered.uniqueKey } : undefined;
}

function isClosedOrdinarySubtree(
  root: LogicalQueryNode,
  active = new Set<LogicalQueryNode>(),
  memo = new Map<LogicalQueryNode, boolean>(),
): boolean {
  const cached = memo.get(root);
  if (cached !== undefined) return cached;
  if (active.has(root)) return false;
  active.add(root);
  let accepted: boolean;
  switch (root.kind) {
    case "scan":
      accepted = true;
      break;
    case "project":
      accepted =
        isPureLocalColumnProject(root) &&
        isClosedOrdinarySubtree(root.input.node, active, memo);
      break;
    case "filter":
      accepted =
        isStableOrdinaryFilter(root.predicate, root.input.scope) &&
        expressionUsesOnlyScope(root.predicate, root.input.scope) &&
        isClosedOrdinarySubtree(root.input.node, active, memo);
      break;
    case "join":
      accepted =
        (root.joinType === "inner" || root.joinType === "left") &&
        safeEqualityCondition(
          root.condition,
          root.left.scope,
          root.right.scope,
          root.left.fields,
          root.right.fields,
        ) &&
        rightUniqueJoinKey(root) !== undefined &&
        isClosedOrdinarySubtree(root.left.node, active, memo) &&
        isClosedOrdinarySubtree(root.right.node, active, memo);
      break;
    default:
      accepted = false;
      break;
  }
  active.delete(root);
  memo.set(root, accepted);
  return accepted;
}

function isStableOrdinaryFilter(
  expression: SqlExpression,
  scope: RelationScope,
): boolean {
  if (
    expression.kind === "null-check" &&
    expression.expression.kind === "column"
  )
    return directColumnIndex(expression.expression, scope) !== undefined;
  if (expression.kind === "boolean" && expression.operator === "AND")
    return (
      expression.expressions.length > 0 &&
      expression.expressions.every((child) =>
        isStableOrdinaryFilter(child, scope),
      )
    );
  return safeFinitePredicate(expression);
}

function containsBoundEquality(
  root: LogicalQueryNode,
  visited = new Set<LogicalQueryNode>(),
): boolean {
  if (visited.has(root)) return false;
  visited.add(root);
  if (
    root.kind === "filter" &&
    safeFinitePredicate(root.predicate) &&
    expressionUsesOnlyScope(root.predicate, root.input.scope)
  ) {
    const inspect = (expression: SqlExpression): boolean => {
      if (expression.kind === "boolean" && expression.operator === "AND")
        return expression.expressions.some(inspect);
      if (expression.kind === "binary" && expression.operator === "=") {
        const value =
          expression.left.kind === "column"
            ? expression.right
            : expression.right.kind === "column"
              ? expression.left
              : undefined;
        return (
          value !== undefined &&
          (value.kind === "parameter" || value.kind === "constant") &&
          nonNullLookupValue(value.value)
        );
      }
      if (
        expression.kind === "in-list" &&
        expression.expression.kind === "column" &&
        expression.values.length === 1 &&
        expression.values.every(nonNullLookupValue)
      )
        return true;
      return false;
    };
    if (inspect(root.predicate)) return true;
  }
  if (root.kind === "join" && rightUniqueJoinKey(root) !== undefined)
    return containsBoundEquality(root.left.node, visited);
  return nodeChildren(root).some((child) =>
    containsBoundEquality(child.node, visited),
  );
}

function pureProjectPath(
  source: QuerySource,
  stopAt: ReadonlySet<LogicalQueryNode> = new Set(),
):
  | {
      readonly node: LogicalQueryNode;
      readonly outputIndexes: readonly number[];
      readonly depth: number;
    }
  | undefined {
  let current = source;
  let outputIndexes = source.fields.map((_field, index) => index);
  let depth = 0;
  const visited = new Set<LogicalQueryNode>();
  while (current.node.kind === "project" && !stopAt.has(current.node)) {
    if (visited.has(current.node) || !isPureLocalColumnProject(current.node))
      return undefined;
    const project = current.node;
    visited.add(project);
    const mappedIndexes = outputIndexes.map((index) =>
      directColumnIndex(
        project.projections[index]?.expression,
        project.input.scope,
      ),
    );
    if (mappedIndexes.some((index) => index === undefined)) return undefined;
    outputIndexes = mappedIndexes as number[];
    current = project.input;
    depth++;
  }
  return {
    node: current.node,
    outputIndexes: outputIndexes as number[],
    depth,
  };
}

function isMaterializedKeyedAggregate(
  join: JoinNode,
  shared: ReadonlyMap<LogicalQueryNode, SharedRelationDefinition>,
  analysis: SharedRelationAnalysis,
): boolean {
  const leftClosed = isClosedOrdinarySubtree(join.left.node);
  if (join.joinType !== "inner" || !leftClosed) return false;
  const rightPath = pureProjectPath(join.right);
  if (!rightPath || rightPath.node.kind !== "aggregate") return false;
  const aggregate = rightPath.node;
  if (
    aggregate.groups.length === 0 ||
    !aggregate.groups.every(
      ({ expression }) =>
        expression.kind === "column" &&
        expression.scope === aggregate.input.scope &&
        expression.index >= 0 &&
        expression.index < aggregate.input.fields.length,
    ) ||
    !aggregate.aggregates.every(({ expression }) =>
      expressionFitsLocalFields(
        expression,
        aggregate.input.scope,
        aggregate.input.fields.length,
      ),
    )
  )
    return false;
  const materializedNodes = new Set(
    [...shared.values()]
      .filter(({ materialization }) => materialization === "materialized")
      .map(({ node }) => node),
  );
  const inputPath = pureProjectPath(aggregate.input, materializedNodes);
  if (!inputPath || inputPath.depth === 0) return false;
  const sharedDefinition = shared.get(inputPath.node);
  if (!sharedDefinition || sharedDefinition.materialization !== "materialized")
    return false;
  const facts = candidateFacts(
    sharedDefinition.node,
    analysis.closedWindowScopeMemo,
  );
  if (
    !facts.selective ||
    facts.forbidden ||
    !facts.referencedScopes.every((scope) => facts.scopes.has(scope)) ||
    !isSafeSharedLookup(sharedDefinition.node) ||
    !containsBoundEquality(sharedDefinition.node)
  )
    return false;
  const pairs = equalityPairs(
    join.condition,
    join.left.scope,
    join.right.scope,
  );
  if (!pairs || pairs.length !== aggregate.groups.length) return false;
  const groupIndexes = new Set<number>();
  const leftIndexes = new Set<number>();
  for (const pair of pairs) {
    const aggregateIndex = rightPath.outputIndexes[pair.right];
    if (
      aggregateIndex === undefined ||
      aggregateIndex < 0 ||
      aggregateIndex >= aggregate.groups.length ||
      groupIndexes.has(aggregateIndex) ||
      leftIndexes.has(pair.left)
    )
      return false;
    groupIndexes.add(aggregateIndex);
    leftIndexes.add(pair.left);
  }
  return groupIndexes.size === aggregate.groups.length;
}

interface ResolvedSchemaColumn {
  readonly table: SchemaObjectReference;
  readonly column: SchemaColumnReference;
}

function foldSqlIdentifierAscii(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code >= 0x41 && code <= 0x5a
      ? String.fromCharCode(code + 0x20)
      : character;
  }).join("");
}

function sameSqlIdentifier(left: string, right: string): boolean {
  return foldSqlIdentifierAscii(left) === foldSqlIdentifierAscii(right);
}

function directSchemaColumn(
  scan: ScanNode,
  index: number,
  outputField: OutputField,
): ResolvedSchemaColumn | undefined {
  const table = scan.table;
  const column = Object.values(table.columns)[index];
  if (
    table.kind !== "table" ||
    table.defaultCollation !== "BINARY" ||
    !column ||
    column.kind !== "column" ||
    column.hidden !== 0 ||
    column.generated ||
    outputField.affinity === "unknown" ||
    outputField.affinity !== column.affinity ||
    !sameSqlIdentifier(column.table, table.name)
  )
    return undefined;
  return { table, column };
}

/**
 * Trace one passed-through output to an ordinary table column. Each selected
 * Project output must be a direct column reference; unrelated computed
 * outputs do not affect the proof. Set, recursive, and unknown sources have
 * no lineage proof.
 */
function resolvePassedThroughColumn(
  node: LogicalQueryNode,
  index: number,
  active = new Set<LogicalQueryNode>(),
): ResolvedSchemaColumn | undefined {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= node.fields.length ||
    active.has(node)
  )
    return undefined;
  active.add(node);
  let resolved: ResolvedSchemaColumn | undefined;
  const field = node.fields[index]!;
  if (node.kind === "scan") {
    resolved = directSchemaColumn(node, index, field);
  } else if (node.kind === "filter") {
    const inputField = node.input.fields[index];
    if (inputField?.affinity === field.affinity)
      resolved = resolvePassedThroughColumn(node.input.node, index, active);
  } else if (node.kind === "project") {
    const projection = node.projections[index];
    if (
      projection?.expression.kind === "column" &&
      projection.expression.scope === node.input.scope &&
      Number.isInteger(projection.expression.index) &&
      projection.expression.index >= 0 &&
      projection.expression.index < node.input.fields.length &&
      projection.expression.resultType.affinity === field.affinity &&
      node.input.fields[projection.expression.index]?.affinity ===
        field.affinity
    )
      resolved = resolvePassedThroughColumn(
        node.input.node,
        projection.expression.index,
        active,
      );
  } else if (node.kind === "join") {
    if (index < node.left.fields.length) {
      if (node.left.fields[index]?.affinity === field.affinity)
        resolved = resolvePassedThroughColumn(node.left.node, index, active);
    } else {
      const rightIndex = index - node.left.fields.length;
      if (node.right.fields[rightIndex]?.affinity === field.affinity)
        resolved = resolvePassedThroughColumn(
          node.right.node,
          rightIndex,
          active,
        );
    }
  }
  active.delete(node);
  return resolved;
}

interface DirectRightScan {
  readonly scan: ScanNode;
  /** Right input output index to the underlying scan output index. */
  readonly scanIndexes: readonly number[];
}

function directRightScan(node: LogicalQueryNode): DirectRightScan | undefined {
  if (node.kind === "scan")
    return {
      scan: node,
      scanIndexes: node.fields.map((_field, index) => index),
    };
  if (node.kind !== "project" || node.input.node.kind !== "scan")
    return undefined;
  const scan = node.input.node;
  const scanIndexes: number[] = [];
  for (let index = 0; index < node.projections.length; index++) {
    const expression = node.projections[index]!.expression;
    if (
      expression.kind !== "column" ||
      expression.scope !== node.input.scope ||
      !Number.isInteger(expression.index) ||
      expression.index < 0 ||
      expression.index >= scan.fields.length ||
      expression.resultType.affinity !== node.fields[index]?.affinity ||
      scan.fields[expression.index]?.affinity !== node.fields[index]?.affinity
    )
      return undefined;
    scanIndexes.push(expression.index);
  }
  return scanIndexes.length === node.fields.length
    ? { scan, scanIndexes }
    : undefined;
}

function factLocalEqualityPairs(
  expression: SqlExpression,
  leftScope: RelationScope,
  rightScope: RelationScope,
): { readonly left: number; readonly right: number }[] | undefined {
  if (
    expression.kind === "boolean" &&
    expression.operator === "AND" &&
    expression.expressions.length > 0
  ) {
    const pairs: { readonly left: number; readonly right: number }[] = [];
    for (const child of expression.expressions) {
      const nested = factLocalEqualityPairs(child, leftScope, rightScope);
      if (!nested) return undefined;
      pairs.push(...nested);
    }
    return pairs;
  }
  if (expression.kind !== "binary" || expression.operator !== "=")
    return undefined;
  const direct = (
    left: SqlExpression,
    right: SqlExpression,
  ): { readonly left: number; readonly right: number } | undefined => {
    const leftIndex = directColumnIndex(left, leftScope);
    const rightIndex = directColumnIndex(right, rightScope);
    return leftIndex === undefined || rightIndex === undefined
      ? undefined
      : { left: leftIndex, right: rightIndex };
  };
  const directPair = direct(expression.left, expression.right);
  return directPair ? [directPair] : undefined;
}

function factLocalIndexedStrategy(
  join: JoinNode,
  owner: Extract<LogicalQueryNode, { readonly kind: "aggregate" }>,
  shared: ReadonlyMap<LogicalQueryNode, SharedRelationDefinition>,
):
  | Extract<PhysicalJoinOrderStrategy, { readonly kind: "fact-local-indexed" }>
  | undefined {
  if (join.joinType !== "inner") return undefined;
  const reuse = shared.get(join.left.node);
  if (
    !reuse ||
    reuse.materialization !== "materialized" ||
    shared.get(owner)?.materialization !== "materialized"
  )
    return undefined;

  const right = directRightScan(join.right.node);
  if (
    !right ||
    right.scan.table.kind !== "table" ||
    right.scan.table.defaultCollation !== "BINARY"
  )
    return undefined;
  const pairs = factLocalEqualityPairs(
    join.condition,
    join.left.scope,
    join.right.scope,
  );
  if (!pairs || pairs.length < 2) return undefined;

  const leftIndexes = new Set<number>();
  const rightIndexes = new Set<number>();
  const pairsByScanIndex = new Map<
    number,
    { readonly left: number; readonly right: number }
  >();
  for (const pair of pairs) {
    if (
      pair.left < 0 ||
      pair.left >= join.left.fields.length ||
      pair.right < 0 ||
      pair.right >= right.scanIndexes.length ||
      leftIndexes.has(pair.left) ||
      rightIndexes.has(pair.right)
    )
      return undefined;
    leftIndexes.add(pair.left);
    rightIndexes.add(pair.right);
    const scanIndex = right.scanIndexes[pair.right]!;
    if (pairsByScanIndex.has(scanIndex)) return undefined;
    const leftField = join.left.fields[pair.left]!;
    const rightField = join.right.fields[pair.right]!;
    const leftColumn = resolvePassedThroughColumn(join.left.node, pair.left);
    const rightColumn = directSchemaColumn(
      right.scan,
      scanIndex,
      right.scan.fields[scanIndex]!,
    );
    if (
      leftField.affinity === "unknown" ||
      leftField.affinity !== rightField.affinity ||
      !leftColumn ||
      !rightColumn ||
      leftColumn.column.affinity !== leftField.affinity ||
      rightColumn.column.affinity !== rightField.affinity
    )
      return undefined;
    pairsByScanIndex.set(scanIndex, pair);
  }

  const schemaColumns = Object.values(right.scan.table.columns);
  const indexes = [...right.scan.table.indexes]
    .filter(
      (index) =>
        index.partial === false &&
        index.rawExpressionSql === undefined &&
        index.columns.length >= 2 &&
        index.columns.every(
          (name): name is string => typeof name === "string",
        ) &&
        index.collations !== undefined &&
        index.collations.length === index.columns.length &&
        new Set(index.columns.map(foldSqlIdentifierAscii)).size ===
          index.columns.length,
    )
    .map((index) => {
      const keyColumns: {
        name: string;
        leftIndex: number;
        rightIndex: number;
      }[] = [];
      for (let keyIndex = 0; keyIndex < index.columns.length; keyIndex++) {
        const name = index.columns[keyIndex]!;
        const schemaIndex = schemaColumns.findIndex((column) =>
          sameSqlIdentifier(column.sqlName, name),
        );
        const pair = pairsByScanIndex.get(schemaIndex);
        const column = schemaColumns[schemaIndex];
        if (
          schemaIndex < 0 ||
          !pair ||
          !column ||
          column.generated ||
          column.hidden !== 0 ||
          index.collations?.[keyIndex] !== "BINARY"
        )
          break;
        keyColumns.push({
          name,
          leftIndex: pair.left,
          rightIndex: pair.right,
        });
      }
      return { index, keyColumns };
    })
    .filter(({ keyColumns }) => keyColumns.length >= 2)
    .sort(
      (left, rightCandidate) =>
        rightCandidate.keyColumns.length - left.keyColumns.length ||
        (left.index.name < rightCandidate.index.name
          ? -1
          : left.index.name > rightCandidate.index.name
            ? 1
            : 0),
    );
  const selected = indexes[0];
  return selected
    ? {
        kind: "fact-local-indexed",
        join,
        driver: "left",
        owner,
        tableName: right.scan.table.name,
        indexName: selected.index.name,
        keyColumns: selected.keyColumns,
      }
    : undefined;
}

function nodeContains(
  root: LogicalQueryNode,
  target: LogicalQueryNode,
): boolean {
  const visited = new Set<LogicalQueryNode>();
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node === target) return true;
    if (visited.has(node)) continue;
    visited.add(node);
    pending.push(...nodeChildren(node).map(({ node: child }) => child));
  }
  return false;
}

function joinOrderStrategies(
  root: LogicalQueryNode,
  sharedDefinitions: readonly SharedRelationDefinition[],
  boundedFactLocal: ReadonlyMap<
    LogicalQueryNode,
    BoundedFactLocalReuseEvidence
  >,
): readonly PhysicalJoinOrderStrategy[] {
  const analysis = analyzeSharedRelations(root);
  const shared = new Map(
    sharedDefinitions.map((definition) => [definition.node, definition]),
  );
  const nodes: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of nodeChildren(node)) visit(child.node);
    nodes.push(node);
  };
  visit(root);
  const anchors = nodes.filter(
    (node): node is JoinNode =>
      node.kind === "join" &&
      isMaterializedKeyedAggregate(node, shared, analysis),
  );
  const strategies: PhysicalJoinOrderStrategy[] = anchors.map((join) => ({
    kind: "right-anchor",
    join,
    driver: "right",
  }));
  const lookupJoins = new Set<JoinNode>();
  for (const anchor of anchors) {
    const descend = (node: LogicalQueryNode): void => {
      if (node.kind === "join") {
        if (node.joinType === "inner") {
          const lookup = singleValueUniqueLookup(node.right);
          if (
            lookup &&
            rightUniqueJoinKey(node) !== undefined &&
            isClosedOrdinarySubtree(node.left.node) &&
            !nodeHasParameters(node.left.node)
          )
            lookupJoins.add(node);
        }
        descend(node.left.node);
        if (node.joinType === "inner") descend(node.right.node);
        return;
      }
      for (const child of nodeChildren(node)) descend(child.node);
    };
    descend(anchor.left.node);
  }
  for (const join of lookupJoins)
    strategies.push({
      kind: "unique-lookup",
      join,
      driver: "right",
      uniqueKey: singleValueUniqueLookup(join.right)!.uniqueKey,
    });

  for (const [candidate, evidence] of boundedFactLocal) {
    if (
      evidence.candidateKind !== "carrier" ||
      !nodeContains(evidence.owner, candidate)
    )
      continue;
    for (const join of nodes) {
      if (
        join.kind !== "join" ||
        join.left.node !== candidate ||
        strategies.some((strategy) => strategy.join === join)
      )
        continue;
      const indexed = factLocalIndexedStrategy(join, evidence.owner, shared);
      if (indexed) strategies.push(indexed);
    }
  }
  return strategies;
}

function expressionHasBoundParameters(expression: SqlExpression): boolean {
  switch (expression.kind) {
    case "parameter":
      return true;
    case "column":
    case "constant":
      return false;
    case "binary":
      return (
        expressionHasBoundParameters(expression.left) ||
        expressionHasBoundParameters(expression.right)
      );
    case "boolean":
      return (
        expression.operator !== "AND" ||
        expression.expressions.some(expressionHasBoundParameters)
      );
    case "null-check":
      return expression.expression.kind !== "column";
    case "in-list":
      return (
        expression.values.length > 0 ||
        expressionHasBoundParameters(expression.expression)
      );
    default:
      return true;
  }
}

function nodeHasParameters(
  root: LogicalQueryNode,
  visited = new Set<LogicalQueryNode>(),
): boolean {
  if (visited.has(root)) return false;
  visited.add(root);
  if (nodeExpressions(root).some(expressionHasBoundParameters)) return true;
  return nodeChildren(root).some((child) =>
    nodeHasParameters(child.node, visited),
  );
}

function sameJoinOrderStrategies(
  actual: readonly PhysicalJoinOrderStrategy[],
  expected: readonly PhysicalJoinOrderStrategy[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((strategy, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        strategy.kind === canonical.kind &&
        strategy.join === canonical.join &&
        strategy.driver === canonical.driver &&
        (strategy.kind === "fact-local-indexed" &&
        canonical.kind === "fact-local-indexed"
          ? strategy.owner === canonical.owner &&
            strategy.tableName === canonical.tableName &&
            strategy.indexName === canonical.indexName &&
            strategy.keyColumns.length === canonical.keyColumns.length &&
            strategy.keyColumns.every(
              (key, keyIndex) =>
                key.name === canonical.keyColumns[keyIndex]?.name &&
                key.leftIndex === canonical.keyColumns[keyIndex]?.leftIndex &&
                key.rightIndex === canonical.keyColumns[keyIndex]?.rightIndex,
            )
          : strategy.kind !== "fact-local-indexed" &&
            canonical.kind !== "fact-local-indexed" &&
            strategy.uniqueKey === canonical.uniqueKey)
      );
    })
  );
}

interface HoistEligibility {
  readonly forbidden: Set<LogicalQueryNode>;
  readonly windowInput: Set<LogicalQueryNode>;
}

interface TerminalAggregateRanking {
  readonly sort: LogicalQueryNode & { readonly kind: "sort" };
  readonly limit?: LogicalQueryNode & { readonly kind: "limit" };
}

function isPureLocalColumnProject(
  node: LogicalQueryNode,
): node is LogicalQueryNode & { readonly kind: "project" } {
  return (
    node.kind === "project" &&
    node.projections.length > 0 &&
    node.projections.every(
      ({ expression }) =>
        expression.kind === "column" &&
        expression.scope === node.input.scope &&
        Number.isInteger(expression.index) &&
        expression.index >= 0 &&
        expression.index < node.input.fields.length,
    )
  );
}

function terminalOutputSort(
  root: LogicalQueryNode,
): LogicalQueryNode | undefined {
  if (root.kind === "sort") return root;
  let source: LogicalQueryNode = root;
  const wrappers = new Set<LogicalQueryNode>();
  while (isPureLocalColumnProject(source)) {
    if (wrappers.has(source)) return undefined;
    wrappers.add(source);
    source = source.input.node;
  }
  return source.kind === "sort" &&
    source.input.node.kind === "union" &&
    source.input.node.all
    ? source
    : undefined;
}

function isAggregateRankingInput(root: LogicalQueryNode): boolean {
  const memo = new Map<LogicalQueryNode, boolean>();
  const active = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): boolean => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    if (active.has(node)) return false;
    active.add(node);
    let result: boolean;
    switch (node.kind) {
      case "aggregate":
        result = true;
        break;
      case "project":
      case "filter":
        result =
          nodeExpressions(node).every(
            (expression) => expressionSources(expression).length === 0,
          ) && visit(node.input.node);
        break;
      case "window":
        result =
          node.windows.length === 1 &&
          node.windows.every(
            ({ specification }) =>
              specification.kind === "row-number" &&
              specification.partitionBy.length === 0 &&
              specification.orderBy.length > 0 &&
              specification.orderBy.every(
                ({ direction }) => direction === "ASC" || direction === "DESC",
              ),
          ) &&
          nodeExpressions(node).every(
            (expression) => expressionSources(expression).length === 0,
          ) &&
          visit(node.input.node);
        break;
      case "join":
        result =
          (node.joinType === "inner" || node.joinType === "left") &&
          nodeExpressions(node).every(
            (expression) => expressionSources(expression).length === 0,
          ) &&
          visit(node.left.node) &&
          visit(node.right.node);
        break;
      case "scan":
      case "values-relation":
      case "json-scalar-array":
      case "semi-join":
      case "anti-join":
      case "distinct":
      case "sort":
      case "limit":
      case "union":
      case "recursive-closure":
        result = false;
        break;
    }
    active.delete(node);
    memo.set(node, result);
    return result;
  };
  return visit(root);
}

function terminalAggregateRanking(
  root: LogicalQueryNode,
): TerminalAggregateRanking | undefined {
  let source = root;
  const wrappers = new Set<LogicalQueryNode>();
  while (isPureLocalColumnProject(source)) {
    if (wrappers.has(source)) return undefined;
    wrappers.add(source);
    source = source.input.node;
  }

  let sort: LogicalQueryNode & { readonly kind: "sort" };
  let limit: (LogicalQueryNode & { readonly kind: "limit" }) | undefined;
  if (source.kind === "sort") sort = source;
  else if (
    source.kind === "limit" &&
    source.offset === undefined &&
    source.input.node.kind === "sort"
  ) {
    limit = source;
    sort = source.input.node;
  } else return undefined;

  return isAggregateRankingInput(sort.input.node) ||
    isTerminalAggregateRankingInput(sort.input.node)
    ? { sort, ...(limit ? { limit } : {}) }
    : undefined;
}

function isTerminalAggregateRankingInput(root: LogicalQueryNode): boolean {
  const visited = new Map<LogicalQueryNode, boolean>();
  const active = new Set<LogicalQueryNode>();
  let hasAggregate = false;
  let hasRankOne = false;

  const visit = (node: LogicalQueryNode): boolean => {
    const previous = visited.get(node);
    if (previous !== undefined) return previous;
    if (active.has(node)) return false;
    active.add(node);

    let accepted = false;
    if (node.kind === "aggregate") {
      const expressions = [
        ...node.groups.map(({ expression }) => expression),
        ...node.aggregates.map(({ expression }) => expression),
      ];
      accepted = expressions.every((expression) =>
        expressionFitsLocalFields(
          expression,
          node.input.scope,
          node.input.fields.length,
        ),
      );
      if (accepted) hasAggregate = true;
    } else if (node.kind === "filter" && isRankOneWindowFilter(node)) {
      accepted = true;
      hasRankOne = true;
    } else if (node.kind === "project") {
      accepted =
        node.projections.every(({ expression }) =>
          expressionFitsLocalFields(
            expression,
            node.input.scope,
            node.input.fields.length,
          ),
        ) && visit(node.input.node);
    } else if (node.kind === "filter") {
      accepted =
        expressionFitsLocalFields(
          node.predicate,
          node.input.scope,
          node.input.fields.length,
        ) && visit(node.input.node);
    } else if (
      node.kind === "join" &&
      (node.joinType === "inner" || node.joinType === "left")
    ) {
      const condition = inspectLocalStableExpression(
        node.condition,
        new Set([node.left.scope, node.right.scope]),
      );
      accepted =
        condition.valid &&
        condition.columns.every(({ scope, index }) =>
          scope === node.left.scope
            ? index < node.left.fields.length
            : index < node.right.fields.length,
        ) &&
        visit(node.left.node) &&
        visit(node.right.node);
    }

    active.delete(node);
    visited.set(node, accepted);
    return accepted;
  };

  return visit(root) && hasAggregate && hasRankOne;
}

function isRankOneWindowFilter(
  node: LogicalQueryNode & { readonly kind: "filter" },
): boolean {
  if (node.input.node.kind !== "window") return false;
  const windowNode = node.input.node;
  if (windowNode.windows.length !== 1) return false;
  const specification = windowNode.windows[0]!.specification;
  if (
    specification.kind !== "row-number" ||
    specification.partitionBy.length === 0 ||
    specification.orderBy.length === 0 ||
    !specification.partitionBy.every((expression) => {
      const index = directColumnIndex(expression, windowNode.input.scope);
      return (
        index !== undefined &&
        index >= 0 &&
        index < windowNode.input.fields.length
      );
    }) ||
    !specification.orderBy.every(
      ({ expression, direction }) =>
        (direction === "ASC" || direction === "DESC") &&
        expressionFitsLocalFields(
          expression,
          windowNode.input.scope,
          windowNode.input.fields.length,
        ),
    )
  )
    return false;

  const rankIndex = windowNode.input.fields.length;
  const predicate = node.predicate;
  if (predicate.kind !== "binary" || predicate.operator !== "=") return false;
  const isRankEqualsOne = (candidate: SqlExpression, value: SqlExpression) =>
    candidate.kind === "column" &&
    candidate.scope === node.input.scope &&
    candidate.index === rankIndex &&
    value.kind === "constant" &&
    value.value === 1;
  return (
    isRankEqualsOne(predicate.left, predicate.right) ||
    isRankEqualsOne(predicate.right, predicate.left)
  );
}

/** Keep selection-sensitive barriers while permitting proven ranking inputs. */
function hoistEligibility(root: LogicalQueryNode): HoistEligibility {
  const forbidden = new Set<LogicalQueryNode>();
  const windowInput = new Set<LogicalQueryNode>();
  const outputSort = terminalOutputSort(root);
  const rankingSorts = new Set<LogicalQueryNode>();
  const rankingLimits = new Set<LogicalQueryNode>();
  const rankingVisited = new Set<LogicalQueryNode>();
  const collectRanking = (node: LogicalQueryNode): void => {
    if (rankingVisited.has(node)) return;
    rankingVisited.add(node);
    const ranking = terminalAggregateRanking(node);
    if (ranking) {
      rankingSorts.add(ranking.sort);
      if (ranking.limit) rankingLimits.add(ranking.limit);
    }
    nodeChildren(node).forEach((child) => collectRanking(child.node));
  };
  collectRanking(root);
  const visited = new Map<LogicalQueryNode, Set<string>>();
  const visit = (
    node: LogicalQueryNode,
    inheritedForbidden: boolean,
    underWindow: boolean,
    branchOperandPath: boolean,
    topNSearchBlocked: boolean,
    licensedTopNSort: boolean,
  ): void => {
    let contexts = visited.get(node);
    if (!contexts) {
      contexts = new Set();
      visited.set(node, contexts);
    }
    const context = `${inheritedForbidden}:${underWindow}:${branchOperandPath}:${topNSearchBlocked}:${licensedTopNSort}`;
    if (contexts.has(context)) return;
    contexts.add(context);
    if (inheritedForbidden || node.kind === "window") forbidden.add(node);
    if (underWindow && !inheritedForbidden && node.kind !== "window")
      windowInput.add(node);

    const terminalRootSort = node === outputSort;
    const terminalAggregateRankingSort = rankingSorts.has(node);
    const terminalAggregateRankingLimit = rankingLimits.has(node);
    const branchTopN =
      branchOperandPath &&
      !topNSearchBlocked &&
      !inheritedForbidden &&
      node.kind === "limit" &&
      nodeChildren(node).some((child) => child.node.kind === "sort");
    const isLicensedTopNSort = node.kind === "sort" && licensedTopNSort;
    const selectionBoundary =
      inheritedForbidden ||
      (node.kind === "sort" &&
        !terminalRootSort &&
        !isLicensedTopNSort &&
        !terminalAggregateRankingSort) ||
      node.kind === "recursive-closure" ||
      (node.kind === "limit" && !branchTopN && !terminalAggregateRankingLimit);
    for (const child of nodeChildren(node)) {
      const startsUnionOperandPath =
        node.kind === "union" &&
        node.all &&
        !inheritedForbidden &&
        !topNSearchBlocked;
      const followsProjectOnUnionPath =
        node.kind === "project" && branchOperandPath;
      const isLicensedTopNSortInput = branchTopN && child.node.kind === "sort";
      const childBranchOperandPath =
        startsUnionOperandPath ||
        (followsProjectOnUnionPath && !topNSearchBlocked);
      const childTopNSearchBlocked =
        isLicensedTopNSort ||
        isLicensedTopNSortInput ||
        terminalAggregateRankingSort
          ? false
          : topNSearchBlocked ||
            (node.kind === "union" && !startsUnionOperandPath) ||
            (node.kind !== "project" &&
              node.kind !== "union" &&
              node.kind !== "scan" &&
              node.kind !== "values-relation" &&
              node.kind !== "json-scalar-array" &&
              !terminalRootSort);
      visit(
        child.node,
        selectionBoundary,
        underWindow || node.kind === "window",
        childBranchOperandPath,
        childTopNSearchBlocked,
        isLicensedTopNSortInput,
      );
    }
    for (const query of nodeExpressions(node).flatMap(expressionSources))
      visit(query.node, true, false, false, true, false);
  };
  visit(root, false, false, false, false, false);
  return { forbidden, windowInput };
}

type MaterializedBoundaryInterface = PhysicalSharedRelationBoundaryEvidence;

interface ConstantExistenceCorrelationContext {
  readonly outerScopes: ReadonlyMap<RelationScope, number>;
}

function exactNodeInputScopes(
  node: LogicalQueryNode,
  inheritedScopes: ReadonlyMap<RelationScope, number>,
): ReadonlyMap<RelationScope, number> | undefined {
  const fieldsByScope = new Map(inheritedScopes);
  for (const source of nodeChildren(node)) {
    const previous = fieldsByScope.get(source.scope);
    if (previous !== undefined && previous !== source.fields.length)
      return undefined;
    fieldsByScope.set(source.scope, source.fields.length);
  }
  return fieldsByScope;
}

function totalNodeWithVisibleScopes(
  node: LogicalQueryNode,
  inheritedScopes: ReadonlyMap<RelationScope, number>,
): boolean {
  if (
    isMaterializationSafeNode(node) ||
    isMaterializationSafePartitionedRowNumberWindow(node)
  )
    return true;
  const fieldsByScope = exactNodeInputScopes(node, inheritedScopes);
  if (!fieldsByScope) return false;
  if (node.kind === "filter")
    return isMaterializationSafeExpression(node.predicate, fieldsByScope);
  if (node.kind === "project")
    return node.projections.every(({ expression }) =>
      isMaterializationSafeExpression(expression, fieldsByScope),
    );
  return false;
}

function totalConstantExistenceBody(
  root: LogicalQueryNode,
  outerScopes: ReadonlyMap<RelationScope, number>,
  materializedBoundaries?: ReadonlyMap<
    LogicalQueryNode,
    MaterializedBoundaryInterface
  >,
): boolean {
  const active = new Set<LogicalQueryNode>();
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): boolean => {
    if (active.has(node)) return false;
    const boundary = materializedBoundaries?.get(node);
    if (boundary) {
      const { definition } = boundary;
      return (
        definition.materialization === "materialized" &&
        definition.node === node &&
        definition.scope === node.scope &&
        sameFields(definition.fields, node.fields) &&
        boundary.license.kind.length > 0
      );
    }
    if (visited.has(node)) return true;
    if (
      node.kind !== "scan" &&
      node.kind !== "values-relation" &&
      node.kind !== "project" &&
      node.kind !== "filter" &&
      node.kind !== "aggregate" &&
      node.kind !== "window"
    )
      return false;
    if (
      node.kind === "window" &&
      (node.windows.length === 0 ||
        node.windows.some(
          ({ specification }) => specification.kind !== "row-number",
        ))
    )
      return false;
    if (!totalNodeWithVisibleScopes(node, outerScopes)) return false;
    active.add(node);
    for (const source of nodeChildren(node)) {
      if (!visit(source.node)) return false;
    }
    active.delete(node);
    visited.add(node);
    return true;
  };
  return visit(root);
}

/**
 * Authorize only the existing `filter(input, scalar(SELECT 1) = 1)` shape.
 * The filter input is the sole external scope exposed to the query body.
 */
function constantExistenceCorrelationContext(
  node: LogicalQueryNode,
  materializedBoundaries?: ReadonlyMap<
    LogicalQueryNode,
    MaterializedBoundaryInterface
  >,
): ConstantExistenceCorrelationContext | undefined {
  if (node.kind !== "filter") return undefined;
  if (
    node.predicate.kind === "null-check" &&
    node.predicate.expression.kind === "scalar-subquery"
  ) {
    const outerScopes = correlatedConstantExistenceOuterScopes(
      node,
      nodeChildren,
      inspectLocalStableExpression,
    );
    return outerScopes ? { outerScopes } : undefined;
  }
  if (
    node.predicate.kind !== "binary" ||
    node.predicate.operator !== "=" ||
    node.predicate.left.kind !== "scalar-subquery" ||
    node.predicate.right.kind !== "constant" ||
    node.predicate.right.value !== 1
  )
    return undefined;
  const query = node.predicate.left.query;
  if (
    !isConstantExistenceQuery(query) ||
    query.scope !== query.node.scope ||
    !sameFields(query.fields, query.node.fields)
  )
    return undefined;
  const outerScopes = new Map<RelationScope, number>([
    [node.input.scope, node.input.fields.length],
  ]);
  return totalConstantExistenceBody(
    query.node,
    outerScopes,
    materializedBoundaries,
  )
    ? { outerScopes }
    : undefined;
}

function expressionColumnScopes(
  expression: SqlExpression,
  scopes: RelationScope[],
): void {
  switch (expression.kind) {
    case "binary":
    case "distinct-from":
      expressionColumnScopes(expression.left, scopes);
      expressionColumnScopes(expression.right, scopes);
      break;
    case "boolean":
      expression.expressions.forEach((child) =>
        expressionColumnScopes(child, scopes),
      );
      break;
    case "not":
    case "null-check":
    case "in-list":
    case "cast-integer":
    case "cast-real":
    case "cast-text":
      expressionColumnScopes(expression.expression, scopes);
      break;
    case "text-position":
      expressionColumnScopes(expression.text, scopes);
      expressionColumnScopes(expression.needle, scopes);
      break;
    case "text-substring":
      expressionColumnScopes(expression.text, scopes);
      expressionColumnScopes(expression.start, scopes);
      if (expression.length) expressionColumnScopes(expression.length, scopes);
      break;
    case "text-like":
      expressionColumnScopes(expression.text, scopes);
      expressionColumnScopes(expression.pattern, scopes);
      break;
    case "in-subquery":
      expressionColumnScopes(expression.expression, scopes);
      break;
    case "function":
      expression.arguments.forEach((argument) =>
        expressionColumnScopes(argument, scopes),
      );
      break;
    case "aggregate":
      if (expression.expression)
        expressionColumnScopes(expression.expression, scopes);
      break;
    case "coalesce":
      expression.expressions.forEach((child) =>
        expressionColumnScopes(child, scopes),
      );
      break;
    case "case":
      expression.branches.forEach((branch) => {
        expressionColumnScopes(branch.when, scopes);
        expressionColumnScopes(branch.then, scopes);
      });
      if (expression.else) expressionColumnScopes(expression.else, scopes);
      break;
    case "column":
      scopes.push(expression.scope);
      break;
    case "scalar-subquery":
    case "parameter":
    case "excluded":
    case "unixepoch":
    case "constant":
      break;
  }
}

function hasClosedWindowSubtreeScopes(
  root: LogicalQueryNode,
  closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>,
): boolean {
  const cached = closedWindowScopeMemo.get(root);
  if (cached !== undefined) return cached;

  const scopes = new Set<RelationScope>();
  const referencedScopes: RelationScope[] = [];
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  let cyclic = false;
  const visit = (node: LogicalQueryNode): void => {
    if (active.has(node)) {
      cyclic = true;
      return;
    }
    if (visited.has(node)) return;
    active.add(node);
    scopes.add(node.scope);
    nodeExpressions(node).forEach((expression) =>
      expressionColumnScopes(expression, referencedScopes),
    );
    nodeSources(node).forEach((source) => visit(source.node));
    active.delete(node);
    visited.add(node);
  };
  visit(root);

  const closed =
    !cyclic && referencedScopes.every((scope) => scopes.has(scope));
  closedWindowScopeMemo.set(root, closed);
  return closed;
}

function candidateFacts(
  root: LogicalQueryNode,
  closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>,
  materializedBoundaries?: ReadonlyMap<
    LogicalQueryNode,
    MaterializedBoundaryInterface
  >,
  requireTotalExpressions = false,
  allowRankOnePartitionedRowNumberProof = false,
  isSafeProvenPartitionedRowNumberWindow = isMaterializationSafeProvenPartitionedRowNumberWindow,
): CandidateFacts {
  const facts: CandidateFacts = {
    scopes: new Set(),
    referencedScopes: [],
    referencedColumns: [],
    materializedBoundariesUsed: new Set(),
    selective: false,
    forbidden: false,
    unsafe: false,
    materializedBoundary: false,
    limitBarrier: false,
    sortBarrier: false,
    rowNumberWindow: false,
    ordinaryRowNumberWindow: false,
  };
  const visited = new Map<
    LogicalQueryNode,
    Map<
      boolean,
      Map<ConstantExistenceCorrelationContext | undefined, Set<boolean>>
    >
  >();
  const visit = (
    node: LogicalQueryNode,
    querySourcePath: boolean,
    constantExistencePath: boolean,
    correlationContext?: ConstantExistenceCorrelationContext,
  ): void => {
    let querySourceContexts = visited.get(node);
    if (!querySourceContexts) {
      querySourceContexts = new Map();
      visited.set(node, querySourceContexts);
    }
    let correlationContexts = querySourceContexts.get(querySourcePath);
    if (!correlationContexts) {
      correlationContexts = new Map();
      querySourceContexts.set(querySourcePath, correlationContexts);
    }
    let constantExistenceContexts = correlationContexts.get(correlationContext);
    if (!constantExistenceContexts) {
      constantExistenceContexts = new Set();
      correlationContexts.set(correlationContext, constantExistenceContexts);
    }
    if (constantExistenceContexts.has(constantExistencePath)) return;
    constantExistenceContexts.add(constantExistencePath);
    facts.scopes.add(node.scope);
    if (node !== root) {
      const boundary = materializedBoundaries?.get(node);
      if (boundary) {
        const definition = boundary.definition;
        if (
          definition.node !== node ||
          definition.scope !== node.scope ||
          !sameFields(definition.fields, node.fields)
        ) {
          facts.forbidden = true;
          facts.unsafe = true;
        }
        facts.selective ||= boundary.selective;
        facts.materializedBoundary = true;
        facts.materializedBoundariesUsed.add(node);
        return;
      }
    }
    const localConstantExistenceContext =
      !querySourcePath && !constantExistencePath
        ? constantExistenceCorrelationContext(node, materializedBoundaries)
        : undefined;
    const isTotal =
      isMaterializationSafeNode(node) ||
      (requireTotalExpressions &&
        allowRankOnePartitionedRowNumberProof &&
        isSafeProvenPartitionedRowNumberWindow(node)) ||
      (querySourcePath &&
        constantExistencePath &&
        correlationContext !== undefined &&
        totalNodeWithVisibleScopes(node, correlationContext.outerScopes)) ||
      localConstantExistenceContext !== undefined;
    if (requireTotalExpressions && !isTotal) {
      facts.unsafe = true;
      return;
    }
    if (
      node.kind === "filter" ||
      node.kind === "semi-join" ||
      node.kind === "anti-join"
    )
      facts.selective = true;
    if (node.kind === "sort") {
      facts.forbidden = true;
      facts.sortBarrier = true;
    }
    if (node.kind === "limit") {
      facts.forbidden = true;
      facts.limitBarrier = true;
    }
    if (node.kind === "recursive-closure") facts.forbidden = true;
    if (node.kind === "recursive-closure") facts.unsafe = true;
    if (node.kind === "window") {
      const onlyRowNumberWindows =
        node.windows.length > 0 &&
        node.windows.every(
          ({ specification }) => specification.kind === "row-number",
        );
      const allowedQueryContext =
        !querySourcePath ||
        (constantExistencePath &&
          hasClosedWindowSubtreeScopes(node, closedWindowScopeMemo));
      if (onlyRowNumberWindows && allowedQueryContext) {
        facts.rowNumberWindow = true;
        if (!querySourcePath) facts.ordinaryRowNumberWindow = true;
      } else {
        facts.forbidden = true;
        facts.unsafe = true;
      }
    }
    for (const expression of nodeExpressions(node)) {
      const inspect = (current: SqlExpression): void => {
        if (current.kind === "column") {
          facts.referencedScopes.push(current.scope);
          facts.referencedColumns.push({
            scope: current.scope,
            index: current.index,
          });
        }
        if (
          current.kind === "unixepoch" ||
          current.kind === "in-subquery" ||
          (current.kind === "scalar-subquery" &&
            (!isConstantExistenceQuery(current.query) || querySourcePath))
        ) {
          facts.forbidden = true;
          facts.unsafe = true;
        }
        switch (current.kind) {
          case "binary":
          case "distinct-from":
            inspect(current.left);
            inspect(current.right);
            break;
          case "boolean":
            current.expressions.forEach(inspect);
            break;
          case "not":
          case "null-check":
          case "in-list":
            inspect(current.expression);
            break;
          case "cast-text":
            inspect(current.expression);
            break;
          case "text-position":
            inspect(current.text);
            inspect(current.needle);
            break;
          case "text-substring":
            inspect(current.text);
            inspect(current.start);
            if (current.length) inspect(current.length);
            break;
          case "text-like":
            inspect(current.text);
            inspect(current.pattern);
            break;
          case "cast-integer":
          case "cast-real":
            inspect(current.expression);
            break;
          case "in-subquery":
            inspect(current.expression);
            break;
          case "function":
            current.arguments.forEach(inspect);
            break;
          case "aggregate":
            if (current.expression) inspect(current.expression);
            break;
          case "coalesce":
            current.expressions.forEach(inspect);
            break;
          case "case":
            current.branches.forEach((branch) => {
              inspect(branch.when);
              inspect(branch.then);
            });
            if (current.else) inspect(current.else);
            break;
          case "column":
          case "parameter":
          case "excluded":
          case "unixepoch":
          case "scalar-subquery":
          case "constant":
            break;
        }
      };
      inspect(expression);
    }
    nodeChildren(node).forEach((source) =>
      visit(
        source.node,
        querySourcePath,
        constantExistencePath,
        correlationContext,
      ),
    );
    for (const expression of nodeExpressions(node))
      visitExpressionQuerySources(expression, (source, sourceKind) => {
        const entersConstantExistencePath =
          !querySourcePath &&
          sourceKind === "scalar-subquery" &&
          isConstantExistenceQuery(source);
        visit(
          source.node,
          true,
          entersConstantExistencePath,
          entersConstantExistencePath
            ? localConstantExistenceContext
            : correlationContext,
        );
      });
  };
  visit(root, false, false);
  return facts;
}

function candidateFactsAreClosed(
  facts: CandidateFacts,
  materializedBoundaries?: ReadonlyMap<
    LogicalQueryNode,
    MaterializedBoundaryInterface
  >,
): boolean {
  if (!facts.referencedScopes.every((scope) => facts.scopes.has(scope)))
    return false;
  if (!materializedBoundaries) return true;
  const exportedFieldCounts = new Map<RelationScope, number>(
    [...materializedBoundaries.values()].map(({ definition }) => [
      definition.scope,
      definition.fields.length,
    ]),
  );
  return facts.referencedColumns.every(({ scope, index }) => {
    const exportedFieldCount = exportedFieldCounts.get(scope);
    return (
      exportedFieldCount === undefined ||
      (Number.isInteger(index) && index >= 0 && index < exportedFieldCount)
    );
  });
}

function wideRankOneBoundaryUsesExistingLicense(
  node: LogicalQueryNode,
  facts: CandidateFacts,
  materializedBoundaries: ReadonlyMap<
    LogicalQueryNode,
    MaterializedBoundaryInterface
  >,
): boolean {
  const usedBoundaries = [...materializedBoundaries.values()].filter(
    ({ definition }) =>
      definition.node !== node && facts.scopes.has(definition.scope),
  );
  // Keep established wide rank-one licenses; new opaque licenses stay narrow.
  return (
    usedBoundaries.length > 0 &&
    usedBoundaries.every(
      ({ license }) =>
        license.kind === "rank-one-project" ||
        license.kind === "bounded-summary-derived" ||
        license.kind === "strict-generic-facts",
    )
  );
}

interface IncomingConsumer {
  readonly parent: LogicalQueryNode;
  readonly kind: "relation" | "expression";
}

function incomingConsumers(
  nodes: readonly LogicalQueryNode[],
): Map<LogicalQueryNode, IncomingConsumer[]> {
  const incoming = new Map<LogicalQueryNode, IncomingConsumer[]>();
  const add = (
    child: LogicalQueryNode,
    parent: LogicalQueryNode,
    kind: IncomingConsumer["kind"],
  ): void => {
    incoming.set(child, [...(incoming.get(child) ?? []), { parent, kind }]);
  };
  for (const parent of nodes) {
    for (const child of nodeChildren(parent))
      add(child.node, parent, "relation");
    for (const expression of nodeExpressions(parent))
      for (const child of expressionSources(expression))
        add(child.node, parent, "expression");
  }
  return incoming;
}

function inspectLocalStableExpression(
  expression: SqlExpression,
  allowedScopes: ReadonlySet<RelationScope>,
): {
  readonly valid: boolean;
  readonly columns: readonly {
    readonly scope: RelationScope;
    readonly index: number;
    readonly name: string;
  }[];
} {
  const columns: { scope: RelationScope; index: number; name: string }[] = [];
  let valid = expressionSources(expression).length === 0;
  const seen = new WeakSet<object>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    if (
      record.kind === "unixepoch" ||
      record.kind === "scalar-subquery" ||
      record.kind === "in-subquery"
    ) {
      valid = false;
      return;
    }
    if (record.kind === "column") {
      const scope = record.scope as RelationScope;
      const index = record.index;
      if (
        !allowedScopes.has(scope) ||
        !Number.isInteger(index) ||
        Number(index) < 0 ||
        typeof record.name !== "string"
      )
        valid = false;
      else
        columns.push({
          scope,
          index: Number(index),
          name: record.name,
        });
      return;
    }
    for (const [key, child] of Object.entries(record))
      if (key !== "scope" && key !== "query") visit(child);
  };
  visit(expression);
  return { valid, columns };
}

function expressionFitsLocalFields(
  expression: SqlExpression,
  scope: RelationScope,
  fieldCount: number,
): boolean {
  const inspected = inspectLocalStableExpression(expression, new Set([scope]));
  return (
    inspected.valid &&
    inspected.columns.every(({ index }) => index < fieldCount)
  );
}
function expressionQueryEdgeSubtrees(
  nodes: readonly LogicalQueryNode[],
  materializedBoundaries: ReadonlySet<LogicalQueryNode> = new Set(),
): ReadonlySet<LogicalQueryNode> {
  const affected = new Set<LogicalQueryNode>();
  const propagated = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    const hasExpressionQuery =
      nodeExpressions(node).some(
        (expression) => expressionSources(expression).length > 0,
      ) || nodeChildren(node).some((child) => propagated.has(child.node));
    if (!hasExpressionQuery) continue;
    affected.add(node);
    if (!materializedBoundaries.has(node)) propagated.add(node);
  }
  return affected;
}

function isStableRelationConsumer(
  parent: LogicalQueryNode,
  child: LogicalQueryNode,
): boolean {
  if (parent.kind === "project" && parent.input.node === child)
    return parent.projections.every(({ expression }) =>
      expressionFitsLocalFields(
        expression,
        parent.input.scope,
        parent.input.fields.length,
      ),
    );
  if (parent.kind === "filter" && parent.input.node === child)
    return expressionFitsLocalFields(
      parent.predicate,
      parent.input.scope,
      parent.input.fields.length,
    );
  if (parent.kind === "aggregate" && parent.input.node === child)
    return [
      ...parent.groups.map(({ expression }) => expression),
      ...parent.aggregates.map(({ expression }) => expression),
    ].every((expression) =>
      expressionFitsLocalFields(
        expression,
        parent.input.scope,
        parent.input.fields.length,
      ),
    );
  if (parent.kind === "window" && parent.input.node === child)
    return (
      parent.windows.length > 0 &&
      parent.windows.every(({ specification }) => {
        if (specification.kind !== "row-number") return false;
        return (
          specification.partitionBy.every((expression) =>
            expressionFitsLocalFields(
              expression,
              parent.input.scope,
              parent.input.fields.length,
            ),
          ) &&
          specification.orderBy.every(
            ({ expression, direction }) =>
              (direction === "ASC" || direction === "DESC") &&
              expressionFitsLocalFields(
                expression,
                parent.input.scope,
                parent.input.fields.length,
              ),
          )
        );
      })
    );
  if (
    parent.kind === "join" &&
    (parent.joinType === "inner" || parent.joinType === "left") &&
    (parent.left.node === child || parent.right.node === child)
  ) {
    const condition = inspectLocalStableExpression(
      parent.condition,
      new Set([parent.left.scope, parent.right.scope]),
    );
    return (
      condition.valid &&
      condition.columns.every(({ scope, index }) =>
        scope === parent.left.scope
          ? index < parent.left.fields.length
          : index < parent.right.fields.length,
      )
    );
  }
  return false;
}

function isStableMaterializedBoundaryConsumer(
  parent: LogicalQueryNode,
  child: LogicalQueryNode,
): boolean {
  if (parent.kind === "window" && parent.input.node === child) {
    const fieldsByScope = new Map([
      [parent.input.scope, parent.input.fields.length],
    ]);
    return (
      parent.windows.length > 0 &&
      parent.windows.every(
        ({ specification }) =>
          specification.kind === "row-number" &&
          specification.partitionBy.every((expression) =>
            isMaterializationSafeExpression(expression, fieldsByScope),
          ) &&
          specification.orderBy.every(
            ({ expression, direction }) =>
              (direction === "ASC" || direction === "DESC") &&
              isMaterializationSafeExpression(expression, fieldsByScope),
          ),
      )
    );
  }
  if (
    parent.kind === "join" &&
    (parent.left.node === child || parent.right.node === child)
  )
    return (
      (parent.joinType === "inner" || parent.joinType === "left") &&
      isMaterializationSafeNode(parent)
    );
  return (
    (parent.kind === "project" ||
      parent.kind === "filter" ||
      parent.kind === "aggregate") &&
    parent.input.node === child &&
    isMaterializationSafeNode(parent)
  );
}
function isPureProjectConsumer(node: LogicalQueryNode): node is ProjectNode {
  return (
    isPureLocalColumnProject(node) &&
    node.projections.every(
      ({ expression }) => expressionSources(expression).length === 0,
    )
  );
}

function isLocalStableProjectConsumer(
  node: LogicalQueryNode,
): node is ProjectNode {
  return (
    node.kind === "project" &&
    node.projections.every(
      ({ expression }) =>
        inspectLocalStableExpression(expression, new Set([node.input.scope]))
          .valid,
    )
  );
}

function terminalBagUnion(
  root: LogicalQueryNode,
): Extract<LogicalQueryNode, { readonly kind: "union" }> | undefined {
  const visited = new Set<LogicalQueryNode>();
  let current = root;
  while (isPureProjectConsumer(current)) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    current = current.input.node;
  }
  if (current.kind !== "limit" || current.offset !== undefined)
    return undefined;
  const sortNode = current.input.node;
  if (sortNode.kind !== "sort") return undefined;
  const sortInputScope = new Set([sortNode.input.scope]);
  if (
    !sortNode.keys.every(
      ({ expression }) =>
        inspectLocalStableExpression(expression, sortInputScope).valid,
    )
  )
    return undefined;

  current = sortNode.input.node;
  let sawCursorFilter = false;
  visited.clear();
  while (true) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    if (isPureProjectConsumer(current)) {
      current = current.input.node;
      continue;
    }
    if (current.kind === "filter" && !sawCursorFilter) {
      const filterInputScope = new Set([current.input.scope]);
      if (
        !inspectLocalStableExpression(current.predicate, filterInputScope).valid
      )
        return undefined;
      sawCursorFilter = true;
      current = current.input.node;
      continue;
    }
    return current.kind === "union" && current.all ? current : undefined;
  }
}

function relationChildIndex(
  parent: LogicalQueryNode,
  child: LogicalQueryNode,
): 0 | 1 | undefined {
  if (parent.kind === "union") {
    if (parent.left.node === child) return 0;
    if (parent.right.node === child) return 1;
  }
  return undefined;
}

function projectPathToUnionBranch(
  child: LogicalQueryNode,
  consumer: LogicalQueryNode,
  unionNode: Extract<LogicalQueryNode, { readonly kind: "union" }>,
  incoming: ReadonlyMap<LogicalQueryNode, readonly IncomingConsumer[]>,
): 0 | 1 | undefined {
  if (!isLocalStableProjectConsumer(consumer) || consumer.input.node !== child)
    return undefined;
  const visited = new Set<LogicalQueryNode>();
  let current: LogicalQueryNode = consumer;
  while (!visited.has(current)) {
    visited.add(current);
    const incomingEdges: readonly IncomingConsumer[] =
      incoming.get(current) ?? [];
    if (incomingEdges.length !== 1 || incomingEdges[0]!.kind !== "relation")
      return undefined;
    const parent: LogicalQueryNode = incomingEdges[0]!.parent;
    if (parent === unionNode) return relationChildIndex(parent, current);
    if (!isLocalStableProjectConsumer(parent) || parent.input.node !== current)
      return undefined;
    current = parent;
  }
  return undefined;
}

function membershipOutputBranch(
  semiJoin: LogicalQueryNode,
  unionNode: Extract<LogicalQueryNode, { readonly kind: "union" }>,
  incoming: ReadonlyMap<LogicalQueryNode, readonly IncomingConsumer[]>,
): 0 | 1 | undefined {
  if (semiJoin.kind !== "semi-join") return undefined;
  const parents = incoming.get(semiJoin) ?? [];
  if (parents.length !== 1 || parents[0]!.kind !== "relation") return undefined;
  return projectPathToUnionBranch(
    semiJoin,
    parents[0]!.parent,
    unionNode,
    incoming,
  );
}

function isTerminalBagMembershipCandidate(
  node: LogicalQueryNode,
  unionNode: Extract<LogicalQueryNode, { readonly kind: "union" }>,
  incoming: ReadonlyMap<LogicalQueryNode, readonly IncomingConsumer[]>,
): node is ProjectNode {
  if (
    node.kind !== "project" ||
    !isPureProjectConsumer(node) ||
    node.fields.length === 0 ||
    node.fields.length > MAX_REPEATED_WINDOW_INPUT_PROJECT_FIELDS
  )
    return false;
  const consumers = incoming.get(node) ?? [];
  if (
    consumers.length !== 2 ||
    consumers.some(({ kind }) => kind !== "relation") ||
    consumers[0]!.parent === consumers[1]!.parent
  )
    return false;

  const directBranches = consumers.map(({ parent }) =>
    projectPathToUnionBranch(node, parent, unionNode, incoming),
  );
  for (let directIndex = 0; directIndex < consumers.length; directIndex += 1) {
    const directBranch = directBranches[directIndex];
    if (directBranch === undefined) continue;
    const keyConsumer = consumers[1 - directIndex]!.parent;
    if (
      !isPureProjectConsumer(keyConsumer) ||
      keyConsumer.input.node !== node ||
      keyConsumer.fields.length === 0 ||
      keyConsumer.fields.length > 4
    )
      continue;
    const keyParents = incoming.get(keyConsumer) ?? [];
    if (keyParents.length !== 1 || keyParents[0]!.kind !== "relation") continue;
    let membershipInput = keyConsumer as LogicalQueryNode;
    let membershipParents = keyParents;
    if (membershipParents[0]!.parent.kind === "distinct") {
      const distinct = membershipParents[0]!.parent;
      if (distinct.input.node !== membershipInput) continue;
      membershipInput = distinct;
      membershipParents = incoming.get(distinct) ?? [];
      if (
        membershipParents.length !== 1 ||
        membershipParents[0]!.kind !== "relation"
      )
        continue;
    }
    const semiJoin = membershipParents[0]!.parent;
    if (
      semiJoin.kind !== "semi-join" ||
      semiJoin.right.node !== membershipInput ||
      semiJoin.right.fields.length === 0 ||
      semiJoin.right.fields.length > 4
    )
      continue;
    const condition = inspectLocalStableExpression(
      semiJoin.condition,
      new Set([semiJoin.left.scope, semiJoin.right.scope]),
    );
    if (!condition.valid) continue;
    const rightIndexes = new Set(
      condition.columns
        .filter(({ scope }) => scope === semiJoin.right.scope)
        .map(({ index }) => index),
    );
    if (
      rightIndexes.size !== semiJoin.right.fields.length ||
      Array.from(
        { length: semiJoin.right.fields.length },
        (_unused, index) => index,
      ).some((index) => !rightIndexes.has(index))
    )
      continue;
    const membershipBranch = membershipOutputBranch(
      semiJoin,
      unionNode,
      incoming,
    );
    if (membershipBranch !== undefined && membershipBranch !== directBranch)
      return true;
  }
  return false;
}

function terminalBagMembershipCandidates(
  root: LogicalQueryNode,
  nodes: readonly LogicalQueryNode[],
  incoming: ReadonlyMap<LogicalQueryNode, readonly IncomingConsumer[]>,
  closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>,
): Set<LogicalQueryNode> {
  const unionNode = terminalBagUnion(root);
  if (!unionNode) return new Set();
  const candidates = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    if (
      !isTerminalBagMembershipCandidate(node, unionNode, incoming) ||
      incoming.get(node)?.length !== 2
    )
      continue;
    const facts = candidateFacts(node, closedWindowScopeMemo);
    if (
      facts.selective &&
      !facts.forbidden &&
      !facts.ordinaryRowNumberWindow &&
      facts.referencedScopes.every((scope) => facts.scopes.has(scope))
    )
      candidates.add(node);
  }
  return candidates;
}

/**
 * Select wide, pure local projections that fan out only to independent stable
 * Filters before multiple ordinary window inputs. The narrow shape keeps this
 * license separate from the existing width and reference-count thresholds.
 */
function sharedFilterFanoutCandidates(
  nodes: readonly LogicalQueryNode[],
  incomingCounts: ReadonlyMap<LogicalQueryNode, number>,
  incoming: ReadonlyMap<LogicalQueryNode, readonly IncomingConsumer[]>,
  hoist: HoistEligibility,
  repeatedWindowInputs: ReadonlySet<LogicalQueryNode>,
  closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>,
): Set<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    if (
      !isPureProjectConsumer(node) ||
      node.fields.length < MIN_REPEATED_WINDOW_INPUT_PROJECT_FIELDS ||
      node.fields.length > MAX_REPEATED_WINDOW_INPUT_PROJECT_FIELDS ||
      !hoist.windowInput.has(node) ||
      !repeatedWindowInputs.has(node)
    )
      continue;

    const consumers = incoming.get(node) ?? [];
    const distinctParents = new Set(consumers.map(({ parent }) => parent));
    if (
      consumers.length < 3 ||
      consumers.length !== (incomingCounts.get(node) ?? 0) ||
      distinctParents.size !== consumers.length ||
      consumers.some(
        ({ kind, parent }) =>
          kind !== "relation" ||
          parent.kind !== "filter" ||
          parent.input.node !== node ||
          !inspectLocalStableExpression(
            parent.predicate,
            new Set([parent.input.scope]),
          ).valid,
      )
    )
      continue;

    const facts = candidateFacts(node, closedWindowScopeMemo);
    if (
      facts.selective &&
      !facts.forbidden &&
      !facts.ordinaryRowNumberWindow &&
      facts.referencedScopes.every((scope) => facts.scopes.has(scope))
    )
      candidates.add(node);
  }
  return candidates;
}

function terminalRankOneSubtreeNodes(
  nodes: readonly LogicalQueryNode[],
): Set<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    const ranking = terminalAggregateRanking(node);
    if (
      !ranking ||
      isAggregateRankingInput(ranking.sort.input.node) ||
      !isTerminalAggregateRankingInput(ranking.sort.input.node)
    )
      continue;
    const visit = (current: LogicalQueryNode): void => {
      if (candidates.has(current)) return;
      candidates.add(current);
      nodeChildren(current).forEach((child) => visit(child.node));
    };
    visit(ranking.sort.input.node);
  }
  return candidates;
}

function sharedRankOneProjectCandidates(
  nodes: readonly LogicalQueryNode[],
  incomingCounts: ReadonlyMap<LogicalQueryNode, number>,
  incoming: ReadonlyMap<LogicalQueryNode, readonly IncomingConsumer[]>,
  hoist: HoistEligibility,
  repeatedWindowInputs: ReadonlySet<LogicalQueryNode>,
  rankingInputNodes: ReadonlySet<LogicalQueryNode>,
  expressionQueryEdgeNodes: ReadonlySet<LogicalQueryNode>,
  closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>,
  materializedBoundaries: ReadonlyMap<
    LogicalQueryNode,
    MaterializedBoundaryInterface
  >,
  isSafeProvenPartitionedRowNumberWindow: (node: LogicalQueryNode) => boolean,
): Set<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    if (
      !isPureProjectConsumer(node) ||
      node.fields.length < MIN_REPEATED_WINDOW_INPUT_PROJECT_FIELDS ||
      node.fields.length > MAX_REPEATED_WINDOW_INPUT_PROJECT_FIELDS ||
      !hoist.windowInput.has(node) ||
      !repeatedWindowInputs.has(node) ||
      !rankingInputNodes.has(node) ||
      expressionQueryEdgeNodes.has(node)
    )
      continue;
    const consumers = incoming.get(node) ?? [];
    if (
      consumers.length < 2 ||
      consumers.length !== (incomingCounts.get(node) ?? 0) ||
      consumers.some(
        ({ kind, parent }) =>
          kind !== "relation" || !isStableRelationConsumer(parent, node),
      )
    )
      continue;
    const initialFacts = candidateFacts(
      node,
      closedWindowScopeMemo,
      materializedBoundaries,
    );
    const consumesMaterializedBoundary = initialFacts.materializedBoundary;
    if (
      consumesMaterializedBoundary &&
      node.fields.length > MAX_MATERIALIZED_SHARED_RELATION_FIELDS &&
      !wideRankOneBoundaryUsesExistingLicense(
        node,
        initialFacts,
        materializedBoundaries,
      )
    )
      continue;
    const facts = consumesMaterializedBoundary
      ? candidateFacts(
          node,
          closedWindowScopeMemo,
          materializedBoundaries,
          true,
          true,
          isSafeProvenPartitionedRowNumberWindow,
        )
      : initialFacts;
    if (
      facts.selective &&
      !facts.forbidden &&
      (!consumesMaterializedBoundary ||
        (facts.materializedBoundary && !facts.unsafe)) &&
      candidateFactsAreClosed(facts, materializedBoundaries)
    )
      candidates.add(node);
  }
  return candidates;
}

function sharedRankOneFactFilterCandidates(
  nodes: readonly LogicalQueryNode[],
  incomingCounts: ReadonlyMap<LogicalQueryNode, number>,
  incoming: ReadonlyMap<LogicalQueryNode, readonly IncomingConsumer[]>,
  hoist: HoistEligibility,
  repeatedWindowInputs: ReadonlySet<LogicalQueryNode>,
  rankingInputNodes: ReadonlySet<LogicalQueryNode>,
  expressionQueryEdgeNodes: ReadonlySet<LogicalQueryNode>,
  closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>,
): Set<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of nodes) {
    if (
      node.kind !== "filter" ||
      node.fields.length < 5 ||
      node.fields.length > 16 ||
      !hoist.windowInput.has(node) ||
      !repeatedWindowInputs.has(node) ||
      !rankingInputNodes.has(node) ||
      expressionQueryEdgeNodes.has(node) ||
      !expressionFitsLocalFields(
        node.predicate,
        node.input.scope,
        node.input.fields.length,
      )
    )
      continue;
    const consumers = incoming.get(node) ?? [];
    if (
      consumers.length !== 2 ||
      consumers.length !== (incomingCounts.get(node) ?? 0) ||
      consumers.some(({ kind }) => kind !== "relation")
    )
      continue;
    const parents = consumers.map(({ parent }) => parent);
    const aggregateConsumer = parents.find(
      (parent) => parent.kind === "aggregate" && parent.input.node === node,
    );
    const projectConsumer = parents.find(
      (parent) => isPureProjectConsumer(parent) && parent.input.node === node,
    );
    if (
      !aggregateConsumer ||
      !projectConsumer ||
      !isStableRelationConsumer(aggregateConsumer, node)
    )
      continue;
    const facts = candidateFacts(node, closedWindowScopeMemo);
    if (
      facts.selective &&
      !facts.forbidden &&
      !facts.ordinaryRowNumberWindow &&
      facts.referencedScopes.every((scope) => facts.scopes.has(scope))
    )
      candidates.add(node);
  }
  return candidates;
}

function sameFields(
  left: readonly OutputField[],
  right: readonly OutputField[],
) {
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

interface SharedRelationAnalysis {
  readonly incoming: ReadonlyMap<LogicalQueryNode, number>;
  readonly postorder: readonly LogicalQueryNode[];
  readonly hoist: ReturnType<typeof hoistEligibility>;
  readonly repeatedWindowInputs: ReadonlySet<LogicalQueryNode>;
  readonly closedWindowScopeMemo: WeakMap<LogicalQueryNode, boolean>;
  readonly incomingEdges: ReturnType<typeof incomingConsumers>;
  readonly terminalBagCandidates: ReadonlySet<LogicalQueryNode>;
  readonly filterFanoutCandidates: ReadonlySet<LogicalQueryNode>;
  readonly ordinaryFilterFanoutCandidates: ReadonlySet<LogicalQueryNode>;
  readonly rankingInputNodes: ReadonlySet<LogicalQueryNode>;
  readonly expressionQueryEdgeNodes: ReadonlySet<LogicalQueryNode>;
  readonly boundedGroupSummaryCandidates: ReadonlySet<LogicalQueryNode>;
  readonly boundedSummaryDerivedCandidates: ReadonlySet<LogicalQueryNode>;
  readonly sharedMembershipInputCandidates: ReadonlySet<LogicalQueryNode>;
  readonly sharedScalarCountCandidates: ReadonlySet<LogicalQueryNode>;
  readonly boundedAdmissionCandidates: ReadonlyMap<
    LogicalQueryNode,
    BoundedAdmissionEvidence
  >;
  readonly boundedAdmissionCounterCandidates: ReadonlyMap<
    LogicalQueryNode,
    BoundedAdmissionEvidence
  >;
}

function analyzeSharedRelations(
  root: LogicalQueryNode,
): SharedRelationAnalysis {
  const incoming = new Map<LogicalQueryNode, number>([[root, 1]]);
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  const postorder: LogicalQueryNode[] = [];
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    if (active.has(node))
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Query plan contains a cycle",
      );
    active.add(node);
    for (const source of nodeSources(node)) {
      incoming.set(source.node, (incoming.get(source.node) ?? 0) + 1);
      visit(source.node);
    }
    active.delete(node);
    visited.add(node);
    postorder.push(node);
  };
  visit(root);
  const hoist = hoistEligibility(root);
  const repeatedWindowInputs = multiWindowInputs(root);
  const closedWindowScopeMemo = new WeakMap<LogicalQueryNode, boolean>();
  const incomingEdges = incomingConsumers(postorder);
  const boundedAdmissionCandidates = boundedAdmissionReuseCandidates({
    nodes: postorder,
    incomingCounts: incoming,
    incoming: incomingEdges,
    maximumFields: MAX_MATERIALIZED_SHARED_RELATION_FIELDS,
    inspectLocalStableExpression,
  });
  const boundedAdmissionCounterCandidates = new Map<
    LogicalQueryNode,
    BoundedAdmissionEvidence
  >(
    [...boundedAdmissionCandidates.values()].map((evidence) => [
      evidence.counter,
      evidence,
    ]),
  );
  const terminalBagCandidates = terminalBagMembershipCandidates(
    root,
    postorder,
    incomingEdges,
    closedWindowScopeMemo,
  );
  const filterFanoutCandidates = sharedFilterFanoutCandidates(
    postorder,
    incoming,
    incomingEdges,
    hoist,
    repeatedWindowInputs,
    closedWindowScopeMemo,
  );
  const expressionQueryEdgeNodes = expressionQueryEdgeSubtrees(postorder);
  const boundedGroupSummaryCandidates = boundedGroupSummaryReuseCandidates({
    nodes: postorder,
    incomingCounts: incoming,
    incoming: incomingEdges,
    forbiddenAncestors: hoist.forbidden,
    expressionQueryEdges: expressionQueryEdgeNodes,
    maximumFields: MAX_MATERIALIZED_SHARED_RELATION_FIELDS,
  });
  const boundedSummaryDerivedCandidates = boundedSummaryDerivedReuseCandidates({
    nodes: postorder,
    incomingCounts: incoming,
    incoming: incomingEdges,
    forbiddenAncestors: hoist.forbidden,
    expressionQueryEdges: expressionQueryEdgeNodes,
    boundedGroupSummaryCandidates,
    maximumFields: MAX_MATERIALIZED_SHARED_RELATION_FIELDS,
    minimumReferences: 2,
  });
  const sharedMembershipInputs = sharedMembershipInputReuseCandidates({
    nodes: postorder,
    incomingCounts: incoming,
    incoming: incomingEdges,
    forbiddenAncestors: hoist.forbidden,
    expressionQueryEdges: expressionQueryEdgeNodes,
    boundedGroupSummaryCandidates,
    minimumFields: MIN_REPEATED_WINDOW_INPUT_PROJECT_FIELDS,
    maximumFields: MAX_REPEATED_WINDOW_INPUT_PROJECT_FIELDS,
    minimumReferences: MIN_REPEATED_WINDOW_INPUT_PROJECT_REFERENCES,
  });
  const sharedScalarCounts = sharedScalarCountReuseCandidates({
    nodes: postorder,
    incomingCounts: incoming,
    incoming: incomingEdges,
    expressionQueryEdges: expressionQueryEdgeNodes,
    boundedGroupSummaryCandidates,
    minimumReferences: 2,
  });
  const ordinaryFilterFanoutCandidates = sharedOrdinaryFilterFanoutCandidates({
    nodes: postorder,
    incomingCounts: incoming,
    incoming: incomingEdges,
    forbidden: hoist.forbidden,
    expressionQueryEdgeNodes,
    minimumFields: MIN_REPEATED_WINDOW_INPUT_PROJECT_FIELDS,
    maximumFields: MAX_REPEATED_WINDOW_INPUT_PROJECT_FIELDS,
    minimumReferences: MIN_REPEATED_WINDOW_INPUT_PROJECT_REFERENCES,
    nodeChildren,
    inspect: inspectLocalStableExpression,
    isPureProjectConsumer,
  });
  return {
    incoming,
    postorder,
    hoist,
    repeatedWindowInputs,
    closedWindowScopeMemo,
    incomingEdges,
    terminalBagCandidates,
    filterFanoutCandidates,
    ordinaryFilterFanoutCandidates,
    rankingInputNodes: terminalRankOneSubtreeNodes(postorder),
    expressionQueryEdgeNodes,
    boundedGroupSummaryCandidates,
    boundedSummaryDerivedCandidates,
    sharedMembershipInputCandidates: sharedMembershipInputs,
    sharedScalarCountCandidates: sharedScalarCounts,
    boundedAdmissionCandidates,
    boundedAdmissionCounterCandidates,
  };
}

function isStableMaterializedBoundaryProject(
  node: LogicalQueryNode,
): node is ProjectNode {
  return (
    node.kind === "project" &&
    node.projections.length > 0 &&
    isMaterializationSafeNode(node)
  );
}
function sharedMaterializedBoundaryProjectCandidates(
  analysis: SharedRelationAnalysis,
  materializedBoundaries: ReadonlyMap<
    LogicalQueryNode,
    MaterializedBoundaryInterface
  >,
): Set<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of analysis.postorder) {
    if (
      !isStableMaterializedBoundaryProject(node) ||
      materializedBoundaries.has(node) ||
      node.fields.length < MIN_MATERIALIZED_BOUNDARY_PROJECT_FIELDS ||
      node.fields.length > MAX_MATERIALIZED_SHARED_RELATION_FIELDS ||
      (analysis.incoming.get(node) ?? 0) <
        MIN_MATERIALIZED_BOUNDARY_PROJECT_REFERENCES ||
      !analysis.hoist.windowInput.has(node) ||
      !analysis.repeatedWindowInputs.has(node) ||
      analysis.rankingInputNodes.has(node)
    )
      continue;
    const consumers = analysis.incomingEdges.get(node) ?? [];
    if (new Set(consumers.map(({ parent }) => parent)).size < 2) continue;
    if (
      consumers.length !== (analysis.incoming.get(node) ?? 0) ||
      consumers.some(
        ({ kind, parent }) =>
          kind !== "relation" ||
          !isStableMaterializedBoundaryConsumer(parent, node),
      )
    )
      continue;
    const facts = candidateFacts(
      node,
      analysis.closedWindowScopeMemo,
      materializedBoundaries,
      true,
    );
    if (
      facts.selective &&
      facts.materializedBoundary &&
      !facts.forbidden &&
      !facts.unsafe &&
      !facts.ordinaryRowNumberWindow &&
      candidateFactsAreClosed(facts, materializedBoundaries)
    )
      candidates.add(node);
  }
  return candidates;
}

function selectedMaterializedBoundaryLicenseSource(
  node: LogicalQueryNode,
  analysis: SharedRelationAnalysis,
  completeKeyedLookupCandidates: ReadonlySet<LogicalQueryNode>,
  rankOneProjectCandidates: ReadonlySet<LogicalQueryNode>,
  rankOneFactFilterCandidates: ReadonlySet<LogicalQueryNode>,
  facts: CandidateFacts,
): PhysicalSharedRelationLicenseKind | undefined {
  if (analysis.boundedGroupSummaryCandidates.has(node))
    return "bounded-group-summary";
  if (analysis.boundedSummaryDerivedCandidates.has(node))
    return "bounded-summary-derived";
  if (analysis.sharedMembershipInputCandidates.has(node))
    return "shared-membership-input";
  if (analysis.sharedScalarCountCandidates.has(node))
    return "shared-scalar-count";
  if (analysis.boundedAdmissionCandidates.has(node)) return "bounded-admission";
  if (analysis.boundedAdmissionCounterCandidates.has(node))
    return "bounded-admission-counter";
  if (completeKeyedLookupCandidates.has(node)) return "complete-keyed-lookup";
  if (rankOneProjectCandidates.has(node)) return "rank-one-project";
  if (rankOneFactFilterCandidates.has(node)) return "rank-one-fact-filter";
  if (facts.selective && !facts.forbidden) return "strict-generic-facts";
  return undefined;
}

function sharedRelationDefinitionsForCandidates(
  analysis: SharedRelationAnalysis,
  rankOneProjectCandidates: ReadonlySet<LogicalQueryNode>,
  rankOneFactFilterCandidates: ReadonlySet<LogicalQueryNode>,
  isSafeProvenPartitionedRowNumberWindow: (node: LogicalQueryNode) => boolean,
  boundedGroupSummaryCandidates: ReadonlySet<LogicalQueryNode> = new Set(),
  boundedAdmissionCandidates: ReadonlyMap<
    LogicalQueryNode,
    BoundedAdmissionEvidence
  > = new Map(),
  boundedAdmissionCounterCandidates: ReadonlyMap<
    LogicalQueryNode,
    BoundedAdmissionEvidence
  > = new Map(),
  completeKeyedLookupCandidates: ReadonlySet<LogicalQueryNode> = new Set(),
  boundedFactLocalReuseCandidates: ReadonlyMap<
    LogicalQueryNode,
    BoundedFactLocalReuseEvidence
  > = new Map(),
  boundedSummaryDerivedCandidates: ReadonlySet<LogicalQueryNode> = analysis.boundedSummaryDerivedCandidates,
  materializedBoundaries?: ReadonlyMap<
    LogicalQueryNode,
    MaterializedBoundaryInterface
  >,
  boundaryAwareWindowProjectCandidates: ReadonlySet<LogicalQueryNode> = new Set(),
  legacyStrictRankOneProjectCandidates: ReadonlySet<LogicalQueryNode> = rankOneProjectCandidates,
): readonly SharedRelationDefinition[] {
  const {
    incoming,
    postorder,
    hoist,
    repeatedWindowInputs,
    closedWindowScopeMemo,
    terminalBagCandidates,
    filterFanoutCandidates,
    ordinaryFilterFanoutCandidates,
    sharedMembershipInputCandidates,
    sharedScalarCountCandidates: scalarCountCandidates,
  } = analysis;
  const sharedMaterializations = new Map<
    LogicalQueryNode,
    SharedRelationDefinition["materialization"]
  >();
  for (const node of postorder) {
    const incomingCount = incoming.get(node) ?? 0;
    const hasTerminalBagLicense = terminalBagCandidates.has(node);
    if (
      incomingCount < 2 ||
      node.kind === "scan" ||
      (hoist.forbidden.has(node) &&
        !hasTerminalBagLicense &&
        !boundedGroupSummaryCandidates.has(node) &&
        !boundedSummaryDerivedCandidates.has(node) &&
        !sharedMembershipInputCandidates.has(node) &&
        !scalarCountCandidates.has(node) &&
        !boundedAdmissionCandidates.has(node) &&
        !boundedAdmissionCounterCandidates.has(node) &&
        !completeKeyedLookupCandidates.has(node) &&
        !boundedFactLocalReuseCandidates.has(node)) ||
      node.fields.length === 0 ||
      node.fields.length > MAX_REPEATED_WINDOW_INPUT_PROJECT_FIELDS
    )
      continue;
    if (boundedGroupSummaryCandidates.has(node)) {
      sharedMaterializations.set(node, "materialized");
      continue;
    }
    if (boundedSummaryDerivedCandidates.has(node)) {
      sharedMaterializations.set(node, "materialized");
      continue;
    }
    if (sharedMembershipInputCandidates.has(node)) {
      sharedMaterializations.set(node, "materialized");
      continue;
    }
    if (scalarCountCandidates.has(node)) {
      sharedMaterializations.set(node, "materialized");
      continue;
    }
    if (boundedAdmissionCandidates.has(node)) {
      sharedMaterializations.set(node, "materialized");
      continue;
    }
    if (boundedAdmissionCounterCandidates.has(node)) {
      sharedMaterializations.set(node, "materialized");
      continue;
    }
    if (completeKeyedLookupCandidates.has(node)) {
      sharedMaterializations.set(node, "materialized");
      continue;
    }
    if (boundedFactLocalReuseCandidates.has(node)) {
      sharedMaterializations.set(node, "materialized");
      continue;
    }
    if (node.fields.length === 1 && isScalarCountRows(node)) continue;
    const hasLegacyStrictRankOnePermit =
      legacyStrictRankOneProjectCandidates.has(node);
    const boundaryContext =
      !hasLegacyStrictRankOnePermit &&
      (rankOneProjectCandidates.has(node) ||
        boundaryAwareWindowProjectCandidates.has(node))
        ? materializedBoundaries
        : undefined;
    const initialFacts = candidateFacts(
      node,
      closedWindowScopeMemo,
      boundaryContext,
    );
    const consumesMaterializedBoundary = initialFacts.materializedBoundary;
    if (
      consumesMaterializedBoundary &&
      node.fields.length > MAX_MATERIALIZED_SHARED_RELATION_FIELDS &&
      !wideRankOneBoundaryUsesExistingLicense(
        node,
        initialFacts,
        boundaryContext ?? new Map(),
      )
    )
      continue;
    const facts = consumesMaterializedBoundary
      ? candidateFacts(
          node,
          closedWindowScopeMemo,
          boundaryContext,
          true,
          rankOneProjectCandidates.has(node) && !hasLegacyStrictRankOnePermit,
          isSafeProvenPartitionedRowNumberWindow,
        )
      : initialFacts;
    const isSafe =
      facts.selective &&
      !facts.forbidden &&
      (!consumesMaterializedBoundary ||
        (facts.materializedBoundary && !facts.unsafe)) &&
      candidateFactsAreClosed(facts, boundaryContext);
    if (!isSafe) continue;

    if (hasTerminalBagLicense) {
      sharedMaterializations.set(node, "auto");
      continue;
    }
    if (filterFanoutCandidates.has(node)) {
      sharedMaterializations.set(node, "auto");
      continue;
    }
    if (ordinaryFilterFanoutCandidates.has(node)) {
      sharedMaterializations.set(node, "auto");
      continue;
    }
    if (rankOneProjectCandidates.has(node)) {
      sharedMaterializations.set(
        node,
        facts.ordinaryRowNumberWindow ? "auto" : "materialized",
      );
      continue;
    }
    if (rankOneFactFilterCandidates.has(node)) {
      sharedMaterializations.set(node, "auto");
      continue;
    }

    if (node.fields.length <= MAX_SHARED_RELATION_FIELDS) {
      sharedMaterializations.set(
        node,
        hoist.windowInput.has(node) || facts.rowNumberWindow
          ? "materialized"
          : "auto",
      );
      continue;
    }
    if (
      node.fields.length <= MAX_MATERIALIZED_SHARED_RELATION_FIELDS &&
      node.kind === "project" &&
      (incomingCount >= 3 ||
        (incomingCount === 2 &&
          hoist.windowInput.has(node) &&
          repeatedWindowInputs.has(node)))
    )
      sharedMaterializations.set(node, "materialized");
    else if (
      node.kind === "project" &&
      node.fields.length >= MIN_REPEATED_WINDOW_INPUT_PROJECT_FIELDS &&
      node.fields.length <= MAX_REPEATED_WINDOW_INPUT_PROJECT_FIELDS &&
      incomingCount >= MIN_REPEATED_WINDOW_INPUT_PROJECT_REFERENCES &&
      hoist.windowInput.has(node) &&
      repeatedWindowInputs.has(node) &&
      !facts.ordinaryRowNumberWindow
    )
      sharedMaterializations.set(node, "materialized");
  }

  const shared = new Set(sharedMaterializations.keys());
  if (shared.size === 0) return [];

  const names = new Map<LogicalQueryNode, string>();
  const reservedNames = new Set(
    postorder
      .filter((node) => node.kind === "scan")
      .map((node) => node.table.name),
  );
  let nextName = 0;
  postorder.forEach((node) => {
    if (shared.has(node)) {
      let name = `_d1_shared_${nextName++}`;
      while (reservedNames.has(name)) name = `_d1_shared_${nextName++}`;
      names.set(node, name);
      reservedNames.add(name);
    }
  });

  return postorder
    .filter((node) => shared.has(node))
    .map((node) => {
      const dependencies = new Set<string>();
      const descendants = new Set<LogicalQueryNode>();
      const collect = (current: LogicalQueryNode): void => {
        if (descendants.has(current)) return;
        descendants.add(current);
        for (const source of nodeSources(current)) {
          const dependency = names.get(source.node);
          if (dependency) dependencies.add(dependency);
          collect(source.node);
        }
      };
      collect(node);
      dependencies.delete(names.get(node)!);
      const orderedDependencies = [...dependencies].sort(
        (left, right) =>
          postorder.findIndex((item) => names.get(item) === left) -
          postorder.findIndex((item) => names.get(item) === right),
      );
      return {
        name: names.get(node)!,
        node,
        scope: node.scope,
        fields: node.fields,
        dependencies: orderedDependencies,
        materialization: sharedMaterializations.get(node)!,
      };
    });
}

interface CanonicalSharedRelationAnalysis {
  readonly definitions: readonly SharedRelationDefinition[];
  readonly boundedFactLocal: ReadonlyMap<
    LogicalQueryNode,
    BoundedFactLocalReuseEvidence
  >;
  readonly materializedBoundaryPasses: number;
  readonly materializedDefinitionsChecked: number;
  readonly currentMaterializedBoundaryContext:
    MaterializedBoundaryContext | undefined;
}

function sharedRelationDefinitions(
  root: LogicalQueryNode,
  includeCurrentMaterializedBoundaryContext = false,
  onMaterializationDiagnostics?: MaterializationDiagnosticSink,
): CanonicalSharedRelationAnalysis {
  // This cache contains only pure facts about this immutable logical graph and
  // is discarded when lowering/validation returns. Validation calls this
  // function again with a fresh context and recomputes every proof.
  const provenWindowAnalysis =
    createProvenPartitionedRowNumberWindowAnalysisContext();
  const analysis = analyzeSharedRelations(root);
  const admissionCounters = new Map<LogicalQueryNode, LogicalQueryNode>(
    [...analysis.boundedAdmissionCandidates.values()].map(
      ({ counter, bounded }) => [counter, bounded],
    ),
  );
  const completeKeyedLookup = completeKeyedLookupReuseCandidates(
    root,
    analysis.boundedAdmissionCandidates,
    admissionCounters,
  );
  const baselineRankOneProjectCandidates = sharedRankOneProjectCandidates(
    analysis.postorder,
    analysis.incoming,
    analysis.incomingEdges,
    analysis.hoist,
    analysis.repeatedWindowInputs,
    analysis.rankingInputNodes,
    analysis.expressionQueryEdgeNodes,
    analysis.closedWindowScopeMemo,
    new Map(),
    provenWindowAnalysis.isSafe,
  );
  const baselineRankOneFactFilterCandidates = sharedRankOneFactFilterCandidates(
    analysis.postorder,
    analysis.incoming,
    analysis.incomingEdges,
    analysis.hoist,
    analysis.repeatedWindowInputs,
    analysis.rankingInputNodes,
    analysis.expressionQueryEdgeNodes,
    analysis.closedWindowScopeMemo,
  );
  const baseline = sharedRelationDefinitionsForCandidates(
    analysis,
    baselineRankOneProjectCandidates,
    baselineRankOneFactFilterCandidates,
    provenWindowAnalysis.isSafe,
    analysis.boundedGroupSummaryCandidates,
    analysis.boundedAdmissionCandidates,
    analysis.boundedAdmissionCounterCandidates,
    completeKeyedLookup,
    new Map(),
    analysis.boundedSummaryDerivedCandidates,
  );
  const consumerEdges = materializationConsumerEdges(
    analysis.postorder,
    nodeChildren,
    nodeExpressions,
    expressionSources,
  );
  const createBoundaryContext = (
    definitions: readonly SharedRelationDefinition[],
    projectCandidates: ReadonlySet<LogicalQueryNode>,
    factFilterCandidates: ReadonlySet<LogicalQueryNode>,
    promotionCandidates?: ReadonlyMap<
      LogicalQueryNode,
      MaterializationPromotionCandidate
    >,
    originalDefinitions?: readonly SharedRelationDefinition[],
    strictStageReaderContext?: StrictStageReaderContext,
    initialInterfaces?: ReadonlyMap<
      LogicalQueryNode,
      PhysicalSharedRelationBoundaryEvidence
    >,
  ) =>
    materializedBoundaryContext({
      root,
      postorder: analysis.postorder,
      closedWindowScopeMemo: analysis.closedWindowScopeMemo,
      baseline: definitions,
      ...(initialInterfaces ? { initialInterfaces } : {}),
      completeKeyedLookupCandidates: completeKeyedLookup,
      rankOneProjectCandidates: projectCandidates,
      rankOneFactFilterCandidates: factFilterCandidates,
      ...(promotionCandidates ? { promotionCandidates } : {}),
      ...(strictStageReaderContext ? { strictStageReaderContext } : {}),
      ...(originalDefinitions ? { originalDefinitions } : {}),
      edges: consumerEdges,
      sourcesOf: nodeSources,
      sameFields,
      candidateFacts: (node, memo, boundaries, requireTotal, allowRankProof) =>
        candidateFacts(
          node,
          memo,
          boundaries,
          requireTotal,
          allowRankProof,
          provenWindowAnalysis.isSafe,
        ),
      candidateFactsAreClosed,
      licenseSourceFor: (node, facts) =>
        selectedMaterializedBoundaryLicenseSource(
          node,
          analysis,
          completeKeyedLookup,
          projectCandidates,
          factFilterCandidates,
          facts,
        ),
      isSafeReader: (node) =>
        isMaterializationSafeNode(node) || provenWindowAnalysis.isSafe(node),
    });
  const boundaryContext = createBoundaryContext(
    baseline,
    baselineRankOneProjectCandidates,
    baselineRankOneFactFilterCandidates,
  );
  const boundaryAwareWindowProjectCandidates =
    sharedMaterializedBoundaryProjectCandidates(
      analysis,
      boundaryContext.interfaces,
    );
  const shieldedExpressionQueryEdges = expressionQueryEdgeSubtrees(
    analysis.postorder,
    new Set(boundaryContext.interfaces.keys()),
  );
  const boundaryAwareRankOneProjectCandidates = sharedRankOneProjectCandidates(
    analysis.postorder,
    analysis.incoming,
    analysis.incomingEdges,
    analysis.hoist,
    analysis.repeatedWindowInputs,
    analysis.rankingInputNodes,
    shieldedExpressionQueryEdges,
    analysis.closedWindowScopeMemo,
    boundaryContext.interfaces,
    provenWindowAnalysis.isSafe,
  );
  const rankOneProjectCandidates = new Set([
    ...baselineRankOneProjectCandidates,
    ...boundaryAwareRankOneProjectCandidates,
  ]);
  const rankOneFactFilterCandidates = sharedRankOneFactFilterCandidates(
    analysis.postorder,
    analysis.incoming,
    analysis.incomingEdges,
    analysis.hoist,
    analysis.repeatedWindowInputs,
    analysis.rankingInputNodes,
    analysis.expressionQueryEdgeNodes,
    analysis.closedWindowScopeMemo,
  );
  const existingSharedOwners = new Set<LogicalQueryNode>([
    ...baseline.map(({ node }) => node),
    ...analysis.boundedGroupSummaryCandidates,
    ...analysis.boundedSummaryDerivedCandidates,
    ...analysis.sharedMembershipInputCandidates,
    ...analysis.sharedScalarCountCandidates,
    ...rankOneProjectCandidates,
    ...rankOneFactFilterCandidates,
  ]);
  const boundedFactLocal = boundedFactLocalReuseCandidates({
    root,
    nodes: analysis.postorder,
    incomingCounts: analysis.incoming,
    incoming: analysis.incomingEdges,
    completeFacts: completeKeyedLookup,
    boundedAdmissions: analysis.boundedAdmissionCandidates,
    sharedBoundaries: existingSharedOwners,
    maximumFields: MAX_MATERIALIZED_SHARED_RELATION_FIELDS,
  });
  const baseDefinitions = sharedRelationDefinitionsForCandidates(
    analysis,
    rankOneProjectCandidates,
    rankOneFactFilterCandidates,
    provenWindowAnalysis.isSafe,
    analysis.boundedGroupSummaryCandidates,
    analysis.boundedAdmissionCandidates,
    analysis.boundedAdmissionCounterCandidates,
    completeKeyedLookup,
    boundedFactLocal,
    analysis.boundedSummaryDerivedCandidates,
    boundaryContext.interfaces,
    boundaryAwareWindowProjectCandidates,
    baselineRankOneProjectCandidates,
  );
  const independentAutoPromotionCandidates =
    autoMaterializationPromotionCandidates(baseDefinitions, analysis.postorder);
  const independentAutoBoundaryContext = createBoundaryContext(
    baseDefinitions,
    rankOneProjectCandidates,
    rankOneFactFilterCandidates,
    independentAutoPromotionCandidates,
    baseDefinitions,
  );
  const stageBaseDefinitions = baseDefinitions.map(
    (definition) =>
      independentAutoBoundaryContext.promotedDefinitions.get(definition.node) ??
      definition,
  );
  const stageReview = reviewStrictRankStages({
    root,
    postorder: analysis.postorder,
    closedWindowScopeMemo: analysis.closedWindowScopeMemo,
    stageBaseDefinitions,
    edges: consumerEdges,
    sourcesOf: nodeSources,
    independentAutoBoundaryContext,
    candidateFacts: (node, memo, boundaries, requireTotal, allowRankProof) =>
      candidateFacts(
        node,
        memo,
        boundaries,
        requireTotal,
        allowRankProof,
        provenWindowAnalysis.isSafe,
      ),
    candidateFactsAreClosed,
    sameFields,
    isSafeReader: (node) =>
      isMaterializationSafeNode(node) || provenWindowAnalysis.isSafe(node),
  });
  const {
    stageProof,
    selectedStageNodes,
    provisionalDefinitions,
    strictStageReaderContext,
  } = stageReview;
  const promotionCandidates = new Map(
    autoMaterializationPromotionCandidates(
      stageBaseDefinitions,
      analysis.postorder,
    ),
  );
  for (const node of selectedStageNodes)
    promotionCandidates.set(node, {
      kind: "strict-serial-rank-stage",
      choiceIndex: analysis.postorder.indexOf(node),
    });
  const provisionalBoundaryContext = createBoundaryContext(
    provisionalDefinitions,
    rankOneProjectCandidates,
    rankOneFactFilterCandidates,
    promotionCandidates,
    stageBaseDefinitions,
    strictStageReaderContext,
    independentAutoBoundaryContext.interfaces,
  );
  const finalReaderAudit = auditMaterializedBoundaryFixedPoint({
    initialBoundaryContext: provisionalBoundaryContext,
    initialReaderContext: {
      definitions: provisionalBoundaryContext.definitions,
      interfaces: provisionalBoundaryContext.interfaces,
      licensedBoundaryNodes: new Set(
        provisionalBoundaryContext.interfaces.keys(),
      ),
    },
    postorder: analysis.postorder,
    maximumRounds: promotionCandidates.size + 1,
    rebuild: (readerContext) => {
      // Stage licenses stay visible to candidate reader proofs, but each
      // selected stage must be re-proved against the current boundary set.
      const initialInterfaces = new Map(
        [...readerContext.interfaces].filter(
          ([node]) =>
            promotionCandidates.get(node)?.kind !== "strict-serial-rank-stage",
        ),
      );
      return createBoundaryContext(
        provisionalDefinitions,
        rankOneProjectCandidates,
        rankOneFactFilterCandidates,
        promotionCandidates,
        stageBaseDefinitions,
        readerContext,
        initialInterfaces,
      );
    },
  });
  let finalBoundaryContext = finalReaderAudit.finalBoundaryContext;
  const finalReaderAuditRounds = finalReaderAudit.rounds;
  const finalReaderAuditStable = finalReaderAudit.stable;
  const acceptedStageCount = [
    ...finalBoundaryContext.promotedDefinitions.keys(),
  ].filter(
    (node) =>
      promotionCandidates.get(node)?.kind === "strict-serial-rank-stage",
  ).length;
  const fallbackTriggered =
    !finalReaderAuditStable || acceptedStageCount !== selectedStageNodes.length;
  let fallbackBoundaryContext: MaterializedBoundaryContext | undefined;
  if (fallbackTriggered) {
    const fallbackCandidates = autoMaterializationPromotionCandidates(
      stageBaseDefinitions,
      analysis.postorder,
    );
    fallbackBoundaryContext = createBoundaryContext(
      stageBaseDefinitions,
      rankOneProjectCandidates,
      rankOneFactFilterCandidates,
      fallbackCandidates,
      stageBaseDefinitions,
      undefined,
      independentAutoBoundaryContext.interfaces,
    );
    finalBoundaryContext = fallbackBoundaryContext;
  }
  emitMaterializationDiagnostic({
    sink: onMaterializationDiagnostics,
    logicalPostorderNodeCount: analysis.postorder.length,
    postorder: analysis.postorder,
    initialDefinitions: baseline,
    baseDefinitions,
    stageBaseDefinitions,
    initialBoundary: boundaryContext,
    independentAutoBoundary: independentAutoBoundaryContext,
    stageProof,
    selectedStageNodes,
    provisionalBoundary: provisionalBoundaryContext,
    acceptedStageCount,
    finalReaderAuditStable,
    finalReaderAuditRounds,
    fallbackTriggered,
    ...(fallbackBoundaryContext
      ? { fallbackBoundary: fallbackBoundaryContext }
      : {}),
    finalBoundary: finalBoundaryContext,
  });
  const definitions = finalBoundaryContext.definitions;
  const currentMaterializedBoundaryContext =
    includeCurrentMaterializedBoundaryContext
      ? finalBoundaryContext
      : undefined;
  return {
    definitions,
    boundedFactLocal,
    // Public counters describe the canonical baseline and returned layouts.
    // Provisional stage/auto reader probes are internal review iterations.
    materializedBoundaryPasses: 2,
    materializedDefinitionsChecked:
      boundaryContext.materializedDefinitionsChecked +
      finalBoundaryContext.materializedDefinitionsChecked,
    currentMaterializedBoundaryContext,
  };
}

/** Validate optimizer metadata against a fresh analysis of the logical root. */
export function validatePhysicalQueryPlan<Row extends object>(
  plan: PhysicalQueryPlan<Row>,
  options?: {
    readonly onMaterializationDiagnostics?: MaterializationDiagnosticSink;
  },
): PhysicalSharedRelationInterfaceView {
  if (
    !plan ||
    typeof plan !== "object" ||
    !plan.root ||
    typeof plan.root !== "object"
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Invalid physical query plan",
    );
  validateLogicalQueryPlan(plan.root);
  if (
    plan.scope !== plan.root.scope ||
    !Array.isArray(plan.fields) ||
    !sameFields(plan.fields, plan.root.fields)
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical query root metadata does not match its logical node",
    );
  const sharedAnalysis = sharedRelationDefinitions(
    plan.root,
    true,
    options?.onMaterializationDiagnostics,
  );
  const expected = sharedAnalysis.definitions;
  const expectedDirectScanProjections = directScanProjectionChoices(plan.root);
  const expectedPassthroughProjectFusions = passthroughProjectFusions(
    plan.root,
    new Set(expected.map(({ node }) => node)),
  );
  const expectedConstantFilterJoinProjections = constantFilterJoinProjections(
    plan.root,
    new Set(expected.map(({ node }) => node)),
    expectedPassthroughProjectFusions,
  );
  const currentBoundaryContext =
    sharedAnalysis.currentMaterializedBoundaryContext;
  if (!currentBoundaryContext)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical self-membership interfaces were not freshly analyzed",
    );
  assertCurrentPhysicalCompileOrderPolicy(
    plan,
    expected,
    currentBoundaryContext.interfaces,
  );
  const membershipCandidates = positiveTupleMembershipCandidates(
    plan.root,
    new Set(expected.map(({ node }) => node)),
    new Set(currentBoundaryContext.interfaces.keys()),
  );
  const selfMembershipContext = createSelfMembershipDerivationContext({
    root: plan.root,
    definitions: expected,
    boundaries: currentBoundaryContext.interfaces,
    sourcesOf: nodeSources,
    sameFields,
    isSafeNode: isMaterializationSafeNode,
  });
  const {
    selfMembershipChoices: expectedSelfMembershipChoices,
    positiveTupleMembershipCandidates:
      expectedPositiveTupleMembershipCandidates,
  } = partitionSelfMembershipCandidates(
    membershipCandidates,
    selfMembershipContext,
  );
  const expectedRowPipelineChoices = rowPipelineChoices(
    plan.root,
    new Set(expected.map(({ node }) => node)),
    canonicalProjectRendererBoundaries(
      expectedDirectScanProjections,
      expectedPassthroughProjectFusions,
      expectedConstantFilterJoinProjections,
      expectedPositiveTupleMembershipCandidates,
      expectedSelfMembershipChoices,
    ),
  );
  const singletonBoundaryContext = currentBoundaryContext;
  if (!singletonBoundaryContext)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical singleton-rank interfaces were not freshly analyzed",
    );
  const expectedSingletonRankChoices = analyzeSingletonRankChoices({
    root: plan.root,
    definitions: expected,
    interfaces: singletonBoundaryContext.interfaces,
    rowPipelines: expectedRowPipelineChoices,
  });
  const expectedNativeNullOrderingChoices = analyzeNativeNullOrdering(
    plan.root,
  );
  const expectedJoinOrderStrategies = joinOrderStrategies(
    plan.root,
    expected,
    sharedAnalysis.boundedFactLocal,
  );
  const expectedConditionalLookupChoices = analyzeConditionalLookupChoices(
    plan.root,
  );
  const expectedLexicographicComparisonChoices = lexicographicComparisonChoices(
    plan.root,
  );
  const semiBoundaryContext = sharedAnalysis.currentMaterializedBoundaryContext;
  if (!semiBoundaryContext)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical semi membership interfaces were not freshly analyzed",
    );
  const expectedSemiMembershipChoices = semiMembershipChoices(
    plan.root,
    semiBoundaryContext.interfaces,
  );
  if (
    !Array.isArray(plan.directScanProjections) ||
    !sameDirectScanProjectionChoices(
      plan.directScanProjections,
      expectedDirectScanProjections,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical direct scan projection choices are inconsistent",
    );
  if (
    !Array.isArray(plan.passthroughProjectFusions) ||
    !samePassthroughProjectFusions(
      plan.passthroughProjectFusions,
      expectedPassthroughProjectFusions,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical passthrough projection fusions are inconsistent",
    );
  if (
    !Array.isArray(plan.rowPipelineChoices) ||
    !sameRowPipelineChoices(plan.rowPipelineChoices, expectedRowPipelineChoices)
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical row-pipeline choices are inconsistent",
    );
  if (
    !Array.isArray(plan.singletonRankChoices) ||
    !sameSingletonRankChoices(
      plan.singletonRankChoices,
      expectedSingletonRankChoices,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical singleton-rank choices are inconsistent",
    );
  if (
    !Array.isArray(plan.nativeNullOrderingChoices) ||
    !sameNativeNullOrderingChoices(
      plan.nativeNullOrderingChoices,
      expectedNativeNullOrderingChoices,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical native null-ordering choices are inconsistent",
    );
  if (
    !Array.isArray(plan.constantFilterJoinProjections) ||
    !sameConstantFilterJoinProjections(
      plan.constantFilterJoinProjections,
      expectedConstantFilterJoinProjections,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical constant filter Join projections are inconsistent",
    );
  if (
    !Array.isArray(plan.positiveTupleMembershipCandidates) ||
    !samePositiveTupleMembershipCandidates(
      plan.positiveTupleMembershipCandidates,
      expectedPositiveTupleMembershipCandidates,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical tuple membership candidates are inconsistent",
    );
  if (
    !Array.isArray(plan.selfMembershipChoices) ||
    !sameSelfMembershipChoices(
      plan.selfMembershipChoices,
      expectedSelfMembershipChoices,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical self-membership choices are inconsistent",
    );
  if (
    !sameSemiMembershipChoices(
      plan.semiMembershipChoices,
      expectedSemiMembershipChoices,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical semi membership choices are inconsistent",
    );
  const expectedSemiMembershipCostSelections = semiMembershipCostSelections(
    expectedSemiMembershipChoices,
  );
  if (
    !sameSemiMembershipCostSelections(
      plan.semiMembershipCostSelections,
      expectedSemiMembershipCostSelections,
      sameSemiMembershipChoices,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical semi membership cost selections are inconsistent",
    );
  if (
    !Array.isArray(plan.joinOrderStrategies) ||
    !sameJoinOrderStrategies(
      plan.joinOrderStrategies,
      expectedJoinOrderStrategies,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical join order strategies are inconsistent",
    );
  if (
    !Array.isArray(plan.conditionalLookupChoices) ||
    !sameConditionalLookupChoices(
      plan.conditionalLookupChoices,
      expectedConditionalLookupChoices,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical conditional lookup choices are inconsistent",
    );
  if (
    !Array.isArray(plan.lexicographicComparisonChoices) ||
    !sameLexicographicComparisonChoices(
      plan.lexicographicComparisonChoices,
      expectedLexicographicComparisonChoices,
    )
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical lexicographic comparison choices are inconsistent",
    );
  let rawActualDefinitions: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(plan, "sharedRelations");
    if (descriptor && "value" in descriptor)
      rawActualDefinitions = descriptor.value;
  } catch {
    rawActualDefinitions = undefined;
  }
  const actualLayout = snapshotPhysicalSharedRelationLayout(
    plan.root,
    rawActualDefinitions,
  );
  const expectedLayout = snapshotPhysicalSharedRelationLayout(
    plan.root,
    expected,
  );
  if (
    !actualLayout ||
    !expectedLayout ||
    !Array.isArray(rawActualDefinitions) ||
    actualLayout.length !== expectedLayout.length
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical query shared relation metadata is inconsistent",
    );
  for (let index = 0; index < expectedLayout.length; index++) {
    if (
      !samePhysicalSharedRelationDefinitionIdentity(
        actualLayout[index]!,
        expectedLayout[index]!,
      )
    )
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Physical query shared relation metadata is inconsistent",
      );
  }
  const sharedRelationBoundaryContext =
    sharedAnalysis.currentMaterializedBoundaryContext;
  if (!sharedRelationBoundaryContext)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical shared relation interfaces were not freshly analyzed",
    );
  return createPhysicalSharedRelationInterfaceView({
    root: plan.root,
    definitions: rawActualDefinitions as readonly SharedRelationDefinition[],
    boundaries: sharedRelationBoundaryContext.interfaces,
    vetoes: sharedRelationBoundaryContext.vetoes,
    materializedBoundaryPasses: sharedAnalysis.materializedBoundaryPasses,
    materializedDefinitionsChecked:
      sharedAnalysis.materializedDefinitionsChecked,
  });
}

export function lowerLogicalQuerySource<Row extends object>(
  source: QuerySource,
): PhysicalQueryPlan<Row> {
  validateLogicalQueryPlan(
    "kind" in source && source.kind === "relation"
      ? (source as Relation<object>)
      : source.node,
  );
  if (
    source.scope !== source.node.scope ||
    !sameFields(source.fields, source.node.fields)
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Query source metadata does not match its logical node",
    );
  const sharedAnalysis = sharedRelationDefinitions(source.node, true);
  const sharedRelations = sharedAnalysis.definitions;
  const currentBoundaryContext =
    sharedAnalysis.currentMaterializedBoundaryContext;
  if (!currentBoundaryContext)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical self-membership interfaces were not freshly analyzed",
    );
  const sharedNodes = new Set(sharedRelations.map(({ node }) => node));
  const directScanProjections = directScanProjectionChoices(source.node);
  const projectFusions = passthroughProjectFusions(source.node, sharedNodes);
  const constantProjections = constantFilterJoinProjections(
    source.node,
    sharedNodes,
    projectFusions,
  );
  const membershipCandidates = positiveTupleMembershipCandidates(
    source.node,
    sharedNodes,
    new Set(currentBoundaryContext.interfaces.keys()),
  );
  const selfMembershipContext = createSelfMembershipDerivationContext({
    root: source.node,
    definitions: sharedRelations,
    boundaries: currentBoundaryContext.interfaces,
    sourcesOf: nodeSources,
    sameFields,
    isSafeNode: isMaterializationSafeNode,
  });
  const {
    selfMembershipChoices,
    positiveTupleMembershipCandidates: tupleCandidates,
  } = partitionSelfMembershipCandidates(
    membershipCandidates,
    selfMembershipContext,
  );
  const semiChoices = semiMembershipChoices(
    source.node,
    currentBoundaryContext.interfaces,
  );
  const semiCostSelections = semiMembershipCostSelections(semiChoices);
  const rowPipelines = rowPipelineChoices(
    source.node,
    sharedNodes,
    canonicalProjectRendererBoundaries(
      directScanProjections,
      projectFusions,
      constantProjections,
      tupleCandidates,
      selfMembershipChoices,
    ),
  );
  const singletonRankChoices = analyzeSingletonRankChoices({
    root: source.node,
    definitions: sharedRelations,
    interfaces: currentBoundaryContext.interfaces,
    rowPipelines,
  });
  const nativeNullOrderingChoices = analyzeNativeNullOrdering(source.node);
  const joinOrder = joinOrderStrategies(
    source.node,
    sharedRelations,
    sharedAnalysis.boundedFactLocal,
  );
  const conditionalLookupChoices = analyzeConditionalLookupChoices(source.node);
  const lexicographicChoices = lexicographicComparisonChoices(source.node);
  const compileOrderPolicy = derivePhysicalCompileOrderPolicy(
    source.node,
    sharedRelations,
    currentBoundaryContext.interfaces,
  );
  return {
    kind: "physical-query",
    root: source.node,
    scope: source.scope,
    fields: source.fields,
    sharedRelations,
    directScanProjections,
    passthroughProjectFusions: projectFusions,
    rowPipelineChoices: rowPipelines,
    singletonRankChoices,
    nativeNullOrderingChoices,
    constantFilterJoinProjections: constantProjections,
    positiveTupleMembershipCandidates: tupleCandidates,
    selfMembershipChoices,
    semiMembershipChoices: semiChoices,
    semiMembershipCostSelections: semiCostSelections,
    joinOrderStrategies: joinOrder,
    conditionalLookupChoices,
    lexicographicComparisonChoices: lexicographicChoices,
    ...(compileOrderPolicy ? { compileOrderPolicy } : {}),
  };
}

/** @internal Recompute the current production SemiJoin eligibility proof. */
export function analyzeSemiMembershipEligibilityForDiagnostics(
  root: LogicalQueryNode,
) {
  const sharedAnalysis = sharedRelationDefinitions(root, true);
  const boundaries = sharedAnalysis.currentMaterializedBoundaryContext;
  if (!boundaries)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical semi membership interfaces were not freshly analyzed",
    );
  return analyzeSemiMembershipCandidates(root, boundaries.interfaces);
}

/** Number of distinct recursive closure nodes rendered as local CTEs. */
export function recursiveClosureCount(root: LogicalQueryNode): number {
  const visited = new Set<LogicalQueryNode>();
  let count = 0;
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    if (node.kind === "recursive-closure") count += 1;
    for (const source of nodeSources(node)) visit(source.node);
  };
  visit(root);
  return count;
}

export function lowerLogicalPlan<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(relation: Relation<Row, Columns>): PhysicalQueryPlan<Row> {
  return lowerLogicalQuerySource<Row>(relation);
}
