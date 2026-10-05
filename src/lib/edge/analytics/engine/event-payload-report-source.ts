import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import { buildEventReportSource } from "@/lib/edge/analytics/engine/event-source-plan";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export interface EventPayloadReportSourceInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly eventName?: string;
}

export interface EventPayloadReportSource {
  readonly builder: LogicalPlanBuilder;
  readonly occurrences: LogicalRelationHandle;
}

/** Shared selected Event source and guarded payload occurrence bag for reports. */
export function buildEventPayloadReportSource(
  input: EventPayloadReportSourceInput,
): EventPayloadReportSource {
  const { builder, events } = buildEventReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(input.scopePlan ? { scopePlan: input.scopePlan } : {}),
    ...(input.scopePlan
      ? { preparedTimePolicy: "reader-window" as const }
      : {}),
    attributes: ["event.report.eventName", "event.report.internalPk"],
    ...(input.eventName !== undefined
      ? {
          eventName: input.eventName,
          eventNameInputSemantics: "legacy-truthy-raw" as const,
        }
      : {}),
  });
  return {
    builder,
    occurrences: builder.eventPayloadOccurrences(events),
  };
}
