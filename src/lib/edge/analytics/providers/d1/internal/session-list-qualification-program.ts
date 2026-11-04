import { parseGoalFilter } from "@/lib/edge/analytics/contract";
import { JOURNEY_SESSION_LIST_REPORT_OUTPUT } from "@/lib/edge/analytics/engine/journey-entity-list-report-plan";
import {
  buildJourneySessionFunnelListQualificationPlan,
  buildJourneySessionGoalListQualificationPlan,
  buildJourneySessionListQualificationPlan,
} from "@/lib/edge/analytics/engine/journey-session-list-qualification-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import { PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT } from "@/lib/edge/analytics/engine/page-dimension-qualification-plan";
import {
  deferredEventQualificationFromQuery,
  isDeferredEventQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  decodeSiteSessionListCursor,
  decodeSiteVisitorSessionsCursor,
  encodeSiteSessionListCursor,
  encodeSiteVisitorSessionsCursor,
  type JourneySearchInput,
  resolveJourneyListAnalysis,
} from "@/lib/edge/analytics/providers/d1/operations/site-journeys";
import type { Env } from "@/lib/edge/types";

import type { QueryWindow } from "./core";
import { queryD1CompiledAll } from "./core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import { queryGoalDefinition } from "./goals";
import {
  type JourneyListAnalysis,
  queryJourneyTargetExistsFromD1,
  type SessionListCursor,
  sessionListPageFromRecords,
} from "./journey-list-queries";
import { InvalidCursorError } from "./pagination";
import type { QualificationEnvelopeCompilationEvidence } from "./qualification-program-envelope";
import { compileQualificationProgramEnvelope } from "./qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "./qualification-program-runtime";
import type {
  DeferredSessionListQualification,
  SessionListQualificationConfiguration,
} from "./session-list-qualification-request";
import {
  assertSessionListQualificationRequest,
  deferredSessionListQualificationFromQuery,
} from "./session-list-qualification-request";

const ERROR_PREFIX = "session_list_qualification";
const SESSION_REPORT_FIELDS = [
  "sessionId",
  "visitorId",
  "userId",
  "userName",
  "startedAt",
  "endedAt",
  "totalDurationMs",
  "active",
  "views",
  "events",
  "bounce",
  "entryPath",
  "exitPath",
  "referrerHost",
  "referrerUrl",
  "country",
  "region",
  "regionCode",
  "city",
  "latitude",
  "longitude",
  "browser",
  "browserVersion",
  "os",
  "osVersion",
  "deviceType",
  "screenWidth",
  "screenHeight",
] as const;

export type SessionListQualificationExecution =
  | {
      readonly kind: "executed";
      readonly result: {
        readonly items: ReturnType<typeof sessionListPageFromRecords>["rows"];
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
      readonly resolvedAnalysis?: JourneyListAnalysis;
      readonly postFallbackError?: { readonly error: unknown };
    };

function requestWindow(time: {
  readonly range: { readonly startMs: number; readonly endExclusiveMs: number };
  readonly capturedAtMs: number;
  readonly reportingTimeZone: string;
}): QueryWindow {
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
): boolean {
  const keys = Reflect.ownKeys(value);
  const required = [...expected].sort();
  return (
    keys.length === required.length &&
    keys.every((key) => typeof key === "string") &&
    [...keys].sort().every((key, index) => key === required[index]) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor;
    })
  );
}

function configurationSort(
  configuration: SessionListQualificationConfiguration,
) {
  return {
    key: configuration.sort.field,
    direction: configuration.sort.direction,
  } as const;
}

function configurationCursorSort(
  configuration: SessionListQualificationConfiguration,
) {
  return {
    field: configuration.sort.field,
    direction: configuration.sort.direction,
  } as const;
}

function listInput(input: {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: DeferredSessionListQualification["qualification"]["filters"];
  readonly configuration: SessionListQualificationConfiguration;
}): JourneySearchInput & { readonly visitorId?: string } {
  return {
    env: input.env,
    siteId: input.siteId,
    window: input.window,
    filters: input.filters,
    search: input.configuration.search,
    page: input.configuration.page,
    audience: input.configuration.audience,
    ...(input.configuration.analysisContext
      ? { analysisContext: input.configuration.analysisContext }
      : {}),
    ...(input.configuration.visitorId
      ? { visitorId: input.configuration.visitorId }
      : {}),
  };
}

