import {
  aggregate,
  and,
  antiJoin,
  callFunction,
  compileD1Query,
  type CompiledQuery,
  count,
  eq,
  filter,
  gte,
  inList,
  isNotNull,
  join,
  lowerLogicalPlan,
  lt,
  neq,
  param,
  project,
  scan,
  semiJoin,
  union,
} from "@/lib/db";
import { D1StatementBudgetError } from "@/lib/db/d1-budget";
import type { AnyExpression } from "@/lib/db/query/expression";
import type { Relation } from "@/lib/db/query/plan";
import { schema } from "@/lib/db/schema";
import type {
  EpochMs,
  ReportingTimeZone,
  SiteId,
  TimeRange,
} from "@/lib/edge/analytics/contract/types";
import {
  LogicalPlanBuilder,
  lowerFilterDocumentToScope,
} from "@/lib/edge/analytics/engine";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type {
  AggregateNode,
  DistinctNode,
  FilterNode,
  LogicalNode,
  ProjectNode,
  RelationshipLookupNode,
  SetOperationNode,
  SourceNode,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type {
  LogicalPlan,
  ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { resolveAnalyticsScope } from "@/lib/edge/analytics/engine/semantic/entities";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticTemporalDomains } from "@/lib/edge/analytics/engine/semantic/time";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type AnalyzedFilterDocument,
  analyzeFilterDocument,
} from "@/lib/filter-contract/filter-semantics";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

export interface AnalyticsPageSessionLoweringInput {
  readonly document: unknown;
  readonly siteIds: readonly SiteId[];
  readonly candidateRange: TimeRange;
  readonly readRange: TimeRange;
  readonly reportingTimeZone: ReportingTimeZone;
  readonly capturedAtMs: EpochMs;
}

export interface AnalyticsSessionIdentityRow {
  readonly site_pk: number;
  readonly session_id: string;
}

export interface AnalyticsSessionCountRow {
  readonly sessions: number;
}

export interface AnalyticsSessionViewsRow {
  readonly views: number;
}

export interface AnalyticsSessionOverviewPairRow {
  readonly sessions: number;
  readonly views: number;
}

export type AnalyticsPageSessionLoweringResult =
  | {
      readonly kind: "supported";
      readonly logicalPlan: ValidatedLogicalPlan;
      readonly query: CompiledQuery<AnalyticsSessionIdentityRow>;
    }
  | {
      readonly kind: "unsupported";
      readonly capability: string;
      readonly node: string;
      readonly reason: string;
    };

export type AnalyticsSessionCountLoweringResult =
  | {
      readonly kind: "supported";
      readonly logicalPlan: ValidatedLogicalPlan;
      readonly query: CompiledQuery<AnalyticsSessionCountRow>;
    }
  | UnsupportedResult;

export type AnalyticsSessionViewsLoweringResult =
  | {
      readonly kind: "supported";
      readonly logicalPlan: ValidatedLogicalPlan;
      readonly query: CompiledQuery<AnalyticsSessionViewsRow>;
    }
  | UnsupportedResult;

export type AnalyticsSessionOverviewPairLoweringResult =
  | {
      readonly kind: "supported";
      readonly logicalPlan: ValidatedLogicalPlan;
      readonly query: CompiledQuery<AnalyticsSessionOverviewPairRow>;
    }
  | UnsupportedResult;

export interface AnalyticsSessionViewsExpectedContext {
  readonly siteId: string;
  readonly candidateRange: TimeRange;
  readonly readRange: TimeRange;
}

type UnsupportedResult = Extract<
  AnalyticsPageSessionLoweringResult,
  { readonly kind: "unsupported" }
>;

type SessionSetPlan =
  | { readonly kind: "candidate"; readonly relationId: RelationId }
  | {
      readonly kind: "page-path";
      readonly relationId: RelationId;
      readonly paths: readonly string[];
    }
  | {
      readonly kind: "event-name";
      readonly relationId: RelationId;
      readonly names: readonly string[];
    }
  | {
      readonly kind: "set-operation";
      readonly relationId: RelationId;
      readonly operation: SetOperationNode["operation"];
      readonly inputs: readonly SessionSetPlan[];
    };

interface SessionPlanSemantics {
  readonly siteId: SiteId;
  readonly candidateRange: TimeRange;
  readonly readRange: TimeRange;
  readonly set: SessionSetPlan;
}

interface SessionPlanContextSemantics {
  readonly siteId: SiteId;
  readonly candidateRange: TimeRange;
  readonly readRange: TimeRange;
}

class PlanShapeMismatch extends Error {
  constructor(
    readonly node: string,
    message: string,
  ) {
    super(message);
    this.name = "PlanShapeMismatch";
  }
}

function unsupported(
  capability: string,
  node: string,
  reason: string,
): UnsupportedResult {
  return { kind: "unsupported", capability, node, reason };
}

function mismatch(node: string, reason: string): never {
  throw new PlanShapeMismatch(node, reason);
}

function requirePlan(
  condition: unknown,
  node: string,
  reason: string,
): asserts condition {
  if (!condition) mismatch(node, reason);
}

function nodeAt<Kind extends LogicalNode["kind"]>(
  plan: ValidatedLogicalPlan,
  id: RelationId,
  kind: Kind,
  path: string,
  visited?: Set<RelationId>,
): Extract<LogicalNode, { readonly kind: Kind }> {
  const node = plan.nodes.find((candidate) => candidate.id === id);
  if (!node || node.kind !== kind) {
    mismatch(path, `Expected a ${kind} node for relation ${String(id)}.`);
  }
  visited?.add(node.id);
  return node as Extract<LogicalNode, { readonly kind: Kind }>;
}

function relationNodeAt(
  plan: ValidatedLogicalPlan,
  id: RelationId,
  path: string,
  visited: Set<RelationId>,
): LogicalNode {
  const node = plan.nodes.find((candidate) => candidate.id === id);
  if (!node) mismatch(path, `Relation ${String(id)} is missing.`);
  visited.add(node.id);
  return node;
}

function slotAt(plan: ValidatedLogicalPlan, id: SlotId, path: string) {
  const slot = plan.slots.find((candidate) => candidate.id === id);
  if (!slot) mismatch(path, `Slot ${String(id)} is missing.`);
  return slot;
}

function entitySlotAt(
  plan: ValidatedLogicalPlan,
  id: SlotId,
  entity: "observation" | "event" | "page" | "session",
  nullable: boolean,
  path: string,
): void {
  const slot = slotAt(plan, id, path);
  requirePlan(
    slot.type.kind === "entity" &&
      slot.type.entity === entity &&
      slot.nullable === nullable,
    path,
    `Expected ${nullable ? "nullable" : "non-null"} ${entity} identity slot.`,
  );
}

function sameSlots(left: readonly SlotId[], right: readonly SlotId[]): boolean {
  return (
    left.length === right.length &&
    left.every((slot, index) => slot === right[index])
  );
}

function rangeIsSafe(range: TimeRange): boolean {
  return (
    Number.isSafeInteger(range.startMs) &&
    Number.isSafeInteger(range.endExclusiveMs) &&
    range.startMs < range.endExclusiveMs
  );
}

function planNodePath(id: RelationId): string {
  return `nodes[${String(id)}]`;
}

function requireObservationGrain(
  node: LogicalNode,
  key: SlotId,
  path: string,
): void {
  requirePlan(
    node.grain.kind === "entity" &&
      node.grain.entity === "observation" &&
      node.grain.key === key,
    path,
    "Expected the Observation identity as the relation grain.",
  );
}

function requireSessionGrain(
  node: LogicalNode,
  plan: ValidatedLogicalPlan,
  path: string,
): void {
  requirePlan(
    node.output.length === 1 &&
      node.grain.kind === "entity" &&
      node.grain.entity === "session" &&
      node.grain.key === node.output[0],
    path,
    "Expected a unary Session identity relation.",
  );
  entitySlotAt(plan, node.output[0]!, "session", false, `${path}.output[0]`);
}

function readPageSourceBindings(
  plan: ValidatedLogicalPlan,
  source: SourceNode,
  visited: Set<RelationId>,
  path: string,
): { readonly observation: SlotId; readonly pagePath: SlotId } {
  visited.add(source.id);
  requirePlan(
    source.entity === "observation" && source.temporalDomain === "read",
    `${path}.temporalDomain`,
    "Page.path evidence must come from Source<observation>[read].",
  );
  requirePlan(
    source.values.length === 2,
    path,
    "Unexpected read Source bindings.",
  );
  const self = source.values.filter((binding) => binding.kind === "self");
  const attributes = source.values.filter(
    (binding) => binding.kind === "attribute",
  );
  requirePlan(
    self.length === 1 &&
      attributes.length === 1 &&
      attributes[0]!.attribute === "page.path",
    path,
    "The read Source must expose Observation identity and page.path only.",
  );
  const observation = self[0]!.slot;
  const pagePath = attributes[0]!.slot;
  entitySlotAt(plan, observation, "observation", false, `${path}.self`);
  const pagePathSlot = slotAt(plan, pagePath, `${path}.page.path`);
  requirePlan(
    pagePathSlot.type.kind === "scalar" &&
      pagePathSlot.type.scalar === "string" &&
      pagePathSlot.nullable &&
      pagePathSlot.lineage.kind === "attribute" &&
      pagePathSlot.lineage.attribute === "page.path",
    `${path}.page.path`,
    "The page.path slot must be a nullable string attribute.",
  );
  requirePlan(
    sameSlots(source.output, [observation, pagePath]) &&
      source.grain.kind === "entity" &&
      source.grain.entity === "observation" &&
      source.grain.key === observation,
    path,
    "The read Source output and grain must preserve Observation identity.",
  );
  return { observation, pagePath };
}

