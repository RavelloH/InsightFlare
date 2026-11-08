import type {
  AdvancedCountFilterMatchPlanInput,
  AdvancedCountQualificationPlanInput,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { DIMENSION_PAGE_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { EVENT_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import {
  buildEventTypeSummaryQualificationPlan,
  EVENT_TYPE_SUMMARY_OUTPUTS,
} from "@/lib/edge/analytics/engine/event-type-summary-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildPageDimensionQualificationPlan,
  PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import { assertWholeFilterCountDocument } from "@/lib/edge/analytics/engine/qualified-page-source";
import { buildReferrerPageQualificationPlan } from "@/lib/edge/analytics/engine/referrer-page-qualification-plan";
import { REFERRERS_PAGE_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/referrer-report-plan";
import { buildSessionBoundaryOverviewPageQualificationPlan } from "@/lib/edge/analytics/engine/session-boundary-dimension-qualification-plan";
import { SESSION_PATH_PAGE_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/session-path-report-plan";
import type {
  DimensionRow,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";
import { InvalidCursorError } from "@/lib/pagination";

import { prepareDeferredEventQualificationFallback } from "./advanced-filter-execution";
import { DIRECT_REFERRER_FILTER_VALUE } from "./core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import {
  decodeDimensionCursor,
  decodeSessionPathDimensionCursor,
  type DimensionAggregateCursor,
  dimensionPageResultFromRows,
  finalizeSessionPathDimensionPage,
  type SessionPathDimensionCursor,
} from "./dimensions";
import {
  decodeEventTypeCursor,
  type EventTypeAggregateCursor,
  eventTypePageResultFromRows,
} from "./events-summary";
import {
  type FilterValuePage,
  mapFilterValueRows,
  queryFilterValuesPageFromD1,
} from "./filter-values";
import {
  assertFilterValuesQualificationRequest,
  type DeferredFilterValuesQualification,
} from "./filter-values-qualification-request";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeCompilation,
  type QualificationEnvelopeQualification,
} from "./qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";
import {
  decodeReferrersCursor,
  type ReferrerAggregateCursor,
  referrerPageFromRows,
} from "./referrers";

const ERROR_PREFIX = "filter_values_qualification";
const FALLBACK_TAG = "analytics.filter_values_qualification";
const REPORT_FIELDS = ["value", "views", "sessions", "visitors"] as const;
const REPORT_ROW_TYPE = "filter-values-page";
const EVENT_REPORT_ROW_TYPE = "event-type-page";
const REFERRER_REPORT_FIELDS = [
  "referrer",
  "views",
  "sessions",
  "visitors",
] as const;
const REFERRER_REPORT_ROW_TYPE = "referrer-page";
const SESSION_BOUNDARY_REPORT_ROW_TYPE = "filter-values-session-boundary-page";
type FilterValuesQualificationCursor =
  | DimensionAggregateCursor
  | EventTypeAggregateCursor
  | ReferrerAggregateCursor
  | SessionPathDimensionCursor;

export type FilterValuesQualificationCompilation =
  | Extract<QualificationEnvelopeCompilation, { readonly kind: "compiled" }>
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

export type FilterValuesQualificationExecution =
  | {
      readonly kind: "executed";
      readonly page: FilterValuePage;
      readonly evidence: Extract<
        QualificationEnvelopeCompilation,
        { readonly kind: "compiled" }
      >["evidence"];
      readonly reportRowCount: number;
      readonly controlRowCount: 1;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

function exactOutput(
  outputs: readonly LogicalOutput[],
  outputId: string,
): LogicalOutput {
  const matches = outputs.filter((output) => output.id === outputId);
  if (matches.length !== 1)
    throw new Error(`${ERROR_PREFIX}_output:${outputId}`);
  return matches[0]!;
}

function requireOwnerCountInput(
  countInput: AdvancedCountQualificationPlanInput,
): AdvancedCountFilterMatchPlanInput {
  if (countInput.scope === "event")
    throw new Error(`${ERROR_PREFIX}_owner_count_scope_invalid`);
  return countInput;
}

function compile(
  request: DeferredFilterValuesQualification,
  cursor: FilterValuesQualificationCursor | null,
): FilterValuesQualificationCompilation {
  const deferred = request.qualification;
  const configuration = request.configuration;
  let qualification: QualificationEnvelopeQualification;
  let reportOutputId: string;
  let controlOutputId: string;
  let reportRowType: string;
  let reportFields: readonly string[];
  let valueNulls: "first" | "last";
  let outputs: readonly LogicalOutput[];
  if (configuration.reportKind === "event") {
    const reportFilters = deferred.filterValuesReportFilters;
    const eventCandidate =
      deferred.countInput.scope === "event" &&
      deferred.countInput.candidateAnchor.kind === "event-candidate";
    if (eventCandidate) {
      if (request.filterMode !== "allow-whole-filter" || reportFilters)
        throw new Error(`${ERROR_PREFIX}_event_candidate_filter_mode_invalid`);
      assertWholeFilterCountDocument(
        deferred.filters,
        deferred.countInput.analysis.document,
        `${ERROR_PREFIX}_event_whole_count_document_mismatch`,
      );
    } else {
      if (!reportFilters)
        throw new Error(`${ERROR_PREFIX}_event_report_filters_missing`);
      if (request.filterMode === "allow-whole-filter") {
        assertWholeFilterCountDocument(
          deferred.filters,
          deferred.countInput.analysis.document,
          `${ERROR_PREFIX}_event_whole_count_document_mismatch`,
        );
        if (reportFilters.root !== null)
          throw new Error(
            `${ERROR_PREFIX}_event_whole_report_filters_not_empty`,
          );
      }
    }
    if (eventCandidate && reportFilters !== undefined)
      throw new Error(`${ERROR_PREFIX}_event_whole_report_filters_not_empty`);
    const plan = buildEventTypeSummaryQualificationPlan({
      siteId: deferred.siteId,
      count: deferred.countInput,
      ...(reportFilters !== undefined ? { reportFilters } : {}),
      query: {
        kind: "page",
        limit: configuration.limit,
        ...(configuration.search !== undefined
          ? { search: configuration.search }
          : {}),
        cursor: (cursor as EventTypeAggregateCursor | null) ?? null,
      },
    });
    qualification = {
      plan: plan.plan,
      primaryReportSourceRelationId: plan.primaryReportSourceRelationId,
      controlsRelationId: plan.controlsRelationId,
      controlOutputId: plan.controlOutputId,
      numericCompatibilityFields: plan.numericCompatibilityFields,
      scope: plan.scope,
      reportSourceRelations: plan.reportSourceRelations,
      ...(plan.candidateGrain ? { candidateGrain: plan.candidateGrain } : {}),
      ...(plan.groupedSummaryRelationId
        ? { groupedSummaryRelationId: plan.groupedSummaryRelationId }
        : {}),
      ...(plan.additionalGroupedSummaryRelationIds
        ? {
            additionalGroupedSummaryRelationIds:
              plan.additionalGroupedSummaryRelationIds,
          }
        : {}),
    };
    reportOutputId = EVENT_TYPE_SUMMARY_OUTPUTS.page;
    controlOutputId = EVENT_QUALIFICATION_CONTROL_OUTPUT;
    reportRowType = EVENT_REPORT_ROW_TYPE;
    reportFields = REPORT_FIELDS;
    valueNulls = "last";
    outputs = plan.plan.outputs;
  } else if (configuration.reportKind === "referrer") {
    const ownerCountInput = requireOwnerCountInput(deferred.countInput);
    const plan = buildReferrerPageQualificationPlan({
      semanticOperation: "filter-values",
      siteId: deferred.siteId,
      queryTime: deferred.requestTime,
      filters: deferred.filters,
      scopePlan: deferred.metadata.plan,
      count: ownerCountInput,
      filterMode: request.filterMode,
      options: {
        limit: configuration.limit,
        includeFullUrl: configuration.field === "referrer.url",
        ...(configuration.search !== undefined
          ? { search: configuration.search }
          : {}),
        sortBy: "views",
        sortDirection: "desc",
        cursor: (cursor as ReferrerAggregateCursor | null) ?? null,
      },
    });
    qualification = plan;
    reportOutputId = REFERRERS_PAGE_REPORT_OUTPUT;
    controlOutputId = PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT;
    reportRowType = REFERRER_REPORT_ROW_TYPE;
    reportFields = REFERRER_REPORT_FIELDS;
    valueNulls = "first";
    outputs = plan.plan.outputs;
  } else if (configuration.reportKind === "session-boundary") {
    const ownerCountInput = requireOwnerCountInput(deferred.countInput);
    const plan = buildSessionBoundaryOverviewPageQualificationPlan({
      semanticOperation: "filter-values",
      siteId: deferred.siteId,
      queryTime: deferred.requestTime,
      filters: deferred.filters,
      scopePlan: deferred.metadata.plan,
      count: ownerCountInput,
      filterMode: request.filterMode,
      kind: configuration.field === "session.entryPath" ? "entry" : "exit",
      limit: configuration.limit,
      ...(configuration.search !== undefined
        ? { search: configuration.search }
        : {}),
      sortBy: "views",
      sortDirection: "desc",
      cursor: (cursor as SessionPathDimensionCursor | null) ?? null,
    });
    qualification = plan;
    reportOutputId = SESSION_PATH_PAGE_REPORT_OUTPUT;
    controlOutputId = PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT;
    reportRowType = SESSION_BOUNDARY_REPORT_ROW_TYPE;
    reportFields = REPORT_FIELDS;
    valueNulls = "first";
    outputs = plan.plan.outputs;
  } else {
    const pageCandidate =
      configuration.reportKind === "page" &&
      "eventCandidateReportProjection" in deferred &&
      deferred.eventCandidateReportProjection === "page-visits";
    if (
      pageCandidate &&
      (request.filterMode !== "allow-whole-filter" ||
        deferred.countInput.scope !== "event" ||
        deferred.countInput.candidateAnchor.kind !== "event-candidate" ||
        deferred.filterValuesRequest.reportKind !== "page")
    )
      throw new Error(`${ERROR_PREFIX}_page_candidate_projection_invalid`);
    const countInput = pageCandidate
      ? deferred.countInput
      : requireOwnerCountInput(deferred.countInput);
    const plan = buildPageDimensionQualificationPlan({
      semanticOperation: "filter-values",
      siteId: deferred.siteId,
      queryTime: deferred.requestTime,
      filters: deferred.filters,
      scopePlan: deferred.metadata.plan,
      count: countInput,
      filterMode: request.filterMode,
      ...(pageCandidate
        ? { eventCandidateReportProjection: "page-visits" as const }
        : {}),
      options: {
        limit: configuration.limit,
        selection: configuration.selection,
        excludeEmpty: true,
        ...(configuration.search !== undefined
          ? { search: configuration.search }
          : {}),
        sortBy: "views",
        sortDirection: "desc",
        cursor: cursor as DimensionAggregateCursor | null,
      },
    });
    qualification = {
      plan: plan.plan,
      primaryReportSourceRelationId: plan.primaryReportSourceRelationId,
      controlsRelationId: plan.controlsRelationId,
      controlOutputId: plan.controlOutputId,
      numericCompatibilityFields: plan.numericCompatibilityFields,
      scope: plan.scope,
      reportSourceRelations: plan.reportSourceRelations,
      ...(plan.candidateGrain ? { candidateGrain: plan.candidateGrain } : {}),
      ...(plan.groupedSummaryRelationId
        ? { groupedSummaryRelationId: plan.groupedSummaryRelationId }
        : {}),
      ...(plan.additionalGroupedSummaryRelationIds
        ? {
            additionalGroupedSummaryRelationIds:
              plan.additionalGroupedSummaryRelationIds,
          }
        : {}),
      ...(plan.eventCandidateReportProjection
        ? {
            eventCandidateReportProjection: plan.eventCandidateReportProjection,
          }
        : {}),
    };
    reportOutputId = DIMENSION_PAGE_REPORT_OUTPUT;
    controlOutputId = PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT;
    reportRowType = REPORT_ROW_TYPE;
    reportFields = REPORT_FIELDS;
    valueNulls = "first";
    outputs = plan.plan.outputs;
  }
  const reportOutput = exactOutput(outputs, reportOutputId);
  const controlsOutput = exactOutput(outputs, controlOutputId);
  return compileQualificationProgramEnvelope({
    qualification,
    siteId: deferred.siteId,
    reports: [
      {
        output: reportOutput,
        fields: reportFields,
        rowType: reportRowType,
      },
    ],
    controlsOutput,
    reportFields,
    controlFields: controlsOutput.fields.map(({ name }) => name),
    ordering: [
      {
        field: "views",
        outputId: reportOutputId,
        direction: "desc",
        nulls: "last",
      },
      ...(configuration.reportKind === "session-boundary"
        ? []
        : [
            {
              field: "sessions",
              outputId: reportOutputId,
              direction: "desc" as const,
              nulls: "last" as const,
            },
          ]),
      {
        field: configuration.reportKind === "referrer" ? "referrer" : "value",
        outputId: reportOutputId,
        direction: "asc",
        nulls: valueNulls,
      },
    ],
    errorPrefix: ERROR_PREFIX,
    fallbackTag: FALLBACK_TAG,
    signal: deferred.signal,
  });
}

function queryWindowFromRequest(
  request: DeferredFilterValuesQualification,
): QueryWindow {
  const time = request.qualification.requestTime;
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

export function compileFilterValuesQualificationProgram(input: {
  readonly request: DeferredFilterValuesQualification;
  readonly cursor?: FilterValuesQualificationCursor | null;
}): FilterValuesQualificationCompilation {
  return compile(input.request, input.cursor ?? null);
}

function exactKeys(row: Record<string, unknown>, fields: readonly string[]) {
  const actual = Object.keys(row).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}

async function decodeRows(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly request: DeferredFilterValuesQualification;
  readonly evidence: Extract<
    QualificationEnvelopeCompilation,
    { readonly kind: "compiled" }
  >["evidence"];
  readonly env: Env;
  readonly window: QueryWindow;
}): Promise<FilterValuesQualificationExecution> {
  const { rows, request, evidence, env, window } = input;
  const isEventReport = request.configuration.reportKind === "event";
  const isReferrerReport = request.configuration.reportKind === "referrer";
  const isSessionBoundaryReport =
    request.configuration.reportKind === "session-boundary";
  const reportOutputId = isEventReport
    ? EVENT_TYPE_SUMMARY_OUTPUTS.page
    : isReferrerReport
      ? REFERRERS_PAGE_REPORT_OUTPUT
      : isSessionBoundaryReport
        ? SESSION_PATH_PAGE_REPORT_OUTPUT
        : DIMENSION_PAGE_REPORT_OUTPUT;
  const reportRowType = isEventReport
    ? EVENT_REPORT_ROW_TYPE
    : isReferrerReport
      ? REFERRER_REPORT_ROW_TYPE
      : isSessionBoundaryReport
        ? SESSION_BOUNDARY_REPORT_ROW_TYPE
        : REPORT_ROW_TYPE;
  const reportFields = isReferrerReport
    ? REFERRER_REPORT_FIELDS
    : REPORT_FIELDS;
  const controlOutputId = isEventReport
    ? EVENT_QUALIFICATION_CONTROL_OUTPUT
    : PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT;
  if (
    evidence.outputDescriptors.length !== 1 ||
    evidence.outputDescriptors[0]?.outputId !== reportOutputId ||
    evidence.outputDescriptors[0]?.rowType !== reportRowType ||
    evidence.outputDescriptors[0]?.fields.join("|") !== reportFields.join("|")
  )
    throw new Error(`${ERROR_PREFIX}_output_descriptor_invalid`);
  const envelopeFields = [
    "rowKind",
    "outputId",
    ...reportFields,
    ...evidence.controlFields,
  ];
  const controlRows: Record<string, unknown>[] = [];
  const reportRows: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (!exactKeys(row, envelopeFields))
      throw new Error(`${ERROR_PREFIX}_envelope_row_invalid`);
    if (row.rowKind === "control") controlRows.push(row);
    else if (row.rowKind === "report") reportRows.push(row);
    else throw new Error(`${ERROR_PREFIX}_row_kind_invalid`);
  }
  if (
    controlRows.length !== 1 ||
    rows.length !== controlRows.length + reportRows.length
  )
    throw new Error(`${ERROR_PREFIX}_control_row_invalid`);
  const control = controlRows[0]!;
  if (
    evidence.controlOutputId !== controlOutputId ||
    control.outputId !== controlOutputId ||
    control.entityKind !== request.qualification.countInput.scope ||
    reportFields.some((field) => control[field] !== null)
  )
    throw new Error(`${ERROR_PREFIX}_control_kind_mismatch`);
  const judgment = judgeQualificationControl(
    decodeQualificationControl({
      read: (field) => control[field],
      compatibilityFields: evidence.compatibilityFields,
      errorLabel: (field) => `${ERROR_PREFIX}_control_invalid:${field}`,
    }),
    {
      reportRowCount: reportRows.length,
      gateViolation: () => new Error(`${ERROR_PREFIX}_gate_violation`),
      invalidIdentity: () => new Error(`${ERROR_PREFIX}_identity_invalid`),
      duplicateIdentity: () => new Error(`${ERROR_PREFIX}_identity_repeated`),
    },
  );
  if (judgment.kind === "fallback")
    return { kind: "fallback", fallbackReason: judgment.fallbackReason };
  const configuration = request.configuration;
  if (reportRows.length > configuration.limit + 1)
    throw new Error(`${ERROR_PREFIX}_page_cardinality_invalid`);
  const rawValues = new Set<string>();
  const mappedRows: DimensionRow[] = reportRows.map((row) => {
    if (
      row.outputId !== reportOutputId ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error(`${ERROR_PREFIX}_report_row_invalid`);
    const value = row[isReferrerReport ? "referrer" : "value"];
    if (typeof value !== "string")
      throw new Error(`${ERROR_PREFIX}_report_value_invalid`);
    if (rawValues.has(value))
      throw new Error(`${ERROR_PREFIX}_report_value_repeated`);
    rawValues.add(value);
    const views = row.views;
    const sessions = row.sessions;
    const visitors = row.visitors;
    for (const [field, count] of [
      ["views", views],
      ["sessions", sessions],
      ["visitors", visitors],
    ] as const) {
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        (field === "views" && count === 0)
      )
        throw new Error(`${ERROR_PREFIX}_report_${field}_invalid`);
    }
    return {
      value,
      views: views as number,
      sessions: sessions as number,
      visitors: visitors as number,
    };
  });
  if (configuration.reportKind === "event") {
    const page = await eventTypePageResultFromRows({
      env,
      siteId: request.qualification.siteId,
      window,
      filters: request.qualification.filters,
      rows: mappedRows,
      limit: configuration.limit,
      ...(configuration.search !== undefined
        ? { search: configuration.search }
        : {}),
      audience: configuration.audience,
    });
    return {
      kind: "executed",
      page: {
        items: page.items.map((row) => ({
          value: row.value,
          occurrences: row.views,
        })),
        pagination: page.pagination,
      },
      evidence,
      reportRowCount: reportRows.length,
      controlRowCount: 1,
    };
  }
  if (configuration.reportKind === "referrer") {
    const page = await referrerPageFromRows({
      env,
      siteId: request.qualification.siteId,
      window,
      filters: request.qualification.filters,
      rows: mappedRows.map((row) => ({
        referrer: row.value,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      })),
      limit: configuration.limit,
      includeFullUrl: configuration.field === "referrer.url",
      ...(configuration.search !== undefined
        ? { search: configuration.search }
        : {}),
      audience: configuration.audience,
      sortBy: "views",
      sortDirection: "desc",
    });
    const items = page.items
      .map((row) => ({
        value: row.referrer || DIRECT_REFERRER_FILTER_VALUE,
        occurrences: row.views,
      }))
      .filter((row) => row.value.length > 0);
    return {
      kind: "executed",
      page: { items, pagination: page.pagination },
      evidence,
      reportRowCount: reportRows.length,
      controlRowCount: 1,
    };
  }
  if (configuration.reportKind === "session-boundary") {
    const page = await finalizeSessionPathDimensionPage({
      env,
      siteId: request.qualification.siteId,
      window,
      filters: request.qualification.filters,
      rows: reportRows,
      limit: configuration.limit,
      kind: configuration.field === "session.entryPath" ? "entry" : "exit",
      ...(configuration.search !== undefined
        ? { search: configuration.search }
        : {}),
      audience: configuration.audience,
      sortBy: "views",
      sortDirection: "desc",
    });
    const items = mapFilterValueRows(page.items, configuration.search);
    return {
      kind: "executed",
      page: {
        items,
        pagination: { ...page.pagination, returned: items.length },
      },
      evidence,
      reportRowCount: reportRows.length,
      controlRowCount: 1,
    };
  }
  const page = await dimensionPageResultFromRows({
    env,
    siteId: request.qualification.siteId,
    window,
    filters: request.qualification.filters,
    limit: configuration.limit,
    selection: configuration.selection,
    options: {
      ...(configuration.search !== undefined
        ? { search: configuration.search }
        : {}),
      sortBy: "views",
      sortDirection: "desc",
    },
    audience: configuration.audience,
    rows: mappedRows,
  });
  return {
    kind: "executed",
    page: {
      items: mapFilterValueRows(page.items, configuration.search),
      pagination: page.pagination,
    },
    evidence,
    reportRowCount: reportRows.length,
    controlRowCount: 1,
  };
}

async function executeFilterValuesQualificationProgram(input: {
  readonly env: Env;
  readonly query: unknown;
  readonly request: DeferredFilterValuesQualification;
  readonly cursor?: FilterValuesQualificationCursor | null;
  readonly window: QueryWindow;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<
  | FilterValuesQualificationExecution
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    }
> {
  const request = assertFilterValuesQualificationRequest(
    input.request,
    input.query,
  );
  const compilation = compile(request, input.cursor ?? null);
  if (compilation.kind === "unavailable") {
    if (input.diagnostics)
      input.diagnostics.advancedCountSqlFallbackReason =
        compilation.fallbackReason;
    return compilation;
  }
  const rows = await executeQualificationQuery(
    request.qualification.signal,
    () =>
      queryD1CompiledAll<Record<string, unknown>>(
        input.env,
        compilation.query,
        input.diagnostics,
      ),
  );
  const execution = await decodeRows({
    rows,
    request,
    evidence: compilation.evidence,
    env: input.env,
    window: input.window,
  });
  if (execution.kind === "fallback" && input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = execution.fallbackReason;
  return execution;
}

async function legacyFallback(input: {
  readonly env: Env;
  readonly request: DeferredFilterValuesQualification;
  readonly window: QueryWindow;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<FilterValuePage> {
  const { qualification, configuration } = input.request;
  const filters =
    await prepareDeferredEventQualificationFallback(qualification);
  return queryFilterValuesPageFromD1(
    input.env,
    qualification.siteId,
    input.window,
    filters,
    configuration.field,
    configuration.limit,
    configuration.cursorToken,
    configuration.search,
    configuration.audience,
  );
}

/** Run one fused Count + Page report, preserving the legacy fallback contract. */
export async function queryFilterValuesPageWithQualification(input: {
  readonly env: Env;
  readonly query: unknown;
  readonly request: DeferredFilterValuesQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<FilterValuePage> {
  const request = assertFilterValuesQualificationRequest(
    input.request,
    input.query,
  );
  const { qualification, configuration } = request;
  const window = queryWindowFromRequest(request);
  let cursor: FilterValuesQualificationCursor | null = null;
  let invalidCursor = false;
  if (configuration.cursorToken) {
    try {
      if (configuration.reportKind === "event") {
        cursor = await decodeEventTypeCursor(
          input.env,
          qualification.siteId,
          window,
          qualification.filters,
          configuration.search,
          configuration.cursorToken,
          configuration.audience,
        );
      } else if (configuration.reportKind === "referrer") {
        cursor = await decodeReferrersCursor(
          input.env,
          qualification.siteId,
          window,
          qualification.filters,
          configuration.field === "referrer.url",
          configuration.search,
          configuration.cursorToken,
          configuration.audience,
        );
      } else if (configuration.reportKind === "session-boundary") {
        cursor = await decodeSessionPathDimensionCursor(
          input.env,
          qualification.siteId,
          window,
          qualification.filters,
          configuration.field === "session.entryPath" ? "entry" : "exit",
          configuration.search,
          configuration.cursorToken,
          configuration.audience,
          "views",
          "desc",
        );
      } else {
        cursor = await decodeDimensionCursor(
          input.env,
          qualification.siteId,
          window,
          qualification.filters,
          configuration.selection,
          configuration.search,
          configuration.cursorToken,
          configuration.audience,
        );
      }
    } catch (error) {
      if (!(error instanceof InvalidCursorError)) throw error;
      invalidCursor = true;
    }
    if (!cursor) invalidCursor = true;
  }
  const execution = await executeFilterValuesQualificationProgram({
    env: input.env,
    query: input.query,
    request,
    // Decoded cursors and derived windows stay inside this module. The only raw
    // token accepted by the production path is the token in the branded config.
    cursor: invalidCursor ? null : cursor,
    window,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
  });
  if (execution.kind !== "executed")
    return legacyFallback({
      env: input.env,
      request,
      window,
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    });
  if (invalidCursor) throw new InvalidCursorError("filter-values");
  return execution.page;
}
