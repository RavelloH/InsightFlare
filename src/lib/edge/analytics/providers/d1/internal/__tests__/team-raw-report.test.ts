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
import type {
  QueryInput,
  QueryTime,
  ScopedFilterPlan,
} from "@/lib/edge/analytics/contract";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  scopedFilterMetadata,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { queryWindowToTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildTeamRawDashboardReportPlan,
  TEAM_RAW_DASHBOARD_OUTPUT_FIELDS,
  TEAM_RAW_DASHBOARD_OUTPUTS,
} from "@/lib/edge/analytics/engine/team-raw-dashboard-report-plan";
import { compileScopedDatasetSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import {
  buildVisitSourceCteForSites,
  visitSourceBindingsForSites,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import type { PreparedMembershipFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import { preparedMembershipFromIds } from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { analyticsPageReportStorageColumn } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import { queryAnalyticsReportOutputSetRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type {
  FilterDocument,
  OverviewAggregateRow,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildTimeBuckets,
  mapOverviewAggregate,
  percentChange,
  timeBucketCase,
  timeBucketTimestamp,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  queryTeamDashboardForTeam,
  queryTeamOverviewFromD1,
  queryTeamTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/team";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import { sitePksFromSiteIdsSql } from "@/lib/edge/sites/identity-sql";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const TEAM_ID = "wave58-team";
const SITE_A = "wave58-team-site-a";
const SITE_B = "wave58-team-site-b";
const SITE_EMPTY = "wave58-team-site-empty";
const SITE_IDS = [SITE_A, SITE_B, SITE_EMPTY];
const OTHER_SITE = "wave58-team-site-foreign";
const BASE = Date.UTC(2026, 0, 5, 0);
const HOUR = 60 * 60 * 1000;
const WINDOW: QueryWindow = {
  startMs: BASE,
  endExclusiveMs: BASE + 4 * HOUR,
  nowMs: BASE + 8 * HOUR,
  timeZone: "UTC",
};
const PREVIOUS_WINDOW: QueryWindow = {
  ...WINDOW,
  startMs: BASE - 4 * HOUR,
  endExclusiveMs: BASE,
};

interface SiteIdentity {
  readonly id: string;
  readonly pk: number;
}

interface CapturedStatement {
  readonly sql: string;
  readonly bindings: readonly SQLInputValue[];
}

interface LegacyDataset {
  readonly ctes: string;
  readonly relation: string;
  readonly bindings: readonly SQLInputValue[];
}

let database: DatabaseSync;
let sites: Map<string, SiteIdentity>;

function addSite(db: DatabaseSync, id: string): SiteIdentity {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: Number(row.site_pk) };
}

function insertPage(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly siteId: string;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly startedAt: number;
    readonly durationMs: number | null;
    readonly pathname?: string;
  },
): void {
  const owner = sites.get(input.siteId);
  if (!owner) throw new Error(`team_fixture_site_missing:${input.siteId}`);
  db.prepare(
    `
    INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname, duration_ms
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'team-wave58.test', ?)
  `,
  ).run(
    input.id,
    input.siteId,
    owner.pk,
    input.visitorId,
    input.sessionId,
    input.startedAt,
    input.startedAt,
    input.pathname ?? "/match",
    input.durationMs,
  );
}

function seedPages(db: DatabaseSync): void {
  const current = [
    {
      id: "wave58-a-shared-1",
      siteId: SITE_A,
      visitorId: "shared-visitor",
      sessionId: "shared-session",
      startedAt: BASE + 10 * 60 * 1000,
      durationMs: 0,
    },
    {
      id: "wave58-a-shared-2",
      siteId: SITE_A,
      visitorId: "shared-visitor",
      sessionId: "shared-session",
      startedAt: BASE + HOUR + 10 * 60 * 1000,
      durationMs: 60,
    },
    {
      id: "wave58-a-empty-identity",
      siteId: SITE_A,
      visitorId: "",
      sessionId: "",
      startedAt: BASE + HOUR + 20 * 60 * 1000,
      durationMs: null,
    },
    {
      id: "wave58-a-space-identity",
      siteId: SITE_A,
      visitorId: " \t\u00a0",
      sessionId: " \t\u00a0",
      startedAt: BASE + 2 * HOUR + 10 * 60 * 1000,
      durationMs: -1,
    },
    {
      id: "wave58-b-shared-raw-identities",
      siteId: SITE_B,
      visitorId: "shared-visitor",
      sessionId: "shared-session",
      startedAt: BASE + 10 * 60 * 1000,
      durationMs: 25,
    },
    {
      id: "wave58-b-single-session",
      siteId: SITE_B,
      visitorId: "visitor-b-only",
      sessionId: "session-b-only",
      startedAt: BASE + 3 * HOUR + 10 * 60 * 1000,
      durationMs: 15,
      pathname: "/other",
    },
    {
      id: "wave58-foreign-page",
      siteId: OTHER_SITE,
      visitorId: "foreign-visitor",
      sessionId: "foreign-session",
      startedAt: BASE + 10 * 60 * 1000,
      durationMs: 999,
    },
  ];
  for (const page of current) insertPage(db, page);
  insertPage(db, {
    id: "wave58-before-window",
    siteId: SITE_A,
    visitorId: "before-visitor",
    sessionId: "before-session",
    startedAt: WINDOW.startMs - 1,
    durationMs: 800,
  });
  insertPage(db, {
    id: "wave58-at-window-end",
    siteId: SITE_A,
    visitorId: "after-visitor",
    sessionId: "after-session",
    startedAt: WINDOW.endExclusiveMs,
    durationMs: 800,
  });
  insertPage(db, {
    id: "wave58-a-previous-match",
    siteId: SITE_A,
    visitorId: "previous-a",
    sessionId: "previous-a-session",
    startedAt: PREVIOUS_WINDOW.startMs + 15 * 60 * 1000,
    durationMs: 30,
  });
  insertPage(db, {
    id: "wave58-b-previous-match",
    siteId: SITE_B,
    visitorId: "previous-b",
    sessionId: "previous-b-session",
    startedAt: PREVIOUS_WINDOW.startMs + 2 * HOUR,
    durationMs: null,
  });
}

function seedPayloadEvent(
  db: DatabaseSync,
  input: {
    readonly siteId: string;
    readonly visitId: string;
    readonly count: 39 | 40;
  },
): void {
  const owner = sites.get(input.siteId);
  if (!owner) throw new Error(`team_fixture_site_missing:${input.siteId}`);
  const eventTime = WINDOW.startMs + 30 * 60 * 1000;
  const nameRow = db
    .prepare(
      "INSERT INTO custom_event_names (site_id, site_pk, name, last_seen_at) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(input.siteId, owner.pk, "wave58-payload", eventTime) as {
    readonly id: number;
  };
  const paths = Array.from({ length: 40 }, (_unused, index) => {
    const path = `/wave58-payload-${index}`;
    const pathRow = db
      .prepare(
        "INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at) VALUES (?, ?, ?, ?) RETURNING id",
      )
      .get(input.siteId, owner.pk, path, eventTime) as {
      readonly id: number;
    };
    return Number(pathRow.id);
  });
  const event = db
    .prepare(
      `
      INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING event_pk
    `,
    )
    .get(
      `wave58-event-${input.visitId}`,
      input.siteId,
      owner.pk,
      input.visitId,
      nameRow.id,
      eventTime,
      eventTime,
      input.count,
      input.count,
    ) as { readonly event_pk: number };
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
  for (const [index, pathId] of paths.slice(0, input.count).entries()) {
    const nodeId = index + 1;
    insertNode.run(event.event_pk, nodeId, pathId);
    insertValue.run(
      event.event_pk,
      nodeId,
      input.siteId,
      owner.pk,
      nameRow.id,
      pathId,
      eventTime,
      `value-${index}`,
    );
  }
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

function payloadExistsFilter(): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "and",
        children: Array.from({ length: 40 }, (_unused, index) => ({
          kind: "condition" as const,
          target: {
            kind: "event-payload" as const,
            path: `/wave58-payload-${index}`,
          },
          operator: "exists" as const,
        })),
      },
    },
    analyticsFilterRegistry,
  );
}

