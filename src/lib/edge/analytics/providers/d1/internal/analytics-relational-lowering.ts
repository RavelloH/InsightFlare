import {
  add,
  aggregate,
  and,
  antiJoin,
  avg,
  caseWhen,
  castInteger,
  constant,
  count,
  countDistinct,
  distinct,
  div,
  eq,
  filter,
  gte,
  isNotNull,
  isNull,
  join,
  limit as limitRelation,
  max,
  min,
  mul,
  neq,
  param,
  project,
  rowNumber,
  semiJoin,
  sort as sortRelation,
  sum,
  union,
  window as windowRelation,
  windowCountRows,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  Predicate,
  SqlExpression,
} from "@/lib/db/query/expression";
import type { WindowOrderKey } from "@/lib/db/query/plan";
import type { LogicalExpr } from "@/lib/edge/analytics/engine/logical/expression";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type {
  AggregateNode,
  AnalysisResultNode,
  AntiJoinNode,
  DistinctNode,
  EventPayloadOccurrencesNode,
  JoinNode,
  LogicalNode,
  OrderedMemberNode,
  ProjectNode,
  RankedMembersNode,
  RelationshipLookupNode,
  RowConcatenationNode,
  SampleStatisticsNode,
  SemiJoinNode,
  SetOperationNode,
  SortKey,
  SourceNode,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalOutput,
  LogicalPlan,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { assertNever } from "@/lib/edge/analytics/engine/logical/plan";
import type {
  LogicalSlot,
  LogicalValueType,
} from "@/lib/edge/analytics/engine/logical/slots";
import { isSameLogicalValueType } from "@/lib/edge/analytics/engine/logical/slots";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import type { AnalyticsEntityKind } from "@/lib/edge/analytics/engine/semantic/entities";

import { nodePath, reject } from "./lowering/errors";
import { ScopedSourceLoweringPass } from "./lowering/scoped-source/scoped-source-lowering-pass";
import {
  type AnalyticsEventPayloadKeySourceBinding,
  analyticsEventPayloadMetadataProviderId,
  type AnalyticsEventPayloadPropertiesMetadataField,
  type AnalyticsProviderSourceBindingRequest,
  assertAnalyticsEventDistinctIdentityLayout,
  assertAnalyticsEventPayloadKeySchema,
} from "./analytics-event-identity-proof";
import {
  type AnalyticsDbRelation,
  AnalyticsRelationalStorage,
  type AnalyticsRelationalStorageContext,
  type LoweredAnalyticsSource,
  normalizeAnalyticsRelationalSiteIds,
} from "./analytics-relational-storage";
export { AnalyticsRelationalLoweringError } from "./lowering/errors";
import type {
  AnalysisResultQualificationBinding,
  ComparisonPageQualificationGate,
  ComparisonPageQualificationGateSide,
} from "./lowering/comparison-page-admission";
import {
  type AnalyticsQualificationAdmissionPolicy,
  applyAnalyticsQualificationAdmissionGate,
  createAnalyticsQualificationAdmittedControls,
  type EventQualificationAdmissionPolicy,
} from "./lowering/event-summary-admission";
import { lowerExpression } from "./lowering/expressions";
import {
  type EventPayloadAdmissionPacket,
  type EventPayloadAdmissionPolicy,
  type EventPayloadCountLoweringContext,
  type EventPayloadPropertiesIdentity,
  lowerEventPayloadProperties,
} from "./lowering/payload-count";
import {
  asPredicate,
  combinePredicates,
  comparableAggregateValue,
  logicalSlot,
  type LoweredRelation,
  type LoweredValue,
  numericAggregateExpression,
  projectedValues,
  type ProviderProjectionValue,
  readValue,
  relationColumn,
  scalarAggregateValue,
  scalarValue,
  slotColumn,
  type SlotLayout,
} from "./lowering/values";
import {
  buildComparisonDomainAggregate,
  type CompletedComparisonDomainAdmission,
  isComparisonDomainSingletonAggregate,
  type RegisteredComparisonAdmissionBinding,
} from "./comparison-domain-admission";

interface EventPayloadKeyProof {
  readonly request: AnalyticsProviderSourceBindingRequest;
  readonly sourceBinding: AnalyticsEventPayloadKeySourceBinding;
  readonly sourceSignature: string;
  readonly scopeRelation: RelationId;
  readonly carrierRelation: AnalyticsDbRelation;
  readonly keyColumn: string;
  readonly eventKeyLayout: SlotLayout;
  readonly metadataColumns: ReadonlyMap<
    AnalyticsEventPayloadPropertiesMetadataField,
    string
  >;
}

function valueForSlot(
  relation: AnalyticsDbRelation,
  slots: ReadonlyMap<SlotId, SlotLayout>,
  id: SlotId,
  path: string,
): LoweredValue {
  return readValue(relation, slots, id, path);
}

function keyEqual(
  left: LoweredValue,
  right: LoweredValue,
  path: string,
): Predicate {
  if (left.kind === "entity" || right.kind === "entity") {
    if (left.kind !== "entity" || right.kind !== "entity")
      reject(path, "A composite entity join key cannot match a scalar key.");
    if (left.entity !== right.entity || left.keys.length !== right.keys.length)
      reject(path, "Composite join keys have incompatible entity identities.");
    const components: Predicate[] = left.keys.map((value, index) =>
      eq(value, right.keys[index]!),
    );
    if (left.nullable) components.push(left.present);
    if (right.nullable) components.push(right.present);
    return combinePredicates("and", components, path);
  }
  return eq(left.expression, right.expression);
}

function assertNonNullableUnaryEntitySet(
  inputNode: LogicalNode,
  entry: LoweredRelation,
  logicalSlots: ReadonlyMap<SlotId, LogicalSlot>,
  path: string,
): AnalyticsEntityKind {
  if (inputNode.output.length !== 1)
    reject(path, "Only unary scoped identity sets are currently supported.");
  const slot = inputNode.output[0]!;
  const value = entry.slots.get(slot);
  const declared = logicalSlot(logicalSlots, slot, path);
  if (
    inputNode.grain.kind !== "entity" ||
    inputNode.grain.key !== slot ||
    !value ||
    value.kind !== "entity" ||
    !["observation", "session", "visitor"].includes(value.type.entity) ||
    inputNode.grain.entity !== value.type.entity ||
    declared.type.kind !== "entity" ||
    declared.type.entity !== value.type.entity ||
    declared.nullable ||
    value.nullable
  )
    reject(
      path,
      value?.kind === "entity" && value.type.entity === "session"
        ? "Set operations require a non-null composite Session key."
        : "Set operations require one non-null scoped entity identity.",
    );
  const expectedKeyWidth = value.type.entity === "observation" ? 3 : 2;
  if (value.keyColumns.length !== expectedKeyWidth)
    reject(path, "Set operation entity key has an invalid composite width.");
  return value.type.entity;
}

function logicalNodeInputs(node: LogicalNode): readonly RelationId[] {
  switch (node.kind) {
    case "source":
      return [];
    case "analysis-result":
      return [];
    case "relationship-lookup":
    case "filter":
    case "event-payload-occurrences":
    case "project":
    case "aggregate":
    case "sample-statistics":
    case "distinct":
    case "ordered-member":
    case "ranked-members":
    case "sort":
    case "limit":
      return [node.input];
    case "set-operation":
      return node.inputs;
    case "row-concatenation":
      return node.inputs;
    case "event-payload-properties":
      return [node.input];
    case "semi-join":
    case "anti-join":
    case "join":
      return [node.left, node.right];
  }
  return assertNever(node);
}

export interface LoweredAnalyticsLogicalOutput {
  readonly relation: AnalyticsDbRelation;
  readonly slots: ReadonlyMap<SlotId, SlotLayout>;
  readonly output: LogicalOutput;
  readonly candidateBounded: boolean;
  readonly candidateActivity?: "page" | "event" | "observation";
  readonly candidateActivitySessionRelation?: RelationId;
  readonly candidateActivitySessionRestricted: boolean;
  readonly relationId: RelationId;
}

export interface AnalyticsDbOutputColumn {
  readonly name: string;
  readonly slot: SlotId;
  /** Entity outputs must name a component of their physical composite key. */
  readonly component?: number;
}

/** Memoized per-node lowering from validated Analytics IR into Generic DB Relations. */
export class AnalyticsLogicalToDbLowerer {
  readonly #plan: ValidatedLogicalPlan;
  readonly #nodes: ReadonlyMap<RelationId, LogicalNode>;
  readonly #logicalSlots: ReadonlyMap<SlotId, LogicalSlot>;
  readonly #memo = new Map<RelationId, LoweredRelation>();
  readonly #eventPayloadAdmissionPackets = new Map<
    RelationId,
    EventPayloadAdmissionPacket
  >();
  readonly #loweredSources = new Map<
    string,
    {
      readonly relation: AnalyticsDbRelation;
      readonly layouts: readonly SlotLayout[];
      readonly providerLayouts: ReadonlyMap<string, string>;
    }
  >();
  readonly #sourceSelectionIds = new WeakMap<object, number>();
  #nextSourceSelectionId = 1;
  readonly #requiredSlots = new Map<RelationId, Set<SlotId>>();
  readonly #requiredProviderSourceBindings = new Map<
    RelationId,
    readonly AnalyticsProviderSourceBindingRequest[]
  >();
  readonly #eventPayloadKeyRequestsByOccurrence = new Map<
    RelationId,
    AnalyticsProviderSourceBindingRequest
  >();
  readonly #eventPayloadKeyRequestsByProperties = new Map<
    RelationId,
    AnalyticsProviderSourceBindingRequest
  >();
  readonly #eventPayloadKeyProofs = new Map<
    RelationId,
    ReadonlyMap<string, EventPayloadKeyProof>
  >();
  readonly #analysisResultOutputs = new WeakMap<
    LogicalPlan,
    Map<string, LoweredAnalyticsLogicalOutput>
  >();
  readonly #analysisResultQualificationBindings = new Map<
    LogicalPlan,
    AnalysisResultQualificationBinding
  >();
  readonly #analysisResultQualificationLowerers = new WeakMap<
    LogicalPlan,
    AnalyticsLogicalToDbLowerer
  >();
  readonly #comparisonPageQualificationGate:
    ComparisonPageQualificationGate | undefined;
  readonly #comparisonAdmissionBinding:
    RegisteredComparisonAdmissionBinding | undefined;
  #comparisonAdmissionEvidence: CompletedComparisonDomainAdmission | undefined;
  #comparisonAdmissionEvidenceTaken = false;
  readonly #storageContext: AnalyticsRelationalStorageContext;
  readonly #storage: AnalyticsRelationalStorage;
  readonly #scopedSourceLowering: ScopedSourceLoweringPass;
  readonly #eventPayloadAdmissionPolicy:
    EventPayloadAdmissionPolicy | undefined;
  readonly #qualificationAdmissionPolicy:
    AnalyticsQualificationAdmissionPolicy | undefined;
  #qualificationAdmittedControls: AnalyticsDbRelation | undefined;
  #loweringQualificationControls = false;
  readonly #qualificationAdmissionUngatedNodes = new Set<RelationId>();

  constructor(
    plan: ValidatedLogicalPlan,
    storageContext: AnalyticsRelationalStorageContext,
    options: {
      readonly eventPayloadAdmissionPolicy?: EventPayloadAdmissionPolicy;
      readonly eventQualificationAdmissionPolicy?: EventQualificationAdmissionPolicy;
      readonly analyticsQualificationAdmissionPolicy?: AnalyticsQualificationAdmissionPolicy;
      readonly analysisResultQualificationBindings?: readonly AnalysisResultQualificationBinding[];
      readonly comparisonPageQualificationGate?: ComparisonPageQualificationGate;
      readonly comparisonDomainAdmissionBinding?: RegisteredComparisonAdmissionBinding;
    } = {},
  ) {
    this.#plan = plan;
    this.#storageContext = storageContext;
    this.#comparisonAdmissionBinding = options.comparisonDomainAdmissionBinding;
    if (
      this.#comparisonAdmissionBinding &&
      !this.#comparisonAdmissionBinding.attach(this, plan)
    )
      reject(
        "options.comparisonDomainAdmissionBinding",
        "The comparison admission binding must be unused and target this exact frozen plan.",
      );
    this.#eventPayloadAdmissionPolicy = options.eventPayloadAdmissionPolicy;
    if (
      options.eventQualificationAdmissionPolicy &&
      options.analyticsQualificationAdmissionPolicy
    )
      reject(
        "options",
        "Only one analytics qualification admission policy may be supplied.",
      );
    this.#qualificationAdmissionPolicy =
      options.analyticsQualificationAdmissionPolicy ??
      (options.eventQualificationAdmissionPolicy
        ? {
            ...options.eventQualificationAdmissionPolicy,
            primaryReportSourceRelationId:
              options.eventQualificationAdmissionPolicy.eventSourceRelationId,
          }
        : undefined);
    for (const binding of options.analysisResultQualificationBindings ?? []) {
      const importedChildNodes = plan.nodes.filter(
        (node): node is AnalysisResultNode =>
          node.kind === "analysis-result" &&
          node.childPlan === binding.childPlan,
      );
      const reportOutputIds = [...binding.reportOutputIds];
      const reportOutputIdSet = new Set(reportOutputIds);
      const reportOutputs = reportOutputIds.map((outputId) =>
        binding.childPlan.outputs.find((output) => output.id === outputId),
      );
      const controlsOutput = binding.childPlan.outputs.find(
        (output) => output.id === binding.controlsOutputId,
      );
      const importedOutputIds = new Set(
        importedChildNodes.map((node) => node.outputId),
      );
      const reportRelationIds = [
        ...new Set(
          reportOutputs.flatMap((output) => (output ? [output.relation] : [])),
        ),
      ];
      const policyReportRelationIds = [...binding.policy.reportRelationIds];
      const importedOutputsAreApproved = [...importedOutputIds].every(
        (outputId) =>
          reportOutputIdSet.has(outputId) ||
          outputId === binding.controlsOutputId,
      );
      const reportRelationsMatchPolicy =
        new Set(policyReportRelationIds).size ===
          policyReportRelationIds.length &&
        reportRelationIds.length === policyReportRelationIds.length &&
        reportRelationIds.every((relationId) =>
          policyReportRelationIds.includes(relationId),
        );
      if (
        importedChildNodes.length === 0 ||
        reportOutputIds.length === 0 ||
        reportOutputIdSet.size !== reportOutputIds.length ||
        reportOutputs.some((output) => output === undefined) ||
        !reportOutputIds.every((outputId) => importedOutputIds.has(outputId)) ||
        !importedChildNodes.some(
          (node) => node.outputId === binding.controlsOutputId,
        ) ||
        reportOutputIdSet.has(binding.controlsOutputId) ||
        !controlsOutput ||
        binding.policy.controlsRelationId !== controlsOutput.relation ||
        !importedOutputsAreApproved ||
        !reportRelationsMatchPolicy
      )
        reject(
          "options.analysisResultQualificationBindings",
          "Each qualification binding must approve imported report outputs and controls from the exact child snapshot, with an exact report relation policy.",
        );
      if (this.#analysisResultQualificationBindings.has(binding.childPlan))
        reject(
          "options.analysisResultQualificationBindings",
          "Each imported child snapshot must have one qualification binding.",
        );
      const policy = Object.freeze({
        ...binding.policy,
        reportSourceRelations: Object.freeze(
          binding.policy.reportSourceRelations.map((source) =>
            Object.freeze({ ...source }),
          ),
        ),
        reportRelationIds: Object.freeze(policyReportRelationIds),
        controlSlots: Object.freeze(
          binding.policy.controlSlots.map((slot) => Object.freeze({ ...slot })),
        ),
        numericCompatibilityControlNames: Object.freeze([
          ...binding.policy.numericCompatibilityControlNames,
        ]),
      });
      this.#analysisResultQualificationBindings.set(
        binding.childPlan,
        Object.freeze({
          childPlan: binding.childPlan,
          reportOutputIds: Object.freeze(reportOutputIds),
          controlsOutputId: binding.controlsOutputId,
          policy,
        }),
      );
    }
    this.#comparisonPageQualificationGate =
      options.comparisonPageQualificationGate;
    let subjectSiteIds: readonly string[];
    let storageSiteIds: readonly string[];
    try {
      subjectSiteIds = normalizeAnalyticsRelationalSiteIds({
        siteIds: plan.context.subject.siteIds,
        time: plan.context.time,
      });
      storageSiteIds = normalizeAnalyticsRelationalSiteIds(storageContext);
    } catch (error) {
      reject(
        "context.subject",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (
      subjectSiteIds.length !== storageSiteIds.length ||
      subjectSiteIds.some((siteId, index) => siteId !== storageSiteIds[index])
    )
      reject(
        "context.subject",
        "Storage site IDs must exactly match the authorized Semantic subject.",
      );
    this.#nodes = new Map(plan.nodes.map((node) => [node.id, node] as const));
    this.#logicalSlots = new Map(
      plan.slots.map((slot) => [slot.id, slot] as const),
    );
    this.#storage = new AnalyticsRelationalStorage(storageContext);
    this.#scopedSourceLowering = new ScopedSourceLoweringPass(
      storageContext,
      plan.nodes.filter((node): node is SourceNode => node.kind === "source"),
    );
  }

  #sourceSelectionId(selection: object | undefined): number | null {
    if (!selection) return null;
    const existing = this.#sourceSelectionIds.get(selection);
    if (existing !== undefined) return existing;
    const next = this.#nextSourceSelectionId++;
    this.#sourceSelectionIds.set(selection, next);
    return next;
  }

  #eventPayloadSource(
    relation: RelationId,
    eventKey: SlotId,
    path: string,
  ): SourceNode {
    const active = new Set<RelationId>();
    let current = relation;
    while (true) {
      if (active.has(current))
        reject(path, "Payload key ancestry contains a relation cycle.");
      active.add(current);
      const node = this.#nodes.get(current);
      if (!node)
        reject(path, "Payload key ancestry lost its Event identity slot.");
      const eventKeySlot = this.#logicalSlots.get(eventKey);
      const preservesEventIdentity =
        node.grain.kind === "entity" &&
        node.grain.entity === "event" &&
        node.grain.key === eventKey &&
        node.output.includes(eventKey) &&
        eventKeySlot?.type.kind === "entity" &&
        eventKeySlot.type.entity === "event" &&
        !eventKeySlot.nullable;
      if (!preservesEventIdentity)
        reject(path, "Payload key ancestry lost its Event identity slot.");
      if (node.kind === "filter") {
        current = node.input;
        continue;
      }
      if (node.kind === "semi-join") {
        const left = this.#nodes.get(node.left);
        if (
          !left ||
          left.grain.kind !== "entity" ||
          left.grain.entity !== "event" ||
          left.grain.key !== eventKey ||
          left.output.length !== node.output.length ||
          left.output.some((slot, index) => node.output[index] !== slot)
        )
          reject(
            path,
            "Payload key membership ancestry does not preserve the left Event rows.",
          );
        current = node.left;
        continue;
      }
      if (
        node.kind !== "source" ||
        node.entity !== "event" ||
        node.grain.kind !== "entity" ||
        node.grain.entity !== "event" ||
        node.grain.key !== eventKey ||
        !node.values.some(
          (binding) => binding.kind === "self" && binding.slot === eventKey,
        )
      )
        reject(
          path,
          "Payload key request requires the canonical Event Source ancestry.",
        );
      return node;
    }
  }

  lower(output: LogicalOutput): LoweredAnalyticsLogicalOutput {
    return this.lowerMany([output])[0]!;
  }

  /** Lowers related outputs with one required-slot analysis and shared memo. */
  lowerMany(
    outputs: readonly LogicalOutput[],
  ): readonly LoweredAnalyticsLogicalOutput[] {
    const binding = this.#comparisonAdmissionBinding;
    if (
      binding &&
      !binding.begin(
        this,
        this.#plan,
        this.#reachableNodeIds(outputs.map((output) => output.relation)),
      )
    )
      reject(
        "outputs",
        "The comparison admission binding must match the selected relation graph and may be consumed only once.",
      );
    this.#comparisonAdmissionEvidence = undefined;
    this.#comparisonAdmissionEvidenceTaken = false;
    try {
      let lowered = this.#lowerManyCore(outputs);
      if (binding) {
        const comparisonInput = binding.materialize(this, this);
        if (!comparisonInput)
          reject(
            "outputs",
            "The current lowerMany call did not materialize its comparison admission evidence.",
          );
        const policy = this.#qualificationAdmissionPolicy;
        if (!policy || policy.reportRelationIds.length === 0)
          reject(
            "outputs",
            "Comparison admission requires the exact provider report relation policy.",
          );
        const aggregate = buildComparisonDomainAggregate(comparisonInput);
        const outputNames = comparisonInput.values.map(
          ({ outputName }) => outputName,
        );
        if (!isComparisonDomainSingletonAggregate(aggregate, outputNames))
          reject(
            "outputs",
            "Comparison admission requires one ungrouped counter aggregate row.",
          );
        const mismatchFree = comparisonInput.values.map(({ outputName }) => {
          const value = aggregate.columns[outputName];
          if (!value)
            reject("outputs", "Comparison aggregate output is missing.");
          return eq(value, param(0));
        });
        if (mismatchFree.length === 0)
          reject(
            "outputs",
            "Comparison admission requires non-empty evidence.",
          );
        const comparisonGate = mismatchFree
          .slice(1)
          .reduce((gate, value) => and(gate, value), mismatchFree[0]!);
        const admittedAggregate = filter(aggregate, comparisonGate);
        const membershipCondition = eq(constant(1), constant(1));
        const reportRelationIds = new Set(policy.reportRelationIds);
        const gatedReports = lowered.filter((output) =>
          reportRelationIds.has(output.output.relation),
        );
        if (gatedReports.length !== reportRelationIds.size)
          reject(
            "outputs",
            "Comparison admission must gate every selected provider report output exactly once.",
          );
        lowered = lowered.map((output) =>
          reportRelationIds.has(output.output.relation)
            ? {
                ...output,
                relation: semiJoin(
                  output.relation,
                  admittedAggregate,
                  membershipCondition,
                ),
              }
            : output,
        );
        this.#comparisonAdmissionEvidence = Object.freeze({
          input: comparisonInput,
          aggregate,
        });
      }
      return lowered;
    } finally {
      if (binding) binding.finish(this);
    }
  }

  #lowerManyCore(
    outputs: readonly LogicalOutput[],
  ): readonly LoweredAnalyticsLogicalOutput[] {
    if (outputs.length === 0)
      reject("outputs", "At least one Logical output is required.");
    const selectedNodes = this.#reachableNodeIds(
      outputs.map((output) => output.relation),
    );
    const admissionPolicy = this.#eventPayloadAdmissionPolicy;
    if (admissionPolicy) {
      const properties = this.#nodes.get(admissionPolicy.propertiesRelation);
      if (
        properties?.kind !== "event-payload-properties" ||
        !selectedNodes.has(admissionPolicy.propertiesRelation) ||
        !Number.isSafeInteger(admissionPolicy.maximumNodes) ||
        admissionPolicy.maximumNodes <= 0 ||
        !Number.isSafeInteger(admissionPolicy.maximumNodes + 1)
      )
        reject(
          nodePath(admissionPolicy.propertiesRelation),
          "Provider payload admission must target one reachable Properties relation with a safe M+1 maximum.",
        );
    }
    const declaredOutputNodes = this.#reachableNodeIds(
      this.#plan.outputs.map((candidate) => candidate.relation),
    );
    const orphan = this.#plan.nodes.find(
      (node) => !declaredOutputNodes.has(node.id),
    );
    if (orphan)
      reject(
        nodePath(orphan.id),
        "Every relational and Boolean node must be reachable from a declared output.",
      );

    // A multi-output caller needs the union of required slots on shared nodes.
    // Lower all roots after that union is known so they share one source graph.
    this.#memo.clear();
    this.#qualificationAdmittedControls = undefined;
    this.#qualificationAdmissionUngatedNodes.clear();
    this.#eventPayloadAdmissionPackets.clear();
    this.#prepareRequiredSlots(outputs, selectedNodes);
    let roots = outputs.map((output) => this.#lowerNode(output.relation));
    if (this.#memo.size !== selectedNodes.size) {
      const unreachable = this.#plan.nodes.find(
        (node) => selectedNodes.has(node.id) && !this.#memo.has(node.id),
      );
      reject(
        unreachable ? nodePath(unreachable.id) : "nodes",
        "Every relation in the selected output dependency graph must be lowered.",
      );
    }
    const qualificationPolicy = this.#qualificationAdmissionPolicy;
    if (qualificationPolicy) {
      const primaryReportSource = this.#nodes.get(
        qualificationPolicy.primaryReportSourceRelationId,
      );
      const controls = this.#nodes.get(qualificationPolicy.controlsRelationId);
      const controlRoots = outputs.filter(
        (output) => output.relation === qualificationPolicy.controlsRelationId,
      );
      const reportRelationIds = new Set(qualificationPolicy.reportRelationIds);
      const reportSourceRelationIds = new Set(
        qualificationPolicy.reportSourceRelations.map(
          ({ relationId }) => relationId,
        ),
      );
      const reportRoots = outputs.filter((output) =>
        reportRelationIds.has(output.relation),
      );
      const reportSourcesValid =
        qualificationPolicy.reportSourceRelations.length > 0 &&
        reportSourceRelationIds.size ===
          qualificationPolicy.reportSourceRelations.length &&
        qualificationPolicy.reportSourceRelations.every(
          ({ relationId, entity }) => {
            const source = this.#nodes.get(relationId);
            return (
              source?.kind === "source" &&
              source.entity === entity &&
              selectedNodes.has(relationId)
            );
          },
        );
      const qualifiedScopeValid =
        ((qualificationPolicy.scope === "session" ||
          qualificationPolicy.scope === "visitor") &&
          qualificationPolicy.candidateGrain === undefined) ||
        (qualificationPolicy.scope === "event" &&
          qualificationPolicy.candidateGrain === "event-candidate" &&
          primaryReportSource?.kind === "source" &&
          primaryReportSource.entity === "event" &&
          qualificationPolicy.reportSourceRelations.length === 1 &&
          qualificationPolicy.reportSourceRelations[0]?.entity === "event");
      if (
        primaryReportSource?.kind !== "source" ||
        (primaryReportSource.entity !== "event" &&
          primaryReportSource.entity !== "page") ||
        controls?.kind === undefined ||
        !selectedNodes.has(qualificationPolicy.primaryReportSourceRelationId) ||
        !reportSourcesValid ||
        !reportSourceRelationIds.has(
          qualificationPolicy.primaryReportSourceRelationId,
        ) ||
        !qualificationPolicy.reportSourceRelations.some(
          ({ relationId, entity }) =>
            relationId === qualificationPolicy.primaryReportSourceRelationId &&
            entity === primaryReportSource.entity,
        ) ||
        !selectedNodes.has(qualificationPolicy.controlsRelationId) ||
        controlRoots.length !== 1 ||
        qualificationPolicy.reportRelationIds.length === 0 ||
        reportRelationIds.size !==
          qualificationPolicy.reportRelationIds.length ||
        reportRoots.length !== qualificationPolicy.reportRelationIds.length ||
        qualificationPolicy.reportRelationIds.some(
          (relationId) =>
            !selectedNodes.has(relationId) ||
            relationId === qualificationPolicy.controlsRelationId ||
            !outputs.some((output) => output.relation === relationId),
        ) ||
        !Number.isSafeInteger(qualificationPolicy.maximumActivities) ||
        qualificationPolicy.maximumActivities < 0 ||
        !qualifiedScopeValid
      )
        reject(
          "outputs",
          "Provider analytics qualification admission must target its exact reachable primary Page/Event Source, report Sources, and one reachable controls output.",
        );
      const controlSlotIds = new Set(controls.output.map(String));
      const controlNames = new Set(
        qualificationPolicy.controlSlots.map(({ name }) => name),
      );
      const requiredControlSlots = [
        "rawCount",
        "nullActivityIdCount",
        "siteIdentityMismatchCount",
        "entityKind",
        "invalidIdentityCount",
        "duplicateIdentityCount",
        ...qualificationPolicy.numericCompatibilityControlNames,
      ];
      if (
        requiredControlSlots.some((slot) => !controlNames.has(slot)) ||
        qualificationPolicy.controlSlots.some(
          ({ slot }) => !controlSlotIds.has(String(slot)),
        ) ||
        new Set(qualificationPolicy.controlSlots.map(({ name }) => name))
          .size !== qualificationPolicy.controlSlots.length ||
        new Set(qualificationPolicy.numericCompatibilityControlNames).size !==
          qualificationPolicy.numericCompatibilityControlNames.length
      )
        reject(
          nodePath(qualificationPolicy.controlsRelationId),
          "Provider analytics qualification controls do not match the declared admission policy.",
        );
    }
    if (
      admissionPolicy &&
      !this.#eventPayloadAdmissionPackets.has(
        admissionPolicy.propertiesRelation,
      )
    )
      reject(
        nodePath(admissionPolicy.propertiesRelation),
        "The selected payload Properties relation did not produce its admission packet.",
      );
    const comparisonGate = this.#comparisonPageQualificationGate;
    if (comparisonGate) {
      const reportIndexes = outputs.flatMap((output, index) =>
        output.relation === comparisonGate.reportRelationId ? [index] : [],
      );
      const controlIndexes = comparisonGate.sides.map((side) =>
        outputs.flatMap((output, index) =>
          output.relation === side.controlsRelationId ? [index] : [],
        ),
      );
      const controlRelationIds = comparisonGate.sides.map(
        ({ controlsRelationId }) => controlsRelationId,
      );
      if (
        reportIndexes.length !== 1 ||
        comparisonGate.sides.length < 1 ||
        comparisonGate.sides.length > 2 ||
        new Set(comparisonGate.sides.map(({ side }) => side)).size !==
          comparisonGate.sides.length ||
        new Set(controlRelationIds).size !== controlRelationIds.length ||
        controlRelationIds.includes(comparisonGate.reportRelationId) ||
        controlIndexes.some((indexes) => indexes.length !== 1) ||
        !selectedNodes.has(comparisonGate.reportRelationId) ||
        controlRelationIds.some((relationId) => !selectedNodes.has(relationId))
      )
        reject(
          "options.comparisonPageQualificationGate",
          "The final comparison report and each qualified-side controls output must be selected exactly once.",
        );
      const reportNode = this.#nodes.get(comparisonGate.reportRelationId);
      if (reportNode?.grain.kind !== "keyed")
        reject(
          nodePath(comparisonGate.reportRelationId),
          "The comparison admission gate requires its keyed report relation.",
        );
      const admittedControls = comparisonGate.sides.map((side, index) => {
        const controlsNode = this.#nodes.get(side.controlsRelationId);
        if (
          controlsNode?.kind !== "analysis-result" ||
          controlsNode.grain.kind !== "scalar"
        )
          reject(
            "options.comparisonPageQualificationGate",
            "Each final comparison control must be a scalar imported qualified child output.",
          );
        return this.#lowerComparisonAdmittedControls(
          roots[controlIndexes[index]![0]!]!,
          side,
          nodePath(side.controlsRelationId),
        );
      });
      const reportIndex = reportIndexes[0]!;
      const report = roots[reportIndex]!;
      const gated = admittedControls.reduce(
        (relation, controls) =>
          applyAnalyticsQualificationAdmissionGate(relation, controls),
        report.relation,
      );
      roots = roots.map((root, index) =>
        index === reportIndex ? { ...root, relation: gated } : root,
      );
    }
    return outputs.map((output, index) => {
      const root = roots[index]!;
      const outputNode = this.#nodes.get(output.relation);
      const outputValue = output.fields[0]
        ? root.slots.get(output.fields[0].slot)
        : undefined;
      return {
        relation: root.relation,
        slots: root.slots,
        output,
        candidateBounded:
          output.fields.length === 1 &&
          outputValue?.kind === "entity" &&
          outputValue.type.entity === "session" &&
          outputValue.candidateBounded,
        candidateActivity: root.candidateActivity,
        candidateActivitySessionRelation: root.candidateActivitySessionRelation,
        candidateActivitySessionRestricted:
          root.candidateActivitySessionRestricted,
        relationId: outputNode?.id ?? output.relation,
      };
    });
  }

  eventPayloadAdmissionPacket(
    propertiesRelation: RelationId,
  ): EventPayloadAdmissionPacket | undefined {
    return this.#eventPayloadAdmissionPackets.get(propertiesRelation);
  }

  readComparisonAdmissionInput(
    relationId: RelationId,
    slotId: SlotId,
  ):
    | {
        readonly relation: AnalyticsDbRelation;
        readonly valueColumn: string;
      }
    | undefined {
    const lowered = this.#memo.get(relationId);
    const layout = lowered?.slots.get(slotId);
    if (
      !lowered ||
      layout?.kind !== "scalar" ||
      layout.type.kind !== "scalar" ||
      layout.type.scalar !== "string"
    )
      return undefined;
    const value = valueForSlot(
      lowered.relation,
      lowered.slots,
      slotId,
      nodePath(relationId),
    );
    if (
      value.kind !== "scalar" ||
      value.type.kind !== "scalar" ||
      value.type.scalar !== "string"
    )
      return undefined;
    return {
      relation: lowered.relation,
      valueColumn: layout.valueColumn,
    };
  }

  takeComparisonDomainAdmissionEvidence():
    CompletedComparisonDomainAdmission | undefined {
    if (
      !this.#comparisonAdmissionBinding ||
      !this.#comparisonAdmissionEvidence ||
      this.#comparisonAdmissionEvidenceTaken
    )
      return undefined;
    this.#comparisonAdmissionEvidenceTaken = true;
    return this.#comparisonAdmissionEvidence;
  }

  /** Returns a Generic relation only for a node lowered in the current demand. */
  loweredRelationForPlan(
    relationId: RelationId,
  ): AnalyticsDbRelation | undefined {
    return this.#memo.get(relationId)?.relation;
  }

  /** Resolves only a selected relation from the exact frozen bound child snapshot. */
  loweredRelationForImportedChildPlan(
    childPlan: LogicalPlan,
    relationId: RelationId,
  ): AnalyticsDbRelation | undefined {
    if (
      !Object.isFrozen(childPlan) ||
      !this.#analysisResultQualificationBindings.has(childPlan)
    )
      return undefined;
    const childLowerer =
      this.#analysisResultQualificationLowerers.get(childPlan);
    return childLowerer?.loweredRelationForPlan(relationId);
  }

  #reachableNodeIds(roots: readonly RelationId[]): Set<RelationId> {
    const reachable = new Set<RelationId>();
    const pending = [...roots];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (reachable.has(id)) continue;
      const node = this.#nodes.get(id);
      if (!node)
        reject(nodePath(id), "The relation references a missing node.");
      reachable.add(id);
      pending.push(...logicalNodeInputs(node));
    }
    return reachable;
  }

  lowerSourceValue(
    lowered: LoweredAnalyticsLogicalOutput,
    slot: SlotId,
    path: string,
  ): LoweredValue {
    return valueForSlot(lowered.relation, lowered.slots, slot, path);
  }

  projectOutput(
    lowered: LoweredAnalyticsLogicalOutput,
    columns: readonly AnalyticsDbOutputColumn[],
  ): AnalyticsDbRelation {
    const projections: Record<string, AnyExpression> = {};
    for (const { name, slot, component } of columns) {
      if (Object.hasOwn(projections, name))
        reject(
          "outputs",
          `Output column ${JSON.stringify(name)} is duplicated.`,
        );
      const value = this.lowerSourceValue(
        lowered,
        slot,
        `outputs.${JSON.stringify(name)}`,
      );
      if (value.kind === "scalar") {
        if (component !== undefined)
          reject(
            "outputs",
            `Scalar output ${JSON.stringify(name)} has no key component.`,
          );
        projections[name] = value.expression;
      } else {
        if (
          component === undefined ||
          !Number.isSafeInteger(component) ||
          component < 0 ||
          component >= value.keys.length
        )
          reject(
            "outputs",
            `Entity output ${JSON.stringify(name)} requires a valid key component.`,
          );
        projections[name] = value.keys[component]!;
      }
    }
    return project(lowered.relation, projections);
  }

  isCandidateBoundedSlot(relation: RelationId, slot: SlotId): boolean {
    return this.#lowerNode(relation).slots.get(slot)?.candidateBounded === true;
  }

  candidateActivity(
    relation: RelationId,
  ): "page" | "event" | "observation" | undefined {
    return this.#lowerNode(relation).candidateActivity;
  }

  isCandidateActivitySessionRestricted(relation: RelationId): boolean {
    return (
      this.#lowerNode(relation).candidateActivitySessionRelation !== undefined
    );
  }

  candidateActivitySessionRelation(
    relation: RelationId,
  ): RelationId | undefined {
    return this.#lowerNode(relation).candidateActivitySessionRelation;
  }

  #rebindEventDistinctIdentityLayouts(
    input: LoweredRelation,
    relation: AnalyticsDbRelation,
    inputScope: RelationId,
    outputScope: RelationId,
    path: string,
  ): LoweredRelation {
    const slots = new Map(input.slots);
    for (const [slot, layout] of input.slots) {
      if (layout.kind !== "entity" || !layout.providerDistinctIdentity)
        continue;
      const proof = layout.providerDistinctIdentity;
      if (
        proof.identitySlot !== slot ||
        proof.scopeRelation !== inputScope ||
        proof.carrierRelation !== input.relation ||
        proof.identityColumns[0] !== layout.keyColumns[0] ||
        proof.identityColumns[1] !== layout.keyColumns[1] ||
        !relation.columns[proof.identityColumns[0]] ||
        !relation.columns[proof.identityColumns[1]] ||
        !relation.columns[proof.discriminatorColumn]
      )
        reject(
          path,
          "A row-preserving relation cannot rebind a mismatched Event identity proof.",
        );
      slots.set(slot, {
        ...layout,
        providerDistinctIdentity: {
          ...proof,
          scopeRelation: outputScope,
          carrierRelation: relation,
        },
      });
    }
    return { ...input, relation, slots };
  }

  #eventPayloadCountContext(): EventPayloadCountLoweringContext {
    return {
      logicalSlots: this.#logicalSlots,
      storage: this.#storage,
      lowerNode: (id) => this.#lowerNode(id),
      requiredOutput: (node) => this.#requiredOutput(node),
      eventPayloadIdentity: (
        propertiesRelation,
        sourceRelation,
        eventKey,
        input,
        path,
      ) =>
        this.#eventPayloadPropertiesIdentity(
          propertiesRelation,
          sourceRelation,
          eventKey,
          input,
          path,
        ),
      ...(this.#eventPayloadAdmissionPolicy
        ? { admissionPolicy: this.#eventPayloadAdmissionPolicy }
        : {}),
      admissionPackets: {
        get: (node) => this.#eventPayloadAdmissionPackets.get(node),
        set: (node, packet) => {
          this.#eventPayloadAdmissionPackets.set(node, packet);
        },
      },
    };
  }

  #lowerNode(id: RelationId): LoweredRelation {
    const existing = this.#memo.get(id);
    if (existing) {
      if (
        !this.#loweringQualificationControls &&
        this.#qualificationAdmissionUngatedNodes.has(id)
      ) {
        const node = this.#nodes.get(id);
        if (!node)
          reject(nodePath(id), "The relation references a missing node.");
        const gated = this.#applyQualificationAdmissionGate(
          node,
          existing,
          nodePath(id),
        );
        this.#qualificationAdmissionUngatedNodes.delete(id);
        this.#memo.set(id, gated);
        return gated;
      }
      return existing;
    }
    const node = this.#nodes.get(id);
    if (!node) reject(nodePath(id), "The relation references a missing node.");
    const path = nodePath(id);
    let result: LoweredRelation;
    switch (node.kind) {
      case "source":
        result = this.#lowerSource(node, path);
        break;
      case "analysis-result":
        result = this.#lowerAnalysisResult(node, path);
        break;
      case "relationship-lookup":
        result = this.#lowerRelationshipLookup(node, path);
        break;
      case "filter": {
        const input = this.#lowerNode(node.input);
        const visible = new Map(input.slots);
        const predicate = asPredicate(
          scalarValue(
            lowerExpression(
              node.predicate,
              input.relation,
              this.#logicalSlots,
              visible,
              `${path}.predicate`,
              this.#plan.context.time,
              this.#comparisonAdmissionBinding
                ? {
                    binding: this.#comparisonAdmissionBinding,
                    owner: this,
                    relationId: node.input,
                  }
                : undefined,
            ),
            `${path}.predicate`,
          ),
          `${path}.predicate`,
        );
        const filtered: AnalyticsDbRelation = filter(input.relation, predicate);
        const values = node.output
          .filter((slot) => this.#requiredOutput(node).has(slot))
          .map((slot) => ({
            slot,
            value: readValue(filtered, input.slots, slot, path),
          }));
        const inputProofs = this.#eventPayloadKeyProofs.get(node.input);
        const providerValues: ProviderProjectionValue[] = [];
        for (const [id, proof] of inputProofs ?? []) {
          if (
            !node.output.includes(proof.request.eventKeySlot) ||
            proof.carrierRelation !== input.relation ||
            input.providerColumns?.get(id) !== proof.keyColumn
          )
            reject(
              path,
              "A transparent Filter cannot propagate a mismatched Event payload key carrier.",
            );
          const inputColumn = proof.keyColumn;
          const expression = relationColumn(filtered, inputColumn, path);
          providerValues.push({
            id,
            expression,
            ...(proof.metadataColumns.size > 0
              ? {
                  additionalValues: [...proof.metadataColumns.entries()].map(
                    ([field, column]) => ({
                      id: analyticsEventPayloadMetadataProviderId(id, field),
                      expression: relationColumn(filtered, column, path),
                    }),
                  ),
                }
              : {}),
          });
        }
        for (const [slot, layout] of input.slots) {
          if (layout.kind !== "entity" || !layout.providerDistinctIdentity)
            continue;
          const proof = layout.providerDistinctIdentity;
          if (!node.output.includes(slot)) continue;
          if (
            layout.type.entity !== "event" ||
            layout.nullable ||
            proof.identitySlot !== slot ||
            proof.scopeRelation !== node.input ||
            proof.carrierRelation !== input.relation ||
            proof.identityColumns[0] !== layout.keyColumns[0] ||
            proof.identityColumns[1] !== layout.keyColumns[1]
          )
            reject(
              path,
              "A transparent Filter cannot propagate a mismatched Event distinct identity proof.",
            );
          providerValues.push({
            id: proof.sourceBinding.request.id,
            expression: relationColumn(
              filtered,
              proof.discriminatorColumn,
              path,
            ),
            identitySlot: slot,
            identitySeed: {
              sourceBinding: proof.sourceBinding,
              sourceSignature: proof.sourceSignature,
              sourceId: proof.sourceId,
              eventKeySlot: proof.eventKeySlot,
              identitySlot: slot,
              scopeRelation: node.id,
              inputRelation: filtered,
              inputIdentityColumns: proof.identityColumns,
              inputDiscriminatorColumn: proof.discriminatorColumn,
            },
          });
        }
        const projected = projectedValues(
          filtered,
          values,
          this.#logicalSlots,
          path,
          providerValues,
        );
        if (inputProofs && inputProofs.size > 0) {
          const proofs = new Map<string, EventPayloadKeyProof>();
          for (const [id, proof] of inputProofs) {
            const keyColumn = projected.providerColumns?.get(id);
            const eventKeyLayout = projected.slots.get(
              proof.request.eventKeySlot,
            );
            if (!keyColumn || !eventKeyLayout)
              reject(
                path,
                "A transparent Filter lost its Event payload key layout.",
              );
            proofs.set(id, {
              ...proof,
              scopeRelation: node.id,
              carrierRelation: projected.relation,
              keyColumn,
              eventKeyLayout,
              metadataColumns: new Map(
                [...proof.metadataColumns.keys()].map((field) => {
                  const column = projected.providerColumns?.get(
                    analyticsEventPayloadMetadataProviderId(id, field),
                  );
                  if (!column)
                    reject(
                      path,
                      "A transparent Filter lost hidden Event payload metadata.",
                    );
                  return [field, column] as const;
                }),
              ),
            });
          }
          this.#eventPayloadKeyProofs.set(node.id, proofs);
        }
        result = {
          ...projected,
          candidateActivity: input.candidateActivity,
          candidateActivitySessionRelation:
            input.candidateActivitySessionRelation,
          candidateActivitySessionRestricted:
            input.candidateActivitySessionRestricted,
        };
        break;
      }
      case "event-payload-occurrences":
        result = this.#lowerEventPayloadOccurrences(node, path);
        break;
      case "event-payload-properties":
        result = lowerEventPayloadProperties(
          node,
          path,
          this.#eventPayloadCountContext(),
        );
        break;
      case "project":
        result = this.#lowerProject(node, path);
        break;
      case "ordered-member":
        result = this.#lowerOrderedMember(node, path);
        break;
      case "ranked-members":
        result = this.#lowerRankedMembers(node, path);
        break;
      case "distinct":
        result = this.#lowerDistinct(node, path);
        break;
      case "set-operation":
        result = this.#lowerSetOperation(node, path);
        break;
      case "row-concatenation":
        result = this.#lowerRowConcatenation(node, path);
        break;
      case "semi-join":
      case "anti-join":
        result = this.#lowerMembershipJoin(node, path);
        break;
      case "aggregate":
        result = this.#lowerAggregate(node, path);
        break;
      case "sample-statistics":
        result = this.#lowerSampleStatistics(node, path);
        break;
      case "join":
        result = this.#lowerJoin(node, path);
        break;
      case "sort": {
        const input = this.#lowerNode(node.input);
        const keys: {
          readonly expression: SqlExpression;
          readonly direction: "ASC" | "DESC";
        }[] = [];
        node.keys.forEach((key, index) => {
          const keyPath = `${path}.keys[${index}]`;
          const logical = logicalSlot(
            this.#logicalSlots,
            key.slot,
            `${keyPath}.slot`,
          );
          if (logical.type.kind !== "scalar" && logical.type.kind !== "bucket")
            reject(keyPath, "Sort keys must be scalar or bucket values.");
          const value = readValue(
            input.relation,
            input.slots,
            key.slot,
            `${keyPath}.slot`,
          );
          if (value.kind !== "scalar")
            reject(keyPath, "Sort keys must be scalar values.");
          const direction = key.direction === "asc" ? "ASC" : "DESC";
          const nativeNulls = key.direction === "asc" ? "first" : "last";
          if (key.nulls !== nativeNulls) {
            keys.push({
              expression: isNull(value.expression),
              direction: key.nulls === "first" ? "DESC" : "ASC",
            });
          }
          keys.push({ expression: value.expression, direction });
        });
        const sorted = sortRelation(input.relation, keys);
        result = this.#rebindEventDistinctIdentityLayouts(
          input,
          sorted,
          node.input,
          node.id,
          path,
        );
        break;
      }
      case "limit": {
        const input = this.#lowerNode(node.input);
        const limited = limitRelation(input.relation, node.count);
        result = this.#rebindEventDistinctIdentityLayouts(
          input,
          limited,
          node.input,
          node.id,
          path,
        );
        break;
      }
    }
    const qualificationPolicy = this.#qualificationAdmissionPolicy;
    if (
      qualificationPolicy &&
      ((node.kind === "source" &&
        qualificationPolicy.reportSourceRelations.some(
          ({ relationId }) => relationId === node.id,
        )) ||
        qualificationPolicy.reportRelationIds.includes(node.id))
    ) {
      if (this.#loweringQualificationControls) {
        this.#qualificationAdmissionUngatedNodes.add(id);
      } else {
        result = this.#applyQualificationAdmissionGate(node, result, path);
        this.#qualificationAdmissionUngatedNodes.delete(id);
      }
    }
    this.#memo.set(id, result);
    return result;
  }

  #lowerQualificationAdmittedControls(path: string): AnalyticsDbRelation {
    const cached = this.#qualificationAdmittedControls;
    if (cached) return cached;
    const policy = this.#qualificationAdmissionPolicy;
    if (!policy)
      reject(
        path,
        "Provider analytics qualification admission policy is missing.",
      );
    const wasLoweringQualificationControls =
      this.#loweringQualificationControls;
    this.#loweringQualificationControls = true;
    let controls: LoweredRelation;
    try {
      controls = this.#lowerNode(policy.controlsRelationId);
    } finally {
      this.#loweringQualificationControls = wasLoweringQualificationControls;
    }
    const scalarControl = (name: string): AnyExpression => {
      const slot = policy.controlSlots.find(
        (controlSlot) => controlSlot.name === name,
      )?.slot;
      const layout = slot !== undefined ? controls.slots.get(slot) : undefined;
      if (!layout || layout.kind !== "scalar")
        reject(
          nodePath(policy.controlsRelationId),
          `Admission control ${JSON.stringify(name)} is not a scalar slot.`,
        );
      return relationColumn(
        controls.relation,
        layout.valueColumn,
        nodePath(policy.controlsRelationId),
      );
    };
    const admitted = createAnalyticsQualificationAdmittedControls({
      controls: controls.relation,
      policy,
      readers: {
        numeric: (name) =>
          scalarControl(name) as unknown as SqlExpression<
            number | null,
            ExpressionResultType<"integer" | "real" | "numeric", boolean>
          >,
        text: (name) =>
          scalarControl(name) as unknown as SqlExpression<
            string | null,
            ExpressionResultType<"text", boolean>
          >,
      },
    });
    this.#qualificationAdmittedControls = admitted;
    return admitted;
  }

  #applyQualificationAdmissionGate(
    node: LogicalNode,
    result: LoweredRelation,
    path: string,
  ): LoweredRelation {
    const admittedControls = this.#lowerQualificationAdmittedControls(path);
    const admittedRelation = applyAnalyticsQualificationAdmissionGate(
      result.relation,
      admittedControls,
    );
    const rebound = this.#rebindEventDistinctIdentityLayouts(
      result,
      admittedRelation,
      node.id,
      node.id,
      path,
    );
    const payloadKeyProofs = this.#eventPayloadKeyProofs.get(node.id);
    if (payloadKeyProofs && payloadKeyProofs.size > 0) {
      const reboundProofs = new Map<string, EventPayloadKeyProof>();
      for (const [proofId, proof] of payloadKeyProofs) {
        if (
          !admittedRelation.columns[proof.keyColumn] ||
          [...proof.metadataColumns.values()].some(
            (column) => !admittedRelation.columns[column],
          )
        )
          reject(
            path,
            "Event qualification admission lost a hidden Event payload key carrier.",
          );
        reboundProofs.set(proofId, {
          ...proof,
          carrierRelation: admittedRelation,
        });
      }
      this.#eventPayloadKeyProofs.set(node.id, reboundProofs);
    }
    return { ...rebound };
  }

  #lowerComparisonAdmittedControls(
    controls: LoweredRelation,
    side: ComparisonPageQualificationGateSide,
    path: string,
  ): AnalyticsDbRelation {
    const required = [
      "rawCount",
      "nullActivityIdCount",
      "siteIdentityMismatchCount",
      "entityKind",
      "invalidIdentityCount",
      "duplicateIdentityCount",
      ...side.policy.numericCompatibilityControlNames,
    ];
    const names = side.controlSlots.map(({ name }) => name);
    if (
      (side.policy.scope !== "session" && side.policy.scope !== "visitor") ||
      !Number.isSafeInteger(side.policy.maximumActivities) ||
      side.policy.maximumActivities < 0 ||
      new Set(side.policy.numericCompatibilityControlNames).size !==
        side.policy.numericCompatibilityControlNames.length ||
      !required.every((name) => names.includes(name)) ||
      new Set(names).size !== names.length ||
      side.controlSlots.length !== required.length ||
      side.controlSlots.some(({ name, slot }) => {
        const declared = this.#logicalSlots.get(slot);
        return (
          !controls.slots.has(slot) ||
          declared?.type.kind !== "scalar" ||
          declared.type.scalar !== (name === "entityKind" ? "string" : "number")
        );
      })
    )
      reject(path, "Comparison qualification controls are incomplete.");
    const scalarControl = (name: string): AnyExpression => {
      const slot = side.controlSlots.find(
        (candidate) => candidate.name === name,
      )?.slot;
      const layout = slot === undefined ? undefined : controls.slots.get(slot);
      if (!layout || layout.kind !== "scalar")
        reject(
          path,
          `Comparison control ${JSON.stringify(name)} is not scalar.`,
        );
      return relationColumn(controls.relation, layout.valueColumn, path);
    };
    return createAnalyticsQualificationAdmittedControls({
      controls: controls.relation,
      policy: side.policy,
      readers: {
        numeric: (name) =>
          scalarControl(name) as unknown as SqlExpression<
            number | null,
            ExpressionResultType<"integer" | "real" | "numeric", boolean>
          >,
        text: (name) =>
          scalarControl(name) as unknown as SqlExpression<
            string | null,
            ExpressionResultType<"text", boolean>
          >,
      },
    });
  }

  #lowerSource(node: SourceNode, path: string): LoweredRelation {
    let lowered: LoweredAnalyticsSource;
    const providerRequests =
      this.#requiredProviderSourceBindings.get(node.id) ?? [];
    try {
      const source = this.#storage.lowerSource(
        node,
        path,
        this.#requiredOutput(node),
        providerRequests,
      );
      lowered = this.#scopedSourceLowering.lowerSelectedReportSource(
        node,
        path,
        source,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const separator = message.indexOf(": ");
      if (separator > 0 && message.startsWith(path + "."))
        reject(message.slice(0, separator), message.slice(separator + 2));
      reject(path, message);
    }
    if (
      lowered.providerBindings.length !== providerRequests.length ||
      providerRequests.some(
        (request) =>
          !lowered.providerBindings.some(
            (binding) =>
              binding.request.id === request.id &&
              binding.request.sourceId === request.sourceId &&
              binding.request.eventKeySlot === request.eventKeySlot &&
              binding.request.includePayloadPropertiesMetadata ===
                request.includePayloadPropertiesMetadata &&
              binding.kind === request.kind,
          ),
      )
    )
      reject(
        path,
        "Storage did not return every requested Provider source binding.",
      );
    const values = node.output
      .filter((slot) => this.#requiredOutput(node).has(slot))
      .map((slot) => {
        const value = lowered.values.get(slot);
        if (!value)
          reject(path, `The source does not bind slot ${String(slot)}.`);
        const logical = logicalSlot(
          this.#logicalSlots,
          slot,
          `${path}.${String(slot)}`,
        );
        const binding = node.values.find(
          (candidate) => candidate.slot === slot,
        );
        if (!binding)
          reject(path, `The source does not declare slot ${String(slot)}.`);
        const lineageMatches =
          (binding.kind === "self" &&
            logical.lineage.kind === "entity" &&
            logical.lineage.entity === node.entity) ||
          (binding.kind === "related-entity" &&
            logical.lineage.kind === "relationship" &&
            logical.lineage.relationship === binding.relationship) ||
          (binding.kind === "attribute" &&
            logical.lineage.kind === "attribute" &&
            logical.lineage.attribute === binding.attribute) ||
          (binding.kind === "occurrence-time" &&
            logical.lineage.kind === "derived" &&
            logical.lineage.operation === "occurrence-time");
        const bindingName =
          binding.kind === "attribute"
            ? binding.attribute
            : binding.kind === "related-entity"
              ? binding.relationship
              : node.entity;
        if (!lineageMatches)
          reject(
            `${path}.${String(slot)}`,
            `Source value lineage for ${bindingName} differs from its declared binding.`,
          );
        if (value.kind === "scalar") {
          if (logical.type.kind === "entity")
            reject(path, "A source attribute cannot bind an entity slot.");
          return {
            slot,
            value: {
              kind: "scalar",
              expression: value.value,
              type: logical.type,
              nullable: logical.nullable,
              candidateBounded: false,
            } satisfies LoweredValue,
          };
        }
        if (
          logical.type.kind !== "entity" ||
          logical.type.entity !== value.entity ||
          logical.nullable !== value.nullable
        )
          reject(
            path,
            `Source binding for ${String(slot)} differs from its registered Logical metadata.`,
          );
        return { slot, value };
      });
    const providerValues: ProviderProjectionValue[] =
      lowered.providerBindings.map((binding) => {
        assertAnalyticsEventPayloadKeySchema(binding.schema, path);
        if (
          binding.kind !== "event-payload-key" ||
          binding.relation !== lowered.relation ||
          lowered.relation.columns[binding.columns.eventPk] !==
            binding.eventPk ||
          lowered.relation.columns[binding.columns.sitePk] !== binding.sitePk ||
          lowered.relation.columns[binding.columns.eventId] !==
            binding.eventId ||
          binding.eventKey !==
            lowered.values.get(binding.request.eventKeySlot) ||
          binding.eventKey.kind !== "entity" ||
          binding.eventKey.entity !== "event" ||
          binding.eventKey.nullable ||
          binding.eventKey.keys.length !== 2 ||
          binding.eventKey.keys[0] !== binding.sitePk ||
          binding.eventKey.keys[1] !== binding.eventId ||
          binding.eventPk.resultType.affinity !== "integer" ||
          binding.eventPk.resultType.nullable
        )
          reject(
            path,
            "Storage Event payload key evidence does not match the mapped business Event identity.",
          );
        const pkSlot = node.values.find(
          (candidate) =>
            candidate.kind === "attribute" &&
            candidate.attribute === "event.report.internalPk",
        )?.slot;
        const reuseSlot =
          pkSlot !== undefined && this.#requiredOutput(node).has(pkSlot)
            ? pkSlot
            : undefined;
        const reuseValue =
          reuseSlot === undefined
            ? undefined
            : values.find(({ slot }) => slot === reuseSlot)?.value;
        if (
          reuseSlot !== undefined &&
          (reuseValue?.kind !== "scalar" ||
            binding.reuseExpression !== reuseValue.expression)
        )
          reject(
            path,
            "A live Logical Event PK must share its exact Provider projection.",
          );
        return {
          id: binding.request.id,
          expression:
            reuseSlot === undefined
              ? binding.eventPk
              : binding.reuseExpression!,
          ...(reuseSlot !== undefined ? { reuseSlot } : {}),
          ...(binding.propertiesMetadata
            ? {
                additionalValues: [
                  {
                    id: analyticsEventPayloadMetadataProviderId(
                      binding.request.id,
                      "siteId",
                    ),
                    expression: binding.propertiesMetadata.siteId,
                  },
                  {
                    id: analyticsEventPayloadMetadataProviderId(
                      binding.request.id,
                      "eventNameId",
                    ),
                    expression: binding.propertiesMetadata.eventNameId,
                  },
                  {
                    id: analyticsEventPayloadMetadataProviderId(
                      binding.request.id,
                      "occurredAt",
                    ),
                    expression: binding.propertiesMetadata.occurredAt,
                  },
                  {
                    id: analyticsEventPayloadMetadataProviderId(
                      binding.request.id,
                      "visitId",
                    ),
                    expression: binding.propertiesMetadata.visitId,
                  },
                ],
              }
            : {}),
        };
      });
    const sourceSignature = JSON.stringify([
      node.entity,
      node.temporalDomain,
      this.#sourceSelectionId(node.selection),
      lowered.providerBindings
        .map(({ request }) => [
          request.id,
          request.includePayloadPropertiesMetadata === true,
        ])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
      node.values.map((binding) => {
        const logical = logicalSlot(
          this.#logicalSlots,
          binding.slot,
          `${path}.${String(binding.slot)}`,
        );
        const value =
          binding.kind === "self"
            ? ["self"]
            : binding.kind === "related-entity"
              ? ["relationship", binding.relationship]
              : binding.kind === "attribute"
                ? ["attribute", binding.attribute]
                : ["occurrence-time"];
        return [
          value,
          this.#requiredOutput(node).has(binding.slot),
          logical.type,
          logical.nullable,
          logical.lineage,
        ];
      }),
    ]);
    const cached = this.#loweredSources.get(sourceSignature);
    if (cached) {
      const providerColumnIds = lowered.providerBindings.flatMap((binding) => [
        binding.request.id,
        ...(binding.propertiesMetadata
          ? (["siteId", "eventNameId", "occurredAt", "visitId"] as const).map(
              (field) =>
                analyticsEventPayloadMetadataProviderId(
                  binding.request.id,
                  field,
                ),
            )
          : []),
      ]);
      if (
        cached.layouts.length !== values.length ||
        cached.providerLayouts.size !== providerColumnIds.length ||
        providerColumnIds.some((id) => !cached.providerLayouts.has(id))
      )
        reject(path, "A reused Source carrier has a different slot layout.");
      const providerColumns = new Map(
        providerColumnIds.map((id) => [id, cached.providerLayouts.get(id)!]),
      );
      const result: LoweredRelation = {
        relation: cached.relation,
        slots: new Map(
          values.map(
            ({ slot }, index) => [slot, cached.layouts[index]!] as const,
          ),
        ),
        ...(providerColumns.size > 0 ? { providerColumns } : {}),
        candidateActivity:
          node.selection === undefined &&
          node.temporalDomain === "candidate" &&
          (node.entity === "page" ||
            node.entity === "event" ||
            node.entity === "observation")
            ? node.entity
            : undefined,
        candidateActivitySessionRestricted: false,
      };
      this.#installEventPayloadKeyProofs(
        node.id,
        lowered.providerBindings,
        sourceSignature,
        result,
        path,
      );
      return result;
    }
    const result = projectedValues(
      lowered.relation,
      values,
      this.#logicalSlots,
      path,
      providerValues,
    );
    const providerLayouts = new Map(result.providerColumns ?? []);
    this.#loweredSources.set(sourceSignature, {
      relation: result.relation,
      layouts: values.map(({ slot }) => {
        const layout = result.slots.get(slot);
        if (!layout)
          reject(path, `A lowered Source has no layout for ${String(slot)}.`);
        return layout;
      }),
      providerLayouts,
    });
    this.#installEventPayloadKeyProofs(
      node.id,
      lowered.providerBindings,
      sourceSignature,
      result,
      path,
    );
    return {
      ...result,
      candidateActivity:
        node.selection === undefined &&
        node.temporalDomain === "candidate" &&
        (node.entity === "page" ||
          node.entity === "event" ||
          node.entity === "observation")
          ? node.entity
          : undefined,
      candidateActivitySessionRestricted: false,
    };
  }

  #installEventPayloadKeyProofs(
    scopeRelation: RelationId,
    bindings: readonly AnalyticsEventPayloadKeySourceBinding[],
    sourceSignature: string,
    lowered: LoweredRelation,
    path: string,
  ): void {
    if (bindings.length === 0) return;
    const proofs = new Map<string, EventPayloadKeyProof>();
    for (const binding of bindings) {
      assertAnalyticsEventPayloadKeySchema(binding.schema, path);
      const eventKeyLayout = lowered.slots.get(binding.request.eventKeySlot);
      const keyColumn = lowered.providerColumns?.get(binding.request.id);
      const metadataColumns = new Map<
        AnalyticsEventPayloadPropertiesMetadataField,
        string
      >();
      if (binding.request.includePayloadPropertiesMetadata === true) {
        for (const field of [
          "siteId",
          "eventNameId",
          "occurredAt",
          "visitId",
        ] as const) {
          const column = lowered.providerColumns?.get(
            analyticsEventPayloadMetadataProviderId(binding.request.id, field),
          );
          if (!column || !lowered.relation.columns[column])
            reject(
              path,
              "Source projection did not preserve hidden Event payload metadata.",
            );
          metadataColumns.set(field, column);
        }
      }
      if (
        binding.request.sourceId !== scopeRelation ||
        binding.kind !== "event-payload-key" ||
        (binding.request.includePayloadPropertiesMetadata === true) !==
          (binding.propertiesMetadata !== undefined) ||
        !keyColumn ||
        !eventKeyLayout ||
        eventKeyLayout.kind !== "entity" ||
        eventKeyLayout.type.entity !== "event" ||
        eventKeyLayout.nullable ||
        eventKeyLayout.keyColumns.length !== 2 ||
        !lowered.relation.columns[keyColumn] ||
        eventKeyLayout.keyColumns.some(
          (column) => !lowered.relation.columns[column],
        )
      )
        reject(
          path,
          "Source projection did not preserve the Provider Event payload key and business identity layout.",
        );
      proofs.set(binding.request.id, {
        request: binding.request,
        sourceBinding: binding,
        sourceSignature,
        scopeRelation,
        carrierRelation: lowered.relation,
        keyColumn,
        eventKeyLayout,
        metadataColumns,
      });
    }
    this.#eventPayloadKeyProofs.set(scopeRelation, proofs);
  }

  #eventPayloadKeyProofForRequest(
    relation: RelationId,
    eventKey: SlotId,
    input: LoweredRelation,
    path: string,
    requested: AnalyticsProviderSourceBindingRequest,
  ): EventPayloadKeyProof {
    const proof = this.#eventPayloadKeyProofs.get(relation)?.get(requested.id);
    if (!proof)
      reject(path, "The Event payload key demand has no current Source proof.");
    const source = this.#eventPayloadSource(
      relation,
      eventKey,
      `${path}.input`,
    );
    const binding = proof.sourceBinding;
    const eventKeyLayout = input.slots.get(eventKey);
    const carrierColumn = input.providerColumns?.get(requested.id);
    if (
      requested.sourceId !== source.id ||
      requested.eventKeySlot !== eventKey ||
      proof.request.id !== requested.id ||
      proof.request.sourceId !== source.id ||
      proof.request.eventKeySlot !== eventKey ||
      proof.request.includePayloadPropertiesMetadata !==
        requested.includePayloadPropertiesMetadata ||
      proof.sourceSignature.length === 0 ||
      proof.scopeRelation !== relation ||
      proof.carrierRelation !== input.relation ||
      proof.keyColumn !== carrierColumn ||
      proof.eventKeyLayout !== eventKeyLayout ||
      binding.request.id !== requested.id ||
      binding.request.sourceId !== source.id ||
      binding.request.eventKeySlot !== eventKey ||
      binding.request.includePayloadPropertiesMetadata !==
        requested.includePayloadPropertiesMetadata ||
      binding.relation.columns[binding.columns.eventPk] !== binding.eventPk ||
      binding.relation.columns[binding.columns.sitePk] !== binding.sitePk ||
      binding.relation.columns[binding.columns.eventId] !== binding.eventId ||
      binding.eventKey.kind !== "entity" ||
      binding.eventKey.entity !== "event" ||
      binding.eventKey.nullable ||
      binding.eventKey.keys.length !== 2 ||
      binding.eventKey.keys[0] !== binding.sitePk ||
      binding.eventKey.keys[1] !== binding.eventId ||
      eventKeyLayout?.kind !== "entity" ||
      eventKeyLayout.type.entity !== "event" ||
      eventKeyLayout.nullable ||
      eventKeyLayout.keyColumns.length !== 2 ||
      (requested.includePayloadPropertiesMetadata === true) !==
        (binding.propertiesMetadata !== undefined) ||
      (requested.includePayloadPropertiesMetadata === true) !==
        (proof.metadataColumns.size === 4)
    )
      reject(
        path,
        "The Event payload key proof does not match its canonical Source, current scope, or business identity mapping.",
      );
    assertAnalyticsEventPayloadKeySchema(binding.schema, path);
    return proof;
  }

  #eventPayloadKeyForOccurrence(
    node: EventPayloadOccurrencesNode,
    input: LoweredRelation,
    path: string,
  ): {
    readonly proof: EventPayloadKeyProof;
    readonly eventPk: AnyExpression;
    readonly sitePk: AnyExpression;
    readonly eventId: AnyExpression;
  } {
    const requested = this.#eventPayloadKeyRequestsByOccurrence.get(node.id);
    if (!requested)
      reject(
        path,
        "Occurrence payload expansion has no Provider key demand proof.",
      );
    const proof = this.#eventPayloadKeyProofForRequest(
      node.input,
      node.eventKey,
      input,
      path,
      requested,
    );
    const eventKeyLayout = input.slots.get(node.eventKey);
    if (!eventKeyLayout || eventKeyLayout.kind !== "entity")
      reject(path, "Occurrence payload Event identity layout is unavailable.");
    const eventPk = relationColumn(input.relation, proof.keyColumn, path);
    const sitePk = relationColumn(
      input.relation,
      eventKeyLayout.keyColumns[0]!,
      path,
    );
    const eventId = relationColumn(
      input.relation,
      eventKeyLayout.keyColumns[1]!,
      path,
    );
    if (
      eventPk.resultType.affinity !== "integer" ||
      eventPk.resultType.nullable ||
      sitePk.resultType.affinity !== "integer" ||
      sitePk.resultType.nullable ||
      eventId.resultType.affinity !== "text" ||
      eventId.resultType.nullable
    )
      reject(
        path,
        "Occurrence payload key carrier has an invalid physical schema.",
      );
    return { proof, eventPk, sitePk, eventId };
  }

  #eventPayloadPropertiesIdentity(
    propertiesRelation: RelationId,
    sourceRelation: RelationId,
    eventKey: SlotId,
    input: LoweredRelation,
    path: string,
  ): EventPayloadPropertiesIdentity {
    const requested =
      this.#eventPayloadKeyRequestsByProperties.get(propertiesRelation);
    if (!requested)
      reject(path, "Payload Properties has no Provider hidden-key demand.");
    const proof = this.#eventPayloadKeyProofForRequest(
      sourceRelation,
      eventKey,
      input,
      path,
      requested,
    );
    const eventKeyLayout = input.slots.get(eventKey);
    const metadata = proof.sourceBinding.propertiesMetadata;
    if (
      !metadata ||
      proof.metadataColumns.size !== 4 ||
      eventKeyLayout?.kind !== "entity"
    )
      reject(path, "Payload Properties has no Provider metadata source proof.");

    const metadataExpression = (
      field: AnalyticsEventPayloadPropertiesMetadataField,
    ) => {
      const column = proof.metadataColumns.get(field);
      const providerColumn = input.providerColumns?.get(
        analyticsEventPayloadMetadataProviderId(requested.id, field),
      );
      if (!column || column !== providerColumn)
        reject(path, "Payload Properties lost its hidden metadata carrier.");
      return relationColumn(input.relation, column, path);
    };
    const eventPk = relationColumn(input.relation, proof.keyColumn, path);
    const sitePk = relationColumn(
      input.relation,
      eventKeyLayout.keyColumns[0]!,
      path,
    );
    const eventId = relationColumn(
      input.relation,
      eventKeyLayout.keyColumns[1]!,
      path,
    );
    const propertiesMetadata = {
      siteId: metadataExpression("siteId"),
      eventNameId: metadataExpression("eventNameId"),
      occurredAt: metadataExpression("occurredAt"),
      visitId: metadataExpression("visitId"),
    };
    if (
      eventPk.resultType.affinity !== "integer" ||
      eventPk.resultType.nullable ||
      sitePk.resultType.affinity !== "integer" ||
      sitePk.resultType.nullable ||
      eventId.resultType.affinity !== "text" ||
      eventId.resultType.nullable ||
      propertiesMetadata.siteId.resultType.affinity !== "text" ||
      propertiesMetadata.siteId.resultType.nullable ||
      propertiesMetadata.eventNameId.resultType.affinity !== "integer" ||
      propertiesMetadata.eventNameId.resultType.nullable ||
      propertiesMetadata.occurredAt.resultType.affinity !== "integer" ||
      propertiesMetadata.occurredAt.resultType.nullable ||
      propertiesMetadata.visitId.resultType.affinity !== "text" ||
      propertiesMetadata.visitId.resultType.nullable
    )
      reject(
        path,
        "Payload Properties hidden source columns have invalid types.",
      );
    return {
      requestId: requested.id,
      sourceId: requested.sourceId,
      eventKeySlot: requested.eventKeySlot,
      scopeRelation: proof.scopeRelation,
      sourceSignature: proof.sourceSignature,
      carrierRelation: proof.carrierRelation,
      keyColumn: proof.keyColumn,
      sourceBinding: proof.sourceBinding,
      eventPk,
      sitePk,
      eventId,
      propertiesMetadata,
    };
  }
  #lowerEventPayloadOccurrences(
    node: EventPayloadOccurrencesNode,
    path: string,
  ): LoweredRelation {
    const input = this.#lowerNode(node.input);
    const eventIdentity = this.#eventPayloadKeyForOccurrence(node, input, path);
    const identitySlot = node.fields.find(
      ({ field }) => field === "eventIdentity",
    )?.slot;
    const includeDistinctIdentity =
      identitySlot !== undefined &&
      this.#requiredOutput(node).has(identitySlot);
    const payload = this.#storage.eventPayloadOccurrences(input.relation, {
      eventPk: eventIdentity.eventPk,
      sitePk: eventIdentity.sitePk,
      eventId: eventIdentity.eventId,
      includeDistinctIdentity,
    });
    const values = node.fields
      .filter((field) => this.#requiredOutput(node).has(field.slot))
      .map(({ field, slot }) => {
        const logical = logicalSlot(
          this.#logicalSlots,
          slot,
          `${path}.${field}`,
        );
        if (field === "eventIdentity") {
          if (
            logical.type.kind !== "entity" ||
            logical.type.entity !== "event" ||
            logical.nullable ||
            !includeDistinctIdentity
          )
            reject(
              `${path}.${field}`,
              "Payload Event identity output must be a required non-null Event Entity slot.",
            );
          return {
            slot,
            value: {
              kind: "entity" as const,
              entity: "event" as const,
              keys: [
                relationColumn(payload, "eventSitePk", `${path}.${field}`),
                relationColumn(payload, "eventId", `${path}.${field}`),
              ],
              present: asPredicate(constant(1), `${path}.${field}`),
              nullable: false,
              candidateBounded: false,
            },
          };
        }
        return {
          slot,
          value: {
            kind: "scalar" as const,
            expression: relationColumn(payload, field, `${path}.${field}`),
            type: logical.type,
            nullable: logical.nullable,
            candidateBounded: false,
          },
        };
      });
    const providerValues: ProviderProjectionValue[] =
      includeDistinctIdentity && identitySlot !== undefined
        ? [
            {
              id: eventIdentity.proof.request.id,
              expression: relationColumn(payload, "providerEventPk", path),
              identitySlot,
              identitySeed: {
                sourceBinding: eventIdentity.proof.sourceBinding,
                sourceSignature: eventIdentity.proof.sourceSignature,
                sourceId: eventIdentity.proof.request.sourceId,
                eventKeySlot: eventIdentity.proof.request.eventKeySlot,
                identitySlot,
                scopeRelation: node.id,
                inputRelation: payload,
                inputIdentityColumns: ["eventSitePk", "eventId"],
                inputDiscriminatorColumn: "providerEventPk",
              },
            },
          ]
        : [];
    return projectedValues(
      payload,
      values,
      this.#logicalSlots,
      path,
      providerValues,
    );
  }

  #lowerAnalysisResult(
    node: AnalysisResultNode,
    path: string,
  ): LoweredRelation {
    let byOutput = this.#analysisResultOutputs.get(node.childPlan);
    let childLowered = byOutput?.get(node.outputId);
    if (!childLowered) {
      const qualificationBinding =
        this.#analysisResultQualificationBindings.get(node.childPlan);
      const reportOutputIds = new Set(
        qualificationBinding?.reportOutputIds ?? [],
      );
      if (
        qualificationBinding &&
        !reportOutputIds.has(node.outputId) &&
        node.outputId !== qualificationBinding.controlsOutputId
      )
        reject(
          `${path}.outputId`,
          "The bound child snapshot contains an unapproved imported output.",
        );
      if (
        qualificationBinding &&
        (reportOutputIds.has(node.outputId) ||
          node.outputId === qualificationBinding.controlsOutputId)
      ) {
        let childPlan: ValidatedLogicalPlan;
        try {
          childPlan = validateLogicalPlan(node.childPlan);
        } catch (error) {
          reject(
            `${path}.childPlan`,
            error instanceof Error
              ? error.message
              : "Child Logical plan is invalid.",
          );
        }
        const reportOutputs = qualificationBinding.reportOutputIds.map(
          (outputId) =>
            childPlan.outputs.find((output) => output.id === outputId),
        );
        const controlsOutput = childPlan.outputs.find(
          (output) => output.id === qualificationBinding.controlsOutputId,
        );
        if (reportOutputs.some((output) => !output) || !controlsOutput)
          reject(
            `${path}.childPlan.outputs`,
            "The bound child report and controls outputs must all exist.",
          );
        let childLowerer = this.#analysisResultQualificationLowerers.get(
          node.childPlan,
        );
        if (!childLowerer) {
          childLowerer = new AnalyticsLogicalToDbLowerer(
            childPlan,
            {
              ...this.#storageContext,
              time: childPlan.context.time,
            },
            {
              analyticsQualificationAdmissionPolicy:
                qualificationBinding.policy,
            },
          );
          this.#analysisResultQualificationLowerers.set(
            node.childPlan,
            childLowerer,
          );
        }
        const approvedOutputs = [
          ...reportOutputs,
          controlsOutput,
        ] as LogicalOutput[];
        const loweredOutputs = childLowerer.lowerMany(approvedOutputs);
        if (!byOutput) {
          byOutput = new Map();
          this.#analysisResultOutputs.set(node.childPlan, byOutput);
        }
        qualificationBinding.reportOutputIds.forEach((outputId, index) => {
          byOutput!.set(outputId, loweredOutputs[index]!);
        });
        byOutput.set(
          qualificationBinding.controlsOutputId,
          loweredOutputs.at(-1)!,
        );
        childLowered = byOutput.get(node.outputId);
        if (!childLowered)
          reject(path, "The bound child output was not lowered.");
      }
    }
    if (!childLowered) {
      let childPlan: ValidatedLogicalPlan;
      try {
        childPlan = validateLogicalPlan(node.childPlan);
      } catch (error) {
        reject(
          `${path}.childPlan`,
          error instanceof Error
            ? error.message
            : "Child Logical plan is invalid.",
        );
      }
      const childOutput = childPlan.outputs.find(
        (output) => output.id === node.outputId,
      );
      if (!childOutput)
        reject(`${path}.outputId`, "The child output is not declared.");
      const childLowerer = new AnalyticsLogicalToDbLowerer(childPlan, {
        ...this.#storageContext,
        time: childPlan.context.time,
      });
      childLowered = childLowerer.lower(childOutput);
      if (!byOutput) {
        byOutput = new Map();
        this.#analysisResultOutputs.set(node.childPlan, byOutput);
      }
      byOutput.set(node.outputId, childLowered);
    }

    const needed = this.#requiredOutput(node);
    const values = node.mappings
      .filter((mapping) => needed.has(mapping.slot))
      .map((mapping) => {
        const field = childLowered.output.fields.find(
          (candidate) => candidate.name === mapping.field,
        );
        if (!field)
          reject(
            `${path}.mappings`,
            `Child output field ${mapping.field} is missing.`,
          );
        const value = valueForSlot(
          childLowered.relation,
          childLowered.slots,
          field.slot,
          `${path}.child.${mapping.field}`,
        );
        if (value.kind !== "scalar")
          reject(
            `${path}.mappings`,
            "Only scalar child output values can be imported.",
          );
        return {
          slot: mapping.slot,
          value: { ...value, candidateBounded: false } as LoweredValue,
        };
      });
    return projectedValues(
      childLowered.relation,
      values,
      this.#logicalSlots,
      path,
    );
  }

  #lowerProject(node: ProjectNode, path: string): LoweredRelation {
    const input = this.#lowerNode(node.input);
    const visible = new Map(input.slots);
    const values = node.projections
      .filter((projection) => this.#requiredOutput(node).has(projection.slot))
      .map((projection, index) => {
        const value = lowerExpression(
          projection.expression,
          input.relation,
          this.#logicalSlots,
          visible,
          `${path}.projections[${index}].expression`,
          this.#plan.context.time,
          this.#comparisonAdmissionBinding
            ? {
                binding: this.#comparisonAdmissionBinding,
                owner: this,
                relationId: node.input,
              }
            : undefined,
        );
        const outputMeta = logicalSlot(
          this.#logicalSlots,
          projection.slot,
          `${path}.projections[${index}].slot`,
        );
        if (value.kind === "scalar")
          return {
            slot: projection.slot,
            value: {
              ...value,
              type: outputMeta.type,
              nullable: outputMeta.nullable,
            },
          };
        if (projection.expression.kind !== "slot")
          reject(
            path,
            "Entity projections must directly rebind a visible entity slot.",
          );
        return {
          slot: projection.slot,
          value: { ...value, nullable: outputMeta.nullable },
        };
      });
    const projected = projectedValues(
      input.relation,
      values,
      this.#logicalSlots,
      path,
    );
    const preservesActivity =
      input.candidateActivity !== undefined &&
      node.grain.kind === "entity" &&
      node.grain.entity === input.candidateActivity;
    return {
      ...projected,
      candidateActivity: preservesActivity
        ? input.candidateActivity
        : undefined,
      candidateActivitySessionRestricted:
        preservesActivity && input.candidateActivitySessionRestricted,
      candidateActivitySessionRelation: preservesActivity
        ? input.candidateActivitySessionRelation
        : undefined,
    };
  }

  #lowerDistinct(node: DistinctNode, path: string): LoweredRelation {
    if (node.keys.length === 0)
      reject(path, "Distinct requires at least one visible key.");
    const input = this.#lowerNode(node.input);
    let relation = input.relation;
    const visible = new Map(input.slots);
    if (node.excludeNull) {
      const guards = node.keys.map((key, index) => {
        const value = readValue(
          relation,
          visible,
          key.input,
          `${path}.keys[${index}]`,
        );
        return value.kind === "entity"
          ? value.present
          : isNotNull(value.expression);
      });
      relation = filter(relation, combinePredicates("and", guards, path));
    }
    const values = node.keys.map((key, index) => {
      const value = readValue(
        relation,
        visible,
        key.input,
        `${path}.keys[${index}]`,
      );
      return {
        slot: key.output,
        value: node.excludeNull ? { ...value, nullable: false } : value,
      };
    });
    const projected = projectedValues(
      relation,
      values,
      this.#logicalSlots,
      path,
    );
    const distinctRelation: AnalyticsDbRelation = distinct(projected.relation);
    const preservesActivity =
      input.candidateActivity !== undefined &&
      node.grain.kind === "entity" &&
      node.grain.entity === input.candidateActivity;
    return {
      relation: distinctRelation,
      slots: projected.slots,
      candidateActivity: preservesActivity
        ? input.candidateActivity
        : undefined,
      candidateActivitySessionRestricted:
        preservesActivity && input.candidateActivitySessionRestricted,
      candidateActivitySessionRelation: preservesActivity
        ? input.candidateActivitySessionRelation
        : undefined,
    };
  }

  #lowerSetOperation(node: SetOperationNode, path: string): LoweredRelation {
    const inputs = node.inputs.map((id) => this.#lowerNode(id));
    const inputEntities: AnalyticsEntityKind[] = [];
    for (const [index, input] of inputs.entries()) {
      const inputNode = this.#nodes.get(node.inputs[index]!);
      if (!inputNode) reject(path, `Set input ${index} does not exist.`);
      inputEntities.push(
        assertNonNullableUnaryEntitySet(
          inputNode,
          input,
          this.#logicalSlots,
          `${path}.inputs[${index}]`,
        ),
      );
    }
    if (node.output.length !== 1)
      reject(path, "Only unary scoped identity sets are currently supported.");
    const outputSlot = node.output[0]!;
    const outputType = logicalSlot(
      this.#logicalSlots,
      outputSlot,
      `${path}.output[0]`,
    );
    const entity = inputEntities[0]!;
    if (
      inputEntities.some((inputEntity) => inputEntity !== entity) ||
      node.grain.kind !== "entity" ||
      node.grain.key !== outputSlot ||
      node.grain.entity !== entity ||
      outputType.type.kind !== "entity" ||
      outputType.type.entity !== entity ||
      outputType.nullable
    )
      reject(
        path,
        "Set inputs and output must preserve one non-null scoped entity identity.",
      );

    const aligned = inputs.map((input, inputIndex) => {
      const sourceNode = this.#nodes.get(node.inputs[inputIndex]!);
      if (!sourceNode) reject(path, "Set input node is missing.");
      const values = sourceNode.output.map((sourceSlot, slotIndex) => ({
        slot: node.output[slotIndex]!,
        value: readValue(
          input.relation,
          input.slots,
          sourceSlot,
          `${path}.inputs[${inputIndex}].output[${slotIndex}]`,
        ),
      }));
      return projectedValues(input.relation, values, this.#logicalSlots, path);
    });

    let relation = aligned[0]!.relation;
    if (node.operation === "union") {
      for (const next of aligned.slice(1))
        relation = union(relation, next.relation);
      const bounded = inputs.every((input, index) => {
        const sourceNode = this.#nodes.get(node.inputs[index]!);
        const sourceSlot = sourceNode?.output[0];
        return (
          sourceSlot !== undefined &&
          input.slots.get(sourceSlot)?.candidateBounded === true
        );
      });
      const initial = aligned[0]!.slots.get(node.output[0]!);
      if (!initial) reject(path, "Union output mapping is missing.");
      return {
        relation,
        slots: new Map([
          [node.output[0]!, { ...initial, candidateBounded: bounded }],
        ]),
        candidateActivitySessionRestricted: false,
      };
    }

    let accumulated = aligned[0]!;
    let bounded = this.#inputSetSlotBounded(inputs[0]!, node.inputs[0]!);
    for (let index = 1; index < aligned.length; index++) {
      const next = aligned[index]!;
      const leftValue = readValue(
        accumulated.relation,
        accumulated.slots,
        node.output[0]!,
        path,
      );
      const rightValue = readValue(
        next.relation,
        next.slots,
        node.output[0]!,
        path,
      );
      const condition = keyEqual(leftValue, rightValue, `${path}.keys[0]`);
      const joined =
        node.operation === "intersect"
          ? semiJoin(accumulated.relation, next.relation, condition)
          : antiJoin(accumulated.relation, next.relation, condition);
      const selected = projectedValues(
        joined,
        [
          {
            slot: node.output[0]!,
            value: readValue(joined, accumulated.slots, node.output[0]!, path),
          },
        ],
        this.#logicalSlots,
        path,
      );
      relation = distinct(selected.relation);
      bounded =
        node.operation === "intersect"
          ? bounded ||
            this.#inputSetSlotBounded(inputs[index]!, node.inputs[index]!)
          : bounded;
      const layout = selected.slots.get(node.output[0]!);
      if (!layout) reject(path, "Set operation output mapping is missing.");
      accumulated = {
        relation,
        slots: new Map([
          [node.output[0]!, { ...layout, candidateBounded: bounded }],
        ]),
        candidateActivitySessionRestricted: false,
      };
    }
    return accumulated;
  }

  #lowerRowConcatenation(
    node: RowConcatenationNode,
    path: string,
  ): LoweredRelation {
    const inputs = node.inputs.map((id) => this.#lowerNode(id));
    const required = this.#requiredOutput(node);
    const aligned = inputs.map((input, inputIndex) => {
      const values = node.columns
        .filter((column) => required.has(column.output))
        .map((column) => {
          const sourceSlot = column.inputs[inputIndex];
          if (sourceSlot === undefined)
            reject(
              path,
              `Input ${inputIndex} has no mapping for ${column.name}.`,
            );
          const value = readValue(
            input.relation,
            input.slots,
            sourceSlot,
            `${path}.inputs[${inputIndex}].${column.name}`,
          );
          if (value.kind !== "scalar")
            reject(
              `${path}.inputs[${inputIndex}].${column.name}`,
              "Row concatenation accepts only scalar or bucket values.",
            );
          const outputMeta = logicalSlot(
            this.#logicalSlots,
            column.output,
            `${path}.${column.name}`,
          );
          return {
            slot: column.output,
            value: {
              ...value,
              type: outputMeta.type,
              candidateBounded: false,
            },
          };
        });
      return projectedValues(
        input.relation,
        values,
        this.#logicalSlots,
        `${path}.inputs[${inputIndex}]`,
      );
    });
    let relation = aligned[0]!.relation;
    for (const next of aligned.slice(1))
      relation = union(relation, next.relation, true);
    const slots = new Map<SlotId, SlotLayout>();
    for (const column of node.columns) {
      if (!required.has(column.output)) continue;
      const initial = aligned[0]!.slots.get(column.output);
      if (!initial || initial.kind !== "scalar")
        reject(path, `Output mapping for ${column.name} is missing.`);
      slots.set(column.output, { ...initial, candidateBounded: false });
    }
    return {
      relation,
      slots,
      candidateActivitySessionRestricted: false,
    };
  }

  #lowerRelationshipLookup(
    node: RelationshipLookupNode,
    path: string,
  ): LoweredRelation {
    if (
      node.relationship !== "observation.session" &&
      node.relationship !== "observation.visitor"
    )
      reject(
        path,
        `Relationship ${node.relationship} has no D1 lookup mapping.`,
      );
    const target =
      node.relationship === "observation.session"
        ? { entity: "session" as const, idColumn: "session_id" as const }
        : { entity: "visitor" as const, idColumn: "visitor_id" as const };
    const input = this.#lowerNode(node.input);
    const required = this.#requiredOutput(node);
    const outputValues = node.output.filter((slot) => required.has(slot));
    if (!required.has(node.relatedSlot)) {
      const forwarded = projectedValues(
        input.relation,
        outputValues.map((slot) => ({
          slot,
          value: readValue(input.relation, input.slots, slot, path),
        })),
        this.#logicalSlots,
        path,
      );
      return {
        ...forwarded,
        candidateActivity: input.candidateActivity,
        candidateActivitySessionRelation:
          input.candidateActivitySessionRelation,
        candidateActivitySessionRestricted:
          input.candidateActivitySessionRestricted,
      };
    }
    const key = readValue(
      input.relation,
      input.slots,
      node.inputKey,
      `${path}.inputKey`,
    );
    if (key.kind !== "entity" || key.entity !== "observation" || key.nullable)
      reject(
        path,
        `Observation ${target.entity} lookup requires a non-null composite Observation key.`,
      );
    if (!this.#hasStorageBackedObservationIdentity(node.input, node.inputKey))
      reject(
        path,
        `Observation ${target.entity} lookup requires an identity preserved from a registered Page/Event Source.`,
      );
    if (key.keys.length !== 3)
      reject(
        path,
        `Observation ${target.entity} lookup requires site, activity kind, and local identity keys.`,
      );
    const observationKind = key.keys[1]! as SqlExpression<
      string | null,
      ExpressionResultType<"text", boolean>
    >;
    // Page/Event identity lookups may use indexed INNER joins only after
    // proving that the Observation identity is carried unchanged from a
    // registered Source. Once an Event row is found, its owner Page is an
    // optional relationship: retain the Event and expose a null Session when
    // the same-site owner lookup has no match.
    const pageInput = filter(
      input.relation,
      eq(observationKind, param("page")),
    );
    const pageKey = readValue(
      pageInput,
      input.slots,
      node.inputKey,
      `${path}.inputKey`,
    );
    if (pageKey.kind !== "entity" || pageKey.entity !== "observation")
      reject(path, "Observation identity was lost during Page lookup.");
    const pageTable = this.#storage.observationPageIdentityRows();
    const pages = project(pageTable, {
      site_pk: pageTable.columns.site_pk,
      visit_id: pageTable.columns.visit_id,
      [target.idColumn]: pageTable.columns[target.idColumn],
    });
    const pageJoined = join(
      pageInput,
      pages,
      and(
        eq(pageKey.keys[0]!, pages.columns.site_pk),
        eq(pageKey.keys[2]!, pages.columns.visit_id),
      ),
    );
    const pageTargetId = relationColumn(
      pageJoined,
      `right_${target.idColumn}`,
      path,
    );
    const pageTargetText = pageTargetId as SqlExpression<
      string | null,
      ExpressionResultType<"text", boolean>
    >;
    const pageValues: {
      readonly slot: SlotId;
      readonly value: LoweredValue;
    }[] = node.output
      .filter((slot) => slot !== node.relatedSlot && required.has(slot))
      .map((slot) => ({
        slot,
        value: this.#joinedValue(
          pageJoined,
          input.slots.get(slot),
          "left_",
          path,
        ),
      }));
    pageValues.push({
      slot: node.relatedSlot,
      value: {
        kind: "entity",
        entity: target.entity,
        keys: [relationColumn(pageJoined, "right_site_pk", path), pageTargetId],
        present: asPredicate(
          and(isNotNull(pageTargetText), neq(pageTargetText, param(""))),
          path,
        ),
        nullable: true,
        candidateBounded: pageKey.candidateBounded,
      },
    });
    const pageResult = projectedValues(
      pageJoined,
      pageValues,
      this.#logicalSlots,
      path,
    );

    const eventInput = filter(
      input.relation,
      eq(observationKind, param("event")),
    );
    const eventKey = readValue(
      eventInput,
      input.slots,
      node.inputKey,
      `${path}.inputKey`,
    );
    if (eventKey.kind !== "entity" || eventKey.entity !== "observation")
      reject(path, "Observation identity was lost during Event lookup.");
    const eventTable = this.#storage.observationEventIdentityRows();
    const events = project(eventTable, {
      site_pk: eventTable.columns.site_pk,
      event_id: eventTable.columns.event_id,
      visit_id: eventTable.columns.visit_id,
    });
    const eventJoined = join(
      eventInput,
      events,
      and(
        eq(eventKey.keys[0]!, events.columns.site_pk),
        eq(eventKey.keys[2]!, events.columns.event_id),
      ),
    );
    const ownerTable = this.#storage.observationPageIdentityRows();
    const owners = project(ownerTable, {
      site_pk: ownerTable.columns.site_pk,
      visit_id: ownerTable.columns.visit_id,
      [target.idColumn]: ownerTable.columns[target.idColumn],
    });
    const eventWithOwner = join(
      eventJoined,
      owners,
      and(
        eq(eventJoined.columns.right_site_pk, owners.columns.site_pk),
        eq(eventJoined.columns.right_visit_id, owners.columns.visit_id),
      ),
      "left",
    );
    const ownerTargetId = relationColumn(
      eventWithOwner,
      `right_${target.idColumn}`,
      path,
    );
    const ownerTargetText = ownerTargetId as SqlExpression<
      string | null,
      ExpressionResultType<"text", boolean>
    >;
    const eventValues: {
      readonly slot: SlotId;
      readonly value: LoweredValue;
    }[] = node.output
      .filter((slot) => slot !== node.relatedSlot && required.has(slot))
      .map((slot) => ({
        slot,
        value: this.#joinedValue(
          eventWithOwner,
          input.slots.get(slot),
          "left_left_",
          path,
        ),
      }));
    eventValues.push({
      slot: node.relatedSlot,
      value: {
        kind: "entity",
        entity: target.entity,
        keys: [
          relationColumn(eventWithOwner, "right_site_pk", path),
          ownerTargetId,
        ],
        present: asPredicate(
          and(isNotNull(ownerTargetText), neq(ownerTargetText, param(""))),
          path,
        ),
        nullable: true,
        candidateBounded: eventKey.candidateBounded,
      },
    });
    const eventResult = projectedValues(
      eventWithOwner,
      eventValues,
      this.#logicalSlots,
      path,
    );
    const projected: LoweredRelation = {
      relation: union(pageResult.relation, eventResult.relation, true),
      slots: pageResult.slots,
      candidateActivity: input.candidateActivity,
      candidateActivitySessionRelation: input.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        input.candidateActivitySessionRestricted,
    };
    return {
      ...projected,
      candidateActivity: input.candidateActivity,
      candidateActivitySessionRelation: input.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        input.candidateActivitySessionRestricted,
    };
  }

  #lowerMembershipJoin(
    node: SemiJoinNode | AntiJoinNode,
    path: string,
  ): LoweredRelation {
    const left = this.#lowerNode(node.left);
    const right = this.#lowerNode(node.right);
    if (node.keys.length === 0)
      reject(path, "Membership joins require at least one explicit key.");
    const conditions = node.keys.map((key, index) =>
      keyEqual(
        readValue(
          left.relation,
          left.slots,
          key.left,
          `${path}.keys[${index}].left`,
        ),
        readValue(
          right.relation,
          right.slots,
          key.right,
          `${path}.keys[${index}].right`,
        ),
        `${path}.keys[${index}]`,
      ),
    );
    const condition = combinePredicates("and", conditions, path);
    const relation =
      node.kind === "semi-join"
        ? semiJoin(left.relation, right.relation, condition)
        : antiJoin(left.relation, right.relation, condition);

    const boundedSlots = new Set<SlotId>();
    for (const [slot, layout] of left.slots) {
      if (layout.candidateBounded) boundedSlots.add(slot);
    }
    for (const key of node.keys) {
      const leftValue = left.slots.get(key.left);
      const rightValue = right.slots.get(key.right);
      if (
        node.kind === "semi-join" &&
        leftValue?.kind === "entity" &&
        rightValue?.kind === "entity" &&
        leftValue.type.entity === rightValue.type.entity &&
        rightValue.candidateBounded
      )
        boundedSlots.add(key.left);
    }
    const required = this.#requiredOutput(node);
    const membershipPayloadProofs =
      node.kind === "semi-join"
        ? this.#eventPayloadKeyProofs.get(node.left)
        : undefined;
    const providerValues: ProviderProjectionValue[] = [];
    for (const [id, proof] of membershipPayloadProofs ?? []) {
      if (
        !node.output.includes(proof.request.eventKeySlot) ||
        proof.carrierRelation !== left.relation ||
        left.providerColumns?.get(id) !== proof.keyColumn
      )
        reject(
          path,
          "A transparent membership semi-join cannot propagate a mismatched Event payload key carrier.",
        );
      providerValues.push({
        id,
        expression: relationColumn(relation, proof.keyColumn, path),
        ...(proof.metadataColumns.size > 0
          ? {
              additionalValues: [...proof.metadataColumns.entries()].map(
                ([field, column]) => ({
                  id: analyticsEventPayloadMetadataProviderId(id, field),
                  expression: relationColumn(relation, column, path),
                }),
              ),
            }
          : {}),
      });
    }
    if (node.kind === "semi-join") {
      for (const [slot, layout] of left.slots) {
        if (
          layout.kind !== "entity" ||
          !layout.providerDistinctIdentity ||
          !node.output.includes(slot)
        )
          continue;
        const proof = layout.providerDistinctIdentity;
        if (
          layout.type.entity !== "event" ||
          layout.nullable ||
          proof.identitySlot !== slot ||
          proof.scopeRelation !== node.left ||
          proof.carrierRelation !== left.relation ||
          proof.identityColumns[0] !== layout.keyColumns[0] ||
          proof.identityColumns[1] !== layout.keyColumns[1]
        )
          reject(
            path,
            "A membership semi-join cannot propagate a mismatched Event distinct identity proof.",
          );
        providerValues.push({
          id: proof.sourceBinding.request.id,
          expression: relationColumn(relation, proof.discriminatorColumn, path),
          identitySlot: slot,
          identitySeed: {
            sourceBinding: proof.sourceBinding,
            sourceSignature: proof.sourceSignature,
            sourceId: proof.sourceId,
            eventKeySlot: proof.eventKeySlot,
            identitySlot: slot,
            scopeRelation: node.id,
            inputRelation: relation,
            inputIdentityColumns: proof.identityColumns,
            inputDiscriminatorColumn: proof.discriminatorColumn,
          },
        });
      }
    }
    const projected = projectedValues(
      relation,
      node.output
        .filter((slot) => required.has(slot))
        .map((slot) => ({
          slot,
          value: readValue(relation, left.slots, slot, path),
        })),
      this.#logicalSlots,
      path,
      providerValues,
    );
    const slots = new Map(
      [...projected.slots].map(
        ([slot, layout]) =>
          [
            slot,
            { ...layout, candidateBounded: boundedSlots.has(slot) },
          ] as const,
      ),
    );
    if (membershipPayloadProofs && membershipPayloadProofs.size > 0) {
      const proofs = new Map<string, EventPayloadKeyProof>();
      for (const [id, proof] of membershipPayloadProofs) {
        const keyColumn = projected.providerColumns?.get(id);
        const eventKeyLayout = slots.get(proof.request.eventKeySlot);
        if (!keyColumn || !eventKeyLayout)
          reject(
            path,
            "A membership semi-join lost its Event payload key layout.",
          );
        proofs.set(id, {
          ...proof,
          scopeRelation: node.id,
          carrierRelation: projected.relation,
          keyColumn,
          eventKeyLayout,
          metadataColumns: new Map(
            [...proof.metadataColumns.keys()].map((field) => {
              const column = projected.providerColumns?.get(
                analyticsEventPayloadMetadataProviderId(id, field),
              );
              if (!column)
                reject(
                  path,
                  "A membership semi-join lost hidden Event payload metadata.",
                );
              return [field, column] as const;
            }),
          ),
        });
      }
      this.#eventPayloadKeyProofs.set(node.id, proofs);
    }
    const pageSessionRestricted =
      node.kind === "semi-join" &&
      left.candidateActivity === "page" &&
      node.keys.length === 1 &&
      node.keys.every((key) => {
        const leftSlot = logicalSlot(this.#logicalSlots, key.left, path);
        const rightSlot = logicalSlot(this.#logicalSlots, key.right, path);
        return (
          leftSlot.type.kind === "entity" &&
          leftSlot.type.entity === "session" &&
          this.#hasRelationshipLineage(key.left, "page.session") &&
          rightSlot.type.kind === "entity" &&
          rightSlot.type.entity === "session" &&
          right.slots.get(key.right)?.candidateBounded === true
        );
      });
    return {
      relation: projected.relation,
      slots,
      ...(projected.providerColumns
        ? { providerColumns: projected.providerColumns }
        : {}),
      candidateActivity: left.candidateActivity,
      candidateActivitySessionRelation:
        left.candidateActivitySessionRelation ??
        (pageSessionRestricted ? node.right : undefined),
      candidateActivitySessionRestricted:
        left.candidateActivitySessionRestricted || pageSessionRestricted,
    };
  }

  #hasStorageBackedObservationIdentity(
    relation: RelationId,
    slot: SlotId,
    active = new Set<string>(),
  ): boolean {
    const visitKey = `${String(relation)}:${String(slot)}`;
    if (active.has(visitKey)) return false;
    const nextActive = new Set(active).add(visitKey);
    const node = this.#nodes.get(relation);
    if (!node || !node.output.includes(slot)) return false;
    switch (node.kind) {
      case "source": {
        const binding = node.values.find((item) => item.slot === slot);
        return (
          (binding?.kind === "self" && node.entity === "observation") ||
          (binding?.kind === "related-entity" &&
            node.entity === "event" &&
            binding.relationship === "event.observation") ||
          (binding?.kind === "related-entity" &&
            node.entity === "page" &&
            binding.relationship === "page.observation")
        );
      }
      case "filter":
        return this.#hasStorageBackedObservationIdentity(
          node.input,
          slot,
          nextActive,
        );
      case "project": {
        const projection = node.projections.find((item) => item.slot === slot);
        return (
          projection?.expression.kind === "slot" &&
          this.#hasStorageBackedObservationIdentity(
            node.input,
            projection.expression.slot,
            nextActive,
          )
        );
      }
      case "distinct": {
        const key = node.keys.find((item) => item.output === slot);
        return (
          key !== undefined &&
          this.#hasStorageBackedObservationIdentity(
            node.input,
            key.input,
            nextActive,
          )
        );
      }
      case "ordered-member":
        return this.#hasStorageBackedObservationIdentity(
          node.input,
          slot,
          nextActive,
        );
      case "ranked-members":
        return (
          slot !== node.rankSlot &&
          this.#hasStorageBackedObservationIdentity(
            node.input,
            slot,
            nextActive,
          )
        );
      case "semi-join":
      case "anti-join":
        return this.#hasStorageBackedObservationIdentity(
          node.left,
          slot,
          nextActive,
        );
      case "set-operation": {
        if (
          node.output.length !== 1 ||
          node.output[0] !== slot ||
          node.grain.kind !== "entity" ||
          node.grain.key !== slot ||
          node.grain.entity !== "observation"
        )
          return false;
        return node.inputs.every((inputId) => {
          const inputNode = this.#nodes.get(inputId);
          const inputSlot = inputNode?.output[0];
          return (
            inputNode?.output.length === 1 &&
            inputNode.grain.kind === "entity" &&
            inputNode.grain.entity === "observation" &&
            inputNode.grain.key === inputSlot &&
            inputSlot !== undefined &&
            this.#hasStorageBackedObservationIdentity(
              inputId,
              inputSlot,
              nextActive,
            )
          );
        });
      }
      case "aggregate":
      case "sample-statistics":
      case "join":
      case "row-concatenation":
      case "event-payload-occurrences":
      case "event-payload-properties":
        // Aggregates and joins do not supply a storage-backed Observation key.
        return false;
      case "analysis-result":
        // Imported values are already aggregated and cannot authorize raw reads.
        return false;
      case "sort":
        return this.#hasStorageBackedObservationIdentity(
          node.input,
          slot,
          nextActive,
        );
      case "limit":
        return this.#hasStorageBackedObservationIdentity(
          node.input,
          slot,
          nextActive,
        );
      case "relationship-lookup":
        return (
          slot !== node.relatedSlot &&
          this.#hasStorageBackedObservationIdentity(
            node.input,
            slot,
            nextActive,
          )
        );
    }
  }

  #lowerAggregate(node: AggregateNode, path: string): LoweredRelation {
    const input = this.#lowerNode(node.input);
    const required = this.#requiredOutput(node);
    const groupBy: Record<string, AnyExpression> = {};
    const aggregates: Record<string, AnyExpression> = {};
    const slots = new Map<SlotId, SlotLayout>();
    const visible = new Map(input.slots);

    node.groups.forEach((group, index) => {
      const groupPath = `${path}.groups[${index}].expression`;
      const value = scalarAggregateValue(
        lowerExpression(
          group.expression,
          input.relation,
          this.#logicalSlots,
          visible,
          groupPath,
          this.#plan.context.time,
          this.#comparisonAdmissionBinding
            ? {
                binding: this.#comparisonAdmissionBinding,
                owner: this,
                relationId: node.input,
              }
            : undefined,
        ),
        groupPath,
      );
      const outputSlot = logicalSlot(
        this.#logicalSlots,
        group.slot,
        `${path}.groups[${index}].slot`,
      );
      if (
        (outputSlot.type.kind !== "scalar" &&
          outputSlot.type.kind !== "bucket") ||
        !isSameLogicalValueType(outputSlot.type, value.type) ||
        outputSlot.nullable !== value.nullable
      )
        reject(
          `${path}.groups[${index}]`,
          "Group output metadata must match its scalar or bucket expression.",
        );

      const valueColumn = slotColumn(index, "g");
      groupBy[valueColumn] = value.expression;
      slots.set(group.slot, {
        kind: "scalar",
        type: outputSlot.type,
        nullable: outputSlot.nullable,
        valueColumn,
        candidateBounded: false,
      });
    });

    let selectedMeasureCount = 0;
    node.measures.forEach((measure, index) => {
      if (!required.has(measure.output)) return;
      selectedMeasureCount += 1;
      const outputSlot = logicalSlot(
        this.#logicalSlots,
        measure.output,
        `${path}.measures[${index}].output`,
      );
      const valueColumn = slotColumn(node.groups.length + index, "a");
      let expression: AnyExpression;
      let expectedType: LogicalValueType;
      let expectedNullable: boolean;

      if (measure.kind === "count-rows") {
        expression = count();
        expectedType = { kind: "scalar", scalar: "number" };
        expectedNullable = false;
      } else {
        const measurePath = `${path}.measures[${index}].input`;
        const value = lowerExpression(
          measure.input,
          input.relation,
          this.#logicalSlots,
          visible,
          measurePath,
          this.#plan.context.time,
          this.#comparisonAdmissionBinding
            ? {
                binding: this.#comparisonAdmissionBinding,
                owner: this,
                relationId: node.input,
              }
            : undefined,
        );
        if (measure.kind === "count-distinct") {
          if (value.kind === "scalar") {
            const scalar = scalarAggregateValue(value, measurePath);
            expression = countDistinct(scalar.expression);
          } else {
            const proof = value.providerDistinctIdentity;
            const slot =
              measure.input.kind === "slot" ? measure.input.slot : undefined;
            const layout =
              slot === undefined ? undefined : input.slots.get(slot);
            if (
              !proof ||
              slot === undefined ||
              slot !== proof.identitySlot ||
              layout?.kind !== "entity" ||
              layout.type.entity !== "event" ||
              layout.nullable ||
              value.entity !== "event" ||
              value.nullable
            )
              reject(
                measurePath,
                "COUNT(DISTINCT) supports Entity values only with a proven non-null Event identity.",
              );
            const discriminator = assertAnalyticsEventDistinctIdentityLayout(
              proof,
              {
                scopeRelation: node.input,
                identitySlot: slot,
                relation: input.relation,
                identityColumns: layout.keyColumns,
                keys: value.keys,
              },
              measurePath,
            );
            expression = countDistinct(discriminator);
          }
          expectedType = { kind: "scalar", scalar: "number" };
          expectedNullable = false;
        } else if (measure.kind === "sum") {
          const scalar = scalarAggregateValue(value, measurePath);
          expression = sum(numericAggregateExpression(scalar, measurePath));
          expectedType = scalar.type;
          expectedNullable = true;
        } else if (measure.kind === "avg") {
          const scalar = scalarAggregateValue(value, measurePath);
          expression = avg(numericAggregateExpression(scalar, measurePath));
          expectedType = scalar.type;
          expectedNullable = true;
        } else if (measure.kind === "min") {
          const scalar = comparableAggregateValue(value, measurePath);
          expression = min(scalar.expression);
          expectedType = scalar.type;
          expectedNullable = true;
        } else {
          const scalar = comparableAggregateValue(value, measurePath);
          expression = max(scalar.expression);
          expectedType = scalar.type;
          expectedNullable = true;
        }
      }

      if (
        outputSlot.type.kind !== "scalar" ||
        !isSameLogicalValueType(outputSlot.type, expectedType) ||
        outputSlot.nullable !== expectedNullable
      )
        reject(
          `${path}.measures[${index}].output`,
          "Aggregate output metadata must match its Logical measure.",
        );
      aggregates[valueColumn] = expression;
      slots.set(measure.output, {
        kind: "scalar",
        type: outputSlot.type,
        nullable: outputSlot.nullable,
        valueColumn,
        candidateBounded: false,
      });
    });

    if (node.groups.length === 0 && selectedMeasureCount === 0) {
      // An ungrouped aggregate still emits exactly one row for an empty bag.
      // Keep that cardinality with a hidden COUNT(*) instead of lowering
      // measure expressions that no selected output consumes.
      aggregates[slotColumn(node.measures.length, "h")] = count();
    }

    const relation: AnalyticsDbRelation = aggregate(input.relation, {
      groupBy,
      aggregates,
    });
    return { relation, slots, candidateActivitySessionRestricted: false };
  }

  #lowerSampleStatistics(
    node: SampleStatisticsNode,
    path: string,
  ): LoweredRelation {
    const input = this.#lowerNode(node.input);
    const visible = new Map(input.slots);
    const selected: Record<string, AnyExpression> = {};
    const groupColumns = node.groups.map((group, index) => {
      const groupPath = `${path}.groups[${index}]`;
      const value = scalarAggregateValue(
        lowerExpression(
          group.expression,
          input.relation,
          this.#logicalSlots,
          visible,
          `${groupPath}.expression`,
          this.#plan.context.time,
          this.#comparisonAdmissionBinding
            ? {
                binding: this.#comparisonAdmissionBinding,
                owner: this,
                relationId: node.input,
              }
            : undefined,
        ),
        `${groupPath}.expression`,
      );
      const outputSlot = logicalSlot(
        this.#logicalSlots,
        group.slot,
        `${groupPath}.slot`,
      );
      if (
        (outputSlot.type.kind !== "scalar" &&
          outputSlot.type.kind !== "bucket") ||
        !isSameLogicalValueType(outputSlot.type, value.type) ||
        outputSlot.nullable !== value.nullable
      )
        reject(
          groupPath,
          "Sample statistics group metadata must match its expression.",
        );
      const column = slotColumn(index, "g");
      selected[column] = value.expression;
      return {
        slot: group.slot,
        column,
        type: outputSlot.type,
        nullable: outputSlot.nullable,
      };
    });
    const numericValue = scalarAggregateValue(
      lowerExpression(
        node.value,
        input.relation,
        this.#logicalSlots,
        visible,
        `${path}.value`,
        this.#plan.context.time,
        this.#comparisonAdmissionBinding
          ? {
              binding: this.#comparisonAdmissionBinding,
              owner: this,
              relationId: node.input,
            }
          : undefined,
      ),
      `${path}.value`,
    );
    if (
      numericValue.type.kind !== "scalar" ||
      numericValue.type.scalar !== "number"
    )
      reject(
        `${path}.value`,
        "Sample statistics require numeric scalar values.",
      );
    const valueColumn = slotColumn(node.groups.length, "v");
    selected[valueColumn] = numericValue.expression;

    const projected = project(input.relation, selected);
    const projectedValue = projected.columns[valueColumn] as AnyExpression;
    const nonNull = filter(projected, isNotNull(projectedValue));
    const partitionBy = groupColumns.map(
      ({ column }) => nonNull.columns[column] as SqlExpression,
    );
    const ordinalColumn = "__analytics_sample_ordinal";
    const partitionCountColumn = "__analytics_sample_count";
    if (
      Object.hasOwn(selected, ordinalColumn) ||
      Object.hasOwn(selected, partitionCountColumn)
    )
      reject(path, "Sample statistics window aliases conflict with inputs.");
    const ordered = windowRelation(nonNull, {
      __analytics_sample_ordinal: rowNumber({
        partitionBy,
        orderBy: [
          {
            expression: nonNull.columns[valueColumn] as SqlExpression,
            direction: "ASC",
          },
        ],
      }),
      __analytics_sample_count: windowCountRows({ partitionBy }),
    });
    const groupBy: Record<string, AnyExpression> = Object.fromEntries(
      groupColumns.map(({ column }) => [
        column,
        ordered.columns[column] as AnyExpression,
      ]),
    );
    const aggregates: Record<string, AnyExpression> = {};
    const outputLayouts = new Map<SlotId, SlotLayout>();
    for (const group of groupColumns) {
      outputLayouts.set(group.slot, {
        kind: "scalar",
        type: group.type,
        nullable: group.nullable,
        valueColumn: group.column,
        candidateBounded: false,
      });
    }

    const samplesSlot = logicalSlot(
      this.#logicalSlots,
      node.samplesOutput,
      `${path}.samplesOutput`,
    );
    const averageSlot = logicalSlot(
      this.#logicalSlots,
      node.averageOutput,
      `${path}.averageOutput`,
    );
    if (
      samplesSlot.type.kind !== "scalar" ||
      samplesSlot.type.scalar !== "number" ||
      samplesSlot.type.unit !== undefined ||
      samplesSlot.nullable ||
      averageSlot.type.kind !== "scalar" ||
      !isSameLogicalValueType(averageSlot.type, numericValue.type) ||
      !averageSlot.nullable
    )
      reject(path, "Sample statistics output metadata is invalid.");

    const samplesColumn = slotColumn(node.groups.length, "samples");
    const averageColumn = slotColumn(node.groups.length + 1, "avg");
    aggregates[samplesColumn] = count();
    aggregates[averageColumn] = avg(
      ordered.columns[valueColumn] as SqlExpression<number | null>,
    );
    outputLayouts.set(node.samplesOutput, {
      kind: "scalar",
      type: samplesSlot.type,
      nullable: false,
      valueColumn: samplesColumn,
      candidateBounded: false,
    });
    outputLayouts.set(node.averageOutput, {
      kind: "scalar",
      type: averageSlot.type,
      nullable: true,
      valueColumn: averageColumn,
      candidateBounded: false,
    });

    node.percentiles.forEach((item, index) => {
      const outputSlot = logicalSlot(
        this.#logicalSlots,
        item.output,
        `${path}.percentiles[${index}].output`,
      );
      if (
        outputSlot.type.kind !== "scalar" ||
        !isSameLogicalValueType(outputSlot.type, numericValue.type) ||
        !outputSlot.nullable
      )
        reject(
          `${path}.percentiles[${index}].output`,
          "Quantile output metadata must preserve the numeric input type and be nullable.",
        );
      const threshold = castInteger(
        div(
          add(
            mul(
              ordered.columns[partitionCountColumn] as SqlExpression<number>,
              constant(item.percentile),
            ),
            constant(99),
          ),
          constant(100),
        ),
      );
      const column = slotColumn(node.groups.length + index + 2, "quantile");
      aggregates[column] = min(
        caseWhen(
          [
            {
              when: gte(
                ordered.columns[ordinalColumn] as SqlExpression<
                  number,
                  ExpressionResultType<"integer", false>
                >,
                threshold,
              ),
              then: ordered.columns[valueColumn] as SqlExpression<
                number | null,
                ExpressionResultType<"numeric", true>
              >,
            },
          ],
          constant(null),
        ),
      );
      outputLayouts.set(item.output, {
        kind: "scalar",
        type: outputSlot.type,
        nullable: true,
        valueColumn: column,
        candidateBounded: false,
      });
    });

    const relation: AnalyticsDbRelation = aggregate(ordered, {
      groupBy,
      aggregates,
    });
    return {
      relation,
      slots: outputLayouts,
      candidateActivitySessionRestricted: false,
    };
  }

  #windowPartitionBy(
    groups: readonly SlotId[],
    input: LoweredRelation,
    path: string,
  ): AnyExpression[] {
    return groups.map((slot, index) => {
      const slotPath = `${path}.groups[${index}]`;
      const logical = logicalSlot(this.#logicalSlots, slot, slotPath);
      if (logical.type.kind !== "scalar")
        reject(slotPath, "Ordered-member groups must be scalar values.");
      const value = readValue(input.relation, input.slots, slot, slotPath);
      if (value.kind !== "scalar")
        reject(slotPath, "Ordered-member groups must be scalar values.");
      return value.expression;
    });
  }

  #windowOrderBy(
    keys: readonly SortKey[],
    input: LoweredRelation,
    path: string,
  ): WindowOrderKey[] {
    const orderBy: WindowOrderKey[] = [];
    keys.forEach((key, index) => {
      const keyPath = `${path}.order[${index}]`;
      const logical = logicalSlot(
        this.#logicalSlots,
        key.slot,
        `${keyPath}.slot`,
      );
      if (logical.type.kind !== "scalar")
        reject(keyPath, "Ordered-member keys must be scalar values.");
      const value = readValue(
        input.relation,
        input.slots,
        key.slot,
        `${keyPath}.slot`,
      );
      if (value.kind !== "scalar")
        reject(keyPath, "Ordered-member keys must be scalar values.");
      const direction = key.direction === "asc" ? "ASC" : "DESC";
      const nativeNulls = key.direction === "asc" ? "first" : "last";
      if (key.nulls !== nativeNulls) {
        orderBy.push({
          expression: isNull(value.expression),
          direction: key.nulls === "first" ? "DESC" : "ASC",
        });
      }
      orderBy.push({ expression: value.expression, direction });
    });
    return orderBy;
  }

  #lowerOrderedMember(node: OrderedMemberNode, path: string): LoweredRelation {
    const input = this.#lowerNode(node.input);
    const partitionBy = this.#windowPartitionBy(node.groups, input, path);
    const orderBy = this.#windowOrderBy(node.order, input, path);

    if (partitionBy.length === 0 || orderBy.length === 0)
      reject(path, "Ordered-member requires groups and order keys.");
    const ranked = windowRelation(input.relation, {
      __analytics_ordered_member_rank: rowNumber({
        partitionBy,
        orderBy: orderBy as [WindowOrderKey, ...WindowOrderKey[]],
      }),
    });
    const selected = filter(
      ranked,
      eq(ranked.columns.__analytics_ordered_member_rank, constant(1)),
    );
    const inputNode = this.#logicalNode(node.input);
    if (!inputNode)
      reject(`${path}.input`, "The ordered-member input node is missing.");
    const values = inputNode.output
      .filter((slot) => this.#requiredOutput(node).has(slot))
      .map((slot) => ({
        slot,
        value: readValue(selected, input.slots, slot, path),
      }));
    const projected = projectedValues(
      selected,
      values,
      this.#logicalSlots,
      path,
    );
    return {
      ...projected,
      candidateActivity: input.candidateActivity,
      candidateActivitySessionRelation: input.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        input.candidateActivitySessionRestricted,
    };
  }

  #lowerRankedMembers(node: RankedMembersNode, path: string): LoweredRelation {
    const inputNode = this.#logicalNode(node.input);
    if (!inputNode)
      reject(`${path}.input`, "The ranked-members input node is missing.");
    const inputGrain = inputNode.grain;
    if (
      inputGrain.kind !== "keyed" ||
      inputGrain.keys.length === 0 ||
      new Set(inputGrain.keys).size !== inputGrain.keys.length
    )
      reject(
        `${path}.input.grain`,
        "Ranked members require a unique keyed grain.",
      );
    if (
      new Set(node.groups).size !== node.groups.length ||
      node.order.length === 0 ||
      new Set(node.order.map((key) => key.slot)).size !== node.order.length
    )
      reject(path, "Ranked-member grouping and ordering keys are invalid.");
    for (const [index, slot] of [
      ...node.groups,
      ...node.order.map((key) => key.slot),
    ].entries()) {
      if (!inputNode.output.includes(slot))
        reject(
          `${path}.keys[${index}]`,
          "Ranked-member key is not visible in its input.",
        );
      if (
        logicalSlot(this.#logicalSlots, slot, `${path}.keys[${index}]`).type
          .kind !== "scalar"
      )
        reject(`${path}.keys[${index}]`, "Ranked-member keys must be scalar.");
    }
    for (const [index, key] of node.order.entries()) {
      if (
        (key.direction !== "asc" && key.direction !== "desc") ||
        (key.nulls !== "first" && key.nulls !== "last")
      )
        reject(
          `${path}.order[${index}]`,
          "Ranked-member ordering metadata is invalid.",
        );
    }
    const rankingKeys = [
      ...new Set([...node.groups, ...node.order.map((key) => key.slot)]),
    ];
    if (
      inputGrain.keys.some(
        (key) =>
          !rankingKeys.includes(key) ||
          logicalSlot(this.#logicalSlots, key, `${path}.input.grain`).type
            .kind !== "scalar",
      ) ||
      node.grain.kind !== "keyed" ||
      node.grain.keys.length !== inputGrain.keys.length ||
      node.grain.keys.some((key, index) => key !== inputGrain.keys[index])
    )
      reject(
        `${path}.grain`,
        "Ranked-member keys must cover and preserve input grain.",
      );
    if (
      node.output.length !== inputNode.output.length + 1 ||
      inputNode.output.some((slot, index) => node.output[index] !== slot) ||
      node.output.at(-1) !== node.rankSlot ||
      inputNode.output.includes(node.rankSlot)
    )
      reject(
        `${path}.output`,
        "Ranked members must append exactly one new rank slot.",
      );
    const rankSlot = logicalSlot(
      this.#logicalSlots,
      node.rankSlot,
      `${path}.rankSlot`,
    );
    if (
      !isSameLogicalValueType(rankSlot.type, {
        kind: "scalar",
        scalar: "number",
      }) ||
      rankSlot.nullable ||
      rankSlot.lineage.kind !== "derived" ||
      rankSlot.lineage.operation !== "ranked-members" ||
      rankSlot.lineage.inputs.length !== rankingKeys.length ||
      rankSlot.lineage.inputs.some((slot, index) => slot !== rankingKeys[index])
    )
      reject(
        `${path}.rankSlot`,
        "Rank output must be a new non-null unitless numeric derived slot.",
      );

    const input = this.#lowerNode(node.input);
    const required = this.#requiredOutput(node);
    const rankNeeded = required.has(node.rankSlot);
    let relation = input.relation;
    if (rankNeeded) {
      const partitionBy = this.#windowPartitionBy(node.groups, input, path);
      const orderBy = this.#windowOrderBy(node.order, input, path);
      if (orderBy.length === 0)
        reject(path, "Ranked members require order keys.");
      relation = windowRelation(input.relation, {
        __analytics_ranked_member_ordinal: rowNumber({
          partitionBy,
          orderBy: orderBy as [WindowOrderKey, ...WindowOrderKey[]],
        }),
      });
    }
    const values = inputNode.output
      .filter((slot) => required.has(slot))
      .map((slot) => ({
        slot,
        value: readValue(relation, input.slots, slot, path),
      }));
    if (rankNeeded) {
      values.push({
        slot: node.rankSlot,
        value: {
          kind: "scalar",
          expression: relationColumn(
            relation,
            "__analytics_ranked_member_ordinal",
            `${path}.rankSlot`,
          ),
          type: { kind: "scalar", scalar: "number" },
          nullable: false,
          candidateBounded: false,
        },
      });
    }
    const projected = projectedValues(
      relation,
      values,
      this.#logicalSlots,
      path,
    );
    return {
      ...projected,
      candidateActivity: input.candidateActivity,
      candidateActivitySessionRelation: input.candidateActivitySessionRelation,
      candidateActivitySessionRestricted:
        input.candidateActivitySessionRestricted,
    };
  }

  #lowerJoin(node: JoinNode, path: string): LoweredRelation {
    const leftNode = this.#logicalNode(node.left);
    const rightNode = this.#logicalNode(node.right);
    if (!leftNode || !rightNode) reject(path, "A join input node is missing.");
    const keylessScalarBroadcast =
      node.joinType === "inner" &&
      node.keys.length === 0 &&
      rightNode.grain.kind === "scalar";
    const keylessScalarInner =
      keylessScalarBroadcast && node.grain.kind === "scalar";
    if (!keylessScalarBroadcast) {
      if (
        (node.joinType !== "inner" && node.joinType !== "left") ||
        node.keys.length === 0 ||
        rightNode.grain.kind === "entity"
      )
        reject(
          path,
          "Only keyless scalar inner joins and keyed scalar inner/left joins are supported.",
        );
      const coveredRightKeys = new Set(node.keys.map((key) => key.right));
      for (const [index, key] of node.keys.entries()) {
        const leftKey = logicalSlot(
          this.#logicalSlots,
          key.left,
          `${path}.keys[${index}].left`,
        );
        const rightKey = logicalSlot(
          this.#logicalSlots,
          key.right,
          `${path}.keys[${index}].right`,
        );
        if (
          (leftKey.type.kind !== "scalar" && leftKey.type.kind !== "bucket") ||
          (rightKey.type.kind !== "scalar" &&
            rightKey.type.kind !== "bucket") ||
          !isSameLogicalValueType(leftKey.type, rightKey.type)
        )
          reject(
            `${path}.keys[${index}]`,
            "Keyed joins require matching scalar or bucket key types.",
          );
      }
      const rightGrainKeys =
        rightNode.grain.kind === "keyed" ? rightNode.grain.keys : [];
      for (const [index, key] of rightGrainKeys.entries()) {
        const slot = logicalSlot(
          this.#logicalSlots,
          key,
          `${path}.right.grain.keys[${index}]`,
        );
        if (
          (slot.type.kind !== "scalar" && slot.type.kind !== "bucket") ||
          !coveredRightKeys.has(key)
        )
          reject(
            `${path}.keys`,
            "Join keys must cover the complete scalar or bucket right grain.",
          );
      }
    }
    const left = this.#lowerNode(node.left);
    const right = this.#lowerNode(node.right);
    const predicate = keylessScalarBroadcast
      ? eq(param(1), param(1))
      : combinePredicates(
          "and",
          node.keys.map((key, index) => {
            const leftValue = readValue(
              left.relation,
              left.slots,
              key.left,
              `${path}.keys[${index}].left`,
            );
            const rightValue = readValue(
              right.relation,
              right.slots,
              key.right,
              `${path}.keys[${index}].right`,
            );
            if (leftValue.kind !== "scalar" || rightValue.kind !== "scalar")
              reject(
                `${path}.keys[${index}]`,
                "Keyed joins require scalar physical key expressions.",
              );
            return eq(leftValue.expression, rightValue.expression);
          }),
          `${path}.keys`,
        );
    const joined = join(
      left.relation,
      right.relation,
      predicate,
      node.joinType,
    );
    const required = this.#requiredOutput(node);
    const values: { readonly slot: SlotId; readonly value: LoweredValue }[] = [
      ...leftNode.output
        .filter((slot) => required.has(slot))
        .map((slot) => ({
          slot,
          value: this.#joinedValue(joined, left.slots.get(slot), "left_", path),
        })),
    ];
    const aliases =
      node.joinType === "left"
        ? new Map(node.rightAliases.map((alias) => [alias.source, alias.alias]))
        : undefined;
    for (const sourceSlot of rightNode.output) {
      const outputSlot = aliases?.get(sourceSlot) ?? sourceSlot;
      if (!required.has(outputSlot)) continue;
      let value = this.#joinedValue(
        joined,
        right.slots.get(sourceSlot),
        "right_",
        path,
      );
      if (!keylessScalarInner) {
        if (value.kind !== "scalar")
          reject(
            `${path}.right.${String(sourceSlot)}`,
            "Keyed joins currently expose scalar right values only.",
          );
        if (aliases) {
          const alias = logicalSlot(
            this.#logicalSlots,
            outputSlot,
            `${path}.rightAliases.${String(outputSlot)}`,
          );
          if (alias.type.kind !== "scalar" || !alias.nullable)
            reject(
              `${path}.rightAliases.${String(outputSlot)}`,
              "Left-joined scalar aliases must be nullable.",
            );
          value = { ...value, nullable: alias.nullable };
        }
      }
      values.push({ slot: outputSlot, value });
    }
    const projected = projectedValues(joined, values, this.#logicalSlots, path);
    return keylessScalarInner
      ? projected
      : {
          ...projected,
          candidateActivity: left.candidateActivity,
          candidateActivitySessionRelation:
            left.candidateActivitySessionRelation,
          candidateActivitySessionRestricted:
            left.candidateActivitySessionRestricted,
        };
  }

  #joinedValue(
    joined: AnalyticsDbRelation,
    layout: SlotLayout | undefined,
    prefix: string,
    path: string,
  ): LoweredValue {
    if (!layout) reject(path, "Join input slot mapping is missing.");
    if (layout.kind === "scalar")
      return {
        kind: "scalar",
        expression: relationColumn(
          joined,
          `${prefix}${layout.valueColumn}`,
          path,
        ),
        type: layout.type,
        nullable: layout.nullable,
        candidateBounded: layout.candidateBounded,
      };
    return {
      kind: "entity",
      entity: layout.type.entity,
      keys: layout.keyColumns.map((name) =>
        relationColumn(joined, `${prefix}${name}`, path),
      ),
      present: layout.presentColumn
        ? asPredicate(
            relationColumn(joined, `${prefix}${layout.presentColumn}`, path),
            path,
          )
        : isNotNull(
            relationColumn(joined, `${prefix}${layout.keyColumns[0]!}`, path),
          ),
      nullable: layout.nullable,
      candidateBounded: layout.candidateBounded,
    };
  }

  #prepareRequiredSlots(
    outputs: readonly LogicalOutput[],
    reachable: ReadonlySet<RelationId>,
  ): void {
    this.#requiredSlots.clear();
    this.#requiredProviderSourceBindings.clear();
    this.#eventPayloadKeyRequestsByOccurrence.clear();
    this.#eventPayloadKeyRequestsByProperties.clear();
    this.#eventPayloadKeyProofs.clear();
    for (const output of outputs)
      this.#addRequiredSlots(
        output.relation,
        output.fields.map((field) => field.slot),
      );
    for (const node of this.#plan.nodes) {
      if (!reachable.has(node.id)) continue;
      if (
        node.kind !== "event-payload-occurrences" &&
        node.kind !== "event-payload-properties"
      )
        continue;
      const source = this.#eventPayloadSource(
        node.input,
        node.eventKey,
        `${nodePath(node.id)}.input`,
      );
      const isProperties = node.kind === "event-payload-properties";
      const request: AnalyticsProviderSourceBindingRequest = {
        kind: "event-payload-key",
        id: JSON.stringify([
          isProperties ? "event-payload-properties-key" : "event-payload-key",
          String(source.id),
        ]),
        sourceId: source.id,
        eventKeySlot: node.eventKey,
        ...(isProperties ? { includePayloadPropertiesMetadata: true } : {}),
      };
      const existing =
        this.#requiredProviderSourceBindings.get(source.id) ?? [];
      if (!existing.some((binding) => binding.id === request.id))
        this.#requiredProviderSourceBindings.set(source.id, [
          ...existing,
          request,
        ]);
      if (isProperties)
        this.#eventPayloadKeyRequestsByProperties.set(node.id, request);
      else this.#eventPayloadKeyRequestsByOccurrence.set(node.id, request);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.#plan.nodes) {
        if (!reachable.has(node.id)) continue;
        const needed = this.#requiredSlots.get(node.id);
        if (!needed) continue;
        const add = (relation: RelationId, slots: readonly SlotId[]) => {
          if (this.#addRequiredSlots(relation, slots)) changed = true;
        };
        switch (node.kind) {
          case "source":
          case "analysis-result":
            // Imported children keep their own relation/slot namespace.
            break;
          case "filter":
            add(node.input, [
              ...node.output.filter((slot) => needed.has(slot)),
              ...this.#expressionSlots(node.predicate),
            ]);
            break;
          case "event-payload-occurrences":
            add(node.input, [node.eventKey]);
            break;
          case "event-payload-properties":
            add(node.input, [
              ...node.output.filter((slot) => needed.has(slot)),
              node.eventKey,
            ]);
            break;
          case "project":
            for (const projection of node.projections) {
              if (needed.has(projection.slot))
                add(node.input, this.#expressionSlots(projection.expression));
            }
            break;
          case "ordered-member":
            add(node.input, [
              ...node.output.filter((slot) => needed.has(slot)),
              ...node.groups,
              ...node.order.map((key) => key.slot),
            ]);
            break;
          case "ranked-members":
            add(node.input, [
              ...node.output.filter(
                (slot) => slot !== node.rankSlot && needed.has(slot),
              ),
              ...node.groups,
              ...node.order.map((key) => key.slot),
            ]);
            break;
          case "relationship-lookup":
            add(node.input, [
              ...node.output.filter(
                (slot) => slot !== node.relatedSlot && needed.has(slot),
              ),
              ...(needed.has(node.relatedSlot) ? [node.inputKey] : []),
            ]);
            break;
          case "distinct":
            add(
              node.input,
              node.keys.map((key) => key.input),
            );
            break;
          case "set-operation":
            for (const inputId of node.inputs) {
              const source = this.#nodes.get(inputId);
              if (!source) continue;
              add(
                inputId,
                node.output.flatMap((slot, index) =>
                  needed.has(slot) && source.output[index] !== undefined
                    ? [source.output[index]!]
                    : [],
                ),
              );
            }
            break;
          case "row-concatenation":
            node.inputs.forEach((inputId, inputIndex) =>
              add(
                inputId,
                node.columns.flatMap((column) =>
                  needed.has(column.output) &&
                  column.inputs[inputIndex] !== undefined
                    ? [column.inputs[inputIndex]!]
                    : [],
                ),
              ),
            );
            break;
          case "semi-join":
          case "anti-join": {
            const left = this.#nodes.get(node.left);
            if (!left) break;
            add(node.left, [
              ...left.output.filter((slot) => needed.has(slot)),
              ...node.keys.map((key) => key.left),
            ]);
            add(
              node.right,
              node.keys.map((key) => key.right),
            );
            break;
          }
          case "aggregate": {
            add(node.input, [
              ...node.groups.flatMap((group) =>
                this.#expressionSlots(group.expression),
              ),
              ...node.measures.flatMap((measure) =>
                !needed.has(measure.output) || measure.kind === "count-rows"
                  ? []
                  : this.#expressionSlots(measure.input),
              ),
            ]);
            break;
          }
          case "sample-statistics":
            add(node.input, [
              ...node.groups.flatMap((group) =>
                this.#expressionSlots(group.expression),
              ),
              ...this.#expressionSlots(node.value),
            ]);
            break;
          case "join": {
            const left = this.#nodes.get(node.left);
            const right = this.#nodes.get(node.right);
            if (left)
              add(node.left, [
                ...left.output.filter((slot) => needed.has(slot)),
                ...node.keys.map((key) => key.left),
              ]);
            if (right) {
              const requestedRight =
                node.joinType === "left"
                  ? node.rightAliases
                      .filter((alias) => needed.has(alias.alias))
                      .map((alias) => alias.source)
                  : right.output.filter((slot) => needed.has(slot));
              add(node.right, [
                ...requestedRight,
                ...node.keys.map((key) => key.right),
              ]);
            }
            break;
          }
          case "sort":
            add(node.input, [
              ...node.output.filter((slot) => needed.has(slot)),
              ...node.keys.map((key) => key.slot),
            ]);
            break;
          case "limit":
            add(
              node.input,
              node.output.filter((slot) => needed.has(slot)),
            );
            break;
        }
      }
    }
  }

  #addRequiredSlots(relation: RelationId, slots: readonly SlotId[]): boolean {
    let changed = false;
    let required = this.#requiredSlots.get(relation);
    if (!required) {
      required = new Set<SlotId>();
      this.#requiredSlots.set(relation, required);
      changed = true;
    }
    for (const slot of slots) {
      if (required.has(slot)) continue;
      required.add(slot);
      changed = true;
    }
    return changed;
  }

  #requiredOutput(node: LogicalNode): ReadonlySet<SlotId> {
    const required = this.#requiredSlots.get(node.id);
    return required ?? new Set(node.output);
  }

  #expressionSlots(expression: LogicalExpr): readonly SlotId[] {
    switch (expression.kind) {
      case "slot":
        return [expression.slot];
      case "literal":
      case "elapsed-duration-literal":
      case "calendar-period-literal":
        return [];
      case "comparison":
      case "arithmetic":
        return [
          ...this.#expressionSlots(expression.left),
          ...this.#expressionSlots(expression.right),
        ];
      case "boolean":
        return expression.terms.flatMap((term) => this.#expressionSlots(term));
      case "not":
      case "null-test":
      case "string-match":
      case "string-normalize":
      case "number-report-text":
      case "numeric-value":
      case "absolute":
      case "round":
      case "time-bucket":
      case "bucket-index":
        return this.#expressionSlots(expression.input);
      case "text-concatenation":
        return expression.values.flatMap((value) =>
          this.#expressionSlots(value),
        );
      case "page-dimension":
        return expression.dependencies.flatMap((dependency) =>
          this.#expressionSlots(dependency.expression),
        );
      case "set-membership":
        return this.#expressionSlots(expression.input);
      case "coalesce":
        return expression.values.flatMap((value) =>
          this.#expressionSlots(value),
        );
      case "case":
        return [
          ...expression.branches.flatMap((branch) => [
            ...this.#expressionSlots(branch.when),
            ...this.#expressionSlots(branch.then),
          ]),
          ...this.#expressionSlots(expression.otherwise),
        ];
    }
  }

  #inputSetSlotBounded(
    entry: LoweredRelation,
    relationId: RelationId,
  ): boolean {
    const node = this.#nodes.get(relationId);
    const slot = node?.output[0];
    return (
      slot !== undefined && entry.slots.get(slot)?.candidateBounded === true
    );
  }

  #hasRelationshipLineage(id: SlotId, relationship: "page.session"): boolean {
    const seen = new Set<SlotId>();
    let current: SlotId | undefined = id;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const slot = this.#logicalSlots.get(current);
      if (!slot) return false;
      if (
        slot.lineage.kind === "relationship" &&
        slot.lineage.relationship === relationship
      )
        return true;
      current = slot.lineage.kind === "alias" ? slot.lineage.source : undefined;
    }
    return false;
  }

  #logicalNode(id: RelationId): LogicalNode | undefined {
    return this.#nodes.get(id);
  }
}
