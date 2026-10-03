import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  buildEventFilteredSourceCte,
  type QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  decodeEventTypeCursor,
  type EventTypeAggregateCursor,
  queryEventsSummaryFromD1,
  queryEventSummaryMetricsFromD1,
  queryEventTypeAggregate,
  queryEventTypePageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type FilterDocument,
  type FilterExpression,
  type FilterFieldId,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";

const SITE_ID = "wave38-event-types";
const SITE_B = "wave38-event-types-sibling";
const TEAM_ID = "wave38-event-types-team";
const FOREIGN_SITE = "wave38-event-types-foreign";
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
  readonly physicalPlanHash?: string;
}> = [];

function newTrace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function summarizeExplain(lines: readonly string[]) {
  return {
    steps: lines.length,
    indexedSearches: lines.filter(
      (line) =>
        /\bSEARCH\b/u.test(line) &&
        /USING (?:COVERING )?(?:INDEX|INTEGER PRIMARY KEY|AUTOMATIC)/u.test(
          line,
        ),
    ).length,
    eventRangeSearches: lines.filter(
      (line) =>
        /\bSEARCH\b/u.test(line) &&
        /idx_custom_events_site_pk_time/u.test(line),
    ).length,
    materializedRelations: lines.filter((line) =>
      line.startsWith("MATERIALIZE "),
    ).length,
    temporaryBtrees: lines.filter((line) => line.startsWith("USE TEMP")).length,
  };
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "wave38-event-type-cursor-test-secret",
  } as unknown as Env;
}

function recordExecutionEvidence(
  label: string,
  trace: SqliteD1Trace,
  physicalPlanHash?: string,
): void {
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
        value === null || typeof value === "number"
          ? value
          : String(value).length > 120
            ? `${String(value).slice(0, 96)}…[${String(value).length} chars]`
            : String(value),
      ),
    explain,
    ...(physicalPlanHash ? { physicalPlanHash } : {}),
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

