import { performance } from "node:perf_hooks";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

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
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { scopedDatasetFor } from "@/lib/edge/analytics/providers/d1/internal/__tests__/journey-list-parent-scoped-oracle";
import { buildVisitFilterSql } from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-filters";
import {
  buildVisitSourceCte,
  visitSourceBindings,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/legacy-core-sources";
import type {
  FilterDocument,
  Interval,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  buildTimeBuckets,
  timeBucketCase,
  timeBucketTimestamp,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { queryRetentionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/journey-retention";
import { instrumentEnv } from "@/lib/edge/observability/bindings";
import {
  createInvocationLogger,
  runWithD1Operation,
  runWithInvocationLogger,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";
import { normalizeFilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "journey-retention-budget-site";
const WINDOW: QueryWindow = {
  startMs: Date.UTC(2026, 0, 5),
  endExclusiveMs: Date.UTC(2026, 0, 9),
  nowMs: Date.UTC(2026, 0, 10),
  timeZone: "UTC",
};

const SITE = "journey-retention-site";
const OTHER_SITE = "journey-retention-other-site";
const DAY = 24 * 60 * 60 * 1000;

interface CapturedStatement {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

interface SiteIdentity {
  readonly id: string;
  readonly pk: number;
}

let database: DatabaseSync;
let site: SiteIdentity;
let otherSite: SiteIdentity;

function addSite(db: DatabaseSync, id: string): SiteIdentity {
  db.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const row = db
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  return { id, pk: Number(row.site_pk) };
}

function addPage(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly visitor: string;
    readonly session: string;
    readonly time: number;
    readonly path: string;
    readonly owner?: SiteIdentity;
  },
): void {
  const owner = input.owner ?? site;
  db.prepare(
    `
    INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'retention.test')
  `,
  ).run(
    input.id,
    owner.id,
    owner.pk,
    input.visitor,
    input.session,
    input.time,
    input.time,
    input.path,
  );
}

function sqliteEnv(db: DatabaseSync, trace?: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(db, trace) } as unknown as Env;
}

function pagePathFilter(path: string): FilterDocument {
  return normalizeFilterDocument(
    {
      version: 1,
      root: {
        kind: "condition",
        target: { kind: "field", field: "page.path" },
        operator: "eq",
        value: path,
      },
    },
    analyticsFilterRegistry,
  );
}

function prepareFilters(
  filters: FilterDocument,
  options: {
    readonly siteId?: string;
    readonly scope?: "event" | "session" | "visitor";
    readonly startMs?: number;
    readonly endExclusiveMs?: number;
  } = {},
): { readonly filters: FilterDocument; readonly scopePlan: ScopedFilterPlan } {
  const prepared = prepareScopedQuery("retention", {
    context: siteQueryContext(options.siteId ?? SITE, "private-dashboard"),
    time: createQueryTime(
      options.startMs ?? WINDOW.startMs - DAY,
      options.endExclusiveMs ?? WINDOW.endExclusiveMs + DAY,
      "UTC",
      WINDOW.nowMs,
    ),
    filters,
    scopePreference: options.scope ?? "event",
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly scopePlan?: ScopedFilterPlan;
  };
  if (!prepared.filters || !prepared.scopePlan)
    throw new Error("journey_retention_prepared_scope_missing");
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
  if (!metadata) throw new Error("journey_retention_prepared_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: { ...prepared.scopePlan, advancedMatches },
  });
}

function legacyRetentionOracle(
  db: DatabaseSync,
  targetSiteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  granularity: Interval,
) {
  const buckets = buildTimeBuckets(window, granularity);
  const bucket = timeBucketCase(buckets, "started_at");
  const dataset = scopedDatasetFor(targetSiteId, window, filters);
  const filter = dataset
    ? null
    : buildVisitFilterSql(filters, "all_visits", { window });
  const sql = `
WITH
${dataset?.ctes ?? buildVisitSourceCte()},
all_visits AS MATERIALIZED (
  SELECT *, ${bucket.sql} AS bucket
  FROM ${dataset?.visitRelation ?? "visit_source"}
  WHERE visitor_id != ''
),
filtered_visits AS MATERIALIZED (
  SELECT visitor_id, bucket
  FROM all_visits
  ${filter?.clause ?? ""}
),
cohort_assign AS (
  SELECT visitor_id, MIN(bucket) AS cohort_bucket
  FROM filtered_visits
  WHERE bucket IS NOT NULL
  GROUP BY visitor_id
),
visitor_buckets AS MATERIALIZED (
  SELECT av.visitor_id, av.bucket
  FROM all_visits av
  INNER JOIN cohort_assign ca ON ca.visitor_id = av.visitor_id
  WHERE av.bucket IS NOT NULL AND av.bucket >= ca.cohort_bucket
  GROUP BY av.visitor_id, av.bucket
)
SELECT cohort_bucket AS cohortBucket, vb.bucket AS visitBucket,
       COUNT(*) AS visitors
FROM visitor_buckets vb
JOIN cohort_assign ca ON vb.visitor_id = ca.visitor_id
GROUP BY cohort_bucket, vb.bucket
ORDER BY cohort_bucket ASC, vb.bucket ASC
`;
  const bindings = [
    ...(dataset
      ? dataset.bindings.map((binding) => binding.value)
      : visitSourceBindings(targetSiteId, window)),
    ...bucket.bindings,
    ...(filter?.bindings ?? []),
  ];
  const rows = db.prepare(sql).all(...bindings) as Array<
    Record<string, unknown>
  >;

  const cohortMap = new Map<
    number,
    { size: number; periods: Map<number, number> }
  >();
  for (const row of rows) {
    const cohortBucket = Number(row.cohortBucket ?? 0);
    const visitBucket = Number(row.visitBucket ?? 0);
    const visitors = Number(row.visitors ?? 0);
    if (!cohortMap.has(cohortBucket))
      cohortMap.set(cohortBucket, { size: 0, periods: new Map() });
    const cohort = cohortMap.get(cohortBucket)!;
    cohort.periods.set(visitBucket, visitors);
    if (visitBucket === cohortBucket) cohort.size = visitors;
  }
  return {
    result: {
      granularity,
      cohorts: Array.from(cohortMap.entries())
        .sort(([left], [right]) => left - right)
        .map(([cohortBucket, { size, periods }]) => ({
          bucket: timeBucketTimestamp(buckets, cohortBucket),
          size,
          periods: Array.from(periods.entries())
            .sort(([left], [right]) => left - right)
            .map(([visitBucket, visitors]) => ({
              index: Math.max(0, visitBucket - cohortBucket),
              visitors,
              rate: size > 0 ? visitors / size : 0,
            })),
        })),
    },
    sql,
    bindings,
  };
}

function seedRetentionPages(db: DatabaseSync): void {
  const start = WINDOW.startMs;
  addPage(db, {
    id: "retention-a-historical-match",
    visitor: "visitor-a",
    session: "a-old-session",
    time: start - DAY,
    path: "/match",
  });
  addPage(db, {
    id: "retention-a-match",
    visitor: "visitor-a",
    session: "a-session-0",
    time: start + 100,
    path: "/match",
  });
  addPage(db, {
    id: "retention-a-return-1",
    visitor: "visitor-a",
    session: "a-session-1",
    time: start + DAY + 100,
    path: "/other",
  });
  addPage(db, {
    id: "retention-a-return-2",
    visitor: "visitor-a",
    session: "a-session-2",
    time: start + DAY + 200,
    path: "/other",
  });
  addPage(db, {
    id: "retention-a-later-match",
    visitor: "visitor-a",
    session: "a-session-3",
    time: start + 2 * DAY + 100,
    path: "/match",
  });
  addPage(db, {
    id: "retention-a-later-return",
    visitor: "visitor-a",
    session: "a-session-4",
    time: start + 3 * DAY + 100,
    path: "/other",
  });
  addPage(db, {
    id: "retention-b-before-cohort",
    visitor: "visitor-b",
    session: "b-session-0",
    time: start + DAY + 100,
    path: "/other",
  });
  addPage(db, {
    id: "retention-b-match",
    visitor: "visitor-b",
    session: "b-session-1",
    time: start + 2 * DAY + 100,
    path: "/match",
  });
  addPage(db, {
    id: "retention-b-return",
    visitor: "visitor-b",
    session: "b-session-2",
    time: start + 3 * DAY + 100,
    path: "/other",
  });
  addPage(db, {
    id: "retention-c-no-window-match",
    visitor: "visitor-c",
    session: "c-session-0",
    time: start - DAY,
    path: "/match",
  });
  addPage(db, {
    id: "retention-c-unmatched",
    visitor: "visitor-c",
    session: "c-session-1",
    time: start + DAY + 100,
    path: "/other",
  });
  addPage(db, {
    id: "retention-empty-visitor",
    visitor: "",
    session: "empty-session",
    time: start + 100,
    path: "/match",
  });
  addPage(db, {
    id: "retention-space-visitor-match",
    visitor: " \t\u00a0",
    session: "space-session-0",
    time: start + 100,
    path: "/match",
  });
  addPage(db, {
    id: "retention-space-visitor-return",
    visitor: " \t\u00a0",
    session: "space-session-1",
    time: start + DAY + 100,
    path: "/other",
  });
  addPage(db, {
    id: "retention-other-site-match",
    visitor: "foreign-visitor",
    session: "foreign-session",
    time: start + 100,
    path: "/match",
    owner: otherSite,
  });
  addPage(db, {
    id: "retention-window-end-match",
    visitor: "after-window-visitor",
    session: "after-window-session",
    time: WINDOW.endExclusiveMs,
    path: "/match",
  });
  addPage(db, {
    id: "retention-d-partial-payload",
    visitor: "visitor-d-partial",
    session: "d-partial-session",
    time: start + 100,
    path: "/other",
  });
}

function seedPayloadEvent(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly visitId: string;
    readonly count: 39 | 40;
  },
): void {
  const time = WINDOW.startMs + 100;
  const name = db
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(site.pk, "retention-payload") as { readonly id: number } | undefined;
  const eventNameId =
    name?.id ??
    Number(
      db
        .prepare(
          "INSERT INTO custom_event_names (site_id, site_pk, name, last_seen_at) VALUES (?, ?, ?, ?) RETURNING id",
        )
        .get(SITE, site.pk, "retention-payload", time)?.id,
    );
  const pathIds = Array.from({ length: 40 }, (_unused, index) => {
    const path = `/journey-retention-${index}`;
    const existing = db
      .prepare(
        "SELECT id FROM custom_event_json_paths WHERE site_pk = ? AND path = ?",
      )
      .get(site.pk, path) as { readonly id: number } | undefined;
    if (existing) return Number(existing.id);
    const inserted = db
      .prepare(
        "INSERT INTO custom_event_json_paths (site_id, site_pk, path, last_seen_at) VALUES (?, ?, ?, ?) RETURNING id",
      )
      .get(SITE, site.pk, path, time) as { readonly id: number };
    return Number(inserted.id);
  });
  const insertedEvent = db
    .prepare(
      `
      INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING event_pk
    `,
    )
    .get(
      input.id,
      SITE,
      site.pk,
      input.visitId,
      eventNameId,
      time,
      time,
      input.count,
      input.count,
    ) as { readonly event_pk: number };
  const insertNode = db.prepare(`
    INSERT INTO custom_event_json_nodes (
      event_pk, node_id, path_id, value_type, depth
    ) VALUES (?, ?, ?, 1, 1)
  `);
  const insertValue = db.prepare(`
    INSERT INTO custom_event_json_values (
      event_pk, node_id, site_id, site_pk, event_name_id, path_id,
      occurred_at, value_type, string_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);
  for (const [index, pathId] of pathIds.slice(0, input.count).entries()) {
    const nodeId = index + 1;
    insertNode.run(insertedEvent.event_pk, nodeId, pathId);
    insertValue.run(
      insertedEvent.event_pk,
      nodeId,
      SITE,
      site.pk,
      eventNameId,
      pathId,
      time,
      `value-${index}`,
    );
  }
}

function seedPageEvent(db: DatabaseSync): void {
  const time = WINDOW.startMs + 110;
  const insertedName = db
    .prepare(
      "INSERT INTO custom_event_names (site_id, site_pk, name, last_seen_at) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .get(SITE, site.pk, "retention-page-event", time) as {
    readonly id: number;
  };
  db.prepare(
    `
    INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
  `,
  ).run(
    "retention-page-event",
    SITE,
    site.pk,
    "retention-a-match",
    insertedName.id,
    time,
    time,
  );
}

function medianSqlExecutionMs(
  statement: StatementSync,
  bindings: readonly SQLInputValue[],
): number {
  for (let index = 0; index < 3; index += 1) statement.all(...bindings);
  const samples = Array.from({ length: 20 }, () => {
    const start = performance.now();
    statement.all(...bindings);
    return performance.now() - start;
  }).sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)] ?? 0;
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
            path: `/journey-retention-${index}`,
          },
          operator: "exists" as const,
        })),
      },
    },
    analyticsFilterRegistry,
  );
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

async function compileOnly(
  label: string,
  filters: FilterDocument,
): Promise<
  | {
      readonly sqlBytes: number;
      readonly bindings: number;
      readonly physicalPlanHash: string;
    }
  | {
      readonly budgetFailure: {
        readonly item: string;
        readonly actual: number;
        readonly limit: number;
      };
    }
> {
  const statements: CapturedStatement[] = [];
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  let failure: unknown;
  try {
    await runWithInvocationLogger(logger, () =>
      runWithD1Operation(`wave55.journey_retention.${label}`, () =>
        queryRetentionFromD1(
          instrumentEnv(capturedEnv(statements), logger),
          SITE_ID,
          WINDOW,
          filters,
          "day",
        ),
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

  const tag = `wave55.journey_retention.${label}`;
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
    physicalPlanHash: String(observation?.data?.physicalPlanHash ?? ""),
  };
}

describe("journey retention Logical reader budgets", () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("compiles plain and direct 40-exists filters once within existing budgets", async () => {
    const prepared = prepareFilters(pagePathFilter("/match"), {
      siteId: SITE_ID,
    });
    const prepared128 = withAdvancedMatches(prepared, {
      visitIds: Array.from({ length: 128 }, (_unused, index) => ({
        siteId: SITE_ID,
        id: `missing-retention-page-${index}`,
      })),
    });
    const results = [
      await compileOnly("plain", EMPTY_FILTER_DOCUMENT),
      await compileOnly("direct-40-exists", directPayloadExistsFilters()),
      await compileOnly("prepared-page-128", prepared128),
    ];
    for (const result of results) {
      expect("budgetFailure" in result).toBe(false);
      if ("budgetFailure" in result) continue;
      expect(result.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(result.bindings).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(result.physicalPlanHash).toMatch(/^v\d+:[a-f0-9]{64}$/u);
    }
  });
});

describe("journey retention migrated SQLite differential", () => {
  beforeAll(() => {
    database = createMigratedDatabase();
    site = addSite(database, SITE);
    otherSite = addSite(database, OTHER_SITE);
    seedRetentionPages(database);
    seedPayloadEvent(database, {
      id: "retention-payload-full",
      visitId: "retention-a-match",
      count: 40,
    });
    seedPayloadEvent(database, {
      id: "retention-payload-partial",
      visitId: "retention-d-partial-payload",
      count: 39,
    });
    seedPageEvent(database);
  });

  afterAll(() => database.close());

  it("matches the frozen parent SQL for direct cohorts and unfiltered tracking", async () => {
    const filters = pagePathFilter("/match");
    const expected = legacyRetentionOracle(
      database,
      SITE,
      WINDOW,
      filters,
      "day",
    );
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const actual = await queryRetentionFromD1(
      sqliteEnv(database, trace),
      SITE,
      WINDOW,
      filters,
      "day",
    );

    expect(actual).toEqual(expected.result);
    expect(actual.cohorts).toEqual([
      {
        bucket: WINDOW.startMs,
        size: 2,
        periods: [
          { index: 0, visitors: 2, rate: 1 },
          { index: 1, visitors: 2, rate: 1 },
          { index: 2, visitors: 1, rate: 0.5 },
          { index: 3, visitors: 1, rate: 0.5 },
        ],
      },
      {
        bucket: WINDOW.startMs + 2 * DAY,
        size: 1,
        periods: [
          { index: 0, visitors: 1, rate: 1 },
          { index: 1, visitors: 1, rate: 1 },
        ],
      },
    ]);
    expect(trace.preparedSql).toHaveLength(1);
    const legacyPlan = database
      .prepare(`EXPLAIN QUERY PLAN ${expected.sql}`)
      .all(...expected.bindings) as Array<{ readonly detail: string }>;
    const logicalPlan = database
      .prepare(`EXPLAIN QUERY PLAN ${trace.preparedSql[0]}`)
      .all(...trace.bindings[0]!) as Array<{ readonly detail: string }>;
    expect(legacyPlan.length).toBeGreaterThan(0);
    expect(logicalPlan.length).toBeGreaterThan(0);
    const legacyExecutionMs = medianSqlExecutionMs(
      database.prepare(expected.sql),
      expected.bindings as SQLInputValue[],
    );
    const logicalExecutionMs = medianSqlExecutionMs(
      database.prepare(trace.preparedSql[0]!),
      trace.bindings[0]!,
    );
    expect(legacyExecutionMs).toBeGreaterThan(0);
    expect(logicalExecutionMs).toBeGreaterThan(0);
  });

  it("matches legacy 40-exists results for a complete event and rejects 39 of 40", async () => {
    const filters = directPayloadExistsFilters();
    const expected = legacyRetentionOracle(
      database,
      SITE,
      WINDOW,
      filters,
      "day",
    );
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const actual = await queryRetentionFromD1(
      sqliteEnv(database, trace),
      SITE,
      WINDOW,
      filters,
      "day",
    );
    expect(actual).toEqual(expected.result);
    expect(actual.cohorts.map(({ size }) => size)).toEqual([1]);
    expect(trace.preparedSql).toHaveLength(1);
  });

  it("keeps prepared Page tracking inside the final scoped Page bag", async () => {
    const rawFilters = pagePathFilter("/match");
    const prepared = prepareFilters(rawFilters, {
      startMs: WINDOW.startMs - 2 * DAY,
      endExclusiveMs: WINDOW.endExclusiveMs + 2 * DAY,
    });
    const expected = legacyRetentionOracle(
      database,
      SITE,
      WINDOW,
      prepared.filters,
      "day",
    );
    const actual = await queryRetentionFromD1(
      sqliteEnv(database),
      SITE,
      WINDOW,
      prepared.filters,
      "day",
    );
    const direct = await queryRetentionFromD1(
      sqliteEnv(database),
      SITE,
      WINDOW,
      rawFilters,
      "day",
    );

    expect(actual).toEqual(expected.result);
    expect(actual).not.toEqual(direct);
    expect(actual.cohorts[0]?.periods.map(({ index }) => index)).toEqual([
      0, 2,
    ]);
    expect(actual.cohorts[0]?.periods).not.toContainEqual(
      expect.objectContaining({ index: 1 }),
    );
  });

  it("preserves prepared page/event, Session, Visitor, empty identity, and authorization scopes", async () => {
    const filters = pagePathFilter("/match");
    const preparedPageAndEvent = withAdvancedMatches(prepareFilters(filters), {
      visitIds: [{ siteId: SITE, id: "retention-a-match" }],
      eventIds: [{ siteId: SITE, id: "retention-page-event" }],
    });
    const preparedCases = [
      preparedPageAndEvent,
      withAdvancedMatches(prepareFilters(filters), {
        visitIds: [
          { siteId: SITE, id: "retention-a-match" },
          ...Array.from({ length: 127 }, (_unused, index) => ({
            siteId: SITE,
            id: `missing-retention-page-${index}`,
          })),
        ],
      }),
      withAdvancedMatches(prepareFilters(filters, { scope: "session" }), {
        entityIds: [{ siteId: SITE, id: "a-session-0" }],
      }),
      withAdvancedMatches(prepareFilters(filters, { scope: "visitor" }), {
        entityIds: [{ siteId: SITE, id: "visitor-a" }],
      }),
      withAdvancedMatches(prepareFilters(filters), { visitIds: [] }),
    ];

    for (const prepared of preparedCases) {
      const expected = legacyRetentionOracle(
        database,
        SITE,
        WINDOW,
        prepared,
        "day",
      );
      const actual = await queryRetentionFromD1(
        sqliteEnv(database),
        SITE,
        WINDOW,
        prepared,
        "day",
      );
      expect(actual).toEqual(expected.result);
    }
    expect(
      await queryRetentionFromD1(
        sqliteEnv(database),
        SITE,
        WINDOW,
        preparedCases[4]!,
        "day",
      ),
    ).toEqual({ granularity: "day", cohorts: [] });

    const preparedForeign = withAdvancedMatches(
      prepareFilters(filters, { siteId: OTHER_SITE }),
      { visitIds: [{ siteId: OTHER_SITE, id: "retention-other-site-match" }] },
    );
    await expect(
      queryRetentionFromD1(
        sqliteEnv(database),
        SITE,
        WINDOW,
        preparedForeign,
        "day",
      ),
    ).rejects.toThrow();
  });

  it("honors the actual reader window against narrower or wider prepared metadata", async () => {
    const filters = pagePathFilter("/match");
    const preparedWindows = [
      prepareFilters(filters, {
        startMs: WINDOW.startMs - 2 * DAY,
        endExclusiveMs: WINDOW.endExclusiveMs + 2 * DAY,
      }).filters,
      prepareFilters(filters, {
        startMs: WINDOW.startMs + DAY,
        endExclusiveMs: WINDOW.endExclusiveMs - DAY,
      }).filters,
    ];
    for (const prepared of preparedWindows) {
      const expected = legacyRetentionOracle(
        database,
        SITE,
        WINDOW,
        prepared,
        "day",
      );
      const actual = await queryRetentionFromD1(
        sqliteEnv(database),
        SITE,
        WINDOW,
        prepared,
        "day",
      );
      expect(actual).toEqual(expected.result);
    }
  });
});
