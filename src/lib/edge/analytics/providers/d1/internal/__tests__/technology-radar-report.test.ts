import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  D1StatementBudgetError,
} from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import type {
  FilterDocument,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryBrowserRadarFromD1,
  queryReferrerRadarFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/radar";
import { technologyVisitSource } from "@/lib/edge/analytics/providers/d1/internal/technology/scoped-source";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE = "technology-radar-budget-site";
const WINDOW: QueryWindow = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 500,
  timeZone: "UTC",
};
const FILTERED_SITE = "technology-radar-site";
const OTHER_SITE = "technology-radar-other-site";

interface Site {
  readonly id: string;
  readonly pk: number;
}

interface VisitFixture {
  readonly id: string;
  readonly site?: Site;
  readonly visitor: string;
  readonly session: string;
  readonly time?: number;
  readonly browser: string;
  readonly referrer: string;
  readonly duration?: number | null;
  readonly pathname?: string;
}

interface CapturedStatement {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

interface ComparableRadarRow {
  readonly browser?: string;
  readonly referrer?: string;
  readonly sessions: number;
  readonly bounces: number;
  readonly avgDurationMs: number;
  readonly avgDepth: number;
  readonly visitors: number;
  readonly returningVisitors: number;
  readonly avgFrequency: number;
  readonly trafficShare: number;
}

function mapLegacyRows(
  rows: readonly Record<string, unknown>[],
  dimension: "browser" | "referrer",
): ComparableRadarRow[] {
  return rows
    .map((row): ComparableRadarRow => ({
      ...(dimension === "browser"
        ? { browser: String(row.browser ?? "").trim() }
        : { referrer: String(row.referrer ?? "").trim() }),
      sessions: Number(row.sessions ?? 0),
      bounces: Number(row.bounces ?? 0),
      avgDurationMs: Number(row.avgDurationMs ?? 0),
      avgDepth: Number(row.avgDepth ?? 0),
      visitors: Number(row.visitors ?? 0),
      returningVisitors: Number(row.returningVisitors ?? 0),
      avgFrequency: Number(row.avgFrequency ?? 0),
      trafficShare: Number(row.trafficShare ?? 0),
    }))
    .filter(
      (row) =>
        (dimension === "browser" ? row.browser!.length > 0 : true) &&
        row.visitors > 0,
    );
}

function sortBrowserRows(rows: readonly ComparableRadarRow[]) {
  return [...rows].sort((left, right) =>
    left.browser!.localeCompare(right.browser!),
  );
}

function capturedSqlEnv(statements: CapturedStatement[]): Env {
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: unknown[]) => ({
          all: async () => {
            statements.push({ sql, bindings });
            return { success: true, results: [] };
          },
        }),
      }),
    },
  } as unknown as Env;
}

let database: DatabaseSync;
let site: Site;
let otherSite: Site;

function addSite(db: DatabaseSync, id: string): Site {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: Number(row.site_pk) };
}

function addVisit(db: DatabaseSync, input: VisitFixture): void {
  const owner = input.site ?? site;
  const time = input.time ?? 120;
  db.prepare(
    `
    INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname, duration_ms,
      browser, referrer_host
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'radar.test', ?, ?, ?)
  `,
  ).run(
    input.id,
    owner.id,
    owner.pk,
    input.visitor,
    input.session,
    time,
    time,
    input.pathname ?? "/included",
    input.duration === undefined ? 50 : input.duration,
    input.browser,
    input.referrer,
  );
}

function sqliteEnv(db: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(db, trace) } as unknown as Env;
}