function prepareTeamFilters(
  filters: FilterDocument,
  scopePreference: "auto" | "event" | "session" | "visitor" = "auto",
  authorizedSiteIds: readonly string[] = SITE_IDS,
  time: QueryWindow = WINDOW,
): { readonly filters: FilterDocument; readonly scopePlan: ScopedFilterPlan } {
  const prepared = prepareScopedQuery("team-dashboard", {
    context: teamQueryContext(TEAM_ID, "private-dashboard", authorizedSiteIds),
    time: createQueryTime(
      time.startMs,
      time.endExclusiveMs,
      time.timeZone,
      time.nowMs,
    ),
    filters,
    scopePreference,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("wave58_team_prepared_scope_missing");
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
  if (!metadata) throw new Error("wave58_team_prepared_metadata_missing");
  const plan = {
    ...prepared.scopePlan,
    preparedMembership: preparedMembershipFromIds(matches),
  };
  return attachScopedFilterMetadata(prepared.filters, { ...metadata, plan });
}

function visitSourceForWindow(window: QueryWindow, siteIds: readonly string[]) {
  const sql = `
visit_source AS MATERIALIZED (
  SELECT site_id, visitor_id, session_id, duration_ms
  FROM visits
  WHERE site_pk IN ${sitePksFromSiteIdsSql(siteIds.length)}
    AND started_at >= ? AND started_at < ?
)`;
  return {
    ctes: sql,
    relation: "visit_source",
    bindings: [...siteIds, window.startMs, window.endExclusiveMs],
  } satisfies LegacyDataset;
}

function legacyDatasetFor(
  siteIds: readonly string[],
  window: QueryWindow,
  filters?: FilterDocument,
): LegacyDataset {
  const metadata = scopedFilterMetadata(filters);
  const effective =
    metadata?.plan.mode === "entity" ||
    (filters?.root !== null && filters?.root !== undefined);
  if (!effective) return visitSourceForWindow(window, siteIds);
  if (!filters || !metadata)
    throw new Error("team_dashboard_scoped_dataset_metadata_required");
  const dataset = compileScopedDatasetSql({
    filters,
    plan: metadata.plan,
    siteIds: [...siteIds],
    window,
  });
  return {
    ctes: dataset.ctes,
    relation: dataset.visitRelation,
    bindings: dataset.bindings.map((binding) => binding.value),
  };
}

function legacyOverviewStatement(
  siteIds: readonly string[],
  window: QueryWindow,
  filters?: FilterDocument,
): CapturedStatement {
  const source = legacyDatasetFor(siteIds, window, filters);
  const sql = `
WITH
${source.ctes},
session_rollup AS (
  SELECT site_id AS siteId, session_id, count(*) AS visit_count
  FROM ${source.relation}
  WHERE session_id != ''
  GROUP BY siteId, session_id
),
combined AS (
  SELECT
    site_id AS siteId,
    count(*) AS views,
    count(DISTINCT CASE WHEN session_id != '' THEN session_id ELSE NULL END) AS sessions,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    0 AS bounces,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
  FROM ${source.relation}
  GROUP BY siteId
  UNION ALL
  SELECT
    siteId,
    0 AS views,
    0 AS sessions,
    0 AS visitors,
    COALESCE(sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END), 0) AS bounces,
    0 AS totalDuration,
    0 AS durationViews
  FROM session_rollup
  GROUP BY siteId
)
SELECT
  siteId,
  sum(views) AS views,
  sum(sessions) AS sessions,
  sum(visitors) AS visitors,
  sum(bounces) AS bounces,
  sum(totalDuration) AS totalDuration,
  sum(durationViews) AS durationViews
FROM combined
GROUP BY siteId
`;
  return { sql, bindings: source.bindings };
}

function legacyTrendStatement(
  siteIds: readonly string[],
  window: QueryWindow,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters?: FilterDocument,
): CapturedStatement {
  const metadata = scopedFilterMetadata(filters);
  const effective =
    metadata?.plan.mode === "entity" ||
    (filters?.root !== null && filters?.root !== undefined);
  const source = effective
    ? legacyDatasetFor(siteIds, window, filters)
    : ({
        ctes: buildVisitSourceCteForSites(siteIds.length),
        relation: "visit_source",
        bindings: visitSourceBindingsForSites([...siteIds], window),
      } satisfies LegacyDataset);
  const bucket = timeBucketCase(
    buildTimeBuckets(window, interval),
    "started_at",
  );
  const sql = `
WITH
${source.ctes}
SELECT
  site_id AS siteId,
  ${bucket.sql} AS bucket,
  count(*) AS views,
  count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
FROM ${source.relation}
GROUP BY siteId, bucket
ORDER BY bucket ASC, siteId ASC
`;
  return { sql, bindings: [...source.bindings, ...bucket.bindings] };
}

function legacyOverview(
  db: DatabaseSync,
  siteIds: readonly string[],
  window: QueryWindow,
  filters?: FilterDocument,
): Map<string, OverviewAggregateRow> {
  const statement = legacyOverviewStatement(siteIds, window, filters);
  const rows = db.prepare(statement.sql).all(...statement.bindings) as Array<
    Record<string, unknown>
  >;
  return new Map(
    rows.map((row) => [
      String(row.siteId ?? ""),
      {
        views: Number(row.views ?? 0),
        sessions: Number(row.sessions ?? 0),
        visitors: Number(row.visitors ?? 0),
        bounces: Number(row.bounces ?? 0),
        totalDuration: Number(row.totalDuration ?? 0),
        durationViews: Number(row.durationViews ?? 0),
      },
    ]),
  );
}

function legacyTrend(
  db: DatabaseSync,
  siteIds: readonly string[],
  window: QueryWindow,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters?: FilterDocument,
) {
  const statement = legacyTrendStatement(siteIds, window, interval, filters);
  const rows = db.prepare(statement.sql).all(...statement.bindings) as Array<
    Record<string, unknown>
  >;
  const buckets = buildTimeBuckets(window, interval);
  return rows
    .map((row) => {
      const bucket = Number(row.bucket ?? 0);
      return {
        siteId: String(row.siteId ?? ""),
        bucket,
        timestampMs: timeBucketTimestamp(buckets, bucket),
        views: Number(row.views ?? 0),
        visitors: Number(row.visitors ?? 0),
      };
    })
    .sort(
      (left, right) =>
        left.bucket - right.bucket || left.siteId.localeCompare(right.siteId),
    );
}

function sqliteEnv(db: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(db, trace) } as unknown as Env;
}

function capturedEnv(statements: CapturedStatement[], rowsRead?: number): Env {
  return {
    DB: {
      prepare: (sql: string) => ({
        bind: (...bindings: SQLInputValue[]) => ({
          all: async () => {
            statements.push({ sql, bindings });
            return {
              success: true,
              results: [],
              ...(rowsRead === undefined
                ? {}
                : { meta: { rows_read: rowsRead } }),
            };
          },
        }),
      }),
    },
  } as unknown as Env;
}

async function compilePublic(
  label: string,
  read: (env: Env) => Promise<unknown>,
): Promise<
  Array<{ sqlBytes: number; bindings: number; physicalPlanHash: string }>
> {
  const statements: CapturedStatement[] = [];
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  let failure: unknown;
  try {
    await runWithInvocationLogger(logger, () =>
      runWithD1Operation(`wave58.team.${label}`, () =>
        read(instrumentEnv(capturedEnv(statements), logger)),
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
  if (failure) throw failure;
  const tag = `wave58.team.${label}`;
  const observations = record.logs.filter(
    (entry) =>
      entry.message === "db.query.v1.all.success" && entry.data?.tag === tag,
  );
  expect(observations, label).toHaveLength(statements.length);
  return statements.map((statement, index) => {
    const sqlBytes = new TextEncoder().encode(statement.sql).byteLength;
    expect(observations[index]?.data).toMatchObject({
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
      physicalPlanHash: String(
        observations[index]?.data?.physicalPlanHash ?? "",
      ),
    };
  });
}

function parentChunkCount(
  siteIds: readonly string[],
  filters?: FilterDocument,
): number | undefined {
  if (!filters || filters.root === null) return Math.ceil(siteIds.length / 98);
  const metadata = scopedFilterMetadata(filters);
  if (!metadata)
    throw new Error("team_dashboard_scoped_dataset_metadata_required");
  const probe = compileScopedDatasetSql({
    filters,
    plan: metadata.plan,
    siteIds: [siteIds[0]!],
    window: WINDOW,
  });
  const fixedBindings = probe.bindings.length - 2;
  const maxSites = Math.floor((100 - fixedBindings) / 2);
  if (maxSites < 1) return undefined;
  return Math.ceil(siteIds.length / maxSites);
}

function explain(db: DatabaseSync, statement: CapturedStatement): string[] {
  return (
    db
      .prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
      .all(...statement.bindings) as Array<{ readonly detail: string }>
  ).map((row) => row.detail);
}

function averageSqlTimeUs(
  db: DatabaseSync,
  statement: CapturedStatement,
  iterations = 50,
): number {
  const prepared = db.prepare(statement.sql);
  for (let index = 0; index < 5; index += 1)
    prepared.all(...statement.bindings);
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1)
    prepared.all(...statement.bindings);
  return ((performance.now() - start) * 1000) / iterations;
}

beforeAll(() => {
  database = createMigratedDatabase();
  sites = new Map(
    [SITE_A, SITE_B, SITE_EMPTY, OTHER_SITE].map((id) => [
      id,
      addSite(database, id),
    ]),
  );
  seedPages(database);
  seedPayloadEvent(database, {
    siteId: SITE_A,
    visitId: "wave58-a-shared-1",
    count: 40,
  });
  seedPayloadEvent(database, {
    siteId: SITE_B,
    visitId: "wave58-b-shared-raw-identities",
    count: 39,
  });
});

afterAll(() => database.close());

describe("team raw overview and trend typed-plan migration", () => {
  it("maps rawSiteId to the stored Page site ID outside the Filter Registry", () => {
    expect(analyticsPageReportStorageColumn("page.report.rawSiteId")).toBe(
      "site_id",
    );
    expect(analyticsFilterRegistry.has("page.report.rawSiteId")).toBe(false);
  });

  it("matches the complete frozen parent Overview Map and Trend DTO on migrated SQLite", async () => {
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = sqliteEnv(database, trace);
    const expectedOverview = legacyOverview(database, SITE_IDS, WINDOW);
    const expectedTrend = legacyTrend(database, SITE_IDS, WINDOW, "hour");
    const diagnostics = createD1ReadDiagnostics();
    const actualOverview = await queryTeamOverviewFromD1(
      env,
      TEAM_ID,
      SITE_IDS,
      WINDOW,
      diagnostics,
    );
    const actualTrend = await queryTeamTrendFromD1(
      env,
      TEAM_ID,
      SITE_IDS,
      WINDOW,
      "hour",
      diagnostics,
    );

    expect(actualOverview).toEqual(expectedOverview);
    expect(actualOverview.has(SITE_EMPTY)).toBe(false);
    expect(actualOverview.get(SITE_A)).toMatchObject({
      views: 4,
      sessions: 2,
      visitors: 2,
      bounces: 1,
      totalDuration: 60,
      durationViews: 2,
    });
    expect(actualOverview.get(SITE_B)).toMatchObject({
      views: 2,
      sessions: 2,
      visitors: 2,
      bounces: 2,
      totalDuration: 40,
      durationViews: 2,
    });
    expect(actualTrend).toEqual(expectedTrend);
    expect(
      actualTrend.every(
        (row) => row.siteId === SITE_A || row.siteId === SITE_B,
      ),
    ).toBe(true);
    expect(trace.preparedSql).toHaveLength(2);
    expect(diagnostics.rowsReadAvailable).toBe(false);
  });

  it.each([
    ["event", "event"] as const,
    ["session", "session"] as const,
    ["visitor", "visitor"] as const,
  ])("matches frozen filtered readers for %s scope", async (_label, scope) => {
    const prepared = prepareTeamFilters(pagePathFilter("/match"), scope);
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const env = sqliteEnv(database, trace);
    expect(
      await queryTeamOverviewFromD1(
        env,
        TEAM_ID,
        SITE_IDS,
        WINDOW,
        undefined,
        prepared.filters,
      ),
    ).toEqual(legacyOverview(database, SITE_IDS, WINDOW, prepared.filters));
    expect(
      await queryTeamTrendFromD1(
        env,
        TEAM_ID,
        SITE_IDS,
        WINDOW,
        "hour",
        undefined,
        prepared.filters,
      ),
    ).toEqual(
      legacyTrend(database, SITE_IDS, WINDOW, "hour", prepared.filters),
    );
    expect(trace.preparedSql).toHaveLength(2);
  });

  it("retains complete 40/40 Event payload matches and rejects the 39/40 site", async () => {
    const prepared = prepareTeamFilters(payloadExistsFilter(), "event");
    const filters = prepared.filters;
    const expected = legacyOverview(database, SITE_IDS, WINDOW, filters);
    expect(expected.has(SITE_A)).toBe(true);
    expect(expected.has(SITE_B)).toBe(false);
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const actual = await queryTeamOverviewFromD1(
      sqliteEnv(database, trace),
      TEAM_ID,
      SITE_IDS,
      WINDOW,
      undefined,
      filters,
    );
    expect(actual).toEqual(expected);
    expect(
      await queryTeamTrendFromD1(
        sqliteEnv(database, trace),
        TEAM_ID,
        SITE_IDS,
        WINDOW,
        "hour",
        undefined,
        filters,
      ),
    ).toEqual(legacyTrend(database, SITE_IDS, WINDOW, "hour", filters));
    expect(trace.preparedSql).toHaveLength(2);
  });

  it("keeps empty entity scope effective and ignores empty observation metadata", async () => {
    const entity = prepareTeamFilters(EMPTY_FILTER_DOCUMENT, "session");
    const observation = prepareTeamFilters(EMPTY_FILTER_DOCUMENT, "event");
    expect(entity.scopePlan.mode).toBe("entity");
    expect(observation.scopePlan.mode).toBe("observation");

    const entityExpected = legacyOverview(
      database,
      SITE_IDS,
      WINDOW,
      entity.filters,
    );
    const entityActual = await queryTeamOverviewFromD1(
      sqliteEnv(database),
      TEAM_ID,
      SITE_IDS,
      WINDOW,
      undefined,
      entity.filters,
    );
    expect(entityActual).toEqual(entityExpected);

    const observationExpected = legacyOverview(database, SITE_IDS, WINDOW);
    const observationActual = await queryTeamOverviewFromD1(
      sqliteEnv(database),
      TEAM_ID,
      SITE_IDS,
      WINDOW,
      undefined,
      observation.filters,
    );
    expect(observationActual).toEqual(observationExpected);
  });

  it("preserves empty prepared match bags and rejects identities outside team authorization", async () => {
    const prepared = prepareTeamFilters(pagePathFilter("/never"));
    const noMatches = withAdvancedMatches(prepared, {
      visitIds: Array.from({ length: 128 }, (_unused, index) => ({
        siteId: SITE_A,
        id: `wave58-no-page-${index}`,
      })),
    });
    const emptyTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    expect(
      await queryTeamOverviewFromD1(
        sqliteEnv(database, emptyTrace),
        TEAM_ID,
        [SITE_A],
        WINDOW,
        undefined,
        noMatches,
      ),
    ).toEqual(new Map());
    expect(emptyTrace.preparedSql).toHaveLength(1);

    const foreign = withAdvancedMatches(prepared, {
      visitIds: [{ siteId: OTHER_SITE, id: "wave58-foreign-page" }],
    });
    const statements: CapturedStatement[] = [];
    await expect(
      queryTeamOverviewFromD1(
        capturedEnv(statements),
        TEAM_ID,
        [SITE_A],
        WINDOW,
        undefined,
        foreign,
      ),
    ).rejects.toThrow("prepared_identity_outside_authorization");
    expect(statements).toHaveLength(0);
  });

  it("uses actual current and previous reader windows while retaining preparation-time proof", async () => {
    const prepared = prepareTeamFilters(
      pagePathFilter("/match"),
      "event",
      SITE_IDS,
      WINDOW,
    );
    const actualCurrent = await queryTeamOverviewFromD1(
      sqliteEnv(database),
      TEAM_ID,
      SITE_IDS,
      WINDOW,
      undefined,
      prepared.filters,
    );
    const actualPrevious = await queryTeamOverviewFromD1(
      sqliteEnv(database),
      TEAM_ID,
      SITE_IDS,
      PREVIOUS_WINDOW,
      undefined,
      prepared.filters,
    );
    expect(actualCurrent).toEqual(
      legacyOverview(database, SITE_IDS, WINDOW, prepared.filters),
    );
    expect(actualPrevious).toEqual(
      legacyOverview(database, SITE_IDS, PREVIOUS_WINDOW, prepared.filters),
    );
    expect(actualPrevious.get(SITE_A)?.views).toBe(2);
    expect(actualPrevious.get(SITE_B)?.views).toBe(1);
  });

  it("passes the true team ID through the dashboard and shares one current Page graph", async () => {
    const prepared = prepareTeamFilters(pagePathFilter("/match"));
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const preloadedSites = SITE_IDS.map((id) => ({
      id,
      teamId: TEAM_ID,
      name: id,
      domain: `${id}.test`,
      publicEnabled: 0,
      publicSlug: null,
      createdAt: 1,
      updatedAt: 1,
    }));
    const dashboard = await queryTeamDashboardForTeam(
      sqliteEnv(database, trace),
      TEAM_ID,
      WINDOW,
      "hour",
      SITE_IDS,
      undefined,
      preloadedSites,
      prepared.filters,
    );
    expect(dashboard.source).toBe("raw");
    const current = legacyOverview(
      database,
      SITE_IDS,
      WINDOW,
      prepared.filters,
    );
    const previous = legacyOverview(
      database,
      SITE_IDS,
      PREVIOUS_WINDOW,
      prepared.filters,
    );
    const defaultAggregate: OverviewAggregateRow = {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDuration: 0,
      durationViews: 0,
    };
    const expectedSites = preloadedSites.map((site) => {
      const overview = mapOverviewAggregate(
        current.get(site.id) ?? defaultAggregate,
      );
      const prior = mapOverviewAggregate(
        previous.get(site.id) ?? defaultAggregate,
      );
      const currentPagesPerSession =
        overview.sessions > 0 ? overview.views / overview.sessions : 0;
      const previousPagesPerSession =
        prior.sessions > 0 ? prior.views / prior.sessions : 0;
      return {
        ...site,
        overview,
        changeRates: {
          views: percentChange(overview.views, prior.views),
          visitors: percentChange(overview.visitors, prior.visitors),
          sessions: percentChange(overview.sessions, prior.sessions),
          bounceRate: percentChange(overview.bounceRate, prior.bounceRate),
          avgDurationMs: percentChange(
            overview.avgDurationMs,
            prior.avgDurationMs,
          ),
          pagesPerSession: percentChange(
            currentPagesPerSession,
            previousPagesPerSession,
          ),
        },
      };
    });
    const expectedTrendRows = legacyTrend(
      database,
      SITE_IDS,
      WINDOW,
      "hour",
      prepared.filters,
    );
    const expectedTrend = new Map<
      number,
      {
        bucket: number;
        timestampMs: number;
        sites: Array<{ siteId: string; views: number; visitors: number }>;
      }
    >();
    for (const row of expectedTrendRows) {
      const entry = expectedTrend.get(row.bucket) ?? {
        bucket: row.bucket,
        timestampMs: row.timestampMs,
        sites: [],
      };
      entry.sites.push({
        siteId: row.siteId,
        views: row.views,
        visitors: row.visitors,
      });
      expectedTrend.set(row.bucket, entry);
    }
    expect(dashboard.data).toEqual({
      sites: expectedSites,
      trend: [...expectedTrend.values()].sort(
        (left, right) => left.bucket - right.bucket,
      ),
    });
    // One combined current statement and one previous-window overview statement.
    expect(trace.preparedSql).toHaveLength(2);
    const currentPlan = explain(database, {
      sql: trace.preparedSql[0]!,
      bindings: trace.bindings[0]!,
    });
    const currentSearches = currentPlan.filter((detail) =>
      detail.includes("idx_visits_site_pk_started_at"),
    ).length;
    expect(currentSearches).toBe(1);
  });

  it("keeps the parent 98-site boundary and does not issue more typed statements", async () => {
    const plainSites = Array.from(
      { length: 99 },
      (_unused, index) => `wave58-missing-${index}`,
    );
    const trace98Overview: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const trace99Trend: SqliteD1Trace = { preparedSql: [], bindings: [] };
    await queryTeamOverviewFromD1(
      sqliteEnv(database, trace98Overview),
      TEAM_ID,
      plainSites.slice(0, 98),
      WINDOW,
    );
    await queryTeamTrendFromD1(
      sqliteEnv(database, trace99Trend),
      TEAM_ID,
      plainSites,
      WINDOW,
      "hour",
    );
    expect(trace98Overview.preparedSql).toHaveLength(1);
    expect(trace99Trend.preparedSql).toHaveLength(2);
    expect(
      trace99Trend.bindings.every(
        (bindings) => bindings.length <= D1_MAX_BOUND_PARAMETERS,
      ),
    ).toBe(true);

    const repeatedAcrossChunks = [...plainSites.slice(0, 98), plainSites[0]!];
    const traceRepeated: SqliteD1Trace = { preparedSql: [], bindings: [] };
    await queryTeamOverviewFromD1(
      sqliteEnv(database, traceRepeated),
      TEAM_ID,
      repeatedAcrossChunks,
      WINDOW,
    );
    expect(traceRepeated.preparedSql).toHaveLength(2);
    expect(legacyTrendStatement(plainSites, WINDOW, "hour")).toBeDefined();
  });

  it("compiles prepared identity snapshots through Generic set binding compression", async () => {
    const prepared = prepareTeamFilters(pagePathFilter("/match"));
    const page128 = withAdvancedMatches(prepared, {
      visitIds: Array.from({ length: 128 }, (_unused, index) => ({
        siteId: SITE_A,
        id: `wave58-budget-page-${index}`,
      })),
    });
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    await queryTeamOverviewFromD1(
      sqliteEnv(database, trace),
      TEAM_ID,
      [SITE_A],
      WINDOW,
      undefined,
      page128,
    );
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
  });

  it("retains missing-metadata errors before preparing D1 and accumulates adapter diagnostics", async () => {
    const statements: CapturedStatement[] = [];
    await expect(
      queryTeamOverviewFromD1(
        capturedEnv(statements),
        TEAM_ID,
        [SITE_A],
        WINDOW,
        undefined,
        pagePathFilter("/match"),
      ),
    ).rejects.toThrow("team_dashboard_scoped_dataset_metadata_required");
    expect(statements).toHaveLength(0);

    const diagnostics = createD1ReadDiagnostics();
    const countedStatements: CapturedStatement[] = [];
    await queryTeamOverviewFromD1(
      capturedEnv(countedStatements, 17),
      TEAM_ID,
      [SITE_A, SITE_B],
      WINDOW,
      diagnostics,
    );
    expect(countedStatements).toHaveLength(1);
    expect(diagnostics).toEqual({ rowsRead: 17, rowsReadAvailable: true });
  });

  it("records Page source EQP and small-fixture timings against the parent SQL", async () => {
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    await queryTeamOverviewFromD1(
      sqliteEnv(database, trace),
      TEAM_ID,
      [SITE_A, SITE_B],
      WINDOW,
    );
    const parent = legacyOverviewStatement([SITE_A, SITE_B], WINDOW);
    const parentPlan = explain(database, parent);
    const typedPlan = explain(database, {
      sql: trace.preparedSql[0]!,
      bindings: trace.bindings[0]!,
    });
    const typedStatement = {
      sql: trace.preparedSql[0]!,
      bindings: trace.bindings[0]!,
    };
    expect(
      parentPlan.some((detail) =>
        detail.includes("idx_visits_site_pk_started_at"),
      ),
    ).toBe(true);
    expect(
      typedPlan.some((detail) =>
        detail.includes("idx_visits_site_pk_started_at"),
      ),
    ).toBe(true);
    const parentSearches = parentPlan.filter((detail) =>
      detail.includes(
        "SEARCH visits USING INDEX idx_visits_site_pk_started_at",
      ),
    ).length;
    const typedSearches = typedPlan.filter((detail) =>
      detail.includes("SEARCH t0 USING INDEX idx_visits_site_pk_started_at"),
    ).length;
    const trendTrace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    await queryTeamTrendFromD1(
      sqliteEnv(database, trendTrace),
      TEAM_ID,
      [SITE_A, SITE_B],
      WINDOW,
      "hour",
    );
    const parentTrend = legacyTrendStatement([SITE_A, SITE_B], WINDOW, "hour");
    const parentTrendPlan = explain(database, parentTrend);
    const typedTrend: CapturedStatement = {
      sql: trendTrace.preparedSql[0]!,
      bindings: trendTrace.bindings[0]!,
    };
    const typedTrendPlan = explain(database, typedTrend);
    const parentTrendSearches = parentTrendPlan.filter((detail) =>
      detail.includes("idx_visits_site_pk_started_at"),
    ).length;
    const typedTrendSearches = typedTrendPlan.filter((detail) =>
      detail.includes("idx_visits_site_pk_started_at"),
    ).length;
    console.info(
      "WAVE58_OVERVIEW_EQP",
      JSON.stringify({
        parentPlan: parentPlan.filter(
          (detail) =>
            detail.includes("idx_visits_site_pk_started_at") ||
            detail.includes("TEMP B-TREE"),
        ),
        typedPlan: typedPlan.filter(
          (detail) =>
            detail.includes("idx_visits_site_pk_started_at") ||
            detail.includes("TEMP B-TREE"),
        ),
        parentSearches,
        typedSearches,
        parentUs: averageSqlTimeUs(database, parent),
        typedUs: averageSqlTimeUs(database, typedStatement),
        parentTrendPlan: parentTrendPlan.filter(
          (detail) =>
            detail.includes("idx_visits_site_pk_started_at") ||
            detail.includes("TEMP B-TREE"),
        ),
        typedTrendPlan: typedTrendPlan.filter(
          (detail) =>
            detail.includes("idx_visits_site_pk_started_at") ||
            detail.includes("TEMP B-TREE"),
        ),
        parentTrendSearches,
        typedTrendSearches,
        parentTrendUs: averageSqlTimeUs(database, parentTrend),
        typedTrendUs: averageSqlTimeUs(database, typedTrend),
      }),
    );
    // A local SQLite plan is a regression signal; it is not D1 rows-read or billing data.
    expect(parentSearches).toBe(1);
    expect(typedSearches).toBe(2);
    expect(parentTrendSearches).toBe(1);
    expect(typedTrendSearches).toBe(1);
  });
});

describe("team raw reader public D1 budgets", () => {
  afterAll(() => vi.restoreAllMocks());

  it("compiles plain 1/98/99, prepared 40-exists, and Page-128 profiles for both readers", async () => {
    const budgetSites = Array.from(
      { length: 98 },
      (_unused, index) => `wave58-budget-site-${index}`,
    );
    const direct40 = prepareTeamFilters(
      payloadExistsFilter(),
      "event",
      budgetSites,
    ).filters;
    const prepared = prepareTeamFilters(
      pagePathFilter("/never"),
      "event",
      budgetSites,
    );
    const prepared128 = withAdvancedMatches(prepared, {
      visitIds: Array.from({ length: 128 }, (_unused, index) => ({
        siteId: budgetSites[0]!,
        id: `wave58-prepared-page-${index}`,
      })),
    });
    const profiles = [
      { name: "plain-1", siteIds: budgetSites.slice(0, 1), filters: undefined },
      { name: "plain-98", siteIds: budgetSites, filters: undefined },
      {
        name: "plain-99",
        siteIds: [...budgetSites, "wave58-budget-site-98"],
        filters: undefined,
      },
      { name: "direct-40-exists", siteIds: budgetSites, filters: direct40 },
      { name: "prepared-page-128", siteIds: budgetSites, filters: prepared128 },
    ] as const;
    const observations: Record<string, unknown> = {};
    for (const profile of profiles) {
      const overview = await compilePublic(`overview.${profile.name}`, (env) =>
        queryTeamOverviewFromD1(
          env,
          TEAM_ID,
          [...profile.siteIds],
          WINDOW,
          undefined,
          profile.filters,
        ),
      );
      const trend = await compilePublic(`trend.${profile.name}`, (env) =>
        queryTeamTrendFromD1(
          env,
          TEAM_ID,
          [...profile.siteIds],
          WINDOW,
          "hour",
          undefined,
          profile.filters,
        ),
      );
      for (const entry of [...overview, ...trend]) {
        expect(entry.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
        expect(entry.bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      }
      const parentChunks = parentChunkCount(profile.siteIds, profile.filters);
      const parentStatements =
        parentChunks === undefined ? undefined : parentChunks * 2;
      if (parentStatements !== undefined)
        expect(overview.length + trend.length).toBeLessThanOrEqual(
          parentStatements,
        );
      observations[profile.name] = {
        overview,
        trend,
        parentStatements,
        parentLegal: parentStatements !== undefined,
      };
    }
    console.info("WAVE58_TYPED_BUDGETS", JSON.stringify(observations));
  });
});