function readEventSourceBindings(
  plan: ValidatedLogicalPlan,
  source: SourceNode,
  visited: Set<RelationId>,
  path: string,
): {
  readonly event: SlotId;
  readonly observation: SlotId;
  readonly eventName: SlotId;
} {
  visited.add(source.id);
  requirePlan(
    source.entity === "event" && source.temporalDomain === "read",
    `${path}.temporalDomain`,
    "event.name evidence must come from Source<event>[read].",
  );
  requirePlan(
    source.values.length === 3,
    path,
    "Unexpected read Event Source bindings.",
  );
  const self = source.values.filter((binding) => binding.kind === "self");
  const relationships = source.values.filter(
    (binding) => binding.kind === "related-entity",
  );
  const attributes = source.values.filter(
    (binding) => binding.kind === "attribute",
  );
  requirePlan(
    self.length === 1 &&
      relationships.length === 1 &&
      relationships[0]!.relationship === "event.observation" &&
      attributes.length === 1 &&
      attributes[0]!.attribute === "event.name",
    path,
    "The read Event Source must expose Event identity, event.observation, and event.name only.",
  );
  const event = self[0]!.slot;
  const observation = relationships[0]!.slot;
  const eventName = attributes[0]!.slot;
  entitySlotAt(plan, event, "event", false, `${path}.self`);
  const observationSlot = slotAt(
    plan,
    observation,
    `${path}.event.observation`,
  );
  requirePlan(
    observationSlot.type.kind === "entity" &&
      observationSlot.type.entity === "observation" &&
      !observationSlot.nullable &&
      observationSlot.lineage.kind === "relationship" &&
      observationSlot.lineage.relationship === "event.observation",
    `${path}.event.observation`,
    "event.observation must preserve a non-null Observation identity.",
  );
  const eventNameSlot = slotAt(plan, eventName, `${path}.event.name`);
  requirePlan(
    eventNameSlot.type.kind === "scalar" &&
      eventNameSlot.type.scalar === "string" &&
      !eventNameSlot.nullable &&
      eventNameSlot.lineage.kind === "attribute" &&
      eventNameSlot.lineage.attribute === "event.name",
    `${path}.event.name`,
    "The event.name slot must be a non-null string attribute.",
  );
  requirePlan(
    sameSlots(source.output, [event, observation, eventName]) &&
      source.grain.kind === "entity" &&
      source.grain.entity === "event" &&
      source.grain.key === event,
    path,
    "The read Source output and grain must preserve Event identity.",
  );
  return { event, observation, eventName };
}

function pagePathValues(
  filterNode: FilterNode,
  pagePathSlot: SlotId,
): readonly string[] {
  return normalizedStringValues(filterNode, pagePathSlot, "page.path");
}

function eventNameValues(
  filterNode: FilterNode,
  eventNameSlot: SlotId,
): readonly string[] {
  return normalizedStringValues(filterNode, eventNameSlot, "event.name");
}

function normalizedStringValues(
  filterNode: FilterNode,
  valueSlot: SlotId,
  field: "page.path" | "event.name",
): readonly string[] {
  const path = `${planNodePath(filterNode.id)}.predicate`;
  const predicate = filterNode.predicate;
  if (predicate.kind === "comparison") {
    requirePlan(
      predicate.operator === "eq" &&
        predicate.stringNormalization === "trim" &&
        predicate.left.kind === "slot" &&
        predicate.left.slot === valueSlot &&
        predicate.right.kind === "literal" &&
        typeof predicate.right.value === "string" &&
        predicate.right.valueType.kind === "scalar" &&
        predicate.right.valueType.scalar === "string",
      path,
      `Only ${field} eq <string> with trim normalization is supported.`,
    );
    return [predicate.right.value];
  }
  if (predicate.kind === "set-membership") {
    requirePlan(
      !predicate.negated &&
        predicate.stringNormalization === "trim" &&
        predicate.input.kind === "slot" &&
        predicate.input.slot === valueSlot &&
        predicate.values.length === 2 &&
        predicate.values.every(
          (value) =>
            typeof value.value === "string" &&
            value.valueType.kind === "scalar" &&
            value.valueType.scalar === "string",
        ),
      path,
      `Only two-value ${field} OR normalized to positive set-membership is supported.`,
    );
    return predicate.values.map((value) => value.value as string);
  }
  mismatch(
    path,
    `Only ${field} equality and its normalized two-value OR set-membership are supported.`,
  );
}

function validateReadPathFilter(
  plan: ValidatedLogicalPlan,
  node: FilterNode,
  source: SourceNode,
  sourceBindings: { readonly observation: SlotId; readonly pagePath: SlotId },
  visited: Set<RelationId>,
): readonly string[] {
  visited.add(node.id);
  requirePlan(
    node.input === source.id &&
      sameSlots(node.output, source.output) &&
      node.grain.kind === "entity" &&
      node.grain.entity === "observation" &&
      node.grain.key === sourceBindings.observation,
    `${planNodePath(node.id)}.input/output`,
    "The page.path Filter must preserve its read Observation bindings.",
  );
  return pagePathValues(node, sourceBindings.pagePath);
}

function validateReadEventFilter(
  node: FilterNode,
  source: SourceNode,
  sourceBindings: { readonly event: SlotId; readonly eventName: SlotId },
  visited: Set<RelationId>,
): readonly string[] {
  visited.add(node.id);
  requirePlan(
    node.input === source.id &&
      sameSlots(node.output, source.output) &&
      node.grain.kind === "entity" &&
      node.grain.entity === "event" &&
      node.grain.key === sourceBindings.event,
    `${planNodePath(node.id)}.input/output`,
    "The event.name Filter must preserve its read Event bindings.",
  );
  return eventNameValues(node, sourceBindings.eventName);
}

function validateReadPageProjection(
  node: ProjectNode,
  input: RelationId,
  observation: SlotId,
  visited: Set<RelationId>,
): SlotId {
  visited.add(node.id);
  requirePlan(
    node.input === input &&
      node.projections.length === 1 &&
      node.projections[0]!.expression.kind === "slot" &&
      node.projections[0]!.expression.slot === observation &&
      node.output.length === 1 &&
      node.output[0] === node.projections[0]!.slot &&
      node.grain.kind === "entity" &&
      node.grain.entity === "observation" &&
      node.grain.key === node.output[0],
    planNodePath(node.id),
    "The page.path match must project its Page Observation identity.",
  );
  return node.output[0]!;
}

function validateReadEventProjection(
  node: ProjectNode,
  input: RelationId,
  sourceBindings: {
    readonly event: SlotId;
    readonly observation: SlotId;
  },
  plan: ValidatedLogicalPlan,
  visited: Set<RelationId>,
): SlotId {
  visited.add(node.id);
  requirePlan(
    node.input === input &&
      node.projections.length === 2 &&
      node.projections[0]!.expression.kind === "slot" &&
      node.projections[0]!.expression.slot === sourceBindings.observation &&
      node.projections[1]!.expression.kind === "slot" &&
      node.projections[1]!.expression.slot === sourceBindings.event &&
      node.output.length === 2 &&
      node.output[0] === node.projections[0]!.slot &&
      node.output[1] === node.projections[1]!.slot &&
      node.grain.kind === "entity" &&
      node.grain.entity === "event" &&
      node.grain.key === node.output[1],
    planNodePath(node.id),
    "The event.name match must project event.observation and preserve Event identity.",
  );
  entitySlotAt(
    plan,
    node.output[0]!,
    "observation",
    false,
    `${planNodePath(node.id)}.output[0]`,
  );
  entitySlotAt(
    plan,
    node.output[1]!,
    "event",
    false,
    `${planNodePath(node.id)}.output[1]`,
  );
  return node.output[0]!;
}

function validateObservationDistinct(
  node: DistinctNode,
  input: ProjectNode,
  inputKey: SlotId,
  plan: ValidatedLogicalPlan,
  visited: Set<RelationId>,
): SlotId {
  visited.add(node.id);
  requirePlan(
    node.input === input.id &&
      node.excludeNull &&
      node.keys.length === 1 &&
      node.keys[0]!.input === inputKey &&
      node.keys[0]!.output === node.output[0] &&
      node.output.length === 1,
    planNodePath(node.id),
    "Matched observations must be non-null and distinct by the projected identity.",
  );
  requireObservationGrain(node, node.output[0]!, planNodePath(node.id));
  entitySlotAt(
    plan,
    node.output[0]!,
    "observation",
    false,
    `${planNodePath(node.id)}.output`,
  );
  return node.output[0]!;
}

function validateSessionRelationship(
  node: RelationshipLookupNode,
  input: RelationId,
  inputKey: SlotId,
  visited: Set<RelationId>,
): SlotId {
  visited.add(node.id);
  requirePlan(
    node.input === input &&
      node.relationship === "observation.session" &&
      node.inputKey === inputKey &&
      node.timeSemantics === "identity-no-activity-filter" &&
      node.output.includes(inputKey) &&
      node.output.includes(node.relatedSlot) &&
      node.grain.kind === "entity" &&
      node.grain.entity === "observation" &&
      node.grain.key === inputKey,
    planNodePath(node.id),
    "Historical identity lookup must attach observation.session without another activity-time filter.",
  );
  return node.relatedSlot;
}

function validateSessionProjection(
  node: ProjectNode,
  input: RelationId,
  relationship: RelationshipLookupNode,
  visited: Set<RelationId>,
): { readonly session: SlotId; readonly observation: SlotId } {
  visited.add(node.id);
  requirePlan(
    node.input === input &&
      node.projections.length === 2 &&
      node.projections[0]!.expression.kind === "slot" &&
      node.projections[0]!.expression.slot === relationship.relatedSlot &&
      node.projections[1]!.expression.kind === "slot" &&
      node.projections[1]!.expression.slot === relationship.inputKey &&
      node.output.length === 2 &&
      node.output[0] === node.projections[0]!.slot &&
      node.output[1] === node.projections[1]!.slot &&
      node.grain.kind === "entity" &&
      node.grain.entity === "observation" &&
      node.grain.key === node.output[1],
    planNodePath(node.id),
    "The relationship projection must preserve Session and Observation identity slots.",
  );
  return { session: node.output[0]!, observation: node.output[1]! };
}

