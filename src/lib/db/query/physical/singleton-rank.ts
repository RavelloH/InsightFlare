import type { SqlExpression } from "@/lib/db/query/expression";
import {
  isMaterializationSafeNode,
  isMaterializationSafeProvenPartitionedRowNumberWindow,
} from "@/lib/db/query/materialization-safety";
import type {
  FilterNode,
  LogicalQueryNode,
  QuerySource,
  UnionNode,
  WindowNode,
} from "@/lib/db/query/plan";
import { analyzeRelationalKeyFacts } from "@/lib/db/query/relational-key-facts";

import {
  buildPhysicalParentIndex,
  deduplicateDependencies,
  proveDistinctUnionConsumerEquivalence,
  samePhysicalDistinctUnionConsumerCertificate,
  samePhysicalSingletonRankBoundaryDependencies,
} from "./consumer-equivalence";
import type {
  PhysicalDistinctUnionConsumerCertificate,
  PhysicalRowPipelineChoice,
  PhysicalSingletonRankBoundaryDependency,
  PhysicalSingletonRankChoice,
  PhysicalSingletonRankRenderContext,
  SharedRelationDefinition,
} from "./contracts";
import { sameRowPipelineChoices } from "./row-pipeline";
import type { PhysicalSharedRelationBoundaryEvidence } from "./shared-relation-interfaces";

type RenderChoiceContext = PhysicalSingletonRankRenderContext & {
  readonly node: LogicalQueryNode;
};

