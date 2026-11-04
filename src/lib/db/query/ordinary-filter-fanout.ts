import type { RelationScope, SqlExpression } from "./expression";
import { isMaterializationSafeExpression } from "./materialization-safety";
import type { LogicalQueryNode, ProjectNode, QuerySource } from "./plan";

interface IncomingConsumer {
  readonly parent: LogicalQueryNode;
  readonly kind: "relation" | "expression";
}

interface LocalExpressionFacts {
  readonly valid: boolean;
  readonly columns: readonly {
    readonly scope: RelationScope;
    readonly index: number;
  }[];
}

type LocalExpressionInspector = (
  expression: SqlExpression,
  allowedScopes: ReadonlySet<RelationScope>,
) => LocalExpressionFacts;

export function isConstantExistenceQuery(query: QuerySource): boolean {
  if (query.node.kind !== "project" || query.node.projections.length !== 1)
    return false;
  const expression = query.node.projections[0]!.expression;
  return expression.kind === "constant" && expression.value === 1;
}

function expressionFitsSources(
  expression: SqlExpression,
  sources: readonly QuerySource[],
  inspect: LocalExpressionInspector,
  correlatedScope?: RelationScope,
  correlatedWidth = 0,
  requireTotal = false,
): boolean {
  const widths = new Map<RelationScope, number>();
  for (const source of sources) {
    const previous = widths.get(source.scope);
    if (previous !== undefined && previous !== source.fields.length)
      return false;
    widths.set(source.scope, source.fields.length);
  }
  if (correlatedScope) {
    const previous = widths.get(correlatedScope);
    if (previous !== undefined && previous !== correlatedWidth) return false;
    widths.set(correlatedScope, correlatedWidth);
  }
  const inspected = inspect(expression, new Set(widths.keys()));
  return (
    inspected.valid &&
    inspected.columns.every(
      ({ scope, index }) => index < (widths.get(scope) ?? 0),
    ) &&
    (!requireTotal || isMaterializationSafeExpression(expression, widths))
  );
}

interface OrdinaryRelationFacts {
  readonly valid: boolean;
  readonly selective: boolean;
}

function ordinaryRelationFacts(
  root: LogicalQueryNode,
  nodeChildren: (node: LogicalQueryNode) => readonly QuerySource[],
  inspect: LocalExpressionInspector,
  correlatedScope?: RelationScope,
  correlatedWidth = 0,
  requireTotal = false,
): OrdinaryRelationFacts {
  const nodes: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  let valid = true;
  const visit = (node: LogicalQueryNode): void => {
    if (!valid) return;
    if (active.has(node)) {
      valid = false;
      return;
    }
    if (visited.has(node)) return;
    if (
      node.kind !== "scan" &&
      node.kind !== "project" &&
      node.kind !== "filter" &&
      node.kind !== "join"
    ) {
      valid = false;
      return;
    }
    if (correlatedScope && node.scope === correlatedScope) {
      valid = false;
      return;
    }
    active.add(node);
    for (const source of nodeChildren(node)) visit(source.node);
    active.delete(node);
    if (valid) {
      visited.add(node);
      nodes.push(node);
    }
  };
  visit(root);
  if (!valid) return { valid: false, selective: false };

  const safeExpression = (
    expression: SqlExpression,
    sources: readonly QuerySource[],
  ) =>
    expressionFitsSources(
      expression,
      sources,
      inspect,
      correlatedScope,
      correlatedWidth,
      requireTotal,
    );
  for (const node of nodes) {
    if (node.kind === "project") {
      if (
        !node.projections.every(({ expression }) =>
          safeExpression(expression, [node.input]),
        )
      )
        return { valid: false, selective: false };
    } else if (node.kind === "filter") {
      if (!safeExpression(node.predicate, [node.input]))
        return { valid: false, selective: false };
    } else if (node.kind === "join") {
      if (
        (node.joinType !== "inner" && node.joinType !== "left") ||
        !safeExpression(node.condition, [node.left, node.right])
      )
        return { valid: false, selective: false };
    }
  }
  return {
    valid: true,
    selective: nodes.some((node) => node.kind === "filter"),
  };
}

/**
 * Reprove the one-scalar `SELECT 1` null-check shape against a closed query
 * body. The scalar result is non-NULL exactly when the body returns a row;
 * both IS NULL and IS NOT NULL therefore have ordinary existence semantics.
 */
