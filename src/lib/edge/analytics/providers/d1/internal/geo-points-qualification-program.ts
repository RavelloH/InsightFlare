import {
  buildJourneyGeoPointsQualificationPlan,
  JOURNEY_GEO_POINTS_OUTPUT,
  type JourneyGeoSummaryLevel,
} from "@/lib/edge/analytics/engine/journey-geo-report-plan";
import type { LogicalOutput } from "@/lib/edge/analytics/engine/logical/plan";
import type { GeoPointAggregate } from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryD1CompiledAll } from "@/lib/edge/analytics/providers/d1/internal/core";
import type { Env } from "@/lib/edge/types";

import type {
  AdvancedCountSqlFallbackReason,
  D1ReadDiagnostics,
} from "./diagnostics";
import {
  assertGeoPointsQualificationRequest,
  type DeferredGeoPointsQualification,
} from "./geo-points-qualification-request";
import { mapJourneyGeoSummaryRowsToDto } from "./journey-geo-queries";
import { mapGeoPointRow } from "./journey-helpers";
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

const POINT_FIELDS = [
  "latitude",
  "longitude",
  "timestampMs",
  "country",
  "region",
  "regionCode",
  "city",
  "pointCount",
] as const;
const SUMMARY_FIELDS: Record<JourneyGeoSummaryLevel, readonly string[]> = {
  country: ["country", "views", "sessions", "visitors"],
  region: ["country", "regionCode", "region", "views", "sessions", "visitors"],
  city: [
    "country",
    "regionCode",
    "region",
    "city",
    "views",
    "sessions",
    "visitors",
  ],
};
const CONTROL_OUTPUT = "geo-points-qualification-controls";
const ERROR_PREFIX = "geo_points_qualification";
const FALLBACK_TAG = "analytics.geo_points_qualification";

export type GeoPointsQualificationCompilation =
  | Extract<QualificationEnvelopeCompilation, { readonly kind: "compiled" }>
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    };

