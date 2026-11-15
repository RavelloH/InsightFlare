import {
  compileD1Query,
  type CompiledQuery,
  constant,
  eq,
  join,
  lowerLogicalPlan,
  project,
  union,
} from "@/lib/db";
import type { SqlExpression } from "@/lib/db/query/expression";
import type { LogicalQueryNode, QuerySource } from "@/lib/db/query/plan";
import {
  ADVANCED_COUNT_FILTER_OUTPUTS,
  advancedCountFilterCombinedGroupWidth,
} from "@/lib/edge/analytics/engine/advanced-count-filter-plan";
import { ADVANCED_FILTER_ACTIVITY_LIMIT } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import type { RelationId } from "@/lib/edge/analytics/engine/logical/ids";
import type { LogicalNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { EventPayloadPropertiesNode } from "@/lib/edge/analytics/engine/logical/nodes";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import {
  ADVANCED_COUNT_SELECTOR_FIELDS,
  type AdvancedCountNumberSelectorField,
} from "@/lib/edge/analytics/engine/semantic/count-selector-fields";
import {
  type EventPayloadTopLevelPath,
  isEventPayloadTopLevelPathSnapshot,
} from "@/lib/edge/analytics/engine/semantic/event-payload-logical";
import { assertAnalyticsEventPayloadKeySourceBinding } from "@/lib/edge/analytics/providers/d1/internal/analytics-event-identity-proof";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import type { EventPayloadAdmissionPacket } from "@/lib/edge/analytics/providers/d1/internal/lowering/payload-count";
import {
  currentD1Operation,
  runWithD1Operation,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

import { ADVANCED_FILTER_MAX_PAYLOAD_NODES } from "./advanced-filter-count-resource-policy";
import { queryD1CompiledAll } from "./core-sources";
import type { D1ReadDiagnostics } from "./diagnostics";

const combinedQueryMetadataBrand: unique symbol = Symbol(
  "advanced-filter-count-combined-query",
);
const payloadCombinedQueryMetadataBrand: unique symbol = Symbol(
  "advanced-filter-count-payload-combined-query",
);
const payloadCombinedAdmissionWitnesses = new WeakMap<
  object,
  EventPayloadAdmissionPacket
>();

function stageOperation(
  stage: "guard" | "match" | "combined" | "payload-combined",
): string {
  return `${currentD1Operation() ?? "analytics.advanced_filter"}.count_${stage}`;
}

function compileOutput(input: {
  readonly plan: ValidatedLogicalPlan;
  readonly outputId: string;
  readonly stage: "guard" | "match";
}): CompiledQuery<Record<string, unknown>> {
  const output = input.plan.outputs.find(
    (candidate) => candidate.id === input.outputId,
  );
  if (!output)
    throw new Error(`advanced_filter_count_${input.stage}_output_missing`);
  const lowerer = new AnalyticsLogicalToDbLowerer(input.plan, {
    siteIds: input.plan.context.subject.siteIds,
    time: input.plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const operation = stageOperation(input.stage);
  return compileD1Query(lowerLogicalPlan(relation), {
    tag: operation,
  }) as CompiledQuery<Record<string, unknown>>;
}

async function executeQuery(input: {
  readonly env: Env;
  readonly query: CompiledQuery<Record<string, unknown>>;
  readonly stage: "guard" | "match" | "combined" | "payload-combined";
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<Array<Record<string, unknown>>> {
  const operation = stageOperation(input.stage);
  const rows = await runWithD1Operation(operation, () =>
    queryD1CompiledAll<object>(input.env, input.query, input.diagnostics),
  );
  return rows as Array<Record<string, unknown>>;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`advanced_filter_count_invalid_${name}`);
  return value;
}

function addNonnegativeIntegersSafely(
  total: number,
  value: number,
  name: string,
): number {
  const sum = total + value;
  if (!Number.isSafeInteger(sum) || sum < total)
    throw new Error(`advanced_filter_count_invalid_${name}_sum`);
  return sum;
}

export async function queryAdvancedFilterCountGuard(input: {
  readonly env: Env;
  readonly query: CompiledQuery<Record<string, unknown>>;
  readonly numericCompatibilityFields: readonly AdvancedCountNumberSelectorField[];
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<{
  readonly rawCount: number;
  readonly nullActivityIdCount: number;
  readonly siteIdentityMismatchCount: number;
  readonly numericCompatibilityFieldIds: readonly string[];
}> {
  const [row] = await executeQuery({
    env: input.env,
    query: input.query,
    stage: "guard",
    diagnostics: input.diagnostics,
  });
  if (!row) throw new Error("advanced_filter_count_guard_result_missing");
  const numericCompatibilityFieldIds = input.numericCompatibilityFields
    .filter(
      (field) =>
        nonnegativeInteger(
          row[field.invalidCountOutput] ?? 0,
          field.invalidCountOutput,
        ) > 0,
    )
    .map((field) => field.fieldId);
  return {
    rawCount: nonnegativeInteger(row.rawCount, "raw_count"),
    nullActivityIdCount: nonnegativeInteger(
      row.nullActivityIdCount ?? 0,
      "null_activity_id_count",
    ),
    siteIdentityMismatchCount: nonnegativeInteger(
      row.siteIdentityMismatchCount ?? 0,
      "site_identity_mismatch_count",
    ),
    numericCompatibilityFieldIds,
  };
}

export async function queryAdvancedFilterCountMatches(input: {
  readonly env: Env;
  readonly query: CompiledQuery<Record<string, unknown>>;
  readonly numericCompatibilityFields: readonly AdvancedCountNumberSelectorField[];
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<{
  readonly matches: Array<{
    readonly siteId: string;
    readonly entityId: string;
  }>;
  readonly numericCompatibilityFieldIds: readonly string[];
}> {
  const rows = await executeQuery({
    env: input.env,
    query: input.query,
    stage: "match",
    diagnostics: input.diagnostics,
  });
  const matches: Array<{ readonly siteId: string; readonly entityId: string }> =
    [];
  const numericCompatibilityFieldIds = new Set<string>();
  for (const row of rows) {
    if (
      input.numericCompatibilityFields.length > 0 &&
      row.rowKind === "numeric-domain"
    ) {
      for (const field of input.numericCompatibilityFields)
        if (
          nonnegativeInteger(
            row[field.invalidCountOutput] ?? 0,
            field.invalidCountOutput,
          ) > 0
        )
          numericCompatibilityFieldIds.add(field.fieldId);
      continue;
    }
    if (input.numericCompatibilityFields.length > 0 && row.rowKind !== "match")
      throw new Error("advanced_filter_count_match_control_row_invalid");
    if (typeof row.siteId !== "string" || typeof row.entityId !== "string")
      throw new Error("advanced_filter_count_match_identity_invalid");
    matches.push({ siteId: row.siteId, entityId: row.entityId });
  }
  return {
    matches,
    numericCompatibilityFieldIds: [...numericCompatibilityFieldIds].sort(),
  };
}

/** Compile once so callers can preflight every count guard before SQL runs. */
export function compileAdvancedFilterCountGuardQuery(
  plan: ValidatedLogicalPlan,
): CompiledQuery<Record<string, unknown>> {
  return compileOutput({
    plan,
    outputId: ADVANCED_COUNT_FILTER_OUTPUTS.guard,
    stage: "guard",
  });
}

/** Compile once so callers can preflight every count matcher before SQL runs. */
export function compileAdvancedFilterCountMatchesQuery(
  plan: ValidatedLogicalPlan,
): CompiledQuery<Record<string, unknown>> {
  return compileOutput({
    plan,
    outputId: ADVANCED_COUNT_FILTER_OUTPUTS.matches,
    stage: "match",
  });
}

/**
 * Compile the combined snapshot only when the physical planner selected the
 * bounded grouped-summary materialization. `null` means to use split reads.
 */
export function compileAdvancedFilterCountCombinedQuery(
  plan: ValidatedLogicalPlan,
): AdvancedFilterCountCombinedQuery | null {
  if ((advancedCountFilterCombinedGroupWidth(plan) ?? Infinity) > 16)
    return null;
  const output = plan.outputs.find(
    (candidate) => candidate.id === ADVANCED_COUNT_FILTER_OUTPUTS.combined,
  );
  if (!output) throw new Error("advanced_filter_count_combined_output_missing");
  const numericCompatibilityFields = output.fields.flatMap((outputField) => {
    const field = ADVANCED_COUNT_SELECTOR_FIELDS.find(
      (candidate) =>
        candidate.kind === "number" &&
        candidate.invalidCountOutput === outputField.name,
    );
    if (!field || field.kind !== "number") return [];
    return [field];
  });
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteIds: plan.context.subject.siteIds,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const physical = lowerLogicalPlan(relation);
  const groupedCandidates = physical.sharedRelations.filter(
    ({ node, materialization }) =>
      node.kind === "aggregate" &&
      node.groups.length === 2 &&
      materialization === "materialized",
  );
  if (
    groupedCandidates.length !== 1 ||
    groupedCandidates[0]!.materialization !== "materialized" ||
    groupedCandidates[0]!.fields.length > 16
  )
    return null;
  return Object.freeze({
    query: compileD1Query(physical, {
      tag: stageOperation("combined"),
    }) as CompiledQuery<Record<string, unknown>>,
    [combinedQueryMetadataBrand]: true as const,
    numericCompatibilityFields: Object.freeze(
      numericCompatibilityFields.map((field) => Object.freeze({ ...field })),
    ),
  });
}

function logicalNodeInputs(node: LogicalNode): readonly RelationId[] {
  switch (node.kind) {
    case "source":
    case "analysis-result":
    case "whole-filter-membership":
    case "whole-filter-core":
    case "membership-read":
      return [];
    case "relationship-lookup":
    case "filter":
    case "event-payload-occurrences":
    case "event-payload-properties":
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
    case "row-concatenation":
      return node.inputs;
    case "semi-join":
    case "anti-join":
    case "join":
      return [node.left, node.right];
  }
}

function reachableLogicalRelations(
  plan: ValidatedLogicalPlan,
  root: RelationId,
): ReadonlySet<RelationId> {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const reachable = new Set<RelationId>();
  const pending = [root];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    const node = nodes.get(id);
    if (!node)
      throw new Error("advanced_filter_count_payload_relation_missing");
    reachable.add(id);
    pending.push(...logicalNodeInputs(node));
  }
  return reachable;
}

function querySourceChildren(source: QuerySource): readonly QuerySource[] {
  const node = source.node;
  if ("input" in node) return [node.input];
  if ("left" in node && "right" in node) return [node.left, node.right];
  if ("seed" in node && "candidates" in node)
    return [node.seed, node.candidates];
  return [];
}

function containsQuerySource(root: QuerySource, target: QuerySource): boolean {
  const pending = [root];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const source = pending.pop()!;
    if (source.node === target.node) return true;
    if (seen.has(source.node)) continue;
    seen.add(source.node);
    pending.push(...querySourceChildren(source));
  }
  return false;
}

function hasOneByOnePredicate(expression: SqlExpression): boolean {
  if (
    expression.kind !== "binary" ||
    expression.operator !== "=" ||
    expression.left.kind !== "constant" ||
    expression.right.kind !== "constant"
  )
    return false;
  return expression.left.value === 1 && expression.right.value === 1;
}

function assertPayloadAdmissionWitness(input: {
  readonly properties: EventPayloadPropertiesNode;
  readonly packet: EventPayloadAdmissionPacket;
  readonly guardRelation: ReturnType<
    AnalyticsLogicalToDbLowerer["projectOutput"]
  >;
  readonly scopeRelation: ReturnType<
    AnalyticsLogicalToDbLowerer["projectOutput"]
  >;
  readonly guardWithCounter: ReturnType<typeof join>;
  readonly guardRows: ReturnType<typeof project>;
  readonly scopeRows: ReturnType<typeof project>;
  readonly combinedRows: { readonly node: LogicalQueryNode };
}): void {
  const { properties, packet } = input;
  const identity = packet.sourceIdentity;
  const maximumNodes = ADVANCED_FILTER_MAX_PAYLOAD_NODES;
  const limitNode = packet.boundedNodes.node;
  const counterNode = packet.counter.node;
  const counterControlNode = packet.counterControl.node;
  const admissionNode = packet.admittedCounter.node;
  const nodeGate = packet.admittedNodeCounterJoin.node;
  const admittedNodesNode = packet.admittedNodes.node;
  const eventGate = packet.admittedEvents.node;
  const eventMetadataNode = packet.admittedEventMetadata.node;
  const eventMetadataGate =
    eventMetadataNode.kind === "project"
      ? eventMetadataNode.input.node
      : undefined;
  const propertyReadNode = packet.propertyReadJoin.node;
  const guardJoinNode = input.guardWithCounter.node;
  const guardProjectionNode = input.guardRows.node;
  const scopeProjectionNode = input.scopeRows.node;
  const unionNode = input.combinedRows.node;
  const scopePayloadCountExpression =
    scopeProjectionNode.kind === "project"
      ? scopeProjectionNode.projections.find(
          (projection) => projection.name === "payloadNodeCount",
        )?.expression
      : undefined;

  assertAnalyticsEventPayloadKeySourceBinding(
    identity.sourceBinding,
    "advanced-filter-count.payloadAdmission.sourceBinding",
  );
  if (
    properties.paths.length === 0 ||
    !isEventPayloadTopLevelPathSnapshot(properties.paths) ||
    properties.properties.length !== properties.paths.length ||
    properties.properties.some(
      (entry, index) =>
        entry.path !== properties.paths[index]?.path ||
        entry.key !== properties.paths[index]?.key,
    ) ||
    packet.propertiesRelation !== properties.id ||
    packet.inputRelation !== properties.input ||
    packet.sourceIdentity.requestId !== identity.sourceBinding.request.id ||
    packet.sourceIdentity.sourceId !==
      identity.sourceBinding.request.sourceId ||
    packet.sourceIdentity.eventKeySlot !== properties.eventKey ||
    identity.scopeRelation !== properties.input ||
    identity.carrierRelation !== packet.input ||
    identity.sourceSignature.length === 0 ||
    identity.sourceBinding.request.includePayloadPropertiesMetadata !== true ||
    packet.maximumNodes !== maximumNodes ||
    packet.paths.length !== properties.paths.length ||
    packet.paths.some(
      (entry, index) =>
        entry.path !== properties.paths[index]?.path ||
        entry.key !== properties.paths[index]?.key,
    ) ||
    packet.propertyReadInputRelation !== packet.admittedEvents ||
    packet.propertyReadNodeRelation !== packet.admittedNodes ||
    packet.propertyReadEventMetadata !== packet.admittedEventMetadata ||
    !containsQuerySource(packet.selectedNodes, identity.carrierRelation) ||
    !containsQuerySource(
      packet.selectedEventMetadata,
      identity.carrierRelation,
    ) ||
    !containsQuerySource(packet.propertyReadRelation, packet.admittedNodes) ||
    !containsQuerySource(
      packet.propertyReadRelation,
      packet.admittedEventMetadata,
    ) ||
    !containsQuerySource(
      packet.propertyReadJoin,
      packet.propertyReadRelation,
    ) ||
    !containsQuerySource(input.guardRelation, packet.propertyReadJoin) ||
    !containsQuerySource(input.scopeRelation, packet.propertyReadJoin)
  )
    throw new Error("advanced_filter_count_payload_source_witness_invalid");

  if (
    limitNode.kind !== "limit" ||
    limitNode.input.node !== packet.selectedNodes.node ||
    limitNode.count.kind !== "parameter" ||
    limitNode.count.value !== maximumNodes + 1 ||
    counterNode.kind !== "aggregate" ||
    counterNode.input.node !== packet.boundedNodes.node ||
    counterNode.groups.length !== 0 ||
    counterNode.aggregates.length !== 1 ||
    counterNode.aggregates[0]?.name !== "payloadNodeCount" ||
    counterNode.aggregates[0]?.expression.kind !== "aggregate" ||
    counterNode.aggregates[0]?.expression.name !== "COUNT" ||
    counterNode.aggregates[0]?.expression.expression !== undefined ||
    packet.counterValue !== packet.counter.columns.payloadNodeCount ||
    counterControlNode.kind !== "project" ||
    counterControlNode.input.node !== packet.counter.node ||
    counterControlNode.projections.length !== 1 ||
    counterControlNode.projections[0]?.name !== "payloadNodeCount" ||
    counterControlNode.projections[0]?.expression.kind !== "column" ||
    counterControlNode.projections[0]?.expression.scope !==
      counterControlNode.input.scope ||
    counterControlNode.projections[0]?.expression.index !== 0 ||
    admissionNode.kind !== "filter" ||
    admissionNode.input.node !== packet.counter.node ||
    admissionNode.predicate.kind !== "binary" ||
    admissionNode.predicate.operator !== "<=" ||
    admissionNode.predicate.left !== packet.counterValue ||
    admissionNode.predicate.right.kind !== "constant" ||
    admissionNode.predicate.right.value !== maximumNodes ||
    nodeGate.kind !== "join" ||
    nodeGate.left.node !== packet.boundedNodes.node ||
    nodeGate.right.node !== packet.admittedCounter.node ||
    !hasOneByOnePredicate(nodeGate.condition) ||
    admittedNodesNode.kind !== "project" ||
    admittedNodesNode.input.node !== packet.admittedNodeCounterJoin.node ||
    eventGate.kind !== "join" ||
    eventGate.left.node !== packet.input.node ||
    eventGate.right.node !== packet.admittedCounter.node ||
    !hasOneByOnePredicate(eventGate.condition) ||
    eventMetadataNode.kind !== "project" ||
    eventMetadataGate?.kind !== "join" ||
    eventMetadataGate.left.node !== packet.selectedEventMetadata.node ||
    eventMetadataGate.right.node !== packet.admittedCounter.node ||
    propertyReadNode.kind !== "join" ||
    propertyReadNode.left.node !== packet.propertyReadInputRelation.node ||
    propertyReadNode.right.node !== packet.propertyReadRelation.node ||
    guardJoinNode.kind !== "join" ||
    guardJoinNode.left.node !== input.guardRelation.node ||
    guardJoinNode.right.node !== packet.counterControl.node ||
    !hasOneByOnePredicate(guardJoinNode.condition) ||
    guardProjectionNode.kind !== "project" ||
    guardProjectionNode.projections.find(
      (projection) => projection.name === "payloadNodeCount",
    )?.expression !== input.guardWithCounter.columns.right_payloadNodeCount ||
    scopeProjectionNode.kind !== "project" ||
    scopePayloadCountExpression?.kind !== "constant" ||
    scopePayloadCountExpression.value !== 0 ||
    unionNode.kind !== "union" ||
    !unionNode.all ||
    unionNode.left.node !== input.guardRows.node ||
    unionNode.right.node !== input.scopeRows.node
  )
    throw new Error("advanced_filter_count_payload_admission_witness_invalid");
}

export function compileAdvancedFilterCountPayloadCombinedQuery(
  plan: ValidatedLogicalPlan,
): AdvancedFilterCountPayloadCombinedQuery {
  const guardOutput = plan.outputs.find(
    (candidate) =>
      candidate.id === ADVANCED_COUNT_FILTER_OUTPUTS.payloadCombinedGuard,
  );
  const scopeOutput = plan.outputs.find(
    (candidate) =>
      candidate.id === ADVANCED_COUNT_FILTER_OUTPUTS.payloadCombinedScope,
  );
  if (!guardOutput || !scopeOutput)
    throw new Error("advanced_filter_count_payload_output_missing");
  const propertiesNodes = plan.nodes.filter(
    (node): node is EventPayloadPropertiesNode =>
      node.kind === "event-payload-properties",
  );
  const properties = propertiesNodes[0];
  if (propertiesNodes.length !== 1 || !properties)
    throw new Error("advanced_filter_count_payload_properties_missing");
  const guardReachable = reachableLogicalRelations(plan, guardOutput.relation);
  if (!guardReachable.has(properties.id))
    throw new Error("advanced_filter_count_payload_properties_missing");

  const expectedGuardFields = [
    "payloadStructureInvalidCount",
    "payloadValueInvalidCount",
    "payloadMultiplicityInvalidCount",
  ];
  const expectedScopeFields = [
    "matched",
    "rawCount",
    "nullActivityIdCount",
    "siteIdentityMismatchCount",
    "payloadMissingFactCount",
    "siteId",
    "entityId",
  ];
  if (
    guardOutput.fields.length !== expectedGuardFields.length ||
    guardOutput.fields.some(
      (field, index) => field.name !== expectedGuardFields[index],
    ) ||
    scopeOutput.fields.length !== expectedScopeFields.length ||
    scopeOutput.fields.some(
      (field, index) => field.name !== expectedScopeFields[index],
    )
  )
    throw new Error("advanced_filter_count_payload_control_schema_invalid");

  const lowerer = new AnalyticsLogicalToDbLowerer(
    plan,
    {
      siteIds: plan.context.subject.siteIds,
      time: plan.context.time,
    },
    {
      eventPayloadAdmissionPolicy: {
        propertiesRelation: properties.id,
        maximumNodes: ADVANCED_FILTER_MAX_PAYLOAD_NODES,
      },
    },
  );
  const [loweredGuard, loweredScope] = lowerer.lowerMany([
    guardOutput,
    scopeOutput,
  ]);
  if (!loweredGuard || !loweredScope)
    throw new Error("advanced_filter_count_payload_output_missing");
  const guardRelation = lowerer.projectOutput(
    loweredGuard,
    guardOutput.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const scopeRelation = lowerer.projectOutput(
    loweredScope,
    scopeOutput.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const packet = lowerer.eventPayloadAdmissionPacket(properties.id);
  if (!packet)
    throw new Error("advanced_filter_count_payload_admission_missing");

  const guardWithCounter = join(
    guardRelation,
    packet.counterControl,
    eq(constant(1), constant(1)),
  );
  const guardRows = project(guardWithCounter, {
    rowKind: constant("guard"),
    matched: constant(0),
    rawCount: constant(0),
    nullActivityIdCount: constant(0),
    siteIdentityMismatchCount: constant(0),
    payloadNodeCount: guardWithCounter.columns.right_payloadNodeCount,
    payloadMissingFactCount: constant(0),
    payloadStructureInvalidCount:
      guardWithCounter.columns.left_payloadStructureInvalidCount,
    payloadValueInvalidCount:
      guardWithCounter.columns.left_payloadValueInvalidCount,
    payloadMultiplicityInvalidCount:
      guardWithCounter.columns.left_payloadMultiplicityInvalidCount,
    siteId: constant(""),
    entityId: constant(""),
  });
  const scopeRows = project(scopeRelation, {
    rowKind: constant("scope"),
    matched: scopeRelation.columns.matched,
    rawCount: scopeRelation.columns.rawCount,
    nullActivityIdCount: scopeRelation.columns.nullActivityIdCount,
    siteIdentityMismatchCount: scopeRelation.columns.siteIdentityMismatchCount,
    payloadNodeCount: constant(0),
    payloadMissingFactCount: scopeRelation.columns.payloadMissingFactCount,
    payloadStructureInvalidCount: constant(0),
    payloadValueInvalidCount: constant(0),
    payloadMultiplicityInvalidCount: constant(0),
    siteId: scopeRelation.columns.siteId,
    entityId: scopeRelation.columns.entityId,
  });
  const combinedRows = union(guardRows, scopeRows, true);
  assertPayloadAdmissionWitness({
    properties,
    packet,
    guardRelation,
    scopeRelation,
    guardWithCounter,
    guardRows,
    scopeRows,
    combinedRows,
  });
  const paths = Object.freeze(
    packet.paths.map((entry) => Object.freeze({ ...entry })),
  );
  const physical = lowerLogicalPlan(combinedRows);
  const result = Object.freeze({
    query: compileD1Query(physical, {
      tag: stageOperation("payload-combined"),
    }) as CompiledQuery<Record<string, unknown>>,
    [payloadCombinedQueryMetadataBrand]: true as const,
    paths,
    maximumNodes: packet.maximumNodes,
  });
  payloadCombinedAdmissionWitnesses.set(result, packet);
  return result;
}

/** Provider-local metadata is derived only from the compiled Logical output. */
export interface AdvancedFilterCountCombinedQuery {
  readonly [combinedQueryMetadataBrand]: true;
  readonly query: CompiledQuery<Record<string, unknown>>;
  readonly numericCompatibilityFields: readonly AdvancedCountNumberSelectorField[];
}

export interface AdvancedFilterCountPayloadCombinedQuery {
  readonly [payloadCombinedQueryMetadataBrand]: true;
  readonly query: CompiledQuery<Record<string, unknown>>;
  readonly paths: readonly EventPayloadTopLevelPath[];
  readonly maximumNodes: number;
}

export interface AdvancedFilterCountCombinedRows {
  readonly rawCount: number;
  readonly nullActivityIdCount: number;
  readonly siteIdentityMismatchCount: number;
  readonly numericCompatibilityFieldIds: readonly string[];
  readonly matches: readonly {
    readonly siteId: unknown;
    readonly entityId: unknown;
  }[];
}

export interface AdvancedFilterCountPayloadCombinedRows {
  readonly rawCount: number;
  readonly nullActivityIdCount: number;
  readonly siteIdentityMismatchCount: number;
  readonly payloadNodeCount: number;
  readonly payloadMissingFactCount: number;
  readonly payloadStructureInvalidCount: number;
  readonly payloadValueInvalidCount: number;
  readonly payloadMultiplicityInvalidCount: number;
  readonly matches: readonly {
    readonly matched: 0 | 1;
    readonly rawCount: number;
    readonly nullActivityIdCount: number;
    readonly siteIdentityMismatchCount: number;
    readonly payloadMissingFactCount: number;
    readonly siteId: unknown;
    readonly entityId: unknown;
  }[];
}

/** Decode the complete result atomically; callers apply guard priority next. */
export async function queryAdvancedFilterCountCombined(input: {
  readonly env: Env;
  readonly query: AdvancedFilterCountCombinedQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<AdvancedFilterCountCombinedRows> {
  const rows = await executeQuery({
    env: input.env,
    query: input.query.query,
    stage: "combined",
    diagnostics: input.diagnostics,
  });
  let guard:
    | {
        readonly rawCount: number;
        readonly nullActivityIdCount: number;
        readonly siteIdentityMismatchCount: number;
        readonly numericCompatibilityFieldIds: readonly string[];
      }
    | undefined;
  const matches: Array<{
    readonly siteId: unknown;
    readonly entityId: unknown;
  }> = [];
  for (const row of rows) {
    if (row.rowKind === "guard") {
      if (guard)
        throw new Error("advanced_filter_count_combined_guard_repeated");
      const rawCount = nonnegativeInteger(row.rawCount, "raw_count");
      const numericCompatibilityFieldIds: string[] = [];
      for (const field of input.query.numericCompatibilityFields) {
        const invalidCount = nonnegativeInteger(
          row[field.invalidCountOutput],
          field.invalidCountOutput,
        );
        if (invalidCount > rawCount)
          throw new Error(
            "advanced_filter_count_combined_numeric_proof_invalid",
          );
        if (invalidCount > 0) numericCompatibilityFieldIds.push(field.fieldId);
      }
      guard = {
        rawCount,
        nullActivityIdCount: nonnegativeInteger(
          row.nullActivityIdCount,
          "null_activity_id_count",
        ),
        siteIdentityMismatchCount: nonnegativeInteger(
          row.siteIdentityMismatchCount,
          "site_identity_mismatch_count",
        ),
        numericCompatibilityFieldIds,
      };
      continue;
    }
    if (row.rowKind !== "match")
      throw new Error("advanced_filter_count_combined_row_kind_invalid");
    if (
      nonnegativeInteger(row.rawCount, "raw_count") !== 0 ||
      nonnegativeInteger(row.nullActivityIdCount, "null_activity_id_count") !==
        0 ||
      nonnegativeInteger(
        row.siteIdentityMismatchCount,
        "site_identity_mismatch_count",
      ) !== 0
    )
      throw new Error("advanced_filter_count_combined_match_control_invalid");
    for (const field of input.query.numericCompatibilityFields)
      if (
        nonnegativeInteger(
          row[field.invalidCountOutput],
          field.invalidCountOutput,
        ) !== 0
      )
        throw new Error("advanced_filter_count_combined_match_control_invalid");
    // Preserve identity values untrusted until the caller has applied the
    // raw-cap, NULL-id, and site-mismatch fallback priority in that order.
    matches.push({ siteId: row.siteId, entityId: row.entityId });
  }
  if (!guard) throw new Error("advanced_filter_count_combined_guard_missing");
  if (
    guard.rawCount > ADVANCED_FILTER_ACTIVITY_LIMIT ||
    guard.nullActivityIdCount > guard.rawCount ||
    guard.siteIdentityMismatchCount > guard.rawCount
  )
    throw new Error("advanced_filter_count_combined_guard_invalid");
  return {
    ...guard,
    numericCompatibilityFieldIds: [
      ...guard.numericCompatibilityFieldIds,
    ].sort(),
    matches,
  };
}

/** Decode one resource guard and every scope row before any identity is trusted. */
export async function queryAdvancedFilterCountPayloadCombined(input: {
  readonly env: Env;
  readonly query: AdvancedFilterCountPayloadCombinedQuery;
  readonly diagnostics?: D1ReadDiagnostics;
}): Promise<AdvancedFilterCountPayloadCombinedRows> {
  const witness = payloadCombinedAdmissionWitnesses.get(input.query);
  if (
    input.query[payloadCombinedQueryMetadataBrand] !== true ||
    !witness ||
    input.query.paths.length === 0 ||
    input.query.maximumNodes !== ADVANCED_FILTER_MAX_PAYLOAD_NODES ||
    witness.maximumNodes !== input.query.maximumNodes ||
    input.query.paths.length !== witness.paths.length ||
    input.query.paths.some(
      (entry, index) =>
        entry.path !== witness.paths[index]?.path ||
        entry.key !== witness.paths[index]?.key,
    )
  )
    throw new Error("advanced_filter_count_payload_admission_metadata_invalid");
  const rows = await executeQuery({
    env: input.env,
    query: input.query.query,
    stage: "payload-combined",
    diagnostics: input.diagnostics,
  });
  type Guard = Omit<AdvancedFilterCountPayloadCombinedRows, "matches">;
  let guard: Guard | undefined;
  const matches: AdvancedFilterCountPayloadCombinedRows["matches"][number][] =
    [];
  const identities = new Set<string>();
  const summaryTotals = {
    rawCount: 0,
    nullActivityIdCount: 0,
    siteIdentityMismatchCount: 0,
    payloadMissingFactCount: 0,
  };
  for (const row of rows) {
    if (row.rowKind === "guard") {
      if (guard)
        throw new Error("advanced_filter_count_payload_guard_repeated");
      if (
        typeof row.siteId !== "string" ||
        row.siteId !== "" ||
        typeof row.entityId !== "string" ||
        row.entityId !== "" ||
        nonnegativeInteger(row.matched, "matched") !== 0
      )
        throw new Error("advanced_filter_count_payload_guard_invalid");
      const activityControlPlaceholders = [
        nonnegativeInteger(row.rawCount, "raw_count"),
        nonnegativeInteger(row.nullActivityIdCount, "null_activity_id_count"),
        nonnegativeInteger(
          row.siteIdentityMismatchCount,
          "site_identity_mismatch_count",
        ),
        nonnegativeInteger(
          row.payloadMissingFactCount,
          "payload_missing_fact_count",
        ),
      ];
      if (activityControlPlaceholders.some((value) => value !== 0))
        throw new Error("advanced_filter_count_payload_guard_invalid");
      guard = {
        rawCount: 0,
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        payloadNodeCount: nonnegativeInteger(
          row.payloadNodeCount,
          "payload_node_count",
        ),
        payloadMissingFactCount: 0,
        payloadStructureInvalidCount: nonnegativeInteger(
          row.payloadStructureInvalidCount,
          "payload_structure_invalid_count",
        ),
        payloadValueInvalidCount: nonnegativeInteger(
          row.payloadValueInvalidCount,
          "payload_value_invalid_count",
        ),
        payloadMultiplicityInvalidCount: nonnegativeInteger(
          row.payloadMultiplicityInvalidCount,
          "payload_multiplicity_invalid_count",
        ),
      };
      continue;
    }
    if (row.rowKind !== "scope")
      throw new Error("advanced_filter_count_payload_row_kind_invalid");
    if (
      !Object.prototype.hasOwnProperty.call(row, "siteId") ||
      !Object.prototype.hasOwnProperty.call(row, "entityId") ||
      (row.siteId !== null && typeof row.siteId !== "string") ||
      (row.entityId !== null && typeof row.entityId !== "string")
    )
      throw new Error("advanced_filter_count_payload_scope_identity_invalid");
    const matched = nonnegativeInteger(row.matched, "matched");
    if (matched > 1)
      throw new Error("advanced_filter_count_payload_match_flag_invalid");
    const rawCount = nonnegativeInteger(row.rawCount, "raw_count");
    const nullActivityIdCount = nonnegativeInteger(
      row.nullActivityIdCount,
      "null_activity_id_count",
    );
    const siteIdentityMismatchCount = nonnegativeInteger(
      row.siteIdentityMismatchCount,
      "site_identity_mismatch_count",
    );
    const payloadMissingFactCount = nonnegativeInteger(
      row.payloadMissingFactCount,
      "payload_missing_fact_count",
    );
    if (
      rawCount === 0 ||
      nullActivityIdCount > rawCount ||
      siteIdentityMismatchCount > rawCount ||
      payloadMissingFactCount > rawCount ||
      nonnegativeInteger(row.payloadNodeCount, "payload_node_count") !== 0 ||
      nonnegativeInteger(
        row.payloadStructureInvalidCount,
        "payload_structure_invalid_count",
      ) !== 0 ||
      nonnegativeInteger(
        row.payloadValueInvalidCount,
        "payload_value_invalid_count",
      ) !== 0 ||
      nonnegativeInteger(
        row.payloadMultiplicityInvalidCount,
        "payload_multiplicity_invalid_count",
      ) !== 0
    )
      throw new Error("advanced_filter_count_payload_scope_control_invalid");
    const identityKey = JSON.stringify([row.siteId, row.entityId]);
    if (identityKey === undefined || identities.has(identityKey))
      throw new Error("advanced_filter_count_payload_scope_repeated");
    identities.add(identityKey);
    summaryTotals.rawCount = addNonnegativeIntegersSafely(
      summaryTotals.rawCount,
      rawCount,
      "raw_count",
    );
    summaryTotals.nullActivityIdCount = addNonnegativeIntegersSafely(
      summaryTotals.nullActivityIdCount,
      nullActivityIdCount,
      "null_activity_id_count",
    );
    summaryTotals.siteIdentityMismatchCount = addNonnegativeIntegersSafely(
      summaryTotals.siteIdentityMismatchCount,
      siteIdentityMismatchCount,
      "site_identity_mismatch_count",
    );
    summaryTotals.payloadMissingFactCount = addNonnegativeIntegersSafely(
      summaryTotals.payloadMissingFactCount,
      payloadMissingFactCount,
      "payload_missing_fact_count",
    );
    matches.push({
      matched: matched as 0 | 1,
      rawCount,
      nullActivityIdCount,
      siteIdentityMismatchCount,
      payloadMissingFactCount,
      siteId: row.siteId,
      entityId: row.entityId,
    });
  }
  if (!guard) throw new Error("advanced_filter_count_payload_guard_missing");
  return {
    ...guard,
    ...summaryTotals,
    matches,
  };
}

/** Validate every match identity together, after guard fallback priority. */
export function validateAdvancedFilterCountCombinedMatches(
  matches: AdvancedFilterCountCombinedRows["matches"],
  expectedSiteId: string,
): Array<{ readonly siteId: string; readonly entityId: string }> {
  const identities = new Set<string>();
  const validated: Array<{
    readonly siteId: string;
    readonly entityId: string;
  }> = [];
  for (const match of matches) {
    if (
      typeof match.siteId !== "string" ||
      match.siteId.length === 0 ||
      match.siteId !== expectedSiteId ||
      typeof match.entityId !== "string" ||
      match.entityId.length === 0
    )
      throw new Error("advanced_filter_count_combined_identity_invalid");
    const key = JSON.stringify([match.siteId, match.entityId]);
    if (identities.has(key))
      throw new Error("advanced_filter_count_combined_identity_repeated");
    identities.add(key);
    validated.push({ siteId: match.siteId, entityId: match.entityId });
  }
  return validated;
}

/** Validate only SQL-matched scope identities after all controls passed. */
export function validateAdvancedFilterCountPayloadCombinedMatches(
  matches: AdvancedFilterCountPayloadCombinedRows["matches"],
  expectedSiteId: string,
): Array<{ readonly siteId: string; readonly entityId: string }> {
  const identities = new Set<string>();
  const validated: Array<{
    readonly siteId: string;
    readonly entityId: string;
  }> = [];
  for (const match of matches) {
    if (match.matched === 0) continue;
    if (
      typeof match.siteId !== "string" ||
      match.siteId.length === 0 ||
      match.siteId !== expectedSiteId ||
      typeof match.entityId !== "string" ||
      match.entityId.length === 0
    )
      throw new Error("advanced_filter_count_payload_identity_invalid");
    const key = JSON.stringify([match.siteId, match.entityId]);
    if (identities.has(key))
      throw new Error("advanced_filter_count_payload_identity_repeated");
    identities.add(key);
    validated.push({ siteId: match.siteId, entityId: match.entityId });
  }
  return validated;
}
