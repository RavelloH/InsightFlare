import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  assertD1StatementBudget,
  compileD1Mutation,
  insert,
  schema,
} from "@/lib/db";
import type { CompiledMutation } from "@/lib/db/mutation/plan";
import {
  expandCustomEventDataJson,
  type ExpandedCustomEventData,
} from "@/lib/edge/ingest/custom-event-json";
import {
  type CustomEventDictionaryIds,
  prepareCustomEventMutations,
} from "@/lib/edge/ingest/custom-event-write-mutations";
import type { BufferedCustomEventRow } from "@/lib/edge/ingest/types";

const INITIAL_DATA = JSON.stringify({
  plan: "Pro🚀",
  count: 3,
  active: true,
  nil: null,
  child: { flag: false },
});
const DUPLICATE_DATA = JSON.stringify({
  plan: "Pro🚀",
  count: 3,
  active: true,
  nil: null,
  child: { flag: false },
  fresh: "delta",
});

function expandedData(json: string): ExpandedCustomEventData {
  const expanded = expandCustomEventDataJson(json);
  if (!expanded.ok) throw new Error(expanded.error);
  return expanded.data;
}

function bufferedEvent(
  overrides: Partial<BufferedCustomEventRow> = {},
): BufferedCustomEventRow {
  return {
    eventId: `event-${"访客🙂".repeat(40)}`,
    siteId: "site-1",
    visitId: "visit-1",
    occurredAt: 1234,
    receivedAt: 1250,
    sequence: 7,
    eventName: "Signup",
    eventDataJson: INITIAL_DATA,
    userId: `用户🙂${"访客🙂".repeat(40)}`,
    dirty: 1,
    flushAttempts: 0,
    lastFlushError: null,
    nextDueAt: null,
    flushDueAt: null,
    bufferRevision: 1,
    createdAt: 100,
    ...overrides,
  };
}

function execute(
  db: DatabaseSync,
  statement: { sql: string; bindings?: readonly unknown[] },
) {
  return db
    .prepare(statement.sql)
    .run(...((statement.bindings ?? []) as SQLInputValue[]));
}

