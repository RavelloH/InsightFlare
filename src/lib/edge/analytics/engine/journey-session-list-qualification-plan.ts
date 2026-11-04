import type {
  FunnelConfigV2,
  QueryTime,
  ScopedFilterPlan,
  SessionListSortKey,
  SortDirection,
} from "@/lib/edge/analytics/contract";
import {
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/contract/types";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  appendAdvancedCountQualification,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import { createJourneyFunnelProgressionSourceSelections } from "@/lib/edge/analytics/engine/funnel-progression-report-plan";
import {
  appendJourneyListAnalysisIdentityRestriction,
  appendJourneySessionListReport,
  createJourneyListAnalysisStageSelection,
  JOURNEY_LIST_EVENT_ATTRIBUTES,
  JOURNEY_LIST_PAGE_ATTRIBUTES,
  JOURNEY_SESSION_LIST_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import { appendJourneyFunnelListQualification } from "@/lib/edge/analytics/engine/journey-funnel-list-qualification-plan";
import {
  assertJourneyListWholeFilterCountDocument,
  type JourneyListQualificationFilterMode,
  resolveJourneyListQualificationFilters,
} from "@/lib/edge/analytics/engine/journey-list-qualification-filters";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { appendQualifiedObservationMembership } from "@/lib/edge/analytics/engine/qualified-page-source";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export type JourneySessionListQualificationPlan = AnalyticsQualificationPlan & {
  readonly reportOutputIds: readonly [
    typeof JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  ];
};

export interface JourneySessionListQualificationInput {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly limit: number;
  readonly sort: {
    readonly key: SessionListSortKey;
    readonly direction: SortDirection;
  };
  readonly search?: string;
  readonly cursor?: {
    readonly sortValue: number;
    readonly startedAt?: number;
    readonly sessionId: string;
  } | null;
  readonly preparedPlanOperation?: "sessions" | "visitor-sessions";
  readonly sessionTarget?: {
    readonly type: "visitor";
    readonly value: string;
  };
  readonly suppressReportRows?: boolean;
  readonly analysisFilter?: FilterDocument;
  readonly funnelAnalysis?: {
    readonly config: FunnelConfigV2;
    readonly stepIndex: number;
    readonly outcome?: "converted" | "dropoff";
  };
}

function queryWindow(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function buildJourneySessionListPlan(
  input: JourneySessionListQualificationInput,
  filterMode: JourneyListQualificationFilterMode = "split-only",
): JourneySessionListQualificationPlan {
  const metadata = scopedFilterMetadata(input.filters);
  const readRange = input.queryTime.readRange ?? input.queryTime.range;
  if (
    !metadata ||
    metadata.plan !== input.scopePlan ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteId ||
    metadata.resolvedScope !== input.scopePlan.scope ||
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
    throw new Error("session_list_qualification_request_context_mismatch");

  const filterResolution = resolveJourneyListQualificationFilters(
    input.filters,
    filterMode,
  );
  if (filterResolution.kind === "unsupported")
    throw new Error(
      "session_list_qualification_native_filter_split_unsupported",
    );
  if (filterResolution.mode === "whole-filter")
    assertJourneyListWholeFilterCountDocument(
      input.filters,
      input.count.analysis.document,
      "session",
    );
  const nativeScopePlan = createScopedFilterPlan(
    input.preparedPlanOperation ?? "sessions",
    filterResolution.nativeFilters,
    input.scopePlan.scope,
  );
  if (!nativeScopePlan || nativeScopePlan.scope !== input.scopePlan.scope)
    throw new Error("session_list_qualification_native_scope_plan_missing");
  const nativeFilters = attachScopedFilterMetadata(
    filterResolution.nativeFilters,
    {
      requestedScope: input.scopePlan.scope,
      resolvedScope: nativeScopePlan.scope,
      plan: nativeScopePlan,
      time: metadata.time,
      siteIds: metadata.siteIds,
    },
  );
  const sources = createJourneyFunnelProgressionSourceSelections({
    siteId: input.siteId,
    window: queryWindow(input.queryTime),
    filters: nativeFilters,
    entityScope: input.funnelAnalysis ? "session" : input.scopePlan.scope,
    preparedPlanOperation: input.funnelAnalysis
      ? "sessions"
      : (input.preparedPlanOperation ?? "sessions"),
  });

  const builder = createAdvancedCountQualificationBuilder(input.count);
  const qualification = appendAdvancedCountQualification(builder, input.count);
  const pages = builder.source("page", {
    temporalDomain: "candidate",
    attributes: JOURNEY_LIST_PAGE_ATTRIBUTES,
    selection: sources.page,
  });
  const events = builder.source("event", {
    temporalDomain: "candidate",
    attributes: JOURNEY_LIST_EVENT_ATTRIBUTES,
    selection: sources.event,
  });
  const qualifiedPages = appendQualifiedObservationMembership({
    builder,
    observations: pages,
    matches: qualification.matches,
    siteId: input.siteId,
    ownerAttribute:
      input.scopePlan.scope === "session"
        ? "page.report.sessionId"
        : "page.report.visitorId",
  });
  const qualifiedEvents = appendQualifiedObservationMembership({
    builder,
    observations: events,
    matches: qualification.matches,
    siteId: input.siteId,
    ownerAttribute:
      input.scopePlan.scope === "session"
        ? "event.report.ownerSessionId"
        : "event.report.ownerVisitorId",
  });

  let reportPages = qualifiedPages;
  let reportEvents = qualifiedEvents;
  if (input.analysisFilter) {
    let goalPages = qualifiedPages;
    let goalEvents = qualifiedEvents;
    if (input.analysisFilter.root !== null) {
      const goalPageSource = builder.source("page", {
        temporalDomain: "candidate",
        attributes:
          input.scopePlan.scope === "session"
            ? ["page.report.sessionId"]
            : ["page.report.sessionId", "page.report.visitorId"],
        selection: createJourneyListAnalysisStageSelection(
          sources.page,
          nativeFilters,
          sources.expectedPlan,
          input.analysisFilter,
        ),
      });
      const goalEventSource = builder.source("event", {
        temporalDomain: "candidate",
        attributes:
          input.scopePlan.scope === "session"
            ? ["event.report.ownerSessionId"]
            : ["event.report.ownerSessionId", "event.report.ownerVisitorId"],
        selection: createJourneyListAnalysisStageSelection(
          sources.event,
          nativeFilters,
          sources.expectedPlan,
          input.analysisFilter,
        ),
      });
      goalPages = appendQualifiedObservationMembership({
        builder,
        observations: goalPageSource,
        matches: qualification.matches,
        siteId: input.siteId,
        ownerAttribute:
          input.scopePlan.scope === "session"
            ? "page.report.sessionId"
            : "page.report.visitorId",
      });
      goalEvents = appendQualifiedObservationMembership({
        builder,
        observations: goalEventSource,
        matches: qualification.matches,
        siteId: input.siteId,
        ownerAttribute:
          input.scopePlan.scope === "session"
            ? "event.report.ownerSessionId"
            : "event.report.ownerVisitorId",
      });
    }
    const restricted = appendJourneyListAnalysisIdentityRestriction({
      builder,
      pages: qualifiedPages,
      events: qualifiedEvents,
      goalPages,
      goalEvents,
      entity: "session",
    });
    reportPages = restricted.pages;
    reportEvents = restricted.events;
  } else if (input.funnelAnalysis) {
    const preparedPlanOperation = input.preparedPlanOperation ?? "sessions";
    if (
      preparedPlanOperation !== "sessions" ||
      qualification.scope !== input.count.scope ||
      input.funnelAnalysis.config.progressionScope !== "session"
    )
      throw new Error("journey_funnel_list_qualification_scope_mismatch");
    const restricted = appendJourneyFunnelListQualification({
      builder,
      sources,
      config: input.funnelAnalysis.config,
      stepIndex: input.funnelAnalysis.stepIndex,
      outcome: input.funnelAnalysis.outcome,
      countMatches: qualification.matches,
      siteId: input.siteId,
      countScope: qualification.scope,
      preparedPlanOperation,
      reportPages: qualifiedPages,
      reportEvents: qualifiedEvents,
    });
    reportPages = restricted.pages;
    reportEvents = restricted.events;
  }

  appendJourneySessionListReport({
    builder,
    pages: reportPages,
    events: reportEvents,
    limit: input.limit,
    sort: input.sort,
    search: input.search,
    cursor: input.cursor,
    sessionTarget: input.sessionTarget,
    suppressReportRows: input.suppressReportRows,
  });
  builder.output(
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    qualification.controls,
    Object.keys(qualification.controls.slots).map((name) => ({
      name,
      slot: name,
    })),
  );

  return {
    plan: builder.finish(),
    primaryReportSourceRelationId: pages.id,
    matchesRelationId: qualification.matches.id,
    controlsRelationId: qualification.controls.id,
    groupedSummaryRelationId: qualification.groupedSummary.id,
    controlOutputId: PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
    reportOutputIds: [JOURNEY_SESSION_LIST_REPORT_OUTPUT],
    numericCompatibilityFields: qualification.numericCompatibilityFields,
    scope: qualification.scope,
    reportSourceRelations: [
      { relationId: pages.id, entity: "page" },
      { relationId: events.id, entity: "event" },
    ],
  };
}

/** Builds one Count relation shared by the legacy Page and Event list sources. */
export function buildJourneySessionListQualificationPlan(
  input: JourneySessionListQualificationInput,
): JourneySessionListQualificationPlan {
  const preparedPlanOperation = input.preparedPlanOperation ?? "sessions";
  const allowWholeFilter =
    (preparedPlanOperation === "sessions" &&
      input.sessionTarget === undefined) ||
    (preparedPlanOperation === "visitor-sessions" &&
      input.sessionTarget?.type === "visitor" &&
      input.sessionTarget.value.length > 0);
  return buildJourneySessionListPlan(
    {
      ...input,
      analysisFilter: undefined,
      funnelAnalysis: undefined,
    },
    allowWholeFilter ? "allow-whole-filter" : "split-only",
  );
}

/** Fuses Count membership, Goal identity restriction, and the Session report. */
export function buildJourneySessionGoalListQualificationPlan(
  input: JourneySessionListQualificationInput & {
    readonly analysisFilter: FilterDocument;
  },
): JourneySessionListQualificationPlan {
  return buildJourneySessionListPlan(
    { ...input, funnelAnalysis: undefined },
    "allow-whole-filter",
  );
}

/** Fuses Count membership, Funnel outcome membership, and the Session report. */
export function buildJourneySessionFunnelListQualificationPlan(
  input: JourneySessionListQualificationInput & {
    readonly funnelAnalysis: {
      readonly config: FunnelConfigV2;
      readonly stepIndex: number;
      readonly outcome?: "converted" | "dropoff";
    };
  },
): JourneySessionListQualificationPlan {
  return buildJourneySessionListPlan(
    { ...input, analysisFilter: undefined },
    "allow-whole-filter",
  );
}