export function correlatedConstantExistenceOuterScopes(
  parent: LogicalQueryNode,
  nodeChildren: (node: LogicalQueryNode) => readonly QuerySource[],
  inspect: LocalExpressionInspector,
): ReadonlyMap<RelationScope, number> | undefined {
  if (
    parent.kind !== "filter" ||
    parent.predicate.kind !== "null-check" ||
    parent.predicate.expression.kind !== "scalar-subquery"
  )
    return undefined;
  const { query } = parent.predicate.expression;
  if (
    !isConstantExistenceQuery(query) ||
    query.scope !== query.node.scope ||
    query.fields.length !== query.node.fields.length ||
    !query.fields.every((field, index) => {
      const bodyField = query.node.fields[index];
      return (
        field.name === bodyField?.name &&
        field.affinity === bodyField?.affinity &&
        field.nullable === bodyField?.nullable
      );
    })
  )
    return undefined;
  const body = ordinaryRelationFacts(
    query.node,
    nodeChildren,
    inspect,
    parent.input.scope,
    parent.input.fields.length,
    true,
  );
  if (!body.valid) return undefined;
  return new Map([[parent.input.scope, parent.input.fields.length]]);
}

function expressionFitsLocalFields(
  expression: SqlExpression,
  scope: RelationScope,
  fieldCount: number,
  inspect: LocalExpressionInspector,
): boolean {
  const inspected = inspect(expression, new Set([scope]));
  return (
    inspected.valid &&
    inspected.columns.every(({ index }) => index < fieldCount)
  );
}

function isSafeCorrelatedConstantExistenceFilter(
  parent: Extract<LogicalQueryNode, { readonly kind: "filter" }>,
  nodeChildren: (node: LogicalQueryNode) => readonly QuerySource[],
  inspect: LocalExpressionInspector,
): boolean {
  const predicate = parent.predicate;
  if (
    predicate.kind !== "null-check" ||
    predicate.expression.kind !== "scalar-subquery" ||
    !isConstantExistenceQuery(predicate.expression.query)
  )
    return false;
  return (
    correlatedConstantExistenceOuterScopes(parent, nodeChildren, inspect) !==
    undefined
  );
}

export function sharedOrdinaryFilterFanoutCandidates(input: {
  readonly nodes: readonly LogicalQueryNode[];
  readonly incomingCounts: ReadonlyMap<LogicalQueryNode, number>;
  readonly incoming: ReadonlyMap<LogicalQueryNode, readonly IncomingConsumer[]>;
  readonly forbidden: ReadonlySet<LogicalQueryNode>;
  readonly expressionQueryEdgeNodes: ReadonlySet<LogicalQueryNode>;
  readonly minimumFields: number;
  readonly maximumFields: number;
  readonly minimumReferences: number;
  readonly nodeChildren: (node: LogicalQueryNode) => readonly QuerySource[];
  readonly inspect: LocalExpressionInspector;
  readonly isPureProjectConsumer: (
    node: LogicalQueryNode,
  ) => node is ProjectNode;
}): Set<LogicalQueryNode> {
  const candidates = new Set<LogicalQueryNode>();
  for (const node of input.nodes) {
    if (
      !input.isPureProjectConsumer(node) ||
      node.fields.length < input.minimumFields ||
      node.fields.length > input.maximumFields ||
      input.forbidden.has(node) ||
      input.expressionQueryEdgeNodes.has(node)
    )
      continue;
    const consumers = input.incoming.get(node) ?? [];
    const distinctParents = new Set(consumers.map(({ parent }) => parent));
    if (
      consumers.length < input.minimumReferences ||
      consumers.length !== (input.incomingCounts.get(node) ?? 0) ||
      distinctParents.size !== consumers.length ||
      consumers.some(
        ({ kind, parent }) =>
          kind !== "relation" ||
          parent.kind !== "filter" ||
          parent.input.node !== node ||
          (!expressionFitsLocalFields(
            parent.predicate,
            parent.input.scope,
            parent.input.fields.length,
            input.inspect,
          ) &&
            !isSafeCorrelatedConstantExistenceFilter(
              parent,
              input.nodeChildren,
              input.inspect,
            )),
      )
    )
      continue;

    const base = ordinaryRelationFacts(node, input.nodeChildren, input.inspect);
    if (base.valid && base.selective) candidates.add(node);
  }
  return candidates;
}
