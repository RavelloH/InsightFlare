import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type {
  CanonicalQuery,
  FilterDocument,
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  CLIENT_DIMENSIONS,
  TECHNOLOGY_SHARE_TREND_OUTPUTS,
  technologyShareTrendQualificationConfiguration,
  UTM_DIMENSIONS,
} from "@/lib/edge/analytics/engine/technology-share-trend-report-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredShareTrendQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type {
  ClientDimensionKey,
  Interval,
  QueryWindow,
  UtmDimensionKey,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  queryReferrerAndChannelTrendFromD1,
  queryShareTrendFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend";
import {
  compileShareTrendQualificationProgram,
  executeShareTrendQualificationProgram,
} from "@/lib/edge/analytics/providers/d1/internal/technology/share-trend-qualification-program";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE = "wave96g-share-trend";
const BASE = Date.UTC(2026, 1, 1);
const HOUR = 60 * 60 * 1000;
const TIME = createQueryTime(BASE, BASE + 3 * HOUR, "UTC", BASE + 3 * HOUR);
const WINDOW: QueryWindow = {
  startMs: BASE,
  endExclusiveMs: BASE + 3 * HOUR,
  nowMs: BASE + 3 * HOUR,
  timeZone: "UTC",
};
const FILTER_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1';
const NO_MATCH_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "missing" }) eq 1';
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();

function writeEvidence(filename: string, contents: string): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(join(EVIDENCE_DIRECTORY, filename), contents, "utf8");
}

type Scope = "session" | "visitor" | "event";
type Variant =
  | "browser"
  | "browser-engine"
  | "client"
  | "utm"
  | "referrer"
  | "referrer-channel"
  | undefined;
type ShareQuery = CanonicalQuery<"share-trend">;

interface SeedVisit {
  readonly id: string;
  readonly visitor: string;
  readonly session: string;
  readonly startedAt: number;
  readonly pathname: string;
  readonly browser: string;
  readonly browserVersion: string;
  readonly language: string;
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly referrerHost: string;
  readonly utmSource: string;
  readonly utmMedium: string;
}

interface Scenario {
  readonly name: string;
  readonly variant: Variant;
  readonly dimension?: ClientDimensionKey | UtmDimensionKey;
}

let database: DatabaseSync;
let sitePk: number;

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function sqliteEnv(db: DatabaseSync, queryTrace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(db, queryTrace) } as unknown as Env;
}

