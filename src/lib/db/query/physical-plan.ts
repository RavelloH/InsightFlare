import { DatabaseCompilerError } from "./errors";
import type { AnyExpression, RelationScope, SqlExpression } from "./expression";
import type {
  LogicalQueryNode,
  OutputField,
  QuerySource,
  Relation,
} from "./plan";
import { validateLogicalQueryPlan } from "./validator";

const MAX_SHARED_RELATION_FIELDS = 4;

export interface SharedRelationDefinition {
  readonly name: string;
  readonly node: LogicalQueryNode;
  readonly scope: RelationScope;
  readonly fields: readonly OutputField[];
  /** Names of shared CTEs referenced by this CTE, in definition order. */
  readonly dependencies: readonly string[];
}

export interface PhysicalQueryPlan<
  Row extends object = Record<string, unknown>,
> {
  readonly kind: "physical-query";
  readonly root: LogicalQueryNode;
  readonly scope: QuerySource["scope"];
  readonly fields: QuerySource["fields"];
  readonly sharedRelations: readonly SharedRelationDefinition[];
  readonly __rowType?: Row;
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
    case "sort":
      return node.keys.map(({ expression }) => expression);
    case "limit":
      return [node.count, ...(node.offset ? [node.offset] : [])];
    case "scan":
    case "distinct":
    case "union":
      return [];
  }
}

function expressionSources(expression: SqlExpression): QuerySource[] {
  const result: QuerySource[] = [];
  const visit = (current: SqlExpression): void => {
    switch (current.kind) {
      case "binary":
        visit(current.left);
        visit(current.right);
        break;
      case "boolean":
        current.expressions.forEach(visit);
        break;
      case "not":
      case "null-check":
        visit(current.expression);
        break;
      case "in-list":
        visit(current.expression);
        break;
      case "in-subquery":
        visit(current.expression);
        result.push(current.query);
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
        result.push(current.query);
        break;
      case "column":
      case "parameter":
      case "excluded":
      case "unixepoch":
        break;
    }
  };
  visit(expression);
  return result;
}

function nodeChildren(node: LogicalQueryNode): QuerySource[] {
  return node.kind === "scan"
    ? []
    : node.kind === "filter" ||
        node.kind === "project" ||
        node.kind === "aggregate" ||
        node.kind === "distinct" ||
        node.kind === "sort" ||
        node.kind === "limit"
      ? [node.input]
      : [node.left, node.right];
}

function nodeSources(node: LogicalQueryNode): QuerySource[] {
  return [
    ...nodeChildren(node),
    ...nodeExpressions(node).flatMap(expressionSources),
  ];
}

/** Mark every node reached through scope/selection-sensitive query context. */
function hoistForbiddenNodes(root: LogicalQueryNode): Set<LogicalQueryNode> {
  const forbidden = new Set<LogicalQueryNode>();
  const visited = new Map<LogicalQueryNode, Set<boolean>>();
  const visit = (node: LogicalQueryNode, inheritedForbidden: boolean): void => {
    let contexts = visited.get(node);
    if (!contexts) {
      contexts = new Set();
      visited.set(node, contexts);
    }
    if (contexts.has(inheritedForbidden)) return;
    contexts.add(inheritedForbidden);
    if (inheritedForbidden) forbidden.add(node);

    const selectionBoundary =
      inheritedForbidden || node.kind === "sort" || node.kind === "limit";
    for (const child of nodeChildren(node))
      visit(child.node, selectionBoundary);
    for (const query of nodeExpressions(node).flatMap(expressionSources))
      visit(query.node, true);
  };
  visit(root, false);
  return forbidden;
}

interface CandidateFacts {
  readonly scopes: Set<RelationScope>;
  readonly referencedScopes: RelationScope[];
  selective: boolean;
  forbidden: boolean;
}

function candidateFacts(root: LogicalQueryNode): CandidateFacts {
  const facts: CandidateFacts = {
    scopes: new Set(),
    referencedScopes: [],
    selective: false,
    forbidden: false,
  };
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    facts.scopes.add(node.scope);
    if (
      node.kind === "filter" ||
      node.kind === "semi-join" ||
      node.kind === "anti-join"
    )
      facts.selective = true;
    if (node.kind === "sort" || node.kind === "limit") facts.forbidden = true;
    for (const expression of nodeExpressions(node)) {
      const inspect = (current: SqlExpression): void => {
        if (current.kind === "column")
          facts.referencedScopes.push(current.scope);
        if (
          current.kind === "unixepoch" ||
          current.kind === "scalar-subquery" ||
          current.kind === "in-subquery"
        )
          facts.forbidden = true;
        switch (current.kind) {
          case "binary":
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
            break;
        }
      };
      inspect(expression);
    }
    nodeSources(node).forEach((source) => visit(source.node));
  };
  visit(root);
  return facts;
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

function sharedRelationDefinitions(
  root: LogicalQueryNode,
): readonly SharedRelationDefinition[] {
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
  const forbiddenToHoist = hoistForbiddenNodes(root);

  const shared = new Set(
    postorder.filter((node) => {
      if ((incoming.get(node) ?? 0) < 2 || node.kind === "scan") return false;
      if (forbiddenToHoist.has(node)) return false;
      if (
        node.fields.length === 0 ||
        node.fields.length > MAX_SHARED_RELATION_FIELDS
      )
        return false;
      const facts = candidateFacts(node);
      return (
        facts.selective &&
        !facts.forbidden &&
        facts.referencedScopes.every((scope) => facts.scopes.has(scope))
      );
    }),
  );
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
      };
    });
}

/** Validate optimizer metadata against a fresh analysis of the logical root. */
export function validatePhysicalQueryPlan<Row extends object>(
  plan: PhysicalQueryPlan<Row>,
): void {
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
  const expected = sharedRelationDefinitions(plan.root);
  const actualDefinitions = plan.sharedRelations;
  let inconsistent =
    !Array.isArray(actualDefinitions) ||
    actualDefinitions.length !== expected.length;
  if (!inconsistent) {
    for (let index = 0; index < expected.length; index++) {
      const actual = actualDefinitions[index]!;
      const canonical = expected[index]!;
      if (
        !actual ||
        typeof actual !== "object" ||
        !Array.isArray(actual.fields) ||
        !Array.isArray(actual.dependencies) ||
        actual.name !== canonical.name ||
        actual.node !== canonical.node ||
        actual.scope !== canonical.scope ||
        !sameFields(actual.fields, canonical.fields) ||
        actual.dependencies.length !== canonical.dependencies.length ||
        actual.dependencies.some(
          (dependency: string, dependencyIndex: number) =>
            dependency !== canonical.dependencies[dependencyIndex],
        )
      ) {
        inconsistent = true;
        break;
      }
    }
  }
  if (inconsistent)
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Physical query shared relation metadata is inconsistent",
    );
}

export function lowerLogicalQuerySource<Row extends object>(
  source: QuerySource,
): PhysicalQueryPlan<Row> {
  validateLogicalQueryPlan(source.node);
  if (
    source.scope !== source.node.scope ||
    !sameFields(source.fields, source.node.fields)
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Query source metadata does not match its logical node",
    );
  return {
    kind: "physical-query",
    root: source.node,
    scope: source.scope,
    fields: source.fields,
    sharedRelations: sharedRelationDefinitions(source.node),
  };
}

export function lowerLogicalPlan<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(relation: Relation<Row, Columns>): PhysicalQueryPlan<Row> {
  return lowerLogicalQuerySource<Row>(relation);
}