async function compileProgram(input: {
  readonly query: Record<string, unknown>;
  readonly deferred: DeferredSessionListQualification;
}) {
  const request = assertSessionListQualificationRequest(
    input.deferred,
    input.query,
  );
  const qualification = request.qualification;
  if (
    !isDeferredEventQualification(qualification) ||
    qualification.operation !== request.operation ||
    deferredEventQualificationFromQuery(input.query, request.operation) !==
      qualification ||
    deferredSessionListQualificationFromQuery(input.query) !== request
  )
    throw new Error(`${ERROR_PREFIX}_request_invalid`);

  const window = requestWindow(qualification.requestTime);
  const cursorInput = listInput({
    env: qualification.env,
    siteId: qualification.siteId,
    window,
    filters: qualification.filters,
    configuration: request.configuration,
  });
  let cursor: SessionListCursor | null = null;
  let cursorError: InvalidCursorError | undefined;
  try {
    if (request.operation === "visitor-sessions") {
      if (!request.configuration.visitorId)
        throw new Error(`${ERROR_PREFIX}_request_target_invalid`);
      cursor = await decodeSiteVisitorSessionsCursor({
        ...cursorInput,
        visitorId: request.configuration.visitorId,
      });
    } else {
      cursor = await decodeSiteSessionListCursor(
        cursorInput,
        configurationCursorSort(request.configuration),
      );
    }
  } catch (error) {
    if (!(error instanceof InvalidCursorError)) throw error;
    cursorError = error;
  }

  let resolvedAnalysis: JourneyListAnalysis | undefined;
  let postFallbackError: { readonly error: unknown } | undefined;
  const analysisContext = request.configuration.analysisContext;
  if (analysisContext?.type === "goal") {
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    try {
      const goal = await queryGoalDefinition(
        qualification.env,
        qualification.siteId,
        analysisContext.goalId,
      );
      if (!goal) throw new Error("resource-not-found");
      resolvedAnalysis = { type: "goal", filter: parseGoalFilter(goal) };
    } catch (error) {
      if (qualification.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      postFallbackError = { error };
    }
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
  } else if (analysisContext?.type === "funnel") {
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    try {
      resolvedAnalysis = await resolveJourneyListAnalysis(
        cursorInput,
        "session",
      );
    } catch (error) {
      if (qualification.signal?.aborted)
        throw new DOMException("Aborted", "AbortError");
      postFallbackError = { error };
    }
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
  }

  const planInput = {
    siteId: qualification.siteId,
    queryTime: qualification.requestTime,
    filters: qualification.filters,
    scopePlan: qualification.metadata.plan,
    count: qualification.countInput,
    limit: request.configuration.page.limit,
    sort: configurationSort(request.configuration),
    search: request.configuration.search,
    cursor,
    preparedPlanOperation: request.operation,
    ...(request.operation === "visitor-sessions"
      ? {
          sessionTarget: {
            type: "visitor" as const,
            value: request.configuration.visitorId!,
          },
        }
      : {}),
  };
  const suppressReportRows = cursorError !== undefined || postFallbackError;
  const plan =
    resolvedAnalysis?.type === "goal"
      ? buildJourneySessionGoalListQualificationPlan({
          ...planInput,
          analysisFilter: resolvedAnalysis.filter,
          ...(suppressReportRows ? { suppressReportRows: true } : {}),
        })
      : resolvedAnalysis?.type === "funnel"
        ? buildJourneySessionFunnelListQualificationPlan({
            ...planInput,
            funnelAnalysis: {
              config: resolvedAnalysis.config,
              stepIndex: resolvedAnalysis.stepIndex,
              ...(resolvedAnalysis.outcome
                ? { outcome: resolvedAnalysis.outcome }
                : {}),
            },
            ...(suppressReportRows ? { suppressReportRows: true } : {}),
          })
        : buildJourneySessionListQualificationPlan({
            ...planInput,
            ...(suppressReportRows ? { suppressReportRows: true } : {}),
          });
  const report = exactOutput(
    plan.plan.outputs,
    JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  );
  const controls = exactOutput(
    plan.plan.outputs,
    PAGE_DIMENSION_QUALIFICATION_CONTROL_OUTPUT,
  );
  const ordering = [
    {
      outputId: JOURNEY_SESSION_LIST_REPORT_OUTPUT,
      field:
        request.configuration.sort.field === "durationMs"
          ? "totalDurationMs"
          : request.configuration.sort.field,
      direction: request.configuration.sort.direction,
      nulls: "last" as const,
    },
    ...(request.configuration.sort.field === "startedAt"
      ? []
      : [
          {
            outputId: JOURNEY_SESSION_LIST_REPORT_OUTPUT,
            field: "startedAt",
            direction: "desc" as const,
            nulls: "last" as const,
          },
        ]),
    {
      outputId: JOURNEY_SESSION_LIST_REPORT_OUTPUT,
      field: "sessionId",
      direction: "asc" as const,
      nulls: "last" as const,
    },
  ];
  const compilation = compileQualificationProgramEnvelope({
    qualification: plan,
    siteId: qualification.siteId,
    reports: [
      {
        output: report,
        fields: report.fields.map(({ name }) => name),
        rowType: "session-list",
      },
    ],
    controlsOutput: controls,
    reportFields: report.fields.map(({ name }) => name),
    controlFields: controls.fields.map(({ name }) => name),
    ordering,
    errorPrefix: ERROR_PREFIX,
    fallbackTag: "analytics.session_list_qualification",
    signal: qualification.signal,
  });
  return {
    request,
    qualification,
    cursorInput,
    cursorError,
    resolvedAnalysis,
    postFallbackError,
    compilation,
  };
}

async function decodeRows(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly request: DeferredSessionListQualification;
  readonly qualification: DeferredSessionListQualification["qualification"];
  readonly evidence: QualificationEnvelopeCompilationEvidence;
  readonly cursorInput: JourneySearchInput & { readonly visitorId?: string };
  readonly cursorError?: InvalidCursorError;
  readonly resolvedAnalysis?: JourneyListAnalysis;
  readonly postFallbackError?: { readonly error: unknown };
}): Promise<SessionListQualificationExecution> {
  const {
    rows,
    request,
    qualification,
    evidence,
    cursorInput,
    cursorError,
    resolvedAnalysis,
    postFallbackError,
  } = input;
  const reportFields = evidence.outputDescriptors.find(
    ({ outputId }) => outputId === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
  )?.fields;
  if (
    !reportFields ||
    reportFields.length !== SESSION_REPORT_FIELDS.length ||
    SESSION_REPORT_FIELDS.some((field) => !reportFields.includes(field))
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
  if (
    controlRows.length !== 1 ||
    controlRows[0]!.outputId !== evidence.controlOutputId ||
    !exactKeys(controlRows[0]!, expectedFields)
  )
    throw new Error(`${ERROR_PREFIX}_control_row_invalid`);
  const control = controlRows[0]!;
  const reportRows = rows.filter((row) => row.rowKind === "report");
  if (rows.length !== controlRows.length + reportRows.length)
    throw new Error(`${ERROR_PREFIX}_envelope_kind_invalid`);
  if (
    control.entityKind !== qualification.countInput.scope ||
    reportFields.some((field) => control[field] !== null)
  )
    throw new Error(`${ERROR_PREFIX}_control_kind_mismatch`);
  const sessionIds = new Set<string>();
  for (const row of reportRows) {
    if (
      row.outputId !== JOURNEY_SESSION_LIST_REPORT_OUTPUT ||
      !exactKeys(row, expectedFields) ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error(`${ERROR_PREFIX}_report_row_invalid`);
    if (
      typeof row.sessionId !== "string" ||
      row.sessionId.length === 0 ||
      sessionIds.has(row.sessionId)
    )
      throw new Error(`${ERROR_PREFIX}_report_identity_invalid`);
    sessionIds.add(row.sessionId);
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
    return {
      kind: "fallback",
      fallbackReason: judgment.fallbackReason,
      ...(resolvedAnalysis ? { resolvedAnalysis } : {}),
      ...(postFallbackError ? { postFallbackError } : {}),
    };
  if (request.operation === "visitor-sessions") {
    const visitorId = request.configuration.visitorId;
    if (!visitorId) throw new Error(`${ERROR_PREFIX}_request_target_invalid`);
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
    if (
      !(await queryJourneyTargetExistsFromD1(
        qualification.env,
        qualification.siteId,
        { type: "visitor", value: visitorId },
        requestWindow(qualification.requestTime),
      ))
    )
      throw new Error("resource-not-found");
    if (qualification.signal?.aborted)
      throw new DOMException("Aborted", "AbortError");
  }
  if (postFallbackError) throw postFallbackError.error;
  if (cursorError) throw cursorError;

  const validRows = reportRows.map((row) =>
    Object.fromEntries(reportFields.map((field) => [field, row[field]])),
  );
  const page = sessionListPageFromRecords(
    validRows,
    request.configuration.page.limit,
    configurationSort(request.configuration),
  );
  const nextCursor =
    request.operation === "visitor-sessions"
      ? await encodeSiteVisitorSessionsCursor(
          {
            ...cursorInput,
            visitorId: request.configuration.visitorId!,
          },
          page.nextCursor,
        )
      : await encodeSiteSessionListCursor(
          cursorInput,
          configurationCursorSort(request.configuration),
          page.nextCursor,
        );
  return {
    kind: "executed",
    result: {
      items: page.rows,
      pagination: {
        limit: request.configuration.page.limit,
        returned: page.rows.length,
        hasMore: page.nextCursor !== null,
        nextCursor,
      },
    },
    evidence,
    reportRowCount: page.rows.length,
    controlRowCount: 1,
  };
}

export async function executeSessionListQualificationProgram(input: {
  readonly query: Record<string, unknown>;
  readonly deferred: DeferredSessionListQualification;
  readonly env: Env;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<SessionListQualificationExecution> {
  const {
    request,
    qualification,
    cursorInput,
    cursorError,
    resolvedAnalysis,
    postFallbackError,
    compilation,
  } = await compileProgram({
    query: input.query,
    deferred: input.deferred,
  });
  if (compilation.kind === "unavailable")
    return {
      ...compilation,
      ...(resolvedAnalysis ? { resolvedAnalysis } : {}),
      ...(postFallbackError ? { postFallbackError } : {}),
    };
  const rawRows = await executeQualificationQuery(qualification.signal, () =>
    queryD1CompiledAll<Record<string, unknown>>(
      input.env,
      compilation.query,
      input.diagnostics,
    ),
  );
  const reportFields = compilation.evidence.outputDescriptors.find(
    ({ outputId }) => outputId === JOURNEY_SESSION_LIST_REPORT_OUTPUT,
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
    ...(resolvedAnalysis ? { resolvedAnalysis } : {}),
    ...(postFallbackError ? { postFallbackError } : {}),
  });
}