function validateSessionDistinct(
  node: DistinctNode,
  input: ProjectNode,
  inputKey: SlotId,
  plan: ValidatedLogicalPlan,
  visited: Set<RelationId>,
): void {
  visited.add(node.id);
  requirePlan(
    node.input === input.id &&
      node.excludeNull &&
      node.keys.length === 1 &&
      node.keys[0]!.input === inputKey &&
      node.keys[0]!.output === node.output[0],
    planNodePath(node.id),
    "Session identity must be null-excluding and distinct by the mapped Session slot.",
  );
  requireSessionGrain(node, plan, planNodePath(node.id));
}

function parseHistoricalSessionSet(
  plan: ValidatedLogicalPlan,
  sessionDistinct: DistinctNode,
  sessionProjection: ProjectNode,
  visited: Set<RelationId>,
):
  | {
      readonly kind: "page-path";
      readonly values: readonly string[];
    }
  | {
      readonly kind: "event-name";
      readonly values: readonly string[];
    } {
  const relationship = nodeAt(
    plan,
    sessionProjection.input,
    "relationship-lookup",
    `${planNodePath(sessionProjection.id)}.input`,
    visited,
  );
  const observationDistinct = nodeAt(
    plan,
    relationship.input,
    "distinct",
    `${planNodePath(relationship.id)}.input`,
    visited,
  );
  const observationProjection = nodeAt(
    plan,
    observationDistinct.input,
    "project",
    `${planNodePath(observationDistinct.id)}.input`,
    visited,
  );
  const nativeInput = relationNodeAt(
    plan,
    observationProjection.input,
    `${planNodePath(observationProjection.id)}.input`,
    visited,
  );
  let evidence:
    | { readonly kind: "page-path"; readonly values: readonly string[] }
    | { readonly kind: "event-name"; readonly values: readonly string[] };

  if (nativeInput.kind === "filter") {
    const readSource = nodeAt(
      plan,
      nativeInput.input,
      "source",
      `${planNodePath(nativeInput.id)}.input`,
      visited,
    );
    const readBindings = readPageSourceBindings(
      plan,
      readSource,
      visited,
      planNodePath(readSource.id),
    );
    const values = validateReadPathFilter(
      plan,
      nativeInput,
      readSource,
      readBindings,
      visited,
    );
    const matchedObservationSlot = validateReadPageProjection(
      observationProjection,
      nativeInput.id,
      readBindings.observation,
      visited,
    );
    validateObservationDistinct(
      observationDistinct,
      observationProjection,
      matchedObservationSlot,
      plan,
      visited,
    );
    evidence = { kind: "page-path", values };
  } else if (nativeInput.kind === "distinct") {
    const nativeObservationDistinct = nativeInput;
    const eventProjection = nodeAt(
      plan,
      nativeObservationDistinct.input,
      "project",
      `${planNodePath(nativeObservationDistinct.id)}.input`,
      visited,
    );
    const eventFilter = nodeAt(
      plan,
      eventProjection.input,
      "filter",
      `${planNodePath(eventProjection.id)}.input`,
      visited,
    );
    const readSource = nodeAt(
      plan,
      eventFilter.input,
      "source",
      `${planNodePath(eventFilter.id)}.input`,
      visited,
    );
    const readBindings = readEventSourceBindings(
      plan,
      readSource,
      visited,
      planNodePath(readSource.id),
    );
    const values = validateReadEventFilter(
      eventFilter,
      readSource,
      readBindings,
      visited,
    );
    const matchedObservationSlot = validateReadEventProjection(
      eventProjection,
      eventFilter.id,
      readBindings,
      plan,
      visited,
    );
    validateObservationDistinct(
      nativeObservationDistinct,
      eventProjection,
      matchedObservationSlot,
      plan,
      visited,
    );
    requirePlan(
      observationProjection.input === nativeObservationDistinct.id &&
        observationProjection.projections.length === 1 &&
        observationProjection.projections[0]!.expression.kind === "slot" &&
        observationProjection.projections[0]!.expression.slot ===
          nativeObservationDistinct.output[0] &&
        observationProjection.output.length === 1 &&
        observationProjection.output[0] ===
          observationProjection.projections[0]!.slot &&
        observationProjection.grain.kind === "entity" &&
        observationProjection.grain.entity === "observation" &&
        observationProjection.grain.key === observationProjection.output[0],
      planNodePath(observationProjection.id),
      "The Event observation set must preserve its native Observation identity before Session lookup.",
    );
    entitySlotAt(
      plan,
      observationProjection.output[0]!,
      "observation",
      false,
      `${planNodePath(observationProjection.id)}.output[0]`,
    );
    validateObservationDistinct(
      observationDistinct,
      observationProjection,
      observationProjection.output[0]!,
      plan,
      visited,
    );
    evidence = { kind: "event-name", values };
  } else {
    mismatch(
      `${planNodePath(observationProjection.id)}.input`,
      "Historical Session evidence must lower through a read Page Filter or Event Filter.",
    );
  }
  validateSessionRelationship(
    relationship,
    observationDistinct.id,
    observationDistinct.output[0]!,
    visited,
  );
  const sessionSlots = validateSessionProjection(
    sessionProjection,
    relationship.id,
    relationship,
    visited,
  );
  requirePlan(
    sessionSlots.session === sessionDistinct.keys[0]!.input &&
      sessionSlots.observation === sessionProjection.output[1],
    `${planNodePath(sessionDistinct.id)}.input`,
    "The historical Session set must use the looked-up Session relationship.",
  );
  validateSessionDistinct(
    sessionDistinct,
    sessionProjection,
    sessionSlots.session,
    plan,
    visited,
  );
  return evidence;
}

function parseCandidateSessionSet(
  plan: ValidatedLogicalPlan,
  sessionDistinct: DistinctNode,
  source: SourceNode,
  visited: Set<RelationId>,
): void {
  visited.add(sessionDistinct.id);
  visited.add(source.id);
  requirePlan(
    source.entity === "observation" &&
      source.temporalDomain === "candidate" &&
      source.values.length === 2,
    `${planNodePath(source.id)}.temporalDomain`,
    "The candidate universe must be Source<observation>[candidate].",
  );
  const self = source.values.filter((binding) => binding.kind === "self");
  const relationships = source.values.filter(
    (binding) => binding.kind === "related-entity",
  );
  requirePlan(
    self.length === 1 &&
      relationships.length === 1 &&
      relationships[0]!.relationship === "observation.session",
    `${planNodePath(source.id)}.values`,
    "The candidate Source must expose Observation identity and observation.session only.",
  );
  const observation = self[0]!.slot;
  const session = relationships[0]!.slot;
  entitySlotAt(
    plan,
    observation,
    "observation",
    false,
    `${planNodePath(source.id)}.self`,
  );
  entitySlotAt(
    plan,
    session,
    "session",
    true,
    `${planNodePath(source.id)}.observation.session`,
  );
  requirePlan(
    sameSlots(source.output, [observation, session]) &&
      source.grain.kind === "entity" &&
      source.grain.entity === "observation" &&
      source.grain.key === observation,
    planNodePath(source.id),
    "Candidate Observation identity and Session relationship slots must be preserved.",
  );
  requirePlan(
    sessionDistinct.input === source.id &&
      sessionDistinct.excludeNull &&
      sessionDistinct.keys.length === 1 &&
      sessionDistinct.keys[0]!.input === session &&
      sessionDistinct.keys[0]!.output === sessionDistinct.output[0],
    planNodePath(sessionDistinct.id),
    "Candidate Session identities must be null-excluding and distinct by observation.session.",
  );
  requireSessionGrain(sessionDistinct, plan, planNodePath(sessionDistinct.id));
}

function parseSessionSetPlan(
  plan: ValidatedLogicalPlan,
  relationId: RelationId,
  path: string,
  visited: Set<RelationId>,
  memo: Map<RelationId, SessionSetPlan>,
): SessionSetPlan {
  const existing = memo.get(relationId);
  if (existing) return existing;
  const node = relationNodeAt(plan, relationId, path, visited);
  let lowered: SessionSetPlan;
  if (node.kind === "set-operation") {
    requirePlan(
      node.inputs.length === 2,
      `${planNodePath(node.id)}.inputs`,
      "Only binary Session set operations are supported in this wave.",
    );
    requireSessionGrain(node, plan, planNodePath(node.id));
    const inputs = node.inputs.map((input, index) =>
      parseSessionSetPlan(
        plan,
        input,
        `${planNodePath(node.id)}.inputs[${index}]`,
        visited,
        memo,
      ),
    );
    lowered = {
      kind: "set-operation",
      relationId: node.id,
      operation: node.operation,
      inputs,
    };
  } else if (node.kind === "distinct") {
    requirePlan(
      node.excludeNull && node.keys.length === 1 && node.output.length === 1,
      planNodePath(node.id),
      "Session sources must be null-excluding distinct relations.",
    );
    requireSessionGrain(node, plan, planNodePath(node.id));
    const input = relationNodeAt(
      plan,
      node.input,
      `${planNodePath(node.id)}.input`,
      visited,
    );
    if (input.kind === "source") {
      parseCandidateSessionSet(plan, node, input, visited);
      lowered = { kind: "candidate", relationId: node.id };
    } else if (input.kind === "project") {
      const evidence = parseHistoricalSessionSet(plan, node, input, visited);
      lowered =
        evidence.kind === "page-path"
          ? {
              kind: "page-path",
              relationId: node.id,
              paths: evidence.values,
            }
          : {
              kind: "event-name",
              relationId: node.id,
              names: evidence.values,
            };
    } else {
      mismatch(
        `${planNodePath(node.id)}.input`,
        "Only candidate Observation sets and historical page.path/event.name Session sets are supported.",
      );
    }
  } else {
    mismatch(
      planNodePath(node.id),
      "Only Session set-operation roots, candidate Session sets, and page.path/event.name Session sets are supported.",
    );
  }
  memo.set(relationId, lowered);
  return lowered;
}

