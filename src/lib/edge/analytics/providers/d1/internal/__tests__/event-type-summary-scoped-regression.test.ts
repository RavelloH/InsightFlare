import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createD1DatabaseClient,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
} from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
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
  EVENT_SUMMARY_CARD_OUTPUTS,
  EVENT_SUMMARY_QUALIFICATION_CONTROL_OUTPUT,
} from "@/lib/edge/analytics/engine/event-summary-cards-plan";
import { buildEventFilteredSourceCte } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import type { PreparedMembershipFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import { preparedMembershipFromIds } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import {
  d1AdvancedFilterMiddleware,
  deferredEventSummaryQualificationFromQuery,
  deferredEventTypesQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
  prepareDeferredEventSummaryFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  compileEventSummaryQualificationProgram,
  compileEventTypesQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import {
  mapEventSummaryCards,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { type QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeEventTypeCursor,
  type EventTypeAggregateCursor,
  queryEventsSummaryFromD1,
  queryEventSummaryMetricsFromD1,
  queryEventTypeAggregate,
  queryEventTypePageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import { hasWholeOriginalCompletion } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import {
  type FilterDocument,
  type FilterExpression,
  type FilterFieldId,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";
import { InvalidCursorError } from "@/lib/pagination";

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

function eventSummaryDto(
  data: Awaited<ReturnType<typeof queryEventsSummaryFromD1>>,
) {
  const events = Number(data.summary.events ?? 0);
  const sessions = Number(data.summary.sessions ?? 0);
  return {
    summary: {
      events,
      eventTypes: Number(data.summary.eventTypes ?? 0),
      sessions,
      visitors: Number(data.summary.visitors ?? 0),
      avgEventsPerSession: sessions > 0 ? events / sessions : 0,
    },
    cards: mapEventSummaryCards(data.cards),
  };
}

function eventSummaryCandidateStatementEvidence(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index],
    sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
    bindingCount: trace.bindings[index]?.length ?? 0,
    sha256: createHash("sha256").update(sql).digest("hex"),
  }));
}

function writeEventSummaryCandidateEvidence(name: string, value: unknown) {
  const artifactDirectory = process.env.WAVE97EH_ARTIFACT_DIR;
  if (!artifactDirectory) return;
  const evidencePath = resolve(artifactDirectory, name);
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, JSON.stringify(value, null, 2), "utf8");
}

