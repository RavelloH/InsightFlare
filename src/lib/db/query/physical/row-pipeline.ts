import type { SqlExpression } from "@/lib/db/query/expression";
import { isMaterializationSafeExpression } from "@/lib/db/query/materialization-safety";
import type {
  FilterNode,
  LogicalQueryNode,
  OutputField,
  ProjectNode,
  QuerySource,
} from "@/lib/db/query/plan";

export type PhysicalRowPipelineNode = FilterNode | ProjectNode;

export interface PhysicalRowPipelineFilter {
  readonly filter: FilterNode;
  /** For each filter-input field, its field index in the pipeline leaf. */
  readonly inputColumnIndexes: readonly number[];
  /** Leaf indexes read by this predicate, sorted and de-duplicated. */
  readonly predicateColumnIndexes: readonly number[];
}

/**
 * A single-use rendering of a pure column/filter segment. `nodes` is ordered
 * outermost-to-innermost and never contains the leaf node.
 */
export interface PhysicalRowPipelineChoice {
  readonly root: PhysicalRowPipelineNode;
  readonly leaf: QuerySource;
  readonly nodes: readonly PhysicalRowPipelineNode[];
  /** For each root output field, the equivalent field index in `leaf`. */
  readonly outputColumnIndexes: readonly number[];
  /** Filters in their original application order, innermost-first. */
  readonly filters: readonly PhysicalRowPipelineFilter[];
}

function sameFieldType(left: OutputField, right: OutputField): boolean {
  return left.affinity === right.affinity && left.nullable === right.nullable;
}

function columnMatchesSource(
  expression: Extract<SqlExpression, { readonly kind: "column" }>,
  source: QuerySource,
): boolean {
  const field = source.fields[expression.index];
  return (
    expression.scope === source.scope &&
    Number.isInteger(expression.index) &&
    expression.index >= 0 &&
    expression.index < source.fields.length &&
    field !== undefined &&
    expression.name === field.name &&
    expression.resultType.affinity === field.affinity &&
    expression.resultType.nullable === field.nullable
  );
}

function expressionUsesOnlySource(
  expression: SqlExpression,
  source: QuerySource,
): boolean {
  if (
    !isMaterializationSafeExpression(
      expression,
      new Map([[source.scope, source.fields.length]]),
    )
  )
    return false;

  const visit = (current: SqlExpression): boolean => {
    switch (current.kind) {
      case "column":
        return columnMatchesSource(current, source);
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
          (current.length === undefined || visit(current.length))
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
            ({ when, then }) => visit(when) && visit(then),
          ) &&
          (current.else === undefined || visit(current.else))
        );
      case "parameter":
      case "constant":
        return true;
      case "excluded":
      case "unixepoch":
      case "scalar-subquery":
      case "in-subquery":
        return false;
    }
  };

  return visit(expression);
}

function isPhysicalRowPipelineNode(
  node: LogicalQueryNode,
): node is PhysicalRowPipelineNode {
  return node.kind === "project" || node.kind === "filter";
}

function isValidPipelineNode(
  node: PhysicalRowPipelineNode,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
): boolean {
  if (sharedNodes.has(node)) return false;
  if (node.kind === "filter")
    return (
      node.fields.length === node.input.fields.length &&
      node.fields.every((field, index) => {
        const inputField = node.input.fields[index];
        return (
          inputField !== undefined &&
          field.name === inputField.name &&
          sameFieldType(field, inputField)
        );
      }) &&
      expressionUsesOnlySource(node.predicate, node.input)
    );

  return (
    node.projections.length === node.fields.length &&
    node.projections.every(({ name, expression }, index) => {
      const outputField = node.fields[index];
      if (
        !outputField ||
        name !== outputField.name ||
        expression.kind !== "column" ||
        !columnMatchesSource(expression, node.input)
      )
        return false;
      return sameFieldType(outputField, node.input.fields[expression.index]!);
    })
  );
}

function nodeSources(node: LogicalQueryNode): readonly QuerySource[] {
  switch (node.kind) {
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
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return [];
  }
  const exhaustive: never = node;
  return exhaustive;
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
      return node.windows.flatMap(({ specification }) =>
        specification.kind === "row-number"
          ? [
              ...specification.partitionBy,
              ...specification.orderBy.map(({ expression }) => expression),
            ]
          : [...specification.partitionBy],
      );
    case "sort":
      return node.keys.map(({ expression }) => expression);
    case "limit":
      return [node.count, ...(node.offset === undefined ? [] : [node.offset])];
    case "recursive-closure":
      return [node.predicate];
    case "distinct":
    case "union":
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return [];
  }
  const exhaustive: never = node;
  return exhaustive;
}

function visitExpressionQuerySources(
  expression: SqlExpression,
  visitSource: (source: QuerySource) => void,
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
      case "in-list":
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
        visitSource(current.query);
        break;
      case "in-subquery":
        visit(current.expression);
        visitSource(current.query);
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

function predicateColumnIndexes(
  expression: SqlExpression,
  input: QuerySource,
  inputColumnIndexes: readonly number[],
): readonly number[] | undefined {
  const indexes = new Set<number>();
  const visit = (current: SqlExpression): boolean => {
    switch (current.kind) {
      case "column": {
        if (!columnMatchesSource(current, input)) return false;
        const leafIndex = inputColumnIndexes[current.index];
        if (leafIndex === undefined) return false;
        indexes.add(leafIndex);
        return true;
      }
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
          (current.length === undefined || visit(current.length))
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
            ({ when, then }) => visit(when) && visit(then),
          ) &&
          (current.else === undefined || visit(current.else))
        );
      case "parameter":
      case "constant":
        return true;
      case "excluded":
      case "unixepoch":
      case "scalar-subquery":
      case "in-subquery":
        return false;
    }
  };
  return visit(expression)
    ? [...indexes].sort((left, right) => left - right)
    : undefined;
}