function candidateSubsetViolation(set: SessionSetPlan): RelationId | undefined {
  if (set.kind === "candidate") return undefined;
  if (set.kind === "page-path" || set.kind === "event-name") {
    return set.relationId;
  }

  const [left, right] = set.inputs;
  const leftViolation = candidateSubsetViolation(left!);
  const rightViolation = candidateSubsetViolation(right!);
  switch (set.operation) {
    case "union":
      return leftViolation === undefined && rightViolation === undefined
        ? undefined
        : set.relationId;
    case "intersect":
      return leftViolation === undefined || rightViolation === undefined
        ? undefined
        : set.relationId;
    case "difference":
      return leftViolation === undefined ? undefined : set.relationId;
  }
}

function matchSessionPlanContext(
  plan: ValidatedLogicalPlan,
): SessionPlanContextSemantics {
  const context = plan.context;
  requirePlan(
    context.scope.requested === "session" &&
      context.scope.contractScope === "session" &&
      context.scope.logicalScope === "session",
    "context.scope",
    "Only the concrete Session scope is supported.",
  );
  requirePlan(
    context.subject.origin === "site" &&
      context.subject.siteIds.length === 1 &&
      typeof context.subject.siteIds[0] === "string" &&
      context.subject.siteIds[0]!.length > 0,
    "context.subject",
    "Exactly one non-empty authorized site identity is required.",
  );
  requirePlan(
    context.time.filter === undefined &&
      context.time.read.kind === "bounded" &&
      rangeIsSafe(context.time.candidate) &&
      rangeIsSafe(context.time.read.range),
    "context.time",
    "Only bounded candidate/read domains are supported; a filter domain is not.",
  );
  return {
    siteId: context.subject.siteIds[0] as SiteId,
    candidateRange: context.time.candidate,
    readRange: context.time.read.range,
  };
}

function matchCandidateBoundedSessionSet(
  plan: ValidatedLogicalPlan,
  relationId: RelationId,
  path: string,
  visited: Set<RelationId>,
): SessionSetPlan {
  const outputRelation = relationNodeAt(plan, relationId, path, visited);
  requirePlan(
    outputRelation.kind === "set-operation",
    path,
    "The Session set must remain a candidate-scoped set operation.",
  );
  const set = parseSessionSetPlan(plan, relationId, path, visited, new Map());
  const candidateSubsetIssue = candidateSubsetViolation(set);
  if (candidateSubsetIssue !== undefined) {
    mismatch(
      planNodePath(candidateSubsetIssue),
      "The Session set is not proven to be a subset of the candidate Session universe.",
    );
  }
  return set;
}

function requireAllPlanNodesVisited(
  plan: ValidatedLogicalPlan,
  visited: ReadonlySet<RelationId>,
): void {
  if (visited.size !== plan.nodes.length) {
    const unreachable = plan.nodes.find((node) => !visited.has(node.id));
    mismatch(
      unreachable ? planNodePath(unreachable.id) : "nodes",
      "The output cannot leave any Boolean or relational subtree unreachable.",
    );
  }
}

function matchSessionPlan(plan: ValidatedLogicalPlan): SessionPlanSemantics {
  const context = matchSessionPlanContext(plan);
  requirePlan(
    plan.outputs.length === 1 &&
      plan.outputs[0]!.id === "matches" &&
      plan.outputs[0]!.fields.length === 1 &&
      plan.outputs[0]!.fields[0]!.name === "entity" &&
      plan.outputs[0]!.fields[0]!.semantic === undefined,
    "outputs",
    "Expected one matches.entity Session key output.",
  );

  const output = plan.outputs[0]!;
  const visited = new Set<RelationId>();
  const outputRelation = relationNodeAt(
    plan,
    output.relation,
    "outputs[0].relation",
    visited,
  );
  const set = matchCandidateBoundedSessionSet(
    plan,
    outputRelation.id,
    "outputs[0].relation",
    visited,
  );
  const outputSlot = output.fields[0]!.slot;
  requirePlan(
    outputRelation.output.length === 1 &&
      outputRelation.output[0] === outputSlot,
    "outputs[0].fields[0].slot",
    "The output field must reference the output relation's Session key.",
  );
  entitySlotAt(plan, outputSlot, "session", false, "outputs[0].fields[0].slot");
  requireAllPlanNodesVisited(plan, visited);
  return {
    ...context,
    set,
  };
}

function validateScalarMetricProjection(
  plan: ValidatedLogicalPlan,
  node: ProjectNode,
  input: RelationId,
  inputSlot: SlotId,
  path: string,
  visited: Set<RelationId>,
): SlotId {
  visited.add(node.id);
  requirePlan(
    node.input === input &&
      node.projections.length === 1 &&
      node.projections[0]!.expression.kind === "slot" &&
      node.projections[0]!.expression.slot === inputSlot &&
      node.output.length === 1 &&
      node.output[0] === node.projections[0]!.slot &&
      node.grain.kind === "scalar",
    path,
    "A scalar metric Project must preserve the aggregate slot exactly.",
  );
  const outputSlot = slotAt(plan, node.output[0]!, `${path}.output[0]`);
  requirePlan(
    outputSlot.type.kind === "scalar" &&
      outputSlot.type.scalar === "number" &&
      !outputSlot.nullable &&
      outputSlot.lineage.kind === "alias" &&
      outputSlot.lineage.source === inputSlot,
    `${path}.output[0]`,
    "The scalar metric Project output must remain a non-null numeric alias.",
  );
  return outputSlot.id;
}

function matchSessionCountPlan(
  plan: ValidatedLogicalPlan,
): SessionPlanSemantics {
  const context = matchSessionPlanContext(plan);
  requirePlan(
    plan.outputs.length === 1 &&
      plan.outputs[0]!.id === "semantic-aggregate" &&
      plan.outputs[0]!.fields.length === 1 &&
      plan.outputs[0]!.fields[0]!.name === "sessions" &&
      plan.outputs[0]!.fields[0]!.semantic?.kind === "metric" &&
      plan.outputs[0]!.fields[0]!.semantic?.id === "sessions",
    "outputs",
    "Expected the semantic-aggregate.sessions metric output only.",
  );

  const output = plan.outputs[0]!;
  const visited = new Set<RelationId>();
  const finalProject = nodeAt(
    plan,
    output.relation,
    "project",
    "outputs[0].relation",
    visited,
  );
  const metricProject = nodeAt(
    plan,
    finalProject.input,
    "project",
    `${planNodePath(finalProject.id)}.input`,
    visited,
  );
  const aggregateNode = nodeAt(
    plan,
    metricProject.input,
    "aggregate",
    `${planNodePath(metricProject.id)}.input`,
    visited,
  );
  requirePlan(
    aggregateNode.groups.length === 0 &&
      aggregateNode.measures.length === 1 &&
      aggregateNode.measures[0]!.kind === "count-rows" &&
      aggregateNode.output.length === 1 &&
      aggregateNode.output[0] === aggregateNode.measures[0]!.output &&
      aggregateNode.grain.kind === "scalar",
    planNodePath(aggregateNode.id),
    "Only an ungrouped single COUNT_ROWS Aggregate is supported for sessions.",
  );
  const aggregateOutput = slotAt(
    plan,
    aggregateNode.output[0]!,
    `${planNodePath(aggregateNode.id)}.output[0]`,
  );
  requirePlan(
    aggregateOutput.type.kind === "scalar" &&
      aggregateOutput.type.scalar === "number" &&
      !aggregateOutput.nullable &&
      aggregateOutput.lineage.kind === "derived" &&
      aggregateOutput.lineage.operation === "aggregate:count-rows",
    `${planNodePath(aggregateNode.id)}.output[0]`,
    "The sessions Aggregate must produce a non-null count-rows number.",
  );

  const metricProjectOutput = validateScalarMetricProjection(
    plan,
    metricProject,
    aggregateNode.id,
    aggregateOutput.id,
    planNodePath(metricProject.id),
    visited,
  );
  const finalProjectOutput = validateScalarMetricProjection(
    plan,
    finalProject,
    metricProject.id,
    metricProjectOutput,
    planNodePath(finalProject.id),
    visited,
  );
  requirePlan(
    finalProject.output.length === 1 &&
      finalProject.output[0] === output.fields[0]!.slot,
    "outputs[0].fields[0].slot",
    "The semantic output must reference the projected sessions count.",
  );
  const outputSlot = slotAt(
    plan,
    finalProjectOutput,
    "outputs[0].fields[0].slot",
  );
  requirePlan(
    finalProjectOutput === output.fields[0]!.slot &&
      outputSlot.type.kind === "scalar" &&
      outputSlot.type.scalar === "number" &&
      !outputSlot.nullable,
    "outputs[0].fields[0].slot",
    "The sessions output must be a non-null numeric value.",
  );
  const set = matchCandidateBoundedSessionSet(
    plan,
    aggregateNode.input,
    `${planNodePath(aggregateNode.id)}.input`,
    visited,
  );
  requireAllPlanNodesVisited(plan, visited);
  return { ...context, set };
}