async function compileOnly(
  label: string,
  invoke: (env: Env) => Promise<unknown>,
) {
  const statements: CapturedStatement[] = [];
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  let failure: unknown;
  try {
    await runWithInvocationLogger(logger, () =>
      runWithD1Operation(`wave53.technology_radar.${label}`, () =>
        invoke(instrumentEnv(capturedSqlEnv(statements), logger)),
      ),
    );
  } catch (error) {
    failure = error;
  }
  const mutedLoggerOutput = vi
    .spyOn(console, "log")
    .mockImplementation(() => {});
  let record: Awaited<ReturnType<typeof logger.emitWhenComplete>>;
  try {
    record = await logger.emitWhenComplete();
  } finally {
    mutedLoggerOutput.mockRestore();
  }
  const observation = record.logs.find(
    (entry) =>
      entry.message === "db.query.v1.all.success" &&
      entry.data?.tag === `wave53.technology_radar.${label}`,
  );
  if (failure && !(failure instanceof D1StatementBudgetError)) throw failure;
  return {
    statements,
    record,
    observation: observation?.data,
    budgetFailure:
      failure instanceof D1StatementBudgetError
        ? { item: failure.item, actual: failure.actual, limit: failure.limit }
        : undefined,
  };
}

function seedRadarFixture(db: DatabaseSync): void {
  const visits: VisitFixture[] = [
    {
      id: "alpha-1",
      visitor: "shared",
      session: "a1",
      browser: "Alpha",
      referrer: "z.test",
      duration: 80,
    },
    {
      id: "alpha-2",
      visitor: "shared",
      session: "a1",
      browser: "Alpha",
      referrer: "z.test",
      duration: -9,
    },
    {
      id: "alpha-3",
      visitor: "alpha-only",
      session: "a2",
      browser: "Alpha",
      referrer: "z.test",
      duration: 20,
    },
    {
      id: "alpha-4",
      visitor: "shared",
      session: "a3",
      browser: "Alpha",
      referrer: "z.test",
      duration: null,
    },
    {
      id: "beta-1",
      visitor: "shared",
      session: "b1",
      browser: "Beta",
      referrer: "a.test",
      duration: 35,
    },
    {
      id: "beta-2",
      visitor: "beta-only",
      session: "b2",
      browser: "Beta",
      referrer: "a.test",
      duration: 65,
    },
    {
      id: "beta-3",
      visitor: "beta-only",
      session: "b2",
      browser: "Beta",
      referrer: "a.test",
      duration: 10,
    },
    {
      id: "gamma-1",
      visitor: "shared",
      session: "g1",
      browser: "Gamma",
      referrer: "m.test",
    },
    {
      id: "gamma-2",
      visitor: "gamma-only",
      session: "g2",
      browser: "Gamma",
      referrer: "m.test",
    },
    {
      id: "no-session",
      visitor: "no-session-visitor",
      session: "",
      browser: "NoSession",
      referrer: "no-session.test",
    },
    {
      id: "no-visitor",
      visitor: "",
      session: "no-visitor-session",
      browser: "NoVisitor",
      referrer: "no-visitor.test",
    },
    {
      id: "empty-browser",
      visitor: "empty-browser-v",
      session: "empty-browser-s",
      browser: "",
      referrer: "",
    },
    {
      id: "space-browser",
      visitor: "space-browser-v",
      session: "space-browser-s",
      browser: "  ",
      referrer: "  ",
    },
    {
      id: "tab-browser",
      visitor: "tab-browser-v",
      session: "tab-browser-s",
      browser: "\t",
      referrer: "\t",
    },
    {
      id: "nbsp-browser",
      visitor: "nbsp-browser-v",
      session: "nbsp-browser-s",
      browser: "\u00a0",
      referrer: "\u00a0",
    },
    {
      id: "space-identities",
      visitor: " ",
      session: " ",
      browser: "Alpha",
      referrer: "space.test",
    },
    {
      id: "outside-window",
      visitor: "outside",
      session: "outside-s",
      browser: "Outside",
      referrer: "outside.test",
      time: 200,
    },
    {
      id: "other-site",
      site: otherSite,
      visitor: "other",
      session: "other-s",
      browser: "Other",
      referrer: "other.test",
    },
    {
      id: "excluded-path",
      visitor: "excluded",
      session: "excluded-s",
      browser: "Excluded",
      referrer: "excluded.test",
      pathname: "/excluded",
    },
  ];
  for (const visit of visits) addVisit(db, visit);
}

