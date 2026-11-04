import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import type { SiteId, TeamId } from "@/lib/edge/analytics/contract/types";
import type { SemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { createSemanticSubjectDomain } from "@/lib/edge/analytics/engine/semantic/subject";
import { queryAdvancedFilterActivityRange } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-activity-query";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";

const MAX_ADVANCED_ACTIVITIES = 20_000;
const SQLITE_ACTIVITY_LIMIT = MAX_ADVANCED_ACTIVITIES + 1;
const SITE_CHUNK_SIZE = 90;

// Frozen from the pre-migration activitySql contract. Keep this oracle separate
// from the new logical plan and physical storage mapping.
const DATA_COLUMNS = [
  "started_at",
  "status",
  "last_activity_at",
  "ended_at",
  "finalized_at",
  "duration_ms",
  "duration_source",
  "exit_reason",
  "pathname",
  "query_string",
  "hash_fragment",
  "hostname",
  "title",
  "referrer_url",
  "referrer_host",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "is_eu",
  "country",
  "region",
  "region_code",
  "city",
  "continent",
  "latitude",
  "longitude",
  "postal_code",
  "metro_code",
  "timezone",
  "as_organization",
  "ua_raw",
  "browser",
  "browser_version",
  "os",
  "os_version",
  "device_type",
  "screen_width",
  "screen_height",
  "language",
  "user_id",
  "user_name",
  "perf_ttfb_ms",
  "perf_fcp_ms",
  "perf_lcp_ms",
  "perf_cls",
  "perf_inp_ms",
] as const;

const CONSUMED_COLUMNS = [
  "kind",
  "id",
  "visit_id",
  "site_id",
  "visitor_id",
  "session_id",
  "time",
  "event_name",
  ...DATA_COLUMNS,
] as const;

const SQL_DATA_PROJECTION = DATA_COLUMNS.map(
  (column) => `v.${column} AS ${column}`,
).join(",\n");

interface FixtureSite {
  readonly id: string;
  readonly pk: number;
}

interface ActivityRange {
  readonly startMs: number;
  readonly endExclusiveMs: number;
}

interface LegacyActivityRow extends Record<string, unknown> {
  readonly kind: "page" | "event";
  readonly id: string | null;
  readonly visit_id: string | null;
  readonly site_id: string;
  readonly visitor_id: string | null;
  readonly session_id: string | null;
  readonly time: number;
  readonly event_name: string | null;
}

interface QueryMetric {
  readonly tag?: string | null;
  readonly sqlBytes?: number | null;
  readonly bindings?: number | null;
  readonly physicalPlanHash?: string | null;
}

interface ObservedQuery<Row> {
  readonly rows: readonly Row[];
  readonly trace: SqliteD1Trace;
  readonly metric: QueryMetric;
}

const databases = new Set<DatabaseSync>();

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  // The canonical migrations describe foreign keys but do not enable the
  // connection pragma. Keep that production SQLite behavior so we can model
  // historical orphan and cross-site owner rows without changing the schema.
  if (
    (database.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
      .foreign_keys !== 0
  ) {
    database.exec("PRAGMA foreign_keys = OFF");
  }
  return database;
}

function addSite(database: DatabaseSync, id: string): FixtureSite {
  database.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: row.site_pk };
}

