import { HIDDEN_LEAVE_GRACE_MS, VISIT_TIMEOUT_MS } from "./ingest-constants";
import type { SqlBinding } from "./ingest-sql";
import { CREATE_BUFFERED_CUSTOM_EVENTS_SQL } from "./ingest-sql";

interface DurableObjectSqlStorage {
  exec(
    query: string,
    ...bindings: SqlBinding[]
  ): {
    toArray(): unknown[];
  };
}

interface TableColumnInfo {
  name?: string;
  notnull?: number;
  dflt_value?: unknown;
}

interface IndexColumnInfo {
  name?: string;
  seqno?: number;
}

function tableColumns(
  sql: DurableObjectSqlStorage,
  tableName: string,
): TableColumnInfo[] {
  return sql
    .exec(`PRAGMA table_info(${tableName})`)
    .toArray() as TableColumnInfo[];
}

function tableColumnNames(
  sql: DurableObjectSqlStorage,
  tableName: string,
): Set<string> {
  return new Set(tableColumns(sql, tableName).map((row) => row.name ?? ""));
}

function indexColumnNames(
  sql: DurableObjectSqlStorage,
  indexName: string,
): string[] {
  return (
    sql.exec(`PRAGMA index_info(${indexName})`).toArray() as IndexColumnInfo[]
  )
    .sort((left, right) => (left.seqno ?? 0) - (right.seqno ?? 0))
    .map((row) => row.name ?? "");
}

function ensureIndexColumns(
  sql: DurableObjectSqlStorage,
  indexName: string,
  expectedColumns: readonly string[],
): void {
  const existingColumns = indexColumnNames(sql, indexName);
  if (
    existingColumns.length === expectedColumns.length &&
    existingColumns.every(
      (columnName, index) => columnName === expectedColumns[index],
    )
  ) {
    return;
  }

  // CREATE INDEX IF NOT EXISTS does not update an already deployed index.
  // Drop only when its shape is different so this remains a one-time migration
  // instead of rebuilding the index on every DO construction.
  sql.exec(`DROP INDEX IF EXISTS ${indexName}`);
}

function ensureColumn(
  sql: DurableObjectSqlStorage,
  tableName: string,
  columnName: string,
  columnType: string,
): void {
  if (tableColumnNames(sql, tableName).has(columnName)) return;
  sql.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
}

const LEGACY_EVENT_CONTEXT_COLUMNS = [
  "visitor_id",
  "session_id",
  "pathname",
  "hostname",
] as const;

function hasIncompatibleLegacyEventContext(
  sql: DurableObjectSqlStorage,
): boolean {
  const columns = tableColumns(sql, "buffered_custom_events");
  return LEGACY_EVENT_CONTEXT_COLUMNS.some((columnName) => {
    const column = columns.find((candidate) => candidate.name === columnName);
    return column?.notnull === 1 && column.dflt_value === null;
  });
}

function migrateLegacyBufferedCustomEvents(sql: DurableObjectSqlStorage): void {
  const columnNames = tableColumnNames(sql, "buffered_custom_events");
  const value = (columnName: string, fallback: string): string =>
    columnNames.has(columnName) ? columnName : fallback;
  const coalesce = (columnName: string, fallback: string): string =>
    columnNames.has(columnName)
      ? `COALESCE(${columnName}, ${fallback})`
      : fallback;

  sql.exec("BEGIN");
  try {
    sql.exec(`
        CREATE TABLE buffered_custom_events_migration (
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
          next_due_at INTEGER,
          flush_due_at INTEGER,
          buffer_revision INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          visitor_id TEXT,
          session_id TEXT,
          pathname TEXT,
          hostname TEXT
        )
      `);
    sql.exec(`
        INSERT INTO buffered_custom_events_migration (
          event_id, site_id, visit_id, occurred_at, received_at, sequence,
          event_name, event_data_json, user_id, dirty, flush_attempts,
          last_flush_error, next_due_at, flush_due_at, buffer_revision,
          created_at, visitor_id, session_id, pathname, hostname
        )
        SELECT
          event_id,
          site_id,
          visit_id,
          occurred_at,
          ${coalesce("received_at", "occurred_at")},
          ${coalesce("sequence", "0")},
          event_name,
          event_data_json,
          ${coalesce("user_id", "''")},
          dirty,
          flush_attempts,
          last_flush_error,
          ${value("next_due_at", "NULL")},
          ${value("flush_due_at", "NULL")},
          ${coalesce("buffer_revision", "1")},
          created_at,
          ${value("visitor_id", "NULL")},
          ${value("session_id", "NULL")},
          ${value("pathname", "NULL")},
          ${value("hostname", "NULL")}
        FROM buffered_custom_events
      `);
    sql.exec(
      "ALTER TABLE buffered_custom_events RENAME TO buffered_custom_events_legacy",
    );
    sql.exec("DROP INDEX IF EXISTS idx_buffered_custom_events_next_due");
    sql.exec("DROP INDEX IF EXISTS idx_buffered_custom_events_dirty_flush_due");
    sql.exec("DROP INDEX IF EXISTS idx_buffered_custom_events_dirty_occurred");
    sql.exec("DROP INDEX IF EXISTS idx_buffered_custom_events_occurred");
    sql.exec("DROP TABLE buffered_custom_events_legacy");
    sql.exec(
      "ALTER TABLE buffered_custom_events_migration RENAME TO buffered_custom_events",
    );
    sql.exec("COMMIT");
  } catch (error) {
    try {
      sql.exec("ROLLBACK");
    } catch {
      // Preserve the migration error if rollback is unavailable.
    }
    throw error;
  }
}

