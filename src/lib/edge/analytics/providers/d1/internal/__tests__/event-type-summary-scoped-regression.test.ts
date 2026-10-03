import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import {
  decodeEventTypeCursor,
  type EventTypeAggregateCursor,
  queryEventSummaryMetricsFromD1,
  queryEventTypeAggregate,
  queryEventTypePageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type FilterDocument,
  type FilterExpression,
  type FilterFieldId,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const SITE_ID = "wave38-event-types";
const WINDOW = {
  startMs: 120,
  endExclusiveMs: 130,
  nowMs: 500,
  timeZone: "UTC",
} as const;
const QUERY_TIME = createQueryTime(120, 130, "UTC", 500);
const SCOPED_PATH = "/scoped";

interface FrozenEventTypeRow {
  readonly value: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}

interface FrozenSummary {
  readonly events: number;
  readonly eventTypes: number;
  readonly sessions: number;
  readonly visitors: number;
}

interface FrozenQueryOptions {
  readonly kind: "list" | "page";
  readonly limit: number;
  readonly search?: string;
  readonly cursor?: EventTypeAggregateCursor | null;
  readonly pathname?: string;
}

const databases = new Set<DatabaseSync>();
const executionEvidence: Array<{
  readonly label: string;
  readonly sqlUtf8Bytes: number;
  readonly bindingCount: number;
  readonly statementCount: number;
  readonly normalizedSqlSha256: string;
  readonly shape: string;
  readonly bindingTail: readonly (number | string | null)[];
  readonly explain: readonly string[];
}> = [];

function newTrace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "wave38-event-type-cursor-test-secret",
  } as unknown as Env;
}

function recordExecutionEvidence(label: string, trace: SqliteD1Trace): void {
  const sql = trace.preparedSql.at(-1);
  const bindings = trace.bindings.at(-1);
  if (sql === undefined || bindings === undefined)
    throw new Error(`wave38_missing_sql_trace:${label}`);
  const normalizedSql = sql.replace(/\s+/gu, " ").trim();
  const explain = explainQueryPlan(database, { sql, bindings });
  const indexedSearches = explain.filter(
    (line) =>
      /\bSEARCH\b/u.test(line) &&
      /USING (?:COVERING )?(?:INDEX|INTEGER PRIMARY KEY|AUTOMATIC)/u.test(line),
  );
  // SQLite's access path is the available local check; it does not provide
  // Cloudflare D1 rowsRead evidence.
  expect(trace.preparedSql, label).toHaveLength(1);
  expect(indexedSearches, label).not.toHaveLength(0);
  executionEvidence.push({
    label,
    sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
    bindingCount: bindings.length,
    statementCount: trace.preparedSql.length,
    normalizedSqlSha256: createHash("sha256")
      .update(normalizedSql, "utf8")
      .digest("hex"),
    shape: normalizedSql.slice(0, 200),
    bindingTail: bindings
      .slice(-9)
      .map((value) =>
        value === null || typeof value === "number" ? value : String(value),
      ),
    explain,
  });
}

function addSite(database: DatabaseSync): number {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  return Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
}

function addName(
  database: DatabaseSync,
  sitePk: number,
  id: number,
  name: string | null,
): void {
  database
    .prepare(
      `INSERT INTO custom_event_names
       (id, site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, ?, 1, ?)`,
    )
    .run(id, SITE_ID, name, sitePk);
}

function addVisit(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly visitorId: string;
    readonly pathname?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', 125, 125, ?, 'wave38.test')`,
    )
    .run(
      input.id,
      SITE_ID,
      sitePk,
      input.visitorId,
      input.sessionId,
      input.pathname ?? "/ordinary",
    );
}

