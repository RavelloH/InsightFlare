import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import { TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS } from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import {
  buildTechnologyBrowserCrossQualificationPlan,
  buildTechnologyCrossQualificationPlan,
  sameTechnologyCrossQualificationConfiguration,
  TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS,
  TECHNOLOGY_BROWSER_CROSS_QUALIFICATION_CONTROL_OUTPUT,
  TECHNOLOGY_CROSS_QUALIFICATION_CONTROL_OUTPUT,
  type TechnologyCrossDimensionQualificationConfiguration,
  type TechnologyCrossQualificationConfiguration,
} from "@/lib/edge/analytics/engine/technology-cross-qualification-plan";
import {
  type DeferredCrossDimensionQualification,
  deferredCrossDimensionQualificationFromQuery,
  isDeferredCrossDimensionQualificationRequest,
  isDeferredEventQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  compileQualificationProgramEnvelope,
  type QualificationEnvelopeCompilationEvidence,
  type QualificationEnvelopeReportDescriptor,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-program-envelope";
import {
  decodeQualificationControl,
  executeQualificationQuery,
  judgeQualificationControl,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-program-runtime";
import type { Env } from "@/lib/edge/types";

const GENERIC_FIELDS = [
  "rowType",
  "primaryValue",
  "secondaryValue",
  "views",
  "visitors",
  "sessions",
  "rowOrder",
] as const;
const BROWSER_FIELDS = [
  "rowType",
  "browser",
  "dimension",
  "views",
  "visitors",
  "sessions",
  "rowOrder",
] as const;
const CONTROL_BASE_FIELDS = [
  "rawCount",
  "nullActivityIdCount",
  "siteIdentityMismatchCount",
  "entityKind",
  "invalidIdentityCount",
  "duplicateIdentityCount",
] as const;

interface OutputDescriptor {
  readonly outputId: string;
  readonly rowType: string;
  readonly fields: readonly string[];
}

export interface CrossQualificationCompilationEvidence extends QualificationEnvelopeCompilationEvidence {
  readonly family: "generic" | "browser";
  readonly configuration: TechnologyCrossQualificationConfiguration;
  readonly reportFields: readonly string[];
}

export type CrossQualificationExecution =
  | {
      readonly kind: "executed";
      readonly rows: readonly Record<string, unknown>[];
      readonly evidence: CrossQualificationCompilationEvidence;
    }
  | {
      readonly kind: "browser-executed";
      readonly operatingSystemRows: readonly Record<string, unknown>[];
      readonly deviceTypeRows: readonly Record<string, unknown>[];
      readonly evidence: CrossQualificationCompilationEvidence;
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
    throw new Error("cross_dimension_qualification_output:" + outputId);
  return matches[0]!;
}

function verifyPlan(
  qualification: AnalyticsQualificationPlan,
  deferred: DeferredCrossDimensionQualification,
  descriptors: readonly OutputDescriptor[],
  controlOutputId: string,
): {
  readonly reports: readonly QualificationEnvelopeReportDescriptor[];
  readonly controlsOutput: LogicalOutput;
  readonly controlFields: readonly string[];
} {
  if (
    qualification.scope !== deferred.qualification.countInput.scope ||
    (qualification.scope !== "session" && qualification.scope !== "visitor") ||
    qualification.controlOutputId !== controlOutputId ||
    qualification.reportOutputIds.length !== descriptors.length ||
    qualification.reportOutputIds.some(
      (id, index) => id !== descriptors[index]?.outputId,
    ) ||
    qualification.reportSourceRelations.length !== 1 ||
    qualification.reportSourceRelations[0]?.entity !== "page" ||
    qualification.reportSourceRelations[0]?.relationId !==
      qualification.primaryReportSourceRelationId
  )
    throw new Error("cross_dimension_qualification_plan_identity_invalid");

  const reports = descriptors.map((descriptor) => {
    const output = exactOutput(qualification.plan.outputs, descriptor.outputId);
    if (
      output.fields.length !== descriptor.fields.length ||
      output.fields.some(
        (field, index) => field.name !== descriptor.fields[index],
      )
    )
      throw new Error(
        "cross_dimension_qualification_schema:" + descriptor.outputId,
      );
    return { output, rowType: descriptor.rowType, fields: descriptor.fields };
  });
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
    throw new Error("cross_dimension_qualification_controls_invalid");
  return { reports, controlsOutput, controlFields };
}

function genericDescriptors(): readonly OutputDescriptor[] {
  return [
    {
      outputId: TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS.primary,
      rowType: "primary",
      fields: GENERIC_FIELDS,
    },
    {
      outputId: TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS.secondary,
      rowType: "secondary",
      fields: GENERIC_FIELDS,
    },
    {
      outputId: TECHNOLOGY_CROSS_BREAKDOWN_OUTPUTS.pairs,
      rowType: "pair",
      fields: GENERIC_FIELDS,
    },
  ];
}

function browserDescriptors(): readonly OutputDescriptor[] {
  const outputs = TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS;
  return [
    {
      outputId: outputs.operatingSystem.primary,
      rowType: "browser",
      fields: BROWSER_FIELDS,
    },
    {
      outputId: outputs.operatingSystem.secondary,
      rowType: "dimension",
      fields: BROWSER_FIELDS,
    },
    {
      outputId: outputs.operatingSystem.pairs,
      rowType: "pair",
      fields: BROWSER_FIELDS,
    },
    {
      outputId: outputs.deviceType.primary,
      rowType: "browser",
      fields: BROWSER_FIELDS,
    },
    {
      outputId: outputs.deviceType.secondary,
      rowType: "dimension",
      fields: BROWSER_FIELDS,
    },
    {
      outputId: outputs.deviceType.pairs,
      rowType: "pair",
      fields: BROWSER_FIELDS,
    },
  ];
}

function compileProgram(input: {
  readonly deferred: DeferredCrossDimensionQualification;
  readonly query: unknown;
  readonly configuration: TechnologyCrossQualificationConfiguration;
}) {
  if (
    !isDeferredCrossDimensionQualificationRequest(input.deferred) ||
    deferredCrossDimensionQualificationFromQuery(input.query) !==
      input.deferred ||
    !Object.isFrozen(input.deferred) ||
    !Object.isFrozen(input.deferred.configuration) ||
    !sameTechnologyCrossQualificationConfiguration(
      input.configuration,
      input.deferred.configuration,
    ) ||
    !isDeferredEventQualification(input.deferred.qualification) ||
    input.deferred.operation !== "cross-dimension" ||
    input.deferred.qualification.operation !== "cross-dimension"
  )
    throw new Error("cross_dimension_qualification_request_untrusted");

  const deferred = input.deferred;
  const configuration = deferred.configuration;
  const browser =
    "family" in configuration && configuration.family === "browser";
  const descriptors = browser ? browserDescriptors() : genericDescriptors();
  const controlOutputId = browser
    ? TECHNOLOGY_BROWSER_CROSS_QUALIFICATION_CONTROL_OUTPUT
    : TECHNOLOGY_CROSS_QUALIFICATION_CONTROL_OUTPUT;
  const qualification = browser
    ? buildTechnologyBrowserCrossQualificationPlan({
        configuration: configuration as Extract<
          TechnologyCrossQualificationConfiguration,
          { family: "browser" }
        >,
        siteId: deferred.qualification.siteId,
        queryTime: deferred.qualification.requestTime,
        filters: deferred.qualification.filters,
        ...(deferred.qualification.technologyFilterMode === "allow-whole-filter"
          ? { filterMode: "allow-whole-filter" as const }
          : {}),
        scopePlan: deferred.qualification.metadata.plan,
        count: deferred.qualification.countInput,
      })
    : buildTechnologyCrossQualificationPlan({
        configuration:
          configuration as TechnologyCrossDimensionQualificationConfiguration,
        siteId: deferred.qualification.siteId,
        queryTime: deferred.qualification.requestTime,
        filters: deferred.qualification.filters,
        ...(deferred.qualification.technologyFilterMode === "allow-whole-filter"
          ? { filterMode: "allow-whole-filter" as const }
          : {}),
        scopePlan: deferred.qualification.metadata.plan,
        count: deferred.qualification.countInput,
      });
  const verified = verifyPlan(
    qualification,
    deferred,
    descriptors,
    controlOutputId,
  );
  const reportFields = browser ? BROWSER_FIELDS : GENERIC_FIELDS;
  const compilation = compileQualificationProgramEnvelope({
    qualification,
    siteId: deferred.qualification.siteId,
    reports: verified.reports,
    controlsOutput: verified.controlsOutput,
    reportFields,
    controlFields: verified.controlFields,
    ordering: browser
      ? [
          { field: "rowType", direction: "asc", nulls: "first" },
          { field: "rowOrder", direction: "asc", nulls: "first" },
          { field: "browser", direction: "asc", nulls: "first" },
          { field: "dimension", direction: "asc", nulls: "first" },
        ]
      : [
          { field: "rowType", direction: "asc", nulls: "first" },
          { field: "rowOrder", direction: "asc", nulls: "first" },
          { field: "primaryValue", direction: "asc", nulls: "first" },
          { field: "secondaryValue", direction: "asc", nulls: "first" },
        ],
    errorPrefix: "cross_dimension_qualification",
    fallbackTag: "analytics.cross_dimension_qualification",
    signal: deferred.qualification.signal,
  });
  if (compilation.kind === "unavailable") return compilation;
  return {
    ...compilation,
    evidence: Object.freeze({
      ...compilation.evidence,
      family: browser ? ("browser" as const) : ("generic" as const),
      configuration,
      reportFields: Object.freeze([...reportFields]),
    }),
  };
}

/** Exposes compile evidence for statement admission and native shape checks. */
export function compileCrossQualificationProgram(input: {
  readonly deferred: DeferredCrossDimensionQualification;
  readonly query: unknown;
  readonly configuration: TechnologyCrossQualificationConfiguration;
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
  deferred: DeferredCrossDimensionQualification,
  evidence: CrossQualificationCompilationEvidence,
): CrossQualificationExecution {
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
    throw new Error("cross_dimension_qualification_control_row_invalid");

  const control = controlRows[0]!;
  if (
    control.entityKind !== deferred.qualification.countInput.scope ||
    evidence.reportFields.some((field) => control[field] !== null)
  )
    throw new Error("cross_dimension_qualification_control_kind_mismatch");
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) =>
      "cross_dimension_qualification_control_invalid:" + field,
  });
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () =>
      new Error("cross_dimension_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback")
    return { kind: "fallback", fallbackReason: judgment.fallbackReason };

  const descriptors = new Map(
    evidence.outputDescriptors.map((descriptor) => [
      descriptor.outputId,
      descriptor,
    ]),
  );
  const genericRows: Record<string, unknown>[] = [];
  const operatingSystemRows: Record<string, unknown>[] = [];
  const deviceTypeRows: Record<string, unknown>[] = [];
  for (const row of reportRows) {
    const descriptor = descriptors.get(String(row.outputId));
    if (
      !exactRowKeys(row, envelopeFields) ||
      !descriptor ||
      row.rowType !== descriptor.rowType ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error("cross_dimension_qualification_report_row_invalid");

    if (evidence.family === "generic") {
      const valid =
        (descriptor.rowType === "primary" &&
          typeof row.primaryValue === "string" &&
          row.secondaryValue === null &&
          Number.isSafeInteger(row.rowOrder) &&
          Number(row.rowOrder) >= 1) ||
        (descriptor.rowType === "secondary" &&
          row.primaryValue === null &&
          typeof row.secondaryValue === "string" &&
          Number.isSafeInteger(row.rowOrder) &&
          Number(row.rowOrder) >= 1) ||
        (descriptor.rowType === "pair" &&
          typeof row.primaryValue === "string" &&
          typeof row.secondaryValue === "string" &&
          row.rowOrder === 0);
      if (!valid)
        throw new Error("cross_dimension_qualification_report_row_invalid");
      genericRows.push(
        Object.fromEntries(
          evidence.reportFields.map((field) => [field, row[field]]),
        ),
      );
      continue;
    }

    const valid =
      (descriptor.rowType === "browser" &&
        typeof row.browser === "string" &&
        row.dimension === null &&
        Number.isSafeInteger(row.rowOrder) &&
        Number(row.rowOrder) >= 1) ||
      (descriptor.rowType === "dimension" &&
        row.browser === null &&
        typeof row.dimension === "string" &&
        Number.isSafeInteger(row.rowOrder) &&
        Number(row.rowOrder) >= 1) ||
      (descriptor.rowType === "pair" &&
        typeof row.browser === "string" &&
        typeof row.dimension === "string" &&
        row.rowOrder === 0);
    if (!valid)
      throw new Error("cross_dimension_qualification_report_row_invalid");

    const decoded = Object.fromEntries(
      evidence.reportFields.map((field) => [field, row[field]]),
    );
    const outputId = descriptor.outputId;
    if (
      outputId ===
        TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.operatingSystem.primary ||
      outputId ===
        TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.operatingSystem.secondary ||
      outputId ===
        TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.operatingSystem.pairs
    )
      operatingSystemRows.push(decoded);
    else if (
      outputId ===
        TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.deviceType.primary ||
      outputId ===
        TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.deviceType.secondary ||
      outputId === TECHNOLOGY_BROWSER_CROSS_BREAKDOWN_OUTPUTS.deviceType.pairs
    )
      deviceTypeRows.push(decoded);
    else throw new Error("cross_dimension_qualification_report_row_invalid");
  }

  if (evidence.family === "browser")
    return {
      kind: "browser-executed",
      operatingSystemRows: Object.freeze(operatingSystemRows),
      deviceTypeRows: Object.freeze(deviceTypeRows),
      evidence,
    };
  return { kind: "executed", rows: Object.freeze(genericRows), evidence };
}

export async function executeCrossQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredCrossDimensionQualification;
  readonly query: unknown;
  readonly configuration: TechnologyCrossQualificationConfiguration;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<CrossQualificationExecution> {
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
