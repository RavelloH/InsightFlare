import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  isNull,
  join,
  limit as queryLimit,
  param,
  project,
  scan,
  schema,
  sort,
} from "@/lib/db";
import { CUSTOM_EVENT_JSON_TYPE } from "@/lib/edge/ingest/custom-event-json";
import { sitePkForSiteId } from "@/lib/edge/sites/identity-query";
import type { Env } from "@/lib/edge/types";

interface CustomEventNodeRow {
  nodeId: number;
  parentNodeId: number | null;
  key: string | null;
  valueType: number;
  memberOrder: number | null;
  arrayIndex: number | null;
  stringValue: string | null;
  numberValue: number | null;
  booleanValue: number | null;
}

export interface CustomEventListItem {
  eventId: string;
  visitId: string;
  eventName: string;
  occurredAt: number;
  receivedAt: number;
  sequence: number;
  nodeCount: number;
  valueCount: number;
}

export interface CustomEventDetail extends CustomEventListItem {
  siteId: string;
  eventData: unknown;
}

export async function readCustomEventsForVisit(
  env: Env,
  siteId: string,
  visitId: string,
  limit = 100,
): Promise<CustomEventListItem[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 500);
  const events = scan(schema.custom_events);
  const names = scan(schema.custom_event_names);
  const joined = join(
    events,
    names,
    eq(events.columns.event_name_id, names.columns.id),
  );
  const matching = filter(
    joined,
    and(
      eq(joined.columns.left_site_pk, sitePkForSiteId(siteId)),
      eq(joined.columns.left_visit_id, param(visitId)),
    ),
  );
  const ordered = sort(matching, [
    { expression: matching.columns.left_occurred_at, direction: "ASC" },
    { expression: matching.columns.left_sequence, direction: "ASC" },
    { expression: matching.columns.left_event_pk, direction: "ASC" },
  ]);
  const bounded = queryLimit(ordered, safeLimit);
  const query = project(bounded, {
    eventId: bounded.columns.left_event_id,
    visitId: bounded.columns.left_visit_id,
    eventName: bounded.columns.right_name,
    occurredAt: bounded.columns.left_occurred_at,
    receivedAt: bounded.columns.left_received_at,
    sequence: bounded.columns.left_sequence,
    nodeCount: bounded.columns.left_node_count,
    valueCount: bounded.columns.left_value_count,
  });
  const rows = await createD1DatabaseClient(env.DB).all(
    compileD1Query(query, { tag: "analytics.custom_events.all" }),
  );

  return rows.results.map((row) => ({
    eventId: String(row.eventId ?? ""),
    visitId: String(row.visitId ?? ""),
    eventName: String(row.eventName ?? ""),
    occurredAt: Number(row.occurredAt ?? 0),
    receivedAt: Number(row.receivedAt ?? 0),
    sequence: Number(row.sequence ?? 0),
    nodeCount: Number(row.nodeCount ?? 0),
    valueCount: Number(row.valueCount ?? 0),
  }));
}

export async function readCustomEventVisitId(
  env: Env,
  siteId: string,
  eventId: string,
): Promise<string | null> {
  const events = scan(schema.custom_events);
  const matching = filter(
    events,
    and(
      eq(events.columns.site_pk, sitePkForSiteId(siteId)),
      eq(events.columns.event_id, param(eventId)),
    ),
  );
  const bounded = queryLimit(matching, 1);
  const query = project(bounded, { visitId: bounded.columns.visit_id });
  const row = await createD1DatabaseClient(env.DB).first(
    compileD1Query(query, { tag: "analytics.custom_events.first" }),
  );
  return row?.visitId ?? null;
}

