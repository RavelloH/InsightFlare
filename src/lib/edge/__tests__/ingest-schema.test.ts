import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initializeIngestSqlSchema } from "@/lib/edge/ingest-schema";
import type { SqlBinding } from "@/lib/edge/ingest-sql";

const NOW = Date.UTC(2026, 4, 25, 12, 0, 0);
const VISIT_TIMEOUT_MS = 12 * 60 * 60 * 1000;

type SqlRow = Record<string, unknown>;

class SqliteSqlStorage {
  readonly db = new DatabaseSync(":memory:");
  readonly updateCalls: Array<{ query: string; changes: number }> = [];

  exec(
    query: string,
    ...bindings: SqlBinding[]
  ): {
    rowsWritten: number;
    toArray(): unknown[];
  } {
    const statement = this.db.prepare(query);
    const normalized = query.trim().toUpperCase();
    if (
      normalized.startsWith("SELECT") ||
      normalized.startsWith("PRAGMA") ||
      normalized.startsWith("WITH") ||
      normalized.startsWith("EXPLAIN")
    ) {
      return {
        rowsWritten: 0,
        toArray: () =>
          statement.all(...bindings).map((row) => ({ ...row }) as SqlRow),
      };
    }

    const changes = Number(statement.run(...bindings).changes ?? 0);
    if (/^UPDATE\s+buffered_/i.test(query.trim())) {
      this.updateCalls.push({ query, changes });
    }
    return { rowsWritten: changes, toArray: () => [] };
  }

  close(): void {
    this.db.close();
  }
}

function rows<T extends SqlRow = SqlRow>(
  sql: SqliteSqlStorage,
  query: string,
  ...bindings: SqlBinding[]
): T[] {
  return sql.exec(query, ...bindings).toArray() as T[];
}