function matchSessionViewsPlan(
  plan: ValidatedLogicalPlan,
): SessionPlanSemantics {
  const context = matchSessionPlanContext(plan);
  requirePlan(
    plan.outputs.length === 1 &&
      plan.outputs[0]!.id === "semantic-aggregate" &&
      plan.outputs[0]!.fields.length === 1 &&
      plan.outputs[0]!.fields[0]!.name === "views" &&
      plan.outputs[0]!.fields[0]!.semantic?.kind === "metric" &&
      plan.outputs[0]!.fields[0]!.semantic?.id === "views",
    "outputs",
    "Expected the semantic-aggregate.views metric output only.",
  );

  const output = plan.outputs[0]!;
  const visited = new Set<RelationId>();
  const finalProject = nodeAt(
    plan,
    output.relation,
    "project",
    "outputs[0].relation",
    visited,
  );
  const metricProject = nodeAt(
    plan,
    finalProject.input,
    "project",
    `${planNodePath(finalProject.id)}.input`,
    visited,
  );
  const aggregateNode = nodeAt(
    plan,
    metricProject.input,
    "aggregate",
    `${planNodePath(metricProject.id)}.input`,
    visited,
  );
  requirePlan(
    aggregateNode.groups.length === 0 &&
      aggregateNode.measures.length === 1 &&
      aggregateNode.measures[0]!.kind === "count-rows" &&
      aggregateNode.output.length === 1 &&
      aggregateNode.output[0] === aggregateNode.measures[0]!.output &&
      aggregateNode.grain.kind === "scalar",
    planNodePath(aggregateNode.id),
    "Only an ungrouped single COUNT_ROWS Aggregate is supported for views.",
  );
  const aggregateOutput = slotAt(
    plan,
    aggregateNode.output[0]!,
    `${planNodePath(aggregateNode.id)}.output[0]`,
  );
  requirePlan(
    aggregateOutput.type.kind === "scalar" &&
      aggregateOutput.type.scalar === "number" &&
      !aggregateOutput.nullable &&
      aggregateOutput.lineage.kind === "derived" &&
      aggregateOutput.lineage.operation === "aggregate:count-rows",
    `${planNodePath(aggregateNode.id)}.output[0]`,
    "The views Aggregate must produce a non-null count-rows number.",
  );
  const metricProjectOutput = validateScalarMetricProjection(
    plan,
    metricProject,
    aggregateNode.id,
    aggregateOutput.id,
    planNodePath(metricProject.id),
    visited,
  );
  const finalProjectOutput = validateScalarMetricProjection(
    plan,
    finalProject,
    metricProject.id,
    metricProjectOutput,
    planNodePath(finalProject.id),
    visited,
  );
  requirePlan(
    finalProject.output.length === 1 &&
      finalProject.output[0] === output.fields[0]!.slot,
    "outputs[0].fields[0].slot",
    "The semantic output must reference the projected views count.",
  );
  const outputSlot = slotAt(
    plan,
    finalProjectOutput,
    "outputs[0].fields[0].slot",
  );
  requirePlan(
    finalProjectOutput === output.fields[0]!.slot &&
      outputSlot.type.kind === "scalar" &&
      outputSlot.type.scalar === "number" &&
      !outputSlot.nullable,
    "outputs[0].fields[0].slot",
    "The views output must be a non-null numeric value.",
  );

  const pageMembership = nodeAt(
    plan,
    aggregateNode.input,
    "semi-join",
    `${planNodePath(aggregateNode.id)}.input`,
    visited,
  );
  // A Page Source has one entity-key row per Page; the SEMI JOIN preserves
  // those rows and cannot multiply them when the Session set has extra facts.
  const candidatePages = nodeAt(
    plan,
    pageMembership.left,
    "source",
    `${planNodePath(pageMembership.id)}.left`,
    visited,
  );
  requirePlan(
    candidatePages.entity === "page" &&
      candidatePages.temporalDomain === "candidate" &&
      candidatePages.values.length === 2 &&
      candidatePages.output.length === 2 &&
      candidatePages.values[0]!.kind === "self" &&
      candidatePages.values[1]!.kind === "related-entity" &&
      candidatePages.values[1]!.relationship === "page.session" &&
      candidatePages.values[0]!.slot === candidatePages.output[0] &&
      candidatePages.values[1]!.slot === candidatePages.output[1] &&
      candidatePages.grain.kind === "entity" &&
      candidatePages.grain.entity === "page" &&
      candidatePages.grain.key === candidatePages.values[0]!.slot,
    planNodePath(candidatePages.id),
    "The left input must be the unique candidate Page Source with its page.session relationship.",
  );
  const pageIdentitySlot = candidatePages.values[0]!.slot;
  const pageSessionSlot = candidatePages.values[1]!.slot;
  entitySlotAt(
    plan,
    pageIdentitySlot,
    "page",
    false,
    `${planNodePath(candidatePages.id)}.self`,
  );
  const pageSessionOutput = slotAt(
    plan,
    pageSessionSlot,
    `${planNodePath(candidatePages.id)}.page.session`,
  );
  requirePlan(
    pageSessionOutput.type.kind === "entity" &&
      pageSessionOutput.type.entity === "session" &&
      pageSessionOutput.nullable &&
      pageSessionOutput.lineage.kind === "relationship" &&
      pageSessionOutput.lineage.relationship === "page.session",
    `${planNodePath(candidatePages.id)}.page.session`,
    "The Page membership key must be the nullable page.session relation.",
  );
  requirePlan(
    pageMembership.output.length === candidatePages.output.length &&
      sameSlots(pageMembership.output, candidatePages.output) &&
      pageMembership.grain.kind === "entity" &&
      pageMembership.grain.entity === "page" &&
      pageMembership.grain.key === pageIdentitySlot &&
      pageMembership.keys.length === 1 &&
      pageMembership.keys[0]!.left === pageSessionSlot,
    planNodePath(pageMembership.id),
    "The Session membership semi-join must preserve candidate Page identity and use page.session.",
  );

  const sessionSet = matchCandidateBoundedSessionSet(
    plan,
    pageMembership.right,
    `${planNodePath(pageMembership.id)}.right`,
    visited,
  );
  const sessionSetRoot = nodeAt(
    plan,
    pageMembership.right,
    "set-operation",
    `${planNodePath(pageMembership.id)}.right`,
  );
  requirePlan(
    sessionSetRoot.output.length === 1 &&
      sessionSetRoot.grain.kind === "entity" &&
      sessionSetRoot.grain.entity === "session" &&
      sessionSetRoot.grain.key === sessionSetRoot.output[0] &&
      pageMembership.keys[0]!.right === sessionSetRoot.output[0],
    `${planNodePath(pageMembership.id)}.keys[0].right`,
    "The Page relation must semi-join against the proven Session entity key.",
  );
  entitySlotAt(
    plan,
    sessionSetRoot.output[0]!,
    "session",
    false,
    `${planNodePath(sessionSetRoot.id)}.output[0]`,
  );
  requireAllPlanNodesVisited(plan, visited);
  return { ...context, set: sessionSet };
}

function matchCountRowsAggregate(
  plan: ValidatedLogicalPlan,
  relationId: RelationId,
  metric: "sessions" | "views",
  visited: Set<RelationId>,
): { readonly node: AggregateNode; readonly output: SlotId } {
  const path = planNodePath(relationId);
  const aggregateNode = nodeAt(plan, relationId, "aggregate", path, visited);
  requirePlan(
    aggregateNode.groups.length === 0 &&
      aggregateNode.measures.length === 1 &&
      aggregateNode.measures[0]!.kind === "count-rows" &&
      aggregateNode.output.length === 1 &&
      aggregateNode.output[0] === aggregateNode.measures[0]!.output &&
      aggregateNode.grain.kind === "scalar",
    path,
    `The ${metric} branch must be an ungrouped COUNT_ROWS Aggregate.`,
  );
  const output = slotAt(plan, aggregateNode.output[0]!, `${path}.output[0]`);
  requirePlan(
    output.type.kind === "scalar" &&
      output.type.scalar === "number" &&
      !output.nullable &&
      output.lineage.kind === "derived" &&
      output.lineage.operation === "aggregate:count-rows",
    `${path}.output[0]`,
    `The ${metric} Aggregate must produce a non-null count-rows number.`,
  );
  return { node: aggregateNode, output: output.id };
}

function validatePairProject(
  plan: ValidatedLogicalPlan,
  node: ProjectNode,
  input: RelationId,
  inputSlots: readonly [SlotId, SlotId],
  path: string,
  visited: Set<RelationId>,
): readonly [SlotId, SlotId] {
  visited.add(node.id);
  requirePlan(
    node.input === input &&
      node.projections.length === 2 &&
      node.projections.every(
        (projection, index) =>
          projection.expression.kind === "slot" &&
          projection.expression.slot === inputSlots[index],
      ) &&
      node.output.length === 2 &&
      node.output.every(
        (slot, index) => slot === node.projections[index]!.slot,
      ) &&
      node.grain.kind === "scalar",
    path,
    "The pair Project must preserve the sessions and views scalar slots in order.",
  );
  const slots = node.output as readonly [SlotId, SlotId];
  for (const [index, slotId] of slots.entries()) {
    const slot = slotAt(plan, slotId, `${path}.output[${index}]`);
    requirePlan(
      slot.type.kind === "scalar" &&
        slot.type.scalar === "number" &&
        !slot.nullable &&
        slot.lineage.kind === "alias" &&
        slot.lineage.source === inputSlots[index],
      `${path}.output[${index}]`,
      "Each pair Project output must remain its non-null numeric metric alias.",
    );
  }
  return slots;
}

