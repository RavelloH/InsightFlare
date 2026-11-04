import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { handlePlannedSiteEventTypeDetail } from "@/lib/api-v1/analytics/site-list";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { emptyEventContextCards } from "@/lib/edge/analytics/composition/d1/shared";
import type { AnalyticsQueryExecutor } from "@/lib/edge/analytics/composition/query-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { EVENT_TYPE_OVERVIEW_OUTPUTS } from "@/lib/edge/analytics/engine/event-type-overview-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredEventTypeDetailQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { compileEventTypeDetailQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import {
  mapEventAnalyticsContextCards,
  mapTabs,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  EVENT_CONTEXT_CARD_KEYS,
  queryEventAnalyticsContextCardsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-context";
import { queryEventTypeOverviewFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-overview";
import { queryEventTypeTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import type { ApiKeyPrincipal } from "@/lib/edge/auth/api-key-auth";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "wave94h-event-type-detail-runtime";
const WINDOW = {
  startMs: Date.UTC(2026, 0, 1, 8),
  endExclusiveMs: Date.UTC(2026, 0, 4, 8),
  nowMs: Date.UTC(2026, 0, 5, 8),
  timeZone: "America/Los_Angeles",
} as const;
const QUERY_TIME = createQueryTime(
  WINDOW.startMs,
  WINDOW.endExclusiveMs,
  WINDOW.timeZone,
  WINDOW.nowMs,
);
const databases = new Set<DatabaseSync>();
const runtimeEvidence: unknown[] = [];

interface DetailQuery extends QueryInput {
  readonly filters: FilterDocument;
  readonly time: QueryTime;
  readonly eventName: string;
  readonly interval: "minute" | "hour" | "day" | "week" | "month";
  readonly includeBreakdowns?: boolean;
  readonly includeContext?: boolean;
}

interface DetailOverrides {
  readonly eventName?: string;
  readonly interval?: DetailQuery["interval"];
  readonly includeBreakdowns?: boolean;
  readonly includeContext?: boolean;
  readonly filterDsl?: string;
}

function newTrace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "wave94h-event-type-detail-runtime-test-secret",
  } as unknown as Env;
}

function captureRuntimeEvidence(input: {
  readonly scenario: string;
  readonly trace: SqliteD1Trace;
  readonly diagnostics: ReturnType<typeof createD1ReadDiagnostics>;
  readonly actual: unknown;
  readonly expected: unknown;
}): void {
  runtimeEvidence.push({
    scenario: input.scenario,
    kind: "compared",
    fallbackReason: input.diagnostics.advancedCountSqlFallbackReason ?? null,
    statementCount: input.trace.preparedSql.length,
    statementMetrics: input.trace.preparedSql.map((sql, index) => ({
      index,
      sqlBytes: new TextEncoder().encode(sql).byteLength,
      sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
      bindingCount: input.trace.bindings[index]?.length ?? null,
    })),
    bindingsPerCall: input.trace.bindings.map((bindings) => bindings.length),
    actualDto: input.actual,
    legacyDto: input.expected,
  });
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE_ID);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE_ID) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(SITE_ID, "wave94h-team", "Event type detail", "detail.test");
  database
    .prepare(
      `INSERT INTO custom_event_names
       (id, site_id, name, last_seen_at, site_pk)
       VALUES
         (1, ?, 'purchase', ?, ?),
         (2, ?, 'signup', ?, ?),
         (3, ?, '', ?, ?),
         (4, ?, '   ', ?, ?),
         (5, ?, ' purchase ', ?, ?)`,
    )
    .run(
      SITE_ID,
      WINDOW.endExclusiveMs - 1,
      sitePk,
      SITE_ID,
      WINDOW.endExclusiveMs - 1,
      sitePk,
      SITE_ID,
      WINDOW.endExclusiveMs - 1,
      sitePk,
      SITE_ID,
      WINDOW.endExclusiveMs - 1,
      sitePk,
      SITE_ID,
      WINDOW.endExclusiveMs - 1,
      sitePk,
    );
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, hostname, title, country,
      browser, device_type
    ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'detail.test', ?, 'US', 'Chrome', 'desktop')`,
  );
  insertVisit.run(
    "visit-scoped",
    SITE_ID,
    sitePk,
    "visitor-a",
    "session-a",
    WINDOW.startMs + 1,
    WINDOW.startMs + 1,
    "/scoped",
    "Scoped page",
  );
  insertVisit.run(
    "visit-other-page",
    SITE_ID,
    sitePk,
    "visitor-a",
    "session-b",
    WINDOW.startMs + 2,
    WINDOW.startMs + 2,
    "/other",
    "Other page",
  );
  const insertEvent = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  );
  insertEvent.run(
    "event-purchase-a",
    SITE_ID,
    sitePk,
    "visit-scoped",
    1,
    WINDOW.startMs + 1000,
    WINDOW.startMs + 1000,
    1,
  );
  insertEvent.run(
    "event-signup-a",
    SITE_ID,
    sitePk,
    "visit-scoped",
    2,
    WINDOW.startMs + 2000,
    WINDOW.startMs + 2000,
    2,
  );
  insertEvent.run(
    "event-purchase-b",
    SITE_ID,
    sitePk,
    "visit-other-page",
    1,
    WINDOW.startMs + 86_400_000,
    WINDOW.startMs + 86_400_000,
    1,
  );
  for (const [id, nameId, offset, sequence] of [
    ["event-empty-name", 3, 3000, 3],
    ["event-whitespace-name", 4, 4000, 4],
    ["event-edge-space-name", 5, 5000, 5],
  ] as const)
    insertEvent.run(
      id,
      SITE_ID,
      sitePk,
      "visit-scoped",
      nameId,
      WINDOW.startMs + offset,
      WINDOW.startMs + offset,
      sequence,
    );
  return database;
}

function prepareQuery(
  scope: "session" | "visitor",
  overrides: DetailOverrides = {},
): DetailQuery {
  const filters = parseFilterDsl(
    overrides.filterDsl ?? 'count(page { page.path eq "/scoped" }) eq 1',
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("event-type-detail", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: QueryTime;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave94h_runtime_query_preparation_failed");
  return {
    ...prepared,
    filters: prepared.filters,
    time: prepared.time,
    eventName: overrides.eventName ?? "purchase",
    interval: overrides.interval ?? "day",
    ...(overrides.includeBreakdowns !== undefined
      ? { includeBreakdowns: overrides.includeBreakdowns }
      : {}),
    ...(overrides.includeContext !== undefined
      ? { includeContext: overrides.includeContext }
      : {}),
  } as DetailQuery;
}

async function legacyDetailValue(env: Env, query: DetailQuery) {
  const deferredResult = await d1AdvancedFilterMiddleware(env)(
    "event-type-detail",
    query,
    async (value) => value,
  );
  const deferred =
    deferredEventTypeDetailQualificationFromQuery(deferredResult);
  if (!deferred) throw new Error("wave94h_runtime_deferred_query_missing");
  const filters = await prepareDeferredEventQualificationFallback(deferred);
  return legacyDetailValueWithFilters(env, query, filters);
}

async function legacyDetailValueWithFilters(
  env: Env,
  query: DetailQuery,
  filters: FilterDocument,
) {
  const window = {
    startMs: query.time.range.startMs,
    endExclusiveMs: query.time.range.endExclusiveMs,
    nowMs: query.time.capturedAtMs,
    timeZone: query.time.reportingTimeZone,
  };
  const includeBreakdowns = query.includeBreakdowns !== false;
  const includeContext = query.includeContext !== false;
  const [overview, trend, cards] = await Promise.all([
    queryEventTypeOverviewFromD1(
      env,
      SITE_ID,
      window,
      filters,
      query.eventName,
      { includeBreakdowns },
    ),
    queryEventTypeTrendFromD1(
      env,
      SITE_ID,
      window,
      query.interval,
      filters,
      query.eventName,
    ),
    includeContext
      ? queryEventAnalyticsContextCardsFromD1(
          env,
          SITE_ID,
          window,
          filters,
          100,
          query.eventName,
        )
      : Promise.resolve(null),
  ]);
  return {
    eventName: query.eventName,
    summary: overview.summary,
    trend,
    breakdowns: {
      pages: mapTabs(overview.breakdowns.pages),
      countries: mapTabs(overview.breakdowns.countries),
      devices: mapTabs(overview.breakdowns.devices),
      browsers: mapTabs(overview.breakdowns.browsers),
    },
    cards: cards
      ? mapEventAnalyticsContextCards(cards)
      : emptyEventContextCards(),
  };
}

afterAll(() => {
  for (const database of databases) database.close();
  const evidencePath = process.env.WAVE94H_RUNTIME_EVIDENCE_PATH;
  if (!evidencePath) return;
  const absolutePath = resolve(evidencePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(
    absolutePath,
    JSON.stringify(
      {
        schema: "wave94h-event-type-detail-runtime-v1",
        scenarios: runtimeEvidence,
      },
      null,
      2,
    ),
    "utf8",
  );
});

describe("event-type-detail runtime qualification", () => {
  it.each(["session", "visitor"] as const)(
    "matches the full legacy DTO for %s scope while issuing one fused report query",
    async (scope) => {
      const database = createFixture();
      const trace = newTrace();
      const env = testEnv(database, trace);
      const query = prepareQuery(scope);
      const expected = await legacyDetailValue(env, query);
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;

      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).resolve("event-type-detail");
      if (!provider) throw new Error("wave94h_detail_provider_missing");
      const actual = await provider.execute(query);

      expect(actual.value).toEqual(expected);
      captureRuntimeEvidence({
        scenario: `default-${scope}`,
        trace,
        diagnostics,
        actual: actual.value,
        expected,
      });
      expect(actual.value.summary.events).toBe(scope === "session" ? 2 : 3);
      expect(actual.value.summary.shareOfAllEvents).toBeCloseTo(
        scope === "session" ? 0.4 : 0.5,
      );
      if (scope === "visitor")
        expect(actual.value.cards.page.path.map(({ label }) => label)).toEqual(
          expect.arrayContaining(["/other", "/scoped"]),
        );
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(trace.preparedSql.length).toBeLessThanOrEqual(2);
      expect(trace.preparedSql.length).toBeGreaterThan(0);
    },
  );

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)(
    "matches the complete legacy DTO when breakdowns=%s and context=%s",
    async (includeBreakdowns, includeContext) => {
      const database = createFixture();
      const trace = newTrace();
      const env = testEnv(database, trace);
      const query = prepareQuery("session", {
        includeBreakdowns,
        includeContext,
      });
      const expected = await legacyDetailValue(env, query);
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).resolve("event-type-detail");
      if (!provider) throw new Error("wave94h_detail_provider_missing");

      expect((await provider.execute(query)).value).toEqual(expected);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    },
  );

  it.each(["", "   ", " purchase "] as const)(
    "preserves separate Overview and legacy trend/context event-name semantics for %j",
    async (eventName) => {
      const database = createFixture();
      const trace = newTrace();
      const env = testEnv(database, trace);
      const query = prepareQuery("session", { eventName });
      const expected = await legacyDetailValue(env, query);
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).resolve("event-type-detail");
      if (!provider) throw new Error("wave94h_detail_provider_missing");
      const actual = await provider.execute(query);

      expect(actual.value).toEqual(expected);
      captureRuntimeEvidence({
        scenario: `event-name-${JSON.stringify(eventName)}`,
        trace,
        diagnostics,
        actual: actual.value,
        expected,
      });
      if (eventName === "") {
        expect(diagnostics.advancedCountSqlFallbackReason?.kind).toBe(
          "compile-budget",
        );
        expect(trace.preparedSql.length).toBeGreaterThan(2);
      } else {
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        expect(trace.preparedSql.length).toBeLessThanOrEqual(2);
      }
      if (eventName === "") {
        expect(actual.value.summary.events).toBe(2);
        expect(
          actual.value.trend.data.reduce((sum, point) => sum + point.events, 0),
        ).toBeGreaterThan(actual.value.summary.events);
      }
      if (eventName !== "") expect(actual.value.summary.events).toBe(0);
    },
  );

  it.each(["week", "month"] as const)(
    "matches the legacy calendar trend DTO for %s buckets",
    async (interval) => {
      const database = createFixture();
      const trace = newTrace();
      const env = testEnv(database, trace);
      const query = prepareQuery("session", { interval });
      const expected = await legacyDetailValue(env, query);
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).resolve("event-type-detail");
      if (!provider) throw new Error("wave94h_detail_provider_missing");

      const actual = await provider.execute(query);
      expect(actual.value).toEqual(expected);
      captureRuntimeEvidence({
        scenario: `calendar-${interval}`,
        trace,
        diagnostics,
        actual: actual.value,
        expected,
      });
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    },
  );

  it.each(["session", "visitor"] as const)(
    "uses the complete legacy operation after numeric-domain fallback in %s scope",
    async (scope) => {
      const database = createFixture();
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "visit-scoped");
      const trace = newTrace();
      const env = testEnv(database, trace);
      const query = prepareQuery(scope, {
        filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
      });
      const expected = await legacyDetailValue(env, query);
      trace.preparedSql.length = 0;
      trace.bindings.length = 0;
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env,
        siteId: SITE_ID,
        diagnostics,
      }).resolve("event-type-detail");
      if (!provider) throw new Error("wave94h_detail_provider_missing");

      const actual = await provider.execute(query);
      expect(actual.value).toEqual(expected);
      captureRuntimeEvidence({
        scenario: `numeric-fallback-${scope}`,
        trace,
        diagnostics,
        actual: actual.value,
        expected,
      });
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(trace.preparedSql.length).toBeGreaterThan(2);
    },
  );

  it("propagates pre-aborted requests without running report SQL", async () => {
    const database = createFixture();
    const trace = newTrace();
    const env = testEnv(database, trace);
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE_ID,
      diagnostics,
    }).resolve("event-type-detail");
    if (!provider) throw new Error("wave94h_detail_provider_missing");
    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.execute(prepareQuery("session"), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(trace.preparedSql).toHaveLength(0);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  });

  it("propagates database failures instead of switching report paths", async () => {
    const env = {
      DB: {
        prepare() {
          throw new Error("wave94h_synthetic_database_failure");
        },
      },
      MAIN_SECRET: "wave94h-event-type-detail-runtime-test-secret",
    } as unknown as Env;
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE_ID,
      diagnostics,
    }).resolve("event-type-detail");
    if (!provider) throw new Error("wave94h_detail_provider_missing");

    await expect(provider.execute(prepareQuery("session"))).rejects.toThrow(
      "wave94h_synthetic_database_failure",
    );
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  });

  it("returns empty report groups for a qualified query with no matches", async () => {
    const database = createFixture();
    const trace = newTrace();
    const env = testEnv(database, trace);
    const query = prepareQuery("session", {
      filterDsl: 'count(page { page.path eq "/missing" }) eq 1',
    });
    const expected = await legacyDetailValue(env, query);
    trace.preparedSql.length = 0;
    trace.bindings.length = 0;
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE_ID,
      diagnostics,
    }).resolve("event-type-detail");
    if (!provider) throw new Error("wave94h_detail_provider_missing");

    const actual = await provider.execute(query);
    expect(actual.value).toEqual(expected);
    expect(actual.value.summary.events).toBe(0);
    expect(actual.value.trend.data.every(({ events }) => events === 0)).toBe(
      true,
    );
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  });

  it("keeps the ordinary non-advanced filter path on its existing reports", async () => {
    const database = createFixture();
    const trace = newTrace();
    const env = testEnv(database, trace);
    const query = prepareQuery("session", {
      filterDsl: 'page.path eq "/scoped"',
    });
    const forwarded = await d1AdvancedFilterMiddleware(env)(
      "event-type-detail",
      query,
      async (value) => value,
    );
    expect(
      deferredEventTypeDetailQualificationFromQuery(forwarded),
    ).toBeUndefined();
    const forwardedFilters = (forwarded as DetailQuery).filters;
    const expected = await legacyDetailValueWithFilters(
      env,
      query,
      forwardedFilters,
    );
    trace.preparedSql.length = 0;
    trace.bindings.length = 0;
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SITE_ID,
      diagnostics,
    }).resolve("event-type-detail");
    if (!provider) throw new Error("wave94h_detail_provider_missing");

    expect((await provider.execute(query)).value).toEqual(expected);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(trace.preparedSql.length).toBeGreaterThan(2);
  });

  it("rejects an over-cap public event name before invoking the provider", async () => {
    const execute = vi.fn();
    const executor = { execute } as unknown as AnalyticsQueryExecutor;
    const principal: ApiKeyPrincipal = {
      keyId: "wave94h-key",
      teamId: "wave94h-team",
      prefix: "wave94h",
      status: "active",
      scopes: ["analytics:read"],
      siteIds: [SITE_ID],
    };
    const response = await handlePlannedSiteEventTypeDetail(
      new Request(
        `https://app.test/api/v1/sites/${SITE_ID}/analytics/events/types/detail`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            timeRange: {
              kind: "absolute",
              from: "2026-01-01T08:00:00.000Z",
              to: "2026-01-04T08:00:00.000Z",
            },
            eventName: "x".repeat(121),
            interval: "day",
          }),
        },
      ),
      principal,
      SITE_ID,
      executor,
      { capturedAtMs: WINDOW.nowMs },
    );

    expect(response.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps the 20001-activity session cap ahead of numeric fallback and report rows", async () => {
    const database = createFixture();
    const sitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE_ID) as { readonly site_pk: number }
      ).site_pk,
    );
    database
      .prepare("DELETE FROM custom_events WHERE site_id = ?")
      .run(SITE_ID);
    database.prepare("DELETE FROM visits WHERE site_id = ?").run(SITE_ID);
    database
      .prepare(
        `WITH RECURSIVE generated(n) AS (
           SELECT 1
           UNION ALL SELECT n + 1 FROM generated WHERE n < 20001
         )
         INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         )
         SELECT 'wave94h-cap-activity-' || n, ?, ?,
           'wave94h-cap-visitor', 'wave94h-cap-session', 'closed',
           ?, ?, '/cap-page', 'detail.test', 1
         FROM generated`,
      )
      .run(SITE_ID, sitePk, WINDOW.startMs + 500, WINDOW.startMs + 500);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave94h-cap-activity-1");
    const fixtureActivityCount = Number(
      (
        database
          .prepare("SELECT COUNT(*) AS count FROM visits WHERE site_id = ?")
          .get(SITE_ID) as { readonly count: number }
      ).count,
    );
    expect(fixtureActivityCount).toBe(20_001);

    const query = prepareQuery("session", {
      filterDsl: "count(page { page.durationMs gt 5 }) eq 1",
    });
    const trace = newTrace();
    const env = testEnv(database, trace);
    const diagnostics = createD1ReadDiagnostics();
    const registry = createD1SiteProviderRegistry({
      env,
      siteId: SITE_ID,
      diagnostics,
    });
    let compilation:
      ReturnType<typeof compileEventTypeDetailQualificationProgram> | undefined;
    registry.useMiddleware(async (_operation, input, next) => {
      const deferred = deferredEventTypeDetailQualificationFromQuery(input);
      if (deferred) {
        const preparedRequest = deferred.eventTypeDetailRequest;
        if (!preparedRequest)
          throw new Error("wave94h_cap_deferred_request_missing");
        compilation = compileEventTypeDetailQualificationProgram({
          deferred,
          query: {
            ...preparedRequest,
            contextLimit: 100,
            selectedKeys: EVENT_CONTEXT_CARD_KEYS,
          },
        });
      }
      return next(input);
    });
    const provider = registry.resolve("event-type-detail");
    if (!provider) throw new Error("wave94h_detail_provider_missing");
    let failure: unknown;
    try {
      await provider.execute(query);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(compilation?.kind).toBe("compiled");
    if (!compilation || compilation.kind !== "compiled")
      throw new Error("wave94h_cap_program_not_compiled");
    const compiled = compilation;

    const rawRows = database
      .prepare(compiled.evidence.sql)
      .all(...(compiled.evidence.bindings as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    const controlRows = rawRows.filter((row) => row.rowKind === "control");
    const reportRows = rawRows.filter((row) => row.rowKind === "report");
    expect(controlRows).toHaveLength(1);
    const control = controlRows[0]!;
    expect(control.entityKind).toBe("session");
    expect(Number(control.rawCount)).toBe(20_001);
    expect(Number(control.invalidContextPageDurationMsCount)).toBeGreaterThan(
      0,
    );
    expect(reportRows).toHaveLength(0);
    expect(
      reportRows.filter(
        (row) => row.outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
      ),
    ).toHaveLength(0);

    expect(trace.preparedSql).toHaveLength(2);
    expect(trace.preparedSql[1]).toBe(compiled.evidence.sql);
    expect(
      trace.preparedSql.filter((sql) => sql === compiled.evidence.sql),
    ).toHaveLength(1);
    runtimeEvidence.push({
      scenario: "activity-cap-priority-session",
      kind: "cap-error",
      fixtureActivityCount,
      failure: {
        domainError: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      },
      fallbackReason: diagnostics.advancedCountSqlFallbackReason ?? null,
      compilation: {
        kind: compiled.kind,
        sqlBytes: compiled.evidence.sqlBytes,
        bindingCount: compiled.evidence.bindingCount,
        sqlSha256: createHash("sha256")
          .update(compiled.evidence.sql, "utf8")
          .digest("hex"),
      },
      rawOutput: {
        rowCount: rawRows.length,
        controlRowCount: controlRows.length,
        reportRowCount: reportRows.length,
        zeroGlobalSummaryRows: reportRows.filter(
          (row) => row.outputId === EVENT_TYPE_OVERVIEW_OUTPUTS.summary,
        ).length,
        control: {
          rowKind: control.rowKind,
          outputId: control.outputId,
          entityKind: control.entityKind,
          rawCount: Number(control.rawCount),
          invalidContextPageDurationMsCount: Number(
            control.invalidContextPageDurationMsCount,
          ),
        },
      },
      callSequence: trace.preparedSql.map((sql, index) => ({
        index,
        role: sql === compiled.evidence.sql ? "fused-detail" : "site-coverage",
        sqlBytes: new TextEncoder().encode(sql).byteLength,
        sqlSha256: createHash("sha256").update(sql, "utf8").digest("hex"),
        bindingCount: trace.bindings[index]?.length ?? null,
      })),
    });
  }, 45_000);
});
