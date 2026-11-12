import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { explainQueryPlan } from "@/lib/db/__tests__/query-plan";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  scopedFilterMetadata,
  type ScopedFilterPlan,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/contract/types";
import { buildOverviewTrendPlan } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import {
  scopedDatasetFor,
  scopedDatasetForUnpreparedReader,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import { buildVisitFilterSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-filters";
import {
  buildVisitSourceCte,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import {
  preparedMembershipFromIds,
  preparedMembershipIdentities,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/prepared-membership-fixture";
import {
  buildTimeBuckets,
  timeBucketCase,
  timeBucketTimestamp,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/overview";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import {
  type CanonicalJsonPath,
  type FilterDocument,
  type FilterDocument as RawFilterDocument,
  normalizeFilterDocument,
} from "@/lib/filter-contract/filters";
import type { FilterScopePreference } from "@/lib/filter-contract/scope-preference";

const SITE_ID = "wave63-trend-site";
const WINDOW: QueryWindow = {
  startMs: 0,
  endExclusiveMs: 180_000,
  nowMs: 179_000,
  timeZone: "UTC",
};

interface SiteIdentity {
  readonly siteId: string;
  readonly sitePk: number;
}

interface PageInput {
  readonly visitId: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly startedAt: number;
  readonly durationMs: number | null;
  readonly pathname: string;
}

interface EventInput {
  readonly eventId: string;
  readonly ownerVisitId: string;
  readonly occurredAt: number;
  readonly name: string;
}

interface TrendRow {
  readonly bucket: number;
  readonly timestampMs: number;
  readonly views: number;
  readonly visitors: number;
  readonly sessions: number;
  readonly bounces: number;
  readonly totalDuration: number;
  readonly durationViews: number;
}

interface SqlAndBindings {
  readonly sql: string;
  readonly bindings: Array<string | number | null>;
}

function createDatabase(): {
  readonly database: DatabaseSync;
  readonly site: SiteIdentity;
} {
  const database = createMigratedDatabase();
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const row = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(SITE_ID) as { readonly site_pk: number };
  return { database, site: { siteId: SITE_ID, sitePk: row.site_pk } };
}

function insertPage(
  database: DatabaseSync,
  site: SiteIdentity,
  input: PageInput,
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, duration_ms, pathname, hostname
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 'trend.test')`,
    )
    .run(
      input.visitId,
      site.siteId,
      site.sitePk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.durationMs,
      input.pathname,
    );
}

function insertEvent(
  database: DatabaseSync,
  site: SiteIdentity,
  input: EventInput,
): void {
  database
    .prepare(
      "INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk) VALUES (?, ?, ?, ?)",
    )
    .run(site.siteId, input.name, input.occurredAt, site.sitePk);
  const name = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(site.sitePk, input.name) as { readonly id: number };
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run(
      input.eventId,
      site.siteId,
      site.sitePk,
      input.ownerVisitId,
      name.id,
      input.occurredAt,
      input.occurredAt,
    );
}

function addPayloadValues(
  database: DatabaseSync,
  site: SiteIdentity,
  eventId: string,
  ownerVisitId: string,
  paths: readonly string[],
): void {
  insertEvent(database, site, {
    eventId,
    ownerVisitId,
    occurredAt: WINDOW.startMs + 2,
    name: "payload",
  });
  const event = database
    .prepare(
      "SELECT event_pk, event_name_id FROM custom_events WHERE event_id = ?",
    )
    .get(eventId) as {
    readonly event_pk: number;
    readonly event_name_id: number;
  };
  const insertPath = database.prepare(
    "INSERT OR IGNORE INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at) VALUES (?, ?, ?, ?)",
  );
  const insertNode = database.prepare(
    "INSERT INTO custom_event_json_nodes (event_pk, node_id, path_id, value_type, depth) VALUES (?, ?, ?, 1, 1)",
  );
  const insertValue = database.prepare(
    `INSERT INTO custom_event_json_values (
      event_pk, node_id, site_id, site_pk, event_name_id, path_id,
      occurred_at, value_type, string_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'present')`,
  );
  for (const [index, path] of paths.entries()) {
    insertPath.run(site.siteId, site.sitePk, path, WINDOW.startMs + 2);
    const pathRow = database
      .prepare(
        "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
      )
      .get(site.sitePk, path) as { readonly id: number };
    const nodeId = index + 1;
    insertNode.run(event.event_pk, nodeId, pathRow.id);
    insertValue.run(
      event.event_pk,
      nodeId,
      site.siteId,
      site.sitePk,
      event.event_name_id,
      pathRow.id,
      WINDOW.startMs + 2,
    );
  }
}

function filterDocument(root: RawFilterDocument["root"]): FilterDocument {
  return normalizeFilterDocument({ version: 1, root }, analyticsFilterRegistry);
}

function fieldFilter(field: string, value: string | number): FilterDocument {
  return filterDocument({
    kind: "condition",
    target: { kind: "field", field },
    operator: "eq",
    value,
  } as RawFilterDocument["root"]);
}

function emptyAndFilter(): FilterDocument {
  return {
    version: 1,
    root: { kind: "and", children: [] },
  } as unknown as FilterDocument;
}

function payloadExistsFilter(count: number): FilterDocument {
  return filterDocument({
    kind: "and",
    children: Array.from({ length: count }, (_unused, index) => ({
      kind: "condition" as const,
      target: {
        kind: "event-payload" as const,
        path: `/wave63/payload-${index}` as CanonicalJsonPath,
      },
      operator: "exists" as const,
    })),
  } as RawFilterDocument["root"]);
}

function queryTime(window: QueryWindow): QueryTime {
  return createQueryTime(
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    window.nowMs,
  );
}

function preparedFilter(input: {
  readonly filters: FilterDocument;
  readonly preparedMembership: NonNullable<
    ScopedFilterPlan["preparedMembership"]
  >;
  readonly scopePreference?: FilterScopePreference;
}): FilterDocument {
  const prepared = prepareScopedQuery("overview", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: queryTime(WINDOW),
    filters: input.filters,
    scopePreference: input.scopePreference ?? "session",
  } as QueryInput & {
    readonly time: QueryTime;
    readonly filters: FilterDocument;
    readonly scopePreference: FilterScopePreference;
  }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("wave63_trend_prepared_filter_missing");
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata) throw new Error("wave63_trend_prepared_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: {
      ...prepared.scopePlan,
      preparedMembership: input.preparedMembership,
    },
  });
}

/** Frozen pre-Wave63 public Trend source/filter/SQL/binding assembly. */
function parentTrendSql(
  siteId: string,
  window: QueryWindow,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters: FilterDocument,
): SqlAndBindings {
  const scopedDataset =
    scopedDatasetFor(siteId, window, filters) ??
    scopedDatasetForUnpreparedReader(
      "trend",
      siteId,
      window,
      filters,
      "session",
    );
  const filter = scopedDataset
    ? { clause: "", bindings: [] as Array<string | number> }
    : buildVisitFilterSql(filters, "visit_source", { window });
  const visitSource = buildVisitSourceCte().replace(
    "visit_source AS (",
    "visit_source AS MATERIALIZED (",
  );
  const buckets = buildTimeBuckets(window, interval);
  const visitBucket = timeBucketCase(buckets, "started_at");
  const scopedVisitorBucket = scopedDataset
    ? timeBucketCase(buckets, "observed_at")
    : null;
  const sessionBucket = timeBucketCase(
    buckets,
    scopedDataset ? "session_observed_at" : "session_started_at",
  );
  const metricSource = scopedDataset
    ? scopedDataset.visitRelation
    : "filtered_visits";
  const scopedEntityObservations = scopedDataset
    ? `
scope_entity_observations AS (
  SELECT visitor_id, session_id, started_at AS observed_at, 1 AS is_visit_observation
  FROM ${scopedDataset.visitRelation}
  UNION ALL
  SELECT visitor_id, session_id, occurred_at AS observed_at, 0 AS is_visit_observation
  FROM ${scopedDataset.eventRelation}
),`
    : "";
  const visitBucketRollup = scopedDataset
    ? `
visit_bucket_rollup AS (
  SELECT
    ${visitBucket.sql} AS bucket,
    count(*) AS views,
    0 AS visitors,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
  FROM ${metricSource}
  GROUP BY bucket
),`
    : `
visit_bucket_rollup AS (
  SELECT
    ${visitBucket.sql} AS bucket,
    count(*) AS views,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS totalDuration,
    COALESCE(sum(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationViews
  FROM ${metricSource}
  GROUP BY bucket
),`;
  const scopedVisitorBucketRollup = scopedDataset
    ? `
visitor_bucket_rollup AS (
  SELECT
    ${scopedVisitorBucket?.sql} AS bucket,
    count(DISTINCT CASE WHEN visitor_id != '' THEN visitor_id ELSE NULL END) AS visitors
  FROM scope_entity_observations
  GROUP BY bucket
),`
    : "";
  const sessionRollup = scopedDataset
    ? `
session_rollup AS (
  SELECT
    session_id,
    MIN(observed_at) AS session_observed_at,
    COUNT(CASE WHEN is_visit_observation = 1 THEN 1 END) AS visit_count
  FROM scope_entity_observations
  WHERE session_id != ''
  GROUP BY session_id
),`
    : `
session_rollup AS (
  SELECT
    vs.session_id,
    MIN(vs.started_at) AS session_started_at,
    count(*) AS visit_count
  FROM ${metricSource} vs
  WHERE vs.session_id != ''
  GROUP BY vs.session_id
),`;
  const combined = scopedDataset
    ? `
combined AS (
  SELECT bucket, views, visitors, 0 AS sessions, 0 AS bounces, totalDuration, durationViews FROM visit_bucket_rollup
  UNION ALL
  SELECT bucket, 0 AS views, visitors, 0 AS sessions, 0 AS bounces, 0 AS totalDuration, 0 AS durationViews FROM visitor_bucket_rollup
  UNION ALL
  SELECT bucket, 0 AS views, 0 AS visitors, sessions, bounces, 0 AS totalDuration, 0 AS durationViews FROM session_bucket_rollup
 )`
    : `
combined AS (
  SELECT bucket, views, visitors, 0 AS sessions, 0 AS bounces, totalDuration, durationViews FROM visit_bucket_rollup
  UNION ALL
  SELECT bucket, 0 AS views, 0 AS visitors, sessions, bounces, 0 AS totalDuration, 0 AS durationViews FROM session_bucket_rollup
 )`;
  const sourceSql = scopedDataset
    ? `${scopedDataset.ctes},
${scopedEntityObservations}`
    : `${visitSource},
filtered_visits AS MATERIALIZED (
  SELECT *
  FROM visit_source
  ${filter.clause}
),`;
  const sql = `
WITH
${sourceSql}
${visitBucketRollup}
${scopedVisitorBucketRollup}
${sessionRollup}
session_bucket_rollup AS (
  SELECT
    ${sessionBucket.sql} AS bucket,
    count(*) AS sessions,
    COALESCE(sum(CASE WHEN visit_count = 1 THEN 1 ELSE 0 END), 0) AS bounces
  FROM session_rollup
  GROUP BY bucket
),
${combined}
SELECT
  bucket,
  sum(views) AS views,
  sum(visitors) AS visitors,
  sum(sessions) AS sessions,
  sum(bounces) AS bounces,
  sum(totalDuration) AS totalDuration,
  sum(durationViews) AS durationViews
FROM combined
GROUP BY bucket
ORDER BY bucket ASC
`;
  return {
    sql,
    bindings: scopedDataset
      ? scopedDataset.bindings.map(({ value }) => value)
      : [...visitSourceBindings(siteId, window), ...filter.bindings],
  };
}

function parentTrend(
  database: DatabaseSync,
  window: QueryWindow,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters: FilterDocument,
): TrendRow[] {
  const parent = parentTrendSql(SITE_ID, window, interval, filters);
  const buckets = buildTimeBuckets(window, interval);
  return (
    database.prepare(parent.sql).all(...parent.bindings) as Record<
      string,
      unknown
    >[]
  ).map((row) => {
    const bucket = Number(row.bucket ?? 0);
    return {
      bucket,
      timestampMs: timeBucketTimestamp(buckets, bucket),
      views: Number(row.views ?? 0),
      visitors: Number(row.visitors ?? 0),
      sessions: Number(row.sessions ?? 0),
      bounces: Number(row.bounces ?? 0),
      totalDuration: Number(row.totalDuration ?? 0),
      durationViews: Number(row.durationViews ?? 0),
    };
  });
}

async function migratedTrend(
  database: DatabaseSync,
  window: QueryWindow,
  interval: "minute" | "hour" | "day" | "week" | "month",
  filters: FilterDocument,
): Promise<{ readonly rows: TrendRow[]; readonly trace: SqliteD1Trace }> {
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const rows = await queryTrendFromD1(
    { DB: createSqliteD1Database(database, trace) } as unknown as Env,
    SITE_ID,
    window,
    interval,
    filters,
  );
  return { rows, trace };
}

function coreFixture(database: DatabaseSync, site: SiteIdentity): void {
  const pages: PageInput[] = [
    {
      visitId: "dup-a",
      sessionId: "duplicate",
      visitorId: "v-a",
      startedAt: 61_000,
      durationMs: 0,
      pathname: "/selected",
    },
    {
      visitId: "dup-b",
      sessionId: "duplicate",
      visitorId: "v-a",
      startedAt: 61_000,
      durationMs: 25,
      pathname: "/selected",
    },
    {
      visitId: "single",
      sessionId: "single",
      visitorId: " ",
      startedAt: 61_000,
      durationMs: -5,
      pathname: "/selected",
    },
    {
      visitId: "tab",
      sessionId: "tab",
      visitorId: "\t",
      startedAt: 61_000,
      durationMs: null,
      pathname: "/selected",
    },
    {
      visitId: "nbsp",
      sessionId: "nbsp",
      visitorId: "\u00a0",
      startedAt: 61_000,
      durationMs: 4,
      pathname: "/selected",
    },
    {
      visitId: "pad-a",
      sessionId: "pad",
      visitorId: " alice ",
      startedAt: 61_000,
      durationMs: 5,
      pathname: "/selected",
    },
    {
      visitId: "pad-b",
      sessionId: "pad",
      visitorId: "alice",
      startedAt: 61_000,
      durationMs: 6,
      pathname: "/selected",
    },
    {
      visitId: "cross",
      sessionId: "cross",
      visitorId: "cross-v",
      startedAt: 61_000,
      durationMs: 10,
      pathname: "/selected",
    },
    {
      visitId: "empty",
      sessionId: "",
      visitorId: "",
      startedAt: 0,
      durationMs: null,
      pathname: "/selected",
    },
    {
      visitId: "owner-outside-window",
      sessionId: "event-only",
      visitorId: "event-v",
      startedAt: 180_000,
      durationMs: 10,
      pathname: "/outside",
    },
    {
      visitId: "window-end",
      sessionId: "end",
      visitorId: "v-end",
      startedAt: 180_000,
      durationMs: 100,
      pathname: "/selected",
    },
  ];
  pages.forEach((page) => insertPage(database, site, page));
  const events: EventInput[] = [
    {
      eventId: "e-dup",
      ownerVisitId: "dup-a",
      occurredAt: 80_000,
      name: "signup",
    },
    {
      eventId: "e-cross-early",
      ownerVisitId: "cross",
      occurredAt: 59_000,
      name: "signup",
    },
    {
      eventId: "e-single",
      ownerVisitId: "single",
      occurredAt: 80_000,
      name: "signup",
    },
    {
      eventId: "e-tab",
      ownerVisitId: "tab",
      occurredAt: 80_000,
      name: "signup",
    },
    {
      eventId: "e-nbsp",
      ownerVisitId: "nbsp",
      occurredAt: 80_000,
      name: "signup",
    },
    {
      eventId: "e-pad",
      ownerVisitId: "pad-a",
      occurredAt: 80_000,
      name: "signup",
    },
    {
      eventId: "e-event-only",
      ownerVisitId: "owner-outside-window",
      occurredAt: 5_000,
      name: "signup",
    },
    {
      eventId: "e-window-end",
      ownerVisitId: "cross",
      occurredAt: 180_000,
      name: "signup",
    },
  ];
  events.forEach((event) => insertEvent(database, site, event));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Overview Trend Logical report", () => {
  it("matches the frozen parent SQL for plain and scoped observation bags", async () => {
    const { database, site } = createDatabase();
    try {
      coreFixture(database, site);
      const allSessions = [
        "duplicate",
        "single",
        "tab",
        "nbsp",
        "pad",
        "cross",
        "event-only",
      ].map((id) => ({ siteId: SITE_ID, id }));
      const prepared = preparedFilter({
        filters: fieldFilter("page.path", "/selected"),
        preparedMembership: preparedMembershipFromIds({
          entityIds: allSessions,
        }),
      });
      const emptyPrepared = preparedFilter({
        filters: fieldFilter("page.path", "/selected"),
        preparedMembership: preparedMembershipFromIds({ entityIds: [] }),
      });
      const directSessionFact = fieldFilter("session.views", 2);
      const prepared128 = preparedFilter({
        filters: fieldFilter("page.path", "/selected"),
        scopePreference: "event",
        preparedMembership: preparedMembershipFromIds({
          visitIds: Array.from({ length: 128 }, (_unused, index) => ({
            siteId: SITE_ID,
            id: index === 0 ? "cross" : `wave63-missing-visit-${index}`,
          })),
          eventIds: Array.from({ length: 128 }, (_unused, index) => ({
            siteId: SITE_ID,
            id: index === 0 ? "e-cross-early" : `wave63-missing-event-${index}`,
          })),
        }),
      });
      const filters = [
        EMPTY_FILTER_DOCUMENT,
        emptyAndFilter(),
        fieldFilter("page.path", "/selected"),
        directSessionFact,
        prepared,
        emptyPrepared,
        prepared128,
      ];
      for (const interval of [
        "minute",
        "hour",
        "day",
        "week",
        "month",
      ] as const) {
        for (const filtersForCase of filters) {
          const expected = parentTrend(
            database,
            WINDOW,
            interval,
            filtersForCase,
          );
          const actual = await migratedTrend(
            database,
            WINDOW,
            interval,
            filtersForCase,
          );
          expect(actual.rows).toEqual(expected);
          expect(actual.trace.preparedSql).toHaveLength(1);
          expect(actual.trace.bindings).toHaveLength(1);
          const plan = buildOverviewTrendPlan({
            siteId: SITE_ID,
            queryTime: queryTime(WINDOW),
            filters: filtersForCase,
            interval,
          });
          expect(plan.outputs[0]?.id).toBe("overview-trend");
        }
      }
      expect(
        await migratedTrend(database, WINDOW, "minute", emptyPrepared).then(
          ({ rows }) => rows,
        ),
      ).toEqual([]);
      const parent128 = parentTrendSql(SITE_ID, WINDOW, "minute", prepared128);
      const logical128 = await migratedTrend(
        database,
        WINDOW,
        "minute",
        prepared128,
      );
      expect(parent128.bindings.length).toBeGreaterThan(100);
      expect(logical128.trace.bindings[0]!.length).toBeLessThanOrEqual(100);
      expect(logical128.trace.preparedSql[0]!.length).toBeLessThanOrEqual(
        100_000,
      );
      const previousWindow: QueryWindow = {
        startMs: 0,
        endExclusiveMs: 60_000,
        nowMs: WINDOW.nowMs,
        timeZone: WINDOW.timeZone,
      };
      expect(logical128.rows).toEqual(
        parentTrend(database, WINDOW, "minute", prepared128),
      );
      expect(
        (await migratedTrend(database, previousWindow, "minute", prepared128))
          .rows,
      ).toEqual(parentTrend(database, previousWindow, "minute", prepared128));

      const plain = parentTrend(
        database,
        WINDOW,
        "minute",
        EMPTY_FILTER_DOCUMENT,
      );
      expect(plain.find((row) => row.bucket === 0)).toMatchObject({
        views: 1,
        sessions: 0,
        visitors: 0,
      });
      expect(plain.find((row) => row.bucket === 1)).toMatchObject({
        views: 8,
        visitors: 7,
        sessions: 6,
        bounces: 4,
        totalDuration: 50,
        durationViews: 6,
      });

      const scoped = parentTrend(database, WINDOW, "minute", prepared);
      expect(scoped.find((row) => row.bucket === 0)).toMatchObject({
        views: 0,
        visitors: 2,
        sessions: 2,
        bounces: 1,
      });
      expect(scoped.find((row) => row.bucket === 1)).toMatchObject({
        views: 8,
        visitors: 7,
        sessions: 5,
        bounces: 3,
        totalDuration: 50,
        durationViews: 6,
      });

      expect(
        (await migratedTrend(database, previousWindow, "minute", prepared))
          .rows,
      ).toEqual(parentTrend(database, previousWindow, "minute", prepared));
    } finally {
      database.close();
    }
  });

  it("builds a typed report with only the requested Page/Event attributes", () => {
    const plan = buildOverviewTrendPlan({
      siteId: SITE_ID,
      queryTime: queryTime(WINDOW),
      filters: fieldFilter("session.views", 2),
      interval: "minute",
    });
    const sources = plan.nodes.filter((node) => node.kind === "source");
    const page = sources.find(
      (node) => node.kind === "source" && node.entity === "page",
    );
    const event = sources.find(
      (node) => node.kind === "source" && node.entity === "event",
    );
    expect(
      page?.kind === "source"
        ? page.values.flatMap((value) =>
            value.kind === "attribute" ? [value.attribute] : [],
          )
        : [],
    ).toEqual([
      "page.report.sessionId",
      "page.report.visitorId",
      "page.report.startedAt",
      "page.report.durationMs",
    ]);
    expect(
      event?.kind === "source"
        ? event.values.flatMap((value) =>
            value.kind === "attribute" ? [value.attribute] : [],
          )
        : [],
    ).toEqual([
      "event.report.ownerSessionId",
      "event.report.ownerVisitorId",
      "event.report.occurredAt",
    ]);
    expect(page?.kind === "source" ? page.selection?.profile : undefined).toBe(
      "direct-page-session-compat-v1",
    );
    expect(
      event?.kind === "source" ? event.selection?.profile : undefined,
    ).toBe("direct-page-session-compat-v1");
    expect(plan.nodes.some((node) => node.kind === "row-concatenation")).toBe(
      true,
    );

    const directPagePlan = buildOverviewTrendPlan({
      siteId: SITE_ID,
      queryTime: queryTime(WINDOW),
      filters: fieldFilter("page.path", "/selected"),
      interval: "minute",
    });
    const directPageSources = directPagePlan.nodes.filter(
      (node) => node.kind === "source",
    );
    expect(directPageSources.map((source) => source.entity)).toEqual(["page"]);
    expect(directPageSources[0]?.selection?.profile).toBe(
      "direct-page-session-compat-v1",
    );

    const plainPlan = buildOverviewTrendPlan({
      siteId: SITE_ID,
      queryTime: queryTime(WINDOW),
      filters: EMPTY_FILTER_DOCUMENT,
      interval: "minute",
    });
    const plainSources = plainPlan.nodes.filter(
      (node) => node.kind === "source",
    );
    expect(plainSources.map((source) => source.entity)).toEqual(["page"]);
    expect(plainSources[0]?.selection?.profile).toBe(
      "direct-page-analytics-v1",
    );

    const preparedPlan = buildOverviewTrendPlan({
      siteId: SITE_ID,
      queryTime: queryTime(WINDOW),
      filters: preparedFilter({
        filters: fieldFilter("page.path", "/selected"),
        preparedMembership: preparedMembershipFromIds({
          entityIds: [{ siteId: SITE_ID, id: "prepared" }],
        }),
      }),
      interval: "minute",
    });
    expect(
      preparedPlan.nodes
        .filter((node) => node.kind === "source")
        .map((source) => source.selection?.profile),
    ).toEqual([
      "prepared-scoped-reader-window-v1",
      "prepared-scoped-reader-window-v1",
    ]);
  });

  it("preserves the direct 40-path payload match and 39-path non-match", async () => {
    const { database, site } = createDatabase();
    try {
      insertPage(database, site, {
        visitId: "payload-40-match",
        sessionId: "payload-40-match",
        visitorId: "payload-match-visitor",
        startedAt: WINDOW.startMs + 2,
        durationMs: 0,
        pathname: "/payload-40",
      });
      insertPage(database, site, {
        visitId: "payload-39-miss",
        sessionId: "payload-39-miss",
        visitorId: "payload-miss-visitor",
        startedAt: WINDOW.startMs + 2,
        durationMs: 0,
        pathname: "/payload-39",
      });
      const paths = Array.from(
        { length: 40 },
        (_unused, index) => `/wave63/payload-${index}`,
      );
      addPayloadValues(
        database,
        site,
        "e-payload-40-match",
        "payload-40-match",
        paths,
      );
      addPayloadValues(
        database,
        site,
        "e-payload-39-miss",
        "payload-39-miss",
        paths.slice(0, 39),
      );

      const filters = payloadExistsFilter(40);
      const expected = parentTrend(database, WINDOW, "minute", filters);
      const actual = await migratedTrend(database, WINDOW, "minute", filters);
      expect(expected.reduce((sum, row) => sum + row.views, 0)).toBe(1);
      expect(actual.rows).toEqual(expected);
      expect(actual.trace.preparedSql).toHaveLength(1);
      expect(actual.trace.bindings[0]!.length).toBeLessThanOrEqual(100);
      expect(actual.trace.preparedSql[0]!.length).toBeLessThanOrEqual(100_000);
    } finally {
      database.close();
    }
  });

  it("matches the parent across hourly and daily buckets at the DST transition", async () => {
    const { database, site } = createDatabase();
    const dstWindow: QueryWindow = {
      startMs: Date.parse("2026-03-08T00:00:00-05:00"),
      endExclusiveMs: Date.parse("2026-03-10T00:00:00-04:00"),
      nowMs: Date.parse("2026-03-10T00:00:00-04:00"),
      timeZone: "America/New_York",
    };
    try {
      const pageTimes = [
        Date.parse("2026-03-08T06:59:00Z"),
        Date.parse("2026-03-08T07:00:00Z"),
        Date.parse("2026-03-09T03:59:00Z"),
        Date.parse("2026-03-09T04:00:00Z"),
        Date.parse("2026-03-10T03:59:00Z"),
      ];
      pageTimes.forEach((startedAt, index) => {
        const visitId = "dst-page-" + index;
        insertPage(database, site, {
          visitId,
          sessionId: visitId,
          visitorId: "dst-visitor-" + index,
          startedAt,
          durationMs: index === 0 ? 0 : 10,
          pathname: "/dst",
        });
        insertEvent(database, site, {
          eventId: "dst-event-" + index,
          ownerVisitId: visitId,
          occurredAt: startedAt - 1_000,
          name: "signup",
        });
      });
      insertPage(database, site, {
        visitId: "dst-end-boundary",
        sessionId: "dst-end-boundary",
        visitorId: "dst-end-boundary",
        startedAt: dstWindow.endExclusiveMs,
        durationMs: 100,
        pathname: "/dst",
      });
      expect(
        buildTimeBuckets(dstWindow, "day").map(
          (bucket) => bucket.endExclusiveMs - bucket.startMs,
        ),
      ).toEqual([23 * 60 * 60 * 1_000, 24 * 60 * 60 * 1_000]);
      for (const filters of [
        EMPTY_FILTER_DOCUMENT,
        fieldFilter("event.name", "signup"),
      ]) {
        const expected = parentTrend(database, dstWindow, "day", filters);
        const actual = await migratedTrend(database, dstWindow, "day", filters);
        expect(actual.rows).toEqual(expected);
        expect(actual.trace.preparedSql).toHaveLength(1);
      }
    } finally {
      database.close();
    }
  });

  it("computes session first-observation only inside the selected window", async () => {
    const { database, site } = createDatabase();
    const selectedWindow: QueryWindow = {
      startMs: 60_000,
      endExclusiveMs: 180_000,
      nowMs: 179_000,
      timeZone: "UTC",
    };
    try {
      insertPage(database, site, {
        visitId: "prior-window-page",
        sessionId: "window-local-session",
        visitorId: "window-local-visitor",
        startedAt: 59_000,
        durationMs: 50,
        pathname: "/prior",
      });
      insertPage(database, site, {
        visitId: "selected-window-page",
        sessionId: "window-local-session",
        visitorId: "window-local-visitor",
        startedAt: 61_000,
        durationMs: 10,
        pathname: "/selected",
      });
      const expected = parentTrend(
        database,
        selectedWindow,
        "minute",
        EMPTY_FILTER_DOCUMENT,
      );
      const actual = await migratedTrend(
        database,
        selectedWindow,
        "minute",
        EMPTY_FILTER_DOCUMENT,
      );
      expect(actual.rows).toEqual(expected);
      expect(actual.rows).toEqual([
        {
          bucket: 0,
          timestampMs: 60_000,
          views: 1,
          visitors: 1,
          sessions: 1,
          bounces: 1,
          totalDuration: 10,
          durationViews: 1,
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("keeps NULL buckets first and preserves the legacy zero mapper", async () => {
    const calls: string[] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          calls.push(sql);
          return {
            bind() {
              return {
                async all() {
                  return {
                    success: true,
                    results: [
                      {
                        bucket: null,
                        views: 2,
                        visitors: 1,
                        sessions: 1,
                        bounces: 0,
                        totalDuration: 0,
                        durationViews: 0,
                      },
                      {
                        bucket: 0,
                        views: 3,
                        visitors: 1,
                        sessions: 1,
                        bounces: 1,
                        totalDuration: 7,
                        durationViews: 1,
                      },
                    ],
                  };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
    const rows = await queryTrendFromD1(
      env,
      SITE_ID,
      WINDOW,
      "minute",
      EMPTY_FILTER_DOCUMENT,
    );
    expect(rows.map((row) => row.bucket)).toEqual([0, 0]);
    expect(rows.map((row) => row.timestampMs)).toEqual([
      buildTimeBuckets(WINDOW, "minute")[0]!.timestampMs,
      buildTimeBuckets(WINDOW, "minute")[0]!.timestampMs,
    ]);
    expect(calls[0]).toContain("ORDER BY");
    expect(calls[0]).toMatch(/ORDER BY [a-z][a-z\d]*\._c0 ASC\) AS/u);
  });

  it("records the logical plain, direct-event, and prepared SQL plans", async () => {
    const { database, site } = createDatabase();
    try {
      coreFixture(database, site);
      const prepared = preparedFilter({
        filters: fieldFilter("page.path", "/selected"),
        preparedMembership: preparedMembershipFromIds({
          entityIds: [
            "duplicate",
            "single",
            "tab",
            "nbsp",
            "pad",
            "cross",
            "event-only",
          ].map((id) => ({ siteId: SITE_ID, id })),
        }),
      });
      const scenarios = [
        { name: "plain", filters: EMPTY_FILTER_DOCUMENT },
        { name: "direct-fact", filters: fieldFilter("session.views", 2) },
        { name: "prepared", filters: prepared },
      ];
      for (const scenario of scenarios) {
        const parent = parentTrendSql(
          SITE_ID,
          WINDOW,
          "minute",
          scenario.filters,
        );
        const { rows, trace } = await migratedTrend(
          database,
          WINDOW,
          "minute",
          scenario.filters,
        );
        expect(rows).toEqual(
          parentTrend(database, WINDOW, "minute", scenario.filters),
        );
        expect(trace.preparedSql).toHaveLength(1);
        const logicalSql = trace.preparedSql[0]!;
        const parentBytes = new TextEncoder().encode(parent.sql).byteLength;
        const logicalBytes = new TextEncoder().encode(logicalSql).byteLength;
        expect(logicalBytes).toBeLessThanOrEqual(100_000);
        expect(trace.bindings[0]!.length).toBeLessThanOrEqual(100);
        expect(explainQueryPlan(database, parent).length).toBeGreaterThan(0);
        expect(
          explainQueryPlan(database, {
            sql: logicalSql,
            bindings: trace.bindings[0]!,
          }).length,
        ).toBeGreaterThan(0);
        expect(parentBytes).toBeGreaterThan(0);
        expect(scenario.name).not.toBe("");
      }
    } finally {
      database.close();
    }
  });
});
