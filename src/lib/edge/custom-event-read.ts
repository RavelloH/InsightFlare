import { CUSTOM_EVENT_JSON_TYPE } from "./custom-event-json";
import { SITE_PK_FROM_SITE_ID_SQL } from "./site-identity-sql";
import type { Env } from "./types";

interface CustomEventRow {
  eventPk: number;
  eventId: string;
  siteId: string;
  visitId: string;
  eventName: string;
  occurredAt: number;
  receivedAt: number;
  sequence: number;
  nodeCount: number;
  valueCount: number;
}

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
  const rows = await env.DB.prepare(
    `
      SELECT
        ce.event_id AS eventId,
        ce.visit_id AS visitId,
        cen.name AS eventName,
        ce.occurred_at AS occurredAt,
        ce.received_at AS receivedAt,
        ce.sequence,
        ce.node_count AS nodeCount,
        ce.value_count AS valueCount
      FROM custom_events ce
      INNER JOIN custom_event_names cen
        ON cen.id = ce.event_name_id
      WHERE ce.site_pk = ${SITE_PK_FROM_SITE_ID_SQL} AND ce.visit_id = ?
      ORDER BY ce.occurred_at ASC, ce.sequence ASC, ce.event_pk ASC
      LIMIT ?
    `,
  )
    .bind(siteId, visitId, safeLimit)
    .all<Record<string, unknown>>();

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
  const row = await env.DB.prepare(
    `
      SELECT visit_id AS visitId
      FROM custom_events
      WHERE site_pk = ${SITE_PK_FROM_SITE_ID_SQL} AND event_id = ?
      LIMIT 1
    `,
  )
    .bind(siteId, eventId)
    .first<{ visitId: string }>();
  return row?.visitId ?? null;
}

export async function readCustomEventDetail(
  env: Env,
  siteId: string,
  eventId: string,
): Promise<CustomEventDetail | null> {
  const event = await env.DB.prepare(
    `
      SELECT
        ce.event_pk AS eventPk,
        ce.event_id AS eventId,
        ce.site_id AS siteId,
        ce.visit_id AS visitId,
        cen.name AS eventName,
        ce.occurred_at AS occurredAt,
        ce.received_at AS receivedAt,
        ce.sequence,
        ce.node_count AS nodeCount,
        ce.value_count AS valueCount
      FROM custom_events ce
      INNER JOIN custom_event_names cen
        ON cen.id = ce.event_name_id
      WHERE ce.site_pk = ${SITE_PK_FROM_SITE_ID_SQL} AND ce.event_id = ?
      LIMIT 1
    `,
  )
    .bind(siteId, eventId)
    .first<CustomEventRow>();
  if (!event) return null;

  const nodes = await env.DB.prepare(
    `
      SELECT
        n.node_id AS nodeId,
        n.parent_node_id AS parentNodeId,
        k.key AS key,
        n.value_type AS valueType,
        n.member_order AS memberOrder,
        n.array_index AS arrayIndex,
        v.string_value AS stringValue,
        v.number_value AS numberValue,
        v.boolean_value AS booleanValue
      FROM custom_event_json_nodes n
      LEFT JOIN custom_event_json_keys k
        ON k.id = n.key_id
      LEFT JOIN custom_event_json_values v
        ON v.event_pk = n.event_pk
       AND v.node_id = n.node_id
      WHERE n.event_pk = ?
      ORDER BY n.depth ASC, n.parent_node_id ASC, n.member_order ASC, n.array_index ASC
    `,
  )
    .bind(event.eventPk)
    .all<CustomEventNodeRow>();

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
    eventData: rebuildEventData(nodes.results),
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