export type GeoPointsQualificationExecution =
  | {
      readonly kind: "executed";
      readonly value: GeoPointAggregate;
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

function compile(
  request: DeferredGeoPointsQualification,
): GeoPointsQualificationCompilation {
  const deferred = request.qualification;
  const plan = buildJourneyGeoPointsQualificationPlan({
    siteId: deferred.siteId,
    queryTime: deferred.requestTime,
    filters: deferred.filters,
    scopePlan: deferred.metadata.plan,
    count: deferred.countInput,
    ...("eventCandidateReportProjection" in deferred &&
    deferred.eventCandidateReportProjection === "page-visits"
      ? { eventCandidateReportProjection: "page-visits" as const }
      : {}),
    limit: request.configuration.limit,
    level: request.configuration.summaryLevel,
    filterMode: request.filterMode,
  });
  const pointOutput = exactOutput(plan.plan.outputs, JOURNEY_GEO_POINTS_OUTPUT);
  const summaryOutputId = `journey-geo-${request.configuration.summaryLevel}-summary`;
  const summaryOutput = exactOutput(plan.plan.outputs, summaryOutputId);
  const controlsOutput = exactOutput(plan.plan.outputs, CONTROL_OUTPUT);
  const expectedOutputIds = [JOURNEY_GEO_POINTS_OUTPUT, summaryOutputId];
  if (
    plan.reportOutputIds.length !== expectedOutputIds.length ||
    plan.reportOutputIds.some(
      (outputId, index) => outputId !== expectedOutputIds[index],
    )
  )
    throw new Error(`${ERROR_PREFIX}_plan_identity_invalid`);
  const reportFields = [
    ...POINT_FIELDS,
    ...SUMMARY_FIELDS[request.configuration.summaryLevel].filter(
      (field) => !POINT_FIELDS.includes(field as (typeof POINT_FIELDS)[number]),
    ),
  ];
  const qualification: QualificationEnvelopeQualification = {
    plan: plan.plan,
    primaryReportSourceRelationId: plan.primaryReportSourceRelationId,
    controlsRelationId: controlsOutput.relation,
    controlOutputId: plan.controlOutputId,
    numericCompatibilityFields: plan.numericCompatibilityFields,
    scope: plan.scope,
    reportSourceRelations: plan.reportSourceRelations,
    groupedSummaryRelationId: plan.groupedSummaryRelationId,
    ...(plan.candidateGrain ? { candidateGrain: plan.candidateGrain } : {}),
    ...(plan.eventCandidateReportProjection
      ? {
          eventCandidateReportProjection: plan.eventCandidateReportProjection,
        }
      : {}),
    ...(plan.additionalGroupedSummaryRelationIds
      ? {
          additionalGroupedSummaryRelationIds:
            plan.additionalGroupedSummaryRelationIds,
        }
      : {}),
    ...(plan.comparisonProvenance.length > 0
      ? { comparisonProvenance: plan.comparisonProvenance }
      : {}),
  };
  return compileQualificationProgramEnvelope({
    qualification,
    siteId: deferred.siteId,
    reports: [
      {
        output: pointOutput,
        fields: POINT_FIELDS,
        rowType: "journey-geo-points",
      },
      {
        output: summaryOutput,
        fields: SUMMARY_FIELDS[request.configuration.summaryLevel],
        rowType: `journey-geo-${request.configuration.summaryLevel}-summary`,
      },
    ],
    controlsOutput,
    reportFields,
    controlFields: controlsOutput.fields.map(({ name }) => name),
    ordering: [
      {
        field: "timestampMs",
        outputId: JOURNEY_GEO_POINTS_OUTPUT,
        direction: "desc",
        nulls: "last",
      },
      {
        field: "views",
        outputId: summaryOutputId,
        direction: "desc",
        nulls: "last",
      },
      {
        field: "sessions",
        outputId: summaryOutputId,
        direction: "desc",
        nulls: "last",
      },
      ...(request.configuration.summaryLevel === "country"
        ? ["country"]
        : request.configuration.summaryLevel === "region"
          ? ["region", "regionCode"]
          : ["city"]
      ).map((field) => ({
        field,
        outputId: summaryOutputId,
        direction: "asc" as const,
        nulls: "first" as const,
      })),
    ],
    errorPrefix: ERROR_PREFIX,
    fallbackTag: FALLBACK_TAG,
    signal: deferred.signal,
  });
}

/** Compile preflight is exposed so all real bounded shapes are checked first. */
export function compileGeoPointsQualificationProgram(input: {
  readonly deferred: DeferredGeoPointsQualification;
}) {
  return compile(input.deferred);
}

function exactKeys(row: Record<string, unknown>, fields: readonly string[]) {
  const actual = Object.keys(row).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteGeoNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function decodeRows(input: {
  readonly rows: readonly Record<string, unknown>[];
  readonly request: DeferredGeoPointsQualification;
  readonly evidence: Extract<
    QualificationEnvelopeCompilation,
    { readonly kind: "compiled" }
  >["evidence"];
}):
  | {
      readonly kind: "executed";
      readonly value: GeoPointAggregate;
      readonly evidence: typeof input.evidence;
      readonly reportRowCount: number;
      readonly controlRowCount: 1;
    }
  | {
      readonly kind: "fallback";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
    } {
  const { rows, request, evidence } = input;
  const envelopeFields = [
    "rowKind",
    "outputId",
    ...evidence.outputDescriptors
      .flatMap(({ fields }) => fields)
      .filter((field, index, all) => all.indexOf(field) === index),
    ...evidence.controlFields,
  ];
  const reportFields = [
    ...POINT_FIELDS,
    ...SUMMARY_FIELDS[request.configuration.summaryLevel].filter(
      (field) => !POINT_FIELDS.includes(field as (typeof POINT_FIELDS)[number]),
    ),
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
    control.outputId !== evidence.controlOutputId ||
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
  if (judgment.kind === "fallback") return judgment;

  const pointOutput = JOURNEY_GEO_POINTS_OUTPUT;
  const summaryOutput = `journey-geo-${request.configuration.summaryLevel}-summary`;
  const points: Record<string, unknown>[] = [];
  const summaries: Record<string, unknown>[] = [];
  for (const row of reportRows) {
    if (evidence.controlFields.some((field) => row[field] !== null))
      throw new Error(`${ERROR_PREFIX}_report_control_shape_invalid`);
    if (row.outputId === pointOutput) {
      if (
        SUMMARY_FIELDS[request.configuration.summaryLevel].some(
          (field) =>
            !POINT_FIELDS.includes(field as (typeof POINT_FIELDS)[number]) &&
            row[field] !== null,
        ) ||
        !finiteGeoNumber(row.latitude) ||
        !finiteGeoNumber(row.longitude) ||
        !finiteGeoNumber(row.timestampMs) ||
        Math.abs(row.latitude) > 90 ||
        Math.abs(row.longitude) > 180 ||
        Number(row.latitude.toFixed(3)) !== row.latitude ||
        Number(row.longitude.toFixed(3)) !== row.longitude ||
        !Number.isSafeInteger(row.timestampMs) ||
        typeof row.country !== "string" ||
        typeof row.region !== "string" ||
        typeof row.regionCode !== "string" ||
        typeof row.city !== "string" ||
        !safeCount(row.pointCount) ||
        row.pointCount < 1
      )
        throw new Error(`${ERROR_PREFIX}_point_shape_invalid`);
      points.push(row);
      continue;
    }
    if (row.outputId === summaryOutput) {
      if (
        POINT_FIELDS.some(
          (field) =>
            !SUMMARY_FIELDS[request.configuration.summaryLevel].includes(
              field,
            ) && row[field] !== null,
        ) ||
        SUMMARY_FIELDS[request.configuration.summaryLevel].some((field) =>
          field === "views" || field === "sessions" || field === "visitors"
            ? !safeCount(row[field]) || (field === "views" && row[field] < 1)
            : typeof row[field] !== "string",
        )
      )
        throw new Error(`${ERROR_PREFIX}_summary_shape_invalid`);
      summaries.push(row);
      continue;
    }
    throw new Error(`${ERROR_PREFIX}_report_output_invalid`);
  }
  const value: GeoPointAggregate = {
    points: points.map((row) =>
      mapGeoPointRow({
        latitude: row.latitude as number,
        longitude: row.longitude as number,
        timestampMs: row.timestampMs as number,
        country: row.country as string,
        region: row.region as string,
        regionCode: row.regionCode as string,
        city: row.city as string,
        pointCount: row.pointCount as number,
      }),
    ),
    ...mapJourneyGeoSummaryRowsToDto(
      request.configuration.summaryLevel,
      summaries,
    ),
  };
  return {
    kind: "executed",
    value,
    evidence,
    reportRowCount: reportRows.length,
    controlRowCount: 1,
  };
}

export async function executeGeoPointsQualificationProgram(input: {
  readonly env: Env;
  readonly query: unknown;
  readonly request: DeferredGeoPointsQualification;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<GeoPointsQualificationExecution> {
  const request = assertGeoPointsQualificationRequest(
    input.request,
    input.query,
  );
  const compilation = compile(request);
  if (compilation.kind === "unavailable")
    return { kind: "unavailable", fallbackReason: compilation.fallbackReason };
  const rows = await executeQualificationQuery(
    request.qualification.signal,
    () =>
      queryD1CompiledAll<Record<string, unknown>>(
        input.env,
        compilation.query,
        input.diagnostics,
      ),
  );
  return decodeRows({
    rows,
    request,
    evidence: compilation.evidence,
  });
}