function sameFields(
  left: QuerySource["fields"],
  right: QuerySource["fields"],
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

function currentSource(source: QuerySource): boolean {
  return (
    source.scope === source.node.scope &&
    sameFields(source.fields, source.node.fields)
  );
}

function nodeChildren(node: LogicalQueryNode): readonly QuerySource[] {
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
}

function expressionSources(expression: SqlExpression): readonly QuerySource[] {
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
        sources.push(current.query);
        break;
      case "in-subquery":
        visit(current.expression);
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

function predicateIsRankOne(
  filter: FilterNode,
  window: WindowNode,
): number | undefined {
  if (filter.input.node !== window || !currentSource(filter.input))
    return undefined;
  const predicate = filter.predicate;
  if (predicate.kind !== "binary" || predicate.operator !== "=")
    return undefined;
  const rank =
    predicate.left.kind === "column" &&
    predicate.right.kind === "constant" &&
    predicate.right.value === 1 &&
    predicate.right.resultType.affinity === "integer" &&
    predicate.right.resultType.nullable === false
      ? predicate.left
      : predicate.right.kind === "column" &&
          predicate.left.kind === "constant" &&
          predicate.left.value === 1 &&
          predicate.left.resultType.affinity === "integer" &&
          predicate.left.resultType.nullable === false
        ? predicate.right
        : undefined;
  if (!rank || rank.scope !== filter.input.scope) return undefined;
  const rankField = filter.input.fields[rank.index];
  if (
    !Number.isInteger(rank.index) ||
    rank.index < 0 ||
    rank.index >= filter.input.fields.length ||
    !rankField ||
    rank.name !== rankField.name ||
    rank.resultType.affinity !== "integer" ||
    rank.resultType.nullable !== false ||
    rankField.affinity !== "integer" ||
    rankField.nullable !== false
  )
    return undefined;
  const windowIndex = rank.index - window.input.fields.length;
  const descriptor = window.windows[windowIndex];
  return descriptor?.specification.kind === "row-number" &&
    descriptor.name === rankField.name &&
    window.fields[rank.index]?.name === rankField.name
    ? rank.index
    : undefined;
}

function directPartitionColumns(
  window: WindowNode,
): readonly number[] | undefined {
  const specification = window.windows[0]?.specification;
  if (!specification || specification.kind !== "row-number") return undefined;
  const columns = new Set<number>();
  for (const expression of specification.partitionBy) {
    if (
      expression.kind !== "column" ||
      expression.scope !== window.input.scope ||
      !Number.isInteger(expression.index) ||
      expression.index < 0 ||
      expression.index >= window.input.fields.length
    )
      return undefined;
    const field = window.input.fields[expression.index];
    if (
      !field ||
      expression.name !== field.name ||
      expression.resultType.affinity !== field.affinity ||
      expression.resultType.nullable !== field.nullable
    )
      return undefined;
    columns.add(expression.index);
  }
  return [...columns].sort((left, right) => left - right);
}

function singletonKey(
  window: WindowNode,
  partitionColumns: readonly number[],
):
  | {
      readonly keyFields: readonly number[];
      readonly keyCollations: readonly "BINARY"[];
      readonly requiredNonNullFields: readonly number[];
    }
  | undefined {
  if (
    !currentSource(window.input) ||
    window.fields.length !==
      window.input.fields.length + window.windows.length ||
    !window.input.fields.every((field, index) => {
      const output = window.fields[index];
      return (
        !!output &&
        field.name === output.name &&
        field.affinity === output.affinity &&
        field.nullable === output.nullable
      );
    })
  )
    return undefined;
  const partition = new Set(partitionColumns);
  if (partition.size === 0) return undefined;
  const facts = analyzeRelationalKeyFacts(window.input);
  const candidate = facts.keys.find(
    (key) =>
      key.fields.length > 0 &&
      key.fields.length === key.collations.length &&
      key.fields.length === key.lookupContracts.length &&
      new Set(key.fields).size === key.fields.length &&
      key.fields.every(
        (field, index) =>
          partition.has(field) &&
          field >= 0 &&
          field < window.input.fields.length &&
          key.collations[index] === "BINARY" &&
          facts.fieldCollations[field] === "BINARY",
      ) &&
      key.requiredNonNull.every((field) => facts.nonNullFields.has(field)),
  );
  if (!candidate) return undefined;
  return {
    keyFields: [...candidate.fields],
    keyCollations: candidate.fields.map(() => "BINARY" as const),
    requiredNonNullFields: [...candidate.requiredNonNull],
  };
}

function reachableRenderContexts(input: {
  readonly root: LogicalQueryNode;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly rowPipelines: readonly PhysicalRowPipelineChoice[];
}): ReadonlyMap<LogicalQueryNode, readonly RenderChoiceContext[]> {
  const shared = new Set(input.definitions.map(({ node }) => node));
  const choices = new Map<LogicalQueryNode, PhysicalRowPipelineChoice>(
    input.rowPipelines.map((choice) => [choice.root, choice] as const),
  );
  const contexts = new Map<LogicalQueryNode, RenderChoiceContext[]>();
  const traverse = (
    start: LogicalQueryNode,
    producer: LogicalQueryNode | null,
    producerIndex: number,
  ): void => {
    const visited = new Set<LogicalQueryNode>();
    const active = new Set<LogicalQueryNode>();
    const visit = (node: LogicalQueryNode): void => {
      if (active.has(node)) return;
      if (visited.has(node)) return;
      if (shared.has(node) && node !== producer) return;
      active.add(node);
      const choice = choices.get(node);
      if (choice) {
        const found = contexts.get(node) ?? [];
        if (
          !found.some(
            (context) =>
              context.producer === producer &&
              context.producerIndex === producerIndex,
          )
        )
          found.push({ producer, producerIndex, node });
        contexts.set(node, found);
        visit(choice.leaf.node);
      } else {
        for (const source of nodeChildren(node)) visit(source.node);
        for (const expression of nodeExpressions(node))
          for (const source of expressionSources(expression))
            visit(source.node);
      }
      active.delete(node);
      visited.add(node);
    };
    visit(start);
  };
  for (const [producerIndex, definition] of input.definitions.entries())
    traverse(definition.node, definition.node, producerIndex);
  traverse(input.root, null, input.definitions.length);
  return contexts;
}

function materializedBoundaryDependency(
  node: LogicalQueryNode,
  context: PhysicalSingletonRankRenderContext,
  definitions: readonly SharedRelationDefinition[],
  interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >,
): PhysicalSingletonRankBoundaryDependency | undefined {
  const producerIndex = definitions.findIndex(
    (definition) => definition.node === node,
  );
  if (producerIndex < 0) return undefined;
  const definition = definitions[producerIndex]!;
  const evidence = interfaces.get(node);
  if (
    definition.materialization !== "materialized" ||
    !evidence ||
    evidence.definition.name !== definition.name ||
    evidence.definition.node !== node ||
    evidence.boundary.kind !== "materialized-relation" ||
    evidence.closure.kind !== "scope-and-exported-columns-closed" ||
    evidence.totality.kind !== "checked-through-current-boundaries" ||
    producerIndex >= context.producerIndex ||
    context.producer === node
  )
    return undefined;
  return {
    node,
    definitionName: definition.name,
    producerIndex,
    consumerProducer: context.producer,
    consumerProducerIndex: context.producerIndex,
  };
}

function proveCandidate(input: {
  readonly root: LogicalQueryNode;
  readonly window: WindowNode;
  readonly context: PhysicalSingletonRankRenderContext;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly parentIndex: ReturnType<typeof buildPhysicalParentIndex>;
}): {
  readonly safe: boolean;
  readonly certificates: readonly PhysicalDistinctUnionConsumerCertificate[];
  readonly dependencies: readonly PhysicalSingletonRankBoundaryDependency[];
} {
  const dependencies: PhysicalSingletonRankBoundaryDependency[] = [];
  const certificates: PhysicalDistinctUnionConsumerCertificate[] = [];
  const visited = new Set<LogicalQueryNode>();
  const active = new Set<LogicalQueryNode>();
  let safe = true;
  const visit = (node: LogicalQueryNode): void => {
    if (!safe || active.has(node) || visited.has(node)) {
      if (active.has(node)) safe = false;
      return;
    }
    const definition = input.definitions.find(
      (candidate) => candidate.node === node,
    );
    if (definition?.materialization === "materialized") {
      const dependency = materializedBoundaryDependency(
        node,
        input.context,
        input.definitions,
        input.interfaces,
      );
      if (!dependency) {
        safe = false;
        return;
      }
      dependencies.push(dependency);
      return;
    }
    if (!isMaterializationSafeNode(node)) {
      safe = false;
      return;
    }
    if (
      node.kind === "sort" ||
      node.kind === "limit" ||
      node.kind === "window" ||
      node.kind === "recursive-closure"
    ) {
      safe = false;
      return;
    }
    active.add(node);
    if (node.kind === "union" && !node.all) {
      const consumer = proveDistinctUnionConsumerEquivalence({
        root: input.root,
        union: node as UnionNode,
        definitions: input.definitions,
        interfaces: input.interfaces,
        consumerProducer: input.context.producer,
        consumerProducerIndex: input.context.producerIndex,
        index: input.parentIndex,
      });
      if (!consumer.passed) {
        safe = false;
        active.delete(node);
        return;
      }
      certificates.push(consumer.certificate);
      dependencies.push(...consumer.boundaryDependencies);
    }
    for (const source of nodeChildren(node)) visit(source.node);
    active.delete(node);
    if (safe) visited.add(node);
  };
  visit(input.window.input.node);
  return {
    safe,
    certificates,
    dependencies: deduplicateDependencies(dependencies),
  };
}

function rankOneCandidates(pipeline: PhysicalRowPipelineChoice): readonly {
  readonly filter: FilterNode;
  readonly rankOutputIndex: number;
  readonly window: WindowNode;
}[] {
  if (pipeline.leaf.node.kind !== "window") return [];
  const window = pipeline.leaf.node;
  if (
    window.windows.length !== 1 ||
    window.windows[0]?.specification.kind !== "row-number" ||
    !isMaterializationSafeProvenPartitionedRowNumberWindow(window) ||
    pipeline.leaf.scope !== window.scope ||
    !sameFields(pipeline.leaf.fields, window.fields)
  )
    return [];
  const candidates: Array<{
    readonly filter: FilterNode;
    readonly rankOutputIndex: number;
    readonly window: WindowNode;
  }> = [];
  for (const filter of pipeline.filters) {
    const rankOutputIndex = predicateIsRankOne(filter.filter, window);
    if (rankOutputIndex === undefined) continue;
    if (
      filter.inputColumnIndexes[rankOutputIndex] !== rankOutputIndex ||
      !pipeline.nodes.includes(filter.filter)
    )
      continue;
    candidates.push({ filter: filter.filter, rankOutputIndex, window });
  }
  return candidates;
}

export function analyzeSingletonRankChoices(input: {
  readonly root: LogicalQueryNode;
  readonly definitions: readonly SharedRelationDefinition[];
  readonly interfaces: ReadonlyMap<
    LogicalQueryNode,
    PhysicalSharedRelationBoundaryEvidence
  >;
  readonly rowPipelines: readonly PhysicalRowPipelineChoice[];
}): readonly PhysicalSingletonRankChoice[] {
  const parentIndex = buildPhysicalParentIndex(input.root);
  const renderContexts = reachableRenderContexts(input);
  const output: PhysicalSingletonRankChoice[] = [];
  for (const pipeline of input.rowPipelines) {
    for (const candidate of rankOneCandidates(pipeline)) {
      const partitionColumnIndexes = directPartitionColumns(candidate.window);
      if (!partitionColumnIndexes) continue;
      const key = singletonKey(candidate.window, partitionColumnIndexes);
      if (!key) continue;
      const contexts = renderContexts.get(pipeline.root) ?? [];
      if (contexts.length === 0) continue;
      const certificates: PhysicalDistinctUnionConsumerCertificate[] = [];
      const dependencies: PhysicalSingletonRankBoundaryDependency[] = [];
      let allContextsSafe = true;
      for (const context of contexts) {
        const proof = proveCandidate({
          root: input.root,
          window: candidate.window,
          context,
          definitions: input.definitions,
          interfaces: input.interfaces,
          parentIndex,
        });
        if (!proof.safe) {
          allContextsSafe = false;
          break;
        }
        for (const certificate of proof.certificates) {
          const prior = certificates.find(
            (value) => value.union === certificate.union,
          );
          if (
            prior &&
            !samePhysicalDistinctUnionConsumerCertificate(prior, certificate)
          ) {
            allContextsSafe = false;
            break;
          }
          if (!prior) certificates.push(certificate);
        }
        if (!allContextsSafe) break;
        dependencies.push(...proof.dependencies);
      }
      if (!allContextsSafe) continue;
      output.push({
        pipeline,
        filter: candidate.filter,
        window: candidate.window,
        rankOutputIndex: candidate.rankOutputIndex,
        partitionColumnIndexes,
        keyFields: key.keyFields,
        keyCollations: key.keyCollations,
        requiredNonNullFields: key.requiredNonNullFields,
        consumerCertificates: certificates,
        boundaryDependencies: deduplicateDependencies(dependencies),
        renderContexts: contexts.map(({ producer, producerIndex }) => ({
          producer,
          producerIndex,
        })),
      });
    }
  }
  return output;
}

function sameNumbers(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameStrings<T extends string>(
  left: readonly T[],
  right: readonly T[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function exactDataKeys(value: unknown, keys: readonly string[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    const ownKeys = Reflect.ownKeys(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    )
      return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function denseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (!descriptor || !("value" in descriptor)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function exactPipelineShape(value: unknown): boolean {
  if (
    !exactDataKeys(value, [
      "root",
      "leaf",
      "nodes",
      "outputColumnIndexes",
      "filters",
    ])
  )
    return false;
  const pipeline = value as PhysicalRowPipelineChoice;
  if (
    !exactDataKeys(pipeline.leaf, ["node", "scope", "fields"]) ||
    !denseArray(pipeline.leaf.fields) ||
    !denseArray(pipeline.nodes) ||
    !denseArray(pipeline.outputColumnIndexes) ||
    !denseArray(pipeline.filters)
  )
    return false;
  return pipeline.filters.every(
    (filter) =>
      exactDataKeys(filter, [
        "filter",
        "inputColumnIndexes",
        "predicateColumnIndexes",
      ]) &&
      denseArray(filter.inputColumnIndexes) &&
      denseArray(filter.predicateColumnIndexes),
  );
}

function exactCatalogOriginShape(value: unknown): boolean {
  return exactDataKeys(value, [
    "scan",
    "tableName",
    "columnName",
    "affinity",
    "collation",
  ]);
}

function exactConsumerCertificateShape(value: unknown): boolean {
  if (
    !exactDataKeys(value, [
      "union",
      "fields",
      "consumerEdges",
      "joinEqualities",
      "droppedBy",
      "representationLaw",
    ])
  )
    return false;
  const certificate = value as PhysicalDistinctUnionConsumerCertificate;
  if (
    !denseArray(certificate.fields) ||
    !denseArray(certificate.consumerEdges) ||
    !denseArray(certificate.joinEqualities) ||
    !denseArray(certificate.droppedBy)
  )
    return false;
  return (
    certificate.fields.every(
      (field) =>
        exactDataKeys(field, [
          "index",
          "name",
          "affinity",
          "leftOrigin",
          "rightOrigin",
        ]) &&
        exactCatalogOriginShape(field.leftOrigin) &&
        exactCatalogOriginShape(field.rightOrigin),
    ) &&
    certificate.consumerEdges.every((edge) =>
      exactDataKeys(edge, ["parent", "child", "via", "phase"]),
    ) &&
    certificate.joinEqualities.every(
      (proof) =>
        exactDataKeys(proof, ["join", "equalities"]) &&
        denseArray(proof.equalities) &&
        proof.equalities.every(
          (equality) =>
            exactDataKeys(equality, [
              "leftIndex",
              "rightIndex",
              "affinity",
              "leftOrigin",
            ]) && exactCatalogOriginShape(equality.leftOrigin),
        ),
    )
  );
}

function exactSingletonChoiceShape(
  value: unknown,
): value is PhysicalSingletonRankChoice {
  if (
    !exactDataKeys(value, [
      "pipeline",
      "filter",
      "window",
      "rankOutputIndex",
      "partitionColumnIndexes",
      "keyFields",
      "keyCollations",
      "requiredNonNullFields",
      "consumerCertificates",
      "boundaryDependencies",
      "renderContexts",
    ])
  )
    return false;
  const choice = value as PhysicalSingletonRankChoice;
  return (
    exactPipelineShape(choice.pipeline) &&
    denseArray(choice.partitionColumnIndexes) &&
    denseArray(choice.keyFields) &&
    denseArray(choice.keyCollations) &&
    denseArray(choice.requiredNonNullFields) &&
    denseArray(choice.consumerCertificates) &&
    choice.consumerCertificates.every(exactConsumerCertificateShape) &&
    denseArray(choice.boundaryDependencies) &&
    choice.boundaryDependencies.every((dependency) =>
      exactDataKeys(dependency, [
        "node",
        "definitionName",
        "producerIndex",
        "consumerProducer",
        "consumerProducerIndex",
      ]),
    ) &&
    denseArray(choice.renderContexts) &&
    choice.renderContexts.every((context) =>
      exactDataKeys(context, ["producer", "producerIndex"]),
    )
  );
}

function sameRenderContexts(
  left: readonly PhysicalSingletonRankRenderContext[],
  right: readonly PhysicalSingletonRankRenderContext[],
): boolean {
  return (
    left.length === right.length &&
    left.every((context, index) => {
      const expected = right[index];
      return (
        !!expected &&
        context.producer === expected.producer &&
        context.producerIndex === expected.producerIndex
      );
    })
  );
}

export function sameSingletonRankChoices(
  actual: readonly PhysicalSingletonRankChoice[],
  expected: readonly PhysicalSingletonRankChoice[],
): boolean {
  if (
    !denseArray(actual) ||
    !denseArray(expected) ||
    !actual.every(exactSingletonChoiceShape)
  )
    return false;
  return (
    actual.length === expected.length &&
    actual.every((choice, index) => {
      const canonical = expected[index];
      return (
        !!canonical &&
        sameRowPipelineChoices([choice.pipeline], [canonical.pipeline]) &&
        choice.filter === canonical.filter &&
        choice.window === canonical.window &&
        choice.rankOutputIndex === canonical.rankOutputIndex &&
        sameNumbers(
          choice.partitionColumnIndexes,
          canonical.partitionColumnIndexes,
        ) &&
        sameNumbers(choice.keyFields, canonical.keyFields) &&
        sameStrings(choice.keyCollations, canonical.keyCollations) &&
        sameNumbers(
          choice.requiredNonNullFields,
          canonical.requiredNonNullFields,
        ) &&
        choice.consumerCertificates.length ===
          canonical.consumerCertificates.length &&
        choice.consumerCertificates.every((certificate, certificateIndex) => {
          const expectedCertificate =
            canonical.consumerCertificates[certificateIndex];
          return (
            !!expectedCertificate &&
            samePhysicalDistinctUnionConsumerCertificate(
              certificate,
              expectedCertificate,
            )
          );
        }) &&
        samePhysicalSingletonRankBoundaryDependencies(
          choice.boundaryDependencies,
          canonical.boundaryDependencies,
        ) &&
        sameRenderContexts(choice.renderContexts, canonical.renderContexts)
      );
    })
  );
}