function sqliteEnvWithResultTransform(
  db: DatabaseSync,
  queryTrace: SqliteD1Trace,
  transform: (
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[],
): Env {
  const baseDatabase = createSqliteD1Database(db, queryTrace);
  return {
    DB: {
      prepare(sql: string) {
        const statement = baseDatabase.prepare(sql);
        return {
          bind(...values: Parameters<typeof statement.bind>) {
            const bound = statement.bind(...values);
            return {
              async all<Row extends object>() {
                const result = await bound.all<Row>();
                return {
                  ...result,
                  results: transform(
                    result.results as unknown as readonly Record<
                      string,
                      unknown
                    >[],
                  ) as unknown as Row[],
                };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
}

function seedVisit(input: SeedVisit): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, browser,
        browser_version, language, screen_width, screen_height,
        referrer_host, utm_source, utm_medium
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'share-trend.test', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      SITE,
      sitePk,
      input.visitor,
      input.session,
      input.startedAt,
      input.startedAt,
      input.pathname,
      input.browser,
      input.browserVersion,
      input.language,
      input.screenWidth,
      input.screenHeight,
      input.referrerHost,
      input.utmSource,
      input.utmMedium,
    );
}

function seedQualifierEvent(visitId: string, suffix: string): void {
  const occurredAt = BASE + 15;
  database
    .prepare(
      `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, 'qualifier', ?, ?)`,
    )
    .run(SITE, occurredAt, sitePk);
  const eventName = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(sitePk, "qualifier") as { readonly id: number };
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run(
      `qualifier-${suffix}`,
      SITE,
      sitePk,
      visitId,
      eventName.id,
      occurredAt,
      occurredAt,
    );
}

function seedNamedEvent(visitId: string, name: string): void {
  const visit = database
    .prepare("SELECT started_at FROM visits WHERE visit_id = ?")
    .get(visitId) as { readonly started_at: number };
  const occurredAt = visit.started_at;
  database
    .prepare(
      `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, ?, ?)`,
    )
    .run(SITE, name, occurredAt, sitePk);
  const eventName = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(sitePk, name) as { readonly id: number };
  database
    .prepare(
      `INSERT OR REPLACE INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run(
      `${name}-${visitId}`,
      SITE,
      sitePk,
      visitId,
      eventName.id,
      occurredAt,
      occurredAt,
    );
}

function deleteNamedEvent(visitId: string, name: string): void {
  database
    .prepare(
      `DELETE FROM custom_events
       WHERE visit_id = ? AND event_name_id = (
         SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?
       )`,
    )
    .run(visitId, sitePk, name);
}

function seedFixture(): void {
  database = createMigratedDatabase();
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(SITE) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave96g-team', 'Share trend qualification', 'share-trend.test', 0)`,
    )
    .run(SITE);

  const visits: readonly SeedVisit[] = [
    {
      id: "alpha-previous",
      visitor: "alpha",
      session: "alpha-old",
      startedAt: BASE + 10 * 60_000,
      pathname: "/qualified",
      browser: "Chrome",
      browserVersion: "123.1",
      language: "en-US",
      screenWidth: 1920,
      screenHeight: 1080,
      referrerHost: "news.example",
      utmSource: "news",
      utmMedium: "email",
    },
    {
      id: "alpha-mid",
      visitor: "alpha",
      session: "alpha-new",
      startedAt: BASE + 65 * 60_000,
      pathname: "/qualified",
      browser: "Firefox",
      browserVersion: "121.0",
      language: "fr-FR",
      screenWidth: 1280,
      screenHeight: 720,
      referrerHost: "docs.example",
      utmSource: "docs",
      utmMedium: "referral",
    },
    {
      id: "alpha-tie-a",
      visitor: "alpha",
      session: "alpha-new",
      startedAt: BASE + 125 * 60_000,
      pathname: "/qualified",
      browser: "Edge",
      browserVersion: "125.4",
      language: "ja-JP",
      screenWidth: 800,
      screenHeight: 600,
      referrerHost: "search.example",
      utmSource: "search",
      utmMedium: "organic",
    },
    {
      id: "alpha-tie-z",
      visitor: "alpha",
      session: "alpha-new",
      startedAt: BASE + 125 * 60_000,
      pathname: "/qualified",
      browser: "Safari",
      browserVersion: "17.2",
      language: "zh-CN",
      screenWidth: 640,
      screenHeight: 480,
      referrerHost: "mail.example",
      utmSource: "mail",
      utmMedium: "email",
    },
    {
      id: "beta-visit",
      visitor: "beta",
      session: "beta-session",
      startedAt: BASE + 70 * 60_000,
      pathname: "/qualified",
      browser: "Chrome",
      browserVersion: "124.0",
      language: "en-GB",
      screenWidth: 1366,
      screenHeight: 768,
      referrerHost: "search.example",
      utmSource: "search",
      utmMedium: "organic",
    },
    {
      id: "gamma-token",
      visitor: "gamma",
      session: "gamma-session",
      startedAt: BASE + 20 * 60_000,
      pathname: "/qualified",
      browser: "__share_trend_other__",
      browserVersion: "1.0",
      language: "",
      screenWidth: 0,
      screenHeight: 0,
      referrerHost: "",
      utmSource: "",
      utmMedium: "",
    },
    {
      id: "delta-key-collision-a",
      visitor: "delta-a",
      session: "delta-a-session",
      startedAt: BASE + 25 * 60_000,
      pathname: "/qualified",
      browser: "Chrome",
      browserVersion: "120.0",
      language: "de-DE",
      screenWidth: 1440,
      screenHeight: 900,
      referrerHost: "alpha.example",
      utmSource: "alpha",
      utmMedium: "referral",
    },
    {
      id: "epsilon-key-collision-b",
      visitor: "delta-b",
      session: "delta-b-session",
      startedAt: BASE + 26 * 60_000,
      pathname: "/qualified",
      browser: "chrome",
      browserVersion: "121.0",
      language: "de-AT",
      screenWidth: 1440,
      screenHeight: 900,
      referrerHost: "beta.example",
      utmSource: "beta",
      utmMedium: "referral",
    },
    {
      id: "ordering-zulu-one",
      visitor: "zulu-visitor-one",
      session: "zulu-session-one",
      startedAt: BASE + 5 * 60_000,
      pathname: "/qualified",
      browser: "Zulu",
      browserVersion: "1.0",
      language: "en",
      screenWidth: 1024,
      screenHeight: 768,
      referrerHost: "zulu.example",
      utmSource: "zulu",
      utmMedium: "referral",
    },
    {
      id: "ordering-zulu-two",
      visitor: "zulu-visitor-two",
      session: "zulu-session-two",
      startedAt: BASE + 70 * 60_000,
      pathname: "/qualified",
      browser: "Zulu",
      browserVersion: "1.0",
      language: "en",
      screenWidth: 1024,
      screenHeight: 768,
      referrerHost: "zulu.example",
      utmSource: "zulu",
      utmMedium: "referral",
    },
    {
      id: "ordering-zulu-three",
      visitor: "zulu-visitor-three",
      session: "zulu-session-three",
      startedAt: BASE + 130 * 60_000,
      pathname: "/qualified",
      browser: "Zulu",
      browserVersion: "1.0",
      language: "en",
      screenWidth: 1024,
      screenHeight: 768,
      referrerHost: "zulu.example",
      utmSource: "zulu",
      utmMedium: "referral",
    },
    {
      id: "ordering-aardvark",
      visitor: "aardvark-visitor",
      session: "aardvark-session",
      startedAt: BASE + 35 * 60_000,
      pathname: "/qualified",
      browser: "Aardvark",
      browserVersion: "1.0",
      language: "en",
      screenWidth: 1024,
      screenHeight: 768,
      referrerHost: "aardvark.example",
      utmSource: "aardvark",
      utmMedium: "referral",
    },
    {
      id: "ordering-bee",
      visitor: "bee-visitor",
      session: "bee-session",
      startedAt: BASE + 45 * 60_000,
      pathname: "/qualified",
      browser: "Bee",
      browserVersion: "1.0",
      language: "en",
      screenWidth: 1024,
      screenHeight: 768,
      referrerHost: "bee.example",
      utmSource: "bee",
      utmMedium: "referral",
    },
    {
      id: "empty-visitor",
      visitor: "",
      session: "empty-session",
      startedAt: BASE + 30 * 60_000,
      pathname: "/qualified",
      browser: "Empty visitor",
      browserVersion: "1.0",
      language: "en",
      screenWidth: 1024,
      screenHeight: 768,
      referrerHost: "empty.example",
      utmSource: "empty",
      utmMedium: "referral",
    },
    {
      id: "excluded-visit",
      visitor: "excluded",
      session: "excluded-session",
      startedAt: BASE + 40 * 60_000,
      pathname: "/excluded",
      browser: "Excluded",
      browserVersion: "1.0",
      language: "en",
      screenWidth: 1024,
      screenHeight: 768,
      referrerHost: "excluded.example",
      utmSource: "excluded",
      utmMedium: "referral",
    },
  ];
  for (const visit of visits) seedVisit(visit);
  for (const visitId of [
    "alpha-tie-z",
    "beta-visit",
    "gamma-token",
    "delta-key-collision-a",
    "epsilon-key-collision-b",
    "ordering-zulu-one",
    "ordering-zulu-two",
    "ordering-zulu-three",
    "ordering-aardvark",
    "ordering-bee",
    "empty-visitor",
    "excluded-visit",
  ])
    seedQualifierEvent(visitId, visitId);
}

function queryFor(
  scope: Scope,
  scenario: Scenario,
  limit = 5,
  filterDsl = FILTER_DSL,
): ShareQuery {
  const filters = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("share-trend", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time: TIME,
    interval: "hour",
    ...(scenario.variant !== undefined ? { variant: scenario.variant } : {}),
    ...(scenario.dimension !== undefined
      ? { dimension: scenario.dimension }
      : {}),
    limit,
  } as unknown as ShareQuery;
}

function queryWindow(time: QueryTime): QueryWindow {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

async function compileCandidate(query: ShareQuery) {
  const queryTrace = trace();
  const diagnostics = createD1ReadDiagnostics();
  const env = sqliteEnv(database, queryTrace);
  const forwarded = await d1AdvancedFilterMiddleware(env, diagnostics, SITE)(
    "share-trend",
    query,
    async (next) => next,
  );
  const deferred = deferredShareTrendQualificationFromQuery(forwarded);
  if (!deferred) return { kind: "legacy" as const, queryTrace };
  const compiled = compileShareTrendQualificationProgram({
    deferred,
    query: forwarded,
    configuration: deferred.configuration,
  });
  return { ...compiled, deferred, queryTrace };
}

async function oldTechnologyReader(
  query: ShareQuery,
  traceForOracle: SqliteD1Trace,
): Promise<unknown> {
  const diagnostics = createD1ReadDiagnostics();
  const env = sqliteEnv(database, traceForOracle);
  const forwarded = await d1AdvancedFilterMiddleware(env, diagnostics, SITE)(
    "performance",
    query,
    async (next) => next,
  );
  expect(deferredShareTrendQualificationFromQuery(forwarded)).toBeUndefined();
  const oldFilters = (forwarded as QueryInput & { filters?: FilterDocument })
    .filters;
  if (!oldFilters) throw new Error("share_trend_oracle_filters_missing");
  const metadata = (
    await import("@/lib/edge/analytics/contract")
  ).scopedFilterMetadata(oldFilters);
  expect(metadata?.plan.advancedMatches).toBeDefined();
  const time = query.time;
  const window = queryWindow(time);
  const interval: Interval = query.interval;
  const limit = query.limit ?? 5;
  if (query.variant === "referrer-channel")
    return queryReferrerAndChannelTrendFromD1(
      env,
      SITE,
      window,
      interval,
      oldFilters,
      limit,
    );
  if (query.variant === "browser")
    return queryShareTrendFromD1(
      env,
      SITE,
      window,
      interval,
      oldFilters,
      limit,
      "browser",
    );
  if (query.variant === "browser-engine")
    return queryShareTrendFromD1(
      env,
      SITE,
      window,
      interval,
      oldFilters,
      limit,
      "browserEngine",
    );
  if (query.variant === "client") {
    const dimension = CLIENT_DIMENSIONS[query.dimension];
    return queryShareTrendFromD1(
      env,
      SITE,
      window,
      interval,
      oldFilters,
      limit,
      dimension,
    );
  }
  if (query.variant === "utm") {
    const dimension = UTM_DIMENSIONS[query.dimension];
    return queryShareTrendFromD1(
      env,
      SITE,
      window,
      interval,
      oldFilters,
      limit,
      dimension,
    );
  }
  return queryShareTrendFromD1(
    env,
    SITE,
    window,
    interval,
    oldFilters,
    limit,
    "referrerDomain",
  );
}

async function productionTechnologyProvider(
  query: ShareQuery,
  queryTrace: SqliteD1Trace,
  diagnostics = createD1ReadDiagnostics(),
  env = sqliteEnv(database, queryTrace),
): Promise<{ readonly value: unknown }> {
  const registry = createD1SiteProviderRegistry({
    env,
    siteId: SITE,
    diagnostics,
  });
  const provider = registry.resolve("share-trend");
  if (!provider) throw new Error("share_trend_provider_missing");
  return provider.execute(query);
}

function configurationFromQuery(query: ShareQuery) {
  const configuration = technologyShareTrendQualificationConfiguration({
    variant: query.variant,
    dimension: "dimension" in query ? query.dimension : undefined,
    interval: query.interval,
    limit: query.limit,
  });
  if (!configuration) throw new Error("share_trend_test_configuration_invalid");
  return configuration;
}

function summarizeCompileResult(
  query: ShareQuery,
  result: Awaited<ReturnType<typeof compileCandidate>>,
) {
  if (result.kind === "compiled")
    return {
      kind: result.kind,
      configuration: configurationFromQuery(query),
      statementTag: result.evidence.statementTag,
      sql: result.evidence.sql,
      sqlBytes: result.evidence.sqlBytes,
      bindings: result.evidence.bindings,
      bindingCount: result.evidence.bindingCount,
      groupWidth: result.evidence.groupWidth,
      sharedRelationCount: result.evidence.sharedRelationCount,
      rootKind: result.evidence.rootKind,
      physicalPlanShape: result.evidence.physicalPlanShape ?? null,
      reportSourceRelations: result.evidence.reportSourceRelations,
      controlOutputId: result.evidence.controlOutputId,
      controlFields: result.evidence.controlFields,
      outputDescriptors: result.evidence.outputDescriptors,
      ordering: result.evidence.ordering,
    };
  if (result.kind === "unavailable")
    return {
      kind: result.kind,
      configuration: configurationFromQuery(query),
      fallbackReason: result.fallbackReason,
      admissionEvidence: result.admissionEvidence ?? null,
    };
  return { kind: result.kind, configuration: configurationFromQuery(query) };
}

beforeAll(() => seedFixture());

afterAll(() => database.close());

describe("share-trend qualified provider regression", () => {
  it("97DQ: qualifies mixed OR Share Trend filters against the legacy reader", async () => {
    seedNamedEvent("excluded-visit", "whole-filter-owner");
    const filterDsl =
      'page.path neq "/excluded" or count(event { event.name eq "whole-filter-owner" }) eq 1';
    const query = queryFor(
      "session",
      { name: "mixed-or", variant: "browser" },
      5,
      filterDsl,
    );
    try {
      const candidate = await compileCandidate(query);
      expect(candidate.kind).toBe("compiled");
      if (candidate.kind !== "compiled") return;
      expect(candidate.deferred.qualification.technologyFilterMode).toBe(
        "allow-whole-filter",
      );
      expect(
        candidate.deferred.qualification.metadata.plan.advancedMatches,
      ).toBeUndefined();
      expect(candidate.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
      expect(candidate.evidence.bindingCount).toBeLessThanOrEqual(100);
      expect(candidate.evidence.reportSourceRelations).toHaveLength(1);

      const actualTrace = trace();
      const diagnostics = createD1ReadDiagnostics();
      const actual = await productionTechnologyProvider(
        query,
        actualTrace,
        diagnostics,
      );
      const oracleTrace = trace();
      const oracle = await oldTechnologyReader(query, oracleTrace);
      const andOracle = await oldTechnologyReader(
        queryFor("session", { name: "and-baseline", variant: "browser" }),
        trace(),
      );
      expect(actual.value).toEqual(oracle);
      expect(actual.value).not.toEqual(andOracle);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(actualTrace.preparedSql).toHaveLength(2);
      expect(actualTrace.preparedSql).toContain(candidate.evidence.sql);
      writeEvidence(
        "97dq-share-trend-mixed-or.json",
        JSON.stringify(
          {
            operation: "share-trend",
            variant: "browser",
            scope: "session",
            filterDsl,
            mode: candidate.deferred.qualification.technologyFilterMode,
            countScope: candidate.deferred.qualification.metadata.plan.scope,
            advancedMatches:
              candidate.deferred.qualification.metadata.plan.advancedMatches ??
              null,
            siteMetadataCount:
              candidate.deferred.qualification.metadata.siteIds.length,
            compilation: {
              statementTag: candidate.evidence.statementTag,
              sql: candidate.evidence.sql,
              sqlUtf8Bytes: new TextEncoder().encode(candidate.evidence.sql)
                .byteLength,
              bindings: candidate.evidence.bindings,
              bindingCount: candidate.evidence.bindingCount,
              groupWidth: candidate.evidence.groupWidth,
              sharedRelationCount: candidate.evidence.sharedRelationCount,
              reportSourceRelations: candidate.evidence.reportSourceRelations,
              controlOutputId: candidate.evidence.controlOutputId,
              controlFields: candidate.evidence.controlFields,
              outputDescriptors: candidate.evidence.outputDescriptors,
              ordering: candidate.evidence.ordering,
            },
            runtime: {
              preparedSql: actualTrace.preparedSql,
              bindings: actualTrace.bindings,
              statementCount: actualTrace.preparedSql.length,
              actual: actual.value,
              legacyPreparedSql: oracleTrace.preparedSql,
              legacyBindings: oracleTrace.bindings,
              legacy: oracle,
              differsFromAnd: true,
              fallbackReason: diagnostics.advancedCountSqlFallbackReason,
            },
          },
          null,
          2,
        ),
      );
    } finally {
      deleteNamedEvent("excluded-visit", "whole-filter-owner");
    }
  });

  it("97DQ: preserves split-only qualification for the existing AND Share Trend", async () => {
    const query = queryFor("session", {
      name: "and-default",
      variant: "browser",
    });
    const candidate = await compileCandidate(query);
    expect(candidate.kind).toBe("compiled");
    if (candidate.kind !== "compiled") return;
    expect(
      candidate.deferred.qualification.technologyFilterMode,
    ).toBeUndefined();
    const actualTrace = trace();
    const actual = await productionTechnologyProvider(query, actualTrace);
    const oracle = await oldTechnologyReader(query, trace());
    expect(actual.value).toEqual(oracle);
  });

  it("keeps the production DTO equal to the independent legacy reader and records admission", async () => {
    const scenarios: readonly Scenario[] = [
      { name: "browser", variant: "browser" },
      { name: "browser-engine", variant: "browser-engine" },
      { name: "client-language", variant: "client", dimension: "language" },
      { name: "utm-source", variant: "utm", dimension: "source" },
      { name: "default-referrer", variant: undefined },
      { name: "referrer-channel", variant: "referrer-channel" },
    ];
    const compileEvidence: Record<string, unknown>[] = [];
    const runtimeEvidence: Record<string, unknown>[] = [];
    const budgets = new Map<string, string>();
    try {
      for (const scope of ["session", "visitor", "event"] as const) {
        for (const scenario of scenarios) {
          const query = queryFor(scope, scenario);
          const candidate = await compileCandidate(query);
          expect(candidate.kind, `${scope}:${scenario.name}:route`).not.toBe(
            "legacy",
          );
          if (
            scenario.name === "browser-engine" ||
            scenario.name === "referrer-channel"
          ) {
            expect(
              candidate.kind,
              `${scope}:${scenario.name}:materialized budget route`,
            ).toBe("compiled");
            if (candidate.kind === "compiled")
              expect(candidate.evidence.sqlBytes).toBeLessThan(100_000);
          }
          compileEvidence.push({
            scope,
            scenario: scenario.name,
            ...summarizeCompileResult(query, candidate),
          });
          budgets.set(`${scope}:${scenario.name}`, candidate.kind);

          const actualTrace = trace();
          const actualDiagnostics = createD1ReadDiagnostics();
          const actual = await productionTechnologyProvider(
            query,
            actualTrace,
            actualDiagnostics,
          );
          if (candidate.kind === "unavailable")
            expect(
              actualDiagnostics.advancedCountSqlFallbackReason,
              `${scope}:${scenario.name}:fallback guard`,
            ).toEqual(candidate.fallbackReason);
          else
            expect(
              actualDiagnostics.advancedCountSqlFallbackReason,
              `${scope}:${scenario.name}:unexpected fallback`,
            ).toBeUndefined();
          const oracleTrace = trace();
          const oracle = await oldTechnologyReader(query, oracleTrace);
          expect(actual.value, `${scope}:${scenario.name}`).toEqual(oracle);
          runtimeEvidence.push({
            scope,
            scenario: scenario.name,
            actualValue: actual.value,
            legacyValue: oracle,
            actualSql: actualTrace.preparedSql,
            actualBindings: actualTrace.bindings,
            oracleSql: oracleTrace.preparedSql,
            oracleBindings: oracleTrace.bindings,
            fallbackReason:
              actualDiagnostics.advancedCountSqlFallbackReason ?? null,
          });
        }
      }

      for (const scope of ["session", "visitor"] as const) {
        expect(budgets.get(`${scope}:browser`), `${scope}:browser`).toBe(
          "compiled",
        );
        expect(
          budgets.get(`${scope}:client-language`),
          `${scope}:client-language`,
        ).toBe("compiled");
        expect(budgets.get(`${scope}:utm-source`), `${scope}:utm-source`).toBe(
          "compiled",
        );
        expect(
          budgets.get(`${scope}:default-referrer`),
          `${scope}:default-referrer`,
        ).toBe("compiled");
      }

      for (const dimension of Object.keys(
        CLIENT_DIMENSIONS,
      ) as ClientDimensionKey[])
        expect(
          technologyShareTrendQualificationConfiguration({
            variant: "client",
            dimension,
            interval: "hour",
            limit: 5,
          }),
          `client:${dimension}`,
        ).toMatchObject({
          kind: "single",
          dimension: CLIENT_DIMENSIONS[dimension],
        });
      for (const dimension of Object.keys(UTM_DIMENSIONS) as UtmDimensionKey[])
        expect(
          technologyShareTrendQualificationConfiguration({
            variant: "utm",
            dimension,
            interval: "hour",
            limit: 5,
          }),
          `utm:${dimension}`,
        ).toMatchObject({
          kind: "single",
          dimension: UTM_DIMENSIONS[dimension],
        });
      expect(
        technologyShareTrendQualificationConfiguration({
          variant: "client",
          dimension: "unknown",
          interval: "hour",
          limit: 5,
        }),
      ).toBeUndefined();
      expect(Object.keys(CLIENT_DIMENSIONS)).toHaveLength(6);
      expect(Object.keys(UTM_DIMENSIONS)).toHaveLength(5);

      for (const scope of ["session", "visitor"] as const) {
        for (const dimension of Object.keys(
          CLIENT_DIMENSIONS,
        ) as ClientDimensionKey[]) {
          if (dimension === "language") continue;
          const scenario: Scenario = {
            name: `client-${dimension}`,
            variant: "client",
            dimension,
          };
          const query = queryFor(scope, scenario);
          const candidate = await compileCandidate(query);
          expect(candidate.kind, `${scope}:${scenario.name}:route`).not.toBe(
            "legacy",
          );
          if (
            scenario.name === "browser-engine" ||
            scenario.name === "referrer-channel"
          ) {
            expect(
              candidate.kind,
              `${scope}:${scenario.name}:materialized budget route`,
            ).toBe("compiled");
            if (candidate.kind === "compiled")
              expect(candidate.evidence.sqlBytes).toBeLessThan(100_000);
          }
          compileEvidence.push({
            scope,
            scenario: scenario.name,
            ...summarizeCompileResult(query, candidate),
          });
          budgets.set(`${scope}:${scenario.name}`, candidate.kind);

          if (dimension === "screenSize") {
            const actualTrace = trace();
            const actualDiagnostics = createD1ReadDiagnostics();
            const actual = await productionTechnologyProvider(
              query,
              actualTrace,
              actualDiagnostics,
            );
            if (candidate.kind === "unavailable")
              expect(actualDiagnostics.advancedCountSqlFallbackReason).toEqual(
                candidate.fallbackReason,
              );
            else
              expect(
                actualDiagnostics.advancedCountSqlFallbackReason,
              ).toBeUndefined();
            const oracleTrace = trace();
            const oracle = await oldTechnologyReader(query, oracleTrace);
            expect(actual.value, `${scope}:${scenario.name}`).toEqual(oracle);
            runtimeEvidence.push({
              scope,
              scenario: scenario.name,
              actualValue: actual.value,
              legacyValue: oracle,
              actualSql: actualTrace.preparedSql,
              actualBindings: actualTrace.bindings,
              oracleSql: oracleTrace.preparedSql,
              oracleBindings: oracleTrace.bindings,
              fallbackReason:
                actualDiagnostics.advancedCountSqlFallbackReason ?? null,
            });
          }
        }
        for (const dimension of Object.keys(
          UTM_DIMENSIONS,
        ) as UtmDimensionKey[]) {
          if (dimension === "source") continue;
          const scenario: Scenario = {
            name: `utm-${dimension}`,
            variant: "utm",
            dimension,
          };
          const query = queryFor(scope, scenario);
          const candidate = await compileCandidate(query);
          expect(candidate.kind, `${scope}:${scenario.name}:route`).not.toBe(
            "legacy",
          );
          if (
            scenario.name === "browser-engine" ||
            scenario.name === "referrer-channel"
          ) {
            expect(
              candidate.kind,
              `${scope}:${scenario.name}:materialized budget route`,
            ).toBe("compiled");
            if (candidate.kind === "compiled")
              expect(candidate.evidence.sqlBytes).toBeLessThan(100_000);
          }
          compileEvidence.push({
            scope,
            scenario: scenario.name,
            ...summarizeCompileResult(query, candidate),
          });
          budgets.set(`${scope}:${scenario.name}`, candidate.kind);
        }
      }

      for (const scope of ["session", "visitor"] as const) {
        for (const limit of [0, 1, 12, 99]) {
          const query = queryFor(
            scope,
            { name: `browser-limit-${limit}`, variant: "browser" },
            limit,
          );
          const actualTrace = trace();
          const actual = await productionTechnologyProvider(query, actualTrace);
          const oracle = await oldTechnologyReader(query, trace());
          expect(actual.value, `${scope}:limit=${limit}`).toEqual(oracle);
          const expectedLimit = Math.min(Math.max(1, limit), 12);
          expect(
            configurationFromQuery(query),
            `${scope}:normalized-limit=${limit}`,
          ).toMatchObject({ limit: expectedLimit });
        }
        const emptyQuery = queryFor(
          scope,
          { name: "empty-membership", variant: "browser" },
          1,
          NO_MATCH_DSL,
        );
        const emptyActualTrace = trace();
        const emptyActualDiagnostics = createD1ReadDiagnostics();
        const emptyActual = await productionTechnologyProvider(
          emptyQuery,
          emptyActualTrace,
          emptyActualDiagnostics,
        );
        const emptyOracle = await oldTechnologyReader(emptyQuery, trace());
        expect(emptyActual.value, `${scope}:empty-membership`).toEqual(
          emptyOracle,
        );
        expect(emptyActual.value).toEqual({ series: [], data: [] });
        expect(emptyActualTrace.preparedSql).toHaveLength(2);
        expect(emptyActualTrace.preparedSql.at(-1)).toContain('AS "rowKind"');
        expect(
          emptyActualDiagnostics.advancedCountSqlFallbackReason,
        ).toBeUndefined();
      }

      for (const scope of ["session", "visitor"] as const) {
        const query = queryFor(scope, {
          name: "referrer-channel-budget",
          variant: "referrer-channel",
        });
        const budget = await compileCandidate(query);
        const evidence = summarizeCompileResult(query, budget);
        compileEvidence.push({
          scope,
          scenario: "referrer-channel-budget",
          ...evidence,
        });
      }
    } finally {
      writeEvidence(
        "wave96i-share-trend-qualified-sqlite-evidence.json",
        JSON.stringify(
          {
            plan: "Wave96G",
            fixture: { siteId: SITE, window: WINDOW, filterDsl: FILTER_DSL },
            compileEvidence,
            runtimeEvidence,
          },
          null,
          2,
        ),
      );
    }
  }, 90_000);

  it("orders qualified rows by output identity, rank, bucket, and label", async () => {
    database.exec("PRAGMA reverse_unordered_selects = ON");
    try {
      const expectedOrdering = [
        { field: "rowKind", direction: "asc", nulls: "first" },
        { field: "outputId", direction: "asc", nulls: "first" },
        { field: "rowOrder", direction: "asc", nulls: "first" },
        { field: "bucket", direction: "asc", nulls: "first" },
        { field: "label", direction: "asc", nulls: "first" },
      ];
      const dualOutputIds = [
        TECHNOLOGY_SHARE_TREND_OUTPUTS.channel.bucket,
        TECHNOLOGY_SHARE_TREND_OUTPUTS.channel.series,
        TECHNOLOGY_SHARE_TREND_OUTPUTS.channel.top,
        TECHNOLOGY_SHARE_TREND_OUTPUTS.source.bucket,
        TECHNOLOGY_SHARE_TREND_OUTPUTS.source.series,
        TECHNOLOGY_SHARE_TREND_OUTPUTS.source.top,
      ];
      const sortedDualOutputIds = [
        ...Object.values(TECHNOLOGY_SHARE_TREND_OUTPUTS.source),
        ...Object.values(TECHNOLOGY_SHARE_TREND_OUTPUTS.channel),
      ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      expect(sortedDualOutputIds).toEqual(dualOutputIds);

      const scopeEvidence: Record<string, unknown>[] = [];
      for (const scope of ["session", "visitor"] as const) {
        const query = queryFor(
          scope,
          { name: "ordering-browser", variant: "browser" },
          12,
        );
        const candidate = await compileCandidate(query);
        expect(candidate.kind).toBe("compiled");
        if (candidate.kind !== "compiled")
          throw new Error("share_trend_ordering_compile_missing");
        expect(candidate.evidence.ordering).toEqual(expectedOrdering);

        const actualTrace = trace();
        const actual = await productionTechnologyProvider(query, actualTrace);
        const oracleTrace = trace();
        const oracle = await oldTechnologyReader(query, oracleTrace);
        expect(actual.value, `${scope}:ordered-dto`).toEqual(oracle);
        const value = actual.value as {
          readonly series: readonly {
            readonly key: string;
            readonly label: string;
            readonly views: number;
            readonly visitors: number;
            readonly sessions: number;
          }[];
          readonly data: readonly {
            readonly visitorsBySeries: Readonly<Record<string, number>>;
          }[];
        };
        const labels = value.series.map(({ label }) => label);
        expect(labels[0]).toBe("Zulu");
        expect(labels.indexOf("Aardvark")).toBeLessThan(labels.indexOf("Bee"));
        const tiedRows = value.series.filter(({ label }) =>
          ["Aardvark", "Bee"].includes(label),
        );
        expect(
          tiedRows.map(({ label, views, visitors, sessions }) => ({
            label,
            views,
            visitors,
            sessions,
          })),
        ).toEqual([
          { label: "Aardvark", views: 1, visitors: 1, sessions: 1 },
          { label: "Bee", views: 1, visitors: 1, sessions: 1 },
        ]);
        const aardvark = value.series.find(({ label }) => label === "Aardvark");
        const bee = value.series.find(({ label }) => label === "Bee");
        expect(aardvark).toBeDefined();
        expect(bee).toBeDefined();
        expect(value.data[0]?.visitorsBySeries[aardvark!.key]).toBe(1);
        expect(value.data[0]?.visitorsBySeries[bee!.key]).toBe(1);
        scopeEvidence.push({
          scope,
          sourceOrderFields: [
            "trendKind",
            "rowType",
            "rowOrder",
            "bucket",
            "label",
          ],
          outputIdProjection: dualOutputIds,
          ordering: candidate.evidence.ordering,
          sqlBytes: candidate.evidence.sqlBytes,
          bindingCount: candidate.evidence.bindingCount,
          groupWidth: candidate.evidence.groupWidth,
          sharedRelationCount: candidate.evidence.sharedRelationCount,
          physicalPlanShape: candidate.evidence.physicalPlanShape ?? null,
          sql: candidate.evidence.sql,
          bindings: candidate.evidence.bindings,
          legacyDto: oracle,
          orderedLabels: labels,
          tieRows: tiedRows,
          bucketZeroLabels: ["Aardvark", "Bee"],
          actualSql: actualTrace.preparedSql,
          actualBindings: actualTrace.bindings,
          oracleSql: oracleTrace.preparedSql,
          oracleBindings: oracleTrace.bindings,
        });
      }
      writeEvidence(
        "wave96i-share-trend-ordering-proof.json",
        JSON.stringify(
          {
            plan: "Wave96G root-review repair",
            sqlitePragma: "reverse_unordered_selects=ON",
            sortOrderEquivalence:
              "Binary outputId order is channel/source then bucket/series/top, equivalent to the native trendKind,rowType order; rowOrder,bucket,label then preserve rank and bucket-label order within each output.",
            outputIdOrder: dualOutputIds,
            scopes: scopeEvidence,
          },
          null,
          2,
        ),
      );
    } finally {
      database.exec("PRAGMA reverse_unordered_selects = OFF");
    }
  }, 90_000);

  it("normalizes only legal dimensions, limits, and default-referrer shapes", () => {
    expect(
      technologyShareTrendQualificationConfiguration({
        variant: undefined,
        dimension: undefined,
        interval: "hour",
        limit: 5,
      }),
    ).toEqual({
      kind: "single",
      dimension: "referrerDomain",
      interval: "hour",
      limit: 5,
    });
    expect(
      technologyShareTrendQualificationConfiguration({
        variant: "referrer-channel",
        dimension: undefined,
        interval: "hour",
        limit: 100,
      }),
    ).toEqual({ kind: "dual", interval: "hour", limit: 12 });
    expect(
      technologyShareTrendQualificationConfiguration({
        variant: "unrecognized",
        dimension: undefined,
        interval: "hour",
        limit: 5,
      }),
    ).toBeUndefined();
    expect(
      technologyShareTrendQualificationConfiguration({
        variant: "browser",
        dimension: "language",
        interval: "hour",
        limit: 5,
      }),
    ).toBeUndefined();
  });

  it("revalidates request-local brands and accepts only normalized-equivalent edits", async () => {
    const query = queryFor(
      "session",
      { name: "brand-check", variant: "browser" },
      99,
    );
    const diagnostics = createD1ReadDiagnostics();
    const forwarded = await d1AdvancedFilterMiddleware(
      sqliteEnv(database, trace()),
      diagnostics,
      SITE,
    )("share-trend", query, async (next) => next);
    const deferred = deferredShareTrendQualificationFromQuery(forwarded);
    expect(deferred).toBeDefined();
    if (!deferred) throw new Error("share_trend_brand_missing");

    const mutableQuery = forwarded as unknown as Record<string, unknown>;
    mutableQuery.limit = 100;
    const reorderedTime = Object.fromEntries(
      Object.entries(mutableQuery.time as Record<string, unknown>).reverse(),
    );
    mutableQuery.time = reorderedTime;
    expect(deferredShareTrendQualificationFromQuery(forwarded)).toBe(deferred);

    const clonedBrand = { ...deferred };
    expect(() =>
      compileShareTrendQualificationProgram({
        deferred: clonedBrand,
        query: forwarded,
        configuration: deferred.configuration,
      }),
    ).toThrow();

    mutableQuery.variant = "client";
    mutableQuery.dimension = "language";
    expect(() => deferredShareTrendQualificationFromQuery(forwarded)).toThrow();
    delete mutableQuery.dimension;
    mutableQuery.variant = "browser";
    mutableQuery.extra = true;
    expect(() => deferredShareTrendQualificationFromQuery(forwarded)).toThrow();
  });

  it("rejects malformed control and report protocol rows", async () => {
    const query = queryFor("session", {
      name: "malformed-envelope",
      variant: "browser",
    });
    const forwarded = await d1AdvancedFilterMiddleware(
      sqliteEnv(database, trace()),
      createD1ReadDiagnostics(),
      SITE,
    )("share-trend", query, async (next) => next);
    const deferred = deferredShareTrendQualificationFromQuery(forwarded);
    expect(deferred).toBeDefined();
    if (!deferred) throw new Error("share_trend_fault_brand_missing");

    const faults = [
      {
        name: "control-schema",
        expected: "share_trend_qualification_control_row_invalid",
        transform(rows: readonly Record<string, unknown>[]) {
          return rows.map((row) => {
            if (row.rowKind !== "control") return row;
            const malformed = { ...row };
            delete malformed.entityKind;
            return malformed;
          });
        },
      },
      {
        name: "control-kind",
        expected: "share_trend_qualification_control_kind_mismatch",
        transform(rows: readonly Record<string, unknown>[]) {
          return rows.map((row) =>
            row.rowKind === "control" ? { ...row, entityKind: "visitor" } : row,
          );
        },
      },
      {
        name: "report-kind",
        expected: "share_trend_qualification_report_descriptor_invalid",
        transform(rows: readonly Record<string, unknown>[]) {
          let changed = false;
          return rows.map((row) => {
            if (row.rowKind !== "report" || changed) return row;
            changed = true;
            return { ...row, trendKind: "unknown" };
          });
        },
      },
    ] as const;
    const faultEvidence: Record<string, unknown>[] = [];
    for (const fault of faults) {
      const faultTrace = trace();
      await expect(
        executeShareTrendQualificationProgram({
          env: sqliteEnvWithResultTransform(
            database,
            faultTrace,
            fault.transform,
          ),
          deferred,
          query: forwarded,
          configuration: deferred.configuration,
        }),
      ).rejects.toThrow(fault.expected);
      expect(faultTrace.preparedSql).toHaveLength(1);
      faultEvidence.push({
        name: fault.name,
        expectedError: fault.expected,
        preparedStatementCount: faultTrace.preparedSql.length,
      });
    }
    writeEvidence(
      "wave96i-share-trend-qualified-fault-evidence.json",
      JSON.stringify({ plan: "Wave96G", faults: faultEvidence }, null, 2),
    );
  }, 30_000);

  it("uses the prepared Page visit relation for Event Count numeric fallback", async () => {
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "alpha-tie-z");
    const query = queryFor(
      "event",
      { name: "numeric-domain-fallback", variant: "browser-engine" },
      5,
      'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1',
    );
    const candidate = await compileCandidate(query);
    expect(candidate.kind).toBe("compiled");
    if (candidate.kind !== "compiled") return;
    expect(candidate.deferred.qualification.countInput.scope).toBe("event");
    expect(candidate.evidence.outputDescriptors).toHaveLength(3);
    const actualTrace = trace();
    const diagnostics = createD1ReadDiagnostics();
    let envelopeRows: readonly Record<string, unknown>[] = [];
    try {
      const actual = await productionTechnologyProvider(
        query,
        actualTrace,
        diagnostics,
        sqliteEnvWithResultTransform(database, actualTrace, (rows) => {
          if (
            rows.some(
              (row) => row.rowKind === "report" || row.rowKind === "control",
            )
          )
            envelopeRows = rows;
          return rows;
        }),
      );
      const oracleTrace = trace();
      const oracle = await oldTechnologyReader(query, oracleTrace);
      expect(actual.value).toEqual(oracle);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(
        envelopeRows.filter((row) => row.rowKind === "report"),
      ).toHaveLength(0);
      expect(
        envelopeRows.filter((row) => row.rowKind === "control"),
      ).toHaveLength(1);
      expect(
        actualTrace.preparedSql.filter((sql) => sql.includes('AS "outputId"')),
      ).toHaveLength(1);
      const compatibilitySql = actualTrace.preparedSql.at(-1);
      expect(compatibilitySql).toContain("visit_id");
      expect(compatibilitySql).not.toContain("entity_id");
      writeEvidence(
        "wave96i-share-trend-numeric-fallback.json",
        JSON.stringify(
          {
            plan: "Wave96G",
            scenario: "numeric-domain-fallback",
            dtoEqual: true,
            fallbackReason: diagnostics.advancedCountSqlFallbackReason,
            actualSql: actualTrace.preparedSql,
            actualBindings: actualTrace.bindings,
            oracleSql: oracleTrace.preparedSql,
            oracleBindings: oracleTrace.bindings,
          },
          null,
          2,
        ),
      );
    } finally {
      database
        .prepare("UPDATE visits SET duration_ms = NULL WHERE visit_id = ?")
        .run("alpha-tie-z");
    }
  }, 30_000);
});
