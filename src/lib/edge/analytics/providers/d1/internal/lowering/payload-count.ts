import {
  aggregate,
  constant,
  count,
  eq,
  filter,
  join,
  limit as limitRelation,
  lte,
  project,
} from "@/lib/db";
import type {
  AnyExpression,
  ExpressionResultType,
  SqlExpression,
} from "@/lib/db/query/expression";
import type {
  RelationId,
  SlotId,
} from "@/lib/edge/analytics/engine/logical/ids";
import type {
  EventPayloadPropertiesNode,
  LogicalNode,
} from "@/lib/edge/analytics/engine/logical/nodes";
import type { LogicalSlot } from "@/lib/edge/analytics/engine/logical/slots";
import type { EventPayloadTopLevelPath } from "@/lib/edge/analytics/engine/semantic/event-payload-logical";
import type { AnalyticsEventPayloadKeySourceBinding } from "@/lib/edge/analytics/providers/d1/internal/analytics-event-identity-proof";
import type {
  AnalyticsDbRelation,
  AnalyticsRelationalStorage,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import { reject } from "@/lib/edge/analytics/providers/d1/internal/lowering/errors";
import {
  logicalSlot,
  type LoweredRelation,
  type LoweredValue,
  projectedValues,
  readValue,
  relationColumn,
  type SlotLayout,
} from "@/lib/edge/analytics/providers/d1/internal/lowering/values";

import type { EVENT_PAYLOAD_NODE_FIELDS } from "./payload-layout";

export interface EventPayloadAdmissionPolicy {
  readonly propertiesRelation: RelationId;
  readonly maximumNodes: number;
}

export interface EventPayloadPropertiesIdentity {
  readonly requestId: string;
  readonly sourceId: RelationId;
  readonly eventKeySlot: SlotId;
  readonly scopeRelation: RelationId;
  readonly sourceSignature: string;
  readonly carrierRelation: AnalyticsDbRelation;
  readonly keyColumn: string;
  readonly sourceBinding: AnalyticsEventPayloadKeySourceBinding;
  readonly eventPk: AnyExpression;
  readonly sitePk: AnyExpression;
  readonly eventId: AnyExpression;
  readonly propertiesMetadata: {
    readonly siteId: AnyExpression;
    readonly eventNameId: AnyExpression;
    readonly occurredAt: AnyExpression;
    readonly visitId: AnyExpression;
  };
}

export interface EventPayloadAdmissionPacket {
  readonly propertiesRelation: RelationId;
  readonly inputRelation: RelationId;
  readonly input: AnalyticsDbRelation;
  readonly paths: readonly EventPayloadTopLevelPath[];
  readonly maximumNodes: number;
  readonly sourceIdentity: EventPayloadPropertiesIdentity;
  readonly selectedNodes: AnalyticsDbRelation;
  readonly selectedEventMetadata: AnalyticsDbRelation;
  readonly boundedNodes: AnalyticsDbRelation;
  readonly counter: AnalyticsDbRelation;
  readonly counterControl: AnalyticsDbRelation;
  readonly counterValue: SqlExpression<
    number,
    ExpressionResultType<"integer", false>
  >;
  readonly admittedCounter: AnalyticsDbRelation;
  readonly admittedNodeCounterJoin: AnalyticsDbRelation;
  readonly admittedNodes: AnalyticsDbRelation;
  readonly admittedEvents: AnalyticsDbRelation;
  readonly admittedEventMetadata: AnalyticsDbRelation;
  /** Exact Provider relation consumed by the Logical Properties read. */
  readonly propertyReadNodeRelation: AnalyticsDbRelation;
  readonly propertyReadInputRelation: AnalyticsDbRelation;
  readonly propertyReadEventMetadata: AnalyticsDbRelation;
  readonly propertyReadRelation: AnalyticsDbRelation;
  readonly propertyReadJoin: AnalyticsDbRelation;
}

/** Narrow access to the current lowerer; cache ownership stays with it. */
export interface EventPayloadCountLoweringContext {
  readonly logicalSlots: ReadonlyMap<SlotId, LogicalSlot>;
  readonly storage: Pick<
    AnalyticsRelationalStorage,
    "eventPayloadNodes" | "eventPayloadProperties"
  >;
  readonly lowerNode: (id: RelationId) => LoweredRelation;
  readonly requiredOutput: (node: LogicalNode) => ReadonlySet<SlotId>;
  readonly eventPayloadIdentity: (
    propertiesRelation: RelationId,
    sourceRelation: RelationId,
    eventKey: SlotId,
    input: LoweredRelation,
    path: string,
  ) => EventPayloadPropertiesIdentity;
  readonly admissionPolicy?: EventPayloadAdmissionPolicy;
  readonly admissionPackets: {
    get: (node: RelationId) => EventPayloadAdmissionPacket | undefined;
    set: (node: RelationId, packet: EventPayloadAdmissionPacket) => void;
  };
}

const selectedNodeFields = [
  "eventPk",
  "nodeId",
  "parentNodeId",
  "key",
  "path",
] as const satisfies readonly (keyof typeof EVENT_PAYLOAD_NODE_FIELDS)[];

function prefixLayout(layout: SlotLayout, prefix: string): SlotLayout {
  return layout.kind === "scalar"
    ? { ...layout, valueColumn: `${prefix}${layout.valueColumn}` }
    : {
        ...layout,
        keyColumns: layout.keyColumns.map((column) => `${prefix}${column}`),
        ...(layout.presentColumn
          ? { presentColumn: `${prefix}${layout.presentColumn}` }
          : {}),
      };
}

function oneRowGate(
  left: AnalyticsDbRelation,
  right: AnalyticsDbRelation,
): AnalyticsDbRelation {
  return join(left, right, eq(constant(1), constant(1)));
}

function admittedNodeRows(
  admittedNodeCounterJoin: AnalyticsDbRelation,
): AnalyticsDbRelation {
  return project(admittedNodeCounterJoin, {
    event_pk: admittedNodeCounterJoin.columns.left_eventPk,
    node_id: admittedNodeCounterJoin.columns.left_nodeId,
    parent_node_id: admittedNodeCounterJoin.columns.left_parentNodeId,
    key: admittedNodeCounterJoin.columns.left_key,
    path: admittedNodeCounterJoin.columns.left_path,
  });
}

function admittedEventMetadataRows(
  eventMetadata: AnalyticsDbRelation,
  admittedCounter: AnalyticsDbRelation,
): AnalyticsDbRelation {
  const joined = oneRowGate(eventMetadata, admittedCounter);
  return project(joined, {
    event_pk: joined.columns.left_event_pk,
    site_id: joined.columns.left_site_id,
    site_pk: joined.columns.left_site_pk,
    event_name_id: joined.columns.left_event_name_id,
    occurred_at: joined.columns.left_occurred_at,
  });
}

export function lowerEventPayloadProperties(
  node: EventPayloadPropertiesNode,
  path: string,
  context: EventPayloadCountLoweringContext,
): LoweredRelation {
  const input = context.lowerNode(node.input);
  const eventKey = readValue(
    input.relation,
    input.slots,
    node.eventKey,
    `${path}.eventKey`,
  );
  if (eventKey.kind !== "entity" || eventKey.entity !== "event")
    reject(path, "Payload properties require a non-null Event identity.");
  if (eventKey.keys.length !== 2)
    reject(`${path}.eventKey`, "Event identity must contain site and ID keys.");

  const identity = context.eventPayloadIdentity(
    node.id,
    node.input,
    node.eventKey,
    input,
    `${path}.input`,
  );
  const selected = context.storage.eventPayloadNodes(
    input.relation,
    eventKey.keys,
    identity.eventPk,
    identity.propertiesMetadata,
    node.paths.map(({ path: requested }) => requested),
    selectedNodeFields,
  );

  const policy = context.admissionPolicy;
  const requiresAdmission = policy?.propertiesRelation === node.id;
  let propertyInput = input.relation;
  let propertyInputSlots: ReadonlyMap<SlotId, SlotLayout> = input.slots;
  let selectedNodeRelation = selected.relation;
  let selectedNodeValues = {
    eventPk: relationColumn(selected.relation, "eventPk", path),
    nodeId: relationColumn(selected.relation, "nodeId", path),
    parentNodeId: relationColumn(selected.relation, "parentNodeId", path),
    key: relationColumn(selected.relation, "key", path),
    path: relationColumn(selected.relation, "path", path),
  };
  let eventMetadata = selected.eventMetadata;
  let boundedNodes: AnalyticsDbRelation | undefined;
  let counter: AnalyticsDbRelation | undefined;
  let counterControl: AnalyticsDbRelation | undefined;
  let counterValue:
    SqlExpression<number, ExpressionResultType<"integer", false>> | undefined;
  let admittedCounter: AnalyticsDbRelation | undefined;
  let admittedNodeCounterJoin: AnalyticsDbRelation | undefined;
  let admittedEvents: AnalyticsDbRelation | undefined;
  if (policy && requiresAdmission) {
    if (
      !Number.isSafeInteger(policy.maximumNodes) ||
      policy.maximumNodes <= 0 ||
      !Number.isSafeInteger(policy.maximumNodes + 1)
    )
      reject(path, "Payload admission policy has an invalid M+1 maximum.");
    boundedNodes = limitRelation(selected.relation, policy.maximumNodes + 1);
    counter = aggregate(boundedNodes, {
      groupBy: {},
      aggregates: { payloadNodeCount: count() },
    });
    counterControl = project(counter, {
      payloadNodeCount: counter.columns.payloadNodeCount,
    });
    counterValue = counter.columns.payloadNodeCount as SqlExpression<
      number,
      ExpressionResultType<"integer", false>
    >;
    admittedCounter = filter(
      counter,
      lte(counterValue, constant(policy.maximumNodes)),
    );
    admittedNodeCounterJoin = oneRowGate(boundedNodes, admittedCounter);
    admittedEvents = oneRowGate(input.relation, admittedCounter);
    selectedNodeRelation = admittedNodeRows(admittedNodeCounterJoin);
    selectedNodeValues = {
      eventPk: relationColumn(selectedNodeRelation, "event_pk", path),
      nodeId: relationColumn(selectedNodeRelation, "node_id", path),
      parentNodeId: relationColumn(
        selectedNodeRelation,
        "parent_node_id",
        path,
      ),
      key: relationColumn(selectedNodeRelation, "key", path),
      path: relationColumn(selectedNodeRelation, "path", path),
    };
    eventMetadata = admittedEventMetadataRows(
      selected.eventMetadata,
      admittedCounter,
    );
    propertyInput = admittedEvents;
    propertyInputSlots = new Map(
      [...input.slots].map(([slot, layout]) => [
        slot,
        prefixLayout(layout, "left_"),
      ]),
    );
  }

  const eventPk = requiresAdmission
    ? relationColumn(
        propertyInput,
        `left_${identity.keyColumn}`,
        `${path}.eventPk`,
      )
    : identity.eventPk;
  const propertyRows = context.storage.eventPayloadProperties(
    eventMetadata,
    selectedNodeRelation,
    selectedNodeValues,
    node.paths,
  );
  const joined = join(
    propertyInput,
    propertyRows,
    eq(eventPk as SqlExpression, propertyRows.columns.event_pk),
  );
  const joinedLayouts = new Map<SlotId, SlotLayout>();
  for (const [slot, layout] of propertyInputSlots)
    joinedLayouts.set(slot, prefixLayout(layout, "left_"));

  const values: { readonly slot: SlotId; readonly value: LoweredValue }[] = [];
  for (const slot of node.output) {
    if (!context.requiredOutput(node).has(slot)) continue;
    const property = node.properties.find((candidate) =>
      candidate.fields.some((field) => field.slot === slot),
    );
    if (!property) {
      values.push({
        slot,
        value: readValue(
          joined,
          joinedLayouts,
          slot,
          `${path}.${String(slot)}`,
        ),
      });
      continue;
    }
    const propertyIndex = node.properties.indexOf(property);
    const field = property.fields.find((candidate) => candidate.slot === slot)!;
    const logical = logicalSlot(
      context.logicalSlots,
      slot,
      `${path}.${field.field}`,
    );
    values.push({
      slot,
      value: {
        kind: "scalar",
        expression: relationColumn(
          joined,
          `right_property_${propertyIndex}_${field.field}`,
          `${path}.${field.field}`,
        ),
        type: logical.type,
        nullable: logical.nullable,
        candidateBounded: false,
      },
    });
  }
  const result = projectedValues(joined, values, context.logicalSlots, path);
  if (policy && requiresAdmission) {
    if (
      !boundedNodes ||
      !counter ||
      !counterControl ||
      !counterValue ||
      !admittedCounter ||
      !admittedNodeCounterJoin ||
      !admittedEvents
    )
      reject(path, "Payload admission relations were not materialized.");
    const packet: EventPayloadAdmissionPacket = Object.freeze({
      propertiesRelation: node.id,
      inputRelation: node.input,
      input: input.relation,
      paths: Object.freeze(
        node.paths.map((entry) => Object.freeze({ ...entry })),
      ),
      maximumNodes: policy.maximumNodes,
      sourceIdentity: identity,
      selectedNodes: selected.relation,
      selectedEventMetadata: selected.eventMetadata,
      boundedNodes,
      counter,
      counterControl,
      counterValue,
      admittedCounter,
      admittedNodeCounterJoin,
      admittedNodes: selectedNodeRelation,
      admittedEvents,
      admittedEventMetadata: eventMetadata,
      propertyReadNodeRelation: selectedNodeRelation,
      propertyReadInputRelation: propertyInput,
      propertyReadEventMetadata: eventMetadata,
      propertyReadRelation: propertyRows,
      propertyReadJoin: joined,
    });
    context.admissionPackets.set(node.id, packet);
  }
  return {
    ...result,
    candidateActivity: input.candidateActivity,
    candidateActivitySessionRelation: input.candidateActivitySessionRelation,
    candidateActivitySessionRestricted:
      input.candidateActivitySessionRestricted,
  };
}
