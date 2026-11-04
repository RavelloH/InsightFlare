import type { CompiledQuery } from "@/lib/db";
import { buildJourneyEventPageQualificationPlan } from "@/lib/edge/analytics/engine/journey-event-page-qualification-plan";
import { JOURNEY_EVENT_PAGE_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/journey-event-page-report-plan";
import { JOURNEY_EVENT_PAGE_REPORT_FIELDS } from "@/lib/edge/analytics/engine/journey-event-page-report-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  deferredEventQualificationFromQuery,
  isDeferredEventQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { JourneyEventRow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  type DeferredJourneyEventPageQualification,
  deferredJourneyEventPageQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/journey-event-page-qualification-request";
import { mapJourneyEventRow } from "@/lib/edge/analytics/providers/d1/internal/journey-helpers";
import { queryJourneyTargetExistsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-list-queries";
import {
  InvalidCursorError,
  pageResult,
} from "@/lib/edge/analytics/providers/d1/internal/pagination";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeCompilationEvidence,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-program-runtime";
import {
  decodeSiteJourneyEventPageCursor,
  encodeSiteJourneyEventPageCursor,
  type JourneyTrajectoryInput,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import type { Env } from "@/lib/edge/types";

const ERROR_PREFIX = "journey_event_page_qualification";

export type JourneyEventPageQualificationExecution =
  | {
      readonly kind: "executed";
      readonly result: {
        readonly items: readonly JourneyEventRow[];
        readonly pagination: {
          readonly limit: number;
          readonly returned: number;
          readonly hasMore: boolean;
          readonly nextCursor: string | null;
        };
      };
      readonly evidence: QualificationEnvelopeCompilationEvidence;
      readonly reportRowCount: number;
      readonly controlRowCount: 1;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

function requestWindow(time: {
  readonly range: { readonly startMs: number; readonly endExclusiveMs: number };
  readonly capturedAtMs: number;
  readonly reportingTimeZone: string;
}) {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

function exactOutput(outputs: readonly LogicalOutput[], outputId: string) {
  const matches = outputs.filter((output) => output.id === outputId);
  if (matches.length !== 1)
    throw new Error(`${ERROR_PREFIX}_output:${outputId}`);
  return matches[0]!;
}

function ownRecordRows(
  input: unknown,
  reportFields: readonly string[],
  controlFields: readonly string[],
): Record<string, unknown>[] {
  if (!Array.isArray(input))
    throw new Error(`${ERROR_PREFIX}_envelope_rows_invalid`);
  const expected = [
    "rowKind",
    "outputId",
    ...reportFields,
    ...controlFields,
  ].sort();
  return input.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error(`${ERROR_PREFIX}_envelope_row_invalid`);
    let keys: PropertyKey[];
    try {
      keys = Reflect.ownKeys(candidate);
    } catch {
      throw new Error(`${ERROR_PREFIX}_envelope_row_invalid`);
    }
    if (
      keys.length !== expected.length ||
      keys.some((key) => typeof key !== "string") ||
      [...keys].sort().some((key, index) => key !== expected[index])
    )
      throw new Error(`${ERROR_PREFIX}_envelope_row_schema_invalid`);
    const row: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor))
        throw new Error(`${ERROR_PREFIX}_envelope_row_schema_invalid`);
      row[key] = descriptor.value;
    }
    return row;
  });
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const keys = Reflect.ownKeys(value);
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key) => typeof key === "string") &&
    [...keys].sort().every((key, index) => key === sortedExpected[index]) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })
  );
}

function targetFor(request: DeferredJourneyEventPageQualification) {
  return request.operation === "visitor-events"
    ? { type: "visitor" as const, value: request.configuration.target }
    : { type: "session" as const, value: request.configuration.target };
}