function addEvent(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly id: string;
    readonly visitId: string;
    readonly nameId: number;
    readonly occurredAt?: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, 777, 1, 1, 1)`,
    )
    .run(
      input.id,
      SITE_ID,
      sitePk,
      input.visitId,
      input.nameId,
      input.occurredAt ?? 125,
    );
}

function addObservation(
  database: DatabaseSync,
  sitePk: number,
  input: {
    readonly id: string;
    readonly nameId: number;
    readonly sessionId: string;
    readonly visitorId: string;
    readonly pathname?: string;
  },
): void {
  const visitId = `visit-${input.id}`;
  addVisit(database, sitePk, {
    id: visitId,
    sessionId: input.sessionId,
    visitorId: input.visitorId,
    pathname: input.pathname,
  });
  addEvent(database, sitePk, {
    id: `event-${input.id}`,
    visitId,
    nameId: input.nameId,
  });
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  // The deployed schema marks name NOT NULL. Rebuild this fixture-only table
  // without that constraint so the legacy COALESCE and raw DISTINCT behavior
  // can be exercised for a joined row whose name is NULL.
  database.exec(`
    ALTER TABLE custom_event_names RENAME TO custom_event_names_not_null;
    CREATE TABLE custom_event_names (
      id INTEGER PRIMARY KEY,
      site_id TEXT NOT NULL,
      name TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen_at INTEGER NOT NULL,
      site_pk INTEGER NOT NULL REFERENCES site_identities(site_pk),
      UNIQUE(site_pk, name)
    );
    DROP TABLE custom_event_names_not_null;
  `);
  const sitePk = addSite(database);
  addName(database, sitePk, 1, "alpha");
  addName(database, sitePk, 2, "beta");
  addName(database, sitePk, 3, "Needle %_\\ suffix");
  addName(database, sitePk, 4, "needle%_other");
  addName(database, sitePk, 5, "   ");
  addName(database, sitePk, 6, "");
  addName(database, sitePk, 7, null);

  addObservation(database, sitePk, {
    id: "alpha-1",
    nameId: 1,
    sessionId: "session-alpha",
    visitorId: "visitor-alpha-1",
    pathname: SCOPED_PATH,
  });
  addObservation(database, sitePk, {
    id: "alpha-2",
    nameId: 1,
    sessionId: "session-alpha",
    visitorId: "",
  });
  addObservation(database, sitePk, {
    id: "alpha-3",
    nameId: 1,
    sessionId: "",
    visitorId: "visitor-alpha-2",
  });
  addObservation(database, sitePk, {
    id: "beta-1",
    nameId: 2,
    sessionId: "session-beta-1",
    visitorId: "visitor-beta",
  });
  addObservation(database, sitePk, {
    id: "beta-2",
    nameId: 2,
    sessionId: "session-beta-2",
    visitorId: "visitor-beta",
  });
  addObservation(database, sitePk, {
    id: "needle-literal-1",
    nameId: 3,
    sessionId: "",
    visitorId: "",
    pathname: SCOPED_PATH,
  });
  addObservation(database, sitePk, {
    id: "needle-literal-2",
    nameId: 3,
    sessionId: "",
    visitorId: "",
  });
  addObservation(database, sitePk, {
    id: "needle-wildcard",
    nameId: 4,
    sessionId: "session-needle",
    visitorId: "visitor-needle",
  });
  addObservation(database, sitePk, {
    id: "space-name",
    nameId: 5,
    sessionId: "session-space",
    visitorId: "visitor-space",
  });
  addObservation(database, sitePk, {
    id: "empty-name",
    nameId: 6,
    sessionId: "session-empty",
    visitorId: "visitor-empty",
  });
  // A joined NULL name models legacy COALESCE(list) and raw DISTINCT(summary).
  addObservation(database, sitePk, {
    id: "null-name-1",
    nameId: 7,
    sessionId: "",
    visitorId: "",
  });
  addObservation(database, sitePk, {
    id: "null-name-2",
    nameId: 7,
    sessionId: "",
    visitorId: "",
  });

  return database;
}

function escapedLegacyPattern(search: string): string {
  return `%${search
    .trim()
    .toLowerCase()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")}%`;
}

