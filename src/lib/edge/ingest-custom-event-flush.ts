import {
  expandCustomEventDataJson,
  type ExpandedCustomEventData,
} from "./custom-event-json";
import { FLUSHED_BUFFER_RETENTION_MS } from "./ingest-constants";
import {
  type IngestFlushContext,
  recordFlushCounter,
  resolveSitePk,
} from "./ingest-flush-types";
import type { BufferedCustomEventRow, DictionaryKind } from "./ingest-types";
import { clampString } from "./utils";

export async function flushCustomEventRowIndividually(
  context: IngestFlushContext,
  row: BufferedCustomEventRow,
): Promise<boolean> {
  try {
    const sitePk = await resolveSitePk(context, row.siteId);
    if (!(await hasPersistedVisit(context, sitePk, row.visitId))) {
      context.observability?.warn("do.flush.custom_event_waiting_for_visit");
      markCustomEventRowsFailed(context, [row], "waiting_for_visit");
      return false;
    }
    const expanded = expandCustomEventDataJson(row.eventDataJson);
    if (!expanded.ok) {
      throw new Error(expanded.error);
    }
    const ids = await resolveCustomEventDictionaryIds(
      context,
      row,
      expanded.data,
      sitePk,
    );
    const statements = prepareCustomEventStatements(
      context,
      row,
      expanded.data,
      ids,
      sitePk,
    );
    recordFlushCounter(context, "d1Statements", statements.length);
    await context.env.DB.batch(statements);
    if (!(await hasPersistedCustomEvent(context, row.eventId))) {
      context.observability?.warn("do.flush.custom_event_insert_not_confirmed");
      markCustomEventRowsFailed(context, [row], "insert_did_not_create_event");
      return false;
    }
    recordFlushCounter(context, "flushedCustomEvents");
    markCustomEventRowsFlushed(context, [row]);
    return true;
  } catch (error) {
    const message = clampString(
      String(error instanceof Error ? error.message : error),
      400,
    );
    void message;
    recordFlushCounter(context, "failedStatements");
    context.observability?.error("do.flush.custom_event_failed");
    markCustomEventRowsFailed(context, [row], message);
    return false;
  }
}

function markCustomEventRowsFlushed(
  context: IngestFlushContext,
  rows: BufferedCustomEventRow[],
): void {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.eventId);
  const updated = context.sqlRun(
    `UPDATE buffered_custom_events SET dirty = 0, flush_attempts = 0, last_flush_error = NULL WHERE event_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  void updated;
  deleteFlushedCustomEventRows(context, rows);
}

function markCustomEventRowsFailed(
  context: IngestFlushContext,
  rows: BufferedCustomEventRow[],
  errorMessage: string,
): void {
  if (rows.length === 0) return;
  const ids = rows.map((row) => row.eventId);
  const deleted = context.sqlRun(
    `DELETE FROM buffered_custom_events WHERE event_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  void deleted;
  void errorMessage;
}

function dictionarySql(kind: DictionaryKind): {
  table: string;
  column: string;
} {
  if (kind === "name") {
    return { table: "custom_event_names", column: "name" };
  }
  if (kind === "key") {
    return { table: "custom_event_json_keys", column: '"key"' };
  }
  return { table: "custom_event_json_paths", column: "path" };
}

async function resolveDictionaryId(
  context: IngestFlushContext,
  kind: DictionaryKind,
  siteId: string,
  sitePk: number,
  value: string,
  seenAt: number,
): Promise<number> {
  const cacheKey = `${kind}:${siteId}:${value}`;
  const cached = context.dictionaryIds.get(cacheKey);
  if (cached !== undefined) return cached;

  const spec = dictionarySql(kind);
  recordFlushCounter(context, "d1Statements");
  await context.env.DB.prepare(
    `
      INSERT INTO ${spec.table} (site_id, site_pk, ${spec.column}, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(site_pk, ${spec.column}) DO UPDATE SET
        last_seen_at = excluded.last_seen_at
    `,
  )
    .bind(siteId, sitePk, value, seenAt, seenAt)
    .run();

  recordFlushCounter(context, "d1Statements");
  const row = await context.env.DB.prepare(
    `
      SELECT id
      FROM ${spec.table}
      WHERE site_pk = ? AND ${spec.column} = ?
      LIMIT 1
    `,
  )
    .bind(sitePk, value)
    .first<{ id: number }>();
  const id = Number(row?.id ?? 0);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error(`Failed to resolve custom event ${kind} dictionary id`);
  }
  context.dictionaryIds.set(cacheKey, id);
  return id;
}

