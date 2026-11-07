import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  type AdvancedCountQualificationFragment,
  type AdvancedCountQualificationPlanInput,
  appendAdvancedCountQualification,
  appendAdvancedEventCandidateCountQualification,
  createAdvancedCountQualificationBuilder,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { EVENT_RECORD_ATTRIBUTES } from "@/lib/edge/analytics/engine/event-record-page-plan";
import {
  addEventReportSource,
  createEventReportSourceContextForBuilder,
  EVENT_REPORT_BASE_ATTRIBUTES,
  EVENT_REPORT_TREND_ATTRIBUTES,
  type EventNameInputSemantics,
} from "@/lib/edge/analytics/engine/event-source-plan";
import type { LogicalRelationHandle } from "@/lib/edge/analytics/engine/logical/builder";
import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const STRING = { kind: "scalar", scalar: "string" } as const;

const SUMMARY_CARD_EVENT_ATTRIBUTES = [
  "event.report.ownerPathname",
  "event.report.ownerTitle",
  "event.report.ownerHostname",
] as const;

export const EVENT_QUALIFICATION_CONTROL_OUTPUT =
  "event-summary-qualification-controls";

export type EventQualifiedSourcePurpose =
  "event-types" | "event-trend" | "summary-cards" | "event-context" | "records";

export interface EventQualificationReportSource {
  readonly relationId: RelationId;
  readonly entity: "event" | "page";
}

export interface EventQualifiedSource<
  Scope extends "session" | "visitor" | "event" = "session" | "visitor",
> {
  readonly builder: ReturnType<typeof createAdvancedCountQualificationBuilder>;
  readonly events: LogicalRelationHandle;
  readonly eventSourceRelationId: RelationId;
  readonly reportSourceRelations: readonly EventQualificationReportSource[];
  readonly qualification: AdvancedCountQualificationFragment<Scope>;
}

export interface AnalyticsQualificationPlan<
  Scope extends "session" | "visitor" | "event" = "session" | "visitor",
> {
  readonly plan: ValidatedLogicalPlan;
  readonly primaryReportSourceRelationId: RelationId;
  readonly matchesRelationId: RelationId;
  readonly controlsRelationId: RelationId;
  readonly groupedSummaryRelationId: RelationId;
  readonly controlOutputId: string;
  readonly reportOutputIds: readonly string[];
  readonly numericCompatibilityFields: readonly {
    readonly fieldId: string;
    readonly invalidCountOutput: string;
  }[];
  readonly scope: Scope;
  readonly candidateGrain?: "event-candidate";
  readonly additionalGroupedSummaryRelationIds?: readonly RelationId[];
  readonly reportSourceRelations: readonly EventQualificationReportSource[];
}

export interface EventQualificationPlan<
  Scope extends "session" | "visitor" | "event" = "session" | "visitor",
> extends AnalyticsQualificationPlan<Scope> {
  readonly eventSourceRelationId: RelationId;
}

/**
 * Appends the authorized Event Source to the same Engine builder as Count.
 * Both operations use this relation and the exact same site/owner join.
 */
export function buildEventQualifiedSource<
  Count extends AdvancedCountQualificationPlanInput,
