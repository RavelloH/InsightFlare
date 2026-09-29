import type {
  LogicalExpressionHandle,
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "./logical/builder";
import type { LogicalValueType } from "./logical/slots";
import {
  assertMetricCatalogValid,
  type AtomicMetricDefinition,
  semanticMetric,
  semanticMetricCatalog,
  type SemanticMetricDefinition,
  type SemanticMetricId,
} from "./semantic/metrics";
import type { EligibleDatasetResolver } from "./eligible-dataset";
import type { PlannedGrouping } from "./grouping";
import {
  groupingFieldDescriptors,
  metricDimensionCapability,
  validatePlannedGrouping,
} from "./grouping";

export interface MetricDependencyPlan {
  readonly requested: readonly SemanticMetricId[];
  readonly closure: readonly SemanticMetricId[];
  readonly atomic: readonly AtomicMetricDefinition[];
  readonly derivedOrder: readonly Extract<
    SemanticMetricDefinition,
    { kind: "derived" }
  >[];
}

export class MetricPlanningError extends Error {
  readonly metric: SemanticMetricId;

  constructor(metric: SemanticMetricId, message: string) {
    super(message);
    this.name = "MetricPlanningError";
    this.metric = metric;
  }
}

/** Resolves dependencies only; it has no filter, scope, provider, or database inputs. */
export function resolveMetricDependencies(
  requested: readonly SemanticMetricId[],
): MetricDependencyPlan {
  assertMetricCatalogValid();
  const selected = [...new Set(requested)].sort((left, right) =>
    left.localeCompare(right),
  );
  const visiting = new Set<SemanticMetricId>();
  const visited = new Set<SemanticMetricId>();
  const ordered: SemanticMetricDefinition[] = [];

  const visit = (id: SemanticMetricId): void => {
    const metric = semanticMetric(id);
    if (!metric)
      throw new MetricPlanningError(id, `Metric ${id} is not registered.`);
    if (visiting.has(id))
      throw new MetricPlanningError(
        id,
        `Metric dependency cycle includes ${id}.`,
      );
    if (visited.has(id)) return;
    visiting.add(id);
    if (metric.kind === "derived") {
      for (const dependency of [...metric.dependencies].sort((left, right) =>
        left.localeCompare(right),
      )) {
        visit(dependency);
      }
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(metric);
  };

  selected.forEach(visit);
  const atomic = ordered
    .filter(
      (metric): metric is AtomicMetricDefinition => metric.kind === "atomic",
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const derivedOrder = ordered.filter(
    (
      metric,
    ): metric is Extract<SemanticMetricDefinition, { kind: "derived" }> =>
      metric.kind === "derived",
  );
  return Object.freeze({
    requested: Object.freeze(selected),
    closure: Object.freeze(ordered.map((metric) => metric.id)),
    atomic: Object.freeze(atomic),
    derivedOrder: Object.freeze(derivedOrder),
  });
}

export function allCanonicalMetricIds(): readonly SemanticMetricId[] {
  return Object.freeze(semanticMetricCatalog.map((metric) => metric.id));
}

export interface PlannedMetricRelation {
  readonly relation: LogicalRelationHandle;
  readonly metrics: ReadonlyMap<SemanticMetricId, string>;
  readonly dimensions: ReadonlyMap<string, string>;
  readonly timeBucket?: string;
  readonly dependencies: MetricDependencyPlan;
}

function numericLiteralType(
  valueType: LogicalValueType,
): Extract<LogicalValueType, { kind: "scalar" }> {
  if (valueType.kind !== "scalar" || valueType.scalar !== "number") {
    throw new Error("metric_requires_numeric_value_type");
  }
  return valueType;
}

function associationGroupSlots(
  association: LogicalRelationHandle,
  grouping: PlannedGrouping,
): readonly { readonly id: string; readonly slotName: string }[] {
  return groupingFieldDescriptors(grouping).map((field) => {
    if (association.slots[field.associationName] === undefined) {
      throw new Error(`metric_association_missing_dimension:${field.key}`);
    }
    return { id: field.key, slotName: field.associationName };
  });
}

function groupedAtomicBranch(
  builder: LogicalPlanBuilder,
  dataset: EligibleDatasetResolver,
  grouping: PlannedGrouping,
  metric: AtomicMetricDefinition,
): LogicalRelationHandle {
  const measure = metric.measure;
  if (measure.kind === "session-bounce-count") {
    throw new Error(`metric_grouping_not_supported:${metric.id}`);
  }
  const entity = measure.entity;
  const association = dataset.association(
    entity,
    grouping,
    metric.timeGroupingPolicy,
  );
  const dimensions = associationGroupSlots(association, grouping);
  const entityName = "entity";
  if (association.slots[entityName] === undefined) {
    throw new Error(`metric_association_missing_entity:${entity}`);
  }
  let distinctInput = association;
  let distinctKeys = [
    ...dimensions.map((dimension) => ({ input: dimension.slotName })),
    { input: entityName },
  ];
  if (
    measure.kind === "valid-attribute-sum" ||
    measure.kind === "valid-attribute-count"
  ) {
    const attributeName = `attribute:${measure.attribute}`;
    const attributeValue = builder.slot(association, attributeName);
    const valid = builder.compare(
      "gte",
      attributeValue,
      builder.literal(0, numericLiteralType(attributeValue.type)),
    );
    distinctInput = builder.filter(association, valid);
    distinctKeys = [
      ...dimensions.map((dimension) => ({ input: dimension.slotName })),
      { input: entityName },
      { input: attributeName },
    ];
  }
  const distinct = builder.distinct(distinctInput, distinctKeys);
  const groups = Object.fromEntries(
    dimensions.map((dimension) => [
      dimension.slotName,
      builder.slot(distinct, dimension.slotName),
    ]),
  );
  const count =
    measure.kind === "entity-count" || measure.kind === "valid-attribute-count";
  const measures = count
    ? [{ name: metric.id, kind: "count-rows" as const }]
    : [
        {
          name: metric.id,
          kind: "sum" as const,
          expression: builder.slot(distinct, `attribute:${measure.attribute}`),
        },
      ];
  return builder.aggregate(distinct, groups, measures);
}

function ungroupedAtomicBranch(
  builder: LogicalPlanBuilder,
  dataset: EligibleDatasetResolver,
  metric: AtomicMetricDefinition,
): LogicalRelationHandle {
  const measure = metric.measure;
  if (measure.kind === "entity-count") {
    const input = dataset.relation(measure.entity);
    return builder.aggregate(input, {}, [
      { name: metric.id, kind: "count-rows" },
    ]);
  }
  if (measure.kind === "session-bounce-count") {
    const pages = dataset.relation("page");
    const session = builder.slot(pages, "relationship:page.session");
    const withSession = builder.filter(pages, builder.isNull(session, true));
    const bySession = builder.aggregate(withSession, { session }, [
      { name: "pageCount", kind: "count-rows" },
    ]);
    const singleton = builder.filter(
      bySession,
      builder.compare(
        "eq",
        builder.slot(bySession, "pageCount"),
        builder.literal(1, { kind: "scalar", scalar: "number" }),
      ),
    );
    return builder.aggregate(singleton, {}, [
      { name: metric.id, kind: "count-rows" },
    ]);
  }

  const pages = dataset.relation(measure.entity);
  const value = builder.slot(pages, `attribute:${measure.attribute}`);
  const valid = builder.compare(
    "gte",
    value,
    builder.literal(0, numericLiteralType(value.type)),
  );
  const filtered = builder.filter(pages, valid);
  if (measure.kind === "valid-attribute-count") {
    return builder.aggregate(filtered, {}, [
      { name: metric.id, kind: "count-rows" },
    ]);
  }
  const aggregate = builder.aggregate(filtered, {}, [
    {
      name: metric.id,
      kind: "sum",
      expression: builder.slot(filtered, `attribute:${measure.attribute}`),
    },
  ]);
  const sum = builder.slot(aggregate, metric.id);
  return builder.project(aggregate, {
    [metric.id]: builder.coalesce(
      sum,
      builder.literal(0, numericLiteralType(metric.valueType)),
    ),
  });
}

function formulaExpression(
  builder: LogicalPlanBuilder,
  relation: LogicalRelationHandle,
  metric: Extract<SemanticMetricDefinition, { kind: "derived" }>,
  formula: Extract<SemanticMetricDefinition, { kind: "derived" }>["formula"],
): LogicalExpressionHandle {
  switch (formula.kind) {
    case "metric-reference": {
      const name =
        relation.slots[`metric:${formula.metric}`] !== undefined
          ? `metric:${formula.metric}`
          : formula.metric;
      return builder.slot(relation, name);
    }
    case "literal":
      return builder.literal(
        formula.value,
        numericLiteralType(metric.valueType),
      );
    case "add":
      return builder.arithmetic(
        "add",
        formulaExpression(builder, relation, metric, formula.left),
        formulaExpression(builder, relation, metric, formula.right),
      );
    case "subtract":
      return builder.arithmetic(
        "subtract",
        formulaExpression(builder, relation, metric, formula.left),
        formulaExpression(builder, relation, metric, formula.right),
      );
    case "multiply":
      return builder.arithmetic(
        "multiply",
        formulaExpression(builder, relation, metric, formula.left),
        formulaExpression(builder, relation, metric, formula.right),
      );
    case "divide":
      return builder.arithmetic(
        "divide",
        formulaExpression(builder, relation, metric, formula.left),
        formulaExpression(builder, relation, metric, formula.right),
      );
    case "round":
      return builder.round(
        formulaExpression(builder, relation, metric, formula.input),
      );
  }
}

function normalizeAtomicBranches(
  builder: LogicalPlanBuilder,
  branches: readonly {
    readonly metric: AtomicMetricDefinition;
    readonly relation: LogicalRelationHandle;
  }[],
  grouping?: PlannedGrouping,
): LogicalRelationHandle {
  if (branches.length === 0)
    throw new Error("metric_plan_has_no_atomic_dependencies");
  if (!grouping) {
    let combined = branches[0]!.relation;
    const paths = new Map<SemanticMetricId, string>([
      [branches[0]!.metric.id, branches[0]!.metric.id],
    ]);
    for (const branch of branches.slice(1)) {
      combined = builder.join(combined, branch.relation, [], "inner");
      paths.set(branch.metric.id, `right.${branch.metric.id}`);
    }
    return builder.project(
      combined,
      Object.fromEntries(
        [...paths].map(([metric, path]) => [
          metric,
          builder.slot(combined, path),
        ]),
      ),
    );
  }

  const dimensionNames = groupingFieldDescriptors(grouping).map((field) => ({
    id: field.key,
    sourceName: field.sourceName,
    outputName: field.outputName,
  }));
  let combined = builder.project(
    grouping.spine,
    Object.fromEntries(
      dimensionNames.map(({ sourceName, outputName }) => [
        outputName,
        builder.slot(grouping.spine, sourceName),
      ]),
    ),
  );
  const metricPaths = new Map<SemanticMetricId, string>();
  for (const branch of branches) {
    const keys = dimensionNames.map(({ outputName }) => ({
      left: outputName,
      right: outputName,
    }));
    const joined = builder.join(combined, branch.relation, keys, "left");
    const expressions: Record<string, LogicalExpressionHandle> = {};
    for (const dimension of dimensionNames) {
      expressions[dimension.outputName] = builder.slot(
        combined,
        dimension.outputName,
      );
    }
    for (const [metricId, path] of metricPaths) {
      expressions[`metric:${metricId}`] = builder.slot(combined, path);
    }
    const measure = builder.slot(joined, `right.${branch.metric.id}`);
    expressions[`metric:${branch.metric.id}`] = builder.coalesce(
      measure,
      builder.literal(0, numericLiteralType(branch.metric.valueType)),
    );
    combined = builder.project(joined, expressions);
    metricPaths.set(branch.metric.id, `metric:${branch.metric.id}`);
  }
  return combined;
}

export function planMetricRelations(
  builder: LogicalPlanBuilder,
  dataset: EligibleDatasetResolver,
  requested: readonly SemanticMetricId[],
  grouping?: PlannedGrouping,
): PlannedMetricRelation {
  if (requested.length === 0)
    throw new Error("metric_plan_requires_requested_metrics");
  const dependencies = resolveMetricDependencies(requested);
  if (grouping) {
    const groupingIssues = validatePlannedGrouping(grouping);
    if (groupingIssues.length > 0) throw new Error(groupingIssues.join("; "));
    for (const metricId of dependencies.closure) {
      for (const dimension of grouping.dimensions.keys()) {
        const capability = metricDimensionCapability(metricId, dimension);
        if (capability?.support !== "supported") {
          throw new Error(
            `metric_dimension_not_supported:${metricId}:${dimension}`,
          );
        }
      }
    }
  }
  const branches = dependencies.atomic.map((metric) => ({
    metric,
    relation: grouping
      ? groupedAtomicBranch(builder, dataset, grouping, metric)
      : ungroupedAtomicBranch(builder, dataset, metric),
  }));
  let relation = normalizeAtomicBranches(builder, branches, grouping);
  const metricFields = new Map<SemanticMetricId, string>(
    dependencies.atomic.map((metric) => [
      metric.id,
      grouping ? `metric:${metric.id}` : metric.id,
    ]),
  );
  const dimensionFields = new Map<string, string>(
    grouping
      ? [...grouping.dimensions.keys()].map((dimension) => [
          dimension,
          `dimension:${dimension}`,
        ])
      : [],
  );
  const timeBucketField = grouping?.timeBucket ? "timeBucket" : undefined;

  for (const metric of dependencies.derivedOrder) {
    const expression = formulaExpression(
      builder,
      relation,
      metric,
      metric.formula,
    );
    const projections: Record<string, LogicalExpressionHandle> = {};
    for (const field of dimensionFields.values()) {
      projections[field] = builder.slot(relation, field);
    }
    if (timeBucketField)
      projections[timeBucketField] = builder.slot(relation, timeBucketField);
    for (const field of metricFields.values()) {
      projections[field] = builder.slot(relation, field);
    }
    const field = grouping ? `metric:${metric.id}` : metric.id;
    projections[field] = expression;
    relation = builder.project(relation, projections);
    metricFields.set(metric.id, field);
  }

  return Object.freeze({
    relation,
    metrics: new Map(
      dependencies.requested.map((id) => [id, metricFields.get(id)!]),
    ),
    dimensions: dimensionFields,
    ...(timeBucketField ? { timeBucket: timeBucketField } : {}),
    dependencies,
  });
}