function seedFortyPayloadExistsEvent(db: DatabaseSync): void {
  const eventTime = WINDOW.startMs + 40;
  db.prepare(
    `
    INSERT INTO custom_event_names (site_id, name, last_seen_at, site_pk)
    VALUES (?, ?, ?, ?)
  `,
  ).run(FILTERED_SITE, "technology-radar-payload", eventTime, site.pk);
  const eventName = db
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(site.pk, "technology-radar-payload") as { readonly id: number };
  const paths = Array.from({ length: 40 }, (_unused, index) => {
    const path = `/technology-radar-${index}`;
    db.prepare(
      `
      INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run(FILTERED_SITE, site.pk, path, eventTime);
    const pathRow = db
      .prepare(
        "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
      )
      .get(site.pk, path) as { readonly id: number };
    return Number(pathRow.id);
  });
  db.prepare(
    `
    INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `,
  ).run(
    "technology-radar-payload-event",
    FILTERED_SITE,
    site.pk,
    "alpha-1",
    eventName.id,
    eventTime,
    eventTime,
    paths.length,
    paths.length,
  );
  const event = db
    .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
    .get("technology-radar-payload-event") as { readonly event_pk: number };
  const insertNode = db.prepare(`
    INSERT INTO custom_event_json_nodes (event_pk, node_id, path_id, value_type, depth)
    VALUES (?, ?, ?, 1, 1)
  `);
  const insertValue = db.prepare(`
    INSERT INTO custom_event_json_values (
      event_pk, node_id, site_id, site_pk, event_name_id, path_id,
      occurred_at, value_type, string_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  for (const [index, pathId] of paths.entries()) {
    const nodeId = index + 1;
    insertNode.run(event.event_pk, nodeId, pathId);
    insertValue.run(
      event.event_pk,
      nodeId,
      FILTERED_SITE,
      site.pk,
      eventName.id,
      pathId,
      eventTime,
      `value-${index}`,
    );
  }
}

function directPayloadExistsFilters(): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "and",
        children: Array.from({ length: 40 }, (_unused, index) => ({
          kind: "condition" as const,
          target: {
            kind: "event-payload" as const,
            path: `/technology-radar-${index}`,
          },
          operator: "exists" as const,
        })),
      },
    },
    analyticsFilterRegistry,
  );
}

function directPayloadEqFilters(): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "and",
        children: Array.from({ length: 40 }, (_unused, index) => ({
          kind: "condition" as const,
          target: {
            kind: "event-payload" as const,
            path: `/technology-radar-${index}`,
          },
          operator: "eq" as const,
          value: `value-${index}`,
        })),
      },
    },
    analyticsFilterRegistry,
  );
}

function pagePathFilter(pathname: string): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "eq",
        value: pathname,
      },
    },
    analyticsFilterRegistry,
  );
}