function dataColumnValue(
  column: (typeof DATA_COLUMNS)[number],
  input: {
    readonly startedAt: number;
    readonly marker: string;
    readonly rich: boolean;
  },
): SQLInputValue {
  if (column === "started_at") return input.startedAt;
  if (column === "last_activity_at") return input.startedAt + 17;
  if (column === "ended_at") return input.rich ? input.startedAt + 20 : null;
  if (column === "finalized_at")
    return input.rich ? input.startedAt + 21 : null;
  if (column === "duration_ms") return input.rich ? 321 : null;
  if (column === "is_eu") return input.rich ? 1 : 0;
  if (column === "latitude") return input.rich ? 37.25 : null;
  if (column === "longitude") return input.rich ? -122.5 : null;
  if (column === "screen_width") return input.rich ? 1_440 : null;
  if (column === "screen_height") return input.rich ? 900 : null;
  if (column.startsWith("perf_")) return input.rich ? 12.75 : null;
  if (column === "duration_source") return input.rich ? "measured" : null;
  if (column === "exit_reason") return input.rich ? "navigation" : null;
  if (column === "user_id" || column === "user_name")
    return input.rich ? `${input.marker}:${column}` : null;
  if (
    column === "status" ||
    column === "pathname" ||
    column === "hostname" ||
    column === "title" ||
    column === "referrer_url" ||
    column === "referrer_host" ||
    column === "utm_source" ||
    column === "utm_medium" ||
    column === "utm_campaign" ||
    column === "utm_term" ||
    column === "utm_content" ||
    column === "country" ||
    column === "region" ||
    column === "region_code" ||
    column === "city" ||
    column === "continent" ||
    column === "postal_code" ||
    column === "metro_code" ||
    column === "timezone" ||
    column === "as_organization" ||
    column === "ua_raw" ||
    column === "browser" ||
    column === "browser_version" ||
    column === "os" ||
    column === "os_version" ||
    column === "device_type" ||
    column === "language"
  ) {
    if (column === "status") return input.rich ? "closed" : "open";
    if (column === "pathname") return input.rich ? "/owner/context" : "/same";
    if (column === "hostname") return "activity-report.fixture";
    if (input.rich) return `${input.marker}:${column}`;
    return "";
  }
  if (column === "query_string" || column === "hash_fragment")
    return input.rich ? `${column}=${input.marker}` : "";
  return `${input.marker}:${column}`;
}

function addVisit(
  database: DatabaseSync,
  site: FixtureSite,
  input: {
    readonly id: string | null;
    readonly startedAt: number;
    readonly sessionId?: string;
    readonly rawSiteId?: string;
    readonly visitorId?: string;
    readonly marker?: string;
    readonly rich?: boolean;
  },
): void {
  const columns = [
    "visit_id",
    "site_id",
    "visitor_id",
    "session_id",
    ...DATA_COLUMNS,
    "site_pk",
  ];
  const marker = input.marker ?? input.id ?? "null-visit";
  const values: SQLInputValue[] = [
    input.id,
    input.rawSiteId ?? site.id,
    input.visitorId ?? `visitor:${marker}`,
    input.sessionId ?? `session:${marker}`,
    ...DATA_COLUMNS.map((column) =>
      dataColumnValue(column, {
        startedAt: input.startedAt,
        marker,
        rich: input.rich ?? false,
      }),
    ),
    site.pk,
  ];
  database
    .prepare(
      `INSERT INTO visits (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...values);
}

function addEventName(
  database: DatabaseSync,
  site: FixtureSite,
  id: number,
  name: string,
): void {
  database
    .prepare(
      "INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, 1, ?)",
    )
    .run(id, site.id, name, site.pk);
}

function addEvent(
  database: DatabaseSync,
  site: FixtureSite,
  input: {
    readonly id: string;
    readonly visitId: string | null;
    readonly nameId: number;
    readonly occurredAt: number;
    readonly rawSiteId?: string;
    readonly sitePk?: number;
  },
): void {
  database
    .prepare(
      "INSERT INTO custom_events (event_id, site_id, visit_id, event_name_id, occurred_at, received_at, sequence, node_count, value_count, site_pk) VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?)",
    )
    .run(
      input.id,
      input.rawSiteId ?? site.id,
      input.visitId,
      input.nameId,
      input.occurredAt,
      input.occurredAt,
      input.sitePk ?? site.pk,
    );
}

function oldActivitySql(siteCount: number): string {
  const sitePlaceholders = Array.from({ length: siteCount }, () => "?").join(
    ", ",
  );
  const pageSiteMembership = `v.site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${sitePlaceholders}))`;
  const eventSiteMembership = `ce.site_pk IN (SELECT site_pk FROM site_identities WHERE site_id IN (${sitePlaceholders}))`;
  return `
