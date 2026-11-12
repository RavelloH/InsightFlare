import type { DatabaseSync, SQLInputValue } from "node:sqlite";

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
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { CROSS_BREAKDOWN_DIMENSIONS } from "@/lib/edge/analytics/contract/dimensions";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { buildTechnologyReferrerChannelTrendPlan } from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import { technologyVisitSource } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-technology-scoped-source";
import type { PreparedMembershipFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import { preparedMembershipFromIds } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import type {
  BrowserVersionAggregateRow,
  BrowserVersionBreakdownRow,
  BrowserVersionSliceRow,
  FilterDocument,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  BROWSER_CROSS_OTHER_BROWSER_TOKEN,
  BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
  BROWSER_CROSS_UNKNOWN_TOKEN,
  BROWSER_VERSION_UNKNOWN_TOKEN,
  browserMajorVersionExpr,
  CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
  CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
  CLIENT_CROSS_UNKNOWN_TOKEN,
  clientDimensionDefinition,
  SHARE_TREND_OTHER_LABEL,
  shareTrendSeriesKey,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  resolveCrossBreakdownDimension,
  resolveCrossBreakdownPageDimension,
} from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import {
  queryBrowserCrossDimensionFromD1,
  queryBrowserVersionBreakdownFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/browser";
import { queryCrossDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/client-cross";
import {
  queryReferrerAndChannelTrendFromD1,
  queryShareTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "technology-share-trend-budget-site";
const WINDOW: QueryWindow = {
  startMs: Date.UTC(2026, 0, 1),
  endExclusiveMs: Date.UTC(2026, 0, 2),
  nowMs: Date.UTC(2026, 0, 3),
  timeZone: "UTC",
};
const PREPARED_WINDOW = {
  startMs: WINDOW.startMs - 10,
  endExclusiveMs: WINDOW.endExclusiveMs + 10,
};

interface CapturedStatement {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

function capturedEnv(statements: CapturedStatement[]): Env {
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
            path: `/technology-share-trend-${index}`,
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
            path: `/technology-share-trend-${index}`,
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

function prepareTrendFilters(
  filters: FilterDocument,
  scope: "event" | "session" | "visitor" = "event",
  siteId = SITE_ID,
): { readonly filters: FilterDocument; readonly scopePlan: ScopedFilterPlan } {
  const prepared = prepareScopedQuery("share-trend", {
    context: siteQueryContext(siteId, "private-dashboard"),
    time: createQueryTime(
      PREPARED_WINDOW.startMs,
      PREPARED_WINDOW.endExclusiveMs,
      "UTC",
      WINDOW.nowMs,
    ),
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("technology_share_trend_prepared_scope_missing");
  return { filters: prepared.filters, scopePlan: prepared.scopePlan };
}

function withAdvancedMatches(
  prepared: {
    readonly filters: FilterDocument;
    readonly scopePlan: ScopedFilterPlan;
  },
  matches: PreparedMembershipFixture,
): FilterDocument {
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata)
    throw new Error("technology_share_trend_prepared_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...prepared.scopePlan,
      preparedMembership: preparedMembershipFromIds(matches),
    },
  });
}

function seedVisit(
  db: DatabaseSync,
  sitePk: number,
  input: {
    readonly id: string;
    readonly visitor: string;
    readonly session: string;
    readonly startedAt: number;
    readonly browser: string;
    readonly browserVersion?: string;
    readonly pathname: string;
    readonly referrerHost?: string;
    readonly utmSource?: string;
    readonly utmMedium?: string;
  },
): void {
  db.prepare(
    `
    INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname, browser, browser_version,
      referrer_host, utm_source, utm_medium
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'trend.test', ?, ?, ?, ?, ?)
  `,
  ).run(
    input.id,
    SITE_ID,
    sitePk,
    input.visitor,
    input.session,
    input.startedAt,
    input.startedAt,
    input.pathname,
    input.browser,
    input.browserVersion ?? "",
    input.referrerHost ?? "",
    input.utmSource ?? "",
    input.utmMedium ?? "",
  );
}

function seedBrowserVersionFixture(
  db: DatabaseSync,
  sitePk: number,
  startedAt: number,
): void {
  const rows = [
    ["chrome-124-shared", "cross-version", "   ", "Chrome", "124.1"],
    ["chrome-124-second", "chrome-124-second", "", "Chrome", "124.9"],
    ["chrome-123-shared", "cross-version", "session-123-a", "Chrome", "123.8"],
    [
      "chrome-123-second",
      "chrome-123-second",
      "session-123-b",
      "Chrome",
      "123.4",
    ],
    ["merge-ascii", "merge-ascii", "merge-session-a", "MERGE", "13.2"],
    ["merge-ascii-second", "merge-ascii", "merge-session-a", "MERGE", "13.9"],
    ["merge-tabs", "merge-tabs", "merge-session-b", " \tMERGE\t ", "12.4"],
    ["edge-ascii", "edge-ascii", "edge-session-a", "Edge", "126.3"],
    ["edge-nbsp", "edge-nbsp", "edge-session-b", " \u00a0Edge\u00a0 ", "127.3"],
    [
      "browser-tie-alpha",
      "browser-tie-alpha",
      "browser-tie-alpha-session",
      "TieAlpha",
      "2.0",
    ],
    [
      "browser-tie-beta",
      "browser-tie-beta",
      "browser-tie-beta-session",
      "TieBeta",
      "1.0",
    ],
    [
      "version-tie-alpha",
      "version-tie-alpha",
      "version-tie-alpha-session",
      "VersionTie",
      "alpha.1",
    ],
    [
      "version-tie-beta",
      "version-tie-beta",
      "version-tie-beta-session",
      "VersionTie",
      "beta.1",
    ],
    ["weird-empty", "weird-empty", "weird-session-empty", "Weird", ""],
    ["weird-dot", "weird-dot", "weird-session-dot", "Weird", ".2"],
    [
      "weird-unknown-collision",
      "weird-unknown-collision",
      "weird-session-collision",
      "Weird",
      `${BROWSER_VERSION_UNKNOWN_TOKEN}.7`,
    ],
    ["weird-v-prefix", "weird-v-prefix", "weird-session-v", "Weird", "v1.2"],
    [
      "weird-leading-zero",
      "weird-leading-zero",
      "weird-session-zero",
      "Weird",
      "01.2",
    ],
    [
      "weird-empty-segment",
      "weird-empty-segment",
      "weird-session-segment",
      "Weird",
      "1..2",
    ],
    [
      "weird-ascii-space",
      "weird-ascii-space",
      "weird-session-space",
      "Weird",
      " 129.1",
    ],
    [
      "weird-tab-version",
      "weird-tab-version",
      "weird-session-tab",
      "Weird",
      "\t130.1",
    ],
    [
      "weird-nbsp-version",
      "weird-nbsp-version",
      "weird-session-nbsp",
      "Weird",
      "\u00a0131.1\u00a0",
    ],
    ["zero-visitor", "", "zero-session", "NoVisitor", "10.2"],
    ["empty-browser", "empty-browser", "empty-browser-session", "", "15.1"],
  ] as const;
  for (const [
    index,
    [id, visitor, session, browser, browserVersion],
  ] of rows.entries()) {
    seedVisit(db, sitePk, {
      id: `browser-version-${id}`,
      visitor,
      session,
      startedAt: startedAt + index,
      browser,
      browserVersion,
      pathname: "/browser-version-diff",
    });
  }
}

let database: DatabaseSync;
let sitePk: number;

function seedPayloadEvent(
  db: DatabaseSync,
  input: {
    readonly visitId: string;
    readonly eventId: string;
    readonly count: number;
  },
): void {
  const occurredAt = WINDOW.startMs + 40;
  db.prepare(
    `
    INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
    VALUES (?, 'technology-share-trend-payload', ?, ?)
  `,
  ).run(SITE_ID, occurredAt, sitePk);
  const eventName = db
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(sitePk, "technology-share-trend-payload") as { readonly id: number };
  const pathIds = Array.from({ length: input.count }, (_unused, index) => {
    const path = `/technology-share-trend-${index}`;
    db.prepare(
      `
      INSERT OR IGNORE INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at)
      VALUES (?, ?, ?, ?)
    `,
    ).run(SITE_ID, sitePk, path, occurredAt);
    const pathRow = db
      .prepare(
        "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
      )
      .get(sitePk, path) as { readonly id: number };
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
    input.eventId,
    SITE_ID,
    sitePk,
    input.visitId,
    eventName.id,
    occurredAt,
    occurredAt,
    pathIds.length,
    pathIds.length,
  );
  const event = db
    .prepare("SELECT event_pk FROM custom_events WHERE event_id = ?")
    .get(input.eventId) as { readonly event_pk: number };
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
  for (const [index, pathId] of pathIds.entries()) {
    const nodeId = index + 1;
    insertNode.run(event.event_pk, nodeId, pathId);
    insertValue.run(
      event.event_pk,
      nodeId,
      SITE_ID,
      sitePk,
      eventName.id,
      pathId,
      occurredAt,
      `value-${index}`,
    );
  }
}

function sqliteEnv(db: DatabaseSync, trace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(db, trace) } as unknown as Env;
}

function legacyBrowserVersionStatement(
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  browserLimit: number,
) {
  const source = technologyVisitSource(siteId, window, filters);
  const normalizedBrowserLimit =
    Number.isFinite(browserLimit) && browserLimit > 0
      ? Math.max(1, Math.floor(browserLimit))
      : null;
  const browserLimitClause = normalizedBrowserLimit
    ? "WHERE browserRank <= ?"
    : "WHERE 1 = 1";
  const sql = `
WITH
${source.ctes},
filtered_visits AS (
  SELECT
    TRIM(COALESCE(browser, '')) AS browser,
    browser_version,
    visitor_id,
    session_id
  FROM ${source.relation}
  ${source.filterClause}
),
browser_rollup AS (
  SELECT
    browser,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions
  FROM filtered_visits
  WHERE browser != ''
  GROUP BY browser
),
ranked_browsers AS (
  SELECT
    browser,
    views,
    visitors,
    sessions,
    ROW_NUMBER() OVER (
      ORDER BY visitors DESC, views DESC, sessions DESC, browser ASC
    ) AS browserRank
  FROM browser_rollup
),
top_browsers AS (
  SELECT browser, views, visitors, sessions, browserRank
  FROM ranked_browsers
  ${browserLimitClause}
),
versioned_visits AS (
  SELECT
    fv.browser,
    CASE
      WHEN ${browserMajorVersionExpr("fv")} != ''
        THEN ${browserMajorVersionExpr("fv")}
      ELSE '${BROWSER_VERSION_UNKNOWN_TOKEN}'
    END AS version,
    fv.visitor_id,
    fv.session_id
  FROM filtered_visits fv
  INNER JOIN top_browsers tb ON tb.browser = fv.browser
),
version_rollup AS (
  SELECT
    browser,
    version,
    COUNT(*) AS views,
    COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) AS visitors,
    COUNT(DISTINCT CASE WHEN session_id != '' THEN session_id END) AS sessions
  FROM versioned_visits
  GROUP BY browser, version
  HAVING COUNT(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id END) > 0
)
SELECT
  tb.browser,
  tb.views,
  tb.visitors,
  tb.sessions,
  tb.browserRank,
  vr.version,
  vr.version AS versionLabel,
  vr.views AS versionViews,
  vr.visitors AS versionVisitors,
  vr.sessions AS versionSessions
FROM top_browsers tb
LEFT JOIN version_rollup vr ON vr.browser = tb.browser
ORDER BY tb.browserRank ASC, versionVisitors DESC, versionViews DESC,
  versionSessions DESC, versionLabel ASC
`;
  return {
    sql,
    bindings: [
      ...source.bindings,
      ...source.filterBindings,
      ...(normalizedBrowserLimit ? [normalizedBrowserLimit] : []),
    ],
  };
}

function mapLegacyBrowserVersionRows(
  rows: readonly Record<string, unknown>[],
  versionLimit: number,
): BrowserVersionBreakdownRow[] {
  const normalizedVersionLimit = Math.min(Math.max(1, versionLimit), 8);
  const topBrowsersByName = new Map<string, BrowserVersionAggregateRow>();
  const versionRows: BrowserVersionAggregateRow[] = [];
  for (const row of rows) {
    const browser = String(row.browser ?? "").trim();
    const browserVisitors = Number(row.visitors ?? 0);
    if (!browser || browserVisitors <= 0) continue;
    if (!topBrowsersByName.has(browser)) {
      topBrowsersByName.set(browser, {
        browser,
        version: "",
        views: Number(row.views ?? 0),
        visitors: browserVisitors,
        sessions: Number(row.sessions ?? 0),
      });
    }
    const version = String(row.version ?? "").trim();
    const versionVisitors = Number(row.versionVisitors ?? 0);
    if (version && versionVisitors > 0) {
      versionRows.push({
        browser,
        version,
        views: Number(row.versionViews ?? 0),
        visitors: versionVisitors,
        sessions: Number(row.versionSessions ?? 0),
      });
    }
  }
  const topBrowsers = [...topBrowsersByName.values()];
  if (topBrowsers.length === 0) return [];

  const versionsByBrowser = new Map<string, BrowserVersionAggregateRow[]>();
  for (const row of versionRows) {
    const bucket = versionsByBrowser.get(row.browser) ?? [];
    bucket.push(row);
    versionsByBrowser.set(row.browser, bucket);
  }

  return topBrowsers.map((browserRow) => {
    const rows = versionsByBrowser.get(browserRow.browser) ?? [];
    const usedKeys = new Set<string>(["other", "unknown"]);
    const versions: BrowserVersionSliceRow[] = [];
    let otherViews = 0;
    let otherVisitors = 0;
    let otherSessions = 0;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (index < normalizedVersionLimit) {
        if (row.version === BROWSER_VERSION_UNKNOWN_TOKEN) {
          versions.push({
            key: "unknown",
            label: "Unknown",
            views: row.views,
            visitors: row.visitors,
            sessions: row.sessions,
            isUnknown: true,
          });
        } else {
          versions.push({
            key: shareTrendSeriesKey(row.version, usedKeys, "version"),
            label: row.version,
            views: row.views,
            visitors: row.visitors,
            sessions: row.sessions,
          });
        }
        continue;
      }
      otherViews += row.views;
      otherVisitors += row.visitors;
      otherSessions += row.sessions;
    }

    if (otherVisitors > 0) {
      versions.push({
        key: "other",
        label: SHARE_TREND_OTHER_LABEL,
        views: otherViews,
        visitors: otherVisitors,
        sessions: otherSessions,
        isOther: true,
      });
    }
    return {
      browser: browserRow.browser,
      views: browserRow.views,
      visitors: browserRow.visitors,
      sessions: browserRow.sessions,
      versions,
    };
  });
}

function legacyBrowserVersionBreakdown(
  db: DatabaseSync,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  browserLimit: number,
  versionLimit: number,
): BrowserVersionBreakdownRow[] {
  const statement = legacyBrowserVersionStatement(
    siteId,
    window,
    filters,
    browserLimit,
  );
  const rows = db.prepare(statement.sql).all(...statement.bindings) as Record<
    string,
    unknown
  >[];
  return mapLegacyBrowserVersionRows(rows, versionLimit);
}

function medianSqlExecutionMs(
  db: DatabaseSync,
  sql: string,
  bindings: readonly SQLInputValue[],
): number {
  const statement = db.prepare(sql);
  const samples: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    const startedAt = performance.now();
    statement.all(...bindings);
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
}

beforeAll(() => {
  database = createMigratedDatabase();
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  const baseline = WINDOW.startMs + 20;
  seedBrowserVersionFixture(database, sitePk, baseline + 20);
  seedVisit(database, sitePk, {
    id: "payload-match",
    visitor: "payload-visitor",
    session: "payload-session",
    startedAt: baseline,
    browser: "Firefox",
    pathname: "/payload-match",
    referrerHost: "news.example",
    utmSource: "newsletter",
    utmMedium: "email",
  });
  seedVisit(database, sitePk, {
    id: "payload-partial",
    visitor: "partial-visitor",
    session: "partial-session",
    startedAt: baseline + 1,
    browser: "Chrome",
    pathname: "/payload-partial",
    referrerHost: "search.example",
    utmSource: "search",
    utmMedium: "organic",
  });
  seedVisit(database, sitePk, {
    id: "prepared-page-match",
    visitor: "prepared-page-visitor",
    session: "prepared-page-session",
    startedAt: baseline + 2,
    browser: "Prepared128",
    pathname: "/prepared-match",
  });
  seedVisit(database, sitePk, {
    id: "session-match-one",
    visitor: "prepared-entity-visitor",
    session: "prepared-session",
    startedAt: baseline + 3,
    browser: "SessionBrowser",
    pathname: "/session-match",
  });
  seedVisit(database, sitePk, {
    id: "session-match-two",
    visitor: "prepared-entity-visitor",
    session: "prepared-session",
    startedAt: baseline + 4,
    browser: "SessionBrowser",
    pathname: "/session-other-page",
  });
  seedVisit(database, sitePk, {
    id: "visitor-match-other-session",
    visitor: "prepared-entity-visitor",
    session: "prepared-visitor-session",
    startedAt: baseline + 5,
    browser: "VisitorBrowser",
    pathname: "/visitor-other-session",
  });
  seedVisit(database, sitePk, {
    id: "outside-reader-window",
    visitor: "outside-window-visitor",
    session: "outside-window-session",
    startedAt: WINDOW.endExclusiveMs + 1,
    browser: "OutsideWindow",
    pathname: "/outside-reader-window",
  });
  seedPayloadEvent(database, {
    visitId: "payload-match",
    eventId: "technology-share-match-event",
    count: 40,
  });
  seedPayloadEvent(database, {
    visitId: "payload-partial",
    eventId: "technology-share-partial-event",
    count: 39,
  });
});

afterAll(() => {
  database.close();
});

async function compileOnly(
  label: string,
  invoke: (env: Env) => Promise<unknown>,
  tagPrefix = "wave54.technology_share_trend",
) {
  const statements: CapturedStatement[] = [];
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  let failure: unknown;
  try {
    await runWithInvocationLogger(logger, () =>
      runWithD1Operation(`${tagPrefix}.${label}`, () =>
        invoke(instrumentEnv(capturedEnv(statements), logger)),
      ),
    );
  } catch (error) {
    failure = error;
  }
  const muted = vi.spyOn(console, "log").mockImplementation(() => {});
  let record: Awaited<ReturnType<typeof logger.emitWhenComplete>>;
  try {
    record = await logger.emitWhenComplete();
  } finally {
    muted.mockRestore();
  }
  if (failure instanceof D1StatementBudgetError)
    return {
      budgetFailure: {
        item: failure.item,
        actual: failure.actual,
        limit: failure.limit,
      },
    };
  if (failure) throw failure;
  const tag = `${tagPrefix}.${label}`;
  const observation = record.logs.find(
    (entry) =>
      entry.message === "db.query.v1.all.success" && entry.data?.tag === tag,
  );
  expect(statements, label).toHaveLength(1);
  const statement = statements[0]!;
  const sqlBytes = new TextEncoder().encode(statement.sql).byteLength;
  expect(observation?.data).toMatchObject({
    tag,
    operation: "all",
    status: "success",
    sqlBytes,
    bindings: statement.bindings.length,
    physicalPlanHash: expect.stringMatching(/^v\d+:[a-f0-9]{64}$/u),
  });
  return {
    sqlBytes,
    bindings: statement.bindings.length,
    physicalPlanHash: observation?.data?.physicalPlanHash,
  };
}

type CrossFamily = "browser" | "client";

function legacyCrossStatement(input: {
  readonly family: CrossFamily;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly primaryExpr: string;
  readonly secondaryExpr: string;
  readonly primaryLimit: number;
  readonly secondaryLimit: number;
}) {
  const source = technologyVisitSource(
    input.siteId,
    input.window,
    input.filters,
  );
  const browser = input.family === "browser";
  const primaryField = browser ? "browser" : "primaryValue";
  const secondaryField = browser ? "dimension" : "secondaryValue";
  const rowTypes = browser
    ? { primary: "browser", secondary: "dimension", pairs: "pair" }
    : { primary: "primary", secondary: "secondary", pairs: "pair" };
  const tokens = browser
    ? {
        unknown: BROWSER_CROSS_UNKNOWN_TOKEN,
        otherPrimary: BROWSER_CROSS_OTHER_BROWSER_TOKEN,
        otherSecondary: BROWSER_CROSS_OTHER_DIMENSION_TOKEN,
      }
    : {
        unknown: CLIENT_CROSS_UNKNOWN_TOKEN,
        otherPrimary: CLIENT_CROSS_OTHER_PRIMARY_TOKEN,
        otherSecondary: CLIENT_CROSS_OTHER_SECONDARY_TOKEN,
      };
  const secondaryExpr = `CASE WHEN ${input.secondaryExpr} != '' THEN ${input.secondaryExpr} ELSE '${tokens.unknown}' END`;
  const sql = `
WITH
${source.ctes},
filtered_visits AS MATERIALIZED (
  SELECT
    ${input.primaryExpr} AS primaryValue,
    ${secondaryExpr} AS secondaryValue,
    visitor_id AS visitorId,
    session_id AS sessionId
  FROM ${source.relation}
  ${source.filterClause}
),
top_primary_aggregate AS (
  SELECT primaryValue, count(*) AS views,
    count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
  FROM filtered_visits WHERE primaryValue != '' GROUP BY primaryValue
),
top_primary_rows AS (
  SELECT primaryValue, views, visitors, sessions,
    ROW_NUMBER() OVER (ORDER BY visitors DESC, views DESC, sessions DESC, primaryValue ASC) AS rowOrder
  FROM top_primary_aggregate
  ORDER BY visitors DESC, views DESC, sessions DESC, primaryValue ASC LIMIT ?
),
top_secondary_aggregate AS (
  SELECT secondaryValue, count(*) AS views,
    count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
  FROM filtered_visits WHERE primaryValue != '' GROUP BY secondaryValue
),
top_secondary_rows AS (
  SELECT secondaryValue, views, visitors, sessions,
    ROW_NUMBER() OVER (ORDER BY visitors DESC, views DESC, sessions DESC, secondaryValue ASC) AS rowOrder
  FROM top_secondary_aggregate
  ORDER BY visitors DESC, views DESC, sessions DESC, secondaryValue ASC LIMIT ?
),
normalized_visits AS (
  SELECT
    CASE WHEN primaryValue IN (SELECT primaryValue FROM top_primary_rows WHERE primaryValue != '' AND visitors > 0)
      THEN primaryValue ELSE '${tokens.otherPrimary}' END AS primaryBucket,
    CASE WHEN secondaryValue IN (SELECT secondaryValue FROM top_secondary_rows WHERE visitors > 0)
      THEN secondaryValue ELSE '${tokens.otherSecondary}' END AS secondaryBucket,
    visitorId, sessionId
  FROM filtered_visits WHERE primaryValue != ''
),
pair_rows AS (
  SELECT primaryBucket, secondaryBucket, count(*) AS views,
    count(DISTINCT CASE WHEN visitorId != '' THEN visitorId ELSE NULL END) AS visitors,
    count(DISTINCT CASE WHEN sessionId != '' THEN sessionId ELSE NULL END) AS sessions
  FROM normalized_visits GROUP BY primaryBucket, secondaryBucket
),
tagged_rows AS (
  SELECT '${rowTypes.primary}' AS rowType, primaryValue AS ${primaryField}, NULL AS ${secondaryField},
    views, visitors, sessions, rowOrder FROM top_primary_rows
  UNION ALL
  SELECT '${rowTypes.secondary}' AS rowType, NULL AS ${primaryField}, secondaryValue AS ${secondaryField},
    views, visitors, sessions, rowOrder FROM top_secondary_rows
  UNION ALL
  SELECT '${rowTypes.pairs}' AS rowType, primaryBucket AS ${primaryField}, secondaryBucket AS ${secondaryField},
    views, visitors, sessions, 0 AS rowOrder FROM pair_rows
)
SELECT rowType, ${primaryField}, ${secondaryField}, views, visitors, sessions, rowOrder
FROM tagged_rows
ORDER BY rowType ASC, rowOrder ASC, ${primaryField} ASC, ${secondaryField} ASC
`;
  return {
    sql,
    bindings: [
      ...source.bindings,
      ...source.filterBindings,
      Math.min(Math.max(1, input.primaryLimit), 12),
      Math.min(Math.max(1, input.secondaryLimit), 8),
    ],
  };
}

function normalizeLegacyCrossRows(
  rows: readonly Record<string, unknown>[],
  family: CrossFamily,
) {
  const primaryField = family === "browser" ? "browser" : "primaryValue";
  const secondaryField = family === "browser" ? "dimension" : "secondaryValue";
  return rows.map((row) => ({
    rowType: String(row.rowType),
    primaryValue: row[primaryField] ?? null,
    secondaryValue: row[secondaryField] ?? null,
    views: Number(row.views),
    visitors: Number(row.visitors),
    sessions: Number(row.sessions),
    rowOrder: Number(row.rowOrder),
  }));
}

function rowsFromSqlite(
  db: DatabaseSync,
  sql: string,
  bindings: readonly unknown[],
) {
  return db.prepare(sql).all(...(bindings as SQLInputValue[])) as Record<
    string,
    unknown
  >[];
}

describe("technology share trend Logical report budgets", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("shares one Page source and the two common latest selections", () => {
    const plan = buildTechnologyReferrerChannelTrendPlan({
      siteId: SITE_ID,
      queryTime: createQueryTime(
        WINDOW.startMs,
        WINDOW.endExclusiveMs,
        WINDOW.timeZone,
        WINDOW.nowMs,
      ),
      filters: EMPTY_FILTER_DOCUMENT,
      interval: "day",
      limit: 5,
    });

    expect(
      plan.nodes.filter(
        (node) => node.kind === "source" && node.entity === "page",
      ),
    ).toHaveLength(1);
    expect(
      plan.nodes.filter((node) => node.kind === "ordered-member"),
    ).toHaveLength(2);
    expect(plan.nodes.filter((node) => node.kind === "join")).toHaveLength(6);
    expect(plan.outputs).toHaveLength(6);
  });

  it("resolves only the finite Cross dimension registry and preserves fallback keys", () => {
    for (const dimension of CROSS_BREAKDOWN_DIMENSIONS) {
      const typed = resolveCrossBreakdownPageDimension(dimension);
      const legacy = resolveCrossBreakdownDimension(dimension);
      expect(typed, dimension).not.toBeNull();
      expect(legacy, dimension).not.toBeNull();
      expect(typed?.fallbackKeyBase, dimension).toBe(legacy?.fallbackKeyBase);
    }
    expect(resolveCrossBreakdownPageDimension("session.entryPath")).toBeNull();
    expect(resolveCrossBreakdownPageDimension("event.name")).toBeNull();
    expect(resolveCrossBreakdownPageDimension("unknown.dimension")).toBeNull();
    expect(resolveCrossBreakdownPageDimension("browser")?.selection).toEqual(
      resolveCrossBreakdownPageDimension("client.browser")?.selection,
    );
    expect(
      resolveCrossBreakdownPageDimension("operatingSystem")?.selection,
    ).toEqual(resolveCrossBreakdownPageDimension("client.os")?.selection);
  });

  it("executes 40-payload matches and rejects partial matches in both readers", async () => {
    const filters = directPayloadExistsFilters();
    const singleTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const single = await queryShareTrendFromD1(
      sqliteEnv(database, singleTrace),
      SITE_ID,
      WINDOW,
      "day",
      filters,
      5,
      "browser",
    );
    expect(single.series).toMatchObject([
      { label: "Firefox", views: 1, visitors: 1, sessions: 1 },
    ]);
    expect(singleTrace.preparedSql).toHaveLength(1);

    const combinedTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const combined = await queryReferrerAndChannelTrendFromD1(
      sqliteEnv(database, combinedTrace),
      SITE_ID,
      WINDOW,
      "day",
      filters,
      5,
    );
    expect(combined.source.series).toMatchObject([
      { label: "news.example", views: 1, visitors: 1, sessions: 1 },
    ]);
    expect(combined.channel.series).toMatchObject([
      { label: "email", views: 1, visitors: 1, sessions: 1 },
    ]);
    expect(combinedTrace.preparedSql).toHaveLength(1);
  });

  it("preserves prepared Page, Event, Session, Visitor, ownership, and read-window scope", async () => {
    const pagePrepared = prepareTrendFilters(pagePathFilter("/prepared-match"));
    const pageIds = withAdvancedMatches(pagePrepared, {
      visitIds: [
        { siteId: SITE_ID, id: "prepared-page-match" },
        ...Array.from({ length: 127 }, (_unused, index) => ({
          siteId: SITE_ID,
          id: `missing-prepared-page-${index}`,
        })),
      ],
    });
    const pageTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const pageResult = await queryShareTrendFromD1(
      sqliteEnv(database, pageTrace),
      SITE_ID,
      WINDOW,
      "day",
      pageIds,
      5,
      "browser",
    );
    expect(pageResult.series).toMatchObject([
      { label: "Prepared128", views: 1, visitors: 1, sessions: 1 },
    ]);
    expect(pageTrace.preparedSql).toHaveLength(1);
    expect(pageTrace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );

    const emptyPageIds = withAdvancedMatches(pagePrepared, { visitIds: [] });
    expect(
      await queryShareTrendFromD1(
        sqliteEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        "day",
        emptyPageIds,
        5,
        "browser",
      ),
    ).toEqual({ series: [], data: [] });

    const payloadFilters = directPayloadExistsFilters();
    const eventPrepared = prepareTrendFilters(payloadFilters);
    const pageAndEventIds = withAdvancedMatches(eventPrepared, {
      visitIds: [{ siteId: SITE_ID, id: "payload-match" }],
      eventIds: [{ siteId: SITE_ID, id: "technology-share-match-event" }],
    });
    expect(
      await queryShareTrendFromD1(
        sqliteEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        "day",
        pageAndEventIds,
        5,
        "browser",
      ),
    ).toMatchObject({ series: [{ label: "Firefox" }] });
    const noEvents = withAdvancedMatches(eventPrepared, {
      visitIds: [],
      eventIds: [{ siteId: SITE_ID, id: "technology-share-match-event" }],
    });
    expect(
      await queryShareTrendFromD1(
        sqliteEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        "day",
        noEvents,
        5,
        "browser",
      ),
    ).toEqual({ series: [], data: [] });

    const sessionPrepared = prepareTrendFilters(
      pagePathFilter("/session-match"),
      "session",
    );
    const sessionIds = withAdvancedMatches(sessionPrepared, {
      entityIds: [{ siteId: SITE_ID, id: "prepared-session" }],
    });
    const sessionResult = await queryShareTrendFromD1(
      sqliteEnv(database, { preparedSql: [], bindings: [] }),
      SITE_ID,
      WINDOW,
      "day",
      sessionIds,
      5,
      "browser",
    );
    expect(sessionResult.series).toMatchObject([
      { label: "SessionBrowser", views: 2, visitors: 1, sessions: 1 },
    ]);
    const emptySessionIds = withAdvancedMatches(sessionPrepared, {
      entityIds: [],
    });
    expect(
      await queryShareTrendFromD1(
        sqliteEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        "day",
        emptySessionIds,
        5,
        "browser",
      ),
    ).toEqual({ series: [], data: [] });

    const visitorPrepared = prepareTrendFilters(
      pagePathFilter("/session-match"),
      "visitor",
    );
    const visitorIds = withAdvancedMatches(visitorPrepared, {
      entityIds: [{ siteId: SITE_ID, id: "prepared-entity-visitor" }],
    });
    const visitorResult = await queryShareTrendFromD1(
      sqliteEnv(database, { preparedSql: [], bindings: [] }),
      SITE_ID,
      WINDOW,
      "day",
      visitorIds,
      5,
      "browser",
    );
    expect(visitorResult.series).toMatchObject([
      { label: "VisitorBrowser", views: 3, visitors: 1, sessions: 2 },
    ]);
    const emptyVisitorIds = withAdvancedMatches(visitorPrepared, {
      entityIds: [],
    });
    expect(
      await queryShareTrendFromD1(
        sqliteEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        "day",
        emptyVisitorIds,
        5,
        "browser",
      ),
    ).toEqual({ series: [], data: [] });

    const preparedOutsideWindow = withAdvancedMatches(
      prepareTrendFilters(pagePathFilter("/outside-reader-window")),
      { visitIds: [{ siteId: SITE_ID, id: "outside-reader-window" }] },
    );
    expect(
      await queryShareTrendFromD1(
        sqliteEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        "day",
        preparedOutsideWindow,
        5,
        "browser",
      ),
    ).toEqual({ series: [], data: [] });

    const foreignPrepared = withAdvancedMatches(
      prepareTrendFilters(
        pagePathFilter("/prepared-match"),
        "event",
        "foreign-technology-share-site",
      ),
      {
        visitIds: [
          { siteId: "foreign-technology-share-site", id: "foreign-page" },
        ],
      },
    );
    await expect(
      queryShareTrendFromD1(
        sqliteEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        "day",
        foreignPrepared,
        5,
        "browser",
      ),
    ).rejects.toThrow();
  });

  it("compiles plain standalone and direct 40-exists standalone/combined once", async () => {
    const filters = directPayloadExistsFilters();
    const preparedPage128 = withAdvancedMatches(
      prepareTrendFilters(pagePathFilter("/prepared-match")),
      {
        visitIds: [
          { siteId: SITE_ID, id: "prepared-page-match" },
          ...Array.from({ length: 127 }, (_unused, index) => ({
            siteId: SITE_ID,
            id: `missing-prepared-compile-${index}`,
          })),
        ],
      },
    );
    const plain = await compileOnly("plain-browser", (env) =>
      queryShareTrendFromD1(
        env,
        SITE_ID,
        WINDOW,
        "day",
        EMPTY_FILTER_DOCUMENT,
        5,
        "browser",
      ),
    );
    const directStandalone = await compileOnly(
      "direct-40-exists-browser",
      (env) =>
        queryShareTrendFromD1(
          env,
          SITE_ID,
          WINDOW,
          "day",
          filters,
          5,
          "browser",
        ),
    );
    const plainCombined = await compileOnly("plain-combined", (env) =>
      queryReferrerAndChannelTrendFromD1(
        env,
        SITE_ID,
        WINDOW,
        "day",
        EMPTY_FILTER_DOCUMENT,
        5,
      ),
    );
    const directCombined = await compileOnly(
      "direct-40-exists-combined",
      (env) =>
        queryReferrerAndChannelTrendFromD1(
          env,
          SITE_ID,
          WINDOW,
          "day",
          filters,
          5,
        ),
    );
    const prepared128 = await compileOnly("prepared-page-128-browser", (env) =>
      queryShareTrendFromD1(
        env,
        SITE_ID,
        WINDOW,
        "day",
        preparedPage128,
        5,
        "browser",
      ),
    );
    const directEq = await compileOnly("direct-40-eq-browser", (env) =>
      queryShareTrendFromD1(
        env,
        SITE_ID,
        WINDOW,
        "day",
        directPayloadEqFilters(),
        5,
        "browser",
      ),
    );

    for (const result of [
      plain,
      plainCombined,
      directStandalone,
      directCombined,
      prepared128,
    ]) {
      expect(result.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(result.bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(result.physicalPlanHash).toMatch(/^v\d+:[a-f0-9]{64}$/u);
    }
    if ("budgetFailure" in directEq) {
      const failure = directEq.budgetFailure!;
      expect(failure.actual).toBeGreaterThan(failure.limit);
    } else {
      expect(directEq.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(directEq.bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    }
  });
});

describe("browser version breakdown Logical report", () => {
  const browserVersionFilters = pagePathFilter("/browser-version-diff");

  it("matches the frozen full-SQL DTO across labels, versions, ranking, and limits", async () => {
    const browserLimits = [
      0.25,
      2.9,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    const versionLimits = [
      2.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const browserLimit of browserLimits) {
      for (const versionLimit of versionLimits) {
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const actual = await queryBrowserVersionBreakdownFromD1(
          sqliteEnv(database, trace),
          SITE_ID,
          WINDOW,
          browserVersionFilters,
          browserLimit,
          versionLimit,
        );
        expect(
          trace.preparedSql,
          `${browserLimit}/${versionLimit}`,
        ).toHaveLength(1);
        expect(actual, `${browserLimit}/${versionLimit}`).toEqual(
          legacyBrowserVersionBreakdown(
            database,
            SITE_ID,
            WINDOW,
            browserVersionFilters,
            browserLimit,
            versionLimit,
          ),
        );
      }
    }

    const unboundedTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const unbounded = await queryBrowserVersionBreakdownFromD1(
      sqliteEnv(database, unboundedTrace),
      SITE_ID,
      WINDOW,
      browserVersionFilters,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    );
    expect(unbounded.map(({ browser }) => browser)).not.toContain("NoVisitor");
    expect(unbounded.map(({ browser }) => browser)).not.toContain("");

    const chrome = unbounded.find(({ browser }) => browser === "Chrome")!;
    expect(chrome.versions.map(({ label }) => label)).toContain("123");
    expect(chrome.versions.map(({ label }) => label)).toContain("124");
    const chromeTopVersion = await queryBrowserVersionBreakdownFromD1(
      sqliteEnv(database, { preparedSql: [], bindings: [] }),
      SITE_ID,
      WINDOW,
      browserVersionFilters,
      Number.NaN,
      1,
    );
    const chromeWithOther = chromeTopVersion.find(
      ({ browser }) => browser === "Chrome",
    )!;
    expect(chromeWithOther.versions.at(-1)).toMatchObject({
      key: "other",
      visitors: 2,
      isOther: true,
    });

    const weird = unbounded.find(({ browser }) => browser === "Weird")!;
    expect(weird.versions.find(({ key }) => key === "unknown")).toMatchObject({
      label: "Unknown",
      views: 3,
      visitors: 3,
      sessions: 3,
      isUnknown: true,
    });
    expect(weird.versions.map(({ label }) => label)).toEqual(
      expect.arrayContaining(["Unknown", "01", "1", "v1", "129", "130", "131"]),
    );
    expect(unbounded.find(({ browser }) => browser === "MERGE")).toMatchObject({
      views: 2,
      visitors: 1,
      sessions: 1,
    });
    expect(
      unbounded.find(({ browser }) => browser === "Edge")?.versions,
    ).toHaveLength(2);
    expect(
      unbounded.findIndex(({ browser }) => browser === "TieAlpha"),
    ).toBeLessThan(unbounded.findIndex(({ browser }) => browser === "TieBeta"));
    expect(
      unbounded
        .find(({ browser }) => browser === "VersionTie")
        ?.versions.map(({ label }) => label),
    ).toEqual(["alpha", "beta"]);

    const parentStatement = legacyBrowserVersionStatement(
      SITE_ID,
      WINDOW,
      browserVersionFilters,
      Number.NaN,
    );
    const newSql = unboundedTrace.preparedSql[0]!;
    const newBindings = unboundedTrace.bindings[0]!;
    const parentExplain = database
      .prepare(`EXPLAIN QUERY PLAN ${parentStatement.sql}`)
      .all(...parentStatement.bindings) as Array<{ readonly detail: string }>;
    const newExplain = database
      .prepare(`EXPLAIN QUERY PLAN ${newSql}`)
      .all(...newBindings) as Array<{ readonly detail: string }>;
    const usefulPlanLines = (rows: readonly { readonly detail: string }[]) =>
      rows
        .map(({ detail }) => detail)
        .filter((detail) =>
          /INDEX|MATERIALIZE|TEMP B-TREE|SCAN visits/iu.test(detail),
        )
        .slice(0, 12);
    console.info(
      "wave56_browser_version_sql_evidence",
      JSON.stringify({
        parent: {
          sqlBytes: new TextEncoder().encode(parentStatement.sql).byteLength,
          bindings: parentStatement.bindings.length,
          medianMs: medianSqlExecutionMs(
            database,
            parentStatement.sql,
            parentStatement.bindings,
          ),
          eqp: usefulPlanLines(parentExplain),
        },
        new: {
          sqlBytes: new TextEncoder().encode(newSql).byteLength,
          bindings: newBindings.length,
          medianMs: medianSqlExecutionMs(database, newSql, newBindings),
          eqp: usefulPlanLines(newExplain),
        },
      }),
    );
  });

  it("keeps the Page reader window, empty selection, Event, Session, and Visitor scopes", async () => {
    const pagePrepared = prepareTrendFilters(pagePathFilter("/prepared-match"));
    const page128 = withAdvancedMatches(pagePrepared, {
      visitIds: [
        { siteId: SITE_ID, id: "prepared-page-match" },
        ...Array.from({ length: 127 }, (_unused, index) => ({
          siteId: SITE_ID,
          id: `missing-browser-version-page-${index}`,
        })),
      ],
    });
    const pageTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    await expect(
      queryBrowserVersionBreakdownFromD1(
        sqliteEnv(database, pageTrace),
        SITE_ID,
        WINDOW,
        page128,
        10,
        8,
      ),
    ).resolves.toMatchObject([
      {
        browser: "Prepared128",
        views: 1,
        visitors: 1,
        sessions: 1,
        versions: [{ key: "unknown", views: 1, visitors: 1, sessions: 1 }],
      },
    ]);
    expect(pageTrace.preparedSql).toHaveLength(1);
    expect(pageTrace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    const emptyPage128 = withAdvancedMatches(pagePrepared, { visitIds: [] });
    await expect(
      queryBrowserVersionBreakdownFromD1(
        sqliteEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        emptyPage128,
        10,
        8,
      ),
    ).resolves.toEqual([]);

    const eventPrepared = prepareTrendFilters(directPayloadExistsFilters());
    const pageAndEvent = withAdvancedMatches(eventPrepared, {
      visitIds: [{ siteId: SITE_ID, id: "payload-match" }],
      eventIds: [{ siteId: SITE_ID, id: "technology-share-match-event" }],
    });
    const eventResult = await queryBrowserVersionBreakdownFromD1(
      sqliteEnv(database, { preparedSql: [], bindings: [] }),
      SITE_ID,
      WINDOW,
      pageAndEvent,
      10,
      8,
    );
    expect(eventResult).toMatchObject([
      { browser: "Firefox", views: 1, versions: [{ key: "unknown" }] },
    ]);

    const sessionPrepared = prepareTrendFilters(
      pagePathFilter("/session-match"),
      "session",
    );
    const sessionResult = await queryBrowserVersionBreakdownFromD1(
      sqliteEnv(database, { preparedSql: [], bindings: [] }),
      SITE_ID,
      WINDOW,
      withAdvancedMatches(sessionPrepared, {
        entityIds: [{ siteId: SITE_ID, id: "prepared-session" }],
      }),
      10,
      8,
    );
    expect(sessionResult).toMatchObject([
      {
        browser: "SessionBrowser",
        views: 2,
        visitors: 1,
        sessions: 1,
        versions: [{ key: "unknown", views: 2, visitors: 1, sessions: 1 }],
      },
    ]);

    const visitorPrepared = prepareTrendFilters(
      pagePathFilter("/session-match"),
      "visitor",
    );
    const visitorResult = await queryBrowserVersionBreakdownFromD1(
      sqliteEnv(database, { preparedSql: [], bindings: [] }),
      SITE_ID,
      WINDOW,
      withAdvancedMatches(visitorPrepared, {
        entityIds: [{ siteId: SITE_ID, id: "prepared-entity-visitor" }],
      }),
      10,
      8,
    );
    expect(visitorResult.map(({ browser }) => browser)).toEqual([
      "SessionBrowser",
      "VisitorBrowser",
    ]);

    const outsidePrepared = withAdvancedMatches(
      prepareTrendFilters(pagePathFilter("/outside-reader-window")),
      { visitIds: [{ siteId: SITE_ID, id: "outside-reader-window" }] },
    );
    await expect(
      queryBrowserVersionBreakdownFromD1(
        sqliteEnv(database, { preparedSql: [], bindings: [] }),
        SITE_ID,
        WINDOW,
        outsidePrepared,
        10,
        8,
      ),
    ).resolves.toEqual([]);
  });

  it("includes all 40 direct payload predicates and rejects the 39-path visit", async () => {
    const filters = directPayloadExistsFilters();
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const actual = await queryBrowserVersionBreakdownFromD1(
      sqliteEnv(database, trace),
      SITE_ID,
      WINDOW,
      filters,
      10,
      8,
    );
    expect(actual).toEqual(
      legacyBrowserVersionBreakdown(database, SITE_ID, WINDOW, filters, 10, 8),
    );
    expect(actual.map(({ browser }) => browser)).toEqual(["Firefox"]);
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
  });

  it("records plain, direct-40, prepared-Page128 and frozen-parent budgets", async () => {
    const direct40 = directPayloadExistsFilters();
    const preparedPage128 = withAdvancedMatches(
      prepareTrendFilters(pagePathFilter("/prepared-match")),
      {
        visitIds: [
          { siteId: SITE_ID, id: "prepared-page-match" },
          ...Array.from({ length: 127 }, (_unused, index) => ({
            siteId: SITE_ID,
            id: `missing-browser-version-budget-${index}`,
          })),
        ],
      },
    );
    const tag = "wave56.technology_browser_version";
    const plain = await compileOnly(
      "plain",
      (env) =>
        queryBrowserVersionBreakdownFromD1(
          env,
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          10,
          8,
        ),
      tag,
    );
    const direct = await compileOnly(
      "direct-40-exists",
      (env) =>
        queryBrowserVersionBreakdownFromD1(
          env,
          SITE_ID,
          WINDOW,
          direct40,
          10,
          8,
        ),
      tag,
    );
    const prepared = await compileOnly(
      "prepared-page-128",
      (env) =>
        queryBrowserVersionBreakdownFromD1(
          env,
          SITE_ID,
          WINDOW,
          preparedPage128,
          10,
          8,
        ),
      tag,
    );

    for (const result of [plain, direct, prepared]) {
      expect(result).not.toHaveProperty("budgetFailure");
      if ("budgetFailure" in result) continue;
      expect(result.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(result.bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(result.physicalPlanHash).toMatch(/^v\d+:[a-f0-9]{64}$/u);
    }

    const parent = [EMPTY_FILTER_DOCUMENT, direct40, preparedPage128].map(
      (filters) => {
        const statement = legacyBrowserVersionStatement(
          SITE_ID,
          WINDOW,
          filters,
          10,
        );
        return {
          sqlBytes: new TextEncoder().encode(statement.sql).byteLength,
          bindings: statement.bindings.length,
        };
      },
    );
    const parentWithinBudget = parent.map(
      (entry) =>
        entry.sqlBytes <= D1_MAX_SQL_UTF8_BYTES &&
        entry.bindings <= D1_MAX_BOUND_PARAMETERS,
    );
    console.info(
      "wave56_browser_version_budget",
      JSON.stringify({
        new: [plain, direct, prepared],
        parent,
        parentWithinBudget,
      }),
    );
  });

  it("matches the frozen Cross SQL for both readers and source profiles", async () => {
    const preparedPage128 = withAdvancedMatches(
      prepareTrendFilters(pagePathFilter("/prepared-match")),
      {
        visitIds: [
          { siteId: SITE_ID, id: "prepared-page-match" },
          ...Array.from({ length: 127 }, (_unused, index) => ({
            siteId: SITE_ID,
            id: `wave57-cross-missing-${index}`,
          })),
        ],
      },
    );
    const sourceCases = [
      { label: "plain", filters: EMPTY_FILTER_DOCUMENT },
      { label: "direct-40-exists", filters: directPayloadExistsFilters() },
      { label: "prepared-page-128", filters: preparedPage128 },
    ] as const;

    for (const sourceCase of sourceCases) {
      for (const family of ["browser", "client"] as const) {
        const primaryExpr =
          family === "browser"
            ? "TRIM(COALESCE(browser, ''))"
            : clientDimensionDefinition("browser").labelExpr;
        const secondaryExpr =
          family === "browser"
            ? "TRIM(COALESCE(os, ''))"
            : clientDimensionDefinition("deviceType").labelExpr;
        const parent = legacyCrossStatement({
          family,
          siteId: SITE_ID,
          window: WINDOW,
          filters: sourceCase.filters,
          primaryExpr,
          secondaryExpr,
          primaryLimit: 12,
          secondaryLimit: 8,
        });
        const parentRows = rowsFromSqlite(
          database,
          parent.sql,
          parent.bindings,
        );
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const env = sqliteEnv(database, trace);
        const dto =
          family === "browser"
            ? await queryBrowserCrossDimensionFromD1(
                env,
                SITE_ID,
                WINDOW,
                sourceCase.filters,
                12,
                8,
                PAGE_DIMENSION_SELECTIONS.operatingSystem,
                "os",
              )
            : await queryCrossDimensionFromD1(
                env,
                SITE_ID,
                WINDOW,
                sourceCase.filters,
                12,
                8,
                resolveCrossBreakdownPageDimension("browser")!,
                resolveCrossBreakdownPageDimension("deviceType")!,
              );
        expect(dto).toBeDefined();
        expect(trace.preparedSql).toHaveLength(1);
        const newRows = rowsFromSqlite(
          database,
          trace.preparedSql[0]!,
          trace.bindings[0]!,
        );
        expect(normalizeLegacyCrossRows(newRows, family)).toEqual(
          normalizeLegacyCrossRows(parentRows, family),
        );
        if (sourceCase.label === "direct-40-exists") {
          const topRowType = family === "browser" ? "browser" : "primary";
          expect(
            parentRows
              .filter((row) => row.rowType === topRowType)
              .reduce((sum, row) => sum + Number(row.views), 0),
          ).toBe(1);
        }
        if (sourceCase.label === "prepared-page-128") {
          const topRowType = family === "browser" ? "browser" : "primary";
          expect(
            parentRows
              .filter((row) => row.rowType === topRowType)
              .reduce((sum, row) => sum + Number(row.views), 0),
          ).toBe(1);
        }
      }
    }
  });

  it("preserves Cross ranking ties, unknown collisions, Other re-deduplication, and empty identities", async () => {
    const crossDatabase = createMigratedDatabase();
    try {
      crossDatabase
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(SITE_ID);
      const crossSitePk = Number(
        (
          crossDatabase
            .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
            .get(SITE_ID) as { readonly site_pk: number }
        ).site_pk,
      );
      const insert = crossDatabase.prepare(`
        INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname, browser, os, device_type
        ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, '', 'cross.test', ?, ?, ?)
      `);
      const at = WINDOW.startMs + 30;
      const rows = [
        [
          "chrome-one",
          "chrome-one",
          "chrome-session-one",
          " Chrome ",
          " Windows ",
          " desktop ",
        ],
        [
          "chrome-two",
          "chrome-two",
          "chrome-session-two",
          "Chrome",
          "Windows",
          "desktop",
        ],
        [
          "edge-one",
          "shared-other",
          "shared-other-session",
          "Edge",
          "Linux",
          "tablet",
        ],
        [
          "edge-two",
          "shared-other",
          "shared-other-session",
          "Edge",
          "Linux",
          "tablet",
        ],
        [
          "safari-one",
          "shared-other",
          "shared-other-session",
          "Safari",
          "macOS",
          "phone",
        ],
        [
          "safari-two",
          "shared-other",
          "shared-other-session",
          "Safari",
          "macOS",
          "phone",
        ],
        [
          "unknown-token",
          "unknown-token-visitor",
          "unknown-token-session",
          "Chrome",
          BROWSER_CROSS_UNKNOWN_TOKEN,
          CLIENT_CROSS_UNKNOWN_TOKEN,
        ],
        ["unknown-empty", "", "", "Chrome", "", ""],
        ["zero-identities", "", "", "Chrome", "ZeroOS", "zero-device"],
        [
          "empty-primary",
          "excluded-visitor",
          "excluded-session",
          "",
          "Excluded",
          "excluded",
        ],
      ] as const;
      for (const [index, row] of rows.entries())
        insert.run(
          row[0],
          SITE_ID,
          crossSitePk,
          row[1],
          row[2],
          at + index,
          at + index,
          row[3],
          row[4],
          row[5],
        );

      for (const family of ["browser", "client"] as const) {
        const dimensionLimit = family === "browser" ? 3 : 2;
        const primaryExpr =
          family === "browser"
            ? "TRIM(COALESCE(browser, ''))"
            : clientDimensionDefinition("browser").labelExpr;
        const secondaryExpr =
          family === "browser"
            ? "TRIM(COALESCE(os, ''))"
            : clientDimensionDefinition("deviceType").labelExpr;
        const parent = legacyCrossStatement({
          family,
          siteId: SITE_ID,
          window: WINDOW,
          filters: EMPTY_FILTER_DOCUMENT,
          primaryExpr,
          secondaryExpr,
          primaryLimit: 1,
          secondaryLimit: dimensionLimit,
        });
        const parentRows = rowsFromSqlite(
          crossDatabase,
          parent.sql,
          parent.bindings,
        );
        const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const env = sqliteEnv(crossDatabase, trace);
        const dto =
          family === "browser"
            ? await queryBrowserCrossDimensionFromD1(
                env,
                SITE_ID,
                WINDOW,
                EMPTY_FILTER_DOCUMENT,
                1,
                dimensionLimit,
                PAGE_DIMENSION_SELECTIONS.operatingSystem,
                "os",
              )
            : await queryCrossDimensionFromD1(
                env,
                SITE_ID,
                WINDOW,
                EMPTY_FILTER_DOCUMENT,
                1,
                dimensionLimit,
                resolveCrossBreakdownPageDimension("browser")!,
                resolveCrossBreakdownPageDimension("deviceType")!,
              );
        const rawRows = normalizeLegacyCrossRows(
          rowsFromSqlite(
            crossDatabase,
            trace.preparedSql[0]!,
            trace.bindings[0]!,
          ),
          family,
        );
        expect(rawRows).toEqual(normalizeLegacyCrossRows(parentRows, family));
        const otherPrimary =
          family === "browser"
            ? BROWSER_CROSS_OTHER_BROWSER_TOKEN
            : CLIENT_CROSS_OTHER_PRIMARY_TOKEN;
        const otherSecondary =
          family === "browser"
            ? BROWSER_CROSS_OTHER_DIMENSION_TOKEN
            : CLIENT_CROSS_OTHER_SECONDARY_TOKEN;
        const unknown =
          family === "browser"
            ? BROWSER_CROSS_UNKNOWN_TOKEN
            : CLIENT_CROSS_UNKNOWN_TOKEN;
        const rowsForFamily = rawRows.filter((row) => row.rowType === "pair");
        expect(
          rowsForFamily.find(
            (row) =>
              row.primaryValue === otherPrimary &&
              row.secondaryValue === otherSecondary,
          ),
        ).toMatchObject({
          views: family === "browser" ? 2 : 4,
          visitors: 1,
          sessions: 1,
        });
        expect(
          rowsForFamily.find(
            (row) =>
              row.primaryValue === "Chrome" &&
              row.secondaryValue === otherSecondary,
          ),
        ).toMatchObject({ views: 1, visitors: 0, sessions: 0 });
        expect(
          rawRows.find(
            (row) =>
              row.rowType ===
                (family === "browser" ? "dimension" : "secondary") &&
              row.secondaryValue === unknown,
          ),
        ).toMatchObject({ views: 2, visitors: 1, sessions: 1 });
        expect(dto.columns.find((column) => column.isUnknown)).toMatchObject({
          views: 2,
          visitors: 1,
          sessions: 1,
        });
        expect(dto.rows.flatMap((row) => row.cells)).not.toContainEqual(
          expect.objectContaining({ views: 1, visitors: 0, sessions: 0 }),
        );

        const tieParent = legacyCrossStatement({
          family,
          siteId: SITE_ID,
          window: WINDOW,
          filters: EMPTY_FILTER_DOCUMENT,
          primaryExpr,
          secondaryExpr,
          primaryLimit: 3,
          secondaryLimit: 2,
        });
        const tieTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
        const tieEnv = sqliteEnv(crossDatabase, tieTrace);
        if (family === "browser")
          await queryBrowserCrossDimensionFromD1(
            tieEnv,
            SITE_ID,
            WINDOW,
            EMPTY_FILTER_DOCUMENT,
            3,
            2,
            PAGE_DIMENSION_SELECTIONS.operatingSystem,
            "os",
          );
        else
          await queryCrossDimensionFromD1(
            tieEnv,
            SITE_ID,
            WINDOW,
            EMPTY_FILTER_DOCUMENT,
            3,
            2,
            resolveCrossBreakdownPageDimension("browser")!,
            resolveCrossBreakdownPageDimension("deviceType")!,
          );
        const tieRows = normalizeLegacyCrossRows(
          rowsFromSqlite(
            crossDatabase,
            tieTrace.preparedSql[0]!,
            tieTrace.bindings[0]!,
          ),
          family,
        );
        expect(
          tieRows
            .filter(
              (row) =>
                row.rowType === (family === "browser" ? "browser" : "primary"),
            )
            .map((row) => row.primaryValue),
        ).toEqual(["Chrome", "Edge", "Safari"]);
        expect(
          normalizeLegacyCrossRows(
            rowsFromSqlite(crossDatabase, tieParent.sql, tieParent.bindings),
            family,
          ),
        ).toEqual(tieRows);
      }
    } finally {
      crossDatabase.close();
    }
  });

  it("preserves Cross limit clamping and rejects fractional and NaN limits", async () => {
    const env = capturedEnv([]);
    await expect(
      queryBrowserCrossDimensionFromD1(
        env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        Number.NaN,
        8,
        PAGE_DIMENSION_SELECTIONS.operatingSystem,
        "os",
      ),
    ).rejects.toThrow("logical_builder_invalid_limit");
    await expect(
      queryCrossDimensionFromD1(
        env,
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        8,
        1.5,
        resolveCrossBreakdownPageDimension("browser")!,
        resolveCrossBreakdownPageDimension("deviceType")!,
      ),
    ).rejects.toThrow("logical_builder_invalid_limit");

    const clamped = await compileOnly(
      "infinite-limits",
      (limitedEnv) =>
        queryBrowserCrossDimensionFromD1(
          limitedEnv,
          SITE_ID,
          WINDOW,
          EMPTY_FILTER_DOCUMENT,
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          PAGE_DIMENSION_SELECTIONS.operatingSystem,
          "os",
        ),
      "wave57.technology_cross_breakdown",
    );
    expect(clamped).not.toHaveProperty("budgetFailure");
  });

  it("keeps Cross dimensions within the parent SQL and D1 budgets", async () => {
    const direct40 = directPayloadExistsFilters();
    const preparedPage128 = withAdvancedMatches(
      prepareTrendFilters(pagePathFilter("/prepared-match")),
      {
        visitIds: [
          { siteId: SITE_ID, id: "prepared-page-match" },
          ...Array.from({ length: 127 }, (_unused, index) => ({
            siteId: SITE_ID,
            id: `wave57-cross-budget-${index}`,
          })),
        ],
      },
    );
    const scenarios = [
      { label: "plain", filters: EMPTY_FILTER_DOCUMENT },
      { label: "direct40", filters: direct40 },
      { label: "prepared128", filters: preparedPage128 },
    ] as const;
    const results: Array<{
      label: string;
      family: CrossFamily;
      new: Awaited<ReturnType<typeof compileOnly>>;
      parent: {
        sqlBytes: number;
        bindings: number;
        withinBudget: boolean;
      };
    }> = [];

    for (const scenario of scenarios) {
      for (const family of ["browser", "client"] as const) {
        const invoke = (env: Env) =>
          family === "browser"
            ? queryBrowserCrossDimensionFromD1(
                env,
                SITE_ID,
                WINDOW,
                scenario.filters,
                8,
                6,
                PAGE_DIMENSION_SELECTIONS.operatingSystem,
                "os",
              )
            : queryCrossDimensionFromD1(
                env,
                SITE_ID,
                WINDOW,
                scenario.filters,
                8,
                6,
                resolveCrossBreakdownPageDimension("page.path")!,
                resolveCrossBreakdownPageDimension("deviceType")!,
              );
        const result = await compileOnly(
          `${scenario.label}-${family}`,
          invoke,
          "wave57.technology_cross_breakdown",
        );
        const parentStatement = legacyCrossStatement({
          family,
          siteId: SITE_ID,
          window: WINDOW,
          filters: scenario.filters,
          primaryExpr:
            family === "browser"
              ? "TRIM(COALESCE(browser, ''))"
              : "TRIM(COALESCE(pathname, ''))",
          secondaryExpr:
            family === "browser"
              ? "TRIM(COALESCE(os, ''))"
              : clientDimensionDefinition("deviceType").labelExpr,
          primaryLimit: 8,
          secondaryLimit: 6,
        });
        const parentBudget = {
          sqlBytes: new TextEncoder().encode(parentStatement.sql).byteLength,
          bindings: parentStatement.bindings.length,
          withinBudget:
            new TextEncoder().encode(parentStatement.sql).byteLength <=
              D1_MAX_SQL_UTF8_BYTES &&
            parentStatement.bindings.length <= D1_MAX_BOUND_PARAMETERS,
        };
        expect(result).not.toHaveProperty("budgetFailure");
        if ("budgetFailure" in result) continue;
        expect(result.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(result.bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
        expect(result.physicalPlanHash).toMatch(/^v\d+:[a-f0-9]{64}$/u);
        results.push({
          label: scenario.label,
          family,
          new: result,
          parent: parentBudget,
        });
      }
    }
    console.info(
      "wave57_technology_cross_breakdown_budget",
      JSON.stringify(results),
    );
  });

  it("compiles representative derived Cross selections through the finite registry", async () => {
    const pairs = [
      ["client.browserEngine", "client.osVersion"],
      ["referrer.domain", "geo.region"],
      ["client.screenSize", "geo.city"],
    ] as const;
    for (const [index, [primary, secondary]] of pairs.entries()) {
      const primaryDefinition = resolveCrossBreakdownPageDimension(primary);
      const secondaryDefinition = resolveCrossBreakdownPageDimension(secondary);
      expect(primaryDefinition).not.toBeNull();
      expect(secondaryDefinition).not.toBeNull();
      const result = await compileOnly(
        `derived-${index}`,
        (env) =>
          queryCrossDimensionFromD1(
            env,
            SITE_ID,
            WINDOW,
            EMPTY_FILTER_DOCUMENT,
            8,
            6,
            primaryDefinition!,
            secondaryDefinition!,
          ),
        "wave57.technology_cross_breakdown",
      );
      expect(result).not.toHaveProperty("budgetFailure");
      if ("budgetFailure" in result) continue;
      expect(result.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(result.bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(result.physicalPlanHash).toMatch(/^v\d+:[a-f0-9]{64}$/u);
    }
  });

  it("matches frozen SQL for derived browser, referrer, screen, region, and city pairs", async () => {
    const pairs = [
      ["client.browserEngine", "client.osVersion"],
      ["referrer.domain", "geo.region"],
      ["client.screenSize", "geo.city"],
    ] as const;
    for (const [primary, secondary] of pairs) {
      const legacyPrimary = resolveCrossBreakdownDimension(primary)!;
      const legacySecondary = resolveCrossBreakdownDimension(secondary)!;
      const parent = legacyCrossStatement({
        family: "client",
        siteId: SITE_ID,
        window: WINDOW,
        filters: EMPTY_FILTER_DOCUMENT,
        primaryExpr: legacyPrimary.labelExpr,
        secondaryExpr: legacySecondary.labelExpr,
        primaryLimit: 12,
        secondaryLimit: 8,
      });
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      await queryCrossDimensionFromD1(
        sqliteEnv(database, trace),
        SITE_ID,
        WINDOW,
        EMPTY_FILTER_DOCUMENT,
        12,
        8,
        resolveCrossBreakdownPageDimension(primary)!,
        resolveCrossBreakdownPageDimension(secondary)!,
      );
      expect(trace.preparedSql).toHaveLength(1);
      expect(
        normalizeLegacyCrossRows(
          rowsFromSqlite(database, trace.preparedSql[0]!, trace.bindings[0]!),
          "client",
        ),
      ).toEqual(
        normalizeLegacyCrossRows(
          rowsFromSqlite(database, parent.sql, parent.bindings),
          "client",
        ),
      );
    }
  });
});