function prepareEventSummaryQuery(
  dsl: string,
  scope: "session" | "visitor" | "event" = "session",
): QueryInput & {
  readonly filters?: FilterDocument;
  readonly time?: QueryTime;
} {
  const filters = parseFilterDsl(dsl, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("event-summary", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: QueryTime;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave94b_event_summary_query_preparation_failed");
  return prepared;
}

interface PreparedEventTypesQuery extends QueryInput {
  readonly filters?: FilterDocument;
  readonly time?: QueryTime;
  readonly limit: number;
  readonly search?: string;
  readonly cursor?: string;
}

function prepareEventTypesQuery(
  dsl: string,
  scope: "event" | "session" | "visitor",
  options: {
    readonly limit: number;
    readonly search?: string;
    readonly cursor?: string;
  },
): PreparedEventTypesQuery {
  const filters = parseFilterDsl(dsl, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("event-types", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: QueryTime;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave94c_event_types_query_preparation_failed");
  return {
    ...prepared,
    limit: options.limit,
    ...(options.search !== undefined ? { search: options.search } : {}),
    ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
  } as PreparedEventTypesQuery;
}

async function executeLegacyEventTypesRequest(input: {
  readonly env: Env;
  readonly prepared: PreparedEventTypesQuery;
}): Promise<Awaited<ReturnType<typeof queryEventTypePageFromD1>>> {
  const forwarded = await d1AdvancedFilterMiddleware(input.env)(
    "event-types",
    input.prepared,
    async (value) => value,
  );
  const deferred = deferredEventTypesQualificationFromQuery(forwarded);
  if (!deferred)
    throw new Error("wave94c_full_legacy_event_types_request_not_prepared");
  const cursor = await decodeEventTypeCursor(
    input.env,
    SITE_ID,
    WINDOW,
    input.prepared.filters!,
    input.prepared.search,
    input.prepared.cursor,
    input.prepared.context.policy.audience,
  );
  if (input.prepared.cursor && !cursor)
    throw new InvalidCursorError("event-types");
  const filters = await prepareDeferredEventQualificationFallback(deferred);
  return queryEventTypePageFromD1(
    input.env,
    SITE_ID,
    WINDOW,
    filters,
    input.prepared.limit,
    input.prepared.search,
    cursor,
    input.prepared.context.policy.audience,
    hasWholeOriginalCompletion(deferred, "event-types")
      ? { wholeOriginalOwner: deferred }
      : undefined,
  );
}

/** Execute the current complete fallback Count+report request with this DSL.
 * This helper is not an independent historical-source oracle. */
async function executeLegacyEventSummaryRequest(input: {
  readonly env: Env;
  readonly prepared: QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: QueryTime;
  };
}): Promise<Awaited<ReturnType<typeof queryEventsSummaryFromD1>>> {
  const forwarded = await d1AdvancedFilterMiddleware(input.env)(
    "event-summary",
    input.prepared,
    async (value) => value,
  );
  const deferred = deferredEventSummaryQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("wave94b_full_legacy_request_not_prepared");
  const filters = await prepareDeferredEventSummaryFallback(deferred);
  return queryEventsSummaryFromD1(
    input.env,
    SITE_ID,
    WINDOW,
    filters,
    hasWholeOriginalCompletion(deferred, "event-summary")
      ? { wholeOriginalOwner: deferred }
      : undefined,
  );
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
  matches: PreparedMembershipFixture,
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
    plan: {
      ...prepared.scopePlan,
      preparedMembership: preparedMembershipFromIds(matches),
    },
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
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(SITE_ID, TEAM_ID, "Event summary qualification", "qualification.test");
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
    physicalPlanHash: expect.stringMatching(/^v12:[a-f0-9]{64}$/u),
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
  it("runs the real event-summary middleware with gated Count qualification in one report statement", async () => {
    const trace = newTrace();
    const logger = createInvocationLogger({
      source: "worker",
      trigger: "request",
    });
    const operation = "wave94b.event-summary-qualification";
    const env = instrumentEnv(testEnv(database, trace), logger);
    const filter = parseFilterDsl(
      'count(page { page.path eq "/scoped" }) eq 1',
      analyticsFilterRegistry,
    );
    const prepared = prepareScopedQuery("event-summary", {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      time: QUERY_TIME,
      filters: filter,
      scopePreference: "session",
    } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
      readonly filters?: FilterDocument;
      readonly time?: QueryTime;
    };
    if (!prepared.filters || !prepared.time)
      throw new Error("wave94b_event_summary_query_preparation_failed");

    let compilation:
      ReturnType<typeof compileEventSummaryQualificationProgram> | undefined;
    const registry = createD1SiteProviderRegistry({ env, siteId: SITE_ID });
    registry.useMiddleware(async (_operation, input, next) => {
      const deferred = deferredEventSummaryQualificationFromQuery(input);
      if (deferred)
        compilation = compileEventSummaryQualificationProgram(deferred);
      return next(input);
    });
    const provider = registry.resolve("event-summary");
    if (!provider) throw new Error("wave94b_event_summary_provider_missing");
    const actual = await runWithInvocationLogger(logger, () =>
      runWithD1Operation(operation, () => provider.execute(prepared as never)),
    );
    const emitted = await logger.emitWhenComplete();
    expect(compilation?.kind).toBe("compiled");
    if (compilation?.kind !== "compiled")
      throw new Error("wave94b_event_summary_fusion_unavailable");
    const compiledEvidence = compilation.evidence;
    expect(trace.preparedSql).toHaveLength(2);
    expect(trace.bindings).toHaveLength(2);
    expect(trace.preparedSql[1]).toBe(compiledEvidence.sql);
    expect(trace.bindings[1]).toEqual(compiledEvidence.bindings);
    expect(trace.preparedSql[1]).not.toContain("json_each");
    expect(trace.bindings.flat()).not.toContain("session-alpha");

    const fusedObservation = emitted.logs.find((item) => {
      if (item.message !== "db.query.v1.all.success") return false;
      const data = item.data as
        { readonly tag?: string; readonly sqlBytes?: number } | undefined;
      return (
        data?.tag === operation && data.sqlBytes === compiledEvidence.sqlBytes
      );
    })?.data as
      | {
          readonly tag?: string;
          readonly sqlBytes?: number;
          readonly bindings?: number;
          readonly physicalPlanHash?: string;
        }
      | undefined;
    expect(fusedObservation).toMatchObject({
      tag: operation,
      sqlBytes: compiledEvidence.sqlBytes,
      bindings: compiledEvidence.bindingCount,
      physicalPlanHash: expect.stringMatching(/^v\d+:[a-f0-9]{64}$/u),
    });

    const baselineTrace = newTrace();
    const baselineEnv = testEnv(database, baselineTrace);
    const legacy = await executeLegacyEventSummaryRequest({
      env: baselineEnv,
      prepared,
    });
    expect(baselineTrace.preparedSql.length).toBeGreaterThan(2);
    const actualValue = actual.value;
    expect(actualValue).toEqual(eventSummaryDto(legacy));
    expect(legacy.summary.events).toBeGreaterThan(1);

    const evidenceDirectory = process.env.WAVE94B_REPAIR_FULL_BASELINE_DIR;
    if (evidenceDirectory) {
      const absoluteEvidencePath = resolve(evidenceDirectory, "session.json");
      mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
      const tracedStatements = (value: SqliteD1Trace) =>
        value.preparedSql.map((sql, index) => ({
          sql,
          bindings: value.bindings[index],
          sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
          sha256: createHash("sha256").update(sql).digest("hex"),
        }));
      writeFileSync(
        absoluteEvidencePath,
        JSON.stringify(
          {
            kind: "wave94b-full-request-sqlite-baseline",
            scope: "session",
            dsl: 'count(page { page.path eq "/scoped" }) eq 1',
            legacyBaseline: {
              route:
                "coverage + normal Count evaluator + report; fusion execution bypassed",
              statementCount: baselineTrace.preparedSql.length,
              statements: tracedStatements(baselineTrace),
              dto: eventSummaryDto(legacy),
            },
            fusedRequest: {
              route: "coverage + one compiled qualification/report statement",
              statementCount: trace.preparedSql.length,
              statements: tracedStatements(trace),
              dto: actualValue,
              compilation: compiledEvidence,
              physicalPlanHash: fusedObservation?.physicalPlanHash,
            },
            dtoEqual: true,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
  });

  it("uses the same fused route with Visitor qualification scope", async () => {
    const trace = newTrace();
    const env = testEnv(database, trace);
    const filter = parseFilterDsl(
      'count(page { page.path eq "/scoped" }) eq 1',
      analyticsFilterRegistry,
    );
    const prepared = prepareScopedQuery("event-summary", {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      time: QUERY_TIME,
      filters: filter,
      scopePreference: "visitor",
    } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
      readonly filters?: FilterDocument;
      readonly time?: QueryTime;
    };
    if (!prepared.filters || !prepared.time)
      throw new Error("wave94b_visitor_event_summary_query_preparation_failed");
    const registry = createD1SiteProviderRegistry({ env, siteId: SITE_ID });
    const provider = registry.resolve("event-summary");
    if (!provider)
      throw new Error("wave94b_visitor_event_summary_provider_missing");
    const actual = await provider.execute(prepared as never);
    expect(trace.preparedSql).toHaveLength(2);
    expect(trace.bindings).toHaveLength(2);
    const baselineTrace = newTrace();
    const legacy = await executeLegacyEventSummaryRequest({
      env: testEnv(database, baselineTrace),
      prepared,
    });
    expect(baselineTrace.preparedSql.length).toBeGreaterThan(2);
    expect(actual.value).toEqual(eventSummaryDto(legacy));

    const evidenceDirectory = process.env.WAVE94B_REPAIR_FULL_BASELINE_DIR;
    if (evidenceDirectory) {
      const absoluteEvidencePath = resolve(evidenceDirectory, "visitor.json");
      mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
      const tracedStatements = (value: SqliteD1Trace) =>
        value.preparedSql.map((sql, index) => ({
          sql,
          bindings: value.bindings[index],
          sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
          sha256: createHash("sha256").update(sql).digest("hex"),
        }));
      writeFileSync(
        absoluteEvidencePath,
        JSON.stringify(
          {
            kind: "wave94b-full-request-sqlite-baseline",
            scope: "visitor",
            dsl: 'count(page { page.path eq "/scoped" }) eq 1',
            legacyBaseline: {
              route:
                "coverage + normal Count evaluator + report; fusion execution bypassed",
              statementCount: baselineTrace.preparedSql.length,
              statements: tracedStatements(baselineTrace),
              dto: eventSummaryDto(legacy),
            },
            fusedRequest: {
              route: "coverage + one compiled qualification/report statement",
              statementCount: trace.preparedSql.length,
              statements: tracedStatements(trace),
              dto: actual.value,
            },
            dtoEqual: true,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
  });

  it.each(["session", "visitor", "event"] as const)(
    "qualifies Event type keyset pages in one report statement for %s scope",
    async (scope) => {
      const qualifiedDatabase = createFixture();
      const siteIdentity = qualifiedDatabase
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number };
      addEvent(qualifiedDatabase, Number(siteIdentity.site_pk), {
        id: "event-qualified-beta",
        visitId: "visit-alpha-1",
        nameId: 2,
      });
      addEvent(qualifiedDatabase, Number(siteIdentity.site_pk), {
        id: "event-qualified-needle",
        visitId: "visit-alpha-1",
        nameId: 3,
      });

      const dsl = 'count(page { page.path eq "/scoped" }) eq 1';
      const search = "a";
      const runActual = async (prepared: PreparedEventTypesQuery) => {
        const trace = newTrace();
        const env = testEnv(qualifiedDatabase, trace);
        const registry = createD1SiteProviderRegistry({ env, siteId: SITE_ID });
        let deferred:
          | ReturnType<typeof deferredEventTypesQualificationFromQuery>
          | undefined;
        registry.useMiddleware(async (operation, input, next) => {
          if (operation === "event-types")
            deferred = deferredEventTypesQualificationFromQuery(input);
          return next(input);
        });
        const provider = registry.resolve("event-types");
        if (!provider) throw new Error("wave94c_event_types_provider_missing");
        const actual = await provider.execute(prepared as never);
        if (!deferred)
          throw new Error("wave94c_event_types_qualification_missing");
        return { actual, deferred, env, trace };
      };
      const statementEvidence = (trace: SqliteD1Trace) =>
        trace.preparedSql.map((sql, index) => ({
          sql,
          bindings: trace.bindings[index],
          sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
          sha256: createHash("sha256").update(sql).digest("hex"),
        }));
      const compilePage = async (input: {
        readonly deferred: NonNullable<
          ReturnType<typeof deferredEventTypesQualificationFromQuery>
        >;
        readonly env: Env;
        readonly prepared: PreparedEventTypesQuery;
      }) => {
        const cursor = await decodeEventTypeCursor(
          input.env,
          SITE_ID,
          WINDOW,
          input.prepared.filters!,
          input.prepared.search,
          input.prepared.cursor,
          input.prepared.context.policy.audience,
        );
        const compilation = compileEventTypesQualificationProgram({
          deferred: input.deferred,
          query: {
            kind: "page",
            limit: input.prepared.limit,
            ...(input.prepared.search !== undefined
              ? { search: input.prepared.search }
              : {}),
            ...(cursor ? { cursor } : {}),
          },
        });
        if (compilation.kind !== "compiled")
          throw new Error("wave94c_event_types_compilation_unavailable");
        return compilation.evidence;
      };

      const firstPrepared = prepareEventTypesQuery(dsl, scope, {
        limit: 1,
        search,
      });
      const firstActual = await runActual(firstPrepared);
      const firstDto = firstActual.actual.value as {
        readonly items: readonly {
          readonly label: string;
          readonly views: number;
          readonly sessions: number;
          readonly visitors: number;
        }[];
        readonly pagination: {
          readonly limit: number;
          readonly returned: number;
          readonly hasMore: boolean;
          readonly nextCursor: string | null;
        };
      };
      const firstCompilation = await compilePage({
        deferred: firstActual.deferred,
        env: firstActual.env,
        prepared: firstPrepared,
      });
      expect(firstActual.trace.preparedSql).toHaveLength(2);
      expect(firstActual.trace.preparedSql[1]).toBe(firstCompilation.sql);
      expect(firstActual.trace.bindings[1]).toEqual(firstCompilation.bindings);
      expect(firstCompilation.groupedSummaryMaterialization).toBe(
        "materialized",
      );
      expect(firstCompilation.groupWidth).toBeLessThanOrEqual(16);
      expect(firstCompilation.sqlBytes).toBe(
        new TextEncoder().encode(firstCompilation.sql).byteLength,
      );
      expect(firstCompilation.bindingCount).toBe(
        firstCompilation.bindings.length,
      );
      expect(firstActual.trace.bindings.flat()).not.toContain("session-alpha");
      expect(firstActual.trace.bindings.flat()).not.toContain(
        "visitor-alpha-1",
      );
      expect(firstDto.items).toHaveLength(1);
      expect(firstDto.pagination).toMatchObject({
        limit: 1,
        returned: 1,
        hasMore: true,
      });
      expect(firstDto.pagination.nextCursor).toEqual(expect.any(String));

      const firstBaselineTrace = newTrace();
      const firstBaseline = await executeLegacyEventTypesRequest({
        env: testEnv(qualifiedDatabase, firstBaselineTrace),
        prepared: firstPrepared,
      });
      const firstBaselineDto = {
        items: mapTabs(firstBaseline.items),
        pagination: firstBaseline.pagination,
      };
      expect(firstBaselineTrace.preparedSql.length).toBeGreaterThan(2);
      expect(firstDto).toEqual(firstBaselineDto);

      const cursor = firstDto.pagination.nextCursor!;
      const continuationPrepared = prepareEventTypesQuery(dsl, scope, {
        limit: 1,
        search,
        cursor,
      });
      const continuationActual = await runActual(continuationPrepared);
      const continuationCompilation = await compilePage({
        deferred: continuationActual.deferred,
        env: continuationActual.env,
        prepared: continuationPrepared,
      });
      const continuationDto = continuationActual.actual.value as {
        readonly items: readonly {
          readonly label: string;
          readonly views: number;
          readonly sessions: number;
          readonly visitors: number;
        }[];
        readonly pagination: {
          readonly limit: number;
          readonly returned: number;
          readonly hasMore: boolean;
          readonly nextCursor: string | null;
        };
      };
      expect(continuationActual.trace.preparedSql).toHaveLength(2);
      expect(continuationActual.trace.preparedSql[1]).toBe(
        continuationCompilation.sql,
      );
      expect(continuationActual.trace.bindings[1]).toEqual(
        continuationCompilation.bindings,
      );
      expect(continuationActual.trace.bindings.flat()).not.toContain(
        "session-alpha",
      );
      const continuationBaselineTrace = newTrace();
      const continuationBaseline = await executeLegacyEventTypesRequest({
        env: testEnv(qualifiedDatabase, continuationBaselineTrace),
        prepared: continuationPrepared,
      });
      const continuationBaselineDto = {
        items: mapTabs(continuationBaseline.items),
        pagination: continuationBaseline.pagination,
      };
      expect(continuationBaselineTrace.preparedSql.length).toBeGreaterThan(2);
      expect(continuationDto).toEqual(continuationBaselineDto);

      const evidenceDirectory = process.env.WAVE94C_EVENT_TYPES_EVIDENCE_DIR;
      if (evidenceDirectory) {
        const absoluteEvidencePath = resolve(
          evidenceDirectory,
          `${scope}.json`,
        );
        mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
        writeFileSync(
          absoluteEvidencePath,
          JSON.stringify(
            {
              kind: "wave94c-event-types-full-request-sqlite-evidence",
              scope,
              dsl,
              search,
              limit: 1,
              firstPage: {
                baseline: {
                  route:
                    "coverage + normal Count evaluator + legacy Event type page",
                  statementCount: firstBaselineTrace.preparedSql.length,
                  statements: statementEvidence(firstBaselineTrace),
                  dto: firstBaselineDto,
                },
                qualified: {
                  route:
                    "coverage + one qualified Event type keyset-page statement",
                  statementCount: firstActual.trace.preparedSql.length,
                  statements: statementEvidence(firstActual.trace),
                  dto: firstDto,
                  compilation: firstCompilation,
                },
                dtoEqual: true,
              },
              continuationPage: {
                baseline: {
                  route:
                    "coverage + normal Count evaluator + legacy Event type page",
                  statementCount: continuationBaselineTrace.preparedSql.length,
                  statements: statementEvidence(continuationBaselineTrace),
                  dto: continuationBaselineDto,
                },
                qualified: {
                  route:
                    "coverage + one qualified Event type keyset-page statement",
                  statementCount: continuationActual.trace.preparedSql.length,
                  statements: statementEvidence(continuationActual.trace),
                  dto: continuationDto,
                  compilation: continuationCompilation,
                },
                dtoEqual: true,
              },
            },
            null,
            2,
          ),
          "utf8",
        );
      }
    },
  );

  it("qualifies Event candidates against the Core oracle through the Event Types page and keeps its cursor", async () => {
    const candidateDatabase = createFixture();
    const siteIdentity = candidateDatabase
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(SITE_ID) as { readonly site_pk: number };
    const sitePk = Number(siteIdentity.site_pk);
    addName(candidateDatabase, sitePk, 8, "candidate-collision-event");
    addName(candidateDatabase, sitePk, 9, "candidate-owner-outside-event");
    addName(candidateDatabase, sitePk, 10, "candidate-whitespace-event");
    addVisit(candidateDatabase, sitePk, {
      id: "candidate-collision",
      sessionId: "",
      visitorId: "candidate-empty-visitor",
      pathname: "/candidate-collision-owner",
    });
    addEvent(candidateDatabase, sitePk, {
      id: "candidate-collision",
      visitId: "candidate-collision",
      nameId: 8,
    });
    addVisit(candidateDatabase, sitePk, {
      id: "candidate-owner-outside",
      sessionId: "candidate-owner-session",
      visitorId: "candidate-owner-visitor",
      pathname: "/candidate-owner-outside",
    });
    candidateDatabase
      .prepare("UPDATE visits SET started_at = 110 WHERE visit_id = ?")
      .run("candidate-owner-outside");
    addEvent(candidateDatabase, sitePk, {
      id: "candidate-owner-outside-event",
      visitId: "candidate-owner-outside",
      nameId: 9,
    });
    addVisit(candidateDatabase, sitePk, {
      id: "candidate-whitespace-event",
      sessionId: "",
      visitorId: "candidate-local-visitor",
      pathname: "/candidate-whitespace-page",
    });
    addVisit(candidateDatabase, sitePk, {
      id: "candidate-whitespace-owner",
      sessionId: " ",
      visitorId: "candidate-whitespace-visitor",
      pathname: "/candidate-whitespace-owner",
    });
    addEvent(candidateDatabase, sitePk, {
      id: "candidate-whitespace-event",
      visitId: "candidate-whitespace-owner",
      nameId: 10,
    });

    const dsl =
      '(count(page) eq 1 AND count(event) eq 1 AND page.path eq "/candidate-collision-owner" AND event.name eq "candidate-collision-event") OR (count(page) eq 0 AND count(event) eq 1 AND page.path eq "/candidate-owner-outside" AND event.name eq "candidate-owner-outside-event") OR (count(page) eq 0 AND count(event) eq 1 AND page.path eq "/candidate-whitespace-owner" AND event.name eq "candidate-whitespace-event")';
    const runActual = async (
      prepared: PreparedEventTypesQuery,
      requestDsl: string,
    ) => {
      const trace = newTrace();
      const env = testEnv(candidateDatabase, trace);
      const registry = createD1SiteProviderRegistry({ env, siteId: SITE_ID });
      let deferred:
        ReturnType<typeof deferredEventTypesQualificationFromQuery> | undefined;
      registry.useMiddleware(async (operation, input, next) => {
        if (operation === "event-types")
          deferred = deferredEventTypesQualificationFromQuery(input);
        return next(input);
      });
      const provider = registry.resolve("event-types");
      if (!provider)
        throw new Error("event_candidate_event_types_provider_missing");
      const actual = await provider.execute(prepared as never);
      if (!deferred)
        throw new Error("event_candidate_event_types_deferred_missing");
      const compilation = compileEventTypesQualificationProgram({
        deferred,
        query: {
          kind: "page",
          limit: prepared.limit,
          ...(prepared.search !== undefined ? { search: prepared.search } : {}),
          ...(prepared.cursor
            ? {
                cursor: await decodeEventTypeCursor(
                  env,
                  SITE_ID,
                  WINDOW,
                  prepared.filters!,
                  prepared.search,
                  prepared.cursor,
                  prepared.context.policy.audience,
                ),
              }
            : {}),
        },
      });
      if (compilation.kind !== "compiled")
        return {
          actual,
          deferred,
          compilation,
          rawRows: null,
          trace,
          env,
          requestDsl,
        };
      const rawQueryRows = await createD1DatabaseClient(
        createSqliteD1Database(candidateDatabase),
      ).all<Record<string, unknown>>({
        tag: compilation.evidence.statementTag,
        sql: compilation.evidence.sql,
        bindings: [...compilation.evidence.bindings],
      } as never);
      return {
        actual,
        deferred,
        compilation: {
          kind: "compiled" as const,
          evidence: compilation.evidence,
        },
        rawRows: rawQueryRows.results,
        trace,
        env,
        requestDsl,
      };
    };
    const toLegacyDto = (
      value: Awaited<ReturnType<typeof executeLegacyEventTypesRequest>>,
    ) => ({ items: mapTabs(value.items), pagination: value.pagination });
    const evidenceDirectory = process.env.WAVE97EA_EVENT_TYPES_EVIDENCE_DIR;
    const evidencePath = evidenceDirectory
      ? resolve(evidenceDirectory, "event-candidate-page.json")
      : undefined;
    const statementEvidence = (trace: SqliteD1Trace) =>
      trace.preparedSql.map((sql, index) => ({
        sql,
        bindings: trace.bindings[index],
        sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
        sha256: createHash("sha256").update(sql).digest("hex"),
      }));
    const evidenceForPage = (
      actual: Awaited<ReturnType<typeof runActual>>,
      baseline: Awaited<ReturnType<typeof executeLegacyEventTypesRequest>>,
      baselineTrace: SqliteD1Trace,
    ) => ({
      request: {
        operation: "event-types",
        audience: "private-dashboard",
        siteId: actual.deferred.siteId,
        requestedScope: actual.deferred.metadata.requestedScope,
        resolvedScope: actual.deferred.metadata.resolvedScope,
        candidateGrain:
          actual.deferred.countInput.scope === "event"
            ? actual.deferred.countInput.candidateAnchor.kind
            : null,
        filter: actual.requestDsl,
      },
      fusedRoute: {
        statementCount: actual.trace.preparedSql.length,
        statements: statementEvidence(actual.trace),
        rawEnvelopeRows: actual.rawRows,
        dto: actual.actual.value,
        compilation: actual.compilation,
      },
      legacyCoreRoute: {
        statementCount: baselineTrace.preparedSql.length,
        statements: statementEvidence(baselineTrace),
        dto: toLegacyDto(baseline),
      },
    });
    const saveEvidence = (evidence: unknown) => {
      if (!evidencePath) return;
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
    };
    const firstPrepared = prepareEventTypesQuery(dsl, "event", {
      limit: 1,
      search: "candidate",
    });
    const firstActual = await runActual(firstPrepared, dsl);
    const firstDto = firstActual.actual.value as {
      readonly items: readonly unknown[];
      readonly pagination: { readonly nextCursor: string | null };
    };
    expect(firstActual.deferred.countInput).toMatchObject({
      scope: "event",
      candidateAnchor: { kind: "event-candidate" },
    });
    expect(firstActual.compilation.kind).toBe("compiled");
    if (firstActual.compilation.kind !== "compiled")
      throw new Error("event_candidate_optimized_compile_missing");
    expect(
      firstActual.compilation.evidence.groupedSummaryMaterializations,
    ).toHaveLength(2);
    expect(
      firstActual.compilation.evidence.groupedSummaryMaterializations?.every(
        ({ groupWidth, materialization }) =>
          groupWidth <= 16 && materialization === "materialized",
      ),
    ).toBe(true);
    expect(firstActual.compilation.evidence.sqlBytes).toBeLessThanOrEqual(
      100_000,
    );
    expect(firstActual.compilation.evidence.bindingCount).toBeLessThanOrEqual(
      100,
    );
    expect(firstActual.trace.preparedSql).toHaveLength(2);
    expect(firstActual.trace.preparedSql[1]).toBe(
      firstActual.compilation.evidence.sql,
    );
    expect(firstActual.trace.bindings[1]).toEqual(
      firstActual.compilation.evidence.bindings,
    );
    expect(firstDto.pagination.nextCursor).toEqual(expect.any(String));

    const firstBaselineTrace = newTrace();
    const firstBaseline = await executeLegacyEventTypesRequest({
      env: testEnv(candidateDatabase, firstBaselineTrace),
      prepared: firstPrepared,
    });
    saveEvidence({
      kind: "wave97ea-event-types-candidate-scope-sqlite-evidence",
      candidateRequest: {
        search: "candidate",
        limit: 1,
        firstPage: evidenceForPage(
          firstActual,
          firstBaseline,
          firstBaselineTrace,
        ),
      },
    });
    expect(firstDto).toEqual(toLegacyDto(firstBaseline));
    expect(firstDto.items).toHaveLength(1);
    expect(firstActual.trace.preparedSql[0]).toEqual(
      firstBaselineTrace.preparedSql[0],
    );
    expect(firstActual.trace.bindings[0]).toEqual(
      firstBaselineTrace.bindings[0],
    );

    const continuationPrepared = prepareEventTypesQuery(dsl, "event", {
      limit: 1,
      search: "candidate",
      cursor: firstDto.pagination.nextCursor!,
    });
    const continuationActual = await runActual(continuationPrepared, dsl);
    const continuationDto = continuationActual.actual.value;
    expect(continuationActual.compilation.kind).toBe("compiled");
    if (continuationActual.compilation.kind !== "compiled")
      throw new Error("event_candidate_continuation_compile_missing");
    expect(
      continuationActual.compilation.evidence.groupedSummaryMaterializations,
    ).toHaveLength(2);
    expect(
      continuationActual.compilation.evidence.sqlBytes,
    ).toBeLessThanOrEqual(100_000);
    expect(
      continuationActual.compilation.evidence.bindingCount,
    ).toBeLessThanOrEqual(100);
    expect(continuationActual.trace.preparedSql).toHaveLength(2);
    expect(continuationActual.trace.preparedSql[1]).toBe(
      continuationActual.compilation.evidence.sql,
    );
    expect(continuationActual.trace.bindings[1]).toEqual(
      continuationActual.compilation.evidence.bindings,
    );
    const continuationBaselineTrace = newTrace();
    const continuationBaseline = await executeLegacyEventTypesRequest({
      env: testEnv(candidateDatabase, continuationBaselineTrace),
      prepared: continuationPrepared,
    });
    saveEvidence({
      kind: "wave97ea-event-types-candidate-scope-sqlite-evidence",
      candidateRequest: {
        search: "candidate",
        limit: 1,
        firstPage: evidenceForPage(
          firstActual,
          firstBaseline,
          firstBaselineTrace,
        ),
        continuationPage: evidenceForPage(
          continuationActual,
          continuationBaseline,
          continuationBaselineTrace,
        ),
      },
    });
    expect(continuationDto).toEqual(toLegacyDto(continuationBaseline));
    expect(continuationActual.trace.preparedSql[0]).toEqual(
      continuationBaselineTrace.preparedSql[0],
    );
    expect(continuationActual.trace.bindings[0]).toEqual(
      continuationBaselineTrace.bindings[0],
    );
    expect(firstDto.items).not.toEqual(
      (continuationDto as { readonly items: readonly unknown[] }).items,
    );

    const nativeDsl =
      'count(event) eq 1 AND (event.name eq "candidate-collision-event" OR NOT event.name eq "candidate-owner-outside-event")';
    const nativePrepared = prepareEventTypesQuery(nativeDsl, "event", {
      limit: 1,
    });
    expect(nativePrepared.search).toBeUndefined();
    const nativeActual = await runActual(nativePrepared, nativeDsl);
    if (nativeActual.compilation.kind !== "compiled")
      throw new Error(
        `event_candidate_native_mixed_compile_unavailable:${JSON.stringify(nativeActual.compilation.fallbackReason)}`,
      );
    expect(nativeActual.deferred.countInput).toMatchObject({
      scope: "event",
      candidateAnchor: { kind: "event-candidate" },
    });
    expect(
      nativeActual.compilation.evidence.groupedSummaryMaterializations,
    ).toHaveLength(2);
    expect(
      nativeActual.compilation.evidence.groupedSummaryMaterializations?.every(
        ({ groupWidth, materialization }) =>
          groupWidth <= 16 && materialization === "materialized",
      ),
    ).toBe(true);
    expect(nativeActual.compilation.evidence.sqlBytes).toBeLessThanOrEqual(
      100_000,
    );
    expect(nativeActual.compilation.evidence.bindingCount).toBeLessThanOrEqual(
      100,
    );
    expect(nativeActual.trace.preparedSql).toHaveLength(2);
    expect(nativeActual.trace.preparedSql[1]).toBe(
      nativeActual.compilation.evidence.sql,
    );
    expect(nativeActual.trace.bindings[1]).toEqual(
      nativeActual.compilation.evidence.bindings,
    );
    const nativeDto = nativeActual.actual.value as {
      readonly items: readonly unknown[];
      readonly pagination: { readonly nextCursor: string | null };
    };
    expect(nativeDto.items).toHaveLength(1);
    expect(nativeDto.pagination.nextCursor).toEqual(expect.any(String));
    const nativeBaselineTrace = newTrace();
    const nativeBaseline = await executeLegacyEventTypesRequest({
      env: testEnv(candidateDatabase, nativeBaselineTrace),
      prepared: nativePrepared,
    });
    expect(nativeDto).toEqual(toLegacyDto(nativeBaseline));

    const nativeContinuationPrepared = prepareEventTypesQuery(
      nativeDsl,
      "event",
      { limit: 1, cursor: nativeDto.pagination.nextCursor! },
    );
    const nativeContinuationActual = await runActual(
      nativeContinuationPrepared,
      nativeDsl,
    );
    if (nativeContinuationActual.compilation.kind !== "compiled")
      throw new Error(
        `event_candidate_native_mixed_continuation_unavailable:${JSON.stringify(nativeContinuationActual.compilation.fallbackReason)}`,
      );
    const nativeContinuationDto = nativeContinuationActual.actual.value;
    expect(
      nativeContinuationActual.compilation.evidence
        .groupedSummaryMaterializations,
    ).toHaveLength(2);
    expect(
      nativeContinuationActual.compilation.evidence.sqlBytes,
    ).toBeLessThanOrEqual(100_000);
    expect(nativeContinuationActual.trace.preparedSql).toHaveLength(2);
    expect(nativeContinuationActual.trace.preparedSql[1]).toBe(
      nativeContinuationActual.compilation.evidence.sql,
    );
    const nativeContinuationBaselineTrace = newTrace();
    const nativeContinuationBaseline = await executeLegacyEventTypesRequest({
      env: testEnv(candidateDatabase, nativeContinuationBaselineTrace),
      prepared: nativeContinuationPrepared,
    });
    expect(nativeContinuationDto).toEqual(
      toLegacyDto(nativeContinuationBaseline),
    );
    expect(nativeDto.items).not.toEqual(
      (nativeContinuationDto as { readonly items: readonly unknown[] }).items,
    );

    saveEvidence({
      kind: "wave97ea-event-types-candidate-scope-sqlite-evidence",
      scope: "event",
      candidateRequest: {
        search: "candidate",
        limit: 1,
        firstPage: evidenceForPage(
          firstActual,
          firstBaseline,
          firstBaselineTrace,
        ),
        continuationPage: evidenceForPage(
          continuationActual,
          continuationBaseline,
          continuationBaselineTrace,
        ),
      },
      nativeMixedRequest: {
        search: null,
        limit: 1,
        firstPage: evidenceForPage(
          nativeActual,
          nativeBaseline,
          nativeBaselineTrace,
        ),
        continuationPage: evidenceForPage(
          nativeContinuationActual,
          nativeContinuationBaseline,
          nativeContinuationBaselineTrace,
        ),
      },
    });
  });

  it("rejects Event type cursors when the Count filter or owner scope changes", async () => {
    const qualifiedDatabase = createFixture();
    const siteIdentity = qualifiedDatabase
      .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
      .get(SITE_ID) as { readonly site_pk: number };
    addEvent(qualifiedDatabase, Number(siteIdentity.site_pk), {
      id: "event-cursor-beta",
      visitId: "visit-alpha-1",
      nameId: 2,
    });
    const original = prepareEventTypesQuery(
      'count(page { page.path eq "/scoped" }) eq 1',
      "session",
      { limit: 1 },
    );
    const firstTrace = newTrace();
    const firstRegistry = createD1SiteProviderRegistry({
      env: testEnv(qualifiedDatabase, firstTrace),
      siteId: SITE_ID,
    });
    const firstProvider = firstRegistry.resolve("event-types");
    if (!firstProvider) throw new Error("wave94c_cursor_provider_missing");
    const first = await firstProvider.execute(original as never);
    const nextCursor = (
      first.value as {
        readonly pagination: { readonly nextCursor: string | null };
      }
    ).pagination.nextCursor;
    if (!nextCursor) throw new Error("wave94c_cursor_not_created");

    const invalidRequests = [
      prepareEventTypesQuery(
        'count(page { page.path eq "/ordinary" }) eq 1',
        "session",
        { limit: 1, cursor: nextCursor },
      ),
      prepareEventTypesQuery(
        'count(page { page.path eq "/scoped" }) eq 1',
        "visitor",
        { limit: 1, cursor: nextCursor },
      ),
    ];
    for (const prepared of invalidRequests) {
      const trace = newTrace();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(qualifiedDatabase, trace),
        siteId: SITE_ID,
      }).resolve("event-types");
      if (!provider) throw new Error("wave94c_cursor_provider_missing");
      await expect(provider.execute(prepared as never)).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
      expect(trace.preparedSql).toHaveLength(2);
      expect(trace.preparedSql.join(" ")).not.toContain("event-type-page");
    }
  });

  it("rejects accessor-shaped Event candidate request state before report reads", async () => {
    const unsafeDatabase = createFixture();
    databases.add(unsafeDatabase);
    const prepared = prepareEventTypesQuery(
      'count(page { page.path eq "/scoped" }) eq 1',
      "event",
      { limit: 1 },
    );
    const scopePlan = prepared.scopePlan;
    let scopePlanReads = 0;
    Object.defineProperty(prepared, "scopePlan", {
      enumerable: true,
      configurable: true,
      get() {
        scopePlanReads += 1;
        return scopePlan;
      },
    });

    const trace = newTrace();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(unsafeDatabase, trace),
      siteId: SITE_ID,
    }).resolve("event-types");
    if (!provider)
      throw new Error("event_candidate_unsafe_request_provider_missing");
    await expect(provider.execute(prepared as never)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [
          {
            path: "query",
            code: "event_types_qualification_request_context_mismatch",
          },
        ],
      },
    });
    expect(scopePlanReads).toBe(0);
    expect(trace.preparedSql.join(" ")).not.toContain("event-type-page");
  });

  it("preserves activity-cap priority before an invalid Event type cursor", async () => {
    const capDatabase = createFixture();
    databases.add(capDatabase);
    capDatabase
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-alpha-1");
    capDatabase
      .prepare(
        `WITH RECURSIVE generated(n) AS (
           SELECT 1
           UNION ALL SELECT n + 1 FROM generated WHERE n < 20001
         )
         INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         )
         SELECT 'wave94d-cap-page-' || n, ?, 1, ?, ?, 'closed', 125,
           125, '/cap-page', 'cap.test', 1
         FROM generated`,
      )
      .run(SITE_ID, "wave94d-cap-visitor", "wave94d-cap-session");
    const prepared = prepareEventTypesQuery(
      "count(page { page.durationMs gt 5 }) eq 1",
      "session",
      { limit: 20, cursor: "invalid-event-types-cursor" },
    );

    const oldTrace = newTrace();
    const oldEnv = testEnv(capDatabase, oldTrace);
    const forwarded = await d1AdvancedFilterMiddleware(oldEnv)(
      "event-types",
      prepared,
      async (value) => value,
    );
    const deferred = deferredEventTypesQualificationFromQuery(forwarded);
    if (!deferred)
      throw new Error("wave94d_pre_fix_deferred_qualification_missing");
    let legacyFailure: unknown;
    try {
      await prepareDeferredEventQualificationFallback(deferred);
      const cursor = await decodeEventTypeCursor(
        oldEnv,
        SITE_ID,
        WINDOW,
        prepared.filters!,
        prepared.search,
        prepared.cursor,
      );
      if (!cursor) throw new InvalidCursorError("event-types");
    } catch (error) {
      legacyFailure = error;
    }

    const currentTrace = newTrace();
    const currentProvider = createD1SiteProviderRegistry({
      env: testEnv(capDatabase, currentTrace),
      siteId: SITE_ID,
    }).resolve("event-types");
    if (!currentProvider)
      throw new Error("wave94d_pre_fix_event_types_provider_missing");
    let currentFailure: unknown;
    try {
      await currentProvider.execute(prepared as never);
    } catch (error) {
      currentFailure = error;
    }
    const legacyDomainError = (
      legacyFailure as
        | {
            readonly domainError?: {
              readonly kind?: string;
              readonly issues?: readonly {
                readonly path: string;
                readonly code: string;
              }[];
            };
          }
        | undefined
    )?.domainError;
    expect(legacyDomainError?.issues).toContainEqual({
      path: "filters",
      code: "filter_activity_limit_exceeded",
    });
    const currentDomainError = (
      currentFailure as
        | {
            readonly domainError?: {
              readonly kind?: string;
              readonly issues?: readonly {
                readonly path: string;
                readonly code: string;
              }[];
            };
          }
        | undefined
    )?.domainError;
    expect(currentDomainError?.issues).toContainEqual({
      path: "filters",
      code: "filter_activity_limit_exceeded",
    });
    expect(currentTrace.preparedSql).toHaveLength(oldTrace.preparedSql.length);
    expect(currentTrace.preparedSql.join(" ")).not.toContain("event-type-page");

    const evidencePath =
      process.env.WAVE94D_EVENT_CURSOR_CAP_FINAL_EVIDENCE_PATH;
    if (evidencePath) {
      const absoluteEvidencePath = resolve(evidencePath);
      mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
      const statements = (trace: SqliteD1Trace) =>
        trace.preparedSql.map((sql, index) => ({
          sql,
          bindings: trace.bindings[index],
          sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
          sha256: createHash("sha256").update(sql).digest("hex"),
        }));
      writeFileSync(
        absoluteEvidencePath,
        JSON.stringify(
          {
            kind: "wave94d-invalid-cursor-cap-priority-post-fix",
            dsl: "count(page { page.durationMs gt 5 }) eq 1",
            scope: "session",
            cursor: prepared.cursor,
            overCapFixtureActivityCount: 20001,
            legacyOrder: {
              route:
                "coverage + Count preparation/cap validation + invalid cursor decode",
              statementCount: oldTrace.preparedSql.length,
              statements: statements(oldTrace),
              failure: {
                kind: legacyDomainError?.kind,
                issues: legacyDomainError?.issues,
              },
            },
            deferredPostFix: {
              route:
                "coverage + Count preparation/cap validation before invalid cursor decode",
              statementCount: currentTrace.preparedSql.length,
              statements: statements(currentTrace),
              failure: {
                kind: currentDomainError?.kind,
                issues: currentDomainError?.issues,
              },
              reportStatementExecuted: false,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
    }
  });

  it.each(["session", "visitor", "event"] as const)(
    "returns an empty qualified Event type page without report leakage for %s scope",
    async (scope) => {
      const emptyDatabase = createFixture();
      databases.add(emptyDatabase);
      const prepared = prepareEventTypesQuery(
        'count(page { page.path eq "/not-present" }) eq 1',
        scope,
        { limit: 20 },
      );
      const trace = newTrace();
      const registry = createD1SiteProviderRegistry({
        env: testEnv(emptyDatabase, trace),
        siteId: SITE_ID,
      });
      let deferred: boolean | undefined;
      registry.useMiddleware(async (operation, input, next) => {
        if (operation === "event-types")
          deferred =
            deferredEventTypesQualificationFromQuery(input) !== undefined;
        return next(input);
      });
      const provider = registry.resolve("event-types");
      if (!provider)
        throw new Error("wave94c_empty_event_types_provider_missing");
      const actual = await provider.execute(prepared as never);
      const baselineTrace = newTrace();
      const baseline = await executeLegacyEventTypesRequest({
        env: testEnv(emptyDatabase, baselineTrace),
        prepared,
      });
      expect(deferred).toBe(true);
      expect(actual.value).toEqual({
        items: mapTabs(baseline.items),
        pagination: baseline.pagination,
      });
      expect(actual.value).toMatchObject({
        items: [],
        pagination: { returned: 0, hasMore: false, nextCursor: null },
      });
      expect(trace.preparedSql).toHaveLength(2);
      expect(baselineTrace.preparedSql.length).toBeGreaterThan(2);
    },
  );

  it("keeps unsupported payload Count on the static Event type path", async () => {
    const prepared = prepareEventTypesQuery(
      'count(event { event.name eq "alpha" AND event.payload("/missing") eq "x" }) eq 1',
      "session",
      { limit: 20 },
    );
    const trace = newTrace();
    const registry = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE_ID,
    });
    let deferred: boolean | undefined;
    registry.useMiddleware(async (operation, input, next) => {
      if (operation === "event-types")
        deferred =
          deferredEventTypesQualificationFromQuery(input) !== undefined;
      return next(input);
    });
    const provider = registry.resolve("event-types");
    if (!provider)
      throw new Error("wave94c_payload_event_types_provider_missing");
    await provider.execute(prepared as never);
    expect(deferred).toBe(false);
    expect(trace.preparedSql.length).toBeGreaterThan(2);
  });

  it.each(["session", "visitor", "event"] as const)(
    "preserves numeric compatibility fallback for qualified Event type pages in %s scope",
    async (scope) => {
      const repairDatabase = createFixture();
      databases.add(repairDatabase);
      repairDatabase
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "visit-alpha-1");
      const dsl = "count(page { page.durationMs gt 5 }) eq 1";
      const prepared = prepareEventTypesQuery(dsl, scope, { limit: 20 });
      const baselineTrace = newTrace();
      const baseline = await executeLegacyEventTypesRequest({
        env: testEnv(repairDatabase, baselineTrace),
        prepared,
      });
      const trace = newTrace();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(repairDatabase, trace),
        siteId: SITE_ID,
        diagnostics,
      }).resolve("event-types");
      if (!provider)
        throw new Error("wave94c_numeric_fallback_provider_missing");
      const actual = await provider.execute(prepared as never);

      const evidenceDirectory = process.env.WAVE94C_EVENT_TYPES_EVIDENCE_DIR;
      if (evidenceDirectory) {
        const absoluteEvidencePath = resolve(
          evidenceDirectory,
          "numeric-fallback",
          `${scope}.json`,
        );
        mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
        const statements = (statementTrace: SqliteD1Trace) =>
          statementTrace.preparedSql.map((sql, index) => ({
            sql,
            bindings: statementTrace.bindings[index],
            sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
            sha256: createHash("sha256").update(sql).digest("hex"),
          }));
        writeFileSync(
          absoluteEvidencePath,
          JSON.stringify(
            {
              kind: "wave94c-event-types-numeric-fallback-evidence",
              scope,
              dsl,
              limit: prepared.limit,
              numericFixture: {
                visitId: "visit-alpha-1",
                fieldId: "page.durationMs",
                storageType: "text",
              },
              baseline: {
                route:
                  "coverage + normal Count evaluator + legacy Event type page",
                statementCount: baselineTrace.preparedSql.length,
                statements: statements(baselineTrace),
                dto: {
                  items: mapTabs(baseline.items),
                  pagination: baseline.pagination,
                },
              },
              qualifiedFallback: {
                route:
                  "coverage + guarded qualification controls + normal Count evaluator + legacy Event type page",
                statementCount: trace.preparedSql.length,
                statements: statements(trace),
                fallbackReason: diagnostics.advancedCountSqlFallbackReason,
                dto: actual.value,
              },
              dtoEqual: true,
            },
            null,
            2,
          ),
          "utf8",
        );
      }

      expect(actual.value).toEqual({
        items: mapTabs(baseline.items),
        pagination: baseline.pagination,
      });
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(trace.preparedSql.length).toBeGreaterThan(2);
    },
  );

  it("runs the event-scope summary numeric fallback through the request-private Event membership relation", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-alpha-1");
    const prepared = prepareEventSummaryQuery(
      "count(page { page.durationMs gt 5 }) eq 0",
      "event",
    );
    const baselineTrace = newTrace();
    const baseline = await executeLegacyEventSummaryRequest({
      env: testEnv(database, baselineTrace),
      prepared,
    });
    expect(baseline.summary.events).toBeGreaterThan(0);

    const trace = newTrace();
    const diagnostics = createD1ReadDiagnostics();
    const env = testEnv(database, trace);
    const forwarded = await d1AdvancedFilterMiddleware(env)(
      "event-summary",
      prepared,
      async (value) => value,
    );
    const deferred = deferredEventSummaryQualificationFromQuery(forwarded);
    if (!deferred) throw new Error("event_summary_membership_deferred_missing");
    const actual = await queryEventsSummaryFromD1(
      env,
      SITE_ID,
      WINDOW,
      deferred.filters,
      { deferredQualification: deferred, diagnostics },
    );
    expect(eventSummaryDto(actual)).toEqual(eventSummaryDto(baseline));
    expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
    expect(deferred.metadata.plan.preparedMembership).toBeUndefined();
    // The legacy ID bridge binds (site, "event", id) triples.
    const hasKindTriple = (bindings: readonly unknown[]) =>
      bindings.some(
        (value, index) =>
          value === "event" &&
          typeof bindings[index + 1] === "string" &&
          (bindings[index + 1] as string).startsWith("event-"),
      );
    expect(hasKindTriple(trace.bindings.at(-1) ?? [])).toBe(false);
  });

  it.each(["session", "visitor"] as const)(
    "runs the %s-scope numeric fallback through the request-private entity membership relation",
    async (scope) => {
      const database = createFixture();
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "visit-alpha-1");
      const prepared = prepareEventTypesQuery(
        "count(page { page.durationMs gt 5 }) eq 0",
        scope,
        { limit: 20 },
      );
      const baselineTrace = newTrace();
      const baseline = await executeLegacyEventTypesRequest({
        env: testEnv(database, baselineTrace),
        prepared,
      });
      expect(baseline.items.length).toBeGreaterThan(0);

      const trace = newTrace();
      const diagnostics = createD1ReadDiagnostics();
      const env = testEnv(database, trace);
      const deferred = deferredEventTypesQualificationFromQuery(
        await d1AdvancedFilterMiddleware(env)(
          "event-types",
          prepared,
          async (value) => value,
        ),
      );
      if (!deferred) throw new Error("entity_membership_deferred_missing");
      const actual = await queryEventTypePageFromD1(
        env,
        SITE_ID,
        WINDOW,
        deferred.filters,
        prepared.limit,
        prepared.search,
        null,
        "private-dashboard",
        { deferredQualification: deferred, diagnostics },
      );
      expect({
        items: mapTabs(actual.items),
        pagination: actual.pagination,
      }).toEqual({
        items: mapTabs(baseline.items),
        pagination: baseline.pagination,
      });
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(deferred.metadata.plan.preparedMembership).toBeUndefined();
      // The legacy ID bridge binds the entity kind next to every identity.
      expect(trace.bindings.at(-1) ?? []).not.toContain(scope);
    },
  );

  it("runs the event-scope numeric fallback through the request-private Event membership relation", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-alpha-1");
    const prepared = prepareEventTypesQuery(
      "count(page { page.durationMs gt 5 }) eq 0",
      "event",
      { limit: 20 },
    );
    const baselineTrace = newTrace();
    const baseline = await executeLegacyEventTypesRequest({
      env: testEnv(database, baselineTrace),
      prepared,
    });
    expect(baseline.items.length).toBeGreaterThan(0);

    const trace = newTrace();
    const diagnostics = createD1ReadDiagnostics();
    const env = testEnv(database, trace);
    const forwarded = await d1AdvancedFilterMiddleware(env)(
      "event-types",
      prepared,
      async (value) => value,
    );
    const deferred = deferredEventTypesQualificationFromQuery(forwarded);
    if (!deferred) throw new Error("event_types_membership_deferred_missing");
    const actual = await queryEventTypePageFromD1(
      env,
      SITE_ID,
      WINDOW,
      deferred.filters,
      prepared.limit,
      prepared.search,
      null,
      "private-dashboard",
      { deferredQualification: deferred, diagnostics },
    );
    expect({
      items: mapTabs(actual.items),
      pagination: actual.pagination,
    }).toEqual({
      items: mapTabs(baseline.items),
      pagination: baseline.pagination,
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
    // The relation is request-private: the trusted scope plan never carries IDs.
    expect(deferred.metadata.plan.preparedMembership).toBeUndefined();
    // The prepared membership binds only (site, id) pairs, never a kind.
    const reportBindings = trace.bindings.at(-1) ?? [];
    expect(reportBindings).not.toContain("event");
    expect(reportBindings).toContain("event-alpha-1");
  });

  it.each(["session", "visitor"] as const)(
    "falls back to the complete legacy request for numeric compatibility in %s scope",
    async (scope) => {
      const repairDatabase = createFixture();
      repairDatabase
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "visit-alpha-1");
      const numericStorageType = repairDatabase
        .prepare(
          "SELECT typeof(duration_ms) AS storageType FROM visits WHERE visit_id = ?",
        )
        .get("visit-alpha-1") as { readonly storageType: string } | undefined;
      expect(numericStorageType?.storageType).toBe("text");

      const filter = parseFilterDsl(
        "count(page { page.durationMs gt 5 }) eq 1",
        analyticsFilterRegistry,
      );
      const prepared = prepareScopedQuery("event-summary", {
        context: siteQueryContext(SITE_ID, "private-dashboard"),
        time: QUERY_TIME,
        filters: filter,
        scopePreference: scope,
      } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
        readonly filters?: FilterDocument;
        readonly time?: QueryTime;
      };
      if (!prepared.filters || !prepared.time)
        throw new Error("wave94b_numeric_fallback_query_preparation_failed");

      const baselineTrace = newTrace();
      const baselineEnv = testEnv(repairDatabase, baselineTrace);
      const baselineMiddleware = d1AdvancedFilterMiddleware(baselineEnv);
      const baselineInput = await baselineMiddleware(
        "event-summary",
        prepared,
        async (input) => input,
      );
      const baselineDeferred =
        deferredEventSummaryQualificationFromQuery(baselineInput);
      if (!baselineDeferred)
        throw new Error("wave94b_numeric_fallback_baseline_not_prepared");
      const baselineFilters =
        await prepareDeferredEventSummaryFallback(baselineDeferred);
      const baseline = await queryEventsSummaryFromD1(
        baselineEnv,
        SITE_ID,
        WINDOW,
        baselineFilters,
        hasWholeOriginalCompletion(baselineDeferred, "event-summary")
          ? { wholeOriginalOwner: baselineDeferred }
          : undefined,
      );
      const baselineDto = {
        summary: {
          events: baseline.summary.events,
          eventTypes: baseline.summary.eventTypes,
          sessions: baseline.summary.sessions,
          visitors: baseline.summary.visitors,
          avgEventsPerSession:
            baseline.summary.sessions > 0
              ? baseline.summary.events / baseline.summary.sessions
              : 0,
        },
        cards: mapEventSummaryCards(baseline.cards),
      };

      const fusedTrace = newTrace();
      const fusedEnv = testEnv(repairDatabase, fusedTrace);
      const fusedDiagnostics = createD1ReadDiagnostics();
      const registry = createD1SiteProviderRegistry({
        env: fusedEnv,
        siteId: SITE_ID,
        diagnostics: fusedDiagnostics,
      });
      const provider = registry.resolve("event-summary");
      if (!provider)
        throw new Error("wave94b_numeric_fallback_provider_missing");
      const actual = await provider.execute(prepared as never);
      const actualDto = actual.value as typeof baselineDto;
      expect(actualDto).toEqual(baselineDto);
      expect(fusedDiagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(fusedTrace.preparedSql.length).toBeGreaterThan(
        baselineTrace.preparedSql.length,
      );

      const evidenceDirectory = process.env.WAVE94B_REPAIR_NUMERIC_EVIDENCE_DIR;
      if (evidenceDirectory) {
        const absoluteEvidencePath = resolve(
          evidenceDirectory,
          `${scope}.json`,
        );
        mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
        const statements = (trace: SqliteD1Trace) =>
          trace.preparedSql.map((sql, index) => ({
            sql,
            bindings: trace.bindings[index],
            sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
            sha256: createHash("sha256").update(sql).digest("hex"),
          }));
        writeFileSync(
          absoluteEvidencePath,
          JSON.stringify(
            {
              kind: "wave94b-numeric-compatibility-fallback-repair",
              dsl: "count(page { page.durationMs gt 5 }) eq 1",
              scope,
              numericFixture: {
                visitId: "visit-alpha-1",
                fieldId: "page.durationMs",
                storageType: numericStorageType?.storageType,
              },
              baseline: {
                route:
                  "d1AdvancedFilterMiddleware -> prepareDeferredEventSummaryFallback -> queryEventsSummaryFromD1",
                statementCount: baselineTrace.preparedSql.length,
                statements: statements(baselineTrace),
                dto: baselineDto,
              },
              fusedRoute: {
                statementCount: fusedTrace.preparedSql.length,
                statements: statements(fusedTrace),
                fallbackReason: fusedDiagnostics.advancedCountSqlFallbackReason,
                dto: actualDto,
              },
            },
            null,
            2,
          ),
          "utf8",
        );
      }
      expect(baselineTrace.preparedSql.length).toBeGreaterThan(2);
      expect(baseline.summary.events).toBe(0);
      expect(fusedTrace.preparedSql.length).toBeGreaterThan(2);
    },
  );

  it("keeps the activity cap ahead of numeric fallback and gates every report arm", async () => {
    const capDatabase = createFixture();
    capDatabase
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-alpha-1");
    capDatabase
      .prepare(
        `WITH RECURSIVE generated(n) AS (
           SELECT 1
           UNION ALL SELECT n + 1 FROM generated WHERE n < 20001
         )
         INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         )
         SELECT 'wave94b-cap-page-' || n, ?, 1, ?, ?, 'closed', 125,
           125, '/cap-page', 'cap.test', 1
         FROM generated`,
      )
      .run(SITE_ID, "wave94b-cap-visitor", "wave94b-cap-session");

    const filter = parseFilterDsl(
      "count(page { page.durationMs gt 5 }) eq 1",
      analyticsFilterRegistry,
    );
    const prepared = prepareScopedQuery("event-summary", {
      context: siteQueryContext(SITE_ID, "private-dashboard"),
      time: QUERY_TIME,
      filters: filter,
      scopePreference: "session",
    } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
      readonly filters?: FilterDocument;
      readonly time?: QueryTime;
    };
    if (!prepared.filters || !prepared.time)
      throw new Error("wave94b_cap_query_preparation_failed");

    const trace = newTrace();
    const env = testEnv(capDatabase, trace);
    const registry = createD1SiteProviderRegistry({ env, siteId: SITE_ID });
    let compilation:
      ReturnType<typeof compileEventSummaryQualificationProgram> | undefined;
    registry.useMiddleware(async (_operation, input, next) => {
      const deferred = deferredEventSummaryQualificationFromQuery(input);
      if (deferred)
        compilation = compileEventSummaryQualificationProgram(deferred);
      return next(input);
    });
    const provider = registry.resolve("event-summary");
    if (!provider) throw new Error("wave94b_cap_provider_missing");
    let failure: unknown;
    try {
      await provider.execute(prepared as never);
    } catch (error) {
      failure = error;
    }
    expect(compilation?.kind).toBe("compiled");
    if (compilation?.kind !== "compiled")
      throw new Error("wave94b_cap_fused_compile_unavailable");
    const rows = capDatabase
      .prepare(compilation.evidence.sql)
      .all(...(compilation.evidence.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const controls = rows.filter((row) => row.rowKind === "control");
    const reportRows = rows.filter((row) => row.rowKind === "report");
    expect(controls).toHaveLength(1);
    expect(Number(controls[0]?.rawCount)).toBeGreaterThan(20_000);
    expect(
      Number(controls[0]?.invalidContextPageDurationMsCount),
    ).toBeGreaterThan(0);
    expect(reportRows).toHaveLength(0);
    const domainError = (
      failure as
        | {
            readonly domainError?: {
              readonly kind?: string;
              readonly issues?: readonly {
                readonly path: string;
                readonly code: string;
              }[];
            };
          }
        | undefined
    )?.domainError;
    expect(domainError?.kind).toBe("invalid-input");
    expect(domainError?.issues).toContainEqual({
      path: "filters",
      code: "filter_activity_limit_exceeded",
    });

    const evidencePath = process.env.WAVE94B_REPAIR_CAP_EVIDENCE_PATH;
    if (evidencePath) {
      const absoluteEvidencePath = resolve(evidencePath);
      mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
      writeFileSync(
        absoluteEvidencePath,
        JSON.stringify(
          {
            kind: "wave94b-cap-and-numeric-priority-contract",
            scope: "session",
            rawCount: Number(controls[0]?.rawCount),
            numericCompatibilityCount: Number(
              controls[0]?.invalidContextPageDurationMsCount,
            ),
            reportRowCount: reportRows.length,
            thrownDomainError: domainError,
            fusedSql: compilation.evidence.sql,
            fusedBindings: compilation.evidence.bindings,
            fusedSqlUtf8Bytes: compilation.evidence.sqlBytes,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
  });

  it.each([
    ["zero qualified pages", false],
    ["zero activities", true],
  ] as const)(
    "keeps the empty summary contract for %s",
    async (label, empty) => {
      const emptyDatabase = createFixture();
      if (empty) {
        emptyDatabase.exec(
          "UPDATE visits SET started_at = 1; UPDATE custom_events SET occurred_at = 1",
        );
      }
      const dsl = empty
        ? 'count(page { page.path eq "/scoped" }) eq 1'
        : 'count(page { page.path eq "/not-present" }) eq 1';
      const prepared = prepareEventSummaryQuery(dsl);
      const trace = newTrace();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(emptyDatabase, trace),
        siteId: SITE_ID,
      }).resolve("event-summary");
      if (!provider)
        throw new Error(`wave94b_empty_summary_provider_missing:${label}`);
      const actual = await provider.execute(prepared as never);
      const baselineTrace = newTrace();
      const baseline = await executeLegacyEventSummaryRequest({
        env: testEnv(emptyDatabase, baselineTrace),
        prepared,
      });
      const expected = eventSummaryDto(baseline);
      expect(actual.value).toEqual(expected);
      expect(actual.value).toMatchObject({
        summary: {
          events: 0,
          eventTypes: 0,
          sessions: 0,
          visitors: 0,
          avgEventsPerSession: 0,
        },
        cards: {
          event: { name: [] },
          page: { hostname: [], path: [], title: [] },
        },
      });
      expect(trace.preparedSql).toHaveLength(2);
    },
  );

  it("preserves an ordinary Event Count qualification after Page Count coverage", async () => {
    const prepared = prepareEventSummaryQuery(
      'count(event { event.name eq "alpha" }) eq 2',
    );
    const trace = newTrace();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE_ID,
    }).resolve("event-summary");
    if (!provider) throw new Error("wave94b_event_count_provider_missing");
    const actual = await provider.execute(prepared as never);
    const baselineTrace = newTrace();
    const baseline = await executeLegacyEventSummaryRequest({
      env: testEnv(database, baselineTrace),
      prepared,
    });
    expect(baselineTrace.preparedSql.length).toBeGreaterThan(2);
    expect(actual.value).toEqual(eventSummaryDto(baseline));
    expect(
      (actual.value as { readonly summary: { readonly events: number } })
        .summary.events,
    ).toBe(2);
    expect(trace.preparedSql).toHaveLength(2);
  });

  it.each([
    [
      "native Event Count AND",
      'count(event { event.name eq "alpha" }) gte 1 AND event.name eq "alpha"',
    ],
    [
      "top-level mixed OR and NOT",
      'count(event { event.name eq "alpha" }) gte 1 OR NOT (event.name eq "alpha")',
    ],
  ] as const)(
    "executes summary cards from an Event candidate for %s",
    async (label, dsl) => {
      const prepared = prepareEventSummaryQuery(dsl, "event");
      const trace = newTrace();
      const registry = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE_ID,
      });
      let deferred:
        | ReturnType<typeof deferredEventSummaryQualificationFromQuery>
        | undefined;
      let compilation:
        ReturnType<typeof compileEventSummaryQualificationProgram> | undefined;
      registry.useMiddleware(async (_operation, input, next) => {
        deferred = deferredEventSummaryQualificationFromQuery(input);
        if (deferred)
          compilation = compileEventSummaryQualificationProgram(deferred);
        return next(input);
      });
      const provider = registry.resolve("event-summary");
      if (!provider)
        throw new Error("wave97eh_event_candidate_summary_provider_missing");
      const actual = await provider.execute(prepared as never);

      expect(deferred?.operation).toBe("event-summary");
      expect(deferred?.metadata.plan.scope).toBe("event");
      expect(deferred?.countInput).toMatchObject({
        scope: "event",
        candidateAnchor: { kind: "event-candidate" },
      });
      expect(compilation?.kind).toBe("compiled");
      if (compilation?.kind !== "compiled")
        throw new Error("wave97eh_event_candidate_summary_compile_unavailable");
      expect(trace.preparedSql).toHaveLength(2);
      expect(trace.preparedSql[1]).toBe(compilation.evidence.sql);
      expect(trace.bindings[1]).toEqual(compilation.evidence.bindings);
      expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
      expect(compilation.evidence.groupedSummaryMaterializations).toHaveLength(
        2,
      );
      expect(
        compilation.evidence.groupedSummaryMaterializations?.every(
          (item) =>
            item.materialization === "materialized" && item.groupWidth <= 16,
        ),
      ).toBe(true);

      const nativeRows = database
        .prepare(compilation.evidence.sql)
        .all(...(compilation.evidence.bindings as SQLInputValue[])) as Record<
        string,
        unknown
      >[];
      const controlRows = nativeRows.filter((row) => row.rowKind === "control");
      const reportRows = nativeRows.filter((row) => row.rowKind === "report");
      expect(controlRows).toHaveLength(1);
      expect(controlRows[0]).toMatchObject({
        outputId: EVENT_SUMMARY_QUALIFICATION_CONTROL_OUTPUT,
        entityKind: "event",
        nullActivityIdCount: 0,
        siteIdentityMismatchCount: 0,
        invalidIdentityCount: 0,
        duplicateIdentityCount: 0,
      });
      const reportRowCounts = Object.fromEntries(
        Object.values(EVENT_SUMMARY_CARD_OUTPUTS).map((outputId) => [
          outputId,
          reportRows.filter((row) => row.outputId === outputId).length,
        ]),
      );
      expect(Object.keys(reportRowCounts).sort()).toEqual(
        Object.values(EVENT_SUMMARY_CARD_OUTPUTS).sort(),
      );
      expect(reportRowCounts[EVENT_SUMMARY_CARD_OUTPUTS.summary]).toBe(1);

      const baselineTrace = newTrace();
      const legacy = await executeLegacyEventSummaryRequest({
        env: testEnv(database, baselineTrace),
        prepared,
      });
      expect(baselineTrace.preparedSql.length).toBeGreaterThan(2);
      expect(actual.value).toEqual(eventSummaryDto(legacy));

      const actualDto = actual.value as ReturnType<typeof eventSummaryDto>;
      expect(actualDto.summary.events).toBeGreaterThan(0);
      expect(actualDto.cards.event.name.map(({ label }) => label)).toContain(
        "alpha",
      );

      writeEventSummaryCandidateEvidence(
        `${label === "native Event Count AND" ? "event-count-and" : "event-count-mixed-or-not"}.json`,
        {
          kind: "wave97eh-event-candidate-summary-cards-v1",
          label,
          dsl,
          scope: deferred?.countInput.scope,
          candidateAnchor: deferred?.countInput.candidateAnchor,
          compiled: compilation.evidence,
          groupedSummaryMaterializations:
            compilation.evidence.groupedSummaryMaterializations,
          controlRows,
          reportRowCounts,
          legacyCore: {
            statementCount: baselineTrace.preparedSql.length,
            statements: eventSummaryCandidateStatementEvidence(baselineTrace),
            dto: eventSummaryDto(legacy),
          },
          eventCandidate: {
            statementCount: trace.preparedSql.length,
            statements: eventSummaryCandidateStatementEvidence(trace),
            dto: actual.value,
          },
          dtoEqual: true,
        },
      );
    },
  );

  it("falls back to Core for an invalid numeric domain in an Event candidate", async () => {
    const numericDatabase = createFixture();
    numericDatabase
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-alpha-1");
    const prepared = prepareEventSummaryQuery(
      "count(page { page.durationMs gt 5 }) eq 1",
      "event",
    );
    const trace = newTrace();
    const diagnostics = createD1ReadDiagnostics();
    const registry = createD1SiteProviderRegistry({
      env: testEnv(numericDatabase, trace),
      siteId: SITE_ID,
      diagnostics,
    });
    let deferred:
      ReturnType<typeof deferredEventSummaryQualificationFromQuery> | undefined;
    let compilation:
      ReturnType<typeof compileEventSummaryQualificationProgram> | undefined;
    registry.useMiddleware(async (_operation, input, next) => {
      deferred = deferredEventSummaryQualificationFromQuery(input);
      if (deferred)
        compilation = compileEventSummaryQualificationProgram(deferred);
      return next(input);
    });
    const provider = registry.resolve("event-summary");
    if (!provider)
      throw new Error("wave97eh_event_candidate_numeric_provider_missing");
    const actual = await provider.execute(prepared as never);

    expect(deferred?.countInput).toMatchObject({
      scope: "event",
      candidateAnchor: { kind: "event-candidate" },
    });
    expect(compilation?.kind).toBe("compiled");
    if (compilation?.kind !== "compiled")
      throw new Error("wave97eh_event_candidate_numeric_compile_unavailable");
    const nativeRows = numericDatabase
      .prepare(compilation.evidence.sql)
      .all(...(compilation.evidence.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const controlRows = nativeRows.filter((row) => row.rowKind === "control");
    const reportRows = nativeRows.filter((row) => row.rowKind === "report");
    expect(controlRows).toHaveLength(1);
    expect(
      Number(controlRows[0]?.invalidContextPageDurationMsCount),
    ).toBeGreaterThan(0);
    expect(reportRows).toHaveLength(0);
    expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });

    const baselineTrace = newTrace();
    const legacy = await executeLegacyEventSummaryRequest({
      env: testEnv(numericDatabase, baselineTrace),
      prepared,
    });
    expect(actual.value).toEqual(eventSummaryDto(legacy));
    expect(trace.preparedSql.length).toBeGreaterThan(2);

    writeEventSummaryCandidateEvidence(
      "event-candidate-numeric-fallback.json",
      {
        kind: "wave97eh-event-candidate-summary-numeric-fallback-v1",
        dsl: "count(page { page.durationMs gt 5 }) eq 1",
        scope: deferred?.countInput.scope,
        candidateAnchor: deferred?.countInput.candidateAnchor,
        compiled: compilation.evidence,
        controlRows,
        reportRowCount: reportRows.length,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        legacyCore: {
          statementCount: baselineTrace.preparedSql.length,
          statements: eventSummaryCandidateStatementEvidence(baselineTrace),
          dto: eventSummaryDto(legacy),
        },
        eventCandidateRequest: {
          statementCount: trace.preparedSql.length,
          statements: eventSummaryCandidateStatementEvidence(trace),
          dto: actual.value,
        },
        dtoEqual: true,
      },
    );
  });

  it("rejects accessor and mismatched Event summary request state before reads", async () => {
    const prepared = prepareEventSummaryQuery(
      'count(event { event.name eq "alpha" }) gte 1',
      "event",
    );
    const accessorTrace = newTrace();
    const accessorRequest = { ...prepared } as typeof prepared;
    let getterReads = 0;
    let accessorNextEntered = false;
    Object.defineProperty(accessorRequest, "filters", {
      enumerable: true,
      get() {
        getterReads += 1;
        return prepared.filters;
      },
    });
    const accessorMiddleware = d1AdvancedFilterMiddleware(
      testEnv(createFixture(), accessorTrace),
    );
    await expect(
      accessorMiddleware("event-summary", accessorRequest, async (query) => {
        accessorNextEntered = true;
        return query;
      }),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [
          {
            path: "query",
            code: "event_summary_qualification_request_own_data_required",
          },
        ],
      },
    });
    expect(getterReads).toBe(0);
    expect(accessorNextEntered).toBe(false);
    expect(accessorTrace.preparedSql).toHaveLength(0);

    const mismatchTrace = newTrace();
    const mismatchRequest = {
      ...prepared,
      time: createQueryTime(121, 130, "UTC", 500),
    };
    let mismatchNextEntered = false;
    const mismatchMiddleware = d1AdvancedFilterMiddleware(
      testEnv(createFixture(), mismatchTrace),
    );
    await expect(
      mismatchMiddleware("event-summary", mismatchRequest, async (query) => {
        mismatchNextEntered = true;
        return query;
      }),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [
          {
            path: "query",
            code: "event_summary_qualification_request_context_mismatch",
          },
        ],
      },
    });
    expect(mismatchNextEntered).toBe(false);
    expect(mismatchTrace.preparedSql).toHaveLength(0);

    writeEventSummaryCandidateEvidence("event-summary-request-safety.json", {
      kind: "wave97eh-event-summary-request-safety-v1",
      accessorRequest: {
        getterReads,
        nextEntered: accessorNextEntered,
        sqlStatementCount: accessorTrace.preparedSql.length,
        rejectionCode: "event_summary_qualification_request_own_data_required",
      },
      contextMismatch: {
        nextEntered: mismatchNextEntered,
        sqlStatementCount: mismatchTrace.preparedSql.length,
        rejectionCode: "event_summary_qualification_request_context_mismatch",
      },
    });
  });

  it("keeps payload Count on the static legacy path", async () => {
    const prepared = prepareEventSummaryQuery(
      'count(event { event.name eq "alpha" AND event.payload("/missing") eq "x" }) eq 1',
    );
    const trace = newTrace();
    const registry = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE_ID,
    });
    let deferred: boolean | undefined;
    registry.useMiddleware(async (_operation, input, next) => {
      deferred =
        deferredEventSummaryQualificationFromQuery(input) !== undefined;
      return next(input);
    });
    const provider = registry.resolve("event-summary");
    if (!provider)
      throw new Error("wave94b_payload_static_path_provider_missing");
    const actual = await provider.execute(prepared as never);
    expect(deferred).toBe(false);
    expect(actual.value).toMatchObject({
      summary: { events: 0 },
      cards: {
        event: { name: [] },
        page: { hostname: [], path: [], title: [] },
      },
    });
    expect(trace.preparedSql.length).toBeGreaterThan(2);
  });

  it("falls back before executing the combined report when compilation exceeds D1 budget", async () => {
    const terms = Array.from(
      { length: D1_MAX_BOUND_PARAMETERS + 1 },
      (_, index) => `page.path contains ${JSON.stringify(`/budget-${index}`)}`,
    ).join(" OR ");
    const prepared = prepareEventSummaryQuery(`count(page { ${terms} }) eq 1`);
    const trace = newTrace();
    const diagnostics = createD1ReadDiagnostics();
    const registry = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE_ID,
      diagnostics,
    });
    let compilation:
      ReturnType<typeof compileEventSummaryQualificationProgram> | undefined;
    registry.useMiddleware(async (_operation, input, next) => {
      const deferred = deferredEventSummaryQualificationFromQuery(input);
      if (deferred)
        compilation = compileEventSummaryQualificationProgram(deferred);
      return next(input);
    });
    const provider = registry.resolve("event-summary");
    if (!provider) throw new Error("wave94b_budget_fallback_provider_missing");
    const actual = await provider.execute(prepared as never);
    expect(compilation?.kind).toBe("unavailable");
    if (compilation?.kind !== "unavailable")
      throw new Error("wave94b_budget_fallback_did_not_refuse");
    expect(compilation.fallbackReason.kind).toBe("compile-budget");
    expect(diagnostics.advancedCountSqlFallbackReason?.kind).toBe(
      "compile-budget",
    );
    expect(actual.value).toMatchObject({ summary: { events: 0 } });
    expect(trace.preparedSql.length).toBeGreaterThan(2);

    const evidencePath = process.env.WAVE94B_REPAIR_BUDGET_EVIDENCE_PATH;
    if (evidencePath) {
      const absoluteEvidencePath = resolve(evidencePath);
      mkdirSync(dirname(absoluteEvidencePath), { recursive: true });
      writeFileSync(
        absoluteEvidencePath,
        JSON.stringify(
          {
            kind: "wave94b-compile-budget-preexecution-fallback",
            scope: "session",
            compilerFallbackReason: compilation.fallbackReason,
            diagnosticsFallbackReason:
              diagnostics.advancedCountSqlFallbackReason,
            statementCount: trace.preparedSql.length,
            statements: trace.preparedSql.map((sql, index) => ({
              sql,
              bindings: trace.bindings[index],
              sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
              sha256: createHash("sha256").update(sql).digest("hex"),
            })),
            dto: actual.value,
          },
          null,
          2,
        ),
        "utf8",
      );
    }
  });

  it("does not swallow cancellation of the qualified event-summary request", async () => {
    const prepared = prepareEventSummaryQuery(
      'count(page { page.path eq "/scoped" }) eq 1',
    );
    const trace = newTrace();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE_ID,
    }).resolve("event-summary");
    if (!provider)
      throw new Error("wave94b_cancelled_request_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.execute(prepared as never, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not swallow a real SQLite failure from the qualified report", async () => {
    const brokenDatabase = createFixture();
    brokenDatabase.exec("DROP TABLE custom_events");
    const prepared = prepareEventSummaryQuery(
      'count(page { page.path eq "/scoped" }) eq 1',
    );
    const trace = newTrace();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(brokenDatabase, trace),
      siteId: SITE_ID,
    }).resolve("event-summary");
    if (!provider) throw new Error("wave94b_database_error_provider_missing");
    await expect(provider.execute(prepared as never)).rejects.toThrow(
      /no such table: custom_events/u,
    );
  });

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