export async function readCustomEventDetail(
  env: Env,
  siteId: string,
  eventId: string,
): Promise<CustomEventDetail | null> {
  const events = scan(schema.custom_events);
  const names = scan(schema.custom_event_names);
  const joined = join(
    events,
    names,
    eq(events.columns.event_name_id, names.columns.id),
  );
  const matching = filter(
    joined,
    and(
      eq(joined.columns.left_site_pk, sitePkForSiteId(siteId)),
      eq(joined.columns.left_event_id, param(eventId)),
    ),
  );
  const bounded = queryLimit(matching, 1);
  const eventQuery = project(bounded, {
    eventPk: bounded.columns.left_event_pk,
    eventId: bounded.columns.left_event_id,
    siteId: bounded.columns.left_site_id,
    visitId: bounded.columns.left_visit_id,
    eventName: bounded.columns.right_name,
    occurredAt: bounded.columns.left_occurred_at,
    receivedAt: bounded.columns.left_received_at,
    sequence: bounded.columns.left_sequence,
    nodeCount: bounded.columns.left_node_count,
    valueCount: bounded.columns.left_value_count,
  });
  const event = await createD1DatabaseClient(env.DB).first(
    compileD1Query(eventQuery, { tag: "analytics.custom_events.first" }),
  );
  if (!event) return null;

  const nodes = scan(schema.custom_event_json_nodes);
  const keys = scan(schema.custom_event_json_keys);
  const nodesWithKeys = join(
    nodes,
    keys,
    eq(nodes.columns.key_id, keys.columns.id),
    "left",
  );
  const keyedNodes = project(nodesWithKeys, {
    event_pk: nodesWithKeys.columns.left_event_pk,
    node_id: nodesWithKeys.columns.left_node_id,
    parent_node_id: nodesWithKeys.columns.left_parent_node_id,
    depth: nodesWithKeys.columns.left_depth,
    key: nodesWithKeys.columns.right_key,
    value_type: nodesWithKeys.columns.left_value_type,
    member_order: nodesWithKeys.columns.left_member_order,
    array_index: nodesWithKeys.columns.left_array_index,
  });
  const values = scan(schema.custom_event_json_values);
  const nodesWithValues = join(
    keyedNodes,
    values,
    and(
      eq(keyedNodes.columns.event_pk, values.columns.event_pk),
      eq(keyedNodes.columns.node_id, values.columns.node_id),
    ),
    "left",
  );
  const eventPkPredicate =
    event.eventPk === null
      ? isNull(nodesWithValues.columns.left_event_pk)
      : eq(nodesWithValues.columns.left_event_pk, param(event.eventPk));
  const matchingNodes = filter(nodesWithValues, eventPkPredicate);
  const orderedNodes = sort(matchingNodes, [
    { expression: matchingNodes.columns.left_depth, direction: "ASC" },
    {
      expression: matchingNodes.columns.left_parent_node_id,
      direction: "ASC",
    },
    {
      expression: matchingNodes.columns.left_member_order,
      direction: "ASC",
    },
    {
      expression: matchingNodes.columns.left_array_index,
      direction: "ASC",
    },
  ]);
  const nodeQuery = project(orderedNodes, {
    nodeId: orderedNodes.columns.left_node_id,
    parentNodeId: orderedNodes.columns.left_parent_node_id,
    key: orderedNodes.columns.left_key,
    valueType: orderedNodes.columns.left_value_type,
    memberOrder: orderedNodes.columns.left_member_order,
    arrayIndex: orderedNodes.columns.left_array_index,
    stringValue: orderedNodes.columns.right_string_value,
    numberValue: orderedNodes.columns.right_number_value,
    booleanValue: orderedNodes.columns.right_boolean_value,
  });
  const nodeRows = await createD1DatabaseClient(env.DB).all(
    compileD1Query(nodeQuery, {
      tag: "analytics.custom_event_json_nodes.all",
    }),
  );

  return {
    eventId: event.eventId,
    siteId: event.siteId,
    visitId: event.visitId,
    eventName: event.eventName,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    sequence: event.sequence,
    nodeCount: event.nodeCount,
    valueCount: event.valueCount,
    eventData: rebuildEventData(nodeRows.results),
  };
}

function rebuildEventData(nodes: CustomEventNodeRow[]): unknown {
  const byParent = new Map<number | null, CustomEventNodeRow[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parentNodeId) ?? [];
    list.push(node);
    byParent.set(node.parentNodeId, list);
  }
  const root = byParent.get(null)?.[0];
  if (!root) return {};
  return materializeNode(root, byParent);
}

function materializeNode(
  node: CustomEventNodeRow,
  byParent: Map<number | null, CustomEventNodeRow[]>,
): unknown {
  if (node.valueType === CUSTOM_EVENT_JSON_TYPE.object) {
    const output: Record<string, unknown> = {};
    const children = [...(byParent.get(node.nodeId) ?? [])].sort(
      (left, right) => (left.memberOrder ?? 0) - (right.memberOrder ?? 0),
    );
    for (const child of children) {
      if (child.key === null) continue;
      output[child.key] = materializeNode(child, byParent);
    }
    return output;
  }

  if (node.valueType === CUSTOM_EVENT_JSON_TYPE.array) {
    return [...(byParent.get(node.nodeId) ?? [])]
      .sort((left, right) => (left.arrayIndex ?? 0) - (right.arrayIndex ?? 0))
      .map((child) => materializeNode(child, byParent));
  }

  if (node.valueType === CUSTOM_EVENT_JSON_TYPE.string) {
    return node.stringValue ?? "";
  }
  if (node.valueType === CUSTOM_EVENT_JSON_TYPE.number) {
    return Number(node.numberValue ?? 0);
  }
  if (node.valueType === CUSTOM_EVENT_JSON_TYPE.boolean) {
    return node.booleanValue === 1;
  }
  return null;
}