async function compileProgram(input: {
  readonly query: Record<string, unknown>;
  readonly deferred: DeferredJourneyEventPageQualification;
}) {
  const request = deferredJourneyEventPageQualificationFromQuery(input.query);
  if (!request || input.deferred !== request)
    throw new Error(`${ERROR_PREFIX}_request_invalid`);
  const qualification = request.qualification;
  if (
    !isDeferredEventQualification(qualification) ||
    deferredEventQualificationFromQuery(input.query, request.operation) !==
      qualification ||
    qualification.operation !== request.operation ||
    qualification.requestTime === undefined ||
    qualification.requestScopePlan === undefined ||
    qualification.journeyEventPageRequest === undefined ||
    qualification.journeyEventPageRequest.operation !== request.operation ||
    qualification.journeyEventPageRequest.target !==
      request.configuration.target ||
    qualification.journeyEventPageRequest.page.limit !==
      request.configuration.page.limit ||
    qualification.journeyEventPageRequest.page.cursor !==
      request.configuration.page.cursor ||
    qualification.journeyEventPageRequest.filterMode !==
      request.configuration.filterMode
  )
    throw new Error(`${ERROR_PREFIX}_request_invalid`);

  const window = requestWindow(qualification.requestTime);
  const cursorInput: JourneyTrajectoryInput = {
    env: qualification.env,
    siteId: qualification.siteId,
    window,
    filters: qualification.filters,
    page: request.configuration.page,
    audience: request.configuration.audience,
  };
  let cursor: { readonly occurredAt: number; readonly id: string } | null =
    null;
  let cursorError: InvalidCursorError | undefined;
  try {
    cursor = await decodeSiteJourneyEventPageCursor(
      cursorInput,
      request.operation,
      request.configuration.target,
    );
  } catch (error) {
    if (!(error instanceof InvalidCursorError)) throw error;
    cursorError = error;
  }

  const plan = buildJourneyEventPageQualificationPlan({
    operation: request.operation,
    siteId: qualification.siteId,
    queryTime: qualification.requestTime,
    filters: qualification.filters,
    scopePlan: qualification.requestScopePlan,
    count: qualification.countInput,
    target: targetFor(request),
    ...(request.configuration.filterMode
      ? { filterMode: request.configuration.filterMode }
      : {}),
    limit: request.configuration.page.limit,
    cursor,
    ...(cursorError ? { suppressReportRows: true } : {}),
  });
  const report = exactOutput(
    plan.plan.outputs,
    JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
  );
  const controls = exactOutput(
    plan.plan.outputs,
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  const reportFields = report.fields.map(({ name }) => name);
  const compilation = compileQualificationProgramEnvelope({
    qualification: plan,
    siteId: qualification.siteId,
    reports: [
      { output: report, fields: reportFields, rowType: "journey-event-page" },
    ],
    controlsOutput: controls,
    reportFields,
    controlFields: controls.fields.map(({ name }) => name),
    ordering: [
      {
        outputId: JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
        field: "occurredAt",
        direction: "desc",
        nulls: "last",
      },
      {
        outputId: JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
        field: "id",
        direction: "desc",
        nulls: "last",
      },
    ],
    errorPrefix: ERROR_PREFIX,
    fallbackTag: "analytics.journey_event_page_qualification",
    signal: qualification.signal,
  });
  return { request, qualification, cursorInput, cursorError, compilation };
}

async function decodeRows(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly request: DeferredJourneyEventPageQualification;
  readonly qualification: DeferredJourneyEventPageQualification["qualification"];
  readonly evidence: QualificationEnvelopeCompilationEvidence;
  readonly cursorInput: JourneyTrajectoryInput;
  readonly cursorError?: InvalidCursorError;
}): Promise<JourneyEventPageQualificationExecution> {
  const { rows, request, qualification, evidence, cursorInput, cursorError } =
    input;
  const reportFields = evidence.outputDescriptors.find(
    ({ outputId }) => outputId === JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
  )?.fields;
  if (
    !reportFields ||
    reportFields.length !== JOURNEY_EVENT_PAGE_REPORT_FIELDS.length ||
    JOURNEY_EVENT_PAGE_REPORT_FIELDS.some(
      (field) => !reportFields.includes(field),
    )
  )
    throw new Error(`${ERROR_PREFIX}_report_schema_invalid`);
  const expectedControlFields = [
    "rawCount",
    "nullActivityIdCount",
    "siteIdentityMismatchCount",
    "invalidIdentityCount",
    "duplicateIdentityCount",
    "entityKind",
    ...evidence.compatibilityFields.map(({ outputName }) => outputName),
  ];
  if (
    new Set(evidence.controlFields).size !== evidence.controlFields.length ||
    evidence.controlFields.length !== expectedControlFields.length ||
    expectedControlFields.some(
      (field) => !evidence.controlFields.includes(field),
    )
  )
    throw new Error(`${ERROR_PREFIX}_control_schema_invalid`);
  const expectedFields = [
    "rowKind",
    "outputId",
    ...reportFields,
    ...evidence.controlFields,
  ];
  if (rows.some((row) => row.rowKind !== "control" && row.rowKind !== "report"))
    throw new Error(`${ERROR_PREFIX}_envelope_kind_invalid`);
  const controlRows = rows.filter((row) => row.rowKind === "control");
  const reportRows = rows.filter((row) => row.rowKind === "report");
  if (
    controlRows.length !== 1 ||
    controlRows[0]!.outputId !== evidence.controlOutputId ||
    !exactKeys(controlRows[0]!, expectedFields) ||
    rows.length !== controlRows.length + reportRows.length
  )
    throw new Error(`${ERROR_PREFIX}_control_row_invalid`);
  const control = controlRows[0]!;
  if (
    control.entityKind !== qualification.countInput.scope ||
    reportFields.some((field) => control[field] !== null)
  )
    throw new Error(`${ERROR_PREFIX}_control_kind_mismatch`);
  for (const row of reportRows) {
    if (
      row.outputId !== JOURNEY_EVENT_PAGE_REPORT_OUTPUT ||
      !exactKeys(row, expectedFields) ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error(`${ERROR_PREFIX}_report_row_invalid`);
    if (
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      (row.kind !== "pageview" && row.kind !== "custom") ||
      typeof row.eventType !== "string" ||
      typeof row.occurredAt !== "number" ||
      !Number.isFinite(row.occurredAt)
    )
      throw new Error(`${ERROR_PREFIX}_report_identity_invalid`);
  }
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) => `${ERROR_PREFIX}_control_invalid:${field}`,
  });
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () => new Error(`${ERROR_PREFIX}_gate_violation`),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback")
    return { kind: "fallback", fallbackReason: judgment.fallbackReason };

  const target = targetFor(request);
  if (
    !(await queryJourneyTargetExistsFromD1(
      qualification.env,
      qualification.siteId,
      target,
      cursorInput.window,
    ))
  )
    throw new Error("resource-not-found");
  if (cursorError) throw cursorError;

  const mapped = reportRows.map((row) =>
    mapJourneyEventRow(
      Object.fromEntries(reportFields.map((field) => [field, row[field]])),
    ),
  );
  const page = pageResult(mapped, request.configuration.page.limit);
  const nextCursor = await encodeSiteJourneyEventPageCursor(
    cursorInput,
    request.operation,
    request.configuration.target,
    page.hasMore && page.last
      ? { occurredAt: page.last.occurredAt, id: page.last.id }
      : null,
  );
  return {
    kind: "executed",
    result: {
      items: page.rows,
      pagination: {
        limit: request.configuration.page.limit,
        returned: page.rows.length,
        hasMore: page.hasMore,
        nextCursor,
      },
    },
    evidence,
    reportRowCount: page.rows.length,
    controlRowCount: 1,
  };
}

export async function executeJourneyEventPageQualificationProgram(input: {
  readonly query: Record<string, unknown>;
  readonly deferred: DeferredJourneyEventPageQualification;
  readonly env: Env;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<JourneyEventPageQualificationExecution> {
  const { request, qualification, cursorInput, cursorError, compilation } =
    await compileProgram({ query: input.query, deferred: input.deferred });
  if (compilation.kind === "unavailable") return compilation;
  const rawRows = await executeQualificationQuery(qualification.signal, () =>
    queryD1CompiledAll<Record<string, unknown>>(
      input.env,
      compilation.query as CompiledQuery<Record<string, unknown>>,
      input.diagnostics,
    ),
  );
  const reportFields = compilation.evidence.outputDescriptors.find(
    ({ outputId }) => outputId === JOURNEY_EVENT_PAGE_REPORT_OUTPUT,
  )?.fields;
  if (!reportFields) throw new Error(`${ERROR_PREFIX}_report_schema_invalid`);
  const rows = ownRecordRows(
    rawRows,
    reportFields,
    compilation.evidence.controlFields,
  );
  return decodeRows({
    rows,
    request,
    qualification,
    evidence: compilation.evidence,
    cursorInput,
    ...(cursorError ? { cursorError } : {}),
  });
}
