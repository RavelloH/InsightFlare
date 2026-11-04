import type { SqlExpression } from "@/lib/db/query/expression";
import type {
  LogicalQueryNode,
  QuerySource,
  ScanNode,
  UnionNode,
} from "@/lib/db/query/plan";

import type {
  PhysicalCatalogColumnOrigin,
  PhysicalDistinctUnionConsumerCertificate,
  PhysicalDistinctUnionConsumerEdge,
  PhysicalDistinctUnionFieldCertificate,
  PhysicalDistinctUnionJoinEquality,
  PhysicalSingletonRankBoundaryDependency,
  SharedRelationDefinition,
} from "./contracts";
import type { PhysicalSharedRelationBoundaryEvidence } from "./shared-relation-interfaces";

export type ConsumerEquivalenceResult =
  | {
      readonly passed: true;
      readonly certificate: PhysicalDistinctUnionConsumerCertificate;
      readonly boundaryDependencies: readonly PhysicalSingletonRankBoundaryDependency[];
    }
  | { readonly passed: false; readonly reason: string };

interface ParentEdge {
  readonly parent: LogicalQueryNode;
  readonly child: LogicalQueryNode;
  readonly kind: "relation" | "expression-query";
  readonly via: string;
}

export interface PhysicalParentIndex {
  readonly incoming: ReadonlyMap<LogicalQueryNode, readonly ParentEdge[]>;
}

interface ConsumerProofContext {
  readonly root: LogicalQueryNode;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly consumerProducer: LogicalQueryNode | null;
  readonly consumerProducerIndex: number;
  readonly parentIndex: PhysicalParentIndex;
}

interface CatalogOriginResult {
  readonly origin?: PhysicalCatalogColumnOrigin;
  readonly dependencies: readonly PhysicalSingletonRankBoundaryDependency[];
  readonly reason?: string;
}

type ConsumerPhase = "union" | "distinct" | "join";

