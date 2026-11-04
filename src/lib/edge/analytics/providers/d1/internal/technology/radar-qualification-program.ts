import { BROWSER_VERSION_BREAKDOWN_OUTPUT } from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import { buildBrowserVersionQualificationPlan } from "@/lib/edge/analytics/engine/browser-version-qualification-plan";
import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildTechnologyRadarQualificationPlan,
  TECHNOLOGY_RADAR_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/technology-radar-qualification-plan";
import {
  TECHNOLOGY_RADAR_OUTPUTS,
  type TechnologyRadarQualificationConfiguration,
} from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import {
  type DeferredRadarQualification,
  deferredRadarQualificationFromQuery,
  isDeferredEventQualification,
  isDeferredRadarQualificationRequest,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeCompilationEvidence,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-program-runtime";
import type { Env } from "@/lib/edge/types";

const REPORT_METRICS = [
  "sessions",
  "bounces",
  "avgDurationMs",
  "avgDepth",
  "visitors",
  "returningVisitors",
  "avgFrequency",
  "trafficShare",
] as const;
const CONTROL_BASE_FIELDS = [
  "rawCount",
  "nullActivityIdCount",
  "siteIdentityMismatchCount",
  "entityKind",
  "invalidIdentityCount",
  "duplicateIdentityCount",
] as const;

const BROWSER_VERSION_REPORT_FIELDS = [
  "browser",
  "views",
  "visitors",
  "sessions",
  "browserRank",
  "version",
  "versionLabel",
  "versionViews",
  "versionVisitors",
  "versionSessions",
] as const;

export interface RadarQualificationCompilationEvidence extends QualificationEnvelopeCompilationEvidence {
  readonly configuration: TechnologyRadarQualificationConfiguration;
  readonly dimension: TechnologyRadarQualificationConfiguration["dimension"];
  readonly reportFields: readonly string[];
}

export type RadarQualificationExecution =
  | {
      readonly kind: "executed";
      readonly rows: readonly Record<string, unknown>[];
      readonly evidence: RadarQualificationCompilationEvidence;
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
    throw new Error(`radar_qualification_output:${outputId}`);
  return matches[0]!;
}

function sameConfiguration(
  left: unknown,
  right: TechnologyRadarQualificationConfiguration,
): boolean {
  if (
    !left ||
    typeof left !== "object" ||
    Array.isArray(left) ||
    (Object.getPrototypeOf(left) !== Object.prototype &&
      Object.getPrototypeOf(left) !== null)
  )
    return false;
  try {
    const keys = Reflect.ownKeys(left);
    const read = (name: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(left, name);
      return descriptor && descriptor.enumerable && "value" in descriptor
        ? descriptor.value
        : undefined;
    };
    if (right.dimension === "browser")
      return (
        keys.length === 1 &&
        keys[0] === "dimension" &&
        read("dimension") === "browser"
      );
    if (right.dimension === "referrer")
      return (
        keys.length === 2 &&
        keys.every((key) => typeof key === "string") &&
        keys.includes("dimension") &&
        keys.includes("limit") &&
        read("dimension") === "referrer" &&
        read("limit") === right.limit &&
        Number.isSafeInteger(read("limit"))
      );
    return (
      keys.length === 3 &&
      keys.every((key) => typeof key === "string") &&
      keys.includes("dimension") &&
      keys.includes("browserLimit") &&
      keys.includes("versionLimit") &&
      read("dimension") === "version" &&
      read("browserLimit") === right.browserLimit &&
      Number.isFinite(read("browserLimit")) &&
      read("versionLimit") === right.versionLimit &&
      Number.isFinite(read("versionLimit"))
    );
  } catch {
    return false;
  }
}

function verifyPlan(
  qualification: AnalyticsQualificationPlan,
  deferred: DeferredRadarQualification,
): {
  readonly report: LogicalOutput;
  readonly reports: readonly {
    readonly output: LogicalOutput;
    readonly rowType: string;
    readonly fields: readonly string[];
  }[];
  readonly controlsOutput: LogicalOutput;
  readonly reportFields: readonly string[];
  readonly controlFields: readonly string[];
} {
  const dimension = deferred.configuration.dimension;
  const outputId =
    dimension === "version"
      ? BROWSER_VERSION_BREAKDOWN_OUTPUT
      : TECHNOLOGY_RADAR_OUTPUTS[dimension];
  const reportFields =
    dimension === "version"
      ? BROWSER_VERSION_REPORT_FIELDS
      : [dimension, ...REPORT_METRICS];
  if (
    qualification.scope !== deferred.qualification.countInput.scope ||
    (qualification.scope !== "session" && qualification.scope !== "visitor") ||
    qualification.controlOutputId !==
      TECHNOLOGY_RADAR_QUALIFICATION_CONTROL_OUTPUT ||
    qualification.reportOutputIds.length !== 1 ||
    qualification.reportOutputIds[0] !== outputId ||
    qualification.reportSourceRelations.length !== 1 ||
    qualification.reportSourceRelations[0]?.entity !== "page" ||
    !qualification.primaryReportSourceRelationId
  )
    throw new Error("radar_qualification_plan_identity_invalid");

  const report = exactOutput(qualification.plan.outputs, outputId);
  if (
    report.fields.length !== reportFields.length ||
    report.fields.some((field, index) => field.name !== reportFields[index])
  )
    throw new Error(`radar_qualification_schema:${outputId}`);
  const controlsOutput = exactOutput(
    qualification.plan.outputs,
    qualification.controlOutputId,
  );
  const controlFields = controlsOutput.fields.map(({ name }) => name);
  const expectedControlFields = [
    ...CONTROL_BASE_FIELDS,
    ...qualification.numericCompatibilityFields.map(
      ({ invalidCountOutput }) => invalidCountOutput,
    ),
  ];
  if (
    new Set(controlFields).size !== controlFields.length ||
    controlFields.length !== expectedControlFields.length ||
    expectedControlFields.some((field) => !controlFields.includes(field))
  )
    throw new Error("radar_qualification_controls_invalid");
  return {
    report,
    reports: [{ output: report, rowType: "radar", fields: reportFields }],
    controlsOutput,
    reportFields,
    controlFields,
  };
}

function compileProgram(input: {
  readonly deferred: DeferredRadarQualification;
  readonly query: unknown;
  readonly configuration: TechnologyRadarQualificationConfiguration;
}) {
  if (
    !isDeferredRadarQualificationRequest(input.deferred) ||
    deferredRadarQualificationFromQuery(input.query) !== input.deferred ||
    !Object.isFrozen(input.deferred) ||
    !Object.isFrozen(input.deferred.configuration) ||
    !sameConfiguration(input.configuration, input.deferred.configuration) ||
    !isDeferredEventQualification(input.deferred.qualification) ||
    input.deferred.operation !== "radar" ||
    input.deferred.qualification.operation !== "radar"
  )
    throw new Error("radar_qualification_request_untrusted");
  const { deferred, configuration } = input;
  const qualification =
    configuration.dimension === "version"
      ? buildBrowserVersionQualificationPlan({
          browserLimit: configuration.browserLimit,
          siteId: deferred.qualification.siteId,
          queryTime: deferred.qualification.requestTime,
          filters: deferred.qualification.filters,
          ...(deferred.qualification.technologyFilterMode ===
          "allow-whole-filter"
            ? { filterMode: "allow-whole-filter" as const }
            : {}),
          scopePlan: deferred.qualification.metadata.plan,
          count: deferred.qualification.countInput,
        })
      : buildTechnologyRadarQualificationPlan({
          configuration,
          siteId: deferred.qualification.siteId,
          queryTime: deferred.qualification.requestTime,
          filters: deferred.qualification.filters,
          ...(deferred.qualification.technologyFilterMode ===
          "allow-whole-filter"
            ? { filterMode: "allow-whole-filter" as const }
            : {}),
          scopePlan: deferred.qualification.metadata.plan,
          count: deferred.qualification.countInput,
        });
  const verified = verifyPlan(qualification, deferred);
  const dimension = configuration.dimension;
  const ordering =
    dimension === "version"
      ? ([
          { field: "browserRank", direction: "asc", nulls: "last" },
          { field: "versionVisitors", direction: "desc", nulls: "last" },
          { field: "versionViews", direction: "desc", nulls: "last" },
          { field: "versionSessions", direction: "desc", nulls: "last" },
          { field: "version", direction: "asc", nulls: "first" },
        ] as const)
      : dimension === "browser"
        ? ([{ field: "visitors", direction: "desc", nulls: "last" }] as const)
        : ([
            { field: "visitors", direction: "desc", nulls: "last" },
            { field: "sessions", direction: "desc", nulls: "last" },
            { field: "referrer", direction: "asc", nulls: "first" },
          ] as const);
  const compilation = compileQualificationProgramEnvelope({
    qualification,
    siteId: deferred.qualification.siteId,
    reports: verified.reports,
    controlsOutput: verified.controlsOutput,
    reportFields: verified.reportFields,
    controlFields: verified.controlFields,
    ordering,
    errorPrefix: "radar_qualification",
    fallbackTag: "analytics.radar_qualification",
    signal: deferred.qualification.signal,
  });
  if (compilation.kind === "unavailable") return compilation;
  return {
    ...compilation,
    evidence: Object.freeze({
      ...compilation.evidence,
      configuration,
      dimension,
      reportFields: Object.freeze([...verified.reportFields]),
    }),
  };
}

/** Exposes compile evidence for statement admission and native shape checks. */
export function compileRadarQualificationProgram(input: {
  readonly deferred: DeferredRadarQualification;
  readonly query: unknown;
  readonly configuration: TechnologyRadarQualificationConfiguration;
}) {
  return compileProgram(input);
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

function decodeRows(
  rows: readonly Record<string, unknown>[],
  deferred: DeferredRadarQualification,
  evidence: RadarQualificationCompilationEvidence,
): RadarQualificationExecution {
  const envelopeFields = [
    "rowKind",
    "outputId",
    ...evidence.reportFields,
    ...evidence.controlFields,
  ];
  const controlRows = rows.filter((row) => row.rowKind === "control");
  const reportRows = rows.filter((row) => row.rowKind === "report");
  if (
    controlRows.length !== 1 ||
    rows.length !== controlRows.length + reportRows.length ||
    !exactRowKeys(controlRows[0]!, envelopeFields) ||
    controlRows[0]!.outputId !== evidence.controlOutputId
  )
    throw new Error("radar_qualification_control_row_invalid");
  const control = controlRows[0]!;
  if (
    control.entityKind !== deferred.qualification.countInput.scope ||
    evidence.reportFields.some((field) => control[field] !== null)
  )
    throw new Error("radar_qualification_control_kind_mismatch");
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) => `radar_qualification_control_invalid:${field}`,
  });
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () => new Error("radar_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback")
    return { kind: "fallback", fallbackReason: judgment.fallbackReason };

  const outputId =
    evidence.dimension === "version"
      ? BROWSER_VERSION_BREAKDOWN_OUTPUT
      : TECHNOLOGY_RADAR_OUTPUTS[evidence.dimension];
  const dimensionField =
    evidence.dimension === "version" ? "browser" : evidence.dimension;
  const seenDimensions = new Set<string>();
  const decodedRows: Record<string, unknown>[] = [];
  for (const row of reportRows) {
    if (
      !exactRowKeys(row, envelopeFields) ||
      row.outputId !== outputId ||
      evidence.controlFields.some((field) => row[field] !== null) ||
      typeof row[dimensionField] !== "string" ||
      (evidence.dimension === "version" && typeof row.version !== "string")
    )
      throw new Error("radar_qualification_report_row_invalid");
    const label =
      evidence.dimension === "version"
        ? JSON.stringify([row.browser, row.version])
        : (row[dimensionField] as string);
    if (seenDimensions.has(label))
      throw new Error("radar_qualification_report_duplicate_dimension");
    seenDimensions.add(label);
    decodedRows.push(
      Object.fromEntries(
        evidence.reportFields.map((field) => [field, row[field]]),
      ),
    );
  }
  return { kind: "executed", rows: Object.freeze(decodedRows), evidence };
}

export async function executeRadarQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredRadarQualification;
  readonly query: unknown;
  readonly configuration: TechnologyRadarQualificationConfiguration;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<RadarQualificationExecution> {
  const compilation = compileProgram(input);
  if (compilation.kind === "unavailable") {
    if (input.diagnostics)
      input.diagnostics.advancedCountSqlFallbackReason =
        compilation.fallbackReason;
    return compilation;
  }
  const rows = await executeQualificationQuery(
    input.deferred.qualification.signal,
    () =>
      queryD1CompiledAll<Record<string, unknown>>(
        input.env,
        compilation.query,
        input.diagnostics,
      ),
  );
  const execution = decodeRows(rows, input.deferred, compilation.evidence);
  if (execution.kind === "fallback" && input.diagnostics)
    input.diagnostics.advancedCountSqlFallbackReason = execution.fallbackReason;
  return execution;
}
