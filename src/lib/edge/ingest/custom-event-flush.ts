import {
  and,
  compileD1Query,
  createD1DatabaseClient,
  eq,
  filter,
  limit,
  param,
  project,
  scan,
  schema,
} from "@/lib/db";
import { clampString } from "@/lib/edge/utils";

import { FLUSHED_BUFFER_RETENTION_MS } from "./constants";
import {
  customEventDictionaryIdQuery,
  customEventDictionaryUpsert,
} from "./custom-event-dictionary-queries";
import {
  expandCustomEventDataJson,
  type ExpandedCustomEventData,
} from "./custom-event-json";
import { prepareCustomEventMutations } from "./custom-event-write-mutations";
import {
  type IngestFlushContext,
  recordFlushCounter,
  resolveSitePk,
} from "./flush-types";
import type { BufferedCustomEventRow, DictionaryKind } from "./types";
interface FlushBufferFields {
  bufferRevision: number;
  flushDueAt: number | null;
  nextDueAt: number | null;
}
type BufferedCustomEventFlushRow = BufferedCustomEventRow &
  Partial<FlushBufferFields>;
const FLUSH_RETRY_DELAYS_MS = [
  60 * 1000,
  2 * 60 * 1000,
  4 * 60 * 1000,
  8 * 60 * 1000,
  15 * 60 * 1000,
] as const;
export async function flushCustomEventRowIndividually(
  context: IngestFlushContext,
  row: BufferedCustomEventFlushRow,
): Promise<boolean> {
  try {
    const sitePk = await resolveSitePk(context, row.siteId);
    if (!(await hasPersistedVisit(context, sitePk, row.visitId))) {
      context.observability?.warn("do.flush.custom_event_waiting_for_visit");
      markCustomEventRowsWaitingForVisit(context, [row]);
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
    const statements = prepareCustomEventMutations(
      row,
      expanded.data,
      ids,
      sitePk,
    );
    await createD1DatabaseClient(context.env.DB).batch(statements);
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
    context.observability?.error("do.flush.custom_event_failed");
    markCustomEventRowsFailed(context, [row], message);
    return false;
  }
}
function markCustomEventRowsFlushed(
  context: IngestFlushContext,
  rows: BufferedCustomEventFlushRow[],
): void {
  if (rows.length === 0) return;
  const conditions = rows
    .map(() => "(event_id = ? AND buffer_revision = ?)")
    .join(" OR ");
  const bindings = rows.flatMap((row) => [row.eventId, bufferRevisionOf(row)]);
  const updated = context.sqlRun(
    `UPDATE buffered_custom_events SET dirty = 0, flush_attempts = 0, last_flush_error = NULL, flush_due_at = NULL, next_due_at = NULL WHERE ${conditions}`,
    ...bindings,
  );
  void updated;
  deleteFlushedCustomEventRows(context, rows);
}
function markCustomEventRowsFailed(
  context: IngestFlushContext,
  rows: BufferedCustomEventFlushRow[],
  errorMessage: string,
): void {
  if (rows.length === 0) return;
  const now = Date.now();
  for (const row of rows) {
    const retryAt = now + retryDelayFor(row.flushAttempts);
    const updated = context.sqlRun(
      `UPDATE buffered_custom_events SET flush_attempts = ?, last_flush_error = ?, flush_due_at = ?, next_due_at = ? WHERE event_id = ? AND buffer_revision = ? AND flush_attempts = ? AND last_flush_error IS ?`,
      row.flushAttempts + 1,
      errorMessage,
      retryAt,
      nextDueAtAfterRetry(row, retryAt),
      row.eventId,
      bufferRevisionOf(row),
      row.flushAttempts,
      row.lastFlushError ?? null,
    );
    void updated;
  }
}
function markCustomEventRowsWaitingForVisit(
  context: IngestFlushContext,
  rows: BufferedCustomEventFlushRow[],
): void {
  if (rows.length === 0) return;
  const now = Date.now();
  for (const row of rows) {
    const retryAt = now + retryDelayFor(row.flushAttempts);
    const updated = context.sqlRun(
      `UPDATE buffered_custom_events SET flush_attempts = ?, last_flush_error = 'waiting_for_visit', flush_due_at = ?, next_due_at = ? WHERE event_id = ? AND buffer_revision = ? AND flush_attempts = ? AND last_flush_error IS ?`,
      row.flushAttempts + 1,
      retryAt,
      nextDueAtAfterRetry(row, retryAt),
      row.eventId,
      bufferRevisionOf(row),
      row.flushAttempts,
      row.lastFlushError ?? null,
    );
    void updated;
  }
}
function bufferRevisionOf(row: Partial<FlushBufferFields>): number {
  return row.bufferRevision ?? 0;
}
function retryDelayFor(previousAttempts: number): number {
  const attempt = Number.isFinite(previousAttempts)
    ? Math.max(0, Math.floor(previousAttempts))
    : 0;
  return (
    FLUSH_RETRY_DELAYS_MS[
      Math.min(attempt, FLUSH_RETRY_DELAYS_MS.length - 1)
    ] ?? FLUSH_RETRY_DELAYS_MS[0]
  );
}
function nextDueAtAfterRetry(
  row: Partial<FlushBufferFields>,
  retryAt: number,
): number {
  if (
    row.nextDueAt === undefined ||
    row.nextDueAt === null ||
    row.nextDueAt === row.flushDueAt
  ) {
    return retryAt;
  }
  return Math.min(row.nextDueAt, retryAt);
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

  const client = createD1DatabaseClient(context.env.DB);
  await client.run(
    customEventDictionaryUpsert(kind, { siteId, sitePk, value, seenAt }),
  );
  const row = await client.first(
    customEventDictionaryIdQuery(kind, sitePk, value),
  );
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
  const visits = scan(schema.visits);
  const persisted = await createD1DatabaseClient(context.env.DB).first(
    compileD1Query(
      limit(
        project(
          filter(
            visits,
            and(
              eq(visits.columns.site_pk, param(sitePk)),
              eq(visits.columns.visit_id, param(visitId)),
            ),
          ),
          { ok: param(1) },
        ),
        1,
      ),
      { tag: "ingest.visits.confirm_persisted" },
    ),
  );
  return persisted !== null;
}
async function hasPersistedCustomEvent(
  context: IngestFlushContext,
  eventId: string,
): Promise<boolean> {
  const events = scan(schema.custom_events);
  const persisted = await createD1DatabaseClient(context.env.DB).first(
    compileD1Query(
      limit(
        project(filter(events, eq(events.columns.event_id, param(eventId))), {
          ok: param(1),
        }),
        1,
      ),
      { tag: "ingest.custom_events.confirm_persisted" },
    ),
  );
  return persisted !== null;
}
function deleteFlushedCustomEventRows(
  context: IngestFlushContext,
  rows: BufferedCustomEventFlushRow[],
): void {
  const cutoffMs = Date.now() - FLUSHED_BUFFER_RETENTION_MS;
  const eligibleRows = rows.filter((row) => row.occurredAt < cutoffMs);
  if (eligibleRows.length === 0) return;
  const conditions = eligibleRows
    .map(() => "(event_id = ? AND buffer_revision = ?)")
    .join(" OR ");
  const bindings = eligibleRows.flatMap((row) => [
    row.eventId,
    bufferRevisionOf(row),
  ]);
  const deleted = context.sqlRun(
    `DELETE FROM buffered_custom_events WHERE ${conditions}`,
    ...bindings,
  );
  void deleted;
  void cutoffMs;
}
