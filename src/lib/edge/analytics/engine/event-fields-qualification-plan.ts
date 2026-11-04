import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  appendEventFieldsPage,
  EVENT_FIELDS_PAGE_OUTPUT,
  type EventFieldCursorValue,
} from "@/lib/edge/analytics/engine/event-fields-plan";
import { buildEventPayloadQualificationPlan } from "@/lib/edge/analytics/engine/event-payload-qualification-plan";
import type { EventQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export interface EventFieldsQualificationOptions {
  readonly eventName?: string;
  readonly limit: number;
  readonly cursor?: EventFieldCursorValue | null;
}

export type EventFieldsQualificationPlan = EventQualificationPlan & {
  readonly plan: ValidatedLogicalPlan;
  readonly reportOutputIds: readonly [typeof EVENT_FIELDS_PAGE_OUTPUT];
};

/** Builds the Event field report beside its Count qualification. */
export function buildEventFieldsQualificationPlan(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly options: EventFieldsQualificationOptions;
}): EventFieldsQualificationPlan {
  return buildEventPayloadQualificationPlan({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    contextMismatchCode: "event_fields_qualification_request_context_mismatch",
    ...(input.options.eventName !== undefined
      ? { eventName: input.options.eventName }
      : {}),
    appendReport: (builder, occurrences) => {
      appendEventFieldsPage(builder, occurrences, input.options);
      return [EVENT_FIELDS_PAGE_OUTPUT] as const;
    },
  });
}