>(input: {
  readonly siteId: string;
  readonly count: Count;
  readonly purpose: EventQualifiedSourcePurpose;
  readonly reportFilters?: FilterDocument;
  readonly eventName?: string;
  readonly eventNameInputSemantics?: EventNameInputSemantics;
  readonly reportAttributes?: readonly string[];
}): EventQualifiedSource<Count["scope"]> {
  if (
    input.count.scope === "event" &&
    ((input.purpose !== "event-types" &&
      input.purpose !== "event-trend" &&
      input.purpose !== "summary-cards" &&
      input.purpose !== "event-context" &&
      input.purpose !== "records") ||
      input.reportFilters !== undefined)
  )
    throw new Error("event_candidate_count_reader_not_authorized");
  if (
    input.count.subject.siteIds.length !== 1 ||
    input.count.subject.siteIds[0] !== input.siteId
  )
    throw new Error("event_qualification_site_subject_mismatch");

  const builder = createAdvancedCountQualificationBuilder(input.count);
  const qualification =
    input.count.scope === "event"
      ? appendAdvancedEventCandidateCountQualification(builder, input.count)
      : appendAdvancedCountQualification(builder, input.count);
  const reportMetadata = input.reportFilters
    ? scopedFilterMetadata(input.reportFilters)
    : undefined;
  if (input.reportFilters && !reportMetadata)
    throw new Error("event_qualification_report_source_metadata_missing");
  const context = createEventReportSourceContextForBuilder(
    builder,
    input.reportFilters ?? EMPTY_FILTER_DOCUMENT,
    reportMetadata ? { scopePlan: reportMetadata.plan } : {},
  );
  const hasPreparedTrendNameGate =
    input.purpose === "event-trend" &&
    input.eventNameInputSemantics === "legacy-truthy-raw" &&
    Boolean(input.eventName);
  // Prepared records compare the normalized request name with a trimmed
  // stored label; keep this gate in the logical expression, not the direct
  // source's raw dictionary-name selection.
  const hasPreparedRecordsNameGate =
    input.purpose === "records" && Boolean(input.eventName?.trim());
  const isEventCandidate = input.count.scope === "event";
  const source = addEventReportSource(context, {
    attributes: [
      ...new Set([
        ...(input.purpose === "event-trend"
          ? EVENT_REPORT_TREND_ATTRIBUTES
          : EVENT_REPORT_BASE_ATTRIBUTES),
        ...(input.purpose === "summary-cards"
          ? SUMMARY_CARD_EVENT_ATTRIBUTES
          : []),
        ...(input.purpose === "event-context"
          ? (input.reportAttributes ?? [])
          : []),
        ...(input.purpose === "records" ? EVENT_RECORD_ATTRIBUTES : []),
        ...(isEventCandidate ? ["event.report.localId"] : []),
      ]),
    ],
    ...(input.purpose !== "event-context" &&
    input.eventName !== undefined &&
    !hasPreparedTrendNameGate &&
    !hasPreparedRecordsNameGate
      ? { eventName: input.eventName }
      : {}),
    ...(input.purpose !== "event-context" &&
    input.eventNameInputSemantics &&
    !hasPreparedTrendNameGate &&
    !hasPreparedRecordsNameGate
      ? { eventNameInputSemantics: input.eventNameInputSemantics }
      : {}),
  });
  const eventNameMatches = hasPreparedTrendNameGate
    ? builder.filter(
        source,
        builder.compare(
          "eq",
          builder.normalizeString(
            builder.coalesce(
              builder.slot(source, "attribute:event.report.eventName"),
              builder.literal("", STRING),
            ),
            "trim-ascii-space",
          ),
          builder.literal(input.eventName!, STRING),
        ),
      )
    : hasPreparedRecordsNameGate
      ? builder.filter(
          source,
          builder.compare(
            "eq",
            builder.normalizeString(
              builder.coalesce(
                builder.slot(source, "attribute:event.report.eventName"),
                builder.literal("", STRING),
              ),
              "trim-ascii-space",
            ),
            builder.literal(input.eventName!.trim(), STRING),
          ),
        )
      : input.purpose === "event-context" && input.eventName
        ? builder.filter(
            source,
            builder.compare(
              "eq",
              builder.normalizeString(
                builder.coalesce(
                  builder.slot(source, "attribute:event.report.eventName"),
                  builder.literal("", STRING),
                ),
                "trim-ascii-space",
              ),
              builder.literal(input.eventName, STRING),
            ),
          )
        : source;
  const additionalEventSlots = Object.fromEntries(
    (input.purpose === "event-context" || input.purpose === "records"
      ? (input.reportAttributes ?? [])
      : []
    ).map((attribute) => [
      `attribute:${attribute}`,
      builder.slot(eventNameMatches, `attribute:${attribute}`),
    ]),
  );
  const eventRows = builder.project(eventNameMatches, {
    ...(isEventCandidate
      ? {
          "attribute:event.report.localId": builder.slot(
            eventNameMatches,
            "attribute:event.report.localId",
          ),
        }
      : {}),
    "attribute:event.report.eventName": builder.slot(
      eventNameMatches,
      "attribute:event.report.eventName",
    ),
    "attribute:event.report.ownerSessionId": builder.slot(
      eventNameMatches,
      "attribute:event.report.ownerSessionId",
    ),
    "attribute:event.report.ownerVisitorId": builder.slot(
      eventNameMatches,
      "attribute:event.report.ownerVisitorId",
    ),
    ...(input.purpose === "event-trend"
      ? {
          "attribute:event.report.occurredAt": builder.slot(
            eventNameMatches,
            "attribute:event.report.occurredAt",
          ),
        }
      : {}),
    ...(input.purpose === "summary-cards"
      ? {
          "attribute:event.report.ownerPathname": builder.slot(
            eventNameMatches,
            "attribute:event.report.ownerPathname",
          ),
          "attribute:event.report.ownerTitle": builder.slot(
            eventNameMatches,
            "attribute:event.report.ownerTitle",
          ),
          "attribute:event.report.ownerHostname": builder.slot(
            eventNameMatches,
            "attribute:event.report.ownerHostname",
          ),
        }
      : {}),
    ...additionalEventSlots,
    businessSiteId: builder.literal(input.siteId, STRING),
  });
  const events =
    input.count.scope === "event"
      ? builder.semiJoin(
          eventRows,
          builder.filter(
            qualification.matches,
            builder.compare(
              "eq",
              builder.slot(qualification.matches, "candidateKind"),
              builder.literal("event", STRING),
            ),
          ),
          [
            { left: "businessSiteId", right: "siteId" },
            { left: "attribute:event.report.localId", right: "entityId" },
          ],
        )
      : builder.semiJoin(eventRows, qualification.matches, [
          { left: "businessSiteId", right: "siteId" },
          {
            left:
              input.count.scope === "session"
                ? "attribute:event.report.ownerSessionId"
                : "attribute:event.report.ownerVisitorId",
            right: "entityId",
          },
        ]);

  return {
    builder,
    events,
    eventSourceRelationId: source.id,
    reportSourceRelations: [{ relationId: source.id, entity: "event" }],
    qualification,
  } as EventQualifiedSource<Count["scope"]>;
}

export function addEventQualificationControlOutput(
  builder: EventQualifiedSource["builder"],
  controls: LogicalRelationHandle,
): void {
  const controlFields = Object.keys(controls.slots);
  builder.output(
    EVENT_QUALIFICATION_CONTROL_OUTPUT,
    controls,
    controlFields.map((name) => ({ name, slot: name })),
  );
}
