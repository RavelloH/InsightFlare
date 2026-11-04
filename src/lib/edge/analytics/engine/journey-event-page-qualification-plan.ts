import {
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  scopedFilterMetadata,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type { QueryTime } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  appendAdvancedCountQualification,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  type AnalyticsQualificationPlan,
  type EventQualificationReportSource,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  appendJourneyEventPageReport,
  JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
  JOURNEY_EVENT_PAGE_SOURCE_EVENT_ATTRIBUTES,
  JOURNEY_EVENT_PAGE_SOURCE_PAGE_ATTRIBUTES,
} from "@/lib/edge/analytics/engine/journey-event-page-report-plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  appendQualifiedObservationMembership,
  assertWholeFilterCountDocument,
  type QualifiedSourceFilterMode,
  resolveQualifiedSourceFilters,
} from "@/lib/edge/analytics/engine/qualified-page-source";
import { createSemanticScopedSourceSelection } from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export type JourneyEventPageOperation = "visitor-events" | "session-events";

export type JourneyEventPageQualificationPlan = AnalyticsQualificationPlan & {
  readonly reportOutputIds: readonly [typeof JOURNEY_EVENT_PAGE_REPORT_OUTPUT];
};

/** Builds one bounded Count qualification shared by the original Page and Event sources. */
export function buildJourneyEventPageQualificationPlan(input: {
  readonly operation: JourneyEventPageOperation;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly target: {
    readonly type: "visitor" | "session";
    readonly value: string;
  };
  readonly filterMode?: QualifiedSourceFilterMode;
  readonly limit: number;
  readonly cursor?: { readonly occurredAt: number; readonly id: string } | null;
  readonly suppressReportRows?: boolean;
}): JourneyEventPageQualificationPlan {
  const metadata = scopedFilterMetadata(input.filters);
  const readRange = input.queryTime.readRange ?? input.queryTime.range;
  if (
    !metadata ||
    metadata.plan !== input.scopePlan ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteId ||
    metadata.resolvedScope !== input.scopePlan.scope ||
    input.target.type !==
      (input.operation === "visitor-events" ? "visitor" : "session") ||
    input.count.subject.siteIds.length !== 1 ||
    input.count.subject.siteIds[0] !== input.siteId ||
    input.count.scope !== input.scopePlan.scope ||
    input.queryTime.range.startMs !== input.count.candidateRange.startMs ||
    input.queryTime.range.endExclusiveMs !==
      input.count.candidateRange.endExclusiveMs ||
    readRange.startMs !== input.count.readRange.startMs ||
    readRange.endExclusiveMs !== input.count.readRange.endExclusiveMs ||
    input.queryTime.filterRange !== undefined ||
    input.queryTime.filterRangeEmpty === true ||
    input.queryTime.fullHistory === true ||
    input.queryTime.reportingTimeZone !== input.count.reportingTimeZone ||
    input.queryTime.capturedAtMs !== input.count.capturedAtMs
  )
    throw new Error(
      "journey_event_page_qualification_request_context_mismatch",
    );

  const filterResolution = resolveQualifiedSourceFilters(
    input.filters,
    input.filterMode ?? "split-only",
  );
  if (filterResolution.kind === "unsupported")
    throw new Error(
      "journey_event_page_qualification_native_filter_split_unsupported",
    );
  if (filterResolution.mode === "whole-filter")
    assertWholeFilterCountDocument(
      input.filters,
      input.count.analysis.document,
      "journey_event_page_qualification_whole_filter_count_document_mismatch",
    );
  const nativeScopePlan = createScopedFilterPlan(
    input.operation,
    filterResolution.nativeFilters,
    input.scopePlan.scope,
  );
  if (!nativeScopePlan || nativeScopePlan.scope !== input.scopePlan.scope)
    throw new Error(
      "journey_event_page_qualification_native_scope_plan_missing",
    );
  const nativeFilters = attachScopedFilterMetadata(
    filterResolution.nativeFilters,
    {
      requestedScope: metadata.requestedScope,
      resolvedScope: nativeScopePlan.scope,
      plan: nativeScopePlan,
      time: metadata.time,
      siteIds: metadata.siteIds,
    },
  );

  const builder = createAdvancedCountQualificationBuilder(input.count);
  const qualification = appendAdvancedCountQualification(builder, input.count);
  const selection = createSemanticScopedSourceSelection({
    profile: "prepared-scoped-reader-window-v1",
    filters: nativeFilters,
    subject: builder.context.subject,
    time: builder.context.time,
    expectedPlan: nativeScopePlan,
    preparedPlanOperation: input.operation,
  });
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: JOURNEY_EVENT_PAGE_SOURCE_PAGE_ATTRIBUTES,
    selection,
  });
  const events = builder.source("event", {
    temporalDomain: "candidate",
    attributes: JOURNEY_EVENT_PAGE_SOURCE_EVENT_ATTRIBUTES,
    selection,
  });
  const ownerKind = input.scopePlan.scope;
  const qualifiedPages = appendQualifiedObservationMembership({
    builder,
    observations: pages,
    matches: qualification.matches,
    siteId: input.siteId,
    ownerAttribute:
      ownerKind === "session"
        ? "page.report.sessionId"
        : "page.report.visitorId",
  });
  const qualifiedEvents = appendQualifiedObservationMembership({
    builder,
    observations: events,
    matches: qualification.matches,
    siteId: input.siteId,
    ownerAttribute:
      ownerKind === "session"
        ? "event.report.ownerSessionId"
        : "event.report.ownerVisitorId",
  });

  appendJourneyEventPageReport({
    builder,
    pages: qualifiedPages,
    events: qualifiedEvents,
    prepared: true,
    target: input.target,
    limit: input.limit,
    cursor: input.cursor,
    suppressReportRows: input.suppressReportRows,
  });
  const controls = qualification.controls;
  builder.output(
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    controls,
    Object.keys(controls.slots).map((name) => ({ name, slot: name })),
  );

  const reportSourceRelations: readonly EventQualificationReportSource[] = [
    { relationId: pages.id, entity: "page" },
    { relationId: events.id, entity: "event" },
  ];
  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [JOURNEY_EVENT_PAGE_REPORT_OUTPUT],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations,
  };
}