function rowPipelineForRoot(
  root: PhysicalRowPipelineNode,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
  reservedProjectRenderers: ReadonlySet<LogicalQueryNode>,
): PhysicalRowPipelineChoice | undefined {
  if (
    reservedProjectRenderers.has(root) ||
    !isValidPipelineNode(root, sharedNodes)
  )
    return undefined;
  const nodes: PhysicalRowPipelineNode[] = [];
  let current: LogicalQueryNode = root;
  let leaf: QuerySource | undefined;
  while (
    isPhysicalRowPipelineNode(current) &&
    isValidPipelineNode(current, sharedNodes)
  ) {
    nodes.push(current);
    leaf = current.input;
    if (
      sharedNodes.has(leaf.node) ||
      reservedProjectRenderers.has(leaf.node) ||
      !isPhysicalRowPipelineNode(leaf.node) ||
      !isValidPipelineNode(leaf.node, sharedNodes)
    )
      break;
    current = leaf.node;
  }
  if (!leaf || nodes.length < 2) return undefined;

  let columnIndexes = Array.from(
    { length: leaf.fields.length },
    (_unused, index) => index,
  );
  const filters: PhysicalRowPipelineFilter[] = [];
  for (const node of [...nodes].reverse()) {
    if (columnIndexes.length !== node.input.fields.length) return undefined;
    if (node.kind === "filter") {
      if (
        !node.fields.every((field, index) =>
          sameFieldType(field, leaf!.fields[columnIndexes[index]!]!),
        )
      )
        return undefined;
      const predicateIndexes = predicateColumnIndexes(
        node.predicate,
        node.input,
        columnIndexes,
      );
      if (!predicateIndexes) return undefined;
      filters.push({
        filter: node,
        inputColumnIndexes: [...columnIndexes],
        predicateColumnIndexes: predicateIndexes,
      });
      continue;
    }
    const nextIndexes: number[] = [];
    for (const { expression } of node.projections) {
      if (expression.kind !== "column") return undefined;
      const mapped = columnIndexes[expression.index];
      if (mapped === undefined) return undefined;
      nextIndexes.push(mapped);
    }
    columnIndexes = nextIndexes;
  }

  if (
    columnIndexes.length !== root.fields.length ||
    !root.fields.every((field, index) =>
      sameFieldType(field, leaf!.fields[columnIndexes[index]!]!),
    )
  )
    return undefined;

  return {
    root,
    leaf,
    nodes,
    outputColumnIndexes: columnIndexes,
    filters,
  };
}

export function rowPipelineChoices(
  root: LogicalQueryNode,
  sharedNodes: ReadonlySet<LogicalQueryNode>,
  reservedProjectRenderers: ReadonlySet<LogicalQueryNode>,
): readonly PhysicalRowPipelineChoice[] {
  const postorder: LogicalQueryNode[] = [];
  const visited = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    for (const source of nodeSources(node)) visit(source.node);
    for (const expression of nodeExpressions(node))
      visitExpressionQuerySources(expression, (source) => visit(source.node));
    postorder.push(node);
  };
  visit(root);

  const choices: PhysicalRowPipelineChoice[] = [];
  for (const node of postorder) {
    if (!isPhysicalRowPipelineNode(node)) continue;
    const choice = rowPipelineForRoot(
      node,
      sharedNodes,
      reservedProjectRenderers,
    );
    if (choice) choices.push(choice);
  }
  return choices;
}

function sameIndexes(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((index, offset) => index === right[offset])
  );
}

function sameFields(
  left: readonly OutputField[],
  right: readonly OutputField[],
): boolean {
  return (
    left.length === right.length &&
    left.every((field, index) => {
      const other = right[index];
      return (
        !!other &&
        field.name === other.name &&
        field.affinity === other.affinity &&
        field.nullable === other.nullable
      );
    })
  );
}

export function sameRowPipelineChoices(
  actual: readonly PhysicalRowPipelineChoice[],
  expected: readonly PhysicalRowPipelineChoice[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        choice.root === canonical.root &&
        choice.leaf.node === canonical.leaf.node &&
        choice.leaf.scope === canonical.leaf.scope &&
        sameFields(choice.leaf.fields, canonical.leaf.fields) &&
        choice.nodes.length === canonical.nodes.length &&
        choice.nodes.every(
          (node, nodeIndex) => node === canonical.nodes[nodeIndex],
        ) &&
        sameIndexes(
          choice.outputColumnIndexes,
          canonical.outputColumnIndexes,
        ) &&
        choice.filters.length === canonical.filters.length &&
        choice.filters.every((filter, filterIndex) => {
          const expectedFilter = canonical.filters[filterIndex];
          return (
            !!expectedFilter &&
            filter.filter === expectedFilter.filter &&
            sameIndexes(
              filter.inputColumnIndexes,
              expectedFilter.inputColumnIndexes,
            ) &&
            sameIndexes(
              filter.predicateColumnIndexes,
              expectedFilter.predicateColumnIndexes,
            )
          );
        })
      );
    })
  );
}

export function rowPipelineShape(choice: PhysicalRowPipelineChoice): {
  readonly nodeKinds: readonly ("filter" | "project")[];
  readonly outputColumnIndexes: readonly number[];
  readonly filterColumnIndexes: readonly (readonly number[])[];
} {
  return {
    nodeKinds: choice.nodes.map(({ kind }) => kind),
    outputColumnIndexes: choice.outputColumnIndexes,
    filterColumnIndexes: choice.filters.map(
      ({ predicateColumnIndexes }) => predicateColumnIndexes,
    ),
  };
}