function matchSessionOverviewPairPlan(
  plan: ValidatedLogicalPlan,
): SessionPlanSemantics {
  const context = matchSessionPlanContext(plan);
  requirePlan(
    plan.outputs.length === 1 &&
      plan.outputs[0]!.id === "semantic-aggregate" &&
      plan.outputs[0]!.fields.length === 2 &&
      plan.outputs[0]!.fields[0]!.name === "sessions" &&
      plan.outputs[0]!.fields[0]!.semantic?.kind === "metric" &&
      plan.outputs[0]!.fields[0]!.semantic?.id === "sessions" &&
      plan.outputs[0]!.fields[1]!.name === "views" &&
      plan.outputs[0]!.fields[1]!.semantic?.kind === "metric" &&
      plan.outputs[0]!.fields[1]!.semantic?.id === "views",
    "outputs",
    "Expected semantic-aggregate.sessions and semantic-aggregate.views outputs in order.",
  );

  const output = plan.outputs[0]!;
  const visited = new Set<RelationId>();
  const finalProject = nodeAt(
    plan,
    output.relation,
    "project",
    "outputs[0].relation",
    visited,
  );
  const normalizedProject = nodeAt(
    plan,
    finalProject.input,
    "project",
    `${planNodePath(finalProject.id)}.input`,
    visited,
  );
  const branchJoin = nodeAt(
    plan,
    normalizedProject.input,
    "join",
    `${planNodePath(normalizedProject.id)}.input`,
    visited,
  );
  const sessions = matchCountRowsAggregate(
    plan,
    branchJoin.left,
    "sessions",
    visited,
  );
  const views = matchCountRowsAggregate(
    plan,
    branchJoin.right,
    "views",
    visited,
  );
  requirePlan(
    branchJoin.joinType === "inner" &&
      branchJoin.keys.length === 0 &&
      branchJoin.grain.kind === "scalar" &&
      branchJoin.output.length === 2 &&
      branchJoin.output[0] === sessions.output &&
      branchJoin.output[1] === views.output &&
      branchJoin.rightAliases.length === 0,
    planNodePath(branchJoin.id),
    "The scalar branch Join must be inner, keyless, and preserve both one-row count branches.",
  );
  const normalizedSlots = validatePairProject(
    plan,
    normalizedProject,
    branchJoin.id,
    [sessions.output, branchJoin.output[1]!],
    planNodePath(normalizedProject.id),
    visited,
  );
  const finalSlots = validatePairProject(
    plan,
    finalProject,
    normalizedProject.id,
    normalizedSlots,
    planNodePath(finalProject.id),
    visited,
  );
  requirePlan(
    finalProject.output[0] === output.fields[0]!.slot &&
      finalProject.output[1] === output.fields[1]!.slot &&
      finalSlots[0] === output.fields[0]!.slot &&
      finalSlots[1] === output.fields[1]!.slot,
    "outputs[0].fields",
    "The semantic output must reference both projected metric counts in order.",
  );

  const pageMembership = nodeAt(
    plan,
    views.node.input,
    "semi-join",
    `${planNodePath(views.node.id)}.input`,
    visited,
  );
  const candidatePages = nodeAt(
    plan,
    pageMembership.left,
    "source",
    `${planNodePath(pageMembership.id)}.left`,
    visited,
  );
  requirePlan(
    candidatePages.entity === "page" &&
      candidatePages.temporalDomain === "candidate" &&
      candidatePages.values.length === 2 &&
      candidatePages.output.length === 2 &&
      candidatePages.values[0]!.kind === "self" &&
      candidatePages.values[1]!.kind === "related-entity" &&
      candidatePages.values[1]!.relationship === "page.session" &&
      candidatePages.values[0]!.slot === candidatePages.output[0] &&
      candidatePages.values[1]!.slot === candidatePages.output[1] &&
      candidatePages.grain.kind === "entity" &&
      candidatePages.grain.entity === "page" &&
      candidatePages.grain.key === candidatePages.values[0]!.slot,
    planNodePath(candidatePages.id),
    "The views branch must start from the unique candidate Page Source and page.session relationship.",
  );
  const pageIdentity = candidatePages.values[0]!.slot;
  const pageSession = candidatePages.values[1]!.slot;
  entitySlotAt(
    plan,
    pageIdentity,
    "page",
    false,
    `${planNodePath(candidatePages.id)}.self`,
  );
  const pageSessionSlot = slotAt(
    plan,
    pageSession,
    `${planNodePath(candidatePages.id)}.page.session`,
  );
  requirePlan(
    pageSessionSlot.type.kind === "entity" &&
      pageSessionSlot.type.entity === "session" &&
      pageSessionSlot.nullable &&
      pageSessionSlot.lineage.kind === "relationship" &&
      pageSessionSlot.lineage.relationship === "page.session",
    `${planNodePath(candidatePages.id)}.page.session`,
    "The Page membership key must preserve its nullable Session relationship.",
  );
  requirePlan(
    pageMembership.output.length === candidatePages.output.length &&
      sameSlots(pageMembership.output, candidatePages.output) &&
      pageMembership.grain.kind === "entity" &&
      pageMembership.grain.entity === "page" &&
      pageMembership.grain.key === pageIdentity &&
      pageMembership.keys.length === 1 &&
      pageMembership.keys[0]!.left === pageSession,
    planNodePath(pageMembership.id),
    "The Session semi-join must preserve candidate Page grain and use page.session.",
  );
  requirePlan(
    sessions.node.input === pageMembership.right,
    `${planNodePath(sessions.node.id)}.input`,
    "Both metric branches must consume the exact same formal Session relation.",
  );
  const sessionSet = matchCandidateBoundedSessionSet(
    plan,
    sessions.node.input,
    `${planNodePath(sessions.node.id)}.input`,
    visited,
  );
  const sessionSetRoot = nodeAt(
    plan,
    pageMembership.right,
    "set-operation",
    `${planNodePath(pageMembership.id)}.right`,
  );
  requirePlan(
    sessionSetRoot.output.length === 1 &&
      sessionSetRoot.grain.kind === "entity" &&
      sessionSetRoot.grain.entity === "session" &&
      sessionSetRoot.grain.key === sessionSetRoot.output[0] &&
      pageMembership.keys[0]!.right === sessionSetRoot.output[0],
    `${planNodePath(pageMembership.id)}.keys[0].right`,
    "The Page branch must use the proven Session entity key for membership.",
  );
  entitySlotAt(
    plan,
    sessionSetRoot.output[0]!,
    "session",
    false,
    `${planNodePath(sessionSetRoot.id)}.output[0]`,
  );
  requireAllPlanNodesVisited(plan, visited);
  return { ...context, set: sessionSet };
}