function prepareRadarFilters(
  filters: FilterDocument,
  siteId = FILTERED_SITE,
  scope: "event" | "session" | "visitor" = "event",
): { readonly filters: FilterDocument; readonly scopePlan: ScopedFilterPlan } {
  const prepared = prepareScopedQuery("radar", {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: createQueryTime(90, 210, "UTC", WINDOW.nowMs),
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("technology_radar_prepared_scope_missing");
  return { filters: prepared.filters, scopePlan: prepared.scopePlan };
}

function withAdvancedMatches(
  prepared: {
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
  },
  advancedMatches: NonNullable<ScopedFilterPlan["advancedMatches"]>,
): FilterDocument {
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("technology_radar_prepared_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: { ...prepared.scopePlan, advancedMatches },
  });
}

function legacyRadarSql(
  dimension: "browser" | "referrer",
  filters: FilterDocument,
  limit = 10,
  window: QueryWindow = WINDOW,
) {
  const source = technologyVisitSource(FILTERED_SITE, window, filters);
  const sql =
    dimension === "browser"
      ? `
WITH
${source.ctes},

filtered_visits AS MATERIALIZED (
  SELECT
    visit_id,
    visitor_id,
    session_id,
    TRIM(COALESCE(browser, '')) AS browser,
    CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0
         THEN duration_ms ELSE 0 END AS safe_duration_ms
  FROM ${source.relation}
  ${source.filterClause}
),

session_level AS (
  SELECT
    browser,
    session_id,
    count(*) AS visit_count,
    sum(safe_duration_ms) AS session_duration
  FROM filtered_visits
  WHERE browser != '' AND session_id != ''
  GROUP BY browser, session_id
),

browser_session_agg AS (
  SELECT
    browser,
    count(*) AS sessions,
    sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END) AS bounces,
    CASE WHEN count(*) > 0
         THEN CAST(sum(session_duration) AS REAL) / count(*)
         ELSE 0 END AS avgDurationMs,
    CASE WHEN count(*) > 0
         THEN CAST(sum(visit_count) AS REAL) / count(*)
         ELSE 0 END AS avgDepth
  FROM session_level
  GROUP BY browser
),

visitor_level AS (
  SELECT
    browser,
    visitor_id,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS session_count
  FROM filtered_visits
  WHERE browser != '' AND visitor_id != ''
  GROUP BY browser, visitor_id
),

browser_visitor_agg AS (
  SELECT
    browser,
    count(*) AS visitors,
    sum(CASE WHEN session_count > 1 THEN 1 ELSE 0 END) AS returningVisitors,
    CASE WHEN count(*) > 0
         THEN CAST(sum(session_count) AS REAL) / count(*)
         ELSE 0 END AS avgFrequency
  FROM visitor_level
  GROUP BY browser
),

total_visitors AS (
  SELECT count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS total
  FROM filtered_visits
  WHERE browser != ''
)

SELECT
  bsa.browser,
  bsa.sessions,
  bsa.bounces,
  bsa.avgDurationMs,
  bsa.avgDepth,
  bva.visitors,
  bva.returningVisitors,
  bva.avgFrequency,
  CASE WHEN tv.total > 0
       THEN CAST(bva.visitors AS REAL) / tv.total
       ELSE 0 END AS trafficShare
FROM browser_session_agg bsa
INNER JOIN browser_visitor_agg bva ON bsa.browser = bva.browser
CROSS JOIN total_visitors tv
ORDER BY bva.visitors DESC
`
      : `
WITH
${source.ctes},

filtered_visits AS MATERIALIZED (
  SELECT
    visit_id,
    visitor_id,
    session_id,
    TRIM(COALESCE(referrer_host, '')) AS referrer,
    CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0
         THEN duration_ms ELSE 0 END AS safe_duration_ms
  FROM ${source.relation}
  ${source.filterClause}
),

session_level AS (
  SELECT
    referrer,
    session_id,
    count(*) AS visit_count,
    sum(safe_duration_ms) AS session_duration
  FROM filtered_visits
  WHERE session_id != ''
  GROUP BY referrer, session_id
),

referrer_session_agg AS (
  SELECT
    referrer,
    count(*) AS sessions,
    sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END) AS bounces,
    CASE WHEN count(*) > 0
         THEN CAST(sum(session_duration) AS REAL) / count(*)
         ELSE 0 END AS avgDurationMs,
    CASE WHEN count(*) > 0
         THEN CAST(sum(visit_count) AS REAL) / count(*)
         ELSE 0 END AS avgDepth
  FROM session_level
  GROUP BY referrer
),

visitor_level AS (
  SELECT
    referrer,
    visitor_id,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS session_count
  FROM filtered_visits
  WHERE visitor_id != ''
  GROUP BY referrer, visitor_id
),

referrer_visitor_agg AS (
  SELECT
    referrer,
    count(*) AS visitors,
    sum(CASE WHEN session_count > 1 THEN 1 ELSE 0 END) AS returningVisitors,
    CASE WHEN count(*) > 0
         THEN CAST(sum(session_count) AS REAL) / count(*)
         ELSE 0 END AS avgFrequency
  FROM visitor_level
  GROUP BY referrer
),

total_visitors AS (
  SELECT count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS total
  FROM filtered_visits
)

SELECT
  rsa.referrer,
  rsa.sessions,
  rsa.bounces,
  rsa.avgDurationMs,
  rsa.avgDepth,
  rva.visitors,
  rva.returningVisitors,
  rva.avgFrequency,
  CASE WHEN tv.total > 0
       THEN CAST(rva.visitors AS REAL) / tv.total
       ELSE 0 END AS trafficShare
FROM referrer_session_agg rsa
INNER JOIN referrer_visitor_agg rva ON rsa.referrer = rva.referrer
CROSS JOIN total_visitors tv
ORDER BY rva.visitors DESC, rsa.sessions DESC, rsa.referrer ASC
LIMIT ?
`;
  return {
    sql,
    bindings: [
      ...source.bindings,
      ...source.filterBindings,
      ...(dimension === "referrer" ? [limit] : []),
    ],
  };
}

describe("technology radar report", () => {
  beforeAll(() => {
    database = createMigratedDatabase();
    site = addSite(database, FILTERED_SITE);
    otherSite = addSite(database, OTHER_SITE);
    seedRadarFixture(database);
    seedFortyPayloadExistsEvent(database);
  });

  afterAll(() => database.close());

  it("matches the legacy visitor and session bags, denominator, and ordering", async () => {
    const emptyFilters = normalizeFilterDocument(
      { version: 1, root: null },
      analyticsFilterRegistry,
    );
    const oldBrowser = legacyRadarSql("browser", emptyFilters);
    const expectedBrowser = database
      .prepare(oldBrowser.sql)
      .all(...oldBrowser.bindings) as Record<string, unknown>[];
    const oldReferrer = legacyRadarSql("referrer", emptyFilters, -1);
    const expectedReferrer = database
      .prepare(oldReferrer.sql)
      .all(...oldReferrer.bindings) as Record<string, unknown>[];
    const browserTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const referrerTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const actualBrowser = await queryBrowserRadarFromD1(
      sqliteEnv(database, browserTrace),
      FILTERED_SITE,
      WINDOW,
      emptyFilters,
    );
    const actualReferrer = await queryReferrerRadarFromD1(
      sqliteEnv(database, referrerTrace),
      FILTERED_SITE,
      WINDOW,
      emptyFilters,
      -1,
    );
    const expectedBrowserRows = mapLegacyRows(expectedBrowser, "browser");
    const expectedReferrerRows = mapLegacyRows(expectedReferrer, "referrer");
    expect(sortBrowserRows(actualBrowser)).toEqual(
      sortBrowserRows(expectedBrowserRows),
    );
    expect(actualReferrer).toEqual(expectedReferrerRows);
    expect(actualBrowser.find((row) => row.browser === "Alpha")).toMatchObject({
      sessions: 4,
      bounces: 3,
      avgDurationMs: 150 / 4,
      avgDepth: 5 / 4,
      visitors: 3,
      returningVisitors: 1,
      avgFrequency: 4 / 3,
      trafficShare: 3 / 9,
    });
    expect(browserTrace.preparedSql).toHaveLength(1);
    expect(referrerTrace.preparedSql).toHaveLength(1);

    const zeroLimit = legacyRadarSql("referrer", emptyFilters, 0);
    const actualZeroLimit = await queryReferrerRadarFromD1(
      sqliteEnv(database),
      FILTERED_SITE,
      WINDOW,
      emptyFilters,
      0,
    );
    expect(actualZeroLimit).toEqual(
      mapLegacyRows(
        database.prepare(zeroLimit.sql).all(...zeroLimit.bindings) as Record<
          string,
          unknown
        >[],
        "referrer",
      ),
    );
    expect(actualZeroLimit).toEqual([]);
    const fractionalLimit = legacyRadarSql("referrer", emptyFilters, 0.5);
    expect(() =>
      database.prepare(fractionalLimit.sql).all(...fractionalLimit.bindings),
    ).toThrow();
    await expect(
      queryReferrerRadarFromD1(
        sqliteEnv(database),
        FILTERED_SITE,
        WINDOW,
        emptyFilters,
        0.5,
      ),
    ).rejects.toThrow();
  });

  it("matches ordinary Page filters for both radar dimensions", async () => {
    const filters = normalizeFilterDocument(
      {
        version: 1,
        root: {
          kind: "condition",
          target: { kind: "field", field: "page.path" },
          operator: "eq",
          value: "/excluded",
        },
      },
      analyticsFilterRegistry,
    );
    const oldBrowser = legacyRadarSql("browser", filters);
    const oldReferrer = legacyRadarSql("referrer", filters, -1);
    const actualBrowser = await queryBrowserRadarFromD1(
      sqliteEnv(database),
      FILTERED_SITE,
      WINDOW,
      filters,
    );
    const actualReferrer = await queryReferrerRadarFromD1(
      sqliteEnv(database),
      FILTERED_SITE,
      WINDOW,
      filters,
      -1,
    );
    expect(sortBrowserRows(actualBrowser)).toEqual(
      sortBrowserRows(
        mapLegacyRows(
          database
            .prepare(oldBrowser.sql)
            .all(...oldBrowser.bindings) as Record<string, unknown>[],
          "browser",
        ),
      ),
    );
    expect(actualReferrer).toEqual(
      mapLegacyRows(
        database
          .prepare(oldReferrer.sql)
          .all(...oldReferrer.bindings) as Record<string, unknown>[],
        "referrer",
      ),
    );
    expect(actualBrowser.map((row) => row.browser)).toEqual(["Excluded"]);
  });

  it("records plain, direct payload, and prepared identity compile evidence", async () => {
    const plain = normalizeFilterDocument(
      { version: 1, root: null },
      analyticsFilterRegistry,
    );
    const prepared = prepareRadarFilters(
      normalizeFilterDocument(
        {
          version: 1,
          root: {
            kind: "condition",
            target: { kind: "field", field: "page.path" },
            operator: "eq",
            value: "/included",
          },
        },
        analyticsFilterRegistry,
      ),
    );
    const prepared128 = withAdvancedMatches(prepared, {
      visitIds: [
        { siteId: FILTERED_SITE, id: "alpha-1" },
        ...Array.from({ length: 127 }, (_unused, index) => ({
          siteId: FILTERED_SITE,
          id: `missing-radar-page-${index}`,
        })),
      ],
    });
    const exists = directPayloadExistsFilters();
    const eq = directPayloadEqFilters();
    const samples = [
      {
        label: "plain-browser",
        invoke: (env: Env) =>
          queryBrowserRadarFromD1(env, FILTERED_SITE, WINDOW, plain),
        limitExpected: true,
      },
      {
        label: "direct-40-exists-browser",
        invoke: (env: Env) =>
          queryBrowserRadarFromD1(env, FILTERED_SITE, WINDOW, exists),
        limitExpected: true,
      },
      {
        label: "direct-40-exists-referrer",
        invoke: (env: Env) =>
          queryReferrerRadarFromD1(env, FILTERED_SITE, WINDOW, exists, 10),
        limitExpected: true,
      },
      {
        label: "direct-40-eq-browser",
        invoke: (env: Env) =>
          queryBrowserRadarFromD1(env, FILTERED_SITE, WINDOW, eq),
        limitExpected: false,
      },
      {
        label: "prepared-page-128-browser",
        invoke: (env: Env) =>
          queryBrowserRadarFromD1(env, FILTERED_SITE, WINDOW, prepared128),
        limitExpected: true,
      },
    ] as const;
    const evidence = [] as Array<Record<string, unknown>>;
    for (const { label, invoke, limitExpected } of samples) {
      const result = await compileOnly(label, invoke);
      if (result.statements.length > 0) {
        expect(result.statements).toHaveLength(1);
        const statement = result.statements[0]!;
        const sqlBytes = new TextEncoder().encode(statement.sql).byteLength;
        expect(result.observation).toMatchObject({
          tag: `wave53.technology_radar.${label}`,
          operation: "all",
          status: "success",
          sqlBytes,
          bindings: statement.bindings.length,
          physicalPlanHash: expect.stringMatching(/^v\d+:[a-f0-9]{64}$/u),
        });
        if (limitExpected) {
          expect(sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
          expect(statement.bindings.length).toBeLessThanOrEqual(
            D1_MAX_BOUND_PARAMETERS,
          );
        }
        evidence.push({
          label,
          statementCount: result.statements.length,
          sqlBytes,
          bindings: statement.bindings.length,
          physicalPlanHash: result.observation?.physicalPlanHash,
          tag: result.observation?.tag,
        });
      } else {
        expect(result.budgetFailure).toBeDefined();
        const oldEq = legacyRadarSql("browser", eq);
        expect(oldEq.bindings.length).toBeGreaterThan(D1_MAX_BOUND_PARAMETERS);
        evidence.push({
          label,
          statementCount: result.record.performance.d1Statements,
          budgetFailure: result.budgetFailure,
          legacyBindings: oldEq.bindings.length,
        });
      }
    }
    expect(evidence).toHaveLength(samples.length);
  });

  it("keeps prepared scope identities and the actual Page reader window", async () => {
    const prepared = prepareRadarFilters(pagePathFilter("/included"));
    const preparedPageIds = withAdvancedMatches(prepared, {
      visitIds: [
        { siteId: FILTERED_SITE, id: "alpha-1" },
        ...Array.from({ length: 127 }, (_unused, index) => ({
          siteId: FILTERED_SITE,
          id: `missing-radar-actual-${index}`,
        })),
      ],
    });
    const actualTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const actual = await queryBrowserRadarFromD1(
      sqliteEnv(database, actualTrace),
      FILTERED_SITE,
      WINDOW,
      preparedPageIds,
    );
    expect(actual).toMatchObject([
      {
        browser: "Alpha",
        sessions: 1,
        visitors: 1,
        avgDepth: 1,
        trafficShare: 1,
      },
    ]);
    expect(actualTrace.preparedSql).toHaveLength(1);
    expect(actualTrace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );

    const noPreparedPages = withAdvancedMatches(prepared, { visitIds: [] });
    expect(
      await queryBrowserRadarFromD1(
        sqliteEnv(database),
        FILTERED_SITE,
        WINDOW,
        noPreparedPages,
      ),
    ).toEqual([]);

    const preparedEventIds = withAdvancedMatches(prepared, {
      visitIds: [{ siteId: FILTERED_SITE, id: "alpha-1" }],
      eventIds: [
        { siteId: FILTERED_SITE, id: "technology-radar-payload-event" },
      ],
    });
    expect(
      await queryBrowserRadarFromD1(
        sqliteEnv(database),
        FILTERED_SITE,
        WINDOW,
        preparedEventIds,
      ),
    ).toMatchObject([
      {
        browser: "Alpha",
        sessions: 1,
        visitors: 1,
        avgDepth: 1,
        trafficShare: 1,
      },
    ]);
    const noPreparedPageOrEvent = withAdvancedMatches(prepared, {
      visitIds: [],
      eventIds: [
        { siteId: FILTERED_SITE, id: "technology-radar-payload-event" },
      ],
    });
    expect(
      await queryBrowserRadarFromD1(
        sqliteEnv(database),
        FILTERED_SITE,
        WINDOW,
        noPreparedPageOrEvent,
      ),
    ).toEqual([]);

    const preparedOutsideWindow = withAdvancedMatches(prepared, {
      visitIds: [{ siteId: FILTERED_SITE, id: "outside-window" }],
    });
    expect(
      await queryBrowserRadarFromD1(
        sqliteEnv(database),
        FILTERED_SITE,
        WINDOW,
        preparedOutsideWindow,
      ),
    ).toEqual([]);

    const preparedSession = prepareRadarFilters(
      pagePathFilter("/included"),
      FILTERED_SITE,
      "session",
    );
    const sessionScoped = withAdvancedMatches(preparedSession, {
      entityIds: [{ siteId: FILTERED_SITE, id: "a1" }],
    });
    expect(
      await queryBrowserRadarFromD1(
        sqliteEnv(database),
        FILTERED_SITE,
        WINDOW,
        sessionScoped,
      ),
    ).toMatchObject([
      {
        browser: "Alpha",
        sessions: 1,
        bounces: 0,
        avgDepth: 2,
        visitors: 1,
        trafficShare: 1,
      },
    ]);
    const emptyPreparedSession = withAdvancedMatches(preparedSession, {
      entityIds: [],
    });
    expect(
      await queryBrowserRadarFromD1(
        sqliteEnv(database),
        FILTERED_SITE,
        WINDOW,
        emptyPreparedSession,
      ),
    ).toEqual([]);

    const preparedVisitor = prepareRadarFilters(
      pagePathFilter("/included"),
      FILTERED_SITE,
      "visitor",
    );
    const visitorScoped = withAdvancedMatches(preparedVisitor, {
      entityIds: [{ siteId: FILTERED_SITE, id: "shared" }],
    });
    expect(
      (
        await queryBrowserRadarFromD1(
          sqliteEnv(database),
          FILTERED_SITE,
          WINDOW,
          visitorScoped,
        )
      ).map((row) => row.browser),
    ).toEqual(["Alpha", "Beta", "Gamma"]);
    const emptyPreparedVisitor = withAdvancedMatches(preparedVisitor, {
      entityIds: [],
    });
    expect(
      await queryBrowserRadarFromD1(
        sqliteEnv(database),
        FILTERED_SITE,
        WINDOW,
        emptyPreparedVisitor,
      ),
    ).toEqual([]);

    const foreignSitePrepared = prepareRadarFilters(
      pagePathFilter("/included"),
      OTHER_SITE,
    );
    const foreignSiteMatches = withAdvancedMatches(foreignSitePrepared, {
      visitIds: [{ siteId: OTHER_SITE, id: "other-site" }],
    });
    await expect(
      queryBrowserRadarFromD1(
        sqliteEnv(database),
        FILTERED_SITE,
        WINDOW,
        foreignSiteMatches,
      ),
    ).rejects.toThrow();
  });

  it("keeps direct 40-payload-exists old and new statement budgets within limits", async () => {
    const filters = directPayloadExistsFilters();
    const legacy = [
      legacyRadarSql("browser", filters),
      legacyRadarSql("referrer", filters),
    ];
    const current: CapturedStatement[][] = [[], []];
    await queryBrowserRadarFromD1(
      capturedSqlEnv(current[0]!),
      FILTERED_SITE,
      WINDOW,
      filters,
    );
    await queryReferrerRadarFromD1(
      capturedSqlEnv(current[1]!),
      FILTERED_SITE,
      WINDOW,
      filters,
      10,
    );

    const legacyBrowserRows = database
      .prepare(legacy[0]!.sql)
      .all(...legacy[0]!.bindings) as Record<string, unknown>[];
    const legacyReferrerRows = database
      .prepare(legacy[1]!.sql)
      .all(...legacy[1]!.bindings) as Record<string, unknown>[];
    const browserTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const referrerTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const browserRows = await queryBrowserRadarFromD1(
      sqliteEnv(database, browserTrace),
      FILTERED_SITE,
      WINDOW,
      filters,
    );
    const referrerRows = await queryReferrerRadarFromD1(
      sqliteEnv(database, referrerTrace),
      FILTERED_SITE,
      WINDOW,
      filters,
      10,
    );
    expect(sortBrowserRows(browserRows)).toEqual(
      sortBrowserRows(mapLegacyRows(legacyBrowserRows, "browser")),
    );
    expect(referrerRows).toEqual(mapLegacyRows(legacyReferrerRows, "referrer"));
    expect(browserTrace.preparedSql).toHaveLength(1);
    expect(referrerTrace.preparedSql).toHaveLength(1);

    expect(current.map((statements) => statements.length)).toEqual([1, 1]);
    for (const [index, statements] of current.entries()) {
      const statement = statements[0]!;
      const sqlBytes = new TextEncoder().encode(statement.sql).byteLength;
      expect(sqlBytes, `new reader ${index}`).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(
        statement.bindings.length,
        `new reader ${index}`,
      ).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(legacy[index]!.sql).toContain("filtered_visits AS MATERIALIZED");
      expect(
        new TextEncoder().encode(legacy[index]!.sql).byteLength,
        `legacy reader ${index}`,
      ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(
        legacy[index]!.bindings.length,
        `legacy reader ${index}`,
      ).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    }
  });
});
