import {
  factEntityKindsForFilter,
  type QueryTime,
  scopedFilterMetadata,
  type SiteId,
} from "@/lib/edge/analytics/contract";
import {
  attachScopedFilterMetadata,
  createScopedFilterPlan,
  type ScopedFilterPlan,
} from "@/lib/edge/analytics/contract/scoped-filter";
import type { AdvancedCountFilterMatchPlanInput } from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import {
  appendAdvancedCountQualification,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import type { EventQualificationReportSource } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type {
  LogicalPlanBuilder,
  LogicalRelationHandle,
} from "@/lib/edge/analytics/engine/logical/builder";
import { splitPageDimensionNativeFilters } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { addPageReportSourceToBuilder } from "@/lib/edge/analytics/engine/page-report-plan";
import { createPageReportSource } from "@/lib/edge/analytics/engine/page-report-plan";
import type { QualificationDependencyRef } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { SemanticRelationshipId } from "@/lib/edge/analytics/engine/semantic/relationships";
import {
  createSemanticScopedSourceSelection,
  type SemanticScopedSourceSelection,
} from "@/lib/edge/analytics/engine/semantic/scoped-source-selection";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { semanticTemporalDomainsFromQueryTime } from "@/lib/edge/analytics/engine/semantic/time";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;

function appendOverviewEventSource(
  builder: LogicalPlanBuilder,
  input: {
    readonly selection: SemanticScopedSourceSelection;
    readonly attributes: readonly string[];
    readonly relationships?: readonly SemanticRelationshipId[];
  },
): LogicalRelationHandle {
  return builder.source("event", {
    temporalDomain: "candidate",
    attributes: input.attributes,
    ...(input.relationships ? { relationships: input.relationships } : {}),
    selection: input.selection,
  });
}

function sameQueryTime(left: QueryTime, right: QueryTime): boolean {
  const leftRead = left.readRange ?? left.range;
  const rightRead = right.readRange ?? right.range;
  return (
    left.range.startMs === right.range.startMs &&
    left.range.endExclusiveMs === right.range.endExclusiveMs &&
    leftRead.startMs === rightRead.startMs &&
    leftRead.endExclusiveMs === rightRead.endExclusiveMs &&
    JSON.stringify(left.filterRange) === JSON.stringify(right.filterRange) &&
    left.filterRangeEmpty === right.filterRangeEmpty &&
    left.fullHistory === right.fullHistory &&
    left.reportingTimeZone === right.reportingTimeZone &&
    left.capturedAtMs === right.capturedAtMs
  );
}

/** Shared source-selection contract for the Overview aggregate and Trend reports. */
export function createOverviewReportSource(input: {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  /**
   * Prepared scope plan and request-private membership that replace the
   * legacy ID set carried by the filters' scoped metadata.
   */
  readonly scopePlan?: ScopedFilterPlan;
  readonly qualificationDependencyRefs?: readonly QualificationDependencyRef[];
  readonly pageVisitDependencyRefs?: readonly QualificationDependencyRef[];
  readonly qualificationSemantics?: "whole-original";
  readonly pageAttributes: readonly string[];
  readonly pageRelationships?: readonly SemanticRelationshipId[];
  readonly eventAttributes: readonly string[];
  readonly eventRelationships?: readonly SemanticRelationshipId[];
}): {
  readonly builder: LogicalPlanBuilder;
  readonly pages: LogicalRelationHandle;
  readonly events?: LogicalRelationHandle;
  readonly selection: SemanticScopedSourceSelection;
  readonly scoped: boolean;
} {
  const metadata = input.scopePlan
    ? { plan: input.scopePlan }
    : scopedFilterMetadata(input.filters);
  if (input.qualificationSemantics && !metadata)
    throw new Error("overview_source_whole_original_requires_prepared_scope");
  const directCompatibilitySelection =
    !metadata && input.filters.root !== null
      ? createSemanticScopedSourceSelection({
          profile: "direct-page-session-compat-v1",
          filters: input.filters,
          subject: createSemanticSubjectDomain({
            origin: "site",
            siteIds: [input.siteId as SiteId],
          }),
          time: semanticTemporalDomainsFromQueryTime(input.queryTime),
        })
      : undefined;
  const scoped = metadata !== undefined || input.filters.root !== null;
  const includeEvents =
    metadata !== undefined ||
    (directCompatibilitySelection !== undefined &&
      input.filters.root !== null &&
      factEntityKindsForFilter(input.filters.root).size > 0);
  const source = createPageReportSource({
    siteId: input.siteId,
    queryTime: input.queryTime,
    filters: input.filters,
    ...(metadata
      ? {
          scopePlan: metadata.plan,
          preparedTimePolicy: "scoped-reader-window-v1" as const,
          ...(input.qualificationSemantics
            ? { qualificationSemantics: input.qualificationSemantics }
            : {}),
          ...((input.pageVisitDependencyRefs ??
          input.qualificationDependencyRefs)
            ? {
                qualificationDependencyRefs:
                  input.pageVisitDependencyRefs ??
                  input.qualificationDependencyRefs,
              }
            : {}),
        }
      : {}),
    ...(directCompatibilitySelection
      ? { sourceSelection: directCompatibilitySelection }
      : {}),
    attributes: input.pageAttributes,
    ...(scoped && input.pageRelationships
      ? { relationships: input.pageRelationships }
      : {}),
  });
  const events = includeEvents
    ? appendOverviewEventSource(source.builder, {
        attributes: input.eventAttributes,
        ...(input.eventRelationships
          ? { relationships: input.eventRelationships }
          : {}),
        selection:
          metadata && input.pageVisitDependencyRefs
            ? createSemanticScopedSourceSelection({
                profile:
                  input.qualificationSemantics === "whole-original"
                    ? "prepared-whole-filter-reader-window-v1"
                    : "prepared-scoped-reader-window-v1",
                filters: input.filters,
                subject: source.builder.context.subject,
                time: source.builder.context.time,
                expectedPlan: metadata.plan,
                ...(input.qualificationDependencyRefs
                  ? {
                      qualificationDependencyRefs:
                        input.qualificationDependencyRefs,
                    }
                  : {}),
              })
            : source.selection,
      })
    : undefined;
  return { ...source, ...(events ? { events } : {}), scoped };
}

/** Appends the shared Page/Event Sources and Count owner semijoins. */
export function appendQualifiedOverviewReportSource(input: {
  readonly semanticOperation: "overview" | "trend";
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan: ScopedFilterPlan;
  readonly count: AdvancedCountFilterMatchPlanInput;
  readonly pageAttributes: readonly string[];
  readonly pageRelationships?: readonly SemanticRelationshipId[];
  readonly eventAttributes: readonly string[];
  readonly eventRelationships?: readonly SemanticRelationshipId[];
}): {
  readonly builder: ReturnType<typeof createAdvancedCountQualificationBuilder>;
  readonly qualification: ReturnType<typeof appendAdvancedCountQualification>;
  readonly pages: LogicalRelationHandle;
  readonly events: LogicalRelationHandle;
  readonly reportSourceRelations: readonly EventQualificationReportSource[];
} {
  const metadata = scopedFilterMetadata(input.filters);
  const queryReadRange = input.queryTime.readRange ?? input.queryTime.range;
  if (
    !metadata ||
    metadata.siteIds.length !== 1 ||
    metadata.siteIds[0] !== input.siteId ||
    metadata.resolvedScope !== input.scopePlan.scope ||
    metadata.plan !== input.scopePlan ||
    input.count.subject.siteIds.length !== 1 ||
    input.count.subject.siteIds[0] !== input.siteId ||
    input.count.scope !== input.scopePlan.scope ||
    !sameQueryTime(input.queryTime, metadata.time) ||
    input.queryTime.range.startMs !== input.count.candidateRange.startMs ||
    input.queryTime.range.endExclusiveMs !==
      input.count.candidateRange.endExclusiveMs ||
    queryReadRange.startMs !== input.count.readRange.startMs ||
    queryReadRange.endExclusiveMs !== input.count.readRange.endExclusiveMs ||
    input.queryTime.filterRange !== undefined ||
    input.queryTime.filterRangeEmpty === true ||
    input.queryTime.fullHistory === true ||
    input.queryTime.reportingTimeZone !== input.count.reportingTimeZone ||
    input.queryTime.capturedAtMs !== input.count.capturedAtMs
  )
    throw new Error("overview_trend_qualification_request_context_mismatch");

  const split = splitPageDimensionNativeFilters(input.filters);
  if (split.kind === "unsupported")
    throw new Error(
      "overview_trend_qualification_native_filter_split_unsupported",
    );
  const nativeScopePlan = createScopedFilterPlan(
    input.semanticOperation,
    split.filters,
    input.scopePlan.scope,
  );
  if (!nativeScopePlan || nativeScopePlan.scope !== input.scopePlan.scope)
    throw new Error("overview_trend_qualification_native_scope_plan_missing");
  const nativeFilters = attachScopedFilterMetadata(split.filters, {
    requestedScope: input.scopePlan.scope,
    resolvedScope: nativeScopePlan.scope,
    plan: nativeScopePlan,
    time: metadata.time,
    siteIds: metadata.siteIds,
  });

  const builder = createAdvancedCountQualificationBuilder(input.count);
  const qualification = appendAdvancedCountQualification(builder, input.count);
  const selection = createSemanticScopedSourceSelection({
    profile: "prepared-scoped-reader-window-v1",
    filters: nativeFilters,
    subject: builder.context.subject,
    time: builder.context.time,
    expectedPlan: nativeScopePlan,
    preparedPlanOperation: input.semanticOperation,
  });
  const pageSource = addPageReportSourceToBuilder(builder, {
    attributes: input.pageAttributes,
    ...(input.pageRelationships
      ? { relationships: input.pageRelationships }
      : {}),
    selection,
  });
  const eventSource = appendOverviewEventSource(builder, {
    attributes: input.eventAttributes,
    ...(input.eventRelationships
      ? { relationships: input.eventRelationships }
      : {}),
    selection,
  });
  const matchesForSite = builder.filter(
    qualification.matches,
    builder.compare(
      "eq",
      builder.slot(qualification.matches, "siteId"),
      builder.literal(input.siteId, STRING),
    ),
  );
  const ownerAttribute =
    input.count.scope === "session" ? "sessionId" : "visitorId";
  const qualifiedPages = builder.semiJoin(pageSource.pages, matchesForSite, [
    { left: `attribute:page.report.${ownerAttribute}`, right: "entityId" },
  ]);
  const qualifiedEvents = builder.semiJoin(eventSource, matchesForSite, [
    {
      left: `attribute:event.report.owner${ownerAttribute[0]!.toUpperCase()}${ownerAttribute.slice(1)}`,
      right: "entityId",
    },
  ]);

  return {
    builder,
    qualification,
    pages: qualifiedPages,
    events: qualifiedEvents,
    reportSourceRelations: [
      { relationId: pageSource.pages.id, entity: "page" },
      { relationId: eventSource.id, entity: "event" },
    ],
  };
}