function requireExpectedSessionViewsContext(
  semantics: SessionPlanSemantics,
  expected: AnalyticsSessionViewsExpectedContext,
): void {
  requirePlan(
    semantics.siteId === expected.siteId,
    "context.subject.siteIds[0]",
    "The plan site must match the caller-authorized site.",
  );
  requirePlan(
    semantics.candidateRange.startMs === expected.candidateRange.startMs &&
      semantics.candidateRange.endExclusiveMs ===
        expected.candidateRange.endExclusiveMs,
    "context.time.candidate",
    "The plan candidate range must match the caller-authorized range.",
  );
  requirePlan(
    semantics.readRange.startMs === expected.readRange.startMs &&
      semantics.readRange.endExclusiveMs === expected.readRange.endExclusiveMs,
    "context.time.read.range",
    "The plan read range must match the caller-authorized range.",
  );
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validateSessionDocumentExpression(
  expression: unknown,
  path: string,
  state: { leaves: number },
): UnsupportedResult | undefined {
  const record = recordOf(expression);
  if (!record) {
    return unsupported(
      "session-equality-leaf-only",
      path,
      "Expected a page.path or event.name equality expression.",
    );
  }

  if (record.kind === "condition") {
    const target = recordOf(record.target);
    if (
      target?.kind !== "field" ||
      (target.field !== "page.path" && target.field !== "event.name") ||
      record.operator !== "eq" ||
      typeof record.value !== "string"
    ) {
      return unsupported(
        "session-equality-leaf-only",
        path,
        "Only page.path or event.name eq <string> leaves are supported.",
      );
    }
    state.leaves += 1;
    return state.leaves > 2
      ? unsupported(
          "two-session-filter-leaves-only",
          path,
          "This wave supports at most two page.path/event.name equality leaves.",
        )
      : undefined;
  }

  if (record.kind === "not") {
    return validateSessionDocumentExpression(
      record.child,
      `${path}.child`,
      state,
    );
  }

  if (record.kind === "and" || record.kind === "or") {
    if (!Array.isArray(record.children) || record.children.length < 2) {
      return unsupported(
        "session-boolean-shape",
        path,
        "AND and OR require at least two child expressions.",
      );
    }
    for (const [index, child] of record.children.entries()) {
      const unsupportedChild = validateSessionDocumentExpression(
        child,
        `${path}.children[${index}]`,
        state,
      );
      if (unsupportedChild) return unsupportedChild;
    }
    return undefined;
  }

  return unsupported(
    "session-boolean-shape",
    path,
    "Only AND, OR, NOT, and page.path/event.name equality conditions are supported.",
  );
}

function analyzeSessionFilterDocument(
  document: unknown,
):
  | { readonly kind: "supported"; readonly analysis: AnalyzedFilterDocument }
  | UnsupportedResult {
  let normalized: ReturnType<typeof normalizeFilterDocument>;
  try {
    normalized = normalizeFilterDocument(document, analyticsFilterRegistry);
  } catch (error) {
    return unsupported(
      "valid-filter-document-required",
      "root",
      error instanceof Error ? error.message : String(error),
    );
  }

  const rawRoot = recordOf(document)?.root;
  if (rawRoot === null || rawRoot === undefined) {
    return unsupported(
      "session-equality-leaf-only",
      "empty-document",
      "A non-empty page.path/event.name equality expression is required.",
    );
  }
  const shapeIssue = validateSessionDocumentExpression(rawRoot, "root", {
    leaves: 0,
  });
  if (shapeIssue) return shapeIssue;

  try {
    return {
      kind: "supported",
      analysis: analyzeFilterDocument(normalized, analyticsFilterRegistry),
    };
  } catch (error) {
    return unsupported(
      "valid-filter-document-required",
      "root",
      error instanceof Error ? error.message : String(error),
    );
  }
}

type SessionSetColumns = Readonly<{
  site_pk: AnyExpression;
  session_id: AnyExpression;
}>;
type SessionSetRelation = Relation<object, SessionSetColumns>;

function asSessionSetRelation<
  Row extends object,
  Columns extends SessionSetColumns,
>(relation: Relation<Row, Columns>): SessionSetRelation {
  return relation as unknown as SessionSetRelation;
}

function compositeSessionKeyMatch(
  left: SessionSetRelation,
  right: SessionSetRelation,
) {
  return and(
    eq(left.columns.site_pk, right.columns.site_pk),
    eq(left.columns.session_id, right.columns.session_id),
  );
}

function compileCandidateSessionSet(
  site: ReturnType<typeof filter>,
  candidateRange: TimeRange,
): SessionSetRelation {
  const candidatePagesSource = scan(schema.visits);
  const candidatePagesScoped = semiJoin(
    candidatePagesSource,
    site,
    eq(candidatePagesSource.columns.site_pk, site.columns.site_pk),
  );
  const candidatePagesInRange = filter(
    candidatePagesScoped,
    and(
      gte(
        candidatePagesScoped.columns.started_at,
        param(candidateRange.startMs),
      ),
      lt(
        candidatePagesScoped.columns.started_at,
        param(candidateRange.endExclusiveMs),
      ),
      isNotNull(candidatePagesScoped.columns.session_id),
      neq(candidatePagesScoped.columns.session_id, param("")),
    ),
  );
  const candidatePageSessions = project(candidatePagesInRange, {
    site_pk: candidatePagesInRange.columns.site_pk,
    session_id: candidatePagesInRange.columns.session_id,
  });

  const candidateEventsSource = scan(schema.custom_events);
  const candidateEventsScoped = semiJoin(
    candidateEventsSource,
    site,
    eq(candidateEventsSource.columns.site_pk, site.columns.site_pk),
  );
  const candidateEventsInRange = filter(
    candidateEventsScoped,
    and(
      gte(
        candidateEventsScoped.columns.occurred_at,
        param(candidateRange.startMs),
      ),
      lt(
        candidateEventsScoped.columns.occurred_at,
        param(candidateRange.endExclusiveMs),
      ),
    ),
  );
  const eventOwnerPages = scan(schema.visits);
  const candidateEventsWithOwner = join(
    candidateEventsInRange,
    eventOwnerPages,
    and(
      eq(
        candidateEventsInRange.columns.visit_id,
        eventOwnerPages.columns.visit_id,
      ),
      eq(
        candidateEventsInRange.columns.site_pk,
        eventOwnerPages.columns.site_pk,
      ),
    ),
  );
  const candidateEventsWithSession = filter(
    candidateEventsWithOwner,
    and(
      isNotNull(candidateEventsWithOwner.columns.right_session_id),
      neq(candidateEventsWithOwner.columns.right_session_id, param("")),
    ),
  );
  const candidateEventSessions = project(candidateEventsWithSession, {
    site_pk: candidateEventsWithSession.columns.left_site_pk,
    session_id: candidateEventsWithSession.columns.right_session_id,
  });

  return asSessionSetRelation(
    union(candidatePageSessions, candidateEventSessions),
  );
}

function compilePagePathSessionSet(
  site: ReturnType<typeof filter>,
  readRange: TimeRange,
  paths: readonly string[],
): SessionSetRelation {
  const readPagesSource = scan(schema.visits);
  const readPagesScoped = semiJoin(
    readPagesSource,
    site,
    eq(readPagesSource.columns.site_pk, site.columns.site_pk),
  );
  const normalizedPaths = paths.map((path) => path.trim());
  const pathExpression = callFunction("trim", readPagesScoped.columns.pathname);
  const pathPredicate =
    normalizedPaths.length === 1
      ? eq(pathExpression, param(normalizedPaths[0]!))
      : inList(pathExpression, normalizedPaths);
  const readPagesMatching = filter(
    readPagesScoped,
    and(
      gte(readPagesScoped.columns.started_at, param(readRange.startMs)),
      lt(readPagesScoped.columns.started_at, param(readRange.endExclusiveMs)),
      isNotNull(readPagesScoped.columns.session_id),
      neq(readPagesScoped.columns.session_id, param("")),
      pathPredicate,
    ),
  );
  // A semi/anti join only tests membership, so duplicate historical Pages
  // cannot change the Session set and do not need a standalone DISTINCT.
  return asSessionSetRelation(
    project(readPagesMatching, {
      site_pk: readPagesMatching.columns.site_pk,
      session_id: readPagesMatching.columns.session_id,
    }),
  );
}

function compileEventNameSessionSet(
  site: ReturnType<typeof filter>,
  readRange: TimeRange,
  names: readonly string[],
): SessionSetRelation {
  const readEventsSource = scan(schema.custom_events);
  const readEventsScoped = semiJoin(
    readEventsSource,
    site,
    eq(readEventsSource.columns.site_pk, site.columns.site_pk),
  );
  const eventNamesSource = scan(schema.custom_event_names);
  const readEventsWithName = join(
    readEventsScoped,
    eventNamesSource,
    and(
      eq(readEventsScoped.columns.event_name_id, eventNamesSource.columns.id),
      eq(readEventsScoped.columns.site_pk, eventNamesSource.columns.site_pk),
    ),
  );
  const normalizedNames = names.map((name) => name.trim());
  const eventNameExpression = callFunction(
    "trim",
    readEventsWithName.columns.right_name,
  );
  const eventNamePredicate =
    normalizedNames.length === 1
      ? eq(eventNameExpression, param(normalizedNames[0]!))
      : inList(eventNameExpression, normalizedNames);
  const readEventsMatching = filter(
    readEventsWithName,
    and(
      gte(
        readEventsWithName.columns.left_occurred_at,
        param(readRange.startMs),
      ),
      lt(
        readEventsWithName.columns.left_occurred_at,
        param(readRange.endExclusiveMs),
      ),
      eventNamePredicate,
    ),
  );

  const ownerPagesSource = scan(schema.visits);
  const readEventsWithOwner = join(
    readEventsMatching,
    ownerPagesSource,
    and(
      eq(
        readEventsMatching.columns.left_visit_id,
        ownerPagesSource.columns.visit_id,
      ),
      eq(
        readEventsMatching.columns.left_site_pk,
        ownerPagesSource.columns.site_pk,
      ),
    ),
  );
  const readEventsWithSession = filter(
    readEventsWithOwner,
    and(
      isNotNull(readEventsWithOwner.columns.right_session_id),
      neq(readEventsWithOwner.columns.right_session_id, param("")),
    ),
  );
  return asSessionSetRelation(
    project(readEventsWithSession, {
      site_pk: readEventsWithSession.columns.left_left_site_pk,
      session_id: readEventsWithSession.columns.right_session_id,
    }),
  );
}

function compileSessionSetPlan(
  set: SessionSetPlan,
  site: ReturnType<typeof filter>,
  semantics: SessionPlanSemantics,
  memo: Map<RelationId, SessionSetRelation>,
): SessionSetRelation {
  const existing = memo.get(set.relationId);
  if (existing) return existing;

  let relation: SessionSetRelation;
  switch (set.kind) {
    case "candidate":
      relation = compileCandidateSessionSet(site, semantics.candidateRange);
      break;
    case "page-path":
      relation = compilePagePathSessionSet(
        site,
        semantics.readRange,
        set.paths,
      );
      break;
    case "event-name":
      relation = compileEventNameSessionSet(
        site,
        semantics.readRange,
        set.names,
      );
      break;
    case "set-operation": {
      const left = compileSessionSetPlan(set.inputs[0]!, site, semantics, memo);
      const right = compileSessionSetPlan(
        set.inputs[1]!,
        site,
        semantics,
        memo,
      );
      if (set.operation === "union") {
        relation = asSessionSetRelation(union(left, right));
      } else if (set.operation === "intersect") {
        relation = semiJoin(left, right, compositeSessionKeyMatch(left, right));
      } else {
        relation = antiJoin(left, right, compositeSessionKeyMatch(left, right));
      }
      break;
    }
  }
  memo.set(set.relationId, relation);
  return relation;
}

function buildSelectedSiteRelation(siteId: SiteId) {
  const siteIdentitySource = scan(schema.site_identities);
  return filter(
    siteIdentitySource,
    eq(siteIdentitySource.columns.site_id, param(siteId)),
  );
}

function compileSessionKeyRelation(
  semantics: SessionPlanSemantics,
  selectedSite: ReturnType<typeof buildSelectedSiteRelation>,
): SessionSetRelation {
  return compileSessionSetPlan(
    semantics.set,
    selectedSite,
    semantics,
    new Map(),
  );
}

function buildSessionKeyRelation(
  semantics: SessionPlanSemantics,
): SessionSetRelation {
  return compileSessionKeyRelation(
    semantics,
    buildSelectedSiteRelation(semantics.siteId),
  );
}

function compileSessionPlanQuery(
  semantics: SessionPlanSemantics,
): CompiledQuery<AnalyticsSessionIdentityRow> {
  const matchingSessions = buildSessionKeyRelation(semantics);
  return compileD1Query(lowerLogicalPlan(matchingSessions), {
    tag: "analytics.session-filter.wave-2",
  }) as CompiledQuery<AnalyticsSessionIdentityRow>;
}

function compileSessionCountQuery(
  semantics: SessionPlanSemantics,
): CompiledQuery<AnalyticsSessionCountRow> {
  const matchingSessions = buildSessionKeyRelation(semantics);
  const sessionCount = aggregate(matchingSessions, {
    groupBy: {},
    aggregates: { sessions: count() },
  });
  return compileD1Query(lowerLogicalPlan(sessionCount), {
    tag: "analytics.filtered-session-count.wave-3",
  }) as CompiledQuery<AnalyticsSessionCountRow>;
}

function compileSessionViewsQuery(
  semantics: SessionPlanSemantics,
): CompiledQuery<AnalyticsSessionViewsRow> {
  const selectedSite = buildSelectedSiteRelation(semantics.siteId);
  const matchingSessions = compileSessionKeyRelation(semantics, selectedSite);
  const candidatePagesSource = scan(schema.visits);
  const candidatePagesScoped = semiJoin(
    candidatePagesSource,
    selectedSite,
    eq(candidatePagesSource.columns.site_pk, selectedSite.columns.site_pk),
  );
  const candidatePagesInRange = filter(
    candidatePagesScoped,
    and(
      gte(
        candidatePagesScoped.columns.started_at,
        param(semantics.candidateRange.startMs),
      ),
      lt(
        candidatePagesScoped.columns.started_at,
        param(semantics.candidateRange.endExclusiveMs),
      ),
      isNotNull(candidatePagesScoped.columns.session_id),
      neq(candidatePagesScoped.columns.session_id, param("")),
    ),
  );
  const eligiblePages = semiJoin(
    candidatePagesInRange,
    matchingSessions,
    compositeSessionKeyMatch(candidatePagesInRange, matchingSessions),
  );
  const views = aggregate(eligiblePages, {
    groupBy: {},
    aggregates: { views: count() },
  });
  return compileD1Query(lowerLogicalPlan(views), {
    tag: "analytics.filtered-session-views.wave-4",
  }) as CompiledQuery<AnalyticsSessionViewsRow>;
}

function compileSessionOverviewPairQuery(
  semantics: SessionPlanSemantics,
): CompiledQuery<AnalyticsSessionOverviewPairRow> {
  const selectedSite = buildSelectedSiteRelation(semantics.siteId);
  const matchingSessions = compileSessionKeyRelation(semantics, selectedSite);
  const sessions = aggregate(matchingSessions, {
    groupBy: {},
    aggregates: { sessions: count() },
  });

  const candidatePagesSource = scan(schema.visits);
  const candidatePagesScoped = semiJoin(
    candidatePagesSource,
    selectedSite,
    eq(candidatePagesSource.columns.site_pk, selectedSite.columns.site_pk),
  );
  const candidatePagesInRange = filter(
    candidatePagesScoped,
    and(
      gte(
        candidatePagesScoped.columns.started_at,
        param(semantics.candidateRange.startMs),
      ),
      lt(
        candidatePagesScoped.columns.started_at,
        param(semantics.candidateRange.endExclusiveMs),
      ),
      isNotNull(candidatePagesScoped.columns.session_id),
      neq(candidatePagesScoped.columns.session_id, param("")),
    ),
  );
  const eligiblePages = semiJoin(
    candidatePagesInRange,
    matchingSessions,
    compositeSessionKeyMatch(candidatePagesInRange, matchingSessions),
  );
  const views = aggregate(eligiblePages, {
    groupBy: {},
    aggregates: { views: count() },
  });

  // Both inputs are ungrouped COUNT(*) aggregates, so each produces exactly
  // one row, including when its input relation is empty. The typed predicate
  // expresses their scalar combination in Generic DB IR.
  const combined = join(sessions, views, eq(param(1), param(1)));
  const output = project(combined, {
    sessions: combined.columns.left_sessions,
    views: combined.columns.right_views,
  });
  return compileD1Query(lowerLogicalPlan(output), {
    tag: "analytics.filtered-session-overview-pair.wave-5",
  }) as CompiledQuery<AnalyticsSessionOverviewPairRow>;
}

/**
 * Lowers supported Session sets by following the validated Analytics plan
 * from its output relation. Unknown nodes, expressions, or disconnected
 * subtrees are rejected before Generic DB IR is constructed.
 */
export function lowerAnalyticsPagePathSessionPlan(
  input: LogicalPlan,
): AnalyticsPageSessionLoweringResult {
  let logicalPlan: ValidatedLogicalPlan;
  try {
    logicalPlan = validateLogicalPlan(input);
  } catch (error) {
    return unsupported(
      "valid-analytics-plan-required",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  let semantics: SessionPlanSemantics;
  try {
    semantics = matchSessionPlan(logicalPlan);
  } catch (error) {
    if (error instanceof PlanShapeMismatch) {
      return unsupported(
        "session-boolean-plan-shape",
        error.node,
        error.message,
      );
    }
    return unsupported(
      "session-boolean-plan-shape",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    return {
      kind: "supported",
      logicalPlan,
      query: compileSessionPlanQuery(semantics),
    };
  } catch (error) {
    return unsupported(
      "generic-db-ir-lowering-failed",
      "generic-db-ir",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Lowers the exact validated sessions metric plan over a bounded filtered
 * Session set, then counts that set inside the Generic DB IR query.
 */
export function lowerAnalyticsFilteredSessionCountPlan(
  input: LogicalPlan,
): AnalyticsSessionCountLoweringResult {
  let logicalPlan: ValidatedLogicalPlan;
  try {
    logicalPlan = validateLogicalPlan(input);
  } catch (error) {
    return unsupported(
      "valid-analytics-plan-required",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  let semantics: SessionPlanSemantics;
  try {
    semantics = matchSessionCountPlan(logicalPlan);
  } catch (error) {
    if (error instanceof PlanShapeMismatch) {
      return unsupported(
        "filtered-session-count-plan-shape",
        error.node,
        error.message,
      );
    }
    return unsupported(
      "filtered-session-count-plan-shape",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    return {
      kind: "supported",
      logicalPlan,
      query: compileSessionCountQuery(semantics),
    };
  } catch (error) {
    return unsupported(
      "generic-db-ir-lowering-failed",
      "generic-db-ir",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Lowers the exact validated views metric plan over candidate Pages whose
 * page.session is in the candidate-bounded matching Session set.
 */
export function lowerAnalyticsFilteredSessionViewsPlan(
  input: LogicalPlan,
  expected: AnalyticsSessionViewsExpectedContext,
): AnalyticsSessionViewsLoweringResult {
  let logicalPlan: ValidatedLogicalPlan;
  try {
    logicalPlan = validateLogicalPlan(input);
  } catch (error) {
    return unsupported(
      "valid-analytics-plan-required",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  let semantics: SessionPlanSemantics;
  try {
    semantics = matchSessionViewsPlan(logicalPlan);
    requireExpectedSessionViewsContext(semantics, expected);
  } catch (error) {
    if (error instanceof PlanShapeMismatch) {
      return unsupported(
        "filtered-session-views-plan-shape",
        error.node,
        error.message,
      );
    }
    return unsupported(
      "filtered-session-views-plan-shape",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    return {
      kind: "supported",
      logicalPlan,
      query: compileSessionViewsQuery(semantics),
    };
  } catch (error) {
    return unsupported(
      "generic-db-ir-lowering-failed",
      "generic-db-ir",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Lowers the exact formal sessions + views aggregate over one shared,
 * candidate-bounded Session set into a single Generic DB IR query.
 */
export function lowerAnalyticsFilteredSessionOverviewPairPlan(
  input: LogicalPlan,
  expected: AnalyticsSessionViewsExpectedContext,
): AnalyticsSessionOverviewPairLoweringResult {
  let logicalPlan: ValidatedLogicalPlan;
  try {
    logicalPlan = validateLogicalPlan(input);
  } catch (error) {
    return unsupported(
      "valid-analytics-plan-required",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  let semantics: SessionPlanSemantics;
  try {
    semantics = matchSessionOverviewPairPlan(logicalPlan);
    requireExpectedSessionViewsContext(semantics, expected);
  } catch (error) {
    if (error instanceof PlanShapeMismatch) {
      return unsupported(
        "filtered-session-overview-pair-plan-shape",
        error.node,
        error.message,
      );
    }
    return unsupported(
      "filtered-session-overview-pair-plan-shape",
      "plan",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const query = compileSessionOverviewPairQuery(semantics);
    return {
      kind: "supported",
      logicalPlan,
      query,
    };
  } catch (error) {
    if (error instanceof D1StatementBudgetError) {
      return unsupported(
        "d1-query-budget-exceeded",
        "compiled-query",
        `${error.item === "sql_bytes" ? "SQL UTF-8 bytes" : "bound parameters"}: ${error.actual} (limit ${error.limit}); the compiled query cannot be submitted to D1.`,
      );
    }
    return unsupported(
      "generic-db-ir-lowering-failed",
      "generic-db-ir",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Build and validate one Analytics plan, then delegate all DB lowering to it. */
export function lowerAnalyticsPagePathToSessionQuery(
  input: AnalyticsPageSessionLoweringInput,
): AnalyticsPageSessionLoweringResult {
  if (!Array.isArray(input.siteIds) || input.siteIds.length !== 1) {
    return unsupported(
      "single-site-only",
      "context.subject",
      "Wave 2 requires exactly one authorized site identity.",
    );
  }

  const analyzed = analyzeSessionFilterDocument(input.document);
  if (analyzed.kind !== "supported") return analyzed;

  let builder: LogicalPlanBuilder;
  try {
    builder = new LogicalPlanBuilder({
      subject: createSemanticSubjectDomain({
        origin: "site",
        siteIds: input.siteIds,
      }),
      time: createSemanticTemporalDomains({
        candidate: input.candidateRange,
        read: { kind: "bounded", range: input.readRange },
        reportingTimeZone: input.reportingTimeZone,
        capturedAtMs: input.capturedAtMs,
      }),
      scope: resolveAnalyticsScope("session"),
    });
  } catch (error) {
    return unsupported(
      "bounded-single-site-context-required",
      "context",
      error instanceof Error ? error.message : String(error),
    );
  }

  const lowered = lowerFilterDocumentToScope(builder, analyzed.analysis, {
    targetScope: "session",
    resolveTemporalDomain: () => "read",
  });
  if (lowered.kind === "unsupported") {
    return unsupported(
      lowered.code,
      lowered.path,
      `${lowered.reason}${lowered.conditionTarget ? ` (${lowered.conditionTarget})` : ""}`,
    );
  }
  if (lowered.kind !== "supported") {
    return unsupported(
      "non-empty-session-filter-required",
      "root",
      "Wave 2 requires a supported non-empty page.path/event.name expression.",
    );
  }

  builder.output("matches", lowered.selection.relation, [
    { name: "entity", slot: "entity" },
  ]);
  return lowerAnalyticsPagePathSessionPlan(builder.finish());
}