SELECT * FROM (
  SELECT
    'page' AS kind,
    v.visit_id AS id,
    v.visit_id,
    v.site_id,
    v.site_pk,
    v.visitor_id,
    v.session_id,
    v.started_at AS time,
    CAST(NULL AS INTEGER) AS event_pk,
    CAST(NULL AS TEXT) AS event_name,
    ${DATA_COLUMNS.map((column) => `v.${column} AS ${column}`).join(",\n")}
  FROM visits v
  WHERE ${pageSiteMembership} AND v.started_at >= ? AND v.started_at < ?
  UNION ALL
  SELECT
    'event' AS kind,
    ce.event_id AS id,
    ce.visit_id,
    ce.site_id,
    ce.site_pk,
    v.visitor_id,
    v.session_id,
    ce.occurred_at AS time,
    ce.event_pk,
    cen.name AS event_name,
    ${SQL_DATA_PROJECTION}
  FROM custom_events ce
  INNER JOIN custom_event_names cen ON cen.id = ce.event_name_id AND cen.site_pk = ce.site_pk
  INNER JOIN visits v ON v.site_pk = ce.site_pk AND v.visit_id = ce.visit_id
  WHERE ${eventSiteMembership} AND ce.occurred_at >= ? AND ce.occurred_at < ?
)
ORDER BY time ASC, CASE kind WHEN 'page' THEN 0 ELSE 1 END ASC, id ASC
LIMIT ?`;
}

function legacyChunkRows(
  database: DatabaseSync,
  siteIds: readonly string[],
  range: ActivityRange,
): LegacyActivityRow[] {
  const rows = database
    .prepare(oldActivitySql(siteIds.length))
    .all(
      ...siteIds,
      range.startMs,
      range.endExclusiveMs,
      ...siteIds,
      range.startMs,
      range.endExclusiveMs,
      SQLITE_ACTIVITY_LIMIT,
    ) as LegacyActivityRow[];
  return rows;
}

function legacyLoadActivities(
  database: DatabaseSync,
  siteIds: readonly string[],
  ranges: readonly ActivityRange[],
): LegacyActivityRow[] {
  const activities: LegacyActivityRow[] = [];
  for (let offset = 0; offset < siteIds.length; offset += SITE_CHUNK_SIZE) {
    const chunk = siteIds.slice(offset, offset + SITE_CHUNK_SIZE);
    for (const range of ranges) {
      activities.push(...legacyChunkRows(database, chunk, range));
    }
  }
  return activities;
}

function consumed(
  row: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  for (const column of CONSUMED_COLUMNS) projection[column] = row[column];
  return projection;
}

function subjectFor(siteIds: readonly string[]): SemanticSubjectDomain {
  return createSemanticSubjectDomain({
    origin: "team",
    teamId: "wave26-activity-team" as TeamId,
    siteIds: siteIds.map((siteId) => siteId as SiteId),
  });
}

function sqliteEnv(database: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, trace) } as unknown as Env;
}

async function observeQuery<Row>(
  database: DatabaseSync,
  invoke: (env: Env) => Promise<readonly Row[]>,
): Promise<ObservedQuery<Row>> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  const env = instrumentEnv(sqliteEnv(database, trace), logger);
  const rows = await runWithInvocationLogger(logger, () =>
    runWithD1Operation("advanced_filter.activities", () => invoke(env)),
  );
  const invocation = await logger.emitWhenComplete();
  const metric = invocation.logs.find((entry) =>
    entry.message.startsWith("db.query.v1.all.success"),
  )?.data as QueryMetric | undefined;
  if (!metric) throw new Error("activity_report_query_diagnostics_missing");
  return { rows, trace, metric };
}

afterAll(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("advanced filter activity report query differential", () => {
  it("preserves the old ordered consumed-row contract on migrated SQLite", async () => {
    const database = createFixture();
    const siteA = addSite(database, " leading '雪🌍 ");
    const siteB = addSite(database, "site-B");
    const siteRawEmpty = addSite(database, "site-for-empty-raw-id");
    const siteUpper = addSite(database, "CaseID");
    const siteLower = addSite(database, "caseid");
    const outside = addSite(database, "not-authorized");
    const authorized = [siteA, siteB, siteRawEmpty, siteUpper, siteLower].map(
      (site) => site.id,
    );
    authorized.push("missing-but-authorized");

    addEventName(database, siteA, 1001, "valid-雪");
    addEventName(database, siteB, 1002, "foreign-name");
    const richOwnerId = "owner-outside-range";
    addVisit(database, siteA, {
      id: richOwnerId,
      startedAt: 50,
      sessionId: "shared-session",
      visitorId: "CaseVisitor",
      rawSiteId: "raw-page-site-id",
      marker: "rich-owner",
      rich: true,
    });
    addVisit(database, siteA, {
      id: "page-at-start",
      startedAt: 100,
      sessionId: "shared-session",
      rawSiteId: "raw-page-site-id",
    });
    addVisit(database, siteA, {
      id: "page-before-end",
      startedAt: 199,
      sessionId: "shared-session",
    });
    addVisit(database, siteA, { id: "page-at-end", startedAt: 200 });
    addVisit(database, siteA, { id: "page-before-start", startedAt: 99 });
    addVisit(database, siteA, {
      id: "",
      startedAt: 150,
      sessionId: "shared-session",
    });
    addVisit(database, siteA, {
      id: "page-same-ms-z",
      startedAt: 150,
      sessionId: "shared-session",
    });
    addVisit(database, siteA, {
      id: "页🌍-page",
      startedAt: 150,
      sessionId: "shared-session",
    });
    addVisit(database, siteB, {
      id: "site-b-shared-session",
      startedAt: 150,
      sessionId: "shared-session",
    });
    addVisit(database, siteRawEmpty, {
      id: "empty-site-page",
      startedAt: 150,
      rawSiteId: "",
    });
    addVisit(database, siteUpper, { id: "upper-site-page", startedAt: 150 });
    addVisit(database, siteLower, { id: "lower-site-page", startedAt: 150 });
    addVisit(database, outside, { id: "unauthorized-page", startedAt: 150 });

    // SQLite permits multiple NULL visit_id values for this rowid table's
    // TEXT PRIMARY KEY, yielding truly identical projected Page rows.
    addVisit(database, siteA, {
      id: null,
      startedAt: 151,
      sessionId: "null-id-session",
      visitorId: "null-id-visitor",
      marker: "duplicate-null-id",
    });
    addVisit(database, siteA, {
      id: null,
      startedAt: 151,
      sessionId: "null-id-session",
      visitorId: "null-id-visitor",
      marker: "duplicate-null-id",
    });

    addEvent(database, siteA, {
      id: "event-before-start",
      visitId: richOwnerId,
      nameId: 1001,
      occurredAt: 99,
    });
    addEvent(database, siteA, {
      id: "event-at-start",
      visitId: richOwnerId,
      nameId: 1001,
      occurredAt: 100,
      rawSiteId: "raw-event-site-id",
    });
    addEvent(database, siteA, {
      id: "event-same-ms-z",
      visitId: richOwnerId,
      nameId: 1001,
      occurredAt: 150,
      rawSiteId: "raw-event-site-id",
    });
    addEvent(database, siteA, {
      id: "",
      visitId: richOwnerId,
      nameId: 1001,
      occurredAt: 150,
    });
    addEvent(database, siteA, {
      id: "event-雪",
      visitId: richOwnerId,
      nameId: 1001,
      occurredAt: 150,
    });
    addEvent(database, siteA, {
      id: "CaseEvent",
      visitId: richOwnerId,
      nameId: 1001,
      occurredAt: 150,
    });
    addEvent(database, siteA, {
      id: "caseevent",
      visitId: richOwnerId,
      nameId: 1001,
      occurredAt: 150,
    });
    addEvent(database, siteA, {
      id: "event-before-end",
      visitId: richOwnerId,
      nameId: 1001,
      occurredAt: 199,
    });
    addEvent(database, siteA, {
      id: "event-at-end",
      visitId: richOwnerId,
      nameId: 1001,
      occurredAt: 200,
    });
    addEvent(database, siteA, {
      id: "event-missing-name",
      visitId: richOwnerId,
      nameId: 98_765,
      occurredAt: 151,
    });
    addEvent(database, siteA, {
      id: "event-foreign-name",
      visitId: richOwnerId,
      nameId: 1002,
      occurredAt: 152,
    });
    addEvent(database, siteA, {
      id: "event-orphan-owner",
      visitId: "missing-owner",
      nameId: 1001,
      occurredAt: 153,
    });
    addEvent(database, siteA, {
      id: "event-cross-site-owner",
      visitId: "site-b-shared-session",
      nameId: 1001,
      occurredAt: 154,
    });

    const range = { startMs: 100, endExclusiveMs: 200 } as const;
    const expected = legacyLoadActivities(database, authorized, [range]);
    const diagnostics = createD1ReadDiagnostics();
    const actual = await observeQuery(database, async (env) => {
      const subject = subjectFor(authorized);
      const result = [];
      for (
        let offset = 0;
        offset < authorized.length;
        offset += SITE_CHUNK_SIZE
      ) {
        const siteIds = authorized.slice(offset, offset + SITE_CHUNK_SIZE);
        result.push(
          ...(await queryAdvancedFilterActivityRange({
            env,
            subject,
            siteIds,
            range,
            diagnostics,
          })),
        );
      }
      return result;
    });

    expect(actual.rows.map((row) => consumed({ ...row }))).toEqual(
      expected.map(consumed),
    );
    expect(actual.rows).toHaveLength(18);
    expect(actual.rows.filter((row) => row.id === null)).toHaveLength(2);
    expect(actual.rows.filter((row) => row.kind === "event")).toHaveLength(7);
    expect(actual.rows.some((row) => row.id === "页🌍-page")).toBe(true);
    expect(actual.rows.some((row) => row.id === "event-雪")).toBe(true);
    expect(actual.rows.some((row) => row.id === "CaseEvent")).toBe(true);
    expect(actual.rows.some((row) => row.id === "caseevent")).toBe(true);
    expect(actual.rows.map((row) => row.kind + ":" + String(row.id))).toContain(
      "page:",
    );
    expect(actual.rows.some((row) => row.site_id === "raw-page-site-id")).toBe(
      true,
    );
    expect(actual.rows.some((row) => row.site_id === "raw-event-site-id")).toBe(
      true,
    );
    expect(actual.rows.some((row) => row.site_id === "")).toBe(true);
    expect(actual.rows.some((row) => row.site_id === "CaseID")).toBe(true);
    expect(actual.rows.some((row) => row.site_id === "caseid")).toBe(true);
    expect(actual.rows.some((row) => row.id === "unauthorized-page")).toBe(
      false,
    );
    expect(actual.rows.some((row) => row.id === "missing-but-authorized")).toBe(
      false,
    );
    expect(actual.rows.some((row) => row.id === "owner-outside-range")).toBe(
      false,
    );
    expect(
      actual.rows.some(
        (row) =>
          row.kind === "event" &&
          row.id === "event-at-start" &&
          row.time === 100 &&
          row.started_at === 50 &&
          row.title === "rich-owner:title",
      ),
    ).toBe(true);
    const sameMillisecondRows = actual.rows.filter((row) => row.time === 150);
    const lastPageAtSameMillisecond = sameMillisecondRows.reduce(
      (lastIndex, row, index) => (row.kind === "page" ? index : lastIndex),
      -1,
    );
    const firstEventAtSameMillisecond = sameMillisecondRows.findIndex(
      (row) => row.kind === "event",
    );
    expect(firstEventAtSameMillisecond).toBeGreaterThan(
      lastPageAtSameMillisecond,
    );
    expect(actual.trace.preparedSql).toHaveLength(1);
    expect(actual.trace.bindings).toHaveLength(1);
    expect(JSON.stringify(actual.trace.bindings[0])).toContain(
      " leading '雪🌍 ",
    );
    expect(JSON.stringify(actual.trace.bindings[0])).not.toContain(
      "not-authorized",
    );
    expect(actual.metric).toMatchObject({
      tag: "advanced_filter.activities",
      sqlBytes: new TextEncoder().encode(actual.trace.preparedSql[0]!)
        .byteLength,
      bindings: actual.trace.bindings[0]!.length,
      physicalPlanHash: expect.stringMatching(/^v8:/u),
    });
    expect(actual.trace.bindings[0]!.length).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    expect(
      new TextEncoder().encode(actual.trace.preparedSql[0]!).byteLength,
    ).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
    expect(
      explainQueryPlan(database, {
        sql: actual.trace.preparedSql[0]!,
        bindings: actual.trace.bindings[0]!,
      }).join("\n"),
    ).toMatch(/idx_(visits|custom_events).*site_pk/u);
    expect(diagnostics).toMatchObject({
      rowsRead: 0,
      rowsReadAvailable: false,
    });
  });

  it("matches the old bag across overlapping and disjoint ranges and 90/91-site chunks", async () => {
    const database = createFixture();
    const siteIds = Array.from({ length: 91 }, (_unused, index) => {
      const id = `wave26-site-${index.toString().padStart(3, "0")}`;
      const site = addSite(database, id);
      addVisit(database, site, {
        id: `visit-${index.toString().padStart(3, "0")}`,
        startedAt: 100 + (index % 90),
        sessionId: `shared-${index % 2}`,
      });
      return id;
    });
    const subject = subjectFor(siteIds);
    const overlapping = [
      { startMs: 100, endExclusiveMs: 150 },
      { startMs: 140, endExclusiveMs: 190 },
    ] as const;
    const disjoint = [
      { startMs: 100, endExclusiveMs: 130 },
      { startMs: 160, endExclusiveMs: 190 },
    ] as const;

    for (const ranges of [overlapping, disjoint]) {
      const expected = legacyLoadActivities(database, siteIds, ranges);
      const actual = await observeQuery(database, async (env) => {
        const result = [];
        for (
          let offset = 0;
          offset < siteIds.length;
          offset += SITE_CHUNK_SIZE
        ) {
          const chunk = siteIds.slice(offset, offset + SITE_CHUNK_SIZE);
          for (const range of ranges) {
            result.push(
              ...(await queryAdvancedFilterActivityRange({
                env,
                subject,
                siteIds: chunk,
                range,
              })),
            );
          }
        }
        return result;
      });

      expect(actual.rows.map((row) => consumed({ ...row }))).toEqual(
        expected.map(consumed),
      );
      expect(actual.trace.preparedSql).toHaveLength(4);
      expect(
        actual.trace.bindings.every(
          (bindings) => bindings.length <= D1_MAX_BOUND_PARAMETERS,
        ),
      ).toBe(true);
      expect(
        actual.trace.preparedSql.every(
          (sql) =>
            new TextEncoder().encode(sql).byteLength <= D1_MAX_SQL_UTF8_BYTES,
        ),
      ).toBe(true);
      expect(
        actual.trace.preparedSql.every((sql) =>
          siteIds.some((siteId) => sql.includes(siteId)),
        ),
      ).toBe(false);
      expect(JSON.stringify(actual.trace.bindings[0])).toContain(
        "wave26-site-000",
      );
      expect(JSON.stringify(actual.trace.bindings[2])).toContain(
        "wave26-site-090",
      );
      const plans = actual.trace.preparedSql.map((sql, index) =>
        explainQueryPlan(database, {
          sql,
          bindings: actual.trace.bindings[index]!,
        }).join("\n"),
      );
      expect(plans.some((plan) => /idx_visits.*site_pk/u.test(plan))).toBe(
        true,
      );
      expect(
        plans.some((plan) => /idx_custom_events.*site_pk/u.test(plan)),
      ).toBe(true);
      // The duplicated time-window rows in the overlap are retained once per
      // range call, matching the old chunk-outer/range-inner loader contract.
      if (ranges === overlapping) {
        expect(actual.rows.length).toBeGreaterThan(
          legacyLoadActivities(database, siteIds, [
            { startMs: 100, endExclusiveMs: 190 },
          ]).length,
        );
      }
    }
  });

  // The isolated V8-coverage run took about six seconds; leave a bounded 20s
  // for this real 20,001-row differential under full-check CPU contention.
  it("applies the real legacy-compatible 20,001-row per-query limit", async () => {
    const database = createFixture();
    try {
      const site = addSite(database, "wave26-limit-site");
      const insert = database.prepare(
        "INSERT INTO visits (visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname, site_pk) VALUES (?, ?, ?, ?, 'closed', 120, 120, '/', 'limit.fixture', ?)",
      );
      database.exec("BEGIN");
      try {
        for (let index = 0; index < SQLITE_ACTIVITY_LIMIT + 2; index += 1) {
          const id = `limit-${index.toString().padStart(5, "0")}`;
          insert.run(id, site.id, "visitor", "session", site.pk);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }

      const range = { startMs: 100, endExclusiveMs: 200 } as const;
      const subject = subjectFor([site.id]);
      const expected = legacyChunkRows(database, [site.id], range);
      const actual = await observeQuery(database, (env) =>
        queryAdvancedFilterActivityRange({
          env,
          subject,
          siteIds: [site.id],
          range,
        }),
      );

      expect(expected).toHaveLength(SQLITE_ACTIVITY_LIMIT);
      expect(actual.rows).toHaveLength(SQLITE_ACTIVITY_LIMIT);
      expect(actual.rows.map((row) => consumed({ ...row }))).toEqual(
        expected.map(consumed),
      );
      expect(actual.rows[0]?.id).toBe("limit-00000");
      expect(actual.rows.at(-1)?.id).toBe("limit-20000");
      expect(actual.trace.preparedSql).toHaveLength(1);
    } finally {
      databases.delete(database);
      database.close();
    }
  }, 20_000);
});