export function initializeIngestSqlSchema(sql: DurableObjectSqlStorage): void {
  const now = Date.now();
  sql.exec(`
      CREATE TABLE IF NOT EXISTS buffered_visits (
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
        query_string TEXT NOT NULL DEFAULT '',
        hash_fragment TEXT NOT NULL DEFAULT '',
        hostname TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        referrer_url TEXT NOT NULL DEFAULT '',
        referrer_host TEXT NOT NULL DEFAULT '',
        utm_source TEXT NOT NULL DEFAULT '',
        utm_medium TEXT NOT NULL DEFAULT '',
        utm_campaign TEXT NOT NULL DEFAULT '',
        utm_term TEXT NOT NULL DEFAULT '',
        utm_content TEXT NOT NULL DEFAULT '',
        is_eu INTEGER NOT NULL DEFAULT 0,
        country TEXT NOT NULL DEFAULT '',
        region TEXT NOT NULL DEFAULT '',
        region_code TEXT NOT NULL DEFAULT '',
        city TEXT NOT NULL DEFAULT '',
        continent TEXT NOT NULL DEFAULT '',
        latitude REAL,
        longitude REAL,
        postal_code TEXT NOT NULL DEFAULT '',
        metro_code TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT '',
        as_organization TEXT NOT NULL DEFAULT '',
        ua_raw TEXT NOT NULL DEFAULT '',
        browser TEXT NOT NULL DEFAULT '',
        browser_version TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        os_version TEXT NOT NULL DEFAULT '',
        device_type TEXT NOT NULL DEFAULT '',
        screen_width INTEGER,
        screen_height INTEGER,
        language TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        user_name TEXT NOT NULL DEFAULT '',
        perf_ttfb_ms REAL,
        perf_fcp_ms REAL,
        perf_lcp_ms REAL,
        perf_cls REAL,
        perf_inp_ms REAL,
        dirty INTEGER NOT NULL DEFAULT 1,
        flush_attempts INTEGER NOT NULL DEFAULT 0,
        last_flush_error TEXT,
        next_due_at INTEGER,
        flush_due_at INTEGER,
        buffer_revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  ensureColumn(sql, "buffered_visits", "perf_ttfb_ms", "REAL");
  ensureColumn(sql, "buffered_visits", "perf_fcp_ms", "REAL");
  ensureColumn(sql, "buffered_visits", "perf_lcp_ms", "REAL");
  ensureColumn(sql, "buffered_visits", "perf_cls", "REAL");
  ensureColumn(sql, "buffered_visits", "perf_inp_ms", "REAL");
  ensureColumn(sql, "buffered_visits", "user_id", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(sql, "buffered_visits", "user_name", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(sql, "buffered_visits", "hidden_at", "INTEGER");
  ensureColumn(sql, "buffered_visits", "next_due_at", "INTEGER");
  ensureColumn(sql, "buffered_visits", "flush_due_at", "INTEGER");
  ensureColumn(
    sql,
    "buffered_visits",
    "buffer_revision",
    "INTEGER NOT NULL DEFAULT 1",
  );
  // Rows created before due-time scheduling have NULL due columns.  Make
  // legacy dirty rows immediately eligible and restore lifecycle deadlines
  // for clean open/hidden visits without touching already-scheduled rows.
  sql.exec(`
      UPDATE buffered_visits
      SET
        flush_due_at = CASE
          WHEN dirty = 1 AND flush_due_at IS NULL THEN ${now}
          ELSE flush_due_at
        END,
        next_due_at = CASE
          WHEN dirty = 1 AND flush_due_at IS NULL THEN ${now}
          WHEN flush_due_at IS NULL THEN
            CASE
              WHEN status = 'open' THEN last_activity_at + ${VISIT_TIMEOUT_MS}
              WHEN status = 'hidden_pending' THEN
                COALESCE(hidden_at, last_activity_at, 0) +
                CASE
                  WHEN hidden_at IS NULL THEN ${VISIT_TIMEOUT_MS}
                  ELSE ${HIDDEN_LEAVE_GRACE_MS}
                END
              ELSE NULL
            END
          WHEN status = 'open' THEN
            CASE
              WHEN flush_due_at <= last_activity_at + ${VISIT_TIMEOUT_MS}
                THEN flush_due_at
              ELSE last_activity_at + ${VISIT_TIMEOUT_MS}
            END
          WHEN status = 'hidden_pending' THEN
            CASE
              WHEN flush_due_at <= COALESCE(hidden_at, last_activity_at, 0) +
                CASE
                  WHEN hidden_at IS NULL THEN ${VISIT_TIMEOUT_MS}
                  ELSE ${HIDDEN_LEAVE_GRACE_MS}
                END
                THEN flush_due_at
              ELSE COALESCE(hidden_at, last_activity_at, 0) +
                CASE
                  WHEN hidden_at IS NULL THEN ${VISIT_TIMEOUT_MS}
                  ELSE ${HIDDEN_LEAVE_GRACE_MS}
                END
            END
          ELSE flush_due_at
        END
      WHERE next_due_at IS NULL
        AND (
          dirty = 1
          OR flush_due_at IS NOT NULL
          OR status IN ('open', 'hidden_pending')
        )
    `);

  // These indexes were useful for broad historical scans, but they are not
  // part of the hot ingest/flush paths.  In a Durable Object every UPDATE of
  // an indexed row also has to maintain the index, so keeping them materially
  // amplifies lifecycle writes.  The remaining indexes cover Alarm selection,
  // due-row flushing, hidden/timeout status scans, and session/visitor lookup.
  for (const indexName of [
    "idx_buffered_visits_dirty_updated",
    "idx_buffered_visits_status_last_activity",
    "idx_buffered_visits_site_visit_status",
    "idx_buffered_visits_started_at",
    "idx_buffered_visits_ended_at",
  ]) {
    sql.exec(`DROP INDEX IF EXISTS ${indexName}`);
  }
  ensureIndexColumns(sql, "idx_buffered_visits_dirty_flush_due", [
    "dirty",
    "flush_due_at",
    "flush_attempts",
  ]);
  sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_buffered_visits_next_due
      ON buffered_visits(next_due_at, visit_id)
    `);
  sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_buffered_visits_dirty_flush_due
      ON buffered_visits(dirty, flush_due_at, flush_attempts)
    `);
  sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_buffered_visits_status_hidden_at
      ON buffered_visits(status, hidden_at)
    `);
  sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_buffered_visits_site_session_status_started
      ON buffered_visits(site_id, session_id, status, started_at)
    `);
  sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_buffered_visits_site_visitor_status
      ON buffered_visits(site_id, visitor_id, status)
    `);
  sql.exec(CREATE_BUFFERED_CUSTOM_EVENTS_SQL);

  // Keep legacy event rows in place.  A legacy context column without a
  // default would reject current inserts, so rebuild that shape atomically;
  // all rows and legacy context values are copied before the old table goes
  // away.  Other old shapes can be migrated additively.
  if (hasIncompatibleLegacyEventContext(sql)) {
    migrateLegacyBufferedCustomEvents(sql);
  }
  const eventColumnNames = tableColumnNames(sql, "buffered_custom_events");
  if (!eventColumnNames.has("received_at")) {
    ensureColumn(
      sql,
      "buffered_custom_events",
      "received_at",
      "INTEGER NOT NULL DEFAULT 0",
    );
    sql.exec(`
        UPDATE buffered_custom_events
        SET received_at = occurred_at
        WHERE received_at = 0 AND occurred_at <> 0
      `);
  }
  ensureColumn(
    sql,
    "buffered_custom_events",
    "sequence",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    sql,
    "buffered_custom_events",
    "user_id",
    "TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(sql, "buffered_custom_events", "next_due_at", "INTEGER");
  ensureColumn(sql, "buffered_custom_events", "flush_due_at", "INTEGER");
  ensureColumn(
    sql,
    "buffered_custom_events",
    "buffer_revision",
    "INTEGER NOT NULL DEFAULT 1",
  );
  sql.exec(`
      UPDATE buffered_custom_events
      SET
        flush_due_at = CASE
          WHEN dirty = 1 AND flush_due_at IS NULL THEN ${now}
          ELSE flush_due_at
        END,
        next_due_at = CASE
          WHEN dirty = 1 AND flush_due_at IS NULL THEN ${now}
          WHEN dirty = 1 THEN flush_due_at
          ELSE NULL
        END
      WHERE next_due_at IS NULL AND dirty = 1
    `);
  sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_buffered_custom_events_next_due
      ON buffered_custom_events(next_due_at, event_id)
    `);
  sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_buffered_custom_events_dirty_flush_due
      ON buffered_custom_events(dirty, flush_due_at, created_at, flush_attempts)
    `);
  sql.exec("DROP INDEX IF EXISTS idx_buffered_custom_events_dirty_occurred");
  sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_buffered_custom_events_occurred
      ON buffered_custom_events(occurred_at)
    `);
}
