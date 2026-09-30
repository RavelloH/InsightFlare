import { DatabaseCompilerError } from "./errors";
import type {
  AnyExpression,
  AnyInListExpression,
  RelationScope,
  SqlExpression,
} from "./expression";
import type {
  LogicalQueryNode,
  OutputField,
  ProjectNode,
  QuerySource,
  Relation,
  ScanNode,
} from "./plan";
import { validateLogicalQueryPlan } from "./validator";

const MAX_SHARED_RELATION_FIELDS = 4;

export const MAX_D1_JSON_MEMBERSHIP_BYTES = 1_000_000;

export interface PhysicalMembershipUsage {
  readonly expression: AnyInListExpression;
  readonly occurrences: number;
}

export interface PhysicalMembershipStrategy {
  readonly expression: AnyInListExpression;
  readonly occurrences: number;
  readonly strategy: "native" | "json-text";
  readonly jsonText?: string;
  readonly jsonUtf8Bytes?: number;
  readonly nativeBindingsSaved: number;
}

export interface PhysicalMembershipOptimization {
  readonly nativeBindingCount: number;
  readonly selectedBindingCount: number;
  readonly strategies: readonly PhysicalMembershipStrategy[];
}

export interface PhysicalMembershipOptimizationFacts {
  readonly nativeBindingCount: number;
  readonly usage: readonly PhysicalMembershipUsage[];
}

export interface SharedRelationDefinition {
  readonly name: string;
  readonly node: LogicalQueryNode;
  readonly scope: RelationScope;
  readonly fields: readonly OutputField[];
  /** Names of shared CTEs referenced by this CTE, in definition order. */
  readonly dependencies: readonly string[];
}

export interface DirectScanProjectionChoice {
  readonly project: ProjectNode;
  readonly scan: ScanNode;
  /** Actual schema SQL column names in the Project output order. */
  readonly sqlColumnNames: readonly string[];
}

export interface PhysicalQueryPlan<
  Row extends object = Record<string, unknown>,
> {
  readonly kind: "physical-query";
  readonly root: LogicalQueryNode;
  readonly scope: QuerySource["scope"];
  readonly fields: QuerySource["fields"];
  readonly sharedRelations: readonly SharedRelationDefinition[];
  /** Safe Project(Scan) column selections chosen by the physical planner. */
  readonly directScanProjections: readonly DirectScanProjectionChoice[];
  /** Backend physical choice, populated after final-shape cost analysis. */
  readonly membershipOptimization?: PhysicalMembershipOptimization;
  readonly __rowType?: Row;
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function encodedTextValues(
  expression: AnyInListExpression,
): { jsonText: string; jsonUtf8Bytes: number } | undefined {
  if (
    expression.values.length < 2 ||
    expression.expression.resultType.affinity !== "text" ||
    !expression.values.every(
      (value): value is string =>
        typeof value === "string" && hasWellFormedUtf16(value),
    )
  )
    return undefined;
  const jsonText = JSON.stringify(expression.values);
  const jsonUtf8Bytes = new TextEncoder().encode(jsonText).byteLength;
  return jsonUtf8Bytes <= MAX_D1_JSON_MEMBERSHIP_BYTES
    ? { jsonText, jsonUtf8Bytes }
    : undefined;
}

/** Select the generic D1 physical representation from measured final-shape costs. */
export function optimizePhysicalMembershipBudget<Row extends object>(
  plan: PhysicalQueryPlan<Row>,
  facts: PhysicalMembershipOptimizationFacts,
  bindingLimit: number,
): PhysicalQueryPlan<Row> {
  if (
    !Number.isInteger(facts.nativeBindingCount) ||
    facts.nativeBindingCount < 0 ||
    !Number.isInteger(bindingLimit) ||
    bindingLimit < 0
  )
    throw new DatabaseCompilerError(
      "invalid_plan",
      "Invalid physical membership budget facts",
    );

  const usage = facts.usage.map((item) => {
    if (!item || !item.expression || item.expression.kind !== "in-list")
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical membership expression facts",
      );
    if (!Number.isInteger(item.occurrences) || item.occurrences < 1)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Invalid physical membership occurrence count",
      );
    return item;
  });

  const savingsByExpression = new Map<AnyInListExpression, number>();
  const encodingByExpression = new Map<
    AnyInListExpression,
    { readonly jsonText: string; readonly jsonUtf8Bytes: number } | undefined
  >();
  let remaining = facts.nativeBindingCount;
  if (remaining > bindingLimit) {
    const candidates = usage
      .map((item, order) => ({
        ...item,
        order,
        saving: item.occurrences * (item.expression.values.length - 1),
      }))
      .filter((item) => item.saving > 0)
      .sort(
        (left, right) => right.saving - left.saving || left.order - right.order,
      );
    for (const candidate of candidates) {
      if (remaining <= bindingLimit) break;
      let encoding = encodingByExpression.get(candidate.expression);
      if (!encoding && !encodingByExpression.has(candidate.expression)) {
        encoding = encodedTextValues(candidate.expression);
        encodingByExpression.set(candidate.expression, encoding);
      }
      if (!encoding) continue;
      savingsByExpression.set(candidate.expression, candidate.saving);
      remaining -= candidate.saving;
    }
  }

  const strategies: PhysicalMembershipStrategy[] = usage.map((item) => {
    const nativeBindingsSaved = savingsByExpression.get(item.expression) ?? 0;
    if (nativeBindingsSaved === 0)
      return {
        expression: item.expression,
        occurrences: item.occurrences,
        strategy: "native",
        nativeBindingsSaved: 0,
      };
    const encoding = encodingByExpression.get(item.expression);
    if (!encoding)
      throw new DatabaseCompilerError(
        "invalid_plan",
        "Selected physical membership has no safe JSON encoding",
      );
    return {
      expression: item.expression,
      occurrences: item.occurrences,
      strategy: "json-text",
      jsonText: encoding.jsonText,
      jsonUtf8Bytes: encoding.jsonUtf8Bytes,
      nativeBindingsSaved,
    };
  });

  return {
    ...plan,
    membershipOptimization: {
      nativeBindingCount: facts.nativeBindingCount,
      selectedBindingCount: remaining,
      strategies,
    },
  };
}

export function hasSamePhysicalMembershipOptimization(
  actual: PhysicalMembershipOptimization | undefined,
  expected: PhysicalMembershipOptimization,
): boolean {
  if (
    !actual ||
    actual.nativeBindingCount !== expected.nativeBindingCount ||
    actual.selectedBindingCount !== expected.selectedBindingCount ||
    !Array.isArray(actual.strategies) ||
    actual.strategies.length !== expected.strategies.length
  )
    return false;
  return actual.strategies.every((item, index) => {
    const canonical = expected.strategies[index];
    return (
      !!item &&
      typeof item === "object" &&
      !!canonical &&
      item.expression === canonical.expression &&
      item.occurrences === canonical.occurrences &&
      item.strategy === canonical.strategy &&
      item.jsonText === canonical.jsonText &&
      item.jsonUtf8Bytes === canonical.jsonUtf8Bytes &&
      item.nativeBindingsSaved === canonical.nativeBindingsSaved
    );
  });
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
  const expectedDirectScanProjections = directScanProjectionChoices(plan.root);
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
    directScanProjections: directScanProjectionChoices(source.node),
  };
}

export function lowerLogicalPlan<
  Row extends object,
  Columns extends Readonly<Record<string, AnyExpression>>,
>(relation: Relation<Row, Columns>): PhysicalQueryPlan<Row> {
  return lowerLogicalQuerySource<Row>(relation);
}