function sameFields(
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

function sourceIsCurrent(source: QuerySource): boolean {
  return (
    source.scope === source.node.scope &&
    sameFields(source.fields, source.node.fields)
  );
}

function nodeChildren(node: LogicalQueryNode): QuerySource[] {
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

function expressionSources(expression: SqlExpression): readonly QuerySource[] {
  const result: QuerySource[] = [];
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
        current.branches.forEach(({ when, then }) => {
          visit(when);
          visit(then);
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
      case "constant":
        break;
    }
  };
  visit(expression);
  return result;
}

function relationVia(
  parent: LogicalQueryNode,
  child: LogicalQueryNode,
): string {
  switch (parent.kind) {
    case "filter":
    case "project":
    case "aggregate":
    case "distinct":
    case "window":
    case "sort":
    case "limit":
      return parent.input.node === child ? "input" : "unknown";
    case "join":
    case "semi-join":
    case "anti-join":
    case "union":
      return parent.left.node === child
        ? "left"
        : parent.right.node === child
          ? "right"
          : "unknown";
    case "recursive-closure":
      return parent.seed.node === child
        ? "seed"
        : parent.candidates.node === child
          ? "candidates"
          : "unknown";
    case "scan":
    case "values-relation":
    case "json-scalar-array":
      return "unknown";
  }
}

function parentIndex(root: LogicalQueryNode): PhysicalParentIndex {
  const incoming = new Map<LogicalQueryNode, ParentEdge[]>();
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (active.has(node)) throw new Error("physical_relation_cycle");
    if (visited.has(node)) return;
    active.add(node);
    const add = (
      child: LogicalQueryNode,
      kind: ParentEdge["kind"],
      via: string,
    ): void => {
      const edges = incoming.get(child) ?? [];
      edges.push({ parent: node, child, kind, via });
      incoming.set(child, edges);
      visit(child);
    };
    for (const source of nodeChildren(node))
      add(source.node, "relation", relationVia(node, source.node));
    for (const expression of nodeExpressions(node))
      for (const source of expressionSources(expression))
        add(source.node, "expression-query", "expression-query");
    active.delete(node);
    visited.add(node);
  };
  visit(root);
  return { incoming };
}

function boundaryDependency(
  node: LogicalQueryNode,
  context: Pick<
    ConsumerProofContext,
    "definitions" | "interfaces" | "consumerProducer" | "consumerProducerIndex"
  >,
): PhysicalSingletonRankBoundaryDependency | undefined {
  const producerIndex = context.definitions.findIndex(
    (definition) => definition.node === node,
  );
  if (producerIndex < 0) return undefined;
  const definition = context.definitions[producerIndex]!;
  const evidence = context.interfaces.get(node);
  if (
    definition.materialization !== "materialized" ||
    !evidence ||
    evidence.definition.name !== definition.name ||
    evidence.definition.node !== definition.node ||
    evidence.boundary.kind !== "materialized-relation" ||
    evidence.closure.kind !== "scope-and-exported-columns-closed" ||
    evidence.totality.kind !== "checked-through-current-boundaries" ||
    producerIndex >= context.consumerProducerIndex ||
    node === context.consumerProducer
  )
    return undefined;
  return {
    node,
    definitionName: definition.name,
    producerIndex,
    consumerProducer: context.consumerProducer,
    consumerProducerIndex: context.consumerProducerIndex,
  };
}

const scopeIds = new WeakMap<object, number>();
let nextScopeId = 0;

function scopeIdentity(scope: object): number {
  let id = scopeIds.get(scope);
  if (id === undefined) {
    id = nextScopeId++;
    scopeIds.set(scope, id);
  }
  return id;
}

function directCatalogOrigin(
  source: QuerySource,
  fieldIndex: number,
  context: ConsumerProofContext,
  active = new Set<string>(),
): CatalogOriginResult {
  if (!sourceIsCurrent(source))
    return {
      dependencies: [],
      reason: "catalog-lineage-source-metadata-mismatch",
    };
  if (
    !Number.isInteger(fieldIndex) ||
    fieldIndex < 0 ||
    fieldIndex >= source.fields.length
  )
    return {
      dependencies: [],
      reason: "catalog-lineage-field-index-out-of-range",
    };
  const node = source.node;
  const key = `${node.kind}:${fieldIndex}:${scopeIdentity(source.scope)}`;
  if (active.has(key))
    return { dependencies: [], reason: "catalog-lineage-cycle" };
  const next = new Set(active).add(key);
  const field = source.fields[fieldIndex]!;
  const dependencies: PhysicalSingletonRankBoundaryDependency[] = [];
  const definition = context.definitions.find(
    (candidate) => candidate.node === node,
  );
  if (definition?.materialization === "materialized") {
    const dependency = boundaryDependency(node, context);
    if (!dependency)
      return {
        dependencies: [],
        reason: "catalog-lineage-materialized-boundary-not-current",
      };
    dependencies.push(dependency);
  }

  if (node.kind === "scan") {
    if (node.table.kind !== "table")
      return { dependencies, reason: "catalog-origin-requires-real-table" };
    const columns = Object.values(node.table.columns);
    const matching = columns.filter(
      (column) =>
        column.sqlName === field.name || column.propertyName === field.name,
    );
    if (columns.length !== source.fields.length || matching.length !== 1)
      return { dependencies, reason: "scan-output-is-not-one-catalog-column" };
    const column = matching[0]!;
    if (
      (field.affinity !== "integer" && field.affinity !== "text") ||
      column.affinity !== field.affinity ||
      column.generated ||
      column.hidden !== 0 ||
      node.table.defaultCollation !== "BINARY"
    )
      return {
        dependencies,
        reason: "catalog-column-not-nongenerated-binary-integer-or-text",
      };
    return {
      origin: {
        scan: node as ScanNode,
        tableName: node.table.name,
        columnName: column.sqlName,
        affinity: field.affinity,
        collation: "BINARY",
      },
      dependencies,
    };
  }

  if (node.kind === "project") {
    const projection = node.projections[fieldIndex];
    const expression = projection?.expression;
    if (
      expression?.kind !== "column" ||
      expression.scope !== node.input.scope ||
      !Number.isInteger(expression.index) ||
      expression.index < 0 ||
      expression.index >= node.input.fields.length ||
      expression.name !== node.input.fields[expression.index]?.name ||
      expression.resultType.affinity !== field.affinity ||
      expression.resultType.nullable !== field.nullable ||
      projection.name !== field.name
    )
      return { dependencies, reason: "computed-or-misaligned-project-field" };
    const result = directCatalogOrigin(
      node.input,
      expression.index,
      context,
      next,
    );
    return {
      ...result,
      dependencies: [...dependencies, ...result.dependencies],
    };
  }

  if (node.kind === "filter" || node.kind === "distinct") {
    if (!sameFields(node.fields, node.input.fields))
      return { dependencies, reason: "pass-through-field-shape-mismatch" };
    const result = directCatalogOrigin(node.input, fieldIndex, context, next);
    return {
      ...result,
      dependencies: [...dependencies, ...result.dependencies],
    };
  }

  if (node.kind === "join") {
    if (fieldIndex < node.left.fields.length) {
      const child = node.left.fields[fieldIndex]!;
      if (
        field.name !== `left_${child.name}` ||
        field.affinity !== child.affinity ||
        field.nullable !== child.nullable
      )
        return { dependencies, reason: "join-left-field-identity-mismatch" };
      const result = directCatalogOrigin(node.left, fieldIndex, context, next);
      return {
        ...result,
        dependencies: [...dependencies, ...result.dependencies],
      };
    }
    if (node.joinType !== "inner")
      return {
        dependencies,
        reason: "outer-join-right-field-is-not-direct-catalog-value",
      };
    const rightIndex = fieldIndex - node.left.fields.length;
    const child = node.right.fields[rightIndex];
    if (
      !child ||
      field.name !== `right_${child.name}` ||
      field.affinity !== child.affinity ||
      field.nullable !== child.nullable
    )
      return { dependencies, reason: "join-right-field-identity-mismatch" };
    const result = directCatalogOrigin(node.right, rightIndex, context, next);
    return {
      ...result,
      dependencies: [...dependencies, ...result.dependencies],
    };
  }

  if (node.kind === "semi-join" || node.kind === "anti-join") {
    if (
      !sameFields(node.fields, node.left.fields) ||
      field.name !== node.left.fields[fieldIndex]?.name ||
      field.affinity !== node.left.fields[fieldIndex]?.affinity ||
      field.nullable !== node.left.fields[fieldIndex]?.nullable
    )
      return { dependencies, reason: "semi-anti-output-is-not-left-field" };
    const result = directCatalogOrigin(node.left, fieldIndex, context, next);
    return {
      ...result,
      dependencies: [...dependencies, ...result.dependencies],
    };
  }

  return { dependencies, reason: `catalog-lineage-unsupported-${node.kind}` };
}

function proveUnionFields(
  union: UnionNode,
  context: ConsumerProofContext,
): {
  readonly fields?: readonly PhysicalDistinctUnionFieldCertificate[];
  readonly dependencies?: readonly PhysicalSingletonRankBoundaryDependency[];
  readonly reason?: string;
} {
  if (
    union.all ||
    !sourceIsCurrent(union.left) ||
    !sourceIsCurrent(union.right) ||
    union.fields.length === 0 ||
    union.left.fields.length !== union.fields.length ||
    union.right.fields.length !== union.fields.length
  )
    return { reason: "requires-nonempty-current-distinct-union" };
  const fields: PhysicalDistinctUnionFieldCertificate[] = [];
  const dependencies: PhysicalSingletonRankBoundaryDependency[] = [];
  for (let index = 0; index < union.fields.length; index += 1) {
    const output = union.fields[index]!;
    const leftField = union.left.fields[index]!;
    const rightField = union.right.fields[index]!;
    if (
      output.name !== leftField.name ||
      output.name !== rightField.name ||
      (output.affinity !== "integer" && output.affinity !== "text") ||
      leftField.affinity !== output.affinity ||
      rightField.affinity !== output.affinity
    )
      return { reason: `union-field-position-or-affinity-mismatch:${index}` };
    const left = directCatalogOrigin(union.left, index, context);
    const right = directCatalogOrigin(union.right, index, context);
    if (!left.origin || !right.origin)
      return {
        reason:
          left.reason ??
          right.reason ??
          `union-field-catalog-origin-unproven:${index}`,
      };
    fields.push({
      index,
      name: output.name,
      affinity: output.affinity,
      leftOrigin: left.origin,
      rightOrigin: right.origin,
    });
    dependencies.push(...left.dependencies, ...right.dependencies);
  }
  return { fields, dependencies };
}

function identityProject(
  node: LogicalQueryNode,
  input: LogicalQueryNode,
): boolean {
  if (
    node.kind !== "project" ||
    node.input.node !== input ||
    !sourceIsCurrent(node.input) ||
    node.projections.length !== node.input.fields.length ||
    !sameFields(node.fields, node.input.fields)
  )
    return false;
  return node.projections.every(({ name, expression }, index) => {
    const field = node.input.fields[index];
    return (
      expression.kind === "column" &&
      expression.scope === node.input.scope &&
      expression.index === index &&
      expression.name === field?.name &&
      expression.resultType.affinity === field?.affinity &&
      expression.resultType.nullable === field?.nullable &&
      name === field?.name
    );
  });
}

function directJoinEqualities(
  join: Extract<LogicalQueryNode, { readonly kind: "join" }>,
):
  | readonly {
      leftIndex: number;
      rightIndex: number;
      leftField: QuerySource["fields"][number];
      rightField: QuerySource["fields"][number];
    }[]
  | undefined {
  const pairs: Array<{
    leftIndex: number;
    rightIndex: number;
    leftField: QuerySource["fields"][number];
    rightField: QuerySource["fields"][number];
  }> = [];
  const visit = (expression: SqlExpression): boolean => {
    if (expression.kind === "boolean" && expression.operator === "AND")
      return (
        expression.expressions.length > 0 && expression.expressions.every(visit)
      );
    if (
      expression.kind !== "binary" ||
      expression.operator !== "=" ||
      expression.left.kind !== "column" ||
      expression.right.kind !== "column"
    )
      return false;
    const left = expression.left;
    const right = expression.right;
    const leftOnLeft =
      left.scope === join.left.scope &&
      left.index >= 0 &&
      left.index < join.left.fields.length;
    const leftOnRight =
      left.scope === join.right.scope &&
      left.index >= 0 &&
      left.index < join.right.fields.length;
    const rightOnLeft =
      right.scope === join.left.scope &&
      right.index >= 0 &&
      right.index < join.left.fields.length;
    const rightOnRight =
      right.scope === join.right.scope &&
      right.index >= 0 &&
      right.index < join.right.fields.length;
    if (
      (!leftOnLeft && !leftOnRight) ||
      (!rightOnLeft && !rightOnRight) ||
      leftOnLeft === rightOnLeft ||
      leftOnRight === rightOnRight
    )
      return false;
    const leftField = leftOnLeft
      ? join.left.fields[left.index]
      : join.right.fields[left.index];
    const rightField = rightOnLeft
      ? join.left.fields[right.index]
      : join.right.fields[right.index];
    if (
      !leftField ||
      !rightField ||
      left.name !== leftField.name ||
      right.name !== rightField.name ||
      left.resultType.affinity !== leftField.affinity ||
      left.resultType.nullable !== leftField.nullable ||
      right.resultType.affinity !== rightField.affinity ||
      right.resultType.nullable !== rightField.nullable
    )
      return false;
    pairs.push({
      leftIndex: leftOnLeft ? left.index : right.index,
      rightIndex: leftOnRight ? left.index : right.index,
      leftField: leftOnLeft ? leftField : rightField,
      rightField: leftOnRight ? leftField : rightField,
    });
    return true;
  };
  return visit(join.condition) ? pairs : undefined;
}

function proveConsumerJoin(
  join: LogicalQueryNode,
  union: UnionNode,
  fields: readonly PhysicalDistinctUnionFieldCertificate[],
  context: ConsumerProofContext,
): {
  readonly equalities?: readonly PhysicalDistinctUnionJoinEquality[];
  readonly dependencies?: readonly PhysicalSingletonRankBoundaryDependency[];
  readonly reason?: string;
} {
  if (
    join.kind !== "join" ||
    join.joinType !== "inner" ||
    !sourceIsCurrent(join.left) ||
    !sourceIsCurrent(join.right) ||
    !sameFields(join.right.fields, union.fields) ||
    join.right.fields.length !== union.fields.length
  )
    return { reason: "union-distinct-not-complete-right-input-of-inner-join" };
  const pairs = directJoinEqualities(join);
  if (!pairs || pairs.length !== join.right.fields.length)
    return { reason: "join-condition-not-exact-right-key-equalities" };
  const seen = new Set<number>();
  const equalities: PhysicalDistinctUnionJoinEquality[] = [];
  const dependencies: PhysicalSingletonRankBoundaryDependency[] = [];
  for (const pair of pairs) {
    const { leftIndex, rightIndex } = pair;
    if (
      seen.has(rightIndex) ||
      rightIndex < 0 ||
      rightIndex >= join.right.fields.length
    )
      return { reason: "join-right-field-not-covered-exactly-once" };
    seen.add(rightIndex);
    const leftField = join.left.fields[leftIndex];
    const rightField = join.right.fields[rightIndex];
    const unionField = union.fields[rightIndex];
    if (
      !leftField ||
      !rightField ||
      pair.leftField !== leftField ||
      pair.rightField !== rightField ||
      !unionField ||
      leftField.affinity !== rightField.affinity ||
      rightField.affinity !== unionField.affinity ||
      (leftField.affinity !== "integer" && leftField.affinity !== "text")
    )
      return { reason: "join-field-affinity-or-union-position-mismatch" };
    const origin = directCatalogOrigin(join.left, leftIndex, context);
    const unionProof = fields[rightIndex];
    if (
      !origin.origin ||
      origin.origin.affinity !== rightField.affinity ||
      origin.origin.collation !== "BINARY" ||
      unionProof?.leftOrigin.collation !== "BINARY" ||
      unionProof?.rightOrigin.collation !== "BINARY"
    )
      return {
        reason:
          origin.reason ??
          "join-comparison-not-same-affinity-binary-catalog-columns",
      };
    dependencies.push(...origin.dependencies);
    equalities.push({
      leftIndex,
      rightIndex,
      affinity: leftField.affinity,
      leftOrigin: origin.origin,
    });
  }
  if (seen.size !== join.right.fields.length)
    return { reason: "join-does-not-cover-every-right-field" };
  return { equalities, dependencies };
}

function projectDropsJoinRight(
  project: LogicalQueryNode,
  join: LogicalQueryNode,
): project is Extract<LogicalQueryNode, { readonly kind: "project" }> {
  if (
    project.kind !== "project" ||
    join.kind !== "join" ||
    project.input.node !== join ||
    !sourceIsCurrent(project.input) ||
    project.projections.length !== project.fields.length
  )
    return false;
  return project.projections.every(({ name, expression }, index) => {
    const sourceField =
      expression.kind === "column" &&
      expression.index >= 0 &&
      expression.index < join.left.fields.length
        ? join.fields[expression.index]
        : undefined;
    const outputField = project.fields[index];
    return (
      expression.kind === "column" &&
      expression.scope === join.scope &&
      !!sourceField &&
      !!outputField &&
      expression.name === sourceField.name &&
      expression.resultType.affinity === sourceField.affinity &&
      expression.resultType.nullable === sourceField.nullable &&
      outputField.affinity === sourceField.affinity &&
      outputField.nullable === sourceField.nullable &&
      name === outputField.name
    );
  });
}

function currentSharedBoundaryDependency(
  node: LogicalQueryNode,
  context: ConsumerProofContext,
): PhysicalSingletonRankBoundaryDependency | undefined {
  const definition = context.definitions.find(
    (candidate) => candidate.node === node,
  );
  if (!definition) return undefined;
  return boundaryDependency(node, context);
}

/** Prove that every raw consumer of a DISTINCT UNION value reaches a safe drop. */
export function proveDistinctUnionConsumerEquivalence(input: {
  readonly root: LogicalQueryNode;
  readonly union: UnionNode;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly consumerProducer: LogicalQueryNode | null;
  readonly consumerProducerIndex: number;
  readonly index: PhysicalParentIndex;
}): ConsumerEquivalenceResult {
  const context: ConsumerProofContext = {
    ...input,
    parentIndex: input.index,
  };
  const unionProof = proveUnionFields(input.union, context);
  const unionFields = unionProof.fields;
  if (!unionFields)
    return {
      passed: false,
      reason: unionProof.reason ?? "union-field-proof-failed",
    };

  const consumerEdges: PhysicalDistinctUnionConsumerEdge[] = [];
  const joinEqualities: Array<{
    join: Extract<LogicalQueryNode, { readonly kind: "join" }>;
    equalities: readonly PhysicalDistinctUnionJoinEquality[];
  }> = [];
  const droppedBy = new Set<
    Extract<LogicalQueryNode, { readonly kind: "project" }>
  >();
  const dependencies = [...(unionProof.dependencies ?? [])];
  const active = new Set<string>();
  const nodeIds = new WeakMap<LogicalQueryNode, number>();
  let nextNodeId = 0;
  const nodeId = (node: LogicalQueryNode): number => {
    let id = nodeIds.get(node);
    if (id === undefined) {
      id = nextNodeId++;
      nodeIds.set(node, id);
    }
    return id;
  };

  const inspect = (
    current: LogicalQueryNode,
    phase: ConsumerPhase,
    passThroughs: number,
  ): { readonly passed: boolean; readonly reason?: string } => {
    if (current === input.root)
      return {
        passed: false,
        reason: "raw-union-reaches-query-root-before-drop",
      };
    const key = `${nodeId(current)}:${phase}:${passThroughs}`;
    if (active.has(key))
      return { passed: false, reason: "consumer-parent-cycle" };
    const boundary = currentSharedBoundaryDependency(current, context);
    if (
      context.definitions.some((definition) => definition.node === current) &&
      !boundary
    )
      return {
        passed: false,
        reason:
          "consumer-shared-node-lacks-current-materialized-interface-before-reader",
      };
    if (boundary) dependencies.push(boundary);

    const parents = input.index.incoming.get(current) ?? [];
    if (parents.length === 0)
      return {
        passed: false,
        reason: "consumer-value-has-uncovered-parent-root",
      };
    active.add(key);
    let reachesDrop = false;
    for (const edge of parents) {
      if (edge.kind !== "relation") {
        active.delete(key);
        return {
          passed: false,
          reason: "expression-query-edge-observes-raw-union-value",
        };
      }
      const parent = edge.parent;
      if (
        (phase === "union" || phase === "distinct") &&
        parent.kind === "project" &&
        edge.via === "input" &&
        passThroughs === 0 &&
        identityProject(parent, current)
      ) {
        consumerEdges.push({ parent, child: current, via: "input", phase });
        const result = inspect(parent, phase, passThroughs + 1);
        if (!result.passed) {
          active.delete(key);
          return result;
        }
        reachesDrop ||= result.passed;
        continue;
      }
      if (
        phase === "union" &&
        parent.kind === "distinct" &&
        edge.via === "input" &&
        parent.input.node === current &&
        sourceIsCurrent(parent.input) &&
        sameFields(parent.fields, current.fields)
      ) {
        consumerEdges.push({ parent, child: current, via: "input", phase });
        const result = inspect(parent, "distinct", 0);
        if (!result.passed) {
          active.delete(key);
          return result;
        }
        reachesDrop ||= result.passed;
        continue;
      }
      if (
        phase === "distinct" &&
        parent.kind === "join" &&
        parent.joinType === "inner" &&
        edge.via === "right" &&
        parent.right.node === current
      ) {
        const joinProof = proveConsumerJoin(
          parent,
          input.union,
          unionFields,
          context,
        );
        if (!joinProof.equalities) {
          active.delete(key);
          return {
            passed: false,
            reason: joinProof.reason ?? "consumer-join-proof-failed",
          };
        }
        dependencies.push(...(joinProof.dependencies ?? []));
        joinEqualities.push({ join: parent, equalities: joinProof.equalities });
        consumerEdges.push({ parent, child: current, via: "right", phase });
        const result = inspect(parent, "join", passThroughs);
        if (!result.passed) {
          active.delete(key);
          return result;
        }
        reachesDrop ||= result.passed;
        continue;
      }
      if (
        phase === "join" &&
        parent.kind === "project" &&
        edge.via === "input" &&
        parent.input.node === current &&
        projectDropsJoinRight(parent, current)
      ) {
        consumerEdges.push({ parent, child: current, via: "input", phase });
        droppedBy.add(parent);
        reachesDrop = true;
        continue;
      }
      active.delete(key);
      return {
        passed: false,
        reason:
          phase === "join"
            ? "join-parent-does-not-directly-drop-all-right-fields"
            : "consumer-path-not-distinct-inner-right-join-left-only-project",
      };
    }
    active.delete(key);
    return reachesDrop
      ? { passed: true }
      : {
          passed: false,
          reason: "consumer-path-does-not-reach-right-field-drop",
        };
  };

  const consumerResult = inspect(input.union, "union", 0);
  if (!consumerResult.passed)
    return {
      passed: false,
      reason: consumerResult.reason ?? "distinct-union-consumer-proof-failed",
    };

  const certificate: PhysicalDistinctUnionConsumerCertificate = {
    union: input.union,
    fields: unionProof.fields,
    consumerEdges,
    joinEqualities,
    droppedBy: [...droppedBy],
    representationLaw: "sqlite-union-distinct-affinity-neutral",
  };
  return {
    passed: true,
    certificate,
    boundaryDependencies: deduplicateDependencies(dependencies),
  };
}

export function buildPhysicalParentIndex(
  root: LogicalQueryNode,
): PhysicalParentIndex {
  return parentIndex(root);
}

export function collectPhysicalSubtreeNodes(
  root: LogicalQueryNode,
): ReadonlySet<LogicalQueryNode> {
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  const visit = (node: LogicalQueryNode): void => {
    if (active.has(node)) throw new Error("physical_relation_cycle");
    if (visited.has(node)) return;
    active.add(node);
    visited.add(node);
    for (const source of nodeChildren(node)) visit(source.node);
    for (const expression of nodeExpressions(node))
      for (const source of expressionSources(expression)) visit(source.node);
    active.delete(node);
  };
  visit(root);
  return visited;
}

export function deduplicateDependencies(
  dependencies: readonly PhysicalSingletonRankBoundaryDependency[],
): readonly PhysicalSingletonRankBoundaryDependency[] {
  const unique = new Map<string, PhysicalSingletonRankBoundaryDependency>();
  for (const dependency of dependencies) {
    const key = `${dependency.definitionName}:${dependency.producerIndex}:${dependency.consumerProducerIndex}`;
    if (!unique.has(key)) unique.set(key, dependency);
  }
  return [...unique.values()].sort(
    (left, right) =>
      left.producerIndex - right.producerIndex ||
      left.definitionName.localeCompare(right.definitionName),
  );
}

export function samePhysicalDistinctUnionConsumerCertificate(
  actual: PhysicalDistinctUnionConsumerCertificate,
  expected: PhysicalDistinctUnionConsumerCertificate,
): boolean {
  return (
    actual.union === expected.union &&
    actual.representationLaw === expected.representationLaw &&
    actual.fields.length === expected.fields.length &&
    actual.fields.every((field, index) => {
      const candidate = expected.fields[index];
      return (
        !!candidate &&
        field.index === candidate.index &&
        field.name === candidate.name &&
        field.affinity === candidate.affinity &&
        field.leftOrigin.scan === candidate.leftOrigin.scan &&
        field.leftOrigin.tableName === candidate.leftOrigin.tableName &&
        field.leftOrigin.columnName === candidate.leftOrigin.columnName &&
        field.leftOrigin.affinity === candidate.leftOrigin.affinity &&
        field.leftOrigin.collation === candidate.leftOrigin.collation &&
        field.rightOrigin.scan === candidate.rightOrigin.scan &&
        field.rightOrigin.tableName === candidate.rightOrigin.tableName &&
        field.rightOrigin.columnName === candidate.rightOrigin.columnName &&
        field.rightOrigin.affinity === candidate.rightOrigin.affinity &&
        field.rightOrigin.collation === candidate.rightOrigin.collation
      );
    }) &&
    actual.consumerEdges.length === expected.consumerEdges.length &&
    actual.consumerEdges.every((edge, index) => {
      const candidate = expected.consumerEdges[index];
      return (
        !!candidate &&
        edge.parent === candidate.parent &&
        edge.child === candidate.child &&
        edge.via === candidate.via &&
        edge.phase === candidate.phase
      );
    }) &&
    actual.joinEqualities.length === expected.joinEqualities.length &&
    actual.joinEqualities.every((proof, index) => {
      const candidate = expected.joinEqualities[index];
      return (
        !!candidate &&
        proof.join === candidate.join &&
        proof.equalities.length === candidate.equalities.length &&
        proof.equalities.every((equality, equalityIndex) => {
          const expectedEquality = candidate.equalities[equalityIndex];
          return (
            !!expectedEquality &&
            equality.leftIndex === expectedEquality.leftIndex &&
            equality.rightIndex === expectedEquality.rightIndex &&
            equality.affinity === expectedEquality.affinity &&
            equality.leftOrigin.scan === expectedEquality.leftOrigin.scan &&
            equality.leftOrigin.tableName ===
              expectedEquality.leftOrigin.tableName &&
            equality.leftOrigin.columnName ===
              expectedEquality.leftOrigin.columnName &&
            equality.leftOrigin.affinity ===
              expectedEquality.leftOrigin.affinity &&
            equality.leftOrigin.collation ===
              expectedEquality.leftOrigin.collation
          );
        })
      );
    }) &&
    actual.droppedBy.length === expected.droppedBy.length &&
    actual.droppedBy.every(
      (project, index) => project === expected.droppedBy[index],
    )
  );
}

export function samePhysicalSingletonRankBoundaryDependencies(
  actual: readonly PhysicalSingletonRankBoundaryDependency[],
  expected: readonly PhysicalSingletonRankBoundaryDependency[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((dependency, index) => {
      const candidate = expected[index];
      return (
        !!candidate &&
        dependency.node === candidate.node &&
        dependency.definitionName === candidate.definitionName &&
        dependency.producerIndex === candidate.producerIndex &&
        dependency.consumerProducer === candidate.consumerProducer &&
        dependency.consumerProducerIndex === candidate.consumerProducerIndex
      );
    })
  );
}
