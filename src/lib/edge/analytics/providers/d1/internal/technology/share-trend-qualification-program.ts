import type { AnalyticsQualificationPlan } from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import {
  buildTechnologyShareTrendQualificationPlan,
  TECHNOLOGY_SHARE_TREND_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/technology-share-trend-qualification-plan";
import {
  TECHNOLOGY_SHARE_TREND_OUTPUTS,
  type TechnologyShareTrendQualificationConfiguration,
} from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import {
  type DeferredShareTrendQualification,
  deferredShareTrendQualificationFromQuery,
  isDeferredEventQualification,
  isDeferredShareTrendQualificationRequest,
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

const REPORT_FIELDS = [
  "trendKind",
  "rowType",
  "bucket",
  "label",
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

type OutputKind = "single" | "source" | "channel";
type OutputRowType = "top" | "series" | "bucket";

interface ShareTrendOutputDescriptor {
  readonly outputId: string;
  readonly trendKind: OutputKind;
  readonly rowType: OutputRowType;
  readonly fields: typeof REPORT_FIELDS;
}

export interface ShareTrendQualificationCompilationEvidence extends QualificationEnvelopeCompilationEvidence {
  readonly configuration: TechnologyShareTrendQualificationConfiguration;
  readonly descriptors: readonly ShareTrendOutputDescriptor[];
}

export type ShareTrendQualificationExecution =
  | {
      readonly kind: "executed";
      readonly rows: readonly Record<string, unknown>[];
      readonly evidence: ShareTrendQualificationCompilationEvidence;
    }
  | {
      readonly kind: "fallback" | "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

function outputDescriptors(
  configuration: TechnologyShareTrendQualificationConfiguration,
): readonly ShareTrendOutputDescriptor[] {
  const kinds: readonly OutputKind[] =
    configuration.kind === "single" ? ["single"] : ["source", "channel"];
  return kinds.flatMap((kind) => {
    const outputs = TECHNOLOGY_SHARE_TREND_OUTPUTS[kind];
    return (["top", "series", "bucket"] as const).map((rowType) => ({
      outputId: outputs[rowType],
      trendKind: kind,
      rowType,
      fields: REPORT_FIELDS,
    }));
  });
}

function exactOutput(
  outputs: readonly LogicalOutput[],
  outputId: string,
): LogicalOutput {
  const matches = outputs.filter((output) => output.id === outputId);
  if (matches.length !== 1)
    throw new Error(`share_trend_qualification_output:${outputId}`);
  return matches[0]!;
}

function normalizedConfiguration(
  value: unknown,
): TechnologyShareTrendQualificationConfiguration | undefined {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null)
    )
      return undefined;
    const keys = Reflect.ownKeys(value);
    const read = (name: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor && descriptor.enumerable && "value" in descriptor
        ? descriptor.value
        : undefined;
    };
    const kind = read("kind");
    const interval = read("interval");
    const limit = read("limit");
    if (
      typeof interval !== "string" ||
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 12
    )
      return undefined;
    if (kind === "single") {
      const dimension = read("dimension");
      if (
        keys.length !== 4 ||
        keys.some((key) => typeof key !== "string") ||
        !keys.includes("kind") ||
        !keys.includes("dimension") ||
        !keys.includes("interval") ||
        !keys.includes("limit") ||
        typeof dimension !== "string" ||
        !Object.prototype.hasOwnProperty.call(
          TECHNOLOGY_SHARE_TREND_OUTPUTS,
          "single",
        )
      )
        return undefined;
      const dimensions = [
        "browser",
        "browserEngine",
        "operatingSystem",
        "osVersion",
        "deviceType",
        "language",
        "screenSize",
        "utmSource",
        "utmMedium",
        "utmCampaign",
        "utmTerm",
        "utmContent",
        "referrerDomain",
        "trafficChannel",
      ] as const;
      if (!dimensions.includes(dimension as (typeof dimensions)[number]))
        return undefined;
      return {
        kind,
        dimension: dimension as (typeof dimensions)[number],
        interval:
          interval as TechnologyShareTrendQualificationConfiguration["interval"],
        limit,
      };
    }
    if (
      kind === "dual" &&
      keys.length === 3 &&
      keys.every((key) => typeof key === "string") &&
      keys.includes("kind") &&
      keys.includes("interval") &&
      keys.includes("limit")
    )
      return {
        kind,
        interval:
          interval as TechnologyShareTrendQualificationConfiguration["interval"],
        limit,
      };
    return undefined;
  } catch {
    return undefined;
  }
}

function sameConfiguration(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizedConfiguration(left);
  const normalizedRight = normalizedConfiguration(right);
  return (
    normalizedLeft !== undefined &&
    normalizedRight !== undefined &&
    normalizedLeft.kind === normalizedRight.kind &&
    normalizedLeft.interval === normalizedRight.interval &&
    normalizedLeft.limit === normalizedRight.limit &&
    (normalizedLeft.kind === "dual" ||
      (normalizedRight.kind === "single" &&
        normalizedLeft.dimension === normalizedRight.dimension))
  );
}

function verifyPlan(
  qualification: AnalyticsQualificationPlan,
  deferred: DeferredShareTrendQualification,
  descriptors: readonly ShareTrendOutputDescriptor[],
): {
  readonly reports: readonly {
    readonly output: LogicalOutput;
    readonly rowType: string;
    readonly fields: readonly string[];
  }[];
  readonly controlsOutput: LogicalOutput;
  readonly controlFields: readonly string[];
} {
  if (
    qualification.scope !== deferred.qualification.countInput.scope ||
    (qualification.scope !== "session" && qualification.scope !== "visitor") ||
    qualification.controlOutputId !==
      TECHNOLOGY_SHARE_TREND_QUALIFICATION_CONTROL_OUTPUT ||
    qualification.reportOutputIds.length !== descriptors.length ||
    qualification.reportOutputIds.some(
      (outputId, index) => outputId !== descriptors[index]?.outputId,
    ) ||
    qualification.reportSourceRelations.length !== 1 ||
    qualification.reportSourceRelations[0]?.entity !== "page"
  )
    throw new Error("share_trend_qualification_plan_identity_invalid");

  const reports = descriptors.map((descriptor) => {
    const output = exactOutput(qualification.plan.outputs, descriptor.outputId);
    if (
      output.fields.length !== descriptor.fields.length ||
      output.fields.some(
        (field, index) => field.name !== descriptor.fields[index],
      )
    )
      throw new Error(
        `share_trend_qualification_schema:${descriptor.outputId}`,
      );
    return {
      output,
      rowType: descriptor.rowType,
      fields: descriptor.fields,
    };
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
    throw new Error("share_trend_qualification_controls_invalid");
  return { reports, controlsOutput, controlFields };
}

function compileProgram(input: {
  readonly deferred: DeferredShareTrendQualification;
  readonly query: unknown;
  readonly configuration: TechnologyShareTrendQualificationConfiguration;
}) {
  if (
    !isDeferredShareTrendQualificationRequest(input.deferred) ||
    deferredShareTrendQualificationFromQuery(input.query) !== input.deferred ||
    !Object.isFrozen(input.deferred) ||
    !Object.isFrozen(input.deferred.configuration) ||
    !sameConfiguration(input.configuration, input.deferred.configuration) ||
    !isDeferredEventQualification(input.deferred.qualification) ||
    input.deferred.operation !== "share-trend" ||
    input.deferred.qualification.operation !== "share-trend"
  )
    throw new Error("share_trend_qualification_request_untrusted");
  const { deferred, configuration } = input;
  const qualification = buildTechnologyShareTrendQualificationPlan({
    configuration,
    siteId: deferred.qualification.siteId,
    queryTime: deferred.qualification.requestTime,
    filters: deferred.qualification.filters,
    ...(deferred.qualification.technologyFilterMode === "allow-whole-filter"
      ? { filterMode: "allow-whole-filter" as const }
      : {}),
    scopePlan: deferred.qualification.metadata.plan,
    count: deferred.qualification.countInput,
  });
  const descriptors = outputDescriptors(configuration);
  const verified = verifyPlan(qualification, deferred, descriptors);
  const compilation = compileQualificationProgramEnvelope({
    qualification,
    siteId: deferred.qualification.siteId,
    reports: verified.reports,
    controlsOutput: verified.controlsOutput,
    reportFields: REPORT_FIELDS,
    controlFields: verified.controlFields,
    ordering: [
      { field: "rowOrder", direction: "asc", nulls: "first" },
      { field: "bucket", direction: "asc", nulls: "first" },
      { field: "label", direction: "asc", nulls: "first" },
    ],
    errorPrefix: "share_trend_qualification",
    fallbackTag: "analytics.share_trend_qualification",
    signal: deferred.qualification.signal,
  });
  if (compilation.kind === "unavailable") return compilation;
  return {
    ...compilation,
    evidence: Object.freeze({
      ...compilation.evidence,
      configuration,
      descriptors: Object.freeze(descriptors),
    }),
  };
}

/** Exposes real compile evidence for bounded admission checks and execution. */
export function compileShareTrendQualificationProgram(input: {
  readonly deferred: DeferredShareTrendQualification;
  readonly query: unknown;
  readonly configuration: TechnologyShareTrendQualificationConfiguration;
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

function nonnegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`share_trend_qualification_value_invalid:${field}`);
  return value;
}

function decodeRows(
  rows: readonly Record<string, unknown>[],
  deferred: DeferredShareTrendQualification,
  evidence: ShareTrendQualificationCompilationEvidence,
): ShareTrendQualificationExecution {
  const envelopeFields = [
    "rowKind",
    "outputId",
    ...REPORT_FIELDS,
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
    throw new Error("share_trend_qualification_control_row_invalid");
  const control = controlRows[0]!;
  if (
    control.entityKind !== deferred.qualification.countInput.scope ||
    REPORT_FIELDS.some((field) => control[field] !== null)
  )
    throw new Error("share_trend_qualification_control_kind_mismatch");
  const decodedControl = decodeQualificationControl({
    read: (field) => control[field],
    compatibilityFields: evidence.compatibilityFields,
    errorLabel: (field) => `share_trend_qualification_control_invalid:${field}`,
  });
  const judgment = judgeQualificationControl(decodedControl, {
    reportRowCount: reportRows.length,
    gateViolation: () => new Error("share_trend_qualification_gate_violation"),
    invalidIdentity: () =>
      new Error("advanced_filter_count_combined_identity_invalid"),
    duplicateIdentity: () =>
      new Error("advanced_filter_count_combined_identity_repeated"),
  });
  if (judgment.kind === "fallback")
    return { kind: "fallback", fallbackReason: judgment.fallbackReason };

  const descriptorById = new Map(
    evidence.descriptors.map((descriptor) => [descriptor.outputId, descriptor]),
  );
  const rowsByOutput = new Map<string, Record<string, unknown>[]>();
  for (const row of reportRows) {
    if (
      !exactRowKeys(row, envelopeFields) ||
      typeof row.outputId !== "string" ||
      evidence.controlFields.some((field) => row[field] !== null)
    )
      throw new Error("share_trend_qualification_report_row_invalid");
    const descriptor = descriptorById.get(row.outputId);
    if (
      !descriptor ||
      row.trendKind !== descriptor.trendKind ||
      row.rowType !== descriptor.rowType ||
      typeof row.label !== "string"
    )
      throw new Error("share_trend_qualification_report_descriptor_invalid");
    const views = nonnegativeSafeInteger(row.views, "views");
    const visitors = nonnegativeSafeInteger(row.visitors, "visitors");
    const sessions = nonnegativeSafeInteger(row.sessions, "sessions");
    const rowOrder = nonnegativeSafeInteger(row.rowOrder, "rowOrder");
    if (
      (descriptor.rowType === "top" && rowOrder < 1) ||
      (descriptor.rowType !== "top" && rowOrder !== 0)
    )
      throw new Error("share_trend_qualification_row_order_invalid");
    if (descriptor.rowType === "bucket") {
      if (
        row.bucket !== null &&
        (typeof row.bucket !== "number" ||
          !Number.isSafeInteger(row.bucket) ||
          row.bucket < 0)
      )
        throw new Error("share_trend_qualification_bucket_invalid");
    } else if (row.bucket !== null) {
      throw new Error("share_trend_qualification_bucket_unexpected");
    }
    if (
      descriptor.rowType !== "bucket" &&
      visitors === 0 &&
      (views !== 0 || sessions !== 0)
    )
      throw new Error("share_trend_qualification_empty_counts_invalid");
    const outputRows = rowsByOutput.get(row.outputId) ?? [];
    outputRows.push(row);
    rowsByOutput.set(row.outputId, outputRows);
  }
  for (const descriptor of evidence.descriptors) {
    const outputRows = rowsByOutput.get(descriptor.outputId) ?? [];
    if (
      descriptor.rowType === "top" &&
      outputRows.length > evidence.configuration.limit
    )
      throw new Error("share_trend_qualification_top_limit_invalid");
    if (descriptor.rowType !== "bucket") {
      const labels = outputRows.map(({ label }) => label);
      if (new Set(labels).size !== labels.length)
        throw new Error("share_trend_qualification_report_duplicate_label");
    } else {
      const keys = outputRows.map(
        (row) => `${String(row.bucket)}\u0000${String(row.label)}`,
      );
      if (new Set(keys).size !== keys.length)
        throw new Error(
          "share_trend_qualification_report_duplicate_bucket_label",
        );
    }
  }
  return { kind: "executed", rows: Object.freeze([...reportRows]), evidence };
}

export async function executeShareTrendQualificationProgram(input: {
  readonly env: Env;
  readonly deferred: DeferredShareTrendQualification;
  readonly query: unknown;
  readonly configuration: TechnologyShareTrendQualificationConfiguration;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<ShareTrendQualificationExecution> {
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
