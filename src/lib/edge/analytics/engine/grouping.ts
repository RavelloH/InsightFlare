import type { CalendarGranularity } from "@/lib/edge/analytics/contract/types";

import type { LogicalRelationHandle } from "./logical/builder";
import { grainKeys } from "./logical/grain";
import type { SlotId } from "./logical/ids";
import type { SemanticDimensionId } from "./semantic/dimensions";
import {
  semanticDimension,
  semanticDimensionCatalog,
} from "./semantic/dimensions";
import type { SemanticMetricId } from "./semantic/metrics";

export interface PlannedGrouping {
  /** One row per output group. Metric branches join back to this relation. */
  readonly spine: LogicalRelationHandle;
  readonly dimensions: ReadonlyMap<SemanticDimensionId, SlotId>;
  readonly timeBucket?: {
    readonly slot: SlotId;
    readonly granularity: CalendarGranularity;
  };
}

export interface GroupingFieldDescriptor {
  readonly key: string;
  readonly sourceName: string;
  readonly outputName: string;
  readonly associationName: string;
}

export function groupingFieldDescriptors(
  grouping: PlannedGrouping,
): readonly GroupingFieldDescriptor[] {
  const fields: GroupingFieldDescriptor[] = [...grouping.dimensions].map(
    ([id, slot]) => {
      const sourceName = Object.entries(grouping.spine.slots).find(
        ([, candidate]) => candidate === slot,
      )?.[0];
      if (!sourceName)
        throw new Error(`grouping_spine_missing_dimension:${id}`);
      return {
        key: id,
        sourceName,
        outputName: `dimension:${id}`,
        associationName: `dimension:${id}`,
      };
    },
  );
  if (grouping.timeBucket) {
    const sourceName = Object.entries(grouping.spine.slots).find(
      ([, candidate]) => candidate === grouping.timeBucket!.slot,
    )?.[0];
    if (!sourceName) throw new Error("grouping_spine_missing_time_bucket");
    fields.push({
      key: "timeBucket",
      sourceName,
      outputName: "timeBucket",
      associationName: "timeBucket",
    });
  }
  return Object.freeze(fields);
}

export type MetricDimensionSupport = "supported" | "not-yet-supported";

export interface MetricDimensionCapability {
  readonly metric: SemanticMetricId;
  readonly dimension: SemanticDimensionId;
  readonly support: MetricDimensionSupport;
  readonly reason: string;
}

const COUNTRY_METRICS = new Set<SemanticMetricId>([
  "views",
  "sessions",
  "visitors",
  "events",
  "totalDurationMs",
  "durationViews",
  "avgDurationMs",
  "viewsPerSession",
]);

const METRIC_IDS: readonly SemanticMetricId[] = [
  "views",
  "sessions",
  "visitors",
  "events",
  "bounces",
  "totalDurationMs",
  "durationViews",
  "avgDurationMs",
  "bounceRate",
  "viewsPerSession",
];

export const metricDimensionCapabilities: readonly MetricDimensionCapability[] =
  Object.freeze(
    METRIC_IDS.flatMap((metric) =>
      semanticDimensionCatalog.map((dimension) => {
        const supported =
          dimension.id === "geo.country" && COUNTRY_METRICS.has(metric);
        return Object.freeze({
          metric,
          dimension: dimension.id,
          support: supported
            ? ("supported" as const)
            : ("not-yet-supported" as const),
          reason: supported
            ? "The entity association can preserve the country group spine."
            : metric === "bounces" || metric === "bounceRate"
              ? "Bounce grouping has no confirmed legacy semantic contract."
              : "This metric and dimension pair has no Phase 4A grouping contract yet.",
        });
      }),
    ),
  );

export function metricDimensionCapability(
  metric: SemanticMetricId,
  dimension: SemanticDimensionId,
): MetricDimensionCapability | undefined {
  return metricDimensionCapabilities.find(
    (item) => item.metric === metric && item.dimension === dimension,
  );
}

export function validatePlannedGrouping(
  grouping: PlannedGrouping,
): readonly string[] {
  const issues: string[] = [];
  for (const [dimensionId, slotId] of grouping.dimensions) {
    if (!semanticDimension(dimensionId))
      issues.push(`dimensions.${dimensionId}: unknown semantic dimension`);
    if (!Object.values(grouping.spine.slots).includes(slotId)) {
      issues.push(
        `dimensions.${dimensionId}: slot is not visible in the group spine`,
      );
    }
  }
  if (
    grouping.timeBucket &&
    !Object.values(grouping.spine.slots).includes(grouping.timeBucket.slot)
  ) {
    issues.push("timeBucket: slot is not visible in the group spine");
  }
  const groupKeyCount =
    grouping.dimensions.size + (grouping.timeBucket ? 1 : 0);
  const declaredGroupKeys = [
    ...grouping.dimensions.values(),
    ...(grouping.timeBucket ? [grouping.timeBucket.slot] : []),
  ];
  if (groupKeyCount === 0 && grouping.spine.grain.kind !== "scalar") {
    issues.push("dimensions: an ungrouped spine must have scalar grain");
  }
  if (groupKeyCount > 0 && grouping.spine.grain.kind === "scalar") {
    issues.push("dimensions: a grouped spine cannot have scalar grain");
  }
  if (groupKeyCount > 0) {
    const actualKeys = grainKeys(grouping.spine.grain);
    if (
      grouping.spine.grain.kind !== "keyed" ||
      actualKeys.length !== declaredGroupKeys.length ||
      !declaredGroupKeys.every((key) => actualKeys.includes(key))
    ) {
      issues.push(
        "dimensions: group spine grain must be exactly the declared dimensions and time bucket",
      );
    }
  }
  return Object.freeze(issues);
}