function preparedIdentityFilters(
  scopePreference: "event" | "session" | "visitor",
  advancedMatches: NonNullable<ScopedFilterPlan["advancedMatches"]>,
  authorizationSiteIds: readonly string[] = [SITE_ID, SITE_B],
): FilterDocument {
  const context = teamQueryContext(
    TEAM_ID,
    "private-dashboard",
    authorizationSiteIds,
  );
  const prepared = prepareScopedQuery("event-records", {
    context,
    time: QUERY_TIME,
    filters: plainFilters(),
    scopePreference,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("wave39_advanced_identity_preparation_failed");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("wave39_advanced_identity_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: { ...prepared.scopePlan, advancedMatches },
  });
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
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_B);
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

/** Frozen pre-Logical rollup with the original scoped source compiler. */
function frozenLegacyScopedEventTypeRows(
  database: DatabaseSync,
  siteId: string,
  filters: FilterDocument,
  options: FrozenQueryOptions,
): FrozenEventTypeRow[] {
  const source = buildEventFilteredSourceCte(siteId, WINDOW, filters);
  const searchPattern =
    options.kind === "list"
      ? options.search
        ? escapedLegacyPattern(options.search)
        : null
      : options.search?.trim()
        ? escapedLegacyPattern(options.search)
        : null;
  const sql = `${source.cte}, event_rollup AS (
    SELECT COALESCE(event_name, '') AS value, count(*) AS views,
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
      options.kind === "page" && options.cursor
        ? `AND (
      views < ? OR (views = ? AND sessions < ?)
      OR (views = ? AND sessions = ? AND value > ?)
    )`
        : ""
    }
  ORDER BY views DESC, sessions DESC, value ASC
    ${options.kind === "page" || options.limit > 0 ? "LIMIT ?" : ""}`;
  const bindings: SQLInputValue[] = [
    ...source.bindings,
    ...(searchPattern === null ? [] : [searchPattern]),
    ...(options.kind === "page" && options.cursor
      ? [
          options.cursor.views,
          options.cursor.views,
          options.cursor.sessions,
          options.cursor.views,
          options.cursor.sessions,
          options.cursor.value,
        ]
      : []),
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

function frozenLegacyScopedSummary(
  database: DatabaseSync,
  siteId: string,
  filters: FilterDocument,
): FrozenSummary {
  const source = buildEventFilteredSourceCte(siteId, WINDOW, filters);
  const row = database
    .prepare(
      `${source.cte}
      SELECT count(*) AS events, count(DISTINCT event_name) AS eventTypes,
        count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
        count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
      FROM filtered_events`,
    )
    .get(...source.bindings);
  if (!row) throw new Error("wave39_legacy_scoped_summary_row_missing");
  return {
    events: Number(row["events"]),
    eventTypes: Number(row["eventTypes"]),
    sessions: Number(row["sessions"]),
    visitors: Number(row["visitors"]),
  };
}

interface FrozenCardRow extends Record<string, unknown> {
  readonly cardType: string;
  readonly value: unknown;
  readonly views: unknown;
  readonly eventTypes: unknown;
  readonly sessions: unknown;
  readonly visitors: unknown;
}

function frozenLegacyEventSummaryCards(
  database: DatabaseSync,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
): {
  readonly rows: FrozenCardRow[];
  readonly sql: string;
  readonly bindings: readonly SQLInputValue[];
} {
  const source = buildEventFilteredSourceCte(
    siteId,
    window,
    filters,
    undefined,
    { materialize: true },
  );
  const sql = `${source.cte},
card_rows AS (
  SELECT '__summary__' AS cardType, NULL AS value, count(*) AS views,
    count(DISTINCT event_name) AS eventTypes,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM filtered_events
  UNION ALL
  SELECT 'event', event_name, count(*), 0,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END),
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END)
  FROM filtered_events
  WHERE TRIM(COALESCE(event_name, '')) != ''
  GROUP BY event_name
  UNION ALL
  SELECT 'path', pathname, count(*), 0,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END),
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END)
  FROM filtered_events
  WHERE TRIM(COALESCE(pathname, '')) != ''
  GROUP BY pathname
  UNION ALL
  SELECT 'title', title, count(*), 0,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END),
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END)
  FROM filtered_events
  WHERE TRIM(COALESCE(title, '')) != ''
  GROUP BY title
  UNION ALL
  SELECT 'hostname', hostname, count(*), 0,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END),
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END)
  FROM filtered_events
  WHERE TRIM(COALESCE(hostname, '')) != ''
  GROUP BY hostname
), ranked_cards AS (
  SELECT cardType, value, views, eventTypes, sessions, visitors,
    ROW_NUMBER() OVER (
      PARTITION BY cardType
      ORDER BY views DESC, sessions DESC, visitors DESC, value ASC
    ) AS card_rank
  FROM card_rows
)
SELECT cardType, value, views, eventTypes, sessions, visitors
FROM ranked_cards
WHERE cardType = '__summary__' OR card_rank <= 100
ORDER BY cardType ASC, card_rank ASC`;
  return {
    rows: database
      .prepare(sql)
      .all(...source.bindings) as unknown as FrozenCardRow[],
    sql,
    bindings: source.bindings,
  };
}

function frozenEventSummaryCardsDto(rows: readonly FrozenCardRow[]) {
  const summaryRow = rows.find((row) => row.cardType === "__summary__");
  const summary = summaryRow
    ? {
        events: Number(summaryRow.views ?? 0),
        eventTypes: Number(summaryRow.eventTypes ?? 0),
        sessions: Number(summaryRow.sessions ?? 0),
        visitors: Number(summaryRow.visitors ?? 0),
      }
    : { events: 0, eventTypes: 0, sessions: 0, visitors: 0 };
  const readDimension = (cardType: string) =>
    rows
      .filter((row) => row.cardType === cardType)
      .map((row) => ({
        value: String(row.value ?? ""),
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
      }));
  return {
    summary,
    cards: {
      event: { name: readDimension("event") },
      page: {
        path: readDimension("path"),
        title: readDimension("title"),
        hostname: readDimension("hostname"),
      },
    },
  };
}

async function queryAndMeasureEventSummaryCards(
  database: DatabaseSync,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  label: string,
) {
  const trace = newTrace();
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  const operation = `wave40.event_summary_cards.${label}`;
  const env = instrumentEnv(testEnv(database, trace), logger);
  const result = await runWithInvocationLogger(logger, () =>
    runWithD1Operation(operation, () =>
      queryEventsSummaryFromD1(env, siteId, window, filters),
    ),
  );
  const emitted = await logger.emitWhenComplete();
  const observation = emitted.logs.find(
    (item) =>
      item.message === "db.query.v1.all.success" &&
      item.data?.tag === operation,
  )?.data as
    | {
        readonly sqlBytes?: number;
        readonly bindings?: number;
        readonly physicalPlanHash?: string;
      }
    | undefined;
  if (!observation?.physicalPlanHash)
    throw new Error(`wave40_cards_observation_missing:${label}`);
  expect(trace.preparedSql, label).toHaveLength(1);
  expect(trace.bindings, label).toHaveLength(1);
  const sql = trace.preparedSql[0]!;
  const bindingCount = trace.bindings[0]!.length;
  const sqlBytes = new TextEncoder().encode(sql).byteLength;
  expect(observation).toMatchObject({
    sqlBytes,
    bindings: bindingCount,
    physicalPlanHash: expect.stringMatching(/^v[12]:[a-f0-9]{64}$/u),
  });
  expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
  expect(bindingCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  recordExecutionEvidence(label, trace, observation.physicalPlanHash);
  return { result, trace, observation };
}

async function expectPublicOutputsMatchLegacySource(
  siteId: string,
  filters: FilterDocument,
  label: string,
): Promise<void> {
  const listTrace = newTrace();
  const list = await queryEventTypeAggregate(
    testEnv(database, listTrace),
    siteId,
    WINDOW,
    filters,
    0,
  );
  expect(list).toEqual(
    frozenLegacyScopedEventTypeRows(database, siteId, filters, {
      kind: "list",
      limit: 0,
    }),
  );
  recordExecutionEvidence(`${label}-list`, listTrace);

  const pageTrace = newTrace();
  const page = await queryEventTypePageFromD1(
    testEnv(database, pageTrace),
    siteId,
    WINDOW,
    filters,
    20,
  );
  expect(page.items).toEqual(
    frozenLegacyScopedEventTypeRows(database, siteId, filters, {
      kind: "page",
      limit: 20,
    }).slice(0, 20),
  );
  recordExecutionEvidence(`${label}-page`, pageTrace);

  const summaryTrace = newTrace();
  const summary = await queryEventSummaryMetricsFromD1(
    testEnv(database, summaryTrace),
    siteId,
    WINDOW,
    filters,
  );
  expect(summary).toEqual(frozenLegacyScopedSummary(database, siteId, filters));
  recordExecutionEvidence(`${label}-summary`, summaryTrace);
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
          explain: summarizeExplain(explain),
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

  it("matches the frozen scoped compiler for prepared Page/Event identities", async () => {
    const filters = preparedIdentityFilters("event", {
      visitIds: [
        { siteId: SITE_ID, id: "visit-alpha-1" },
        { siteId: SITE_ID, id: "visit-alpha-1" },
      ],
      eventIds: [
        { siteId: SITE_ID, id: "event-alpha-1" },
        { siteId: SITE_ID, id: "event-alpha-2" },
        // The authorized sibling has the same local ID, but the subject below
        // is SITE_ID. Identity matching must keep the site component.
        { siteId: SITE_B, id: "event-alpha-1" },
      ],
    });
    await expectPublicOutputsMatchLegacySource(
      SITE_ID,
      filters,
      "prepared-observation-identities",
    );

    const siblingSubjectFilters = preparedIdentityFilters(
      "event",
      {
        eventIds: [
          { siteId: SITE_ID, id: "event-alpha-1" },
          { siteId: SITE_B, id: "event-alpha-1" },
        ],
      },
      [SITE_ID, SITE_B],
    );
    await expectPublicOutputsMatchLegacySource(
      SITE_B,
      siblingSubjectFilters,
      "prepared-sibling-subject-isolation",
    );
    await expect(
      queryEventTypeAggregate(
        testEnv(database, newTrace()),
        FOREIGN_SITE,
        WINDOW,
        filters,
        0,
      ),
    ).rejects.toThrow(
      "invalid_semantic_scoped_source_selection:subject_outside_prepared_authorization",
    );
  });

  it("matches prepared Session/Visitor identities and empty identity sets", async () => {
    const sessionFilters = preparedIdentityFilters("session", {
      entityIds: [{ siteId: SITE_ID, id: "session-alpha" }],
    });
    await expectPublicOutputsMatchLegacySource(
      SITE_ID,
      sessionFilters,
      "prepared-session-identities",
    );

    const visitorFilters = preparedIdentityFilters("visitor", {
      entityIds: [{ siteId: SITE_ID, id: "visitor-alpha-1" }],
    });
    await expectPublicOutputsMatchLegacySource(
      SITE_ID,
      visitorFilters,
      "prepared-visitor-identities",
    );

    const emptyObservationFilters = preparedIdentityFilters("event", {
      visitIds: [],
      eventIds: [],
    });
    await expectPublicOutputsMatchLegacySource(
      SITE_ID,
      emptyObservationFilters,
      "prepared-empty-observation-identities",
    );
    const emptySessionFilters = preparedIdentityFilters("session", {
      entityIds: [],
    });
    await expectPublicOutputsMatchLegacySource(
      SITE_ID,
      emptySessionFilters,
      "prepared-empty-session-identities",
    );
    const emptyVisitorFilters = preparedIdentityFilters("visitor", {
      entityIds: [],
    });
    await expectPublicOutputsMatchLegacySource(
      SITE_ID,
      emptyVisitorFilters,
      "prepared-empty-visitor-identities",
    );
  });

  it("packs a >100-binding prepared identity set through the shared optimizer", async () => {
    const eventIds = Array.from({ length: 126 }, (_, index) => ({
      siteId: SITE_ID,
      id: `missing-event-${index}`,
    }));
    eventIds.push(
      { siteId: SITE_ID, id: "event-alpha-1" },
      { siteId: SITE_B, id: "event-alpha-1" },
      { siteId: SITE_ID, id: "event-alpha-1" },
    );
    const filters = preparedIdentityFilters("event", { eventIds });
    const frozenSource = buildEventFilteredSourceCte(SITE_ID, WINDOW, filters);
    expect(frozenSource.bindings.length).toBeGreaterThan(100);

    const trace = newTrace();
    const rows = await queryEventTypeAggregate(
      testEnv(database, trace),
      SITE_ID,
      WINDOW,
      filters,
      0,
    );
    expect(rows).toEqual(
      frozenLegacyScopedEventTypeRows(database, SITE_ID, filters, {
        kind: "list",
        limit: 0,
      }),
    );
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.bindings[0]?.length).toBeLessThanOrEqual(100);
    expect(trace.preparedSql[0]?.toLowerCase()).toContain("json_each");
    recordExecutionEvidence("prepared-native-bindings-packed", trace);
  });

  it("returns a real zero summary for an empty database", async () => {
    const emptyDatabase = createMigratedDatabase();
    databases.add(emptyDatabase);
    const trace = newTrace();
    const summary = await queryEventSummaryMetricsFromD1(
      testEnv(emptyDatabase, trace),
      FOREIGN_SITE,
      WINDOW,
      plainFilters(),
    );
    expect(summary).toEqual({
      events: 0,
      eventTypes: 0,
      sessions: 0,
      visitors: 0,
    });
    expect(summary).toEqual(frozenLegacySummary(emptyDatabase));
    recordExecutionEvidence("empty-database-summary", trace);
  });

  it("preserves Unicode and NUL substring-search behavior", async () => {
    const searchDatabase = createFixture();
    databases.add(searchDatabase);
    const sitePk = Number(
      (
        searchDatabase
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE_ID) as { readonly site_pk: number }
      ).site_pk,
    );
    addName(searchDatabase, sitePk, 8, "雪花 🚀");
    addName(searchDatabase, sitePk, 9, "nul\u0000suffix");
    addObservation(searchDatabase, sitePk, {
      id: "unicode-search",
      nameId: 8,
      sessionId: "session-unicode",
      visitorId: "visitor-unicode",
    });
    addObservation(searchDatabase, sitePk, {
      id: "nul-search",
      nameId: 9,
      sessionId: "session-nul",
      visitorId: "visitor-nul",
    });

    for (const [label, search] of [
      ["unicode", "雪"],
      ["nul", "\u0000"],
    ] as const) {
      const trace = newTrace();
      const rows = await queryEventTypeAggregate(
        testEnv(searchDatabase, trace),
        SITE_ID,
        WINDOW,
        plainFilters(),
        0,
        search,
      );
      expect(rows).toEqual(
        frozenLegacyEventTypeRows(searchDatabase, {
          kind: "list",
          limit: 0,
          search,
        }),
      );
      expect(trace.bindings[0]).toContain(escapedLegacyPattern(search));
      recordExecutionEvidence(`direct-list-search-${label}`, trace);
    }
  });

  it("keeps a direct page/event composition as one direct predicate", async () => {
    const filters = plainFilters({
      kind: "and",
      children: [
        {
          kind: "condition",
          target: { kind: "field", field: "page.path" as FilterFieldId },
          operator: "eq",
          value: SCOPED_PATH,
        },
        {
          kind: "condition",
          target: { kind: "field", field: "event.name" as FilterFieldId },
          operator: "eq",
          value: "alpha",
        },
      ],
    });
    const trace = newTrace();
    const summary = await queryEventSummaryMetricsFromD1(
      testEnv(database, trace),
      SITE_ID,
      WINDOW,
      filters,
    );
    expect(summary).toEqual(
      frozenLegacyScopedSummary(database, SITE_ID, filters),
    );
    expect(summary).toEqual({
      events: 1,
      eventTypes: 1,
      sessions: 1,
      visitors: 1,
    });
    recordExecutionEvidence("direct-page-event-composition", trace);
  });

  it("migrates complete Event summary cards against the frozen cards SQL", async () => {
    const legacy = frozenLegacyEventSummaryCards(
      database,
      SITE_ID,
      WINDOW,
      plainFilters(),
    );
    const actual = await queryAndMeasureEventSummaryCards(
      database,
      SITE_ID,
      WINDOW,
      plainFilters(),
      "plain",
    );
    expect(actual.result).toEqual(frozenEventSummaryCardsDto(legacy.rows));
    const legacyExplain = explainQueryPlan(database, {
      sql: legacy.sql,
      bindings: legacy.bindings,
    });
    console.info(
      `[Wave40 cards legacy-vs-compiled] ${JSON.stringify({
        label: "plain",
        statementCount: actual.trace.preparedSql.length,
        legacy: {
          sqlUtf8Bytes: new TextEncoder().encode(legacy.sql).byteLength,
          bindings: legacy.bindings.length,
          explain: summarizeExplain(legacyExplain),
        },
        compiled: {
          sqlUtf8Bytes: new TextEncoder().encode(actual.trace.preparedSql[0]!)
            .byteLength,
          bindings: actual.trace.bindings[0]!.length,
          physicalPlanHash: actual.observation.physicalPlanHash,
          explain: summarizeExplain(
            explainQueryPlan(database, {
              sql: actual.trace.preparedSql[0]!,
              bindings: actual.trace.bindings[0]!,
            }),
          ),
        },
      })}`,
    );
  });

  it("matches all four top-100 cards for ties, raw values, and legacy edge rows", async () => {
    const cardsDatabase = createFixture();
    databases.add(cardsDatabase);
    const sitePk = Number(
      (
        cardsDatabase
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE_ID) as { readonly site_pk: number }
      ).site_pk,
    );

    const tieLabels = [
      "z-visitor-many",
      "a-visitor-one",
      "b-value-a",
      "c-value-z",
    ];
    for (let index = 0; index < 110; index += 1) {
      const label =
        tieLabels[index] ?? `group-${String(index).padStart(3, "0")}`;
      const nameId = 100 + index;
      addName(cardsDatabase, sitePk, nameId, label);
      const pathname = `/${label}`;
      const title = `title:${label}`;
      const hostname = `host-${label}.example`;
      const insertCardObservation = (
        suffix: string,
        visitorId: string,
        occurredAt = 125,
      ) => {
        const id = `card-${index}-${suffix}`;
        const visitId = `visit-${id}`;
        addVisit(cardsDatabase, sitePk, {
          id: visitId,
          sessionId: `card-session-${index}`,
          visitorId,
          pathname,
        });
        cardsDatabase
          .prepare(
            "UPDATE visits SET title = ?, hostname = ? WHERE visit_id = ?",
          )
          .run(title, hostname, visitId);
        addEvent(cardsDatabase, sitePk, {
          id: `event-${id}`,
          visitId,
          nameId,
          occurredAt,
        });
      };

      const visitor = `card-visitor-${index}`;
      insertCardObservation("one", visitor);
      if (index < 4) {
        insertCardObservation(
          "two",
          index === 0 ? `${visitor}-second` : visitor,
        );
      }
    }

    // U+0020 trimming, Unicode, embedded NUL, a weak BLOB value, a missing
    // dictionary row, an orphan owner, and half-open time boundaries all use
    // the same fixture and frozen old SQL oracle.
    addName(cardsDatabase, sitePk, 220, "雪🌙");
    addName(cardsDatabase, sitePk, 221, "nul\u0000event");
    addName(cardsDatabase, sitePk, 222, "edge-start");
    addName(cardsDatabase, sitePk, 223, "edge-end");
    addObservation(cardsDatabase, sitePk, {
      id: "unicode-card",
      nameId: 220,
      sessionId: "unicode-session",
      visitorId: "unicode-visitor",
      pathname: "/雪🌙",
    });
    addObservation(cardsDatabase, sitePk, {
      id: "nul-card",
      nameId: 221,
      sessionId: "nul-session",
      visitorId: "nul-visitor",
      pathname: "/nul\u0000path",
    });
    const startVisit = "visit-edge-start";
    addVisit(cardsDatabase, sitePk, {
      id: startVisit,
      sessionId: "edge-start-session",
      visitorId: "edge-start-visitor",
      pathname: "/edge-start",
    });
    addEvent(cardsDatabase, sitePk, {
      id: "event-edge-start",
      visitId: startVisit,
      nameId: 222,
      occurredAt: WINDOW.startMs,
    });
    const endVisit = "visit-edge-end";
    addVisit(cardsDatabase, sitePk, {
      id: endVisit,
      sessionId: "edge-end-session",
      visitorId: "edge-end-visitor",
      pathname: "/edge-end",
    });
    addEvent(cardsDatabase, sitePk, {
      id: "event-edge-end",
      visitId: endVisit,
      nameId: 223,
      occurredAt: WINDOW.endExclusiveMs,
    });
    addEvent(cardsDatabase, sitePk, {
      id: "event-orphan-owner",
      visitId: "missing-owner",
      nameId: 222,
    });
    addEvent(cardsDatabase, sitePk, {
      id: "event-missing-dictionary",
      visitId: startVisit,
      nameId: 9999,
    });
    const blobVisit = "visit-blob-host";
    addVisit(cardsDatabase, sitePk, {
      id: blobVisit,
      sessionId: "blob-session",
      visitorId: "blob-visitor",
      pathname: "/blob-owner",
    });
    cardsDatabase
      .prepare("UPDATE visits SET hostname = ? WHERE visit_id = ?")
      .run(Buffer.from("blob-host"), blobVisit);
    addEvent(cardsDatabase, sitePk, {
      id: "event-blob-host",
      visitId: blobVisit,
      nameId: 220,
    });

    const legacy = frozenLegacyEventSummaryCards(
      cardsDatabase,
      SITE_ID,
      WINDOW,
      plainFilters(),
    );
    const actual = await queryAndMeasureEventSummaryCards(
      cardsDatabase,
      SITE_ID,
      WINDOW,
      plainFilters(),
      "top-100-edge-fixture",
    );
    const legacyDto = frozenEventSummaryCardsDto(legacy.rows);
    expect(actual.result).toEqual(legacyDto);
    expect(legacyDto.cards.event.name).toHaveLength(100);
    expect(legacyDto.cards.page.path).toHaveLength(100);
    expect(legacyDto.cards.page.title).toHaveLength(100);
    expect(legacyDto.cards.page.hostname).toHaveLength(100);
    for (const values of [
      legacyDto.cards.event.name,
      legacyDto.cards.page.path,
      legacyDto.cards.page.title,
      legacyDto.cards.page.hostname,
    ]) {
      const many = values.findIndex((row) =>
        row.value.includes("visitor-many"),
      );
      const one = values.findIndex((row) => row.value.includes("visitor-one"));
      const valueA = values.findIndex((row) => row.value.includes("value-a"));
      const valueZ = values.findIndex((row) => row.value.includes("value-z"));
      expect(many).toBeGreaterThanOrEqual(0);
      expect(one).toBeGreaterThan(many);
      expect(values[many]).toMatchObject({
        views: 2,
        sessions: 1,
        visitors: 2,
      });
      expect(values[one]).toMatchObject({ views: 2, sessions: 1, visitors: 1 });
      expect(valueA).toBeGreaterThanOrEqual(0);
      expect(valueZ).toBeGreaterThan(valueA);
      expect(values[valueA]).toMatchObject({
        views: 2,
        sessions: 1,
        visitors: 1,
      });
      expect(values[valueZ]).toMatchObject({
        views: 2,
        sessions: 1,
        visitors: 1,
      });
    }
    expect(
      legacyDto.cards.event.name.some((row) => row.value === "edge-start"),
    ).toBe(true);
    expect(
      legacyDto.cards.event.name.some((row) => row.value === "edge-end"),
    ).toBe(false);
    expect(legacyDto.cards.event.name.some((row) => row.value === "")).toBe(
      false,
    );
    console.info(
      `[Wave40 cards top-100 fixture] ${JSON.stringify({
        distinctGroupsPerDimension: 110,
        returned: {
          event: legacyDto.cards.event.name.length,
          path: legacyDto.cards.page.path.length,
          title: legacyDto.cards.page.title.length,
          hostname: legacyDto.cards.page.hostname.length,
        },
        legacySqlUtf8Bytes: new TextEncoder().encode(legacy.sql).byteLength,
        compiledSqlUtf8Bytes: actual.observation.sqlBytes,
        bindingCount: actual.observation.bindings,
        physicalPlanHash: actual.observation.physicalPlanHash,
        legacyExplain: summarizeExplain(
          explainQueryPlan(cardsDatabase, {
            sql: legacy.sql,
            bindings: legacy.bindings,
          }),
        ),
        compiledExplain: summarizeExplain(
          explainQueryPlan(cardsDatabase, {
            sql: actual.trace.preparedSql[0]!,
            bindings: actual.trace.bindings[0]!,
          }),
        ),
      })}`,
    );
  });

  it("keeps cards equivalent for filters, prepared entities, large identities, and empty identities", async () => {
    const cardsDatabase = createFixture();
    databases.add(cardsDatabase);
    const sitePk = Number(
      (
        cardsDatabase
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE_ID) as { readonly site_pk: number }
      ).site_pk,
    );
    for (let index = 0; index < 108; index += 1) {
      const nameId = 100 + index;
      addName(cardsDatabase, sitePk, nameId, `advanced-${index}`);
      addObservation(cardsDatabase, sitePk, {
        id: `advanced-${index}`,
        nameId,
        sessionId: `advanced-session-${index}`,
        visitorId: `advanced-visitor-${index}`,
        pathname: index === 0 ? SCOPED_PATH : `/advanced-${index}`,
      });
    }

    const scenarios: Array<{
      readonly label: string;
      readonly filters: FilterDocument;
      readonly siteId?: string;
    }> = [
      {
        label: "prepared-filter",
        filters: preparedPathFilters().filters,
      },
      {
        label: "prepared-session-entity",
        filters: preparedIdentityFilters("session", {
          entityIds: [{ siteId: SITE_ID, id: "advanced-session-0" }],
        }),
      },
      {
        label: "prepared-large-identities",
        filters: preparedIdentityFilters("event", {
          eventIds: [
            ...Array.from({ length: 126 }, (_, index) => ({
              siteId: SITE_ID,
              id: `missing-event-${index}`,
            })),
            { siteId: SITE_ID, id: "event-advanced-0" },
            { siteId: SITE_B, id: "event-advanced-0" },
          ],
        }),
      },
      {
        label: "prepared-empty-identities",
        filters: preparedIdentityFilters("event", { eventIds: [] }),
      },
    ];
    for (const scenario of scenarios) {
      const siteId = scenario.siteId ?? SITE_ID;
      const legacy = frozenLegacyEventSummaryCards(
        cardsDatabase,
        siteId,
        WINDOW,
        scenario.filters,
      );
      const actual = await queryAndMeasureEventSummaryCards(
        cardsDatabase,
        siteId,
        WINDOW,
        scenario.filters,
        scenario.label,
      );
      expect(actual.result, scenario.label).toEqual(
        frozenEventSummaryCardsDto(legacy.rows),
      );
      console.info(
        `[Wave40 cards legacy-vs-compiled] ${JSON.stringify({
          label: scenario.label,
          legacy: {
            sqlUtf8Bytes: new TextEncoder().encode(legacy.sql).byteLength,
            bindings: legacy.bindings.length,
            explain: summarizeExplain(
              explainQueryPlan(cardsDatabase, {
                sql: legacy.sql,
                bindings: legacy.bindings,
              }),
            ),
          },
          compiled: {
            sqlUtf8Bytes: actual.observation.sqlBytes,
            bindings: actual.observation.bindings,
            physicalPlanHash: actual.observation.physicalPlanHash,
            explain: summarizeExplain(
              explainQueryPlan(cardsDatabase, {
                sql: actual.trace.preparedSql[0]!,
                bindings: actual.trace.bindings[0]!,
              }),
            ),
          },
        })}`,
      );
    }
  });
});