function createPreSchedulingSchema(sql: SqliteSqlStorage): void {
  sql.db.exec(`
    CREATE TABLE buffered_visits (
      visit_id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      hidden_at INTEGER,
      ended_at INTEGER,
      finalized_at INTEGER,
      duration_ms INTEGER,
      duration_source TEXT,
      exit_reason TEXT,
      pathname TEXT NOT NULL,
      hostname TEXT NOT NULL,
      dirty INTEGER NOT NULL DEFAULT 1,
      flush_attempts INTEGER NOT NULL DEFAULT 0,
      last_flush_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE buffered_custom_events (
      event_id TEXT PRIMARY KEY,
      site_id TEXT NOT NULL,
      visit_id TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      sequence INTEGER NOT NULL DEFAULT 0,
      event_name TEXT NOT NULL,
      event_data_json TEXT NOT NULL DEFAULT '{}',
      user_id TEXT NOT NULL DEFAULT '',
      dirty INTEGER NOT NULL DEFAULT 1,
      flush_attempts INTEGER NOT NULL DEFAULT 0,
      last_flush_error TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  sql.db
    .prepare(
      `INSERT INTO buffered_visits (
        visit_id, site_id, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname,
        dirty, flush_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "dirty-complete",
      "site-1",
      "visitor-1",
      "session-1",
      "complete",
      NOW - 2_000,
      NOW - 1_000,
      "/complete",
      "example.com",
      1,
      0,
      NOW,
      NOW,
    );
  sql.db
    .prepare(
      `INSERT INTO buffered_visits (
        visit_id, site_id, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname,
        dirty, flush_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "clean-open",
      "site-1",
      "visitor-2",
      "session-2",
      "open",
      NOW - 2_000,
      NOW - 1_000,
      "/open",
      "example.com",
      0,
      0,
      NOW,
      NOW,
    );
  sql.db
    .prepare(
      `INSERT INTO buffered_visits (
        visit_id, site_id, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname,
        dirty, flush_attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "clean-complete",
      "site-1",
      "visitor-3",
      "session-3",
      "complete",
      NOW - 2_000,
      NOW - 1_000,
      "/complete-clean",
      "example.com",
      0,
      0,
      NOW,
      NOW,
    );

  sql.db
    .prepare(
      `INSERT INTO buffered_custom_events (
        event_id, site_id, visit_id, occurred_at, received_at, sequence,
        event_name, dirty, flush_attempts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "dirty-event",
      "site-1",
      "dirty-complete",
      NOW - 1_000,
      NOW,
      0,
      "Dirty",
      1,
      0,
      NOW,
    );
  sql.db
    .prepare(
      `INSERT INTO buffered_custom_events (
        event_id, site_id, visit_id, occurred_at, received_at, sequence,
        event_name, dirty, flush_attempts, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "clean-event",
      "site-1",
      "clean-complete",
      NOW - 1_000,
      NOW,
      0,
      "Clean",
      0,
      0,
      NOW,
    );
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("initializeIngestSqlSchema", () => {
  it("backfills pre-scheduling rows and does not rewrite terminal NULL due rows", () => {
    const sql = new SqliteSqlStorage();
    createPreSchedulingSchema(sql);

    initializeIngestSqlSchema(sql);

    expect(
      rows<{
        visitId: string;
        flushDueAt: number | null;
        nextDueAt: number | null;
      }>(
        sql,
        `
          SELECT
            visit_id AS visitId,
            flush_due_at AS flushDueAt,
            next_due_at AS nextDueAt
          FROM buffered_visits
          ORDER BY visit_id
        `,
      ),
    ).toEqual([
      {
        visitId: "clean-complete",
        flushDueAt: null,
        nextDueAt: null,
      },
      {
        visitId: "clean-open",
        flushDueAt: null,
        nextDueAt: NOW - 1_000 + VISIT_TIMEOUT_MS,
      },
      {
        visitId: "dirty-complete",
        flushDueAt: NOW,
        nextDueAt: NOW,
      },
    ]);
    expect(
      rows<{
        eventId: string;
        flushDueAt: number | null;
        nextDueAt: number | null;
      }>(
        sql,
        `
          SELECT
            event_id AS eventId,
            flush_due_at AS flushDueAt,
            next_due_at AS nextDueAt
          FROM buffered_custom_events
          ORDER BY event_id
        `,
      ),
    ).toEqual([
      { eventId: "clean-event", flushDueAt: null, nextDueAt: null },
      { eventId: "dirty-event", flushDueAt: NOW, nextDueAt: NOW },
    ]);

    const firstMigrationWrites = sql.updateCalls.map((call) => call.changes);
    expect(firstMigrationWrites).toEqual([2, 1]);

    // Simulate an incorrectly ordered index with the same column count.
    // Initialization must compare the full shape before repairing it.
    sql.db.exec(`
      DROP INDEX idx_buffered_visits_dirty_flush_due;
      CREATE INDEX idx_buffered_visits_dirty_flush_due
        ON buffered_visits(dirty, flush_attempts, flush_due_at);
    `);
    sql.updateCalls.length = 0;
    initializeIngestSqlSchema(sql);

    expect(sql.updateCalls.map((call) => call.changes)).toEqual([0, 0]);
    expect(
      rows<{ name: string; seqno: number }>(
        sql,
        "PRAGMA index_info(idx_buffered_visits_dirty_flush_due)",
      )
        .sort((left, right) => left.seqno - right.seqno)
        .map((row) => row.name),
    ).toEqual(["dirty", "flush_due_at", "flush_attempts"]);
    sql.close();
  });

  it("preserves legacy custom event rows while adding current columns", () => {
    const sql = new SqliteSqlStorage();
    sql.db.exec(`
      CREATE TABLE buffered_custom_events (
        event_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        visit_id TEXT NOT NULL,
        visitor_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pathname TEXT NOT NULL,
        hostname TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        event_data_json TEXT NOT NULL DEFAULT '{}',
        dirty INTEGER NOT NULL DEFAULT 1,
        flush_attempts INTEGER NOT NULL DEFAULT 0,
        last_flush_error TEXT,
        created_at INTEGER NOT NULL
      );
      INSERT INTO buffered_custom_events (
        event_id, site_id, visit_id, visitor_id, session_id,
        pathname, hostname, occurred_at, event_name, event_data_json,
        dirty, flush_attempts, created_at
      ) VALUES (
        'legacy-event', 'site-1', 'visit-1', 'visitor-1', 'session-1',
        '/legacy', 'example.com', ${NOW - 1_000}, 'Legacy', '{"ok":true}',
        1, 0, ${NOW}
      );
    `);

    initializeIngestSqlSchema(sql);

    expect(
      rows<{
        count: number;
        eventName: string;
        eventDataJson: string;
        receivedAt: number;
        sequence: number;
        nextDueAt: number | null;
      }>(
        sql,
        `
          SELECT
            COUNT(*) OVER () AS count,
            event_name AS eventName,
            event_data_json AS eventDataJson,
            received_at AS receivedAt,
            sequence,
            next_due_at AS nextDueAt
          FROM buffered_custom_events
          WHERE event_id = 'legacy-event'
        `,
      ),
    ).toEqual([
      {
        count: 1,
        eventName: "Legacy",
        eventDataJson: '{"ok":true}',
        receivedAt: NOW - 1_000,
        sequence: 0,
        nextDueAt: NOW,
      },
    ]);
    expect(
      rows<{ name: string }>(
        sql,
        "PRAGMA table_info(buffered_custom_events)",
      ).map((column) => column.name),
    ).toEqual(
      expect.arrayContaining([
        "visitor_id",
        "session_id",
        "pathname",
        "hostname",
        "received_at",
        "sequence",
        "next_due_at",
        "flush_due_at",
        "buffer_revision",
      ]),
    );
    sql.close();
  });
});
