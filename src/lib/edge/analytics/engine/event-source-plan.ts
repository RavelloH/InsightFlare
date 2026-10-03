import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime, SiteId } from "@/lib/edge/analytics/contract/types";
import {
  type LogicalExpressionHandle,
  LogicalPlanBuilder,
  type LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const EVENT_REPORT_BASE_ATTRIBUTES = [
  "event.report.eventName",
  "event.report.ownerSessionId",
  "event.report.ownerVisitorId",
] as const;

export const EVENT_REPORT_TREND_ATTRIBUTES = [
  ...EVENT_REPORT_BASE_ATTRIBUTES,
  "event.report.occurredAt",
] as const;

export type EventNameInputSemantics = "trimmed-nonempty" | "legacy-truthy-raw";

/** Builds a shared value-only Event Source used by event summaries and trends. */
export function buildEventReportSource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly attributes: readonly string[];
  readonly eventName?: string;
  readonly eventNameInputSemantics?: EventNameInputSemantics;
}): {
  readonly builder: LogicalPlanBuilder;
  readonly events: LogicalRelationHandle;
} {
  const time = semanticTemporalDomainsFromQueryTime(input.queryTime);
  const subject = createSemanticSubjectDomain({
    origin: "site",
    siteIds: [input.siteId as SiteId],
  });
  const selection = createSemanticScopedSourceSelection({
    profile: input.scopePlan
      ? "prepared-scoped-v1"
      : "direct-event-analytics-v1",
    filters: input.filters,
    subject,
    time,
    ...(input.scopePlan ? { expectedPlan: input.scopePlan } : {}),
    ...(input.eventName !== undefined
      ? {
          eventName: input.eventName,
          eventNameInputSemantics:
            input.eventNameInputSemantics ?? "trimmed-nonempty",
        }
      : {}),
  });
  const builder = new LogicalPlanBuilder({
    subject,
    time,
    scope: resolveAnalyticsScope(input.scopePlan?.scope ?? "event"),
    originOperation: "event-records",
  });
  const events = builder.source("event", {
    temporalDomain: "candidate",
    attributes: input.attributes,
    selection,
  });
  return { builder, events };
}

/** Keep nonblank raw identity counting identical across Event summary/trend plans. */
export function nonEmptyDistinctValue(
  builder: LogicalPlanBuilder,
  value: LogicalExpressionHandle,
): LogicalExpressionHandle {
  const stringType = { kind: "scalar", scalar: "string" } as const;
  return builder.caseWhen(
    [
      {
        when: builder.compare("neq", value, builder.literal("", stringType)),
        then: value,
      },
    ],
    builder.literal(null, stringType),
  );
}