function executeBatch(
  db: DatabaseSync,
  statements: readonly { sql: string; bindings?: readonly unknown[] }[],
): number[] {
  db.exec("BEGIN");
  try {
    const changes = statements.map((statement) =>
      Number(execute(db, statement).changes),
    );
    db.exec("COMMIT");
    return changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function setupDatabase(): { db: DatabaseSync; sitePk: number } {
  const db = createMigratedDatabase();
  execute(
    db,
    compileD1Mutation(insert(schema.site_identities, { site_id: "site-1" })),
  );
  const sitePk = Number(
    (
      db
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get("site-1") as {
        site_pk: number;
      }
    ).site_pk,
  );
  db.prepare(
    `INSERT INTO visits (
      visit_id, site_id, visitor_id, session_id, status, started_at,
      last_activity_at, pathname, hostname, site_pk
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "visit-1",
    "site-1",
    "visitor-1",
    "session-1",
    "open",
    1,
    2,
    "/",
    "example.test",
    sitePk,
  );
  return { db, sitePk };
}

function registerDictionaries(
  db: DatabaseSync,
  sitePk: number,
  expanded: ExpandedCustomEventData,
): CustomEventDictionaryIds {
  const eventNameId = 10;
  db.prepare(
    "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
  ).run(eventNameId, "site-1", "Signup", 100, sitePk);

  const keyIds = new Map(
    expanded.keys.map((key, index) => [key, 20 + index] as const),
  );
  for (const [key, id] of keyIds) {
    db.prepare(
      'INSERT INTO custom_event_json_keys (id, site_id, "key", last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)',
    ).run(id, "site-1", key, 100, sitePk);
  }

  const pathIds = new Map(
    expanded.paths.map((path, index) => [path, 30 + index] as const),
  );
  for (const [path, id] of pathIds) {
    db.prepare(
      "INSERT INTO custom_event_json_paths (id, site_id, path, last_seen_at, site_pk) VALUES (?, ?, ?, ?, ?)",
    ).run(id, "site-1", path, 100, sitePk);
  }

  return { eventNameId, keyIds, pathIds };
}

function legacyCustomEventStatements(
  row: BufferedCustomEventRow,
  expanded: ExpandedCustomEventData,
  ids: CustomEventDictionaryIds,
  sitePk: number,
) {
  const event = {
    sql: `INSERT OR IGNORE INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count, user_id, ae_synced_at,
      created_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ? FROM visits
    WHERE site_pk = ? AND visit_id = ? LIMIT 1`,
    bindings: [
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
    ],
  };
  const nodes = expanded.nodes.map((node) => {
    const pathId = ids.pathIds.get(node.path);
    if (pathId === undefined) throw new Error(`Missing path ${node.path}`);
    const keyId = node.key === null ? null : ids.keyIds.get(node.key);
    if (node.key !== null && keyId === undefined)
      throw new Error(`Missing key ${node.key}`);
    return {
      sql: `INSERT OR IGNORE INTO custom_event_json_nodes (
        event_pk, node_id, parent_node_id, key_id, path_id, value_type,
        member_order, array_index, depth
      ) SELECT event_pk, ?, ?, ?, ?, ?, ?, ?, ? FROM custom_events
      WHERE event_id = ?`,
      bindings: [
        node.nodeId,
        node.parentNodeId,
        keyId ?? null,
        pathId,
        node.valueType,
        node.memberOrder,
        node.arrayIndex,
        node.depth,
        row.eventId,
      ],
    };
  });
  const values = expanded.values.map((value) => {
    const pathId = ids.pathIds.get(value.path);
    if (pathId === undefined) throw new Error(`Missing path ${value.path}`);
    return {
      sql: `INSERT OR IGNORE INTO custom_event_json_values (
        event_pk, node_id, site_id, site_pk, event_name_id, path_id,
        occurred_at, scope_node_id, value_type, string_value, string_hash,
        number_value, boolean_value
      ) SELECT event_pk, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM custom_events WHERE event_id = ?`,
      bindings: [
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
      ],
    };
  });
  return [event, ...nodes, ...values];
}

function persistedSnapshot(db: DatabaseSync) {
  return {
    events: db.prepare("SELECT * FROM custom_events ORDER BY event_id").all(),
    nodes: db
      .prepare(
        "SELECT * FROM custom_event_json_nodes ORDER BY event_pk, node_id",
      )
      .all(),
    values: db
      .prepare(
        "SELECT * FROM custom_event_json_values ORDER BY event_pk, node_id",
      )
      .all(),
  };
}

describe("typed custom event write mutations", () => {
  it("matches ordered legacy event, node and value writes and remains retry-idempotent", () => {
    const typed = setupDatabase();
    const legacy = setupDatabase();
    const initialExpanded = expandedData(INITIAL_DATA);
    const duplicateExpanded = expandedData(DUPLICATE_DATA);
    try {
      const ids = registerDictionaries(
        typed.db,
        typed.sitePk,
        duplicateExpanded,
      );
      registerDictionaries(legacy.db, legacy.sitePk, duplicateExpanded);

      const row = bufferedEvent();
      const typedBatch = prepareCustomEventMutations(
        row,
        initialExpanded,
        ids,
        typed.sitePk,
      );
      const legacyBatch = legacyCustomEventStatements(
        row,
        initialExpanded,
        ids,
        legacy.sitePk,
      );
      expect(typedBatch.map(({ tag }) => tag)).toEqual([
        "ingest.custom_events.insert",
        ...initialExpanded.nodes.map(
          () => "ingest.custom_event_json_nodes.insert",
        ),
        ...initialExpanded.values.map(
          () => "ingest.custom_event_json_values.insert",
        ),
      ]);
      expect(typedBatch).toHaveLength(
        1 + initialExpanded.nodes.length + initialExpanded.values.length,
      );
      for (const statement of typedBatch) {
        assertD1StatementBudget(statement);
        expect(statement.bindings?.length ?? 0).toBeLessThanOrEqual(100);
      }
      expect(typedBatch[0]!.sql).not.toContain(row.eventId);
      expect(typedBatch[0]!.bindings).toContain(row.eventId);
      expect(typedBatch[0]!.sql).not.toContain(row.userId);
      expect(typedBatch[0]!.bindings).toContain(row.userId);

      const typedChanges = executeBatch(typed.db, typedBatch);
      const legacyChanges = executeBatch(legacy.db, legacyBatch);
      expect(typedChanges).toEqual(legacyChanges);
      expect(persistedSnapshot(typed.db)).toEqual(persistedSnapshot(legacy.db));

      const repeatedTypedChanges = executeBatch(typed.db, typedBatch);
      const repeatedLegacyChanges = executeBatch(legacy.db, legacyBatch);
      expect(repeatedTypedChanges).toEqual(repeatedLegacyChanges);
      expect(repeatedTypedChanges.every((changes) => changes === 0)).toBe(true);

      const duplicateRow = bufferedEvent({ eventDataJson: DUPLICATE_DATA });
      const duplicateTyped = prepareCustomEventMutations(
        duplicateRow,
        duplicateExpanded,
        ids,
        typed.sitePk,
      );
      const duplicateLegacy = legacyCustomEventStatements(
        duplicateRow,
        duplicateExpanded,
        ids,
        legacy.sitePk,
      );
      expect(duplicateTyped).toHaveLength(
        1 + duplicateExpanded.nodes.length + duplicateExpanded.values.length,
      );
      executeBatch(typed.db, duplicateTyped);
      executeBatch(legacy.db, duplicateLegacy);
      expect(persistedSnapshot(typed.db)).toEqual(persistedSnapshot(legacy.db));
      expect(
        typed.db
          .prepare(
            "SELECT COUNT(*) AS count FROM custom_event_json_values WHERE string_value = ?",
          )
          .get("delta"),
      ).toEqual({ count: 1 });

      const missingParent = prepareCustomEventMutations(
        bufferedEvent({ eventId: "missing-parent", visitId: "no-visit" }),
        initialExpanded,
        ids,
        typed.sitePk,
      );
      expect(executeBatch(typed.db, missingParent).every((n) => n === 0)).toBe(
        true,
      );
      const wrongSite = prepareCustomEventMutations(
        bufferedEvent({ eventId: "wrong-site" }),
        initialExpanded,
        ids,
        typed.sitePk + 1,
      );
      expect(executeBatch(typed.db, wrongSite).every((n) => n === 0)).toBe(
        true,
      );

      expect(() =>
        prepareCustomEventMutations(
          row,
          initialExpanded,
          { ...ids, pathIds: new Map() },
          typed.sitePk,
        ),
      ).toThrow(/Missing custom event path id/u);
    } finally {
      typed.db.close();
      legacy.db.close();
    }
  });

  it("keeps parent and event-id source lookups on their indexes", () => {
    const { db, sitePk } = setupDatabase();
    const expanded = expandedData(INITIAL_DATA);
    try {
      const ids = registerDictionaries(db, sitePk, expanded);
      const statements = prepareCustomEventMutations(
        bufferedEvent(),
        expanded,
        ids,
        sitePk,
      );
      const plans = [statements[0]!, statements[1]!].map((statement) =>
        db
          .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
          .all(...(statement.bindings as SQLInputValue[]))
          .map((row) => String((row as { detail: string }).detail)),
      );
      expect(plans[0]!.join("\n")).toMatch(
        /SEARCH t0 USING INDEX sqlite_autoindex_visits_1 \(visit_id=\?\)/u,
      );
      expect(plans[1]!.join("\n")).toMatch(/event_id=\?/u);
    } finally {
      db.close();
    }
  });
});
