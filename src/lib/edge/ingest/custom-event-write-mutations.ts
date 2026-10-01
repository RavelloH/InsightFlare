import {
  and,
  compileD1Mutation,
  eq,
  filter,
  insertOrIgnoreFromQuery,
  limit,
  param,
  project,
  scan,
} from "@/lib/db";
import type { CompiledMutation } from "@/lib/db/mutation/plan";
import { schema } from "@/lib/db/schema";

import type { ExpandedCustomEventData } from "./custom-event-json";
import type { BufferedCustomEventRow } from "./types";

export interface CustomEventDictionaryIds {
  eventNameId: number;
  keyIds: Map<string, number>;
  pathIds: Map<string, number>;
}

export function prepareCustomEventMutations(
  row: BufferedCustomEventRow,
  expanded: ExpandedCustomEventData,
  ids: CustomEventDictionaryIds,
  sitePk: number,
): CompiledMutation[] {
  const visits = scan(schema.visits);
  const matchingVisit = limit(
    filter(
      visits,
      and(
        eq(visits.columns.site_pk, param(sitePk)),
        eq(visits.columns.visit_id, param(row.visitId)),
      ),
    ),
    1,
  );
  const eventSource = project(matchingVisit, {
    event_id: param(row.eventId),
    site_id: param(row.siteId),
    site_pk: param(sitePk),
    visit_id: param(row.visitId),
    event_name_id: param(ids.eventNameId),
    occurred_at: param(row.occurredAt),
    received_at: param(row.receivedAt),
    sequence: param(row.sequence),
    node_count: param(expanded.nodes.length),
    value_count: param(expanded.values.length),
    user_id: param(row.userId || null),
    ae_synced_at: param(null),
    created_at: param(row.createdAt),
  });
  const event = compileD1Mutation(
    insertOrIgnoreFromQuery(
      schema.custom_events,
      [
        "event_id",
        "site_id",
        "site_pk",
        "visit_id",
        "event_name_id",
        "occurred_at",
        "received_at",
        "sequence",
        "node_count",
        "value_count",
        "user_id",
        "ae_synced_at",
        "created_at",
      ],
      eventSource,
    ),
    { tag: "ingest.custom_events.insert" },
  );

  const nodeMutations = expanded.nodes.map((node) => {
    const pathId = ids.pathIds.get(node.path);
    if (pathId === undefined)
      throw new Error(`Missing custom event path id for ${node.path}`);
    const keyId = node.key === null ? null : ids.keyIds.get(node.key);
    if (node.key !== null && keyId === undefined)
      throw new Error(`Missing custom event key id for ${node.key}`);

    const events = scan(schema.custom_events);
    const matchingEvent = filter(
      events,
      eq(events.columns.event_id, param(row.eventId)),
    );
    const source = project(matchingEvent, {
      event_pk: matchingEvent.columns.event_pk,
      node_id: param(node.nodeId),
      parent_node_id: param(node.parentNodeId),
      key_id: param(keyId ?? null),
      path_id: param(pathId),
      value_type: param(node.valueType),
      member_order: param(node.memberOrder),
      array_index: param(node.arrayIndex),
      depth: param(node.depth),
    });
    return compileD1Mutation(
      insertOrIgnoreFromQuery(
        schema.custom_event_json_nodes,
        [
          "event_pk",
          "node_id",
          "parent_node_id",
          "key_id",
          "path_id",
          "value_type",
          "member_order",
          "array_index",
          "depth",
        ],
        source,
      ),
      { tag: "ingest.custom_event_json_nodes.insert" },
    );
  });

  const valueMutations = expanded.values.map((value) => {
    const pathId = ids.pathIds.get(value.path);
    if (pathId === undefined)
      throw new Error(`Missing custom event path id for ${value.path}`);

    const events = scan(schema.custom_events);
    const matchingEvent = filter(
      events,
      eq(events.columns.event_id, param(row.eventId)),
    );
    const source = project(matchingEvent, {
      event_pk: matchingEvent.columns.event_pk,
      node_id: param(value.nodeId),
      site_id: param(row.siteId),
      site_pk: param(sitePk),
      event_name_id: param(ids.eventNameId),
      path_id: param(pathId),
      occurred_at: param(row.occurredAt),
      scope_node_id: param(value.scopeNodeId),
      value_type: param(value.valueType),
      string_value: param(value.stringValue),
      string_hash: param(value.stringHash),
      number_value: param(value.numberValue),
      boolean_value: param(value.booleanValue),
    });
    return compileD1Mutation(
      insertOrIgnoreFromQuery(
        schema.custom_event_json_values,
        [
          "event_pk",
          "node_id",
          "site_id",
          "site_pk",
          "event_name_id",
          "path_id",
          "occurred_at",
          "scope_node_id",
          "value_type",
          "string_value",
          "string_hash",
          "number_value",
          "boolean_value",
        ],
        source,
      ),
      { tag: "ingest.custom_event_json_values.insert" },
    );
  });

  return [event, ...nodeMutations, ...valueMutations];
}
