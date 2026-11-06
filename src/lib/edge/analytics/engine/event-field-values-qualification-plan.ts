import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountQualificationPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  appendEventFieldValuesPage,
  EVENT_FIELD_VALUES_PAGE_OUTPUT,
  type EventFieldValuesPageOptions,
} from "@/lib/edge/analytics/engine/event-field-values-plan";
import { buildEventPayloadQualificationPlan } from "@/lib/edge/analytics/engine/event-payload-qualification-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

/** Builds the paged Event value report beside its Count qualification. */
export function buildEventFieldValuesQualificationPlan<
  TCount extends AdvancedCountQualificationPlanInput,
>(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: TCount;
  readonly eventName?: string;
  readonly options: EventFieldValuesPageOptions;
}) {
  return buildEventPayloadQualificationPlan({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    scopePlan: input.scopePlan,
    count: input.count,
    contextMismatchCode:
      "event_field_values_qualification_request_context_mismatch",
    ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
    appendReport: (builder, occurrences) => {
      appendEventFieldValuesPage(builder, occurrences, input.options);
      return [EVENT_FIELD_VALUES_PAGE_OUTPUT] as const;
    },
  });
}
