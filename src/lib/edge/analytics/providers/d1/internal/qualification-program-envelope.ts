import type { CompiledQuery } from "@/lib/db";
import {
  caseWhen,
  compileD1Query,
  constant,
  eq,
  isNull,
  join,
  lowerLogicalPlan,
  project,
  sort,
  union,
} from "@/lib/db";
import type { AnyExpression } from "@/lib/db/query/expression";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type {
  AnalyticsQualificationPlan,
  EventQualificationReportSource,
} from "@/lib/edge/analytics/engine/event-qualified-source-plan";
import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";
import type {
  LogicalOutput,
  LogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import type { QualifiedGeoComparisonProvenance } from "@/lib/edge/analytics/engine/semantic/count-bare-fields";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import type { AnalysisResultQualificationBinding } from "@/lib/edge/analytics/providers/d1/internal/lowering/comparison-page-admission";
import type { AnalyticsQualificationAdmissionPolicy } from "@/lib/edge/analytics/providers/d1/internal/lowering/event-summary-admission";
import { currentD1Operation } from "@/lib/edge/observability/logger";

import {
  createRegisteredComparisonAdmissionBinding,
  isComparisonDomainSingletonAggregate,
} from "./comparison-domain-admission";
import type { AdvancedCountSqlFallbackReason } from "./diagnostics";
import {
  type QualificationCompatibilityField,
  qualificationCompatibilityFieldsFromNumeric,
  qualificationCompatibilityOutputNames,
  validateQualificationCompatibilityFields,
} from "./qualification-compatibility";
import {
  type GroupedSummaryRelationEvidence,
  proveGroupedSummaryRelations,
} from "./qualification-grouped-summary-evidence";
import {
  compileQualificationQuery,
  type QualificationSignal,
} from "./qualification-program-runtime";

export interface QualificationEnvelopeReportDescriptor {
  readonly output: LogicalOutput;
  readonly fields: readonly string[];
  readonly rowType: string;
}

export interface QualificationEnvelopeOrderingDescriptor {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly nulls: "first" | "last";
  readonly outputId?: string;
}

export interface QualificationEnvelopeCompilationEvidence {
  readonly statementTag: string;
  readonly sql: string;
  readonly bindings: readonly unknown[];
  readonly sqlBytes: number;
  readonly bindingCount: number;
  readonly groupWidth: number;
  readonly groupedSummaryProof: QualificationEnvelopeGroupedSummaryProof;
  readonly additionalGroupedSummaryProofs?: readonly QualificationEnvelopeGroupedSummaryProof[];
  readonly sharedRelationCount: number;
  readonly rootKind: string;
  readonly physicalPlanShape?: CompiledQuery["physicalPlanShape"];
  readonly logicalPlan: AnalyticsQualificationPlan["plan"];
  readonly reportSourceRelations: readonly EventQualificationReportSource[];
  readonly controlOutputId: string;
  readonly controlFields: readonly string[];
  readonly compatibilityFields: readonly QualificationCompatibilityField[];
  readonly outputDescriptors: readonly {
    readonly outputId: string;
    readonly rowType: string;
    readonly fields: readonly string[];
  }[];
  readonly ordering: readonly QualificationEnvelopeOrderingDescriptor[];
}

export interface QualificationEnvelopeGroupedSummaryProof {
  readonly source: "local-plan" | "imported-child" | "missing";
  readonly relationId: RelationId | null;
  readonly nodeKind: string | null;
  readonly groupKeyCount: number | null;
  readonly fieldCount: number | null;
  readonly matchingSharedRelationCount: number;
  readonly materialization: string | null;
  readonly sharedRelations: readonly {
    readonly nodeKind: string;
    readonly materialization: string;
    readonly fieldCount: number;
    readonly sameNode: boolean;
  }[];
}

export interface QualificationEnvelopeQualification {
  readonly plan: AnalyticsQualificationPlan["plan"];
  readonly primaryReportSourceRelationId: AnalyticsQualificationPlan["primaryReportSourceRelationId"];
  readonly controlsRelationId: AnalyticsQualificationPlan["controlsRelationId"];
  readonly groupedSummaryRelationId?: AnalyticsQualificationPlan["groupedSummaryRelationId"];
  readonly additionalGroupedSummaryRelationIds?: readonly RelationId[];
  readonly candidateGrain?: "event-candidate";
  readonly eventCandidateReportProjection?: "page-visits";
  readonly controlOutputId: string;
  readonly numericCompatibilityFields: AnalyticsQualificationPlan["numericCompatibilityFields"];
  readonly scope: "session" | "visitor" | "event";
  readonly reportSourceRelations: readonly EventQualificationReportSource[];
  readonly comparisonProvenance?: readonly QualifiedGeoComparisonProvenance[];
}

export interface QualificationEnvelopeImportedGroupedSummaryReference {
  readonly kind: "imported-child";
  readonly childPlan: LogicalPlan;
  readonly relationId: RelationId;
}

export type QualificationEnvelopeCompilation =
  | {
      readonly kind: "compiled";
      readonly query: CompiledQuery<Record<string, unknown>>;
      readonly evidence: QualificationEnvelopeCompilationEvidence;
    }
  | {
      readonly kind: "unavailable";
      readonly fallbackReason: AdvancedCountSqlFallbackReason;
      readonly admissionEvidence?: {
        readonly groupWidth: number | null;
        readonly groupedSummaryProof: QualificationEnvelopeGroupedSummaryProof;
        readonly additionalGroupedSummaryProofs?: readonly QualificationEnvelopeGroupedSummaryProof[];
        readonly sharedRelationCount: number;
        readonly rootKind: string;
        readonly sharedRelations: readonly {
          readonly nodeKind: string;
          readonly materialization: string;
          readonly fieldCount: number;
        }[];
      };
    };

function taggedRows(input: {
  readonly reports: readonly {
    readonly outputId: string;
    readonly relation: AnalyticsDbRelation;
    readonly fields: readonly string[];
  }[];
  readonly controls: AnalyticsDbRelation;
  readonly controlOutputId: string;
  readonly reportFields: readonly string[];
  readonly controlFields: readonly string[];
  readonly ordering?: readonly QualificationEnvelopeOrderingDescriptor[];
  readonly errorPrefix: string;
}): AnalyticsDbRelation {
  const allFields = new Set(input.reportFields);
  if (
    allFields.size !== input.reportFields.length ||
    allFields.has("rowKind") ||
    allFields.has("outputId")
  )
    throw new Error(`${input.errorPrefix}_envelope_schema_invalid`);
  const controlNames = new Set(input.controlFields);
  if (
    controlNames.size !== input.controlFields.length ||
    controlNames.has("rowKind") ||
    controlNames.has("outputId") ||
    input.reportFields.some((field) => controlNames.has(field))
  )
    throw new Error(`${input.errorPrefix}_control_name_invalid`);

  const branches = input.reports.map(({ outputId, relation, fields }) => {
    if (
      new Set(fields).size !== fields.length ||
      fields.some((field) => !allFields.has(field))
    )
      throw new Error(`${input.errorPrefix}_report_schema_invalid:${outputId}`);
    const projection: Record<string, AnyExpression> = {
      rowKind: constant("report"),
      outputId: constant(outputId),
    };
    for (const field of input.reportFields)
      projection[field] = fields.includes(field)
        ? (relation.columns[field] ??
          (() => {
            throw new Error(
              `${input.errorPrefix}_report_field_missing:${outputId}:${field}`,
            );
          })())
        : constant(null);
    for (const field of input.controlFields) projection[field] = constant(null);
    return project(relation, projection);
  });
  const controlProjection: Record<string, AnyExpression> = {
    rowKind: constant("control"),
    outputId: constant(input.controlOutputId),
  };
  for (const field of input.reportFields)
    controlProjection[field] = constant(null);
  for (const field of input.controlFields) {
    const expression = input.controls.columns[field];
    if (!expression)
      throw new Error(`${input.errorPrefix}_control_field_missing:${field}`);
    controlProjection[field] = expression;
  }
  branches.push(project(input.controls, controlProjection));
  let envelope = branches[0];
  if (!envelope) throw new Error(`${input.errorPrefix}_rows_missing`);
  for (const branch of branches.slice(1))
    envelope = union(envelope, branch, true);

  if (input.ordering === undefined)
    return sort(envelope, [
      { expression: envelope.columns.rowKind, direction: "ASC" },
      { expression: envelope.columns.outputId, direction: "ASC" },
      { expression: envelope.columns.bucket, direction: "ASC" },
    ]);

  const seen = new Set(["rowKind", "outputId"]);
  const reportOutputIds = new Set(
    input.reports.map(({ outputId }) => outputId),
  );
  const orderKeys: {
    readonly expression: AnyExpression;
    readonly direction: "ASC" | "DESC";
  }[] = [
    {
      expression: envelope.columns.rowKind,
      direction: "ASC" as const,
    },
    {
      expression: envelope.columns.outputId,
      direction: "ASC" as const,
    },
  ];
  for (const key of input.ordering) {
    const scopedKey = key.outputId ? key.outputId + "|" + key.field : key.field;
    const fieldExpression = envelope.columns[key.field];
    if (
      !fieldExpression ||
      !Object.prototype.hasOwnProperty.call(envelope.columns, key.field) ||
      (key.outputId !== undefined && !reportOutputIds.has(key.outputId)) ||
      seen.has(scopedKey) ||
      (key.direction !== "asc" && key.direction !== "desc") ||
      (key.nulls !== "first" && key.nulls !== "last")
    )
      throw new Error(
        input.errorPrefix + "_envelope_order_invalid:" + key.field,
      );
    seen.add(scopedKey);
    const expression = key.outputId
      ? (caseWhen(
          [
            {
              when: eq(
                envelope.columns.outputId,
                constant(key.outputId) as never,
              ),
              then: fieldExpression,
            },
          ],
          constant(null),
        ) as AnyExpression)
      : fieldExpression;
    const nativeNulls = key.direction === "asc" ? "first" : "last";
    if (key.nulls !== nativeNulls)
      orderKeys.push({
        expression: caseWhen(
          [
            {
              when: isNull(expression),
              then: constant(key.nulls === "first" ? 0 : 1),
            },
          ],
          constant(key.nulls === "first" ? 1 : 0),
        ),
        direction: "ASC",
      });
    orderKeys.push({
      expression,
      direction: key.direction === "asc" ? "ASC" : "DESC",
    });
  }
  return sort(envelope, orderKeys);
}

/** Lower, admit, envelope, and compile one gated multi-output qualification. */
export function compileQualificationProgramEnvelope(input: {
  readonly qualification: QualificationEnvelopeQualification;
  readonly siteId: string;
  readonly reports: readonly QualificationEnvelopeReportDescriptor[];
  readonly controlsOutput: LogicalOutput;
  readonly reportFields: readonly string[];
  readonly controlFields: readonly string[];
  readonly ordering?: readonly QualificationEnvelopeOrderingDescriptor[];
  readonly errorPrefix: string;
  readonly fallbackTag: string;
  readonly signal?: QualificationSignal;
  readonly analysisResultQualificationBindings?: readonly AnalysisResultQualificationBinding[];
  readonly importedGroupedSummaryReference?: QualificationEnvelopeImportedGroupedSummaryReference;
}): QualificationEnvelopeCompilation {
  const { qualification } = input;
  if (
    input.controlsOutput.id !== qualification.controlOutputId ||
    qualification.reportSourceRelations.length === 0 ||
    input.reports.length === 0 ||
    new Set(input.reports.map(({ output }) => output.id)).size !==
      input.reports.length ||
    new Set(input.reports.map(({ output }) => output.relation)).size !==
      input.reports.length ||
    input.reports.some(
      ({ output }) => output.relation === input.controlsOutput.relation,
    ) ||
    input.reports.some(({ output }) => {
      const planOutputs = qualification.plan.outputs.filter(
        (candidate) => candidate.id === output.id,
      );
      return (
        planOutputs.length !== 1 ||
        planOutputs[0]!.relation !== output.relation ||
        planOutputs[0]!.fields.length !== output.fields.length ||
        planOutputs[0]!.fields.some(
          (field, index) =>
            field.name !== output.fields[index]?.name ||
            field.slot !== output.fields[index]?.slot,
        )
      );
    }) ||
    (qualification.eventCandidateReportProjection === "page-visits" &&
      (qualification.plan.outputs.length !== input.reports.length + 1 ||
        qualification.plan.outputs.some(
          (output) =>
            output.id !== qualification.controlOutputId &&
            !input.reports.some(
              ({ output: report }) => report.id === output.id,
            ),
        ))) ||
    (qualification.candidateGrain === "event-candidate" &&
      (qualification.scope !== "event" ||
        qualification.comparisonProvenance !== undefined ||
        (qualification.eventCandidateReportProjection === undefined
          ? input.reports.length !== 1 ||
            qualification.reportSourceRelations.length !== 1 ||
            qualification.reportSourceRelations[0]!.entity !== "event" ||
            qualification.reportSourceRelations[0]!.relationId !==
              qualification.primaryReportSourceRelationId
          : qualification.eventCandidateReportProjection !== "page-visits" ||
            qualification.reportSourceRelations.length !== 1 ||
            qualification.reportSourceRelations[0]!.entity !== "page" ||
            qualification.reportSourceRelations[0]!.relationId !==
              qualification.primaryReportSourceRelationId))) ||
    (qualification.eventCandidateReportProjection !== undefined &&
      qualification.candidateGrain !== "event-candidate") ||
    (qualification.candidateGrain === undefined &&
      qualification.additionalGroupedSummaryRelationIds !== undefined)
  )
    throw new Error(`${input.errorPrefix}_plan_identity_invalid`);
  const controlFieldNames = input.controlsOutput.fields.map(({ name }) => name);
  if (
    controlFieldNames.length !== input.controlFields.length ||
    controlFieldNames.some((name) => !input.controlFields.includes(name))
  )
    throw new Error(`${input.errorPrefix}_controls_invalid`);

  const comparisonAdmissionBinding =
    qualification.comparisonProvenance &&
    qualification.comparisonProvenance.length > 0
      ? createRegisteredComparisonAdmissionBinding({
          plan: qualification.plan,
          provenance: qualification.comparisonProvenance,
          siteId: input.siteId,
          scope: qualification.scope as "session" | "visitor",
          reportSourceRelationIds: qualification.reportSourceRelations.map(
            ({ relationId }) => relationId,
          ),
          rawCountEligibilityWitness:
            qualification.comparisonProvenance[0]!.rawCountEligibilityWitness,
        })
      : undefined;
  const compatibilityFields = qualificationCompatibilityFieldsFromNumeric(
    qualification.numericCompatibilityFields,
  );
  const finalCompatibilityFields = validateQualificationCompatibilityFields([
    ...compatibilityFields,
    ...(comparisonAdmissionBinding?.descriptors ?? []),
  ]);
  const compatibilityControlFields =
    qualificationCompatibilityOutputNames(compatibilityFields);
  const policy: AnalyticsQualificationAdmissionPolicy = {
    primaryReportSourceRelationId: qualification.primaryReportSourceRelationId,
    reportSourceRelations: qualification.reportSourceRelations,
    reportRelationIds: input.reports.map(({ output }) => output.relation),
    controlsRelationId: input.controlsOutput.relation,
    controlSlots: input.controlsOutput.fields.map(({ name, slot }) => ({
      name,
      slot,
    })),
    scope: qualification.scope,
    ...(qualification.candidateGrain
      ? { candidateGrain: qualification.candidateGrain }
      : {}),
    ...(qualification.eventCandidateReportProjection
      ? {
          eventCandidateReportProjection:
            qualification.eventCandidateReportProjection,
        }
      : {}),
    maximumActivities: ADVANCED_FILTER_MAX_ACTIVITIES,
    numericCompatibilityControlNames: compatibilityControlFields,
  };
  const lowerer = new AnalyticsLogicalToDbLowerer(
    qualification.plan,
    {
      siteId: input.siteId,
      time: qualification.plan.context.time,
    },
    {
      analyticsQualificationAdmissionPolicy: policy,
      ...(input.analysisResultQualificationBindings
        ? {
            analysisResultQualificationBindings:
              input.analysisResultQualificationBindings,
          }
        : {}),
      ...(comparisonAdmissionBinding
        ? { comparisonDomainAdmissionBinding: comparisonAdmissionBinding }
        : {}),
    },
  );
  const lowered = lowerer.lowerMany([
    ...input.reports.map(({ output }) => output),
    input.controlsOutput,
  ]);
  const reportRelations = input.reports.map(({ output, fields }, index) => ({
    outputId: output.id,
    fields,
    relation: lowerer.projectOutput(
      lowered[index]!,
      output.fields.map(({ name, slot }) => ({ name, slot })),
    ),
  }));
  let controls = lowerer.projectOutput(
    lowered[input.reports.length]!,
    input.controlsOutput.fields.map(({ name, slot }) => ({ name, slot })),
  );
  let finalControlFields = [...input.controlFields];
  if (comparisonAdmissionBinding) {
    const evidence = lowerer.takeComparisonDomainAdmissionEvidence();
    if (!evidence)
      throw new Error(`${input.errorPrefix}_comparison_evidence_missing`);
    const aggregateRelation = evidence.aggregate;
    const outputNames = comparisonAdmissionBinding.descriptors.map(
      ({ outputName }) => outputName,
    );
    if (!isComparisonDomainSingletonAggregate(aggregateRelation, outputNames))
      throw new Error(
        `${input.errorPrefix}_comparison_aggregate_not_singleton`,
      );
    const controlsWithComparison = join(
      controls,
      aggregateRelation,
      eq(constant(1), constant(1)),
    );
    const comparisonProjection: Record<string, AnyExpression> = {};
    for (const field of input.controlFields) {
      const value = controlsWithComparison.columns[`left_${field}`];
      if (!value)
        throw new Error(`${input.errorPrefix}_control_field_missing:${field}`);
      comparisonProjection[field] = value;
    }
    for (const descriptor of comparisonAdmissionBinding.descriptors) {
      if (input.controlFields.includes(descriptor.outputName))
        throw new Error(`${input.errorPrefix}_comparison_control_collision`);
      const value =
        controlsWithComparison.columns[`right_${descriptor.outputName}`];
      if (!value)
        throw new Error(
          `${input.errorPrefix}_comparison_control_missing:${descriptor.outputName}`,
        );
      comparisonProjection[descriptor.outputName] = value;
    }
    controls = project(controlsWithComparison, comparisonProjection);
    finalControlFields = [
      ...input.controlFields,
      ...comparisonAdmissionBinding.descriptors.map(
        ({ outputName }) => outputName,
      ),
    ];
    if (new Set(finalControlFields).size !== finalControlFields.length)
      throw new Error(`${input.errorPrefix}_comparison_control_collision`);
  }
  const envelope = taggedRows({
    reports: reportRelations,
    controls,
    controlOutputId: qualification.controlOutputId,
    reportFields: input.reportFields,
    controlFields: finalControlFields,
    ...(input.ordering ? { ordering: input.ordering } : {}),
    errorPrefix: input.errorPrefix,
  });
  const physical = lowerLogicalPlan(envelope);
  const localGroupedSummaryId = qualification.groupedSummaryRelationId;
  const importedGroupedSummary = input.importedGroupedSummaryReference;
  const eventCandidate = qualification.candidateGrain === "event-candidate";
  const groupedSummaryIds = [
    ...(localGroupedSummaryId === undefined ? [] : [localGroupedSummaryId]),
    ...(qualification.additionalGroupedSummaryRelationIds ?? []),
  ];
  const eventCandidateGroupedEvidence = eventCandidate
    ? proveGroupedSummaryRelations({
        relationIds: groupedSummaryIds,
        planNodes: qualification.plan.nodes,
        physicalSharedRelations: physical.sharedRelations,
        lowerRelation: (relationId) =>
          lowerer.loweredRelationForPlan(relationId),
      })
    : undefined;
  const eventCandidateProof = (
    item?: GroupedSummaryRelationEvidence,
  ): QualificationEnvelopeGroupedSummaryProof =>
    item
      ? Object.freeze({
          source: "local-plan",
          relationId: item.relationId,
          nodeKind: item.nodeKind,
          groupKeyCount: item.groupKeyCount,
          fieldCount: item.fieldCount,
          matchingSharedRelationCount: item.matchingSharedRelationCount,
          materialization: item.materialization,
          sharedRelations: item.sharedRelations,
        })
      : Object.freeze({
          source: "missing",
          relationId: null,
          nodeKind: null,
          groupKeyCount: null,
          fieldCount: null,
          matchingSharedRelationCount: 0,
          materialization: null,
          sharedRelations: Object.freeze(
            physical.sharedRelations.map((relation) =>
              Object.freeze({
                nodeKind: relation.node.kind,
                materialization: relation.materialization,
                fieldCount: relation.fields.length,
                sameNode: false,
              }),
            ),
          ),
        });

  const groupedSummarySource: "local-plan" | "imported-child" | "missing" =
    localGroupedSummaryId !== undefined && !importedGroupedSummary
      ? "local-plan"
      : localGroupedSummaryId === undefined && importedGroupedSummary
        ? "imported-child"
        : "missing";
  const groupedSummaryId =
    groupedSummarySource === "local-plan"
      ? localGroupedSummaryId!
      : groupedSummarySource === "imported-child" && importedGroupedSummary
        ? importedGroupedSummary.relationId
        : null;
  const legacyGrouped = eventCandidate
    ? undefined
    : groupedSummarySource === "local-plan"
      ? lowerer.loweredRelationForPlan(groupedSummaryId!)
      : groupedSummarySource === "imported-child" &&
          importedGroupedSummary !== undefined &&
          importedGroupedSummary.kind === "imported-child" &&
          Object.isFrozen(importedGroupedSummary) &&
          Object.isFrozen(importedGroupedSummary.childPlan)
        ? lowerer.loweredRelationForImportedChildPlan(
            importedGroupedSummary.childPlan,
            groupedSummaryId!,
          )
        : undefined;
  const legacyGroupedCandidates = physical.sharedRelations.filter(
    (relation) => relation.node === legacyGrouped?.node,
  );
  const groupedSummaryProof: QualificationEnvelopeGroupedSummaryProof =
    eventCandidate
      ? eventCandidateProof(eventCandidateGroupedEvidence!.entries[0])
      : Object.freeze({
          source: groupedSummarySource,
          relationId: groupedSummaryId,
          nodeKind: legacyGrouped?.node.kind ?? null,
          groupKeyCount:
            legacyGrouped?.node.kind === "aggregate"
              ? legacyGrouped.node.groups.length
              : null,
          fieldCount: legacyGrouped?.fields.length ?? null,
          matchingSharedRelationCount: legacyGroupedCandidates.length,
          materialization:
            legacyGroupedCandidates.length === 1
              ? legacyGroupedCandidates[0]!.materialization
              : null,
          sharedRelations: Object.freeze(
            physical.sharedRelations.map((relation) =>
              Object.freeze({
                nodeKind: relation.node.kind,
                materialization: relation.materialization,
                fieldCount: relation.fields.length,
                sameNode: relation.node === legacyGrouped?.node,
              }),
            ),
          ),
        });
  const additionalGroupedSummaryProofs = eventCandidate
    ? Object.freeze(
        eventCandidateGroupedEvidence!.entries
          .slice(1)
          .map(eventCandidateProof),
      )
    : undefined;
  const grouped = eventCandidate
    ? (eventCandidateGroupedEvidence!.entries[0]?.lowered as
        AnalyticsDbRelation | undefined)
    : legacyGrouped;
  const groupedCandidates = physical.sharedRelations.filter(
    (relation) => relation.node === grouped?.node,
  );
  if (
    (eventCandidate
      ? !eventCandidateGroupedEvidence!.valid || groupedSummaryIds.length !== 2
      : !grouped ||
        grouped.node.kind !== "aggregate" ||
        grouped.node.groups.length !== 2 ||
        grouped.fields.length > 16 ||
        groupedCandidates.length !== 1 ||
        groupedCandidates[0]!.materialization !== "materialized" ||
        groupedCandidates[0]!.fields.length > 16) ||
    !grouped
  )
    return {
      kind: "unavailable",
      fallbackReason: {
        kind: "grouped-summary-unavailable",
        groupWidth: grouped?.fields.length ?? null,
      },
      admissionEvidence: {
        groupWidth: grouped?.fields.length ?? null,
        groupedSummaryProof,
        ...(additionalGroupedSummaryProofs
          ? { additionalGroupedSummaryProofs }
          : {}),
        sharedRelationCount: physical.sharedRelations.length,
        rootKind: physical.root.kind,
        sharedRelations: Object.freeze(
          physical.sharedRelations.map((relation) =>
            Object.freeze({
              nodeKind: relation.node.kind,
              materialization: relation.materialization,
              fieldCount: relation.fields.length,
            }),
          ),
        ),
      },
    };
  const groupWidth = grouped.fields.length;

  const compilation = compileQualificationQuery(
    () =>
      compileD1Query(physical, {
        tag: currentD1Operation() ?? input.fallbackTag,
      }) as CompiledQuery<Record<string, unknown>>,
    input.signal,
  );
  if (compilation.kind === "unavailable")
    return {
      ...compilation,
      admissionEvidence: {
        groupWidth,
        groupedSummaryProof,
        ...(additionalGroupedSummaryProofs
          ? { additionalGroupedSummaryProofs }
          : {}),
        sharedRelationCount: physical.sharedRelations.length,
        rootKind: physical.root.kind,
        sharedRelations: Object.freeze(
          physical.sharedRelations.map((relation) =>
            Object.freeze({
              nodeKind: relation.node.kind,
              materialization: relation.materialization,
              fieldCount: relation.fields.length,
            }),
          ),
        ),
      },
    };
  const { query } = compilation;
  return {
    kind: "compiled",
    query,
    evidence: Object.freeze({
      statementTag: query.tag ?? currentD1Operation() ?? input.fallbackTag,
      sql: query.sql,
      bindings: Object.freeze([...(query.bindings ?? [])]),
      sqlBytes: new TextEncoder().encode(query.sql).byteLength,
      bindingCount: query.bindings?.length ?? 0,
      groupWidth,
      groupedSummaryProof,
      ...(additionalGroupedSummaryProofs
        ? { additionalGroupedSummaryProofs }
        : {}),
      sharedRelationCount: physical.sharedRelations.length,
      rootKind: physical.root.kind,
      ...(query.physicalPlanShape
        ? { physicalPlanShape: query.physicalPlanShape }
        : {}),
      logicalPlan: qualification.plan,
      reportSourceRelations: qualification.reportSourceRelations,
      controlOutputId: qualification.controlOutputId,
      controlFields: Object.freeze([...finalControlFields]),
      compatibilityFields: finalCompatibilityFields,
      outputDescriptors: Object.freeze(
        input.reports.map(({ output, rowType, fields }) =>
          Object.freeze({
            outputId: output.id,
            rowType,
            fields: Object.freeze([...fields]),
          }),
        ),
      ),
      ordering: Object.freeze(
        input.ordering
          ? [
              {
                field: "rowKind",
                direction: "asc" as const,
                nulls: "first" as const,
              },
              {
                field: "outputId",
                direction: "asc" as const,
                nulls: "first" as const,
              },
              ...input.ordering.map((item) => ({ ...item })),
            ]
          : [
              {
                field: "rowKind",
                direction: "asc" as const,
                nulls: "first" as const,
              },
              {
                field: "outputId",
                direction: "asc" as const,
                nulls: "first" as const,
              },
              {
                field: "bucket",
                direction: "asc" as const,
                nulls: "first" as const,
              },
            ],
      ),
    }),
  };
}