/** Frozen pre-Logical event-rollup SQL, independent of production plan code. */
function frozenLegacyEventTypeRows(
  database: DatabaseSync,
  options: FrozenQueryOptions,
): FrozenEventTypeRow[] {
  const searchPattern =
    options.kind === "list"
      ? options.search
        ? escapedLegacyPattern(options.search)
        : null
      : options.search?.trim()
        ? escapedLegacyPattern(options.search)
        : null;
  const sql = `
WITH filtered_events AS (
  SELECT cen.name AS event_name, v.session_id, v.visitor_id
  FROM custom_events ce
  INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id
  INNER JOIN visits v
    ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
  WHERE ce.site_id = ?
    AND ce.occurred_at >= ? AND ce.occurred_at < ?
    ${options.pathname === undefined ? "" : "AND v.pathname = ?"}
), event_rollup AS (
  SELECT
    COALESCE(event_name, '') AS value,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_events
  GROUP BY value
)
SELECT value, views, sessions, visitors
FROM event_rollup
WHERE TRIM(value) != ''
  ${searchPattern === null ? "" : "AND LOWER(value) LIKE ? ESCAPE '\\'"}
  ${
    options.kind !== "page" || !options.cursor
      ? ""
      : `AND (
    views < ? OR (views = ? AND sessions < ?)
    OR (views = ? AND sessions = ? AND value > ?)
  )`
  }
ORDER BY views DESC, sessions DESC, value ASC
  ${options.kind === "page" ? "LIMIT ?" : options.limit > 0 ? "LIMIT ?" : ""}
`;
  const bindings: SQLInputValue[] = [
    SITE_ID,
    WINDOW.startMs,
    WINDOW.endExclusiveMs,
    ...(options.pathname === undefined ? [] : [options.pathname]),
    ...(searchPattern === null ? [] : [searchPattern]),
    ...(options.kind !== "page" || !options.cursor
      ? []
      : [
          options.cursor.views,
          options.cursor.views,
          options.cursor.sessions,
          options.cursor.views,
          options.cursor.sessions,
          options.cursor.value,
        ]),
    ...(options.kind === "page"
      ? [options.limit + 1]
      : options.limit > 0
        ? [options.limit]
        : []),
  ];
  return database
    .prepare(sql)
    .all(...bindings) as unknown as FrozenEventTypeRow[];
}

/** Frozen pre-migration scalar summary SQL; eventTypes counts raw names. */
function frozenLegacySummary(
  database: DatabaseSync,
  pathname?: string,
): FrozenSummary {
  const row = database
    .prepare(
      `
      SELECT
        count(*) AS events,
        count(DISTINCT cen.name) AS eventTypes,
        count(DISTINCT CASE WHEN v.session_id != '' THEN v.session_id ELSE NULL END) AS sessions,
        count(DISTINCT CASE WHEN v.visitor_id != '' THEN v.visitor_id ELSE NULL END) AS visitors
      FROM custom_events ce
      INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id
      INNER JOIN visits v
        ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
      WHERE ce.site_id = ?
        AND ce.occurred_at >= ? AND ce.occurred_at < ?
        ${pathname === undefined ? "" : "AND v.pathname = ?"}
    `,
    )
    .get(
      SITE_ID,
      WINDOW.startMs,
      WINDOW.endExclusiveMs,
      ...(pathname === undefined ? [] : [pathname]),
    );
  if (!row) throw new Error("wave38_legacy_summary_row_missing");
  return {
    events: Number(row["events"]),
    eventTypes: Number(row["eventTypes"]),
    sessions: Number(row["sessions"]),
    visitors: Number(row["visitors"]),
  };
}

