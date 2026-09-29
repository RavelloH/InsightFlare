import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "./logical/builder";
import type { ValidatedLogicalPlan } from "./logical/plan";
import type { LogicalPlanContext } from "./logical/plan";
import type { EligibleDatasetResolver } from "./eligible-dataset";
import type { PlannedGrouping } from "./grouping";
import { planMetricRelations } from "./metric-planner";
import {
  type SemanticAggregateQuery,
  validateSemanticAggregateQuery,
} from "./query";

function contextSnapshot(context: LogicalPlanContext): string {
  return JSON.stringify({
    subject: {
      origin: context.subject.origin,
      siteIds: context.subject.siteIds,
      teamId: context.subject.teamId ?? null,
    },
    time: {
      candidate: context.time.candidate,
      filter: context.time.filter ?? null,
      read: context.time.read,
      reportingTimeZone: context.time.reportingTimeZone,
      capturedAtMs: context.time.capturedAtMs,
    },
    scope: {
      requested: context.scope.requested,
      contractScope: context.scope.contractScope,
      logicalScope: context.scope.logicalScope,
    },
    originOperation: context.originOperation ?? null,
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** Plans the normalized aggregate shape; filter lowering is supplied as an eligible dataset. */
export function planSemanticAggregateQuery(
  builder: LogicalPlanBuilder,
  rawQuery: SemanticAggregateQuery,
  dataset: EligibleDatasetResolver,
  grouping?: PlannedGrouping,
): ValidatedLogicalPlan {
  const query = validateSemanticAggregateQuery(rawQuery);
  if (contextSnapshot(builder.context) !== contextSnapshot(query.context)) {
    throw new Error("semantic_query_builder_context_mismatch");
  }
  if (
    dataset.subject.origin !== query.context.subject.origin ||
    dataset.subject.teamId !== query.context.subject.teamId ||
    !sameIds(dataset.subject.siteIds, query.context.subject.siteIds)
  ) {
    throw new Error("semantic_query_dataset_subject_mismatch");
  }
  const requestedDimensions = [...query.dimensions].sort();
  const plannedDimensions = grouping
    ? [...grouping.dimensions.keys()].sort()
    : [];
  if (!sameIds(requestedDimensions, plannedDimensions)) {
    throw new Error("semantic_query_grouping_dimensions_mismatch");
  }
  if (query.timeBucket) {
    if (
      !grouping?.timeBucket ||
      grouping.timeBucket.granularity !== query.timeBucket.granularity
    ) {
      throw new Error(
        "semantic_query_time_bucket_requires_matching_group_spine",
      );
    }
  } else if (grouping?.timeBucket) {
    throw new Error("semantic_query_does_not_request_grouping_time_bucket");
  }
  if (query.filters?.root && dataset.scope.kind !== "matching") {
    throw new Error("semantic_query_filter_requires_resolved_eligible_dataset");
  }
  if (
    query.filters?.root &&
    query.context.scope.logicalScope !== null &&
    dataset.scope.kind === "matching" &&
    dataset.scope.target !== query.context.scope.logicalScope
  ) {
    throw new Error("semantic_query_scope_dataset_mismatch");
  }

  const planned = planMetricRelations(
    builder,
    dataset,
    query.metrics,
    grouping,
  );
  const projections: Record<
    string,
    ReturnType<LogicalPlanBuilder["slot"]>
  > = {};
  for (const dimension of query.dimensions) {
    const field = planned.dimensions.get(dimension);
    if (!field)
      throw new Error(`semantic_query_dimension_not_planned:${dimension}`);
    projections[dimension] = builder.slot(planned.relation, field);
  }
  if (query.timeBucket) {
    if (!planned.timeBucket)
      throw new Error("semantic_query_time_bucket_not_planned");
    projections.timeBucket = builder.slot(planned.relation, planned.timeBucket);
  }
  for (const metric of query.metrics) {
    const field = planned.metrics.get(metric);
    if (!field) throw new Error(`semantic_query_metric_not_planned:${metric}`);
    projections[metric] = builder.slot(planned.relation, field);
  }

  let relation: LogicalRelationHandle = builder.project(
    planned.relation,
    projections,
  );
  if (query.sort.length > 0) {
    relation = builder.sort(
      relation,
      query.sort.map((sort) => ({
        slot: sort.field,
        direction: sort.direction,
        nulls: sort.nulls,
      })),
    );
  }
  if (query.limit !== undefined)
    relation = builder.limit(relation, query.limit);

  builder.output("semantic-aggregate", relation, [
    ...query.dimensions.map((dimension) => ({
      name: dimension,
      slot: dimension,
      semantic: { kind: "dimension" as const, id: dimension },
    })),
    ...(query.timeBucket ? [{ name: "timeBucket", slot: "timeBucket" }] : []),
    ...query.metrics.map((metric) => ({
      name: metric,
      slot: metric,
      semantic: { kind: "metric" as const, id: metric },
    })),
  ]);
  return builder.finish();
}