async function resolveCustomEventDictionaryIds(
  context: IngestFlushContext,
  row: BufferedCustomEventRow,
  expanded: ExpandedCustomEventData,
  sitePk: number,
): Promise<{
  eventNameId: number;
  keyIds: Map<string, number>;
  pathIds: Map<string, number>;
}> {
  const seenAt = row.createdAt;
  const eventNameId = await resolveDictionaryId(
    context,
    "name",
    row.siteId,
    sitePk,
    row.eventName,
    seenAt,
  );
  const keyIds = new Map<string, number>();
  for (const key of expanded.keys) {
    keyIds.set(
      key,
      await resolveDictionaryId(
        context,
        "key",
        row.siteId,
        sitePk,
        key,
        seenAt,
      ),
    );
  }
  const pathIds = new Map<string, number>();
  for (const path of expanded.paths) {
    pathIds.set(
      path,
      await resolveDictionaryId(
        context,
        "path",
        row.siteId,
        sitePk,
        path,
        seenAt,
      ),
    );
  }
  return { eventNameId, keyIds, pathIds };
}

async function hasPersistedVisit(
  context: IngestFlushContext,
  sitePk: number,
  visitId: string,
): Promise<boolean> {
  recordFlushCounter(context, "d1Statements");
  const persisted = await context.env.DB.prepare(
    `
      SELECT 1 AS ok
      FROM visits
      WHERE site_pk = ? AND visit_id = ?
      LIMIT 1
    `,
  )
    .bind(sitePk, visitId)
    .first<{ ok: number }>();
  return persisted !== null;
}

async function hasPersistedCustomEvent(
  context: IngestFlushContext,
  eventId: string,
): Promise<boolean> {
  recordFlushCounter(context, "d1Statements");
  const persisted = await context.env.DB.prepare(
    `
      SELECT 1 AS ok
      FROM custom_events
      WHERE event_id = ?
      LIMIT 1
    `,
  )
    .bind(eventId)
    .first<{ ok: number }>();
  return persisted !== null;
}

function prepareCustomEventStatements(
  context: IngestFlushContext,
  row: BufferedCustomEventRow,
  expanded: ExpandedCustomEventData,
  ids: {
    eventNameId: number;
    keyIds: Map<string, number>;
    pathIds: Map<string, number>;
  },
  sitePk: number,
): D1PreparedStatement[] {
  const eventStatement = context.env.DB.prepare(
    `
      INSERT OR IGNORE INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at, received_at,
        sequence, node_count, value_count, user_id, ae_synced_at, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
      FROM visits
      WHERE site_pk = ? AND visit_id = ?
      LIMIT 1
    `,
  ).bind(
    row.eventId,
    row.siteId,
    sitePk,
    row.visitId,
    ids.eventNameId,
    row.occurredAt,
    row.receivedAt,
    row.sequence,
    expanded.nodes.length,
    expanded.values.length,
    row.userId || null,
    row.createdAt,
    sitePk,
    row.visitId,
  );

  const nodeStatements = expanded.nodes.map((node) => {
    const pathId = ids.pathIds.get(node.path);
    if (pathId === undefined) {
      throw new Error(`Missing custom event path id for ${node.path}`);
    }
    const keyId = node.key === null ? null : ids.keyIds.get(node.key);
    if (node.key !== null && keyId === undefined) {
      throw new Error(`Missing custom event key id for ${node.key}`);
    }
    return context.env.DB.prepare(
      `
        INSERT OR IGNORE INTO custom_event_json_nodes (
          event_pk, node_id, parent_node_id, key_id, path_id, value_type,
          member_order, array_index, depth
        )
        SELECT event_pk, ?, ?, ?, ?, ?, ?, ?, ?
        FROM custom_events
        WHERE event_id = ?
      `,
    ).bind(
      node.nodeId,
      node.parentNodeId,
      keyId ?? null,
      pathId,
      node.valueType,
      node.memberOrder,
      node.arrayIndex,
      node.depth,
      row.eventId,
    );
  });

  const valueStatements = expanded.values.map((value) => {
    const pathId = ids.pathIds.get(value.path);
    if (pathId === undefined) {
      throw new Error(`Missing custom event value path id for ${value.path}`);
    }
    return context.env.DB.prepare(
      `
        INSERT OR IGNORE INTO custom_event_json_values (
          event_pk, node_id, site_id, site_pk, event_name_id, path_id, occurred_at,
          scope_node_id, value_type, string_value, string_hash, number_value,
          boolean_value
        )
        SELECT event_pk, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM custom_events
        WHERE event_id = ?
      `,
    ).bind(
      value.nodeId,
      row.siteId,
      sitePk,
      ids.eventNameId,
      pathId,
      row.occurredAt,
      value.scopeNodeId,
      value.valueType,
      value.stringValue,
      value.stringHash,
      value.numberValue,
      value.booleanValue,
      row.eventId,
    );
  });

  return [eventStatement, ...nodeStatements, ...valueStatements];
}

function deleteFlushedCustomEventRows(
  context: IngestFlushContext,
  rows: BufferedCustomEventRow[],
): void {
  const cutoffMs = Date.now() - FLUSHED_BUFFER_RETENTION_MS;
  const ids = rows
    .filter((row) => row.occurredAt < cutoffMs)
    .map((row) => row.eventId);
  if (ids.length === 0) return;
  const deleted = context.sqlRun(
    `DELETE FROM buffered_custom_events WHERE event_id IN (${ids.map(() => "?").join(",")})`,
    ...ids,
  );
  void deleted;
  void cutoffMs;
}
