import type { CompiledQuery } from "@/lib/db";
import {
  caseWhen,
  compileD1Query,
  constant,
  isNull,
  lowerLogicalPlan,
  project,
  sort,
  union,
} from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import type { LogicalQueryNode } from "@/lib/db/query/plan";
import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  CalendarGranularity,
  QueryAudience,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { OVERVIEW_CHANNELS_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/channel-client-geo-report-plan";
import {
  buildChannelListQualificationPlan,
  CHANNEL_LIST_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/channel-list-qualification-plan";
import {
  DIMENSION_PAGE_REPORT_OUTPUT,
  dimensionSortColumns,
  type DimensionSortKey,
  overviewPageTableDescriptor,
  type OverviewPageTableTab,
  type PageDimensionSelection,
  validatePageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  buildEventContextQualificationPlan,
  EVENT_CONTEXT_REPORT_FIELDS,
  EVENT_CONTEXT_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/event-context-report-plan";
import {
  EVENT_FIELD_VALUES_PAGE_FIELDS,
  EVENT_FIELD_VALUES_PAGE_OUTPUT,
  type EventFieldValueCursorValue,
} from "@/lib/edge/analytics/engine/event-field-values-plan";
import { buildEventFieldValuesQualificationPlan } from "@/lib/edge/analytics/engine/event-field-values-qualification-plan";
import {
  EVENT_FIELDS,
  EVENT_FIELDS_PAGE_OUTPUT,
  type EventFieldCursorValue,
} from "@/lib/edge/analytics/engine/event-fields-plan";
import { buildEventFieldsQualificationPlan } from "@/lib/edge/analytics/engine/event-fields-qualification-plan";
import type {
  AnalyticsQualificationPlan,
  EventQualificationPlan,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  buildEventSummaryCardsQualificationPlan,
  EVENT_SUMMARY_CARD_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import {
  buildEventTrendQualificationPlan,
  EVENT_TREND_OUTPUTS,
  type EventTrendQualificationInput,
} from "@/lib/edge/analytics/engine/event-trend-plan";
import {
  buildEventTypeDetailQualificationPlan,
  EVENT_TYPE_DETAIL_CONTEXT_LIMIT,
} from "@/lib/edge/analytics/engine/event-type-detail-plan";
import {
  EVENT_TYPE_OVERVIEW_FIELDS,
  EVENT_TYPE_OVERVIEW_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-type-overview-plan";
import {
  buildEventTypeSummaryQualificationPlan,
  EVENT_TYPE_SUMMARY_OUTPUTS,
  type EventTypePageQuery,
  type EventTypeQualificationQuery,
} from "@/lib/edge/analytics/engine/event-type-summary-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildPageDimensionQualificationPlan,
  buildPagesAggregateQualificationPlan,
  buildPagesTabsQualificationPlan,
  PAGES_AGGREGATE_QUALIFICATION_CONTROL_OUTPUT,
  PAGES_AGGREGATE_REPORT_OUTPUT,
  PAGES_TABS_QUALIFICATION_CONTROL_OUTPUT,
  type PagesTabsQualificationConfiguration,
} from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import type { PageAggregateCursor } from "@/lib/edge/analytics/engine/page-report-plan";
import {
  PAGE_TAB_CARDS,
  PAGE_TAB_OUTPUT_FIELDS,
  PAGE_TAB_OUTPUT_IDS,
} from "@/lib/edge/analytics/engine/page-tabs-report-plan";
import {
  PAGES_WITH_TABS_OUTPUT_FIELDS,
  PAGES_WITH_TABS_OUTPUT_IDS,
  PAGES_WITH_TABS_PAGE_OUTPUT_ID,
} from "@/lib/edge/analytics/engine/pages-with-tabs-report-plan";
import { buildReferrerPageQualificationPlan } from "@/lib/edge/analytics/engine/referrer-page-qualification-plan";
import {
  type ReferrerAggregateCursor,
  type ReferrerOverviewTab,
  type ReferrerPageSortKey,
  REFERRERS_PAGE_REPORT_OUTPUT,
} from "@/lib/edge/analytics/engine/referrer-report-plan";
import {
  buildReferrersQualificationPlan,
  REFERRERS_QUALIFICATION_CONTROL_OUTPUT,
  type ReferrersQualificationConfiguration,
} from "@/lib/edge/analytics/engine/referrers-qualification-plan";
import {
  EVENT_CONTEXT_CARD_KEYS,
  type EventContextCardKey,
} from "@/lib/edge/analytics/engine/semantic/event-context-cards";
import { eventPayloadValueTypeCode } from "@/lib/edge/analytics/engine/semantic/event-payload-value-type";
import {
  buildSessionBoundaryDimensionQualificationPlan,
  buildSessionBoundaryOverviewPageQualificationPlan,
} from "@/lib/edge/analytics/engine/session-boundary-dimension-qualification-plan";
import {
  SESSION_PATH_PAGE_REPORT_OUTPUT,
  SESSION_PATH_TOP_REPORT_OUTPUT,
  type SessionPathCursor,
  type SessionPathKind,
  type SessionPathSortKey,
} from "@/lib/edge/analytics/engine/session-path-report-plan";
import {
  type DeferredChannelListQualification,
  type DeferredEventContextQualification,
  type DeferredEventFieldsQualification,
  type DeferredEventFieldValuesQualification,
  type DeferredEventNameDimensionQualification,
  type DeferredEventQualification,
  type DeferredEventSummaryQualification,
  type DeferredEventTrendQualification,
  type DeferredEventTypeDetailQualification,
  type DeferredEventTypesQualification,
  type DeferredPageQualification,
  type DeferredPagesAggregatePageQualification,
  type DeferredPagesTabsQualification,
  type DeferredReferrersQualification,
  type DeferredSessionBoundaryDimensionQualification,
  type DeferredSessionBoundaryOverviewPageQualification,
  isCanonicalPrivateChannelListWholeFilterRequest,
  isCanonicalPrivateChannelOverviewWholeFilterRequest,
  isCanonicalPrivatePageDimensionWholeFilterRequest,
  isDeferredEventQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import type { AnalyticsQualificationAdmissionPolicy } from "@/lib/edge/analytics/providers/d1/internal/lowering/event-summary-admission";
import { currentD1Operation } from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import type { FilterDocument } from "@/lib/filter-contract/filters";

import { queryD1CompiledAll } from "./core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import {
  type QualificationCompatibilityField,
  qualificationCompatibilityFieldsFromNumeric,
} from "./qualification-compatibility";
import { proveGroupedSummaryRelations } from "./qualification-grouped-summary-evidence";
import {
  assertQualificationNotAborted,
  compileQualificationQuery,
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";

const ENVELOPE_REPORT_FIELDS = [
  "cardType",
  "value",
  "label",
  "views",
  "eventTypes",
  "sessions",
  "visitors",
  "eventName",
  "bucket",
  "seriesName",
  "events",
] as const;

const EVENT_TYPE_DETAIL_ENVELOPE_REPORT_FIELDS = [
  ...ENVELOPE_REPORT_FIELDS,
  "pathname",
  "queryValue",
  "hashValue",
  "scopedEvents",
] as const;

const REFERRER_OVERVIEW_ENVELOPE_REPORT_FIELDS = [
  "referrer",
  "views",
  "sessions",
  "visitors",
] as const;

const EVENT_SUMMARY_REPORT_FIELDS = [
  "cardType",
  "value",
  "views",
  "eventTypes",
  "sessions",
  "visitors",
] as const;

const EVENT_TYPE_REPORT_FIELDS = [
  "value",
  "views",
  "sessions",
  "visitors",
] as const;

const EVENT_TREND_REPORT_FIELDS = {
  [EVENT_TREND_OUTPUTS.series]: ["eventName", "events", "sessions", "visitors"],
  [EVENT_TREND_OUTPUTS.points]: ["bucket", "seriesName", "events"],
  [EVENT_TREND_OUTPUTS.other]: ["eventName", "events", "sessions", "visitors"],
} as const;

const EVENT_TYPE_DETAIL_TREND_FIELDS = [
  "bucket",
  "events",
  "visitors",
] as const;
const EVENT_FIELDS_REPORT_FIELDS = EVENT_FIELDS.map(({ name }) => name);
const REFERRERS_SUMMARY_REPORT_FIELDS = [
  "rowType",
  "referrer",
  "totalViews",
  "directViews",
  "externalViews",
  "uniqueDomains",
  "uniqueLinks",
  "views",
] as const;
const REFERRERS_PAGE_REPORT_FIELDS = [
  "referrer",
  "views",
  "sessions",
  "visitors",
] as const;
const REFERRERS_ENVELOPE_REPORT_FIELDS = [
  ...REFERRERS_SUMMARY_REPORT_FIELDS,
  "sessions",
  "visitors",
] as const;
type ReportOrderKey = {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
};

interface PayloadReportFamily {
  readonly outputId: string;
  readonly fields: readonly string[];
  readonly order: readonly ReportOrderKey[];
  readonly statementTag: string;
}

const EVENT_FIELDS_REPORT_FAMILY: PayloadReportFamily = {
  outputId: EVENT_FIELDS_PAGE_OUTPUT,
  fields: EVENT_FIELDS_REPORT_FIELDS,
  order: [
    { field: "outputId", direction: "asc", nulls: "last" },
    { field: "events", direction: "desc", nulls: "last" },
    { field: "occurrences", direction: "desc", nulls: "last" },
    { field: "path", direction: "asc", nulls: "first" },
    { field: "valueType", direction: "asc", nulls: "first" },
  ],
  statementTag: "analytics.event_fields_qualification",
};

const EVENT_FIELD_VALUES_REPORT_FAMILY: PayloadReportFamily = {
  outputId: EVENT_FIELD_VALUES_PAGE_OUTPUT,
  fields: EVENT_FIELD_VALUES_PAGE_FIELDS,
  order: [
    { field: "outputId", direction: "asc", nulls: "last" },
    { field: "occurrences", direction: "desc", nulls: "last" },
    { field: "events", direction: "desc", nulls: "last" },
    { field: "valueString", direction: "asc", nulls: "first" },
    { field: "valueNumber", direction: "asc", nulls: "first" },
    { field: "valueBoolean", direction: "asc", nulls: "first" },
  ],
  statementTag: "analytics.event_field_values_qualification",
};

const REPORT_ORDER = [
  { field: "cardType", direction: "asc", nulls: "first" },
  { field: "views", direction: "desc", nulls: "last" },
  { field: "sessions", direction: "desc", nulls: "last" },
  { field: "visitors", direction: "desc", nulls: "last" },
  { field: "value", direction: "asc", nulls: "first" },
] as const;

const EVENT_TYPE_REPORT_ORDER = [
  { field: "views", direction: "desc", nulls: "last" },
  { field: "sessions", direction: "desc", nulls: "last" },
  { field: "value", direction: "asc", nulls: "last" },
] as const;

const EVENT_TREND_REPORT_ORDER = [
  { field: "outputId", direction: "asc", nulls: "last" },
  { field: "events", direction: "desc", nulls: "last" },
  { field: "sessions", direction: "desc", nulls: "last" },
  { field: "eventName", direction: "asc", nulls: "last" },
  { field: "bucket", direction: "asc", nulls: "last" },
  { field: "seriesName", direction: "asc", nulls: "last" },
  { field: "visitors", direction: "desc", nulls: "last" },
] as const;

const REPORT_OUTPUT_TYPES = [
  [EVENT_SUMMARY_CARD_OUTPUTS.summary, "__summary__"],
  [EVENT_SUMMARY_CARD_OUTPUTS.event, "event"],
  [EVENT_SUMMARY_CARD_OUTPUTS.path, "path"],
  [EVENT_SUMMARY_CARD_OUTPUTS.title, "title"],
  [EVENT_SUMMARY_CARD_OUTPUTS.hostname, "hostname"],
] as const;

const QUALIFICATION_ENVELOPE_RESERVED_FIELDS = new Set([
  "rowKind",
  "outputId",
  "referrer",
  ...ENVELOPE_REPORT_FIELDS,
  ...REFERRERS_SUMMARY_REPORT_FIELDS,
  "scopedEvents",
  ...EVENT_FIELDS_REPORT_FIELDS,
  ...EVENT_FIELD_VALUES_REPORT_FAMILY.fields,
  ...PAGES_WITH_TABS_OUTPUT_FIELDS,
]);

export interface EventSummaryQualificationCompilationEvidence {
  readonly statementTag: string;
  readonly sql: string;
  readonly bindings: readonly unknown[];
  readonly sqlBytes: number;
  readonly bindingCount: number;
  readonly groupWidth: number;
  readonly groupedSummaryMaterialization: "materialized";
  readonly groupedSummaryMaterializations?: readonly {
    readonly relationId: string;
    readonly groupWidth: number;
    readonly materialization: "materialized";
  }[];
  readonly qualifiedReportInputWidth?: number;
  readonly qualifiedReportInputMaterialization?: "materialized";
  readonly sharedRelationCount: number;
  readonly rootKind: string;
  readonly physicalScanKinds: readonly string[];
  readonly physicalPlanShape?: CompiledQuery["physicalPlanShape"];
}

type QualifiedReportKind =
  | "event-summary"
  | "event-types"
  | "event-trend"
  | "event-context"
  | "event-type-detail"
  | "event-fields"
  | "event-field-values"
  | "page-dimension"
  | "referrers"
  | "pages-aggregate-page"
  | "pages-tabs"
  | "channel-list"
  | "session-boundary-dimension"
  | "session-boundary-overview-page";

const PAGE_DIMENSION_REPORT_FIELDS = [
  "value",
  "views",
  "sessions",
  "visitors",
] as const;
const PAGES_AGGREGATE_REPORT_FIELDS = [
  "pathname",
  "queryValue",
  "hashValue",
  "views",
  "sessions",
] as const;
const PAGES_TABS_ENVELOPE_REPORT_FIELDS = PAGES_WITH_TABS_OUTPUT_FIELDS;
const CHANNEL_LIST_REPORT_FIELDS = [
  "channel",
  "views",
  "sessions",
  "visitors",
] as const;
const PAGE_DIMENSION_REPORT_STATEMENT_TAG =
  "analytics.page_dimension_qualification";

function payloadReportFamily(
  kind: QualifiedReportKind,
): PayloadReportFamily | undefined {
  if (kind === "event-fields") return EVENT_FIELDS_REPORT_FAMILY;
  if (kind === "event-field-values") return EVENT_FIELD_VALUES_REPORT_FAMILY;
  return undefined;
}

function pageDimensionReportOrder(
  query: PageDimensionQualificationReportQuery,
): readonly ReportOrderKey[] {
  if (query.family === "referrer-overview") {
    const primary = query.sortBy === "visitors" ? "visitors" : "views";
    const secondary = query.sortBy === "visitors" ? "views" : "sessions";
    return [
      { field: "outputId", direction: "asc", nulls: "last" },
      { field: primary, direction: query.sortDirection, nulls: "last" },
      { field: secondary, direction: query.sortDirection, nulls: "last" },
      { field: "referrer", direction: "asc", nulls: "first" },
    ];
  }
  const columns = dimensionSortColumns(query.sortBy);
  return [
    { field: "outputId", direction: "asc", nulls: "last" },
    { field: columns.primary, direction: query.sortDirection, nulls: "last" },
    {
      field: columns.secondary,
      direction: query.sortDirection,
      nulls: "last",
    },
    { field: "value", direction: "asc", nulls: "first" },
  ];
}

function channelListReportOrder(): readonly ReportOrderKey[] {
  return [
    { field: "outputId", direction: "asc", nulls: "last" },
    { field: "views", direction: "desc", nulls: "last" },
    { field: "sessions", direction: "desc", nulls: "last" },
    { field: "channel", direction: "asc", nulls: "first" },
  ];
}

function sessionBoundaryDimensionReportOrder(
  query:
    | SessionBoundaryDimensionQualificationReportQuery
    | SessionBoundaryOverviewPageQualificationReportQuery,
): readonly ReportOrderKey[] {
  const secondary: readonly ReportOrderKey[] =
    query.sortBy === "visitors"
      ? [
          {
            field: "views",
            direction: query.sortDirection,
            nulls: "last",
          },
        ]
      : [];
  return [
    { field: "outputId", direction: "asc", nulls: "last" },
    { field: query.sortBy, direction: query.sortDirection, nulls: "last" },
    ...secondary,
    { field: "value", direction: "asc", nulls: "first" },
  ];
}

interface EventQualificationProgram {
  readonly query: CompiledQuery<Record<string, unknown>>;
  readonly evidence: EventSummaryQualificationCompilationEvidence;
  readonly deferred:
    | DeferredEventQualification
    | DeferredEventTypesQualification
    | DeferredEventNameDimensionQualification;
  readonly reportKind: QualifiedReportKind;
  readonly reportOutputIds: readonly string[];
  readonly controlOutputId: string;
  readonly compatibilityFields: readonly QualificationCompatibilityField[];
  readonly reportCardTypes?: readonly EventContextCardKey[];
  readonly reportEnvelopeFields: readonly string[];
  readonly reportConfiguration?:
    PagesTabsQualificationConfiguration | ReferrersQualificationConfiguration;
}

interface PageDimensionQualificationReportQueryBase {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly selection: PageDimensionSelection;
  readonly limit: number;
  readonly cursor: DimensionCursor | null;
  readonly cursorToken: string | null;
  readonly search?: string;
  readonly sortBy: DimensionSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly audience: QueryAudience;
}

export type PageDimensionQualificationReportQuery =
  | (PageDimensionQualificationReportQueryBase & {
      readonly family?: "breakdown";
      readonly dimension: string;
      readonly excludeEmpty: false;
    })
  | (PageDimensionQualificationReportQueryBase & {
      readonly family: "overview-tab";
      readonly tab: OverviewPageTableTab;
      readonly excludeEmpty: boolean;
    })
  | {
      readonly siteId: string;
      readonly queryTime: QueryTime;
      readonly filters: FilterDocument;
      readonly scopePlan?: ScopedFilterPlan;
      readonly family: "referrer-overview";
      readonly tab: ReferrerOverviewTab;
      readonly includeFullUrl: boolean;
      readonly limit: number;
      readonly cursor: ReferrerAggregateCursor | null;
      readonly cursorToken: string | null;
      readonly search?: string;
      readonly sortBy: ReferrerPageSortKey;
      readonly sortDirection: "asc" | "desc";
      readonly audience: QueryAudience;
    };

export interface PagesAggregateQualificationReportQuery {
  readonly env: Env;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursor: PageAggregateCursor | null;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
  readonly variant: string | undefined;
  readonly includeTabs: boolean | undefined;
}

export interface PagesTabsQualificationReportQuery {
  readonly env: Env;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly configuration: PagesTabsQualificationConfiguration;
  readonly limit: number;
  readonly includeDetails: boolean;
  readonly cursor: PageAggregateCursor | null;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
  readonly variant: string | undefined;
  readonly includeTabs: boolean | undefined;
}

export interface SessionBoundaryDimensionQualificationReportQuery {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly dimension: "session.entryPath" | "session.exitPath";
  readonly kind: SessionPathKind;
  readonly limit: number;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly audience: QueryAudience;
}

export interface SessionBoundaryOverviewPageQualificationReportQuery {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly mode: "overview-tab";
  readonly tab: "page.entry" | "page.exit";
  readonly dimension: "session.entryPath" | "session.exitPath";
  readonly kind: SessionPathKind;
  readonly limit: number;
  readonly cursor: SessionPathCursor | null;
  readonly cursorToken: string | null;
  readonly search?: string;
  readonly sortBy: SessionPathSortKey;
  readonly sortDirection: "asc" | "desc";
  readonly audience: QueryAudience;
}

export interface ChannelListQualificationReportQuery {
  readonly env: Env;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly mode: "list";
  readonly limit: number;
  readonly sourceLimit: number | undefined;
  readonly audience: QueryAudience;
  readonly hasComparison: boolean;
  readonly hasCurrent: boolean;
  readonly hasReference: boolean;
}

type DimensionCursor = {
  readonly primary: number;
  readonly secondary: number;
  readonly value: string;
};

export type EventSummaryQualificationCompilation =
  | {
      readonly kind: "compiled";
      readonly evidence: EventSummaryQualificationCompilationEvidence;
    }
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

export type EventSummaryQualificationExecution =
  | {
      readonly kind: "executed";
      readonly rows: readonly Record<string, unknown>[];
      readonly evidence: EventSummaryQualificationCompilationEvidence;
    }
  | {
      readonly kind: "legacy";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

const compiledPrograms = new WeakSet<object>();

function invalidInput(
  path: string,
  code: string,
): AnalyticsProviderDomainError {
  return new AnalyticsProviderDomainError({
    kind: "invalid-input",
    issues: [{ path, code }],
  });
}

function exactOutput(
  outputs: readonly LogicalOutput[],
  outputId: string,
): LogicalOutput {
  const matches = outputs.filter((output) => output.id === outputId);
  if (matches.length !== 1)
    throw new Error(`analytics_event_summary_qualification_output:${outputId}`);
  return matches[0]!;
}

function scanKinds(root: LogicalQueryNode): string[] {
  const visited = new Set<LogicalQueryNode>();
  const kinds = new Set<string>();
  const pending: LogicalQueryNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);
    if (node.kind === "scan") kinds.add(node.table.name);
    switch (node.kind) {
      case "scan":
      case "values-relation":
      case "json-scalar-array":
        break;
      case "filter":
      case "project":
      case "distinct":
      case "sort":
      case "limit":
      case "window":
      case "aggregate":
        pending.push(node.input.node);
        break;
      case "recursive-closure":
        pending.push(node.seed.node, node.candidates.node);
        break;
      case "join":
      case "semi-join":
        pending.push(node.left.node, node.right.node);
        break;
      case "union":
        pending.push(node.left.node, node.right.node);
        break;
    }
  }
  return [...kinds].sort();
}

function requireScalarReportRelation(
  output: LogicalOutput,
  lowered: ReturnType<AnalyticsLogicalToDbLowerer["lowerMany"]>[number],
  lowerer: AnalyticsLogicalToDbLowerer,
  expectedFields: readonly string[],
): AnalyticsDbRelation {
  if (
    output.fields.length !== expectedFields.length ||
    output.fields.some((field, index) => field.name !== expectedFields[index])
  )
    throw new Error(
      `analytics_event_summary_qualification_schema:${output.id}`,
    );
  return lowerer.projectOutput(
    lowered,
    output.fields.map(({ name, slot }) => ({ name, slot })),
  );
}

function envelopeReportFieldsForKind(
  kind: QualifiedReportKind,
  pageQuery?:
    | PageDimensionQualificationReportQuery
    | ReferrersQualificationReportQuery
    | PagesAggregateQualificationReportQuery
    | PagesTabsQualificationReportQuery,
): readonly string[] {
  const payloadFamily = payloadReportFamily(kind);
  if (payloadFamily) return payloadFamily.fields;
  if (kind === "channel-list") return CHANNEL_LIST_REPORT_FIELDS;
  if (kind === "pages-aggregate-page") return PAGES_AGGREGATE_REPORT_FIELDS;
  if (kind === "pages-tabs") return PAGES_TABS_ENVELOPE_REPORT_FIELDS;
  if (kind === "referrers") return REFERRERS_ENVELOPE_REPORT_FIELDS;
  if (kind === "page-dimension")
    return pageQuery &&
      "family" in pageQuery &&
      pageQuery.family === "referrer-overview"
      ? REFERRER_OVERVIEW_ENVELOPE_REPORT_FIELDS
      : ENVELOPE_REPORT_FIELDS;
  if (kind === "event-type-detail")
    return EVENT_TYPE_DETAIL_ENVELOPE_REPORT_FIELDS;
  return ENVELOPE_REPORT_FIELDS;
}

function taggedReportRows(
  relation: AnalyticsDbRelation,
  outputId: string,
  controlNames: readonly string[],
  reportFields: readonly string[],
) {
  const projections: Record<string, AnyExpression> = {
    rowKind: constant("report"),
    outputId: constant(outputId),
  };
  for (const field of reportFields)
    projections[field] = relation.columns[field] ?? constant(null);
  for (const field of controlNames) {
    if (
      QUALIFICATION_ENVELOPE_RESERVED_FIELDS.has(field) ||
      field in projections
    )
      throw new Error(
        `analytics_event_summary_qualification_control_name:${field}`,
      );
    projections[field] = constant(null);
  }
  return project(relation, projections);
}

function taggedControlRows(
  relation: AnalyticsDbRelation,
  controlOutputId: string,
  controlNames: readonly string[],
  reportFields: readonly string[],
) {
  const projections: Record<string, AnyExpression> = {
    rowKind: constant("control"),
    outputId: constant(controlOutputId),
  };
  for (const field of reportFields) projections[field] = constant(null);
  for (const field of controlNames) {
    if (
      QUALIFICATION_ENVELOPE_RESERVED_FIELDS.has(field) ||
      field in projections
    )
      throw new Error(
        `analytics_event_summary_qualification_control_name:${field}`,
      );
    const value = relation.columns[field];
    if (!value)
      throw new Error(
        `analytics_event_summary_qualification_control_missing:${field}`,
      );
    projections[field] = value;
  }
  return project(relation, projections);
}

export interface EventTrendQualificationQuery {
  readonly interval: EventTrendQualificationInput["interval"];
  readonly limit: number;
  readonly otherToken: string;
  readonly otherLabel: string;
  readonly eventName?: string;
}

export interface EventContextQualificationQuery {
  readonly limit: number;
  readonly selectedKeys: readonly EventContextCardKey[];
  readonly eventName?: string;
}

export interface EventTypeDetailQualificationQuery {
  readonly eventName: string;
  readonly interval: CalendarGranularity;
  readonly includeBreakdowns: boolean;
  readonly includeContext: boolean;
  readonly contextLimit?: number;
  readonly selectedKeys?: readonly EventContextCardKey[];
}

type EventQualificationCompileRequest =
  | {
      readonly kind: "event-summary";
      readonly deferred: DeferredEventSummaryQualification;
    }
  | {
      readonly kind: "event-types";
      readonly deferred:
        | DeferredEventTypesQualification
        | DeferredEventNameDimensionQualification;
      readonly query: EventTypeQualificationQuery;
    }
  | {
      readonly kind: "event-trend";
      readonly deferred: DeferredEventTrendQualification;
      readonly query: EventTrendQualificationQuery;
    }
  | {
      readonly kind: "event-context";
      readonly deferred: DeferredEventContextQualification;
      readonly query: EventContextQualificationQuery;
    }
  | {
      readonly kind: "event-type-detail";
      readonly deferred: DeferredEventTypeDetailQualification;
      readonly query: EventTypeDetailQualificationQuery;
    }
  | {
      readonly kind: "event-fields";
      readonly deferred: DeferredEventFieldsQualification;
      readonly query: EventFieldsQualificationQuery;
    }
  | {
      readonly kind: "event-field-values";
      readonly deferred: DeferredEventFieldValuesQualification;
      readonly query: EventFieldValuesQualificationQuery;
    }
  | {
      readonly kind: "page-dimension";
      readonly deferred: DeferredPageQualification;
      readonly query: PageDimensionQualificationReportQuery;
    }
  | {
      readonly kind: "referrers";
      readonly deferred: DeferredReferrersQualification;
      readonly query: ReferrersQualificationReportQuery;
    }
  | {
      readonly kind: "pages-aggregate-page";
      readonly deferred: DeferredPagesAggregatePageQualification;
      readonly query: PagesAggregateQualificationReportQuery;
    }
  | {
      readonly kind: "pages-tabs";
      readonly deferred: DeferredPagesTabsQualification;
      readonly query: PagesTabsQualificationReportQuery;
    }
  | {
      readonly kind: "channel-list";
      readonly deferred: DeferredChannelListQualification;
      readonly query: ChannelListQualificationReportQuery;
    }
  | {
      readonly kind: "session-boundary-dimension";
      readonly deferred: DeferredSessionBoundaryDimensionQualification;
      readonly query: SessionBoundaryDimensionQualificationReportQuery;
    }
  | {
      readonly kind: "session-boundary-overview-page";
      readonly deferred: DeferredSessionBoundaryOverviewPageQualification;
      readonly query: SessionBoundaryOverviewPageQualificationReportQuery;
    };

export interface EventFieldsQualificationQuery {
  readonly env: Env;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly eventName?: string;
  readonly limit: number;
  readonly cursor: EventFieldCursorValue | null;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
}

export interface EventFieldValuesQualificationQuery {
  readonly env: Env;
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly eventName?: string;
  readonly fieldPath: string;
  readonly fieldValueType: string;
  readonly search?: string;
  readonly limit: number;
  readonly cursor: EventFieldValueCursorValue | null;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
}

export interface ReferrersQualificationReportQuery {
  readonly siteId: string;
  readonly queryTime: QueryTime;
  readonly filters: FilterDocument;
  readonly scopePlan?: ScopedFilterPlan;
  readonly configuration: ReferrersQualificationConfiguration;
  readonly cursorToken: string | null;
  readonly audience: QueryAudience;
}

function reportFieldsForOutput(
  kind: QualifiedReportKind,
  outputId: string,
  configuration?:
    PagesTabsQualificationConfiguration | ReferrersQualificationConfiguration,
): readonly string[] {
  const payloadFamily = payloadReportFamily(kind);
  if (payloadFamily) {
    if (outputId !== payloadFamily.outputId)
      throw new Error(
        kind === "event-fields"
          ? `analytics_event_fields_qualification_output:${outputId}`
          : `analytics_event_field_values_qualification_output:${outputId}`,
      );
    return payloadFamily.fields;
  }
  if (kind === "channel-list") {
    if (outputId !== OVERVIEW_CHANNELS_REPORT_OUTPUT)
      throw new Error(
        `analytics_channel_list_qualification_output:${outputId}`,
      );
    return CHANNEL_LIST_REPORT_FIELDS;
  }
  if (kind === "page-dimension") {
    if (outputId === REFERRERS_PAGE_REPORT_OUTPUT)
      return REFERRER_OVERVIEW_ENVELOPE_REPORT_FIELDS;
    if (outputId !== DIMENSION_PAGE_REPORT_OUTPUT)
      throw new Error(
        `analytics_page_dimension_qualification_output:${outputId}`,
      );
    return PAGE_DIMENSION_REPORT_FIELDS;
  }
  if (kind === "referrers") {
    const referrersConfiguration =
      typeof configuration === "object" && configuration !== null
        ? configuration
        : undefined;
    if (
      referrersConfiguration?.kind === "summary" &&
      (outputId === "referrer-summary" || outputId === "referrer-top-sources")
    )
      return REFERRERS_SUMMARY_REPORT_FIELDS;
    if (
      referrersConfiguration?.kind === "page" &&
      outputId === REFERRERS_PAGE_REPORT_OUTPUT
    )
      return REFERRERS_PAGE_REPORT_FIELDS;
    throw new Error(`analytics_referrers_qualification_output:${outputId}`);
  }
  if (kind === "pages-aggregate-page") {
    if (outputId !== PAGES_AGGREGATE_REPORT_OUTPUT)
      throw new Error(
        `analytics_pages_aggregate_qualification_output:${outputId}`,
      );
    return PAGES_AGGREGATE_REPORT_FIELDS;
  }
  if (kind === "pages-tabs") {
    if (
      typeof configuration === "string" &&
      configuration === "tabs-only" &&
      (PAGE_TAB_OUTPUT_IDS as readonly string[]).includes(outputId)
    )
      return PAGE_TAB_OUTPUT_FIELDS;
    if (
      typeof configuration === "string" &&
      configuration === "pages-with-tabs" &&
      (PAGES_WITH_TABS_OUTPUT_IDS as readonly string[]).includes(outputId)
    )
      return PAGES_WITH_TABS_OUTPUT_FIELDS;
    throw new Error(`analytics_pages_tabs_qualification_output:${outputId}`);
  }
  if (kind === "session-boundary-dimension") {
    if (outputId !== SESSION_PATH_TOP_REPORT_OUTPUT)
      throw new Error(
        `analytics_session_boundary_dimension_qualification_output:${outputId}`,
      );
    return PAGE_DIMENSION_REPORT_FIELDS;
  }
  if (kind === "session-boundary-overview-page") {
    if (outputId !== SESSION_PATH_PAGE_REPORT_OUTPUT)
      throw new Error(
        `analytics_session_boundary_overview_page_qualification_output:${outputId}`,
      );
    return PAGE_DIMENSION_REPORT_FIELDS;
  }
  if (kind === "event-summary") return EVENT_SUMMARY_REPORT_FIELDS;
  if (kind === "event-types") return EVENT_TYPE_REPORT_FIELDS;
  if (kind === "event-type-detail") {
    if (
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.summary ||
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.page ||
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.country ||
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.device ||
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.browser
    )
      return EVENT_TYPE_OVERVIEW_FIELDS.map(({ name }) => name);
    if (outputId === EVENT_TREND_OUTPUTS.typePoints)
      return EVENT_TYPE_DETAIL_TREND_FIELDS;
    if (outputId === EVENT_CONTEXT_REPORT_OUTPUT)
      return EVENT_CONTEXT_REPORT_FIELDS;
    throw new Error(
      `analytics_event_type_detail_qualification_output:${outputId}`,
    );
  }
  if (kind === "event-context") {
    if (outputId !== EVENT_CONTEXT_REPORT_OUTPUT)
      throw new Error(
        `analytics_event_context_qualification_output:${outputId}`,
      );
    return EVENT_CONTEXT_REPORT_FIELDS;
  }
  const fields = (
    EVENT_TREND_REPORT_FIELDS as Record<string, readonly string[]>
  )[outputId];
  if (!fields)
    throw new Error(`analytics_event_trend_qualification_output:${outputId}`);
  return fields;
}

type EventPayloadQualificationRequest = Extract<
  EventQualificationCompileRequest,
  { readonly kind: "event-fields" | "event-field-values" }
>;

function payloadRequestContextMatches(
  deferred: DeferredEventQualification,
  query: EventFieldsQualificationQuery | EventFieldValuesQualificationQuery,
): boolean {
  return (
    deferred.env === query.env &&
    deferred.siteId === query.siteId &&
    JSON.stringify(deferred.filters) === JSON.stringify(query.filters) &&
    JSON.stringify(deferred.metadata.plan) ===
      JSON.stringify(query.scopePlan ?? deferred.metadata.plan) &&
    (deferred.requestScopePlan === undefined ||
      JSON.stringify(deferred.requestScopePlan) ===
        JSON.stringify(query.scopePlan ?? deferred.requestScopePlan)) &&
    deferred.requestTime !== undefined &&
    sameEventFieldsQueryTime(deferred.requestTime, query.queryTime) &&
    sameEventFieldsQueryTime(deferred.time, query.queryTime)
  );
}

function validatePayloadRequest(request: EventPayloadQualificationRequest) {
  if (request.kind === "event-fields") {
    const prepared = request.deferred.eventFieldsRequest;
    const query = request.query;
    if (
      !prepared ||
      !payloadRequestContextMatches(request.deferred, query) ||
      (prepared.eventName ?? undefined) !== (query.eventName || undefined) ||
      prepared.limit !== query.limit ||
      prepared.cursor !== query.cursorToken ||
      prepared.audience !== query.audience ||
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 200
    )
      throw invalidInput("query", "event_fields_request_context_mismatch");
    return;
  }

  const prepared = request.deferred.eventFieldValuesRequest;
  const query = request.query;
  if (
    !prepared ||
    !payloadRequestContextMatches(request.deferred, query) ||
    (prepared.eventName ?? undefined) !== (query.eventName || undefined) ||
    prepared.fieldPath !== query.fieldPath ||
    prepared.fieldValueType !== query.fieldValueType ||
    (prepared.search ?? undefined) !== (query.search || undefined) ||
    prepared.limit !== query.limit ||
    prepared.cursor !== query.cursorToken ||
    prepared.audience !== query.audience ||
    eventPayloadValueTypeCode(query.fieldValueType) === null ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    query.limit > 200
  )
    throw invalidInput("query", "event_field_values_request_context_mismatch");
}

function pageDimensionWholeFilterModeMatchesRequest(
  deferred: DeferredEventQualification,
  query: PageDimensionQualificationReportQuery,
): boolean {
  if (deferred.pageDimensionFilterMode !== "allow-whole-filter") return true;
  if (query.family === "overview-tab") {
    if (
      query.tab === "source.channel" &&
      deferred.operation === "channel-overview"
    )
      return isCanonicalPrivateChannelOverviewWholeFilterRequest({
        mode: query.family,
        audience: query.audience,
        tab: query.tab,
        family: deferred.overviewPageTableRequest?.family,
        selection: query.selection,
        excludeEmpty: query.excludeEmpty,
      });
    return isCanonicalPrivatePageDimensionWholeFilterRequest({
      mode: "overview-tab",
      audience: query.audience,
      tab: query.tab,
      overviewFamily: deferred.overviewPageTableRequest?.family,
      selection: query.selection,
      excludeEmpty: query.excludeEmpty,
    });
  }
  if (query.family !== undefined && query.family !== "breakdown") return false;
  return isCanonicalPrivatePageDimensionWholeFilterRequest({
    mode: "breakdown",
    audience: query.audience,
    dimension: query.dimension,
    selection: query.selection,
    excludeEmpty: query.excludeEmpty,
  });
}

function validatePageDimensionRequest(
  request: Extract<
    EventQualificationCompileRequest,
    { readonly kind: "page-dimension" }
  >,
) {
  const deferred = request.deferred;
  const query = request.query;
  let requestMatches: boolean;
  if (query.family === "referrer-overview") {
    const prepared = deferred.referrerOverviewRequest;
    requestMatches = Boolean(
      prepared &&
      deferred.pageDimensionRequest === undefined &&
      deferred.overviewPageTableRequest === undefined &&
      prepared.mode === "overview-tab" &&
      prepared.tab === query.tab &&
      prepared.includeFullUrl === query.includeFullUrl &&
      ((query.tab === "source.link" && query.includeFullUrl) ||
        (query.tab === "source.domain" && !query.includeFullUrl)) &&
      prepared.limit === query.limit &&
      prepared.cursorText === query.cursorToken &&
      prepared.search === query.search &&
      prepared.sortBy === query.sortBy &&
      prepared.sortDirection === query.sortDirection &&
      prepared.audience === query.audience &&
      Number.isSafeInteger(query.limit) &&
      query.limit >= 1,
    );
  } else {
    let canonicalSelection: PageDimensionSelection;
    try {
      canonicalSelection = validatePageDimensionSelection(query.selection);
    } catch {
      throw invalidInput("query", "page_dimension_request_context_mismatch");
    }
    requestMatches =
      query.family === "overview-tab"
        ? (() => {
            const prepared = deferred.overviewPageTableRequest;
            const descriptor = overviewPageTableDescriptor(query.tab);
            const channelOverview = query.tab === "source.channel";
            return Boolean(
              prepared &&
              deferred.operation ===
                (channelOverview ? "channel-overview" : "page-dimension") &&
              deferred.pageDimensionRequest === undefined &&
              deferred.referrerOverviewRequest === undefined &&
              descriptor &&
              (descriptor.family === "channel") === channelOverview &&
              prepared.mode === "overview-tab" &&
              prepared.tab === query.tab &&
              JSON.stringify(prepared.selection) ===
                JSON.stringify(canonicalSelection) &&
              JSON.stringify(descriptor.selection) ===
                JSON.stringify(canonicalSelection) &&
              prepared.excludeEmpty === descriptor.excludeEmpty &&
              query.excludeEmpty === descriptor.excludeEmpty &&
              prepared.limit === query.limit &&
              prepared.cursorText === query.cursorToken &&
              prepared.search === query.search &&
              prepared.sortBy === query.sortBy &&
              prepared.sortDirection === query.sortDirection &&
              prepared.audience === query.audience &&
              Number.isSafeInteger(query.limit) &&
              query.limit >= 1,
            );
          })()
        : (() => {
            const prepared = deferred.pageDimensionRequest;
            return Boolean(
              prepared &&
              deferred.overviewPageTableRequest === undefined &&
              deferred.referrerOverviewRequest === undefined &&
              prepared.dimension === query.dimension &&
              JSON.stringify(prepared.selection) ===
                JSON.stringify(canonicalSelection) &&
              prepared.limit === query.limit &&
              prepared.cursorText === query.cursorToken &&
              prepared.search === query.search &&
              prepared.sortBy === query.sortBy &&
              prepared.sortDirection === query.sortDirection &&
              query.excludeEmpty === false &&
              prepared.audience === query.audience,
            );
          })();
  }
  if (
    deferred.siteId !== query.siteId ||
    JSON.stringify(deferred.filters) !== JSON.stringify(query.filters) ||
    JSON.stringify(deferred.metadata.plan) !==
      JSON.stringify(query.scopePlan ?? deferred.metadata.plan) ||
    (deferred.requestScopePlan !== undefined &&
      JSON.stringify(deferred.requestScopePlan) !==
        JSON.stringify(query.scopePlan ?? deferred.requestScopePlan)) ||
    deferred.requestTime === undefined ||
    !sameEventFieldsQueryTime(deferred.requestTime, query.queryTime) ||
    !sameEventFieldsQueryTime(deferred.time, query.queryTime) ||
    !requestMatches ||
    !pageDimensionWholeFilterModeMatchesRequest(deferred, query)
  )
    throw invalidInput(
      "query",
      query.family === "overview-tab" && query.tab === "source.channel"
        ? "channel_overview_request_context_mismatch"
        : "page_dimension_request_context_mismatch",
    );
}

function validateReferrersRequest(
  request: Extract<
    EventQualificationCompileRequest,
    { readonly kind: "referrers" }
  >,
) {
  const deferred = request.deferred;
  const prepared = deferred.referrersRequest;
  const query = request.query;
  const configuration = query.configuration as unknown;
  const configurationLimit = isRecord(configuration)
    ? configuration.kind === "summary"
      ? configuration.topN
      : configuration.limit
    : undefined;
  let requestMatches = false;
  if (prepared.kind === "summary" && isRecord(configuration)) {
    requestMatches =
      exactKeys(configuration, ["kind", "topN"]) &&
      configuration.kind === "summary" &&
      configuration.topN === prepared.topN &&
      query.cursorToken === null;
  } else if (prepared.kind === "page" && isRecord(configuration)) {
    const expectedKeys =
      prepared.search === undefined
        ? [
            "kind",
            "limit",
            "includeFullUrl",
            "sortBy",
            "sortDirection",
            "cursor",
          ]
        : [
            "kind",
            "limit",
            "includeFullUrl",
            "search",
            "sortBy",
            "sortDirection",
            "cursor",
          ];
    const cursor = configuration.cursor;
    const validCursor =
      cursor === null ||
      (isRecord(cursor) &&
        exactKeys(cursor, ["primary", "secondary", "referrer"]) &&
        finiteNumber(cursor.primary) &&
        finiteNumber(cursor.secondary) &&
        typeof cursor.referrer === "string");
    requestMatches =
      exactKeys(configuration, expectedKeys) &&
      configuration.kind === "page" &&
      configuration.limit === prepared.limit &&
      configuration.includeFullUrl === prepared.includeFullUrl &&
      configuration.search === prepared.search &&
      configuration.sortBy === prepared.sortBy &&
      configuration.sortDirection === prepared.sortDirection &&
      validCursor &&
      query.cursorToken === prepared.cursorText;
  }
  if (
    !prepared ||
    deferred.operation !== "referrers" ||
    deferred.siteId !== query.siteId ||
    JSON.stringify(deferred.filters) !== JSON.stringify(query.filters) ||
    JSON.stringify(deferred.metadata.plan) !==
      JSON.stringify(query.scopePlan ?? deferred.metadata.plan) ||
    (deferred.requestScopePlan !== undefined &&
      JSON.stringify(deferred.requestScopePlan) !==
        JSON.stringify(query.scopePlan ?? deferred.requestScopePlan)) ||
    deferred.requestTime === undefined ||
    !sameEventFieldsQueryTime(deferred.requestTime, query.queryTime) ||
    !sameEventFieldsQueryTime(deferred.time, query.queryTime) ||
    prepared.audience !== query.audience ||
    query.audience !== "private-dashboard" ||
    typeof configurationLimit !== "number" ||
    !Number.isSafeInteger(configurationLimit) ||
    configurationLimit < 0 ||
    !requestMatches
  )
    throw invalidInput("query", "referrers_request_context_mismatch");
}

function validatePagesAggregatePageRequest(
  request: Extract<
    EventQualificationCompileRequest,
    { readonly kind: "pages-aggregate-page" }
  >,
) {
  const deferred = request.deferred;
  const prepared = deferred.pagesAggregatePageRequest;
  const query = request.query;
  const cursor = query.cursor;
  const cursorValid =
    cursor === null ||
    (typeof cursor === "object" &&
      Object.keys(cursor).length === 5 &&
      Object.hasOwn(cursor, "views") &&
      Object.hasOwn(cursor, "sessions") &&
      Object.hasOwn(cursor, "pathname") &&
      Object.hasOwn(cursor, "query") &&
      Object.hasOwn(cursor, "hash") &&
      typeof cursor.views === "number" &&
      Number.isFinite(cursor.views) &&
      typeof cursor.sessions === "number" &&
      Number.isFinite(cursor.sessions) &&
      typeof cursor.pathname === "string" &&
      typeof cursor.query === "string" &&
      typeof cursor.hash === "string");
  if (
    !prepared ||
    deferred.operation !== "pages-aggregate-page" ||
    deferred.env !== query.env ||
    deferred.siteId !== query.siteId ||
    JSON.stringify(deferred.filters) !== JSON.stringify(query.filters) ||
    JSON.stringify(deferred.metadata.plan) !==
      JSON.stringify(query.scopePlan ?? deferred.metadata.plan) ||
    (deferred.requestScopePlan !== undefined &&
      JSON.stringify(deferred.requestScopePlan) !==
        JSON.stringify(query.scopePlan ?? deferred.requestScopePlan)) ||
    deferred.requestTime === undefined ||
    !sameEventFieldsQueryTime(deferred.requestTime, query.queryTime) ||
    !sameEventFieldsQueryTime(deferred.time, query.queryTime) ||
    prepared.limit !== query.limit ||
    prepared.includeDetails !== query.includeDetails ||
    prepared.cursorText !== query.cursorToken ||
    prepared.audience !== query.audience ||
    prepared.variant !== query.variant ||
    prepared.includeTabs !== query.includeTabs ||
    query.audience !== "private-dashboard" ||
    query.includeTabs === true ||
    query.variant === "tabs" ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    !cursorValid
  )
    throw invalidInput(
      "query",
      "pages_aggregate_page_request_context_mismatch",
    );
}

function validateChannelListRequest(
  request: Extract<
    EventQualificationCompileRequest,
    { readonly kind: "channel-list" }
  >,
) {
  const deferred = request.deferred;
  const prepared = deferred.channelListRequest;
  const query = request.query;
  const wholeFilterModeMatches =
    deferred.channelListFilterMode === undefined ||
    isCanonicalPrivateChannelListWholeFilterRequest({
      mode: query.mode,
      audience: query.audience,
    });
  if (
    !prepared ||
    deferred.operation !== "channel-list" ||
    deferred.env !== query.env ||
    deferred.siteId !== query.siteId ||
    JSON.stringify(deferred.filters) !== JSON.stringify(query.filters) ||
    JSON.stringify(deferred.metadata.plan) !==
      JSON.stringify(query.scopePlan ?? deferred.metadata.plan) ||
    (deferred.requestScopePlan !== undefined &&
      JSON.stringify(deferred.requestScopePlan) !==
        JSON.stringify(query.scopePlan ?? deferred.requestScopePlan)) ||
    deferred.requestTime === undefined ||
    !sameEventFieldsQueryTime(deferred.requestTime, query.queryTime) ||
    !sameEventFieldsQueryTime(deferred.time, query.queryTime) ||
    prepared.mode !== query.mode ||
    prepared.limit !== query.limit ||
    prepared.sourceLimit !== query.sourceLimit ||
    prepared.audience !== query.audience ||
    prepared.hasComparison !== query.hasComparison ||
    prepared.hasCurrent !== query.hasCurrent ||
    prepared.hasReference !== query.hasReference ||
    !wholeFilterModeMatches ||
    query.mode !== "list" ||
    query.hasComparison ||
    query.hasCurrent ||
    query.hasReference ||
    (query.sourceLimit === undefined
      ? query.limit !== 100
      : query.sourceLimit !== query.limit) ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1
  )
    throw invalidInput("query", "channel_list_request_context_mismatch");
}

function validateSessionBoundaryDimensionRequest(
  request: Extract<
    EventQualificationCompileRequest,
    { readonly kind: "session-boundary-dimension" }
  >,
) {
  const prepared = request.deferred.sessionBoundaryDimensionRequest;
  const query = request.query;
  if (
    !prepared ||
    request.deferred.siteId !== query.siteId ||
    JSON.stringify(request.deferred.filters) !==
      JSON.stringify(query.filters) ||
    JSON.stringify(request.deferred.metadata.plan) !==
      JSON.stringify(query.scopePlan ?? request.deferred.metadata.plan) ||
    (request.deferred.requestScopePlan !== undefined &&
      JSON.stringify(request.deferred.requestScopePlan) !==
        JSON.stringify(query.scopePlan ?? request.deferred.requestScopePlan)) ||
    request.deferred.requestTime === undefined ||
    !sameEventFieldsQueryTime(request.deferred.requestTime, query.queryTime) ||
    !sameEventFieldsQueryTime(request.deferred.time, query.queryTime) ||
    prepared.dimension !== query.dimension ||
    prepared.kind !== query.kind ||
    (query.kind === "entry" && query.dimension !== "session.entryPath") ||
    (query.kind === "exit" && query.dimension !== "session.exitPath") ||
    prepared.limit !== query.limit ||
    prepared.search !== query.search ||
    prepared.sortBy !== query.sortBy ||
    prepared.sortDirection !== query.sortDirection ||
    prepared.audience !== query.audience ||
    (request.deferred.sessionBoundaryFilterMode !== undefined &&
      (request.deferred.sessionBoundaryFilterMode !== "allow-whole-filter" ||
        request.deferred.operation !== "session-boundary-dimension" ||
        prepared.audience !== "private-dashboard" ||
        query.audience !== "private-dashboard" ||
        (prepared.kind === "entry"
          ? prepared.dimension !== "session.entryPath"
          : prepared.dimension !== "session.exitPath"))) ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1
  )
    throw invalidInput(
      "query",
      "session_boundary_dimension_request_context_mismatch",
    );
}

function validateSessionBoundaryOverviewPageRequest(
  request: Extract<
    EventQualificationCompileRequest,
    { readonly kind: "session-boundary-overview-page" }
  >,
) {
  const prepared = request.deferred.sessionBoundaryOverviewPageRequest;
  const query = request.query;
  if (
    !prepared ||
    request.deferred.operation !== "session-boundary-overview-page" ||
    request.deferred.siteId !== query.siteId ||
    JSON.stringify(request.deferred.filters) !==
      JSON.stringify(query.filters) ||
    JSON.stringify(request.deferred.metadata.plan) !==
      JSON.stringify(query.scopePlan ?? request.deferred.metadata.plan) ||
    (request.deferred.requestScopePlan !== undefined &&
      JSON.stringify(request.deferred.requestScopePlan) !==
        JSON.stringify(query.scopePlan ?? request.deferred.requestScopePlan)) ||
    request.deferred.requestTime === undefined ||
    !sameEventFieldsQueryTime(request.deferred.requestTime, query.queryTime) ||
    !sameEventFieldsQueryTime(request.deferred.time, query.queryTime) ||
    query.mode !== "overview-tab" ||
    (query.tab !== "page.entry" && query.tab !== "page.exit") ||
    prepared.mode !== query.mode ||
    prepared.tab !== query.tab ||
    prepared.kind !== query.kind ||
    prepared.dimension !== query.dimension ||
    prepared.limit !== query.limit ||
    prepared.cursorToken !== query.cursorToken ||
    prepared.search !== query.search ||
    prepared.sortBy !== query.sortBy ||
    prepared.sortDirection !== query.sortDirection ||
    prepared.audience !== query.audience ||
    (request.deferred.sessionBoundaryFilterMode !== undefined &&
      (request.deferred.sessionBoundaryFilterMode !== "allow-whole-filter" ||
        request.deferred.operation !== "session-boundary-overview-page" ||
        prepared.audience !== "private-dashboard" ||
        query.audience !== "private-dashboard" ||
        (prepared.tab === "page.entry"
          ? prepared.kind !== "entry" ||
            prepared.dimension !== "session.entryPath"
          : prepared.tab !== "page.exit" ||
            prepared.kind !== "exit" ||
            prepared.dimension !== "session.exitPath"))) ||
    (query.tab === "page.entry" &&
      (query.kind !== "entry" || query.dimension !== "session.entryPath")) ||
    (query.tab === "page.exit" &&
      (query.kind !== "exit" || query.dimension !== "session.exitPath")) ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1
  )
    throw invalidInput(
      "query",
      "session_boundary_overview_page_request_context_mismatch",
    );
}

function buildPayloadQualificationPlan(
  request: EventPayloadQualificationRequest,
): EventQualificationPlan {
  if (request.kind === "event-fields") {
    return buildEventFieldsQualificationPlan({
      siteId: request.query.siteId,
      queryTime: request.query.queryTime,
      filters: request.query.filters,
      scopePlan: request.query.scopePlan ?? request.deferred.metadata.plan,
      count: request.deferred.countInput,
      options: {
        ...(request.query.eventName !== undefined
          ? { eventName: request.query.eventName }
          : {}),
        limit: request.query.limit,
        cursor: request.query.cursor,
      },
    });
  }

  const valueTypeCode = eventPayloadValueTypeCode(request.query.fieldValueType);
  if (valueTypeCode === null)
    throw invalidInput(
      "fieldValueType",
      "event_field_values_request_context_mismatch",
    );
  return buildEventFieldValuesQualificationPlan({
    siteId: request.query.siteId,
    queryTime: request.query.queryTime,
    filters: request.query.filters,
    scopePlan: request.query.scopePlan ?? request.deferred.metadata.plan,
    count: request.deferred.countInput,
    ...(request.query.eventName !== undefined
      ? { eventName: request.query.eventName }
      : {}),
    options: {
      fieldPath: request.query.fieldPath,
      valueTypeCode,
      limit: request.query.limit,
      cursor: request.query.cursor,
      ...(request.query.search !== undefined
        ? { search: request.query.search }
        : {}),
    },
  });
}

function qualificationStatementTag(kind: QualifiedReportKind): string {
  const payloadFamily = payloadReportFamily(kind);
  if (payloadFamily) return payloadFamily.statementTag;
  if (kind === "page-dimension") return PAGE_DIMENSION_REPORT_STATEMENT_TAG;
  if (kind === "referrers") return "analytics.referrers_qualification";
  if (kind === "pages-aggregate-page")
    return "analytics.pages_aggregate_qualification";
  if (kind === "pages-tabs") return "analytics.pages_tabs_qualification";
  if (kind === "session-boundary-dimension")
    return "analytics.session_boundary_dimension_qualification";
  if (kind === "session-boundary-overview-page")
    return "analytics.session_boundary_overview_page_qualification";
  if (kind === "channel-list") return "analytics.channel_list_qualification";
  if (kind === "event-summary") return "analytics.event_summary_qualification";
  if (kind === "event-types") return "analytics.event_types_qualification";
  if (kind === "event-trend") return "analytics.event_trend_qualification";
  if (kind === "event-context") return "analytics.event_context_qualification";
  return "analytics.event_type_detail_qualification";
}

function compileProgram(request: EventQualificationCompileRequest):
  | {
      readonly kind: "compiled";
      readonly program: EventQualificationProgram;
    }
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    } {
  const { deferred } = request;
  const eventNameDimensionList =
    request.kind === "event-types" &&
    request.query.kind === "list" &&
    deferred.operation === "event-name-dimension";
  const channelOverviewPage =
    request.kind === "page-dimension" &&
    request.query.family === "overview-tab" &&
    request.query.tab === "source.channel" &&
    deferred.operation === "channel-overview";
  if (
    !isDeferredEventQualification(deferred) ||
    (deferred.operation !== request.kind &&
      !eventNameDimensionList &&
      !channelOverviewPage)
  )
    throw new Error("analytics_event_qualification_request_mismatch");
  if (
    eventNameDimensionList &&
    (request.query.limit !== deferred.eventNameDimensionRequest.limit ||
      request.query.search !== deferred.eventNameDimensionRequest.search ||
      deferred.eventNameDimensionRequest.mode !== "breakdown" ||
      deferred.eventNameDimensionRequest.dimension !== "event.name")
  )
    throw new Error("event_name_dimension_qualification_request_mismatch");
  if (request.kind === "event-fields" || request.kind === "event-field-values")
    validatePayloadRequest(request);
  if (request.kind === "page-dimension") validatePageDimensionRequest(request);
  if (request.kind === "referrers") validateReferrersRequest(request);
  if (request.kind === "pages-aggregate-page")
    validatePagesAggregatePageRequest(request);
  if (request.kind === "pages-tabs") validatePagesTabsRequest(request);
  if (request.kind === "channel-list") validateChannelListRequest(request);
  if (request.kind === "session-boundary-dimension")
    validateSessionBoundaryDimensionRequest(request);
  if (request.kind === "session-boundary-overview-page")
    validateSessionBoundaryOverviewPageRequest(request);
  assertQualificationNotAborted(deferred.signal);
  const qualification: AnalyticsQualificationPlan<
    "session" | "visitor" | "event"
  > =
    request.kind === "event-summary"
      ? buildEventSummaryCardsQualificationPlan({
          siteId: deferred.siteId,
          count: request.deferred.countInput,
        })
      : request.kind === "event-types"
        ? buildEventTypeSummaryQualificationPlan({
            siteId: deferred.siteId,
            count: request.deferred.countInput,
            query: request.query,
            ...(deferred.operation === "event-name-dimension" &&
            deferred.eventNameDimensionReportFilters !== undefined
              ? {
                  reportFilters: deferred.eventNameDimensionReportFilters,
                }
              : {}),
          })
        : request.kind === "event-trend"
          ? buildEventTrendQualificationPlan({
              siteId: deferred.siteId,
              queryTime: deferred.time,
              filters: deferred.filters,
              scopePlan: deferred.metadata.plan,
              count: request.deferred.countInput,
              ...request.query,
            })
          : request.kind === "event-context"
            ? buildEventContextQualificationPlan({
                siteId: deferred.siteId,
                count: request.deferred.countInput,
                ...request.query,
              })
            : request.kind === "event-type-detail"
              ? buildEventTypeDetailQualificationPlan({
                  siteId: deferred.siteId,
                  count: request.deferred.countInput,
                  ...request.query,
                  contextLimit:
                    request.query.contextLimit ??
                    EVENT_TYPE_DETAIL_CONTEXT_LIMIT,
                })
              : request.kind === "pages-aggregate-page"
                ? buildPagesAggregateQualificationPlan({
                    siteId: request.query.siteId,
                    queryTime: request.query.queryTime,
                    filters: request.query.filters,
                    scopePlan:
                      request.query.scopePlan ?? deferred.metadata.plan,
                    count: request.deferred.countInput,
                    limit: request.query.limit,
                    includeDetails: request.query.includeDetails,
                    cursor: request.query.cursor,
                  })
                : request.kind === "pages-tabs"
                  ? buildPagesTabsQualificationPlan({
                      configuration: request.query.configuration,
                      siteId: request.query.siteId,
                      queryTime: request.query.queryTime,
                      filters: request.query.filters,
                      scopePlan:
                        request.query.scopePlan ?? deferred.metadata.plan,
                      count: request.deferred.countInput,
                      limit: request.query.limit,
                      includeDetails: request.query.includeDetails,
                      cursor: request.query.cursor,
                    })
                  : request.kind === "referrers"
                    ? buildReferrersQualificationPlan({
                        siteId: request.query.siteId,
                        queryTime: request.query.queryTime,
                        filters: request.query.filters,
                        scopePlan:
                          request.query.scopePlan ?? deferred.metadata.plan,
                        count: request.deferred.countInput,
                        configuration: request.query.configuration,
                      })
                    : request.kind === "page-dimension"
                      ? request.query.family === "referrer-overview"
                        ? buildReferrerPageQualificationPlan({
                            ...(request.query.audience === "private-dashboard"
                              ? { filterMode: "allow-whole-filter" as const }
                              : {}),
                            siteId: request.query.siteId,
                            queryTime: request.query.queryTime,
                            filters: request.query.filters,
                            scopePlan:
                              request.query.scopePlan ?? deferred.metadata.plan,
                            count: request.deferred.countInput,
                            options: {
                              limit: request.query.limit,
                              includeFullUrl: request.query.includeFullUrl,
                              ...(request.query.search !== undefined
                                ? { search: request.query.search }
                                : {}),
                              sortBy: request.query.sortBy,
                              sortDirection: request.query.sortDirection,
                              cursor: request.query.cursor,
                            },
                          })
                        : buildPageDimensionQualificationPlan({
                            ...(deferred.operation === "channel-overview"
                              ? { semanticOperation: "channels" as const }
                              : {}),
                            ...(deferred.pageDimensionFilterMode ===
                            "allow-whole-filter"
                              ? { filterMode: "allow-whole-filter" as const }
                              : {}),
                            siteId: request.query.siteId,
                            queryTime: request.query.queryTime,
                            filters: request.query.filters,
                            scopePlan:
                              request.query.scopePlan ?? deferred.metadata.plan,
                            count: request.deferred.countInput,
                            options: {
                              selection: request.query.selection,
                              limit: request.query.limit,
                              cursor: request.query.cursor,
                              ...(request.query.search !== undefined
                                ? { search: request.query.search }
                                : {}),
                              sortBy: request.query.sortBy,
                              sortDirection: request.query.sortDirection,
                              excludeEmpty: request.query.excludeEmpty,
                            },
                          })
                      : request.kind === "session-boundary-dimension"
                        ? buildSessionBoundaryDimensionQualificationPlan({
                            ...(deferred.sessionBoundaryFilterMode ===
                            "allow-whole-filter"
                              ? {
                                  filterMode:
                                    deferred.sessionBoundaryFilterMode,
                                }
                              : {}),
                            siteId: request.query.siteId,
                            queryTime: request.query.queryTime,
                            filters: request.query.filters,
                            scopePlan:
                              request.query.scopePlan ?? deferred.metadata.plan,
                            count: request.deferred.countInput,
                            kind: request.query.kind,
                            limit: request.query.limit,
                            ...(request.query.search !== undefined
                              ? { search: request.query.search }
                              : {}),
                            sortBy: request.query.sortBy,
                            sortDirection: request.query.sortDirection,
                          })
                        : request.kind === "session-boundary-overview-page"
                          ? buildSessionBoundaryOverviewPageQualificationPlan({
                              ...(deferred.sessionBoundaryFilterMode ===
                              "allow-whole-filter"
                                ? {
                                    filterMode:
                                      deferred.sessionBoundaryFilterMode,
                                  }
                                : {}),
                              siteId: request.query.siteId,
                              queryTime: request.query.queryTime,
                              filters: request.query.filters,
                              scopePlan:
                                request.query.scopePlan ??
                                deferred.metadata.plan,
                              count: request.deferred.countInput,
                              kind: request.query.kind,
                              limit: request.query.limit,
                              ...(request.query.search !== undefined
                                ? { search: request.query.search }
                                : {}),
                              sortBy: request.query.sortBy,
                              sortDirection: request.query.sortDirection,
                              cursor: request.query.cursor,
                            })
                          : request.kind === "channel-list"
                            ? buildChannelListQualificationPlan({
                                ...(deferred.channelListFilterMode ===
                                "allow-whole-filter"
                                  ? {
                                      filterMode: "allow-whole-filter" as const,
                                    }
                                  : {}),
                                siteId: request.query.siteId,
                                queryTime: request.query.queryTime,
                                filters: request.query.filters,
                                scopePlan:
                                  request.query.scopePlan ??
                                  deferred.metadata.plan,
                                count: request.deferred.countInput,
                                limit: request.query.limit,
                              })
                            : buildPayloadQualificationPlan(request);
  if (request.kind === "event-type-detail") {
    const prepared = deferred.eventTypeDetailRequest;
    if (
      !prepared ||
      prepared.eventName !== request.query.eventName ||
      prepared.interval !== request.query.interval ||
      prepared.includeBreakdowns !== request.query.includeBreakdowns ||
      prepared.includeContext !== request.query.includeContext
    )
      throw new Error("event_type_detail_qualification_request_mismatch");
  }
  const plan = qualification.plan;
  const payloadFamily = payloadReportFamily(request.kind);
  const expectedReportOutputIds =
    request.kind === "event-summary"
      ? REPORT_OUTPUT_TYPES.map(([outputId]) => outputId)
      : request.kind === "event-types"
        ? [
            request.query.kind === "list"
              ? EVENT_TYPE_SUMMARY_OUTPUTS.list
              : EVENT_TYPE_SUMMARY_OUTPUTS.page,
          ]
        : request.kind === "event-trend"
          ? [
              EVENT_TREND_OUTPUTS.series,
              EVENT_TREND_OUTPUTS.points,
              EVENT_TREND_OUTPUTS.other,
            ]
          : request.kind === "event-context"
            ? [EVENT_CONTEXT_REPORT_OUTPUT]
            : request.kind === "event-type-detail"
              ? [
                  EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
                  ...(request.query.includeBreakdowns
                    ? [
                        EVENT_TYPE_OVERVIEW_OUTPUTS.page,
                        EVENT_TYPE_OVERVIEW_OUTPUTS.country,
                        EVENT_TYPE_OVERVIEW_OUTPUTS.device,
                        EVENT_TYPE_OVERVIEW_OUTPUTS.browser,
                      ]
                    : []),
                  EVENT_TREND_OUTPUTS.typePoints,
                  ...(request.query.includeContext &&
                  (request.query.selectedKeys?.length ?? 19) > 0
                    ? [EVENT_CONTEXT_REPORT_OUTPUT]
                    : []),
                ]
              : payloadFamily
                ? [payloadFamily.outputId]
                : request.kind === "pages-aggregate-page"
                  ? [PAGES_AGGREGATE_REPORT_OUTPUT]
                  : request.kind === "pages-tabs"
                    ? request.query.configuration === "tabs-only"
                      ? PAGE_TAB_OUTPUT_IDS
                      : PAGES_WITH_TABS_OUTPUT_IDS
                    : request.kind === "referrers"
                      ? request.query.configuration.kind === "summary"
                        ? ["referrer-summary", "referrer-top-sources"]
                        : [REFERRERS_PAGE_REPORT_OUTPUT]
                      : request.kind === "page-dimension"
                        ? request.query.family === "referrer-overview"
                          ? [REFERRERS_PAGE_REPORT_OUTPUT]
                          : [DIMENSION_PAGE_REPORT_OUTPUT]
                        : request.kind === "session-boundary-dimension"
                          ? [SESSION_PATH_TOP_REPORT_OUTPUT]
                          : request.kind === "session-boundary-overview-page"
                            ? [SESSION_PATH_PAGE_REPORT_OUTPUT]
                            : request.kind === "channel-list"
                              ? [OVERVIEW_CHANNELS_REPORT_OUTPUT]
                              : [];
  const eventCandidatePage =
    request.kind === "event-types" &&
    request.query.kind === "page" &&
    deferred.operation === "event-types" &&
    deferred.metadata.plan.scope === "event" &&
    deferred.countInput.scope === "event" &&
    deferred.countInput.candidateAnchor.kind === "event-candidate";
  const eventCandidateList =
    eventNameDimensionList &&
    deferred.metadata.plan.scope === "event" &&
    deferred.countInput.scope === "event" &&
    deferred.countInput.candidateAnchor.kind === "event-candidate";
  const eventCandidateEventTypeQuery = eventCandidatePage || eventCandidateList;
  const qualificationScopeValid =
    ((qualification.scope === "session" || qualification.scope === "visitor") &&
      qualification.candidateGrain === undefined) ||
    (eventCandidateEventTypeQuery &&
      qualification.scope === "event" &&
      qualification.candidateGrain === "event-candidate");
  if (
    qualification.scope !== deferred.countInput.scope ||
    !qualificationScopeValid ||
    qualification.reportOutputIds.length !== expectedReportOutputIds.length ||
    new Set(qualification.reportOutputIds).size !==
      expectedReportOutputIds.length ||
    (request.kind === "channel-list" &&
      qualification.controlOutputId !==
        CHANNEL_LIST_QUALIFICATION_CONTROL_OUTPUT) ||
    (request.kind === "pages-aggregate-page" &&
      qualification.controlOutputId !==
        PAGES_AGGREGATE_QUALIFICATION_CONTROL_OUTPUT) ||
    (request.kind === "pages-tabs" &&
      qualification.controlOutputId !==
        PAGES_TABS_QUALIFICATION_CONTROL_OUTPUT) ||
    (request.kind === "referrers" &&
      qualification.controlOutputId !==
        REFERRERS_QUALIFICATION_CONTROL_OUTPUT) ||
    qualification.reportOutputIds.some(
      (outputId, index) => outputId !== expectedReportOutputIds[index],
    )
  )
    throw new Error(
      "analytics_event_summary_qualification_plan_identity_invalid",
    );
  const controlsOutput = exactOutput(
    plan.outputs,
    qualification.controlOutputId,
  );
  const controlNames = controlsOutput.fields.map((field) => field.name);
  const compatibilityFields = qualificationCompatibilityFieldsFromNumeric(
    qualification.numericCompatibilityFields,
  );
  const expectedControlNames = [
    "rawCount",
    "nullActivityIdCount",
    "siteIdentityMismatchCount",
    "entityKind",
    "invalidIdentityCount",
    "duplicateIdentityCount",
    ...compatibilityFields.map(({ outputName }) => outputName),
  ];
  if (
    new Set(controlNames).size !== controlNames.length ||
    expectedControlNames.some((name) => !controlNames.includes(name))
  )
    throw new Error("analytics_event_summary_qualification_controls_invalid");
  const reportOutputs = qualification.reportOutputIds.map((outputId) =>
    exactOutput(plan.outputs, outputId),
  );
  const outputs = [...reportOutputs, controlsOutput];
  const policy: AnalyticsQualificationAdmissionPolicy = {
    primaryReportSourceRelationId: qualification.primaryReportSourceRelationId,
    reportSourceRelations: qualification.reportSourceRelations,
    reportRelationIds: reportOutputs.map((output) => output.relation),
    controlsRelationId: controlsOutput.relation,
    controlSlots: controlsOutput.fields.map(({ name, slot }) => ({
      name,
      slot,
    })),
    scope: qualification.scope,
    ...(qualification.candidateGrain
      ? { candidateGrain: qualification.candidateGrain }
      : {}),
    maximumActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
    numericCompatibilityControlNames: compatibilityFields.map(
      ({ outputName }) => outputName,
    ),
  };
  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan,
    { siteId: deferred.siteId, time: plan.context.time },
    { analyticsQualificationAdmissionPolicy: policy },
  );
  const lowered = lowerer.lowerMany(outputs);
  const reportRelations = reportOutputs.map((output, index) =>
    requireScalarReportRelation(
      output,
      lowered[index]!,
      lowerer,
      reportFieldsForOutput(
        request.kind,
        output.id,
        request.kind === "pages-tabs" || request.kind === "referrers"
          ? request.query.configuration
          : undefined,
      ),
    ),
  );
  const controlRelation = lowerer.projectOutput(
    lowered[reportOutputs.length]!,
    controlsOutput.fields.map(({ name, slot }) => ({ name, slot })),
  );
  const envelopeReportFields = envelopeReportFieldsForKind(
    request.kind,
    request.kind === "page-dimension" ||
      request.kind === "referrers" ||
      request.kind === "pages-aggregate-page" ||
      request.kind === "pages-tabs"
      ? request.query
      : undefined,
  );
  const branches = reportRelations.map((relation, index) =>
    taggedReportRows(
      relation,
      reportOutputs[index]!.id,
      controlNames,
      envelopeReportFields,
    ),
  );
  branches.push(
    taggedControlRows(
      controlRelation,
      qualification.controlOutputId,
      controlNames,
      envelopeReportFields,
    ),
  );
  let envelope = branches[0]!;
  for (const branch of branches.slice(1))
    envelope = union(envelope, branch, true);
  const reportOrder =
    payloadFamily?.order ??
    (request.kind === "pages-tabs"
      ? request.query.configuration === "tabs-only"
        ? ([
            { field: "cardType", direction: "asc", nulls: "first" },
            { field: "views", direction: "desc", nulls: "last" },
            { field: "sessions", direction: "desc", nulls: "last" },
            { field: "value", direction: "asc", nulls: "first" },
          ] as const)
        : ([
            { field: "rowType", direction: "asc", nulls: "first" },
            { field: "cardType", direction: "asc", nulls: "first" },
            { field: "views", direction: "desc", nulls: "last" },
            { field: "sessions", direction: "desc", nulls: "last" },
            { field: "pathname", direction: "asc", nulls: "first" },
            { field: "queryValue", direction: "asc", nulls: "first" },
            { field: "hashValue", direction: "asc", nulls: "first" },
            { field: "value", direction: "asc", nulls: "first" },
          ] as const)
      : request.kind === "pages-aggregate-page"
        ? ([
            { field: "outputId", direction: "asc", nulls: "last" },
            { field: "views", direction: "desc", nulls: "last" },
            { field: "sessions", direction: "desc", nulls: "last" },
            { field: "pathname", direction: "asc", nulls: "first" },
            { field: "queryValue", direction: "asc", nulls: "first" },
            { field: "hashValue", direction: "asc", nulls: "first" },
          ] as const)
        : request.kind === "referrers"
          ? request.query.configuration.kind === "summary"
            ? ([
                { field: "outputId", direction: "asc", nulls: "last" },
                { field: "rowType", direction: "asc", nulls: "first" },
                { field: "views", direction: "desc", nulls: "last" },
                { field: "referrer", direction: "asc", nulls: "first" },
              ] as const)
            : ([
                { field: "outputId", direction: "asc", nulls: "last" },
                {
                  field:
                    request.query.configuration.sortBy === "visitors"
                      ? "visitors"
                      : "views",
                  direction: request.query.configuration.sortDirection,
                  nulls: "last",
                },
                {
                  field:
                    request.query.configuration.sortBy === "visitors"
                      ? "views"
                      : "sessions",
                  direction: request.query.configuration.sortDirection,
                  nulls: "last",
                },
                { field: "referrer", direction: "asc", nulls: "first" },
              ] as const)
          : request.kind === "page-dimension"
            ? pageDimensionReportOrder(request.query)
            : request.kind === "session-boundary-dimension"
              ? sessionBoundaryDimensionReportOrder(request.query)
              : request.kind === "session-boundary-overview-page"
                ? sessionBoundaryDimensionReportOrder(request.query)
                : request.kind === "channel-list"
                  ? channelListReportOrder()
                  : request.kind === "event-summary"
                    ? REPORT_ORDER
                    : request.kind === "event-types"
                      ? EVENT_TYPE_REPORT_ORDER
                      : request.kind === "event-trend"
                        ? EVENT_TREND_REPORT_ORDER
                        : request.kind === "event-type-detail"
                          ? ([
                              {
                                field: "outputId",
                                direction: "asc",
                                nulls: "last",
                              },
                              {
                                field: "cardType",
                                direction: "asc",
                                nulls: "first",
                              },
                              {
                                field: "events",
                                direction: "desc",
                                nulls: "last",
                              },
                              {
                                field: "views",
                                direction: "desc",
                                nulls: "last",
                              },
                              {
                                field: "sessions",
                                direction: "desc",
                                nulls: "last",
                              },
                              {
                                field: "visitors",
                                direction: "desc",
                                nulls: "last",
                              },
                              {
                                field: "value",
                                direction: "asc",
                                nulls: "first",
                              },
                              {
                                field: "bucket",
                                direction: "asc",
                                nulls: "last",
                              },
                            ] as const)
                          : REPORT_ORDER);
  const orderKeys = reportOrder.flatMap((key) => {
    const expression = envelope.columns[key.field] as AnyExpression | undefined;
    if (!expression)
      throw new Error(
        `analytics_event_summary_qualification_order:${key.field}`,
      );
    const nativeNulls = key.direction === "asc" ? "first" : "last";
    return [
      ...(key.nulls === nativeNulls
        ? []
        : [
            {
              expression: caseWhen(
                [
                  {
                    when: isNull(expression),
                    then: constant(key.nulls === "first" ? 0 : 1),
                  },
                ],
                constant(key.nulls === "first" ? 1 : 0),
              ),
              direction: "ASC" as const,
            },
          ]),
      {
        expression,
        direction:
          key.direction === "asc" ? ("ASC" as const) : ("DESC" as const),
      },
    ];
  });
  const sorted = sort(envelope, orderKeys);
  const physical = lowerLogicalPlan(sorted);
  const groupedSummaryIds = [
    qualification.groupedSummaryRelationId,
    ...(qualification.additionalGroupedSummaryRelationIds ?? []),
  ];
  const groupedSummaryEvidence = proveGroupedSummaryRelations({
    relationIds: groupedSummaryIds,
    planNodes: plan.nodes,
    physicalSharedRelations: physical.sharedRelations,
    lowerRelation: (relationId) => lowerer.loweredRelationForPlan(relationId),
  });
  const groupedSummaries = groupedSummaryEvidence.entries;
  const expectedGroupedSummaryCount =
    qualification.candidateGrain === "event-candidate" ? 2 : 1;
  const failedGroupedSummary = groupedSummaries.find(
    ({ validShape, materialized }) => !validShape || !materialized,
  );
  if (
    !groupedSummaryEvidence.valid ||
    failedGroupedSummary ||
    groupedSummaryIds.length !== expectedGroupedSummaryCount
  ) {
    return {
      kind: "unavailable",
      fallbackReason: {
        kind: "grouped-summary-unavailable",
        groupWidth: failedGroupedSummary?.lowered?.fields.length ?? null,
      },
    };
  }
  const groupedSummary = groupedSummaries[0]!.lowered!;
  const qualifiedReportInput =
    request.kind === "event-context" || request.kind === "event-type-detail"
      ? physical.sharedRelations.find(
          ({ node }) =>
            node.kind === "project" &&
            node.input.node.kind === "semi-join" &&
            node.fields.length > 16,
        )
      : undefined;
  assertQualificationNotAborted(deferred.signal);
  const statementTag =
    request.kind === "page-dimension" &&
    request.query.family === "referrer-overview"
      ? "analytics.referrer_overview_qualification"
      : qualificationStatementTag(request.kind);
  const compilation = compileQualificationQuery(
    () =>
      compileD1Query(physical, {
        tag: currentD1Operation() ?? statementTag,
      }) as CompiledQuery<Record<string, unknown>>,
    deferred.signal,
  );
  if (compilation.kind === "unavailable") return compilation;
  const { query } = compilation;
  const evidence: EventSummaryQualificationCompilationEvidence = Object.freeze({
    statementTag: query.tag ?? currentD1Operation() ?? statementTag,
    sql: query.sql,
    bindings: Object.freeze([...(query.bindings ?? [])]),
    sqlBytes: new TextEncoder().encode(query.sql).byteLength,
    bindingCount: query.bindings?.length ?? 0,
    groupWidth: groupedSummary.fields.length,
    groupedSummaryMaterialization: "materialized",
    ...(groupedSummaries.length > 1
      ? {
          groupedSummaryMaterializations: Object.freeze(
            groupedSummaries.map(({ relationId, lowered }) => ({
              relationId: String(relationId),
              groupWidth: lowered!.fields.length,
              materialization: "materialized" as const,
            })),
          ),
        }
      : {}),
    ...(qualifiedReportInput?.materialization === "materialized"
      ? {
          qualifiedReportInputWidth: qualifiedReportInput.fields.length,
          qualifiedReportInputMaterialization: "materialized" as const,
        }
      : {}),
    sharedRelationCount: physical.sharedRelations.length,
    rootKind: physical.root.kind,
    physicalScanKinds: Object.freeze(scanKinds(physical.root)),
    ...(query.physicalPlanShape
      ? { physicalPlanShape: query.physicalPlanShape }
      : {}),
  });
  const program: EventQualificationProgram = Object.freeze({
    query,
    evidence,
    deferred,
    reportKind: request.kind,
    reportOutputIds: Object.freeze([...qualification.reportOutputIds]),
    ...(request.kind === "event-context"
      ? { reportCardTypes: Object.freeze([...request.query.selectedKeys]) }
      : request.kind === "event-type-detail"
        ? {
            reportCardTypes: Object.freeze([
              ...(request.query.includeContext
                ? (request.query.selectedKeys ?? EVENT_CONTEXT_CARD_KEYS)
                : []),
            ]),
          }
        : {}),
    controlOutputId: qualification.controlOutputId,
    compatibilityFields: Object.freeze(compatibilityFields),
    reportEnvelopeFields: envelopeReportFields,
    ...(request.kind === "pages-tabs" || request.kind === "referrers"
      ? { reportConfiguration: request.query.configuration }
      : {}),
  });
  compiledPrograms.add(program);
  return { kind: "compiled", program };
}

function sameEventFieldsQueryTime(left: QueryTime, right: QueryTime): boolean {
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

function validatePagesTabsRequest(
  request: Extract<
    EventQualificationCompileRequest,
    { readonly kind: "pages-tabs" }
  >,
) {
  const deferred = request.deferred;
  const prepared = deferred.pagesTabsRequest;
  const query = request.query;
  const cursor = query.cursor;
  const cursorValid =
    cursor === null ||
    (typeof cursor === "object" &&
      Object.keys(cursor).length === 5 &&
      Object.hasOwn(cursor, "views") &&
      Object.hasOwn(cursor, "sessions") &&
      Object.hasOwn(cursor, "pathname") &&
      Object.hasOwn(cursor, "query") &&
      Object.hasOwn(cursor, "hash") &&
      typeof cursor.views === "number" &&
      Number.isFinite(cursor.views) &&
      typeof cursor.sessions === "number" &&
      Number.isFinite(cursor.sessions) &&
      typeof cursor.pathname === "string" &&
      typeof cursor.query === "string" &&
      typeof cursor.hash === "string");
  const expectedOutputs =
    query.configuration === "tabs-only"
      ? PAGE_TAB_OUTPUT_IDS
      : PAGES_WITH_TABS_OUTPUT_IDS;
  if (
    !prepared ||
    deferred.operation !== "pages-tabs" ||
    deferred.env !== query.env ||
    deferred.siteId !== query.siteId ||
    JSON.stringify(deferred.filters) !== JSON.stringify(query.filters) ||
    JSON.stringify(query.scopePlan ?? deferred.metadata.plan) !==
      JSON.stringify(deferred.metadata.plan) ||
    JSON.stringify(query.scopePlan ?? deferred.metadata.plan) !==
      JSON.stringify(deferred.requestScopePlan ?? deferred.metadata.plan) ||
    deferred.requestTime === undefined ||
    !sameEventFieldsQueryTime(deferred.requestTime, query.queryTime) ||
    !sameEventFieldsQueryTime(deferred.time, query.queryTime) ||
    prepared.configuration !== query.configuration ||
    prepared.limit !== query.limit ||
    prepared.includeDetails !== query.includeDetails ||
    prepared.cursorText !== query.cursorToken ||
    prepared.audience !== query.audience ||
    prepared.variant !== query.variant ||
    prepared.includeTabs !== query.includeTabs ||
    query.audience !== "private-dashboard" ||
    (query.configuration === "tabs-only"
      ? query.variant !== "tabs" ||
        query.includeDetails ||
        query.cursor !== null ||
        query.cursorToken !== null
      : query.variant === "tabs" || query.includeTabs !== true) ||
    !Number.isSafeInteger(query.limit) ||
    query.limit < 1 ||
    !cursorValid ||
    (query.cursorToken === null && query.cursor !== null) ||
    expectedOutputs.length === 0
  )
    throw invalidInput("query", "pages_tabs_request_context_mismatch");
}

export function compileEventSummaryQualificationProgram(
  deferred: DeferredEventSummaryQualification,
): EventSummaryQualificationCompilation {
  const result = compileProgram({ kind: "event-summary", deferred });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileEventTypesQualificationProgram(input: {
  readonly deferred: DeferredEventTypesQualification;
  readonly query: EventTypePageQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "event-types",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileEventNameDimensionQualificationProgram(
  deferred: DeferredEventNameDimensionQualification,
): EventSummaryQualificationCompilation {
  const request = deferred.eventNameDimensionRequest;
  const result = compileProgram({
    kind: "event-types",
    deferred,
    query: {
      kind: "list",
      limit: request.limit,
      ...(request.search !== undefined ? { search: request.search } : {}),
    },
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileEventTrendQualificationProgram(input: {
  readonly deferred: DeferredEventTrendQualification;
  readonly query: EventTrendQualificationQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "event-trend",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileEventContextQualificationProgram(input: {
  readonly deferred: DeferredEventContextQualification;
  readonly query: EventContextQualificationQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "event-context",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileEventTypeDetailQualificationProgram(input: {
  readonly deferred: DeferredEventTypeDetailQualification;
  readonly query: EventTypeDetailQualificationQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "event-type-detail",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileEventFieldsQualificationProgram(input: {
  readonly deferred: DeferredEventFieldsQualification;
  readonly query: EventFieldsQualificationQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "event-fields",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileEventFieldValuesQualificationProgram(input: {
  readonly deferred: DeferredEventFieldValuesQualification;
  readonly query: EventFieldValuesQualificationQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "event-field-values",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compilePageDimensionQualificationProgram(input: {
  readonly deferred: DeferredPageQualification;
  readonly query: PageDimensionQualificationReportQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "page-dimension",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileReferrersQualificationProgram(input: {
  readonly deferred: DeferredReferrersQualification;
  readonly query: ReferrersQualificationReportQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "referrers",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compilePagesAggregateQualificationProgram(input: {
  readonly deferred: DeferredPagesAggregatePageQualification;
  readonly query: PagesAggregateQualificationReportQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "pages-aggregate-page",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compilePagesTabsQualificationProgram(input: {
  readonly deferred: DeferredPagesTabsQualification;
  readonly query: PagesTabsQualificationReportQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "pages-tabs",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileChannelListQualificationProgram(input: {
  readonly deferred: DeferredChannelListQualification;
  readonly query: ChannelListQualificationReportQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "channel-list",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileSessionBoundaryDimensionQualificationProgram(input: {
  readonly deferred: DeferredSessionBoundaryDimensionQualification;
  readonly query: SessionBoundaryDimensionQualificationReportQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "session-boundary-dimension",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

export function compileSessionBoundaryOverviewPageQualificationProgram(input: {
  readonly deferred: DeferredSessionBoundaryOverviewPageQualification;
  readonly query: SessionBoundaryOverviewPageQualificationReportQuery;
}): EventSummaryQualificationCompilation {
  const result = compileProgram({
    kind: "session-boundary-overview-page",
    deferred: input.deferred,
    query: input.query,
  });
  return result.kind === "compiled"
    ? { kind: "compiled", evidence: result.program.evidence }
    : result;
}

function exactRowKeys(
  row: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(row).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableFiniteNumber(value: unknown): value is number | null {
  return value === null || finiteNumber(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validReportShape(
  kind: QualifiedReportKind,
  outputId: string,
  row: Record<string, unknown>,
  configuration?:
    PagesTabsQualificationConfiguration | ReferrersQualificationConfiguration,
): boolean {
  const payloadFamily = payloadReportFamily(kind);
  if (payloadFamily && outputId !== payloadFamily.outputId) return false;
  if (kind === "channel-list")
    return (
      outputId === OVERVIEW_CHANNELS_REPORT_OUTPUT &&
      typeof row.channel === "string" &&
      finiteNumber(row.views) &&
      finiteNumber(row.sessions) &&
      finiteNumber(row.visitors)
    );
  if (kind === "pages-tabs") {
    const cardType =
      PAGE_TAB_CARDS.find((card) => card.outputId === outputId)?.cardType ??
      (outputId === "page-tabs-entry"
        ? "entry"
        : outputId === "page-tabs-exit"
          ? "exit"
          : null);
    if (typeof configuration === "string" && configuration === "tabs-only")
      return (
        cardType !== null &&
        row.cardType === cardType &&
        typeof row.value === "string" &&
        finiteNumber(row.views) &&
        finiteNumber(row.sessions) &&
        finiteNumber(row.visitors)
      );
    if (
      typeof configuration !== "string" ||
      configuration !== "pages-with-tabs"
    )
      return false;
    if (outputId === PAGES_WITH_TABS_PAGE_OUTPUT_ID)
      return (
        row.rowType === "page" &&
        row.cardType === "" &&
        typeof row.pathname === "string" &&
        typeof row.queryValue === "string" &&
        typeof row.hashValue === "string" &&
        row.value === "" &&
        finiteNumber(row.views) &&
        finiteNumber(row.sessions) &&
        row.visitors === 0
      );
    return (
      cardType !== null &&
      row.rowType === "tab" &&
      row.cardType === cardType &&
      row.pathname === "" &&
      row.queryValue === "" &&
      row.hashValue === "" &&
      typeof row.value === "string" &&
      finiteNumber(row.views) &&
      finiteNumber(row.sessions) &&
      finiteNumber(row.visitors)
    );
  }
  if (kind === "pages-aggregate-page")
    return (
      outputId === PAGES_AGGREGATE_REPORT_OUTPUT &&
      typeof row.pathname === "string" &&
      typeof row.queryValue === "string" &&
      typeof row.hashValue === "string" &&
      finiteNumber(row.views) &&
      finiteNumber(row.sessions)
    );
  if (kind === "referrers") {
    const referrersConfiguration =
      typeof configuration === "object" && configuration !== null
        ? configuration
        : undefined;
    if (referrersConfiguration?.kind === "summary") {
      if (outputId === "referrer-summary")
        return (
          row.rowType === "summary" &&
          typeof row.referrer === "string" &&
          finiteNumber(row.totalViews) &&
          nullableFiniteNumber(row.directViews) &&
          nullableFiniteNumber(row.externalViews) &&
          finiteNumber(row.uniqueDomains) &&
          finiteNumber(row.uniqueLinks) &&
          finiteNumber(row.views)
        );
      if (outputId === "referrer-top-sources")
        return (
          row.rowType === "top" &&
          typeof row.referrer === "string" &&
          row.totalViews === null &&
          row.directViews === null &&
          row.externalViews === null &&
          row.uniqueDomains === null &&
          row.uniqueLinks === null &&
          finiteNumber(row.views)
        );
      return false;
    }
    return (
      referrersConfiguration?.kind === "page" &&
      outputId === REFERRERS_PAGE_REPORT_OUTPUT &&
      typeof row.referrer === "string" &&
      finiteNumber(row.views) &&
      finiteNumber(row.sessions) &&
      finiteNumber(row.visitors)
    );
  }
  if (kind === "page-dimension" && outputId === REFERRERS_PAGE_REPORT_OUTPUT)
    return (
      typeof row.referrer === "string" &&
      finiteNumber(row.views) &&
      finiteNumber(row.sessions) &&
      finiteNumber(row.visitors)
    );
  if (kind === "page-dimension")
    return (
      outputId === DIMENSION_PAGE_REPORT_OUTPUT &&
      typeof row.value === "string" &&
      finiteNumber(row.views) &&
      finiteNumber(row.sessions) &&
      finiteNumber(row.visitors)
    );
  if (kind === "session-boundary-dimension")
    return (
      outputId === SESSION_PATH_TOP_REPORT_OUTPUT &&
      typeof row.value === "string" &&
      finiteNumber(row.views) &&
      finiteNumber(row.sessions) &&
      finiteNumber(row.visitors)
    );
  if (kind === "session-boundary-overview-page")
    return (
      outputId === SESSION_PATH_PAGE_REPORT_OUTPUT &&
      typeof row.value === "string" &&
      finiteNumber(row.views) &&
      finiteNumber(row.sessions) &&
      finiteNumber(row.visitors)
    );
  if (kind === "event-type-detail") {
    if (
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.summary ||
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.page ||
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.country ||
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.device ||
      outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.browser
    )
      return (
        typeof row.cardType === "string" &&
        nullableString(row.value) &&
        finiteNumber(row.events) &&
        finiteNumber(row.eventTypes) &&
        finiteNumber(row.sessions) &&
        finiteNumber(row.visitors) &&
        finiteNumber(row.scopedEvents)
      );
    if (outputId === EVENT_TREND_OUTPUTS.typePoints)
      return (
        nullableFiniteNumber(row.bucket) &&
        finiteNumber(row.events) &&
        finiteNumber(row.visitors)
      );
    if (outputId === EVENT_CONTEXT_REPORT_OUTPUT)
      return (
        typeof row.cardType === "string" &&
        nullableString(row.value) &&
        nullableString(row.label) &&
        ["views", "sessions", "visitors"].every((field) =>
          finiteNumber(row[field]),
        )
      );
    return false;
  }
  if (kind === "event-trend") {
    if (outputId === EVENT_TREND_OUTPUTS.series)
      return (
        nullableString(row.eventName) &&
        finiteNumber(row.events) &&
        finiteNumber(row.sessions) &&
        finiteNumber(row.visitors)
      );
    if (outputId === EVENT_TREND_OUTPUTS.points)
      return (
        nullableFiniteNumber(row.bucket) &&
        nullableString(row.seriesName) &&
        finiteNumber(row.events)
      );
    if (outputId === EVENT_TREND_OUTPUTS.other)
      return (
        typeof row.eventName === "string" &&
        finiteNumber(row.events) &&
        finiteNumber(row.sessions) &&
        finiteNumber(row.visitors)
      );
    return false;
  }
  if (kind === "event-types")
    return (
      typeof row.value === "string" &&
      ["views", "sessions", "visitors"].every((field) =>
        finiteNumber(row[field]),
      )
    );
  if (kind === "event-context")
    return (
      typeof row.cardType === "string" &&
      nullableString(row.value) &&
      nullableString(row.label) &&
      ["views", "sessions", "visitors"].every((field) =>
        finiteNumber(row[field]),
      )
    );
  if (kind === "event-fields")
    return (
      typeof row.path === "string" &&
      typeof row.valueType === "number" &&
      Number.isSafeInteger(row.valueType) &&
      finiteNumber(row.events) &&
      finiteNumber(row.occurrences) &&
      nullableFiniteNumber(row.firstSeenAt) &&
      nullableFiniteNumber(row.lastSeenAt) &&
      nullableString(row.stringValue) &&
      nullableFiniteNumber(row.numberValue) &&
      nullableFiniteNumber(row.booleanValue)
    );
  if (kind === "event-field-values")
    return (
      typeof row.valueType === "number" &&
      Number.isSafeInteger(row.valueType) &&
      finiteNumber(row.events) &&
      finiteNumber(row.occurrences) &&
      nullableFiniteNumber(row.firstSeenAt) &&
      nullableFiniteNumber(row.lastSeenAt) &&
      nullableString(row.stringValue) &&
      nullableFiniteNumber(row.numberValue) &&
      nullableFiniteNumber(row.booleanValue) &&
      typeof row.valueString === "string" &&
      finiteNumber(row.valueNumber) &&
      finiteNumber(row.valueBoolean)
    );
  return (
    (row.value === null || typeof row.value === "string") &&
    ["views", "eventTypes", "sessions", "visitors"].every(
      (field) => row[field] === null || finiteNumber(row[field]),
    )
  );
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  program: EventQualificationProgram,
): EventSummaryQualificationExecution {
  if (!compiledPrograms.has(program))
    throw new Error("analytics_event_summary_qualification_program_untrusted");
  const deferred = program.deferred;
  const controlFields = [
    "rowKind",
    "outputId",
    ...program.reportEnvelopeFields,
    "rawCount",
    "nullActivityIdCount",
    "siteIdentityMismatchCount",
    "entityKind",
    "invalidIdentityCount",
    "duplicateIdentityCount",
    ...program.compatibilityFields.map(({ outputName }) => outputName),
  ];
  const controlRows = rows.filter((row) => row.rowKind === "control");
  if (
    controlRows.length !== 1 ||
    !exactRowKeys(controlRows[0]!, controlFields) ||
    controlRows[0]!.outputId !== program.controlOutputId
  )
    throw new Error(
      "analytics_event_summary_qualification_control_row_invalid",
    );
  const control = controlRows[0]!;
  if (control.entityKind !== deferred.countInput.scope)
    throw new Error(
      "analytics_event_summary_qualification_control_kind_mismatch",
    );
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: program.compatibilityFields,
    errorLabel: (field) =>
      `analytics_event_summary_qualification_control_invalid:${field}`,
  });
  const reportRows = rows.filter((row) => row.rowKind === "report");
  if (rows.length !== controlRows.length + reportRows.length)
    throw new Error(
      "analytics_event_summary_qualification_envelope_kind_invalid",
    );
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () =>
      new Error("analytics_event_summary_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback")
    return { kind: "legacy", fallbackReason: judgment.fallbackReason };
  const reportOutputs = new Set(program.reportOutputIds);
  const expectedCardTypes = new Map<string, string>(
    REPORT_OUTPUT_TYPES.map(([outputId, cardType]) => [outputId, cardType]),
  );
  const expectedEventTypeDetailCardTypes = new Map<string, string>([
    [EVENT_TYPE_OVERVIEW_OUTPUTS.summary, "summary"],
    [EVENT_TYPE_OVERVIEW_OUTPUTS.page, "page"],
    [EVENT_TYPE_OVERVIEW_OUTPUTS.country, "country"],
    [EVENT_TYPE_OVERVIEW_OUTPUTS.device, "device"],
    [EVENT_TYPE_OVERVIEW_OUTPUTS.browser, "browser"],
  ]);
  const expectedContextCardTypes = new Set(program.reportCardTypes ?? []);
  for (const row of reportRows) {
    const outputFields =
      typeof row.outputId === "string" && reportOutputs.has(row.outputId)
        ? reportFieldsForOutput(
            program.reportKind,
            row.outputId,
            program.reportConfiguration,
          )
        : null;
    const invalidReportShape =
      !outputFields ||
      !validReportShape(
        program.reportKind,
        row.outputId as string,
        row,
        program.reportConfiguration,
      ) ||
      program.reportEnvelopeFields.some(
        (field) => !outputFields.includes(field) && row[field] !== null,
      );
    if (
      !exactRowKeys(row, controlFields) ||
      typeof row.outputId !== "string" ||
      !reportOutputs.has(row.outputId) ||
      (program.reportKind === "event-summary" &&
        row.cardType !== expectedCardTypes.get(row.outputId)) ||
      (program.reportKind === "event-types" &&
        (row.cardType !== null || row.eventTypes !== null)) ||
      (program.reportKind === "event-context" &&
        (row.outputId !== EVENT_CONTEXT_REPORT_OUTPUT ||
          typeof row.cardType !== "string" ||
          !expectedContextCardTypes.has(
            row.cardType as EventContextCardKey,
          ))) ||
      (program.reportKind === "event-type-detail" &&
        ((row.outputId === EVENT_CONTEXT_REPORT_OUTPUT &&
          (typeof row.cardType !== "string" ||
            !expectedContextCardTypes.has(
              row.cardType as EventContextCardKey,
            ))) ||
          (row.outputId !== EVENT_CONTEXT_REPORT_OUTPUT &&
            row.outputId !== EVENT_TREND_OUTPUTS.typePoints &&
            row.cardType !==
              expectedEventTypeDetailCardTypes.get(row.outputId as string)))) ||
      (program.reportKind === "event-trend" &&
        ["cardType", "value", "views", "eventTypes"].some(
          (field) => row[field] !== null,
        )) ||
      invalidReportShape ||
      controlFields
        .filter((field) =>
          [
            "rawCount",
            "nullActivityIdCount",
            "siteIdentityMismatchCount",
            "entityKind",
            "invalidIdentityCount",
            "duplicateIdentityCount",
            ...program.compatibilityFields.map(({ outputName }) => outputName),
          ].includes(field),
        )
        .some((field) => row[field] !== null)
    )
      throw new Error(
        "analytics_event_summary_qualification_report_row_invalid",
      );
  }
  if (
    program.reportKind === "event-summary" &&
    reportRows.filter(
      (row) => row.outputId === EVENT_SUMMARY_CARD_OUTPUTS.summary,
    ).length > 1
  )
    throw new Error("analytics_event_summary_qualification_summary_duplicated");
  if (
    program.reportKind === "event-type-detail" &&
    reportRows.filter(
      (row) => row.outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
    ).length !== 1
  )
    throw new Error(
      "analytics_event_type_detail_qualification_summary_cardinality",
    );
  if (
    program.reportKind === "event-trend" &&
    reportRows.filter((row) => row.outputId === EVENT_TREND_OUTPUTS.other)
      .length !== 1
  )
    throw new Error("analytics_event_trend_qualification_other_cardinality");
  if (program.reportKind === "referrers") {
    const configuration =
      typeof program.reportConfiguration === "object"
        ? program.reportConfiguration
        : undefined;
    if (configuration?.kind === "summary") {
      const summaryRows = reportRows.filter(
        (row) => row.outputId === "referrer-summary",
      );
      const topRows = reportRows.filter(
        (row) => row.outputId === "referrer-top-sources",
      );
      if (summaryRows.length !== 1 || topRows.length > configuration.topN + 1)
        throw new Error(
          "analytics_referrers_qualification_summary_cardinality",
        );
    } else if (
      configuration?.kind !== "page" ||
      reportRows.length > configuration.limit + 1
    )
      throw new Error("analytics_referrers_qualification_page_cardinality");
  }
  return {
    kind: "executed",
    rows: Object.freeze([...reportRows]),
    evidence: program.evidence,
  };
}

async function executeEventQualificationProgram(input: {
  readonly env: Env;
  readonly request: EventQualificationCompileRequest;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<
  | EventSummaryQualificationExecution
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    }
> {
  const result = compileProgram(input.request);
  if (result.kind === "unavailable") return result;
  const rows = await executeQualificationQuery(
    input.request.deferred.signal,
    () =>
      queryD1CompiledAll(input.env, result.program.query, input.diagnostics),
  );
  return decodeRows(rows, result.program);
}

export function executeEventSummaryQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredEventSummaryQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: { kind: "event-summary", deferred: input.deferred },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeEventTypesQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredEventTypesQualification;
  readonly query: EventTypePageQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "event-types",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeEventNameDimensionQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredEventNameDimensionQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  const request = input.deferred.eventNameDimensionRequest;
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "event-types",
      deferred: input.deferred,
      query: {
        kind: "list",
        limit: request.limit,
        ...(request.search !== undefined ? { search: request.search } : {}),
      },
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeEventTrendQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredEventTrendQualification;
  readonly query: EventTrendQualificationQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "event-trend",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeEventContextQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredEventContextQualification;
  readonly query: EventContextQualificationQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "event-context",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeEventTypeDetailQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredEventTypeDetailQualification;
  readonly query: EventTypeDetailQualificationQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "event-type-detail",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeEventFieldsQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredEventFieldsQualification;
  readonly query: EventFieldsQualificationQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "event-fields",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeEventFieldValuesQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredEventFieldValuesQualification;
  readonly query: EventFieldValuesQualificationQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "event-field-values",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executePageDimensionQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredPageQualification;
  readonly query: PageDimensionQualificationReportQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "page-dimension",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeReferrersQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredReferrersQualification;
  readonly query: ReferrersQualificationReportQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "referrers",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executePagesAggregateQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredPagesAggregatePageQualification;
  readonly query: PagesAggregateQualificationReportQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "pages-aggregate-page",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executePagesTabsQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredPagesTabsQualification;
  readonly query: PagesTabsQualificationReportQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "pages-tabs",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeChannelListQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredChannelListQualification;
  readonly query: ChannelListQualificationReportQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "channel-list",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeSessionBoundaryDimensionQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredSessionBoundaryDimensionQualification;
  readonly query: SessionBoundaryDimensionQualificationReportQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "session-boundary-dimension",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}

export function executeSessionBoundaryOverviewPageQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredSessionBoundaryOverviewPageQualification;
  readonly query: SessionBoundaryOverviewPageQualificationReportQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): ReturnType<typeof executeEventQualificationProgram> {
  return executeEventQualificationProgram({
    env: input.env,
    request: {
      kind: "session-boundary-overview-page",
      deferred: input.deferred,
      query: input.query,
    },
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
}