function plainFilters(root: FilterExpression | null = null): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function preparedPathFilters(): {
  readonly filters: FilterDocument;
  readonly time: QueryTime;
} {
  const expression: FilterExpression = {
    kind: "condition",
    target: { kind: "field", field: "page.path" as FilterFieldId },
    operator: "eq",
    value: SCOPED_PATH,
  };
  const prepared = prepareScopedQuery("event-records", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters: plainFilters(expression),
    scopePreference: "event",
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: QueryTime;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave38_prepared_filter_incomplete");
  return { filters: prepared.filters, time: prepared.time };
}

let database: DatabaseSync;

beforeAll(() => {
  database = createFixture();
});

afterAll(() => {
  if (executionEvidence.length > 0) {
    console.info(
      `[wave38 event-type SQL and SQLite access-path evidence] ${JSON.stringify(
        executionEvidence.map(({ explain, ...item }) => ({
          ...item,
          indexedSearchCount: explain.filter(
            (line) =>
              /\bSEARCH\b/u.test(line) &&
              /USING (?:COVERING )?(?:INDEX|INTEGER PRIMARY KEY|AUTOMATIC)/u.test(
                line,
              ),
          ).length,
          indexedAccess: explain
            .filter(
              (line) =>
                /\bSEARCH\b/u.test(line) &&
                /USING (?:COVERING )?(?:INDEX|INTEGER PRIMARY KEY|AUTOMATIC)/u.test(
                  line,
                ),
            )
            .slice(0, 5),
          tempOperations: explain.filter((line) => line.startsWith("USE TEMP")),
        })),
      )}`,
    );
  }
  for (const item of databases) item.close();
});

describe("Wave38 Event type and summary Logical migration regressions", () => {
  it("matches frozen list and summary semantics for NULL, empty, whitespace, and empty IDs", async () => {
    const listTrace = newTrace();
    const list = await queryEventTypeAggregate(
      testEnv(database, listTrace),
      SITE_ID,
      WINDOW,
      plainFilters(),
      0,
    );
    const legacyList = frozenLegacyEventTypeRows(database, {
      kind: "list",
      limit: 0,
    });
    expect(list).toEqual(legacyList);
    recordExecutionEvidence("direct-list", listTrace);
    expect(list.map((row) => row.value)).toEqual([
      "alpha",
      "beta",
      "Needle %_\\ suffix",
      "needle%_other",
    ]);
    expect(list[0]).toEqual({
      value: "alpha",
      views: 3,
      sessions: 1,
      visitors: 2,
    });

    const summaryTrace = newTrace();
    const summary = await queryEventSummaryMetricsFromD1(
      testEnv(database, summaryTrace),
      SITE_ID,
      WINDOW,
      plainFilters(),
    );
    recordExecutionEvidence("direct-summary", summaryTrace);
    expect(summary).toEqual(frozenLegacySummary(database));
    expect(summary).toEqual({
      events: 12,
      eventTypes: 6,
      sessions: 6,
      visitors: 6,
    });
  });

  it("preserves escaped substring search and the legacy list/page whitespace gate difference", async () => {
    const escapedSearch = "  nEeDlE %_\\  ";
    const listTrace = newTrace();
    const list = await queryEventTypeAggregate(
      testEnv(database, listTrace),
      SITE_ID,
      WINDOW,
      plainFilters(),
      10,
      escapedSearch,
    );
    expect(list).toEqual(
      frozenLegacyEventTypeRows(database, {
        kind: "list",
        limit: 10,
        search: escapedSearch,
      }),
    );
    expect(list.map((row) => row.value)).toEqual(["Needle %_\\ suffix"]);
    recordExecutionEvidence("direct-list-search-escaped", listTrace);

    const whitespaceTrace = newTrace();
    const whitespaceList = await queryEventTypeAggregate(
      testEnv(database, whitespaceTrace),
      SITE_ID,
      WINDOW,
      plainFilters(),
      0,
      "  ",
    );
    expect(whitespaceList).toEqual(
      frozenLegacyEventTypeRows(database, {
        kind: "list",
        limit: 0,
        search: "  ",
      }),
    );
    expect(whitespaceTrace.preparedSql[0]).toContain("LIKE");
    expect(whitespaceTrace.bindings.flat()).toContain("%%");
    recordExecutionEvidence("direct-list-search-whitespace", whitespaceTrace);

    const whitespacePageTrace = newTrace();
    const whitespacePage = await queryEventTypePageFromD1(
      testEnv(database, whitespacePageTrace),
      SITE_ID,
      WINDOW,
      plainFilters(),
      20,
      "  ",
    );
    expect(whitespacePage.items).toEqual(
      frozenLegacyEventTypeRows(database, {
        kind: "page",
        limit: 20,
        search: "  ",
      }),
    );
    expect(whitespacePageTrace.preparedSql[0]).not.toContain("LIKE");
    expect(whitespacePageTrace.bindings.flat()).not.toContain("%%");
    recordExecutionEvidence(
      "direct-page-search-whitespace",
      whitespacePageTrace,
    );
  });

  it("keeps keyset ordering and signs a cursor that resumes exactly after the prior page", async () => {
    const firstTrace = newTrace();
    const first = await queryEventTypePageFromD1(
      testEnv(database, firstTrace),
      SITE_ID,
      WINDOW,
      plainFilters(),
      2,
    );
    const legacyFirst = frozenLegacyEventTypeRows(database, {
      kind: "page",
      limit: 2,
    });
    expect(first.items).toEqual(legacyFirst.slice(0, 2));
    expect(first.pagination).toMatchObject({
      limit: 2,
      returned: 2,
      hasMore: true,
    });
    expect(first.pagination.nextCursor).toEqual(expect.any(String));
    recordExecutionEvidence("direct-page-first", firstTrace);

    const env = testEnv(database, newTrace());
    const cursor = await decodeEventTypeCursor(
      env,
      SITE_ID,
      WINDOW,
      plainFilters(),
      undefined,
      first.pagination.nextCursor,
    );
    expect(cursor).toEqual({
      views: first.items[1]!.views,
      sessions: first.items[1]!.sessions,
      value: first.items[1]!.value,
    });

    const secondTrace = newTrace();
    const second = await queryEventTypePageFromD1(
      testEnv(database, secondTrace),
      SITE_ID,
      WINDOW,
      plainFilters(),
      2,
      undefined,
      cursor,
    );
    expect(second.items).toEqual(
      frozenLegacyEventTypeRows(database, {
        kind: "page",
        limit: 2,
        cursor,
      }).slice(0, 2),
    );
    expect(second.items.map((row) => row.value)).toEqual([
      "Needle %_\\ suffix",
      "needle%_other",
    ]);
    expect(second.pagination.hasMore).toBe(false);
    expect(second.pagination.nextCursor).toBeNull();
    recordExecutionEvidence("direct-page-cursor", secondTrace);
  });

  it("binds an escaped search and all six keyset values on a continuation page", async () => {
    const search = "needle";
    const firstTrace = newTrace();
    const first = await queryEventTypePageFromD1(
      testEnv(database, firstTrace),
      SITE_ID,
      WINDOW,
      plainFilters(),
      1,
      search,
    );
    expect(first.items).toEqual(
      frozenLegacyEventTypeRows(database, {
        kind: "page",
        limit: 1,
        search,
      }).slice(0, 1),
    );
    expect(first.pagination.nextCursor).toEqual(expect.any(String));
    recordExecutionEvidence("direct-page-search-first", firstTrace);

    const cursor = await decodeEventTypeCursor(
      testEnv(database, newTrace()),
      SITE_ID,
      WINDOW,
      plainFilters(),
      search,
      first.pagination.nextCursor,
    );
    expect(cursor).not.toBeNull();
    const continuationTrace = newTrace();
    const continuation = await queryEventTypePageFromD1(
      testEnv(database, continuationTrace),
      SITE_ID,
      WINDOW,
      plainFilters(),
      1,
      search,
      cursor,
    );
    expect(continuation.items).toEqual(
      frozenLegacyEventTypeRows(database, {
        kind: "page",
        limit: 1,
        search,
        cursor,
      }).slice(0, 1),
    );
    const bindings = continuationTrace.bindings[0] ?? [];
    expect(bindings.slice(-9)).toEqual([
      "%needle%",
      "\\",
      cursor!.views,
      cursor!.views,
      cursor!.sessions,
      cursor!.views,
      cursor!.sessions,
      cursor!.value,
      2,
    ]);
    recordExecutionEvidence("direct-page-search-cursor", continuationTrace);
  });

  it("matches the frozen oracle for prepared scoped owner-page filters in all three outputs", async () => {
    const { filters } = preparedPathFilters();
    const listTrace = newTrace();
    const list = await queryEventTypeAggregate(
      testEnv(database, listTrace),
      SITE_ID,
      WINDOW,
      filters,
      0,
    );
    expect(list).toEqual(
      frozenLegacyEventTypeRows(database, {
        kind: "list",
        limit: 0,
        pathname: SCOPED_PATH,
      }),
    );
    expect(list.map((row) => row.value)).toEqual([
      "alpha",
      "Needle %_\\ suffix",
    ]);
    recordExecutionEvidence("prepared-list", listTrace);

    const pageTrace = newTrace();
    const page = await queryEventTypePageFromD1(
      testEnv(database, pageTrace),
      SITE_ID,
      WINDOW,
      filters,
      1,
    );
    expect(page.items).toEqual(
      frozenLegacyEventTypeRows(database, {
        kind: "page",
        limit: 1,
        pathname: SCOPED_PATH,
      }).slice(0, 1),
    );
    recordExecutionEvidence("prepared-page", pageTrace);

    const summaryTrace = newTrace();
    const summary = await queryEventSummaryMetricsFromD1(
      testEnv(database, summaryTrace),
      SITE_ID,
      WINDOW,
      filters,
    );
    expect(summary).toEqual(frozenLegacySummary(database, SCOPED_PATH));
    expect(summary).toEqual({
      events: 2,
      eventTypes: 2,
      sessions: 1,
      visitors: 1,
    });
    recordExecutionEvidence("prepared-summary", summaryTrace);
  });
});
