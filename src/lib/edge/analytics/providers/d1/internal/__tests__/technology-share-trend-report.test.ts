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
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { ScopedFilterPlan } from "@/lib/edge/analytics/contract/scoped-filter";
import type {
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract/types";
import { buildTechnologyReferrerChannelTrendPlan } from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import type { FilterDocument } from "@/lib/edge/analytics/providers/d1/internal/core";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
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
  advancedMatches: NonNullable<ScopedFilterPlan["advancedMatches"]>,
): FilterDocument {
  const metadata = scopedFilterMetadata(prepared.filters);
  if (!metadata)
    throw new Error("technology_share_trend_prepared_metadata_missing");
  return attachScopedFilterMetadata(prepared.filters, {
    ...metadata,
    plan: { ...prepared.scopePlan, advancedMatches },
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
      started_at, last_activity_at, pathname, hostname, browser,
      referrer_host, utm_source, utm_medium
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'trend.test', ?, ?, ?, ?)
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
    input.referrerHost ?? "",
    input.utmSource ?? "",
    input.utmMedium ?? "",
  );
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
) {
  const statements: CapturedStatement[] = [];
  const logger = createInvocationLogger({
    source: "worker",
    trigger: "request",
  });
  let failure: unknown;
  try {
    await runWithInvocationLogger(logger, () =>
      runWithD1Operation(`wave54.technology_share_trend.${label}`, () =>
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
  const tag = `wave54.technology_share_trend.${label}`;
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
