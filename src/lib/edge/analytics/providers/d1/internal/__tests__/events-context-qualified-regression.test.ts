import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  type CompiledQuery,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
} from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { buildEventContextQualificationPlan } from "@/lib/edge/analytics/engine/event-context-report-plan";
import { EVENT_CONTEXT_CARD_KEYS } from "@/lib/edge/analytics/engine/semantic/event-context-cards";
import { queryEventAnalyticsContextCardsParentOracleFromD1 } from "@/lib/edge/analytics/providers/d1/internal/__tests__/event-context-parent-oracle";
import {
  d1AdvancedFilterMiddleware,
  deferredEventContextQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  compileEventContextQualificationProgram,
  type EventContextQualificationQuery,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import {
  mapEventAnalyticsContextCards,
  queryD1CompiledAll,
  type QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  type EventContextCardKey,
  queryEventAnalyticsContextCardsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-context";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "wave94e-event-context";
const FOREIGN_SITE_ID = "wave94e-event-context-foreign";
const WINDOW: QueryWindow = {
  startMs: Date.UTC(2026, 0, 1, 8),
  endExclusiveMs: Date.UTC(2026, 0, 4, 8),
  nowMs: Date.UTC(2026, 0, 5, 8),
  timeZone: "America/Los_Angeles",
};
const QUERY_TIME = createQueryTime(
  WINDOW.startMs,
  WINDOW.endExclusiveMs,
  WINDOW.timeZone,
  WINDOW.nowMs,
);
const databases = new Set<DatabaseSync>();
const evidenceBatches: unknown[] = [];

interface PreparedEventContextQuery extends QueryInput {
  readonly filters: FilterDocument;
  readonly time: QueryTime;
  readonly eventName: string;
  readonly limit: number;
  readonly selectedKeys?: readonly EventContextCardKey[];
}

interface ContextScenario {
  readonly label: string;
  readonly scope: "session" | "visitor";
  readonly limit: number;
  readonly eventName?: string;
  readonly selectedKeys?: readonly EventContextCardKey[];
  readonly countPath?: string;
  readonly countDsl?: string;
  readonly expectedFallback?: "numeric-data-domain" | "compile-budget";
}

function newTrace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "wave94e-event-context-qualified-test-secret",
  } as unknown as Env;
}

function sitePrimaryKey(database: DatabaseSync, siteId: string): number {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  return Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number }
    ).site_pk,
  );
}

function insertVisit(
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly siteId: string;
    readonly sitePk: number;
    readonly visitorId: string;
    readonly sessionId: string;
    readonly startedAt: number;
    readonly pathname: string;
    readonly country?: string;
    readonly region?: string;
    readonly regionCode?: string;
    readonly city?: string;
    readonly organization?: string;
    readonly browser?: string;
    readonly os?: string;
    readonly osVersion?: string;
    readonly deviceType?: string;
    readonly language?: string;
    readonly screenWidth?: number;
    readonly screenHeight?: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
         visit_id, site_id, site_pk, visitor_id, session_id, status,
         started_at, last_activity_at, pathname, query_string, hostname,
         title, referrer_url, referrer_host, browser, os, os_version,
         device_type, language, screen_width, screen_height, country, region,
         region_code, city, continent, timezone, as_organization
       ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'plan=pro', 'context.test',
         'Context title', 'https://ref.test/previous', 'ref.test', ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, 'North America', 'America/Los_Angeles', ?)`,
    )
    .run(
      input.id,
      input.siteId,
      input.sitePk,
      input.visitorId,
      input.sessionId,
      input.startedAt,
      input.startedAt,
      input.pathname,
      input.browser ?? "Chrome",
      input.os ?? "macOS",
      input.osVersion ?? "17.0",
      input.deviceType ?? "desktop",
      input.language ?? "en-US",
      input.screenWidth ?? 1440,
      input.screenHeight ?? 900,
      input.country ?? "US",
      input.region ?? "California",
      input.regionCode ?? "CA",
      input.city ?? "San Francisco",
      input.organization ?? "Example Organization",
    );
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const sitePk = sitePrimaryKey(database, SITE_ID);
  const foreignSitePk = sitePrimaryKey(database, FOREIGN_SITE_ID);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, ?, ?, 0), (?, ?, ?, ?, 0)`,
    )
    .run(
      SITE_ID,
      "wave94e-team",
      "Event context qualification",
      "context.test",
      FOREIGN_SITE_ID,
      "wave94e-foreign-team",
      "Foreign context site",
      "foreign-context.test",
    );

  const visits = [
    {
      id: "visit-a-empty-path",
      siteId: SITE_ID,
      sitePk,
      visitorId: "wave94e-visitor-a",
      sessionId: "wave94e-shared-session",
      startedAt: WINDOW.startMs,
      pathname: "",
    },
    {
      id: "visit-a-whitespace-path",
      siteId: SITE_ID,
      sitePk,
      visitorId: "wave94e-visitor-a",
      sessionId: "wave94e-shared-session",
      startedAt: WINDOW.startMs + 5,
      pathname: "   ",
    },
    {
      id: "visit-a-qualifying",
      siteId: SITE_ID,
      sitePk,
      visitorId: "wave94e-visitor-a",
      sessionId: "wave94e-shared-session",
      startedAt: WINDOW.startMs + 20,
      pathname: "/qualifying",
    },
    {
      id: "visit-a-later",
      siteId: SITE_ID,
      sitePk,
      visitorId: "wave94e-visitor-a",
      sessionId: "wave94e-shared-session",
      startedAt: WINDOW.startMs + 30,
      pathname: "/a-later",
      browser: "  Chrome  ",
      country: "US",
    },
    {
      id: "visit-b-unqualified-early",
      siteId: SITE_ID,
      sitePk,
      visitorId: "wave94e-visitor-b",
      sessionId: "wave94e-shared-session",
      startedAt: WINDOW.startMs + 10,
      pathname: "/b-unqualified-early",
      country: "CA",
      region: "British Columbia",
      regionCode: "BC",
      city: "Vancouver",
      organization: "Foreign Organization",
      browser: "Firefox",
    },
    {
      id: "visit-tie-z",
      siteId: SITE_ID,
      sitePk,
      visitorId: "wave94e-visitor-a",
      sessionId: "wave94e-tie-session",
      startedAt: WINDOW.startMs + 40,
      pathname: "/tie-z",
    },
    {
      id: "visit-tie-a",
      siteId: SITE_ID,
      sitePk,
      visitorId: "wave94e-visitor-a",
      sessionId: "wave94e-tie-session",
      startedAt: WINDOW.startMs + 40,
      pathname: "/tie-a",
    },
    {
      id: "visit-foreign-site",
      siteId: FOREIGN_SITE_ID,
      sitePk: foreignSitePk,
      visitorId: "wave94e-visitor-a",
      sessionId: "wave94e-shared-session",
      startedAt: WINDOW.startMs + 1,
      pathname: "/foreign-site",
    },
  ] as const;
  for (const visit of visits) insertVisit(database, visit);

  const names = [" signup ", "signup", "SignUp", "   "];
  const nameIds = new Map<string, number>();
  names.forEach((name, index) => {
    const id = index + 1;
    database
      .prepare(
        `INSERT INTO custom_event_names
         (id, site_id, name, last_seen_at, site_pk)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, SITE_ID, name, WINDOW.startMs, sitePk);
    nameIds.set(name, id);
  });
  database
    .prepare(
      `INSERT INTO custom_event_names
       (id, site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(5, FOREIGN_SITE_ID, "signup", WINDOW.startMs, foreignSitePk);
  nameIds.set("foreign-signup", 5);
  const foreignNameId = nameIds.get("foreign-signup");
  if (foreignNameId === undefined)
    throw new Error("wave94e_foreign_event_name_missing");

  const events = [
    {
      id: "event-a-qualifying-1",
      visit: "visit-a-qualifying",
      name: " signup ",
    },
    {
      id: "event-a-qualifying-2",
      visit: "visit-a-qualifying",
      name: " signup ",
    },
    { id: "event-a-later", visit: "visit-a-later", name: "signup" },
    { id: "event-b", visit: "visit-b-unqualified-early", name: "signup" },
    { id: "event-tie-z", visit: "visit-tie-z", name: "signup" },
    { id: "event-tie-a", visit: "visit-tie-a", name: "signup" },
    { id: "event-a-upper", visit: "visit-a-qualifying", name: "SignUp" },
    { id: "event-a-blank", visit: "visit-a-qualifying", name: "   " },
  ] as const;
  events.forEach((event, index) => {
    const eventNameId = nameIds.get(event.name);
    if (eventNameId === undefined)
      throw new Error(`wave94e_event_name_missing:${event.name}`);
    database
      .prepare(
        `INSERT INTO custom_events (
           event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
           received_at, sequence, node_count, value_count
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
      )
      .run(
        event.id,
        SITE_ID,
        sitePk,
        event.visit,
        eventNameId,
        WINDOW.startMs + 100 + index,
        WINDOW.nowMs,
      );
  });
  database
    .prepare(
      `INSERT INTO custom_events (
         event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
         received_at, sequence, node_count, value_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
    )
    .run(
      "event-foreign-site",
      FOREIGN_SITE_ID,
      foreignSitePk,
      "visit-foreign-site",
      foreignNameId,
      WINDOW.startMs + 200,
      WINDOW.nowMs,
    );
  return database;
}

function prepareContextQuery(input: {
  readonly scope: ContextScenario["scope"];
  readonly limit: number;
  readonly eventName?: string;
  readonly selectedKeys?: readonly EventContextCardKey[];
  readonly countPath?: string;
  readonly countDsl?: string;
}): PreparedEventContextQuery {
  const filters = parseFilterDsl(
    input.countDsl ??
      `count(page { page.path eq ${JSON.stringify(input.countPath ?? "/qualifying")} }) eq 1`,
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("event-context", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters,
    scopePreference: input.scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: QueryTime;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave94e_event_context_preparation_failed");
  return {
    ...prepared,
    filters: prepared.filters,
    time: prepared.time,
    eventName: input.eventName ?? "",
    limit: input.limit,
    ...(input.selectedKeys ? { selectedKeys: input.selectedKeys } : {}),
  } as PreparedEventContextQuery;
}

function statementEvidence(trace: SqliteD1Trace) {
  return trace.preparedSql.map((sql, index) => ({
    sql,
    bindings: trace.bindings[index],
    sqlUtf8Bytes: new TextEncoder().encode(sql).byteLength,
    bindingCount: trace.bindings[index]?.length ?? 0,
    sha256: createHash("sha256").update(sql).digest("hex"),
  }));
}

async function prepareDeferred(
  database: DatabaseSync,
  prepared: PreparedEventContextQuery,
) {
  const trace = newTrace();
  const forwarded = await d1AdvancedFilterMiddleware(testEnv(database, trace))(
    "event-context",
    prepared,
    async (value) => value,
  );
  const deferred = deferredEventContextQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("wave94e_deferred_event_context_missing");
  return { trace, forwarded, deferred };
}

async function runScenario(database: DatabaseSync, scenario: ContextScenario) {
  const prepared = prepareContextQuery(scenario);
  const { trace: oldTrace, deferred } = await prepareDeferred(
    database,
    prepared,
  );
  const oldFilters = await prepareDeferredEventQualificationFallback(deferred);
  const selectedKeys = scenario.selectedKeys?.length
    ? EVENT_CONTEXT_CARD_KEYS.filter((key) =>
        new Set(scenario.selectedKeys).has(key),
      )
    : [...EVENT_CONTEXT_CARD_KEYS];
  const baselineRaw = await queryEventAnalyticsContextCardsParentOracleFromD1(
    testEnv(database, oldTrace),
    SITE_ID,
    WINDOW,
    oldFilters,
    scenario.limit,
    scenario.eventName ?? "",
    selectedKeys,
  );
  const baselineDto = mapEventAnalyticsContextCards(baselineRaw);

  const diagnostics = createD1ReadDiagnostics();
  const actualTrace = newTrace();
  const provider = createD1SiteProviderRegistry({
    env: testEnv(database, actualTrace),
    siteId: SITE_ID,
    diagnostics,
  }).resolve("event-context");
  if (!provider) throw new Error("wave94e_event_context_provider_missing");
  const actual = await provider.execute(prepared as never);
  expect(actual.value).toEqual({
    eventName: scenario.eventName ?? "",
    cards: baselineDto,
  });

  const proof = await prepareDeferred(database, prepared);
  const query: EventContextQualificationQuery = {
    limit: scenario.limit,
    selectedKeys,
    eventName: scenario.eventName ?? "",
  };
  const compilation = compileEventContextQualificationProgram({
    deferred: proof.deferred,
    query,
  });
  let rawRows: readonly Record<string, unknown>[] = [];
  let reportSourceRelations: readonly unknown[] = [];
  let qualificationGraph: Record<string, unknown> | null = null;
  if (compilation.kind === "compiled") {
    const plan = buildEventContextQualificationPlan({
      siteId: SITE_ID,
      count: proof.deferred.countInput,
      limit: scenario.limit,
      selectedKeys,
      eventName: scenario.eventName ?? "",
    });
    reportSourceRelations = plan.reportSourceRelations ?? [];
    qualificationGraph = {
      eventSourceRelationId: plan.eventSourceRelationId,
      matchesRelationId: plan.matchesRelationId,
      controlsRelationId: plan.controlsRelationId,
      groupedSummaryRelationId: plan.groupedSummaryRelationId,
      controlOutputId: plan.controlOutputId,
      reportOutputIds: plan.reportOutputIds,
      reportSourceRelations: plan.reportSourceRelations ?? [],
    };
    expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
    expect(compilation.evidence.groupedSummaryMaterialization).toBe(
      "materialized",
    );
    if (!scenario.selectedKeys?.length) {
      expect(compilation.evidence.qualifiedReportInputWidth).toBe(22);
      expect(compilation.evidence.qualifiedReportInputMaterialization).toBe(
        "materialized",
      );
    }
    expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(
      D1_MAX_SQL_UTF8_BYTES,
    );
    expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    rawRows = await queryD1CompiledAll(testEnv(database, newTrace()), {
      kind: "query",
      sql: compilation.evidence.sql,
      bindings: [...compilation.evidence.bindings],
      tag: compilation.evidence.statementTag,
    } as CompiledQuery<Record<string, unknown>>);
    const controls = rawRows.filter((row) => row.rowKind === "control");
    expect(controls).toHaveLength(1);
    expect(controls[0]!.entityKind).toBe(scenario.scope);
    expect(rawRows.length).toBeGreaterThanOrEqual(controls.length);
  }

  if (scenario.expectedFallback === "numeric-data-domain") {
    expect(compilation.kind).toBe("compiled");
    expect(diagnostics.advancedCountSqlFallbackReason?.kind).toBe(
      "numeric-data-domain",
    );
    expect(actualTrace.preparedSql.length).toBeGreaterThan(2);
    expect(rawRows.filter((row) => row.rowKind === "report")).toHaveLength(0);
  } else if (scenario.expectedFallback === "compile-budget") {
    expect(compilation.kind).toBe("unavailable");
    if (compilation.kind !== "unavailable")
      throw new Error("wave94e_context_budget_not_refused");
    expect(compilation.fallbackReason.kind).toBe("compile-budget");
    expect(diagnostics.advancedCountSqlFallbackReason?.kind).toBe(
      "compile-budget",
    );
    expect(actualTrace.preparedSql.length).toBeGreaterThan(2);
  } else {
    expect(
      compilation.kind,
      compilation.kind === "unavailable"
        ? JSON.stringify(compilation.fallbackReason)
        : undefined,
    ).toBe("compiled");
    expect(actualTrace.preparedSql).toHaveLength(2);
    if (compilation.kind === "compiled")
      expect(actualTrace.preparedSql.at(-1)).toBe(compilation.evidence.sql);
  }
  expect(oldTrace.preparedSql.length).toBeGreaterThan(2);
  expect(
    JSON.stringify(actualTrace.bindings).includes("wave94e-shared-session"),
  ).toBe(false);
  expect(
    JSON.stringify(actualTrace.bindings).includes("wave94e-visitor-a"),
  ).toBe(false);

  return {
    scenario,
    baseline: {
      statementCount: oldTrace.preparedSql.length,
      statements: statementEvidence(oldTrace),
      dto: baselineDto,
    },
    qualified: {
      statementCount: actualTrace.preparedSql.length,
      statements: statementEvidence(actualTrace),
      dto: actual.value,
      dtoEqual: true,
      compilation:
        compilation.kind === "compiled"
          ? { kind: compilation.kind, evidence: compilation.evidence }
          : {
              kind: compilation.kind,
              fallbackReason: compilation.fallbackReason,
            },
      reportSourceRelations,
      qualificationGraph,
      rawQualificationRows: rawRows,
      diagnosticsFallback: diagnostics.advancedCountSqlFallbackReason ?? null,
      ownerIdentifiersBound: false,
    },
  };
}

function writeEvidence(value: unknown): void {
  evidenceBatches.push(value);
}

afterAll(() => {
  for (const database of databases) database.close();
  const evidencePath = process.env.WAVE94E_EVENT_CONTEXT_EVIDENCE_PATH;
  if (!evidencePath) return;
  const absolutePath = resolve(evidencePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(
    absolutePath,
    JSON.stringify(
      { kind: "wave94e-event-context-qualified-evidence-v1", evidenceBatches },
      null,
      2,
    ),
    "utf8",
  );
});

describe("Wave94E qualified Event Context", () => {
  it.each(["session", "visitor"] as const)(
    "preserves all 19 cards and the full legacy DTO for %s Count qualification",
    async (scope) => {
      const database = createFixture();
      const result = await runScenario(database, {
        label: `${scope}-all-19-cards`,
        scope,
        limit: 100,
        eventName: "signup",
      });
      if (result.qualified.compilation.kind !== "compiled")
        throw new Error("wave94e_context_default_cards_not_compiled");
      const cards = result.qualified.dto as {
        readonly cards: {
          readonly page: Record<string, readonly { readonly label: string }[]>;
          readonly source: Record<
            string,
            readonly { readonly label: string }[]
          >;
          readonly client: Record<
            string,
            readonly { readonly label: string }[]
          >;
          readonly geo: Record<
            string,
            readonly { readonly value: string; readonly label: string }[]
          >;
        };
      };
      const returnedKeys = [
        ...Object.keys(cards.cards.page),
        ...Object.keys(cards.cards.source),
        ...Object.keys(cards.cards.client),
        ...Object.keys(cards.cards.geo),
      ];
      expect(returnedKeys).toHaveLength(19);
      expect(
        new Set(
          result.qualified.rawQualificationRows
            .filter((row) => row.rowKind === "report")
            .map((row) => row.cardType),
        ),
      ).toEqual(new Set(EVENT_CONTEXT_CARD_KEYS));
      expect(cards.cards.page.path.map(({ label }) => label)).not.toContain(
        "/foreign-site",
      );
      expect(cards.cards.geo.country[0]).toMatchObject({
        value: "US",
        label: "US",
      });
      if (scope === "visitor") {
        expect(cards.cards.page.entry.map(({ label }) => label)).not.toContain(
          "/b-unqualified-early",
        );
        expect(cards.cards.page.entry.map(({ label }) => label)).toContain(
          "/qualifying",
        );
        expect(cards.cards.page.exit.map(({ label }) => label)).not.toContain(
          "/b-unqualified-early",
        );
        expect(cards.cards.page.entry.map(({ label }) => label)).toContain(
          "/tie-a",
        );
        expect(cards.cards.page.exit.map(({ label }) => label)).toContain(
          "/tie-z",
        );
      } else {
        expect(cards.cards.page.entry.map(({ label }) => label)).toContain(
          "/b-unqualified-early",
        );
      }
      expect(result.qualified.compilation.evidence.physicalScanKinds).toContain(
        "custom_events",
      );
      expect(result.qualified.compilation.evidence.physicalScanKinds).toContain(
        "visits",
      );
      expect(result.qualified.reportSourceRelations).toHaveLength(2);
      writeEvidence({
        kind: "wave94e-event-context-qualified-differential-v1",
        scenarios: [result],
      });
    },
  );

  it("keeps selected cards, limits, and the legacy reader-window name gate", async () => {
    const database = createFixture();
    const results = [];
    for (const scenario of [
      {
        label: "selected-ordinary-subset-with-limit-one",
        scope: "visitor" as const,
        limit: 1,
        eventName: "signup",
        selectedKeys: ["path", "country"] as const,
      },
      {
        label: "boundary-only-keys",
        scope: "visitor" as const,
        limit: 100,
        eventName: "signup",
        selectedKeys: ["entry", "exit"] as const,
      },
      {
        label: "event-count-qualification-with-page-boundaries",
        scope: "visitor" as const,
        limit: 100,
        eventName: "signup",
        selectedKeys: ["entry", "path"] as const,
        countDsl: 'count(event { event.name eq "signup" }) eq 3',
      },
      {
        label: "truthy-whitespace-name-is-trim-compared-to-raw-input",
        scope: "visitor" as const,
        limit: 100,
        eventName: " ",
      },
      {
        label: "empty-name-keeps-the-legacy-no-gate-behavior",
        scope: "visitor" as const,
        limit: 100,
        eventName: "",
      },
    ])
      results.push(await runScenario(database, scenario));
    const subset = results[0]!.qualified.dto as {
      readonly cards: {
        readonly page: { readonly path: readonly { readonly label: string }[] };
        readonly geo: {
          readonly country: readonly { readonly value: string }[];
        };
        readonly source: {
          readonly domain: readonly unknown[];
          readonly link: readonly unknown[];
        };
        readonly client: Record<string, readonly unknown[]>;
      };
    };
    expect(subset.cards.page.path).toHaveLength(1);
    expect(subset.cards.page.path[0]!.label).toBe("/qualifying");
    expect(subset.cards.geo.country).toHaveLength(1);
    expect(subset.cards.source.domain).toEqual([]);
    expect(subset.cards.source.link).toEqual([]);
    expect(
      Object.values(subset.cards.client).every((rows) => rows.length === 0),
    ).toBe(true);
    const boundary = results[1]!.qualified.dto as {
      readonly cards: { readonly page: Record<string, readonly unknown[]> };
    };
    expect(boundary.cards.page.path).toEqual([]);
    expect(boundary.cards.page.entry.length).toBeGreaterThan(0);
    const eventCount = results[2]!.qualified.dto as {
      readonly cards: {
        readonly page: {
          readonly entry: readonly { readonly label: string }[];
        };
      };
    };
    expect(eventCount.cards.page.entry.map(({ label }) => label)).not.toContain(
      "/b-unqualified-early",
    );
    const whitespace = results[3]!.qualified.dto as {
      readonly cards: { readonly page: Record<string, readonly unknown[]> };
    };
    expect(
      Object.values(whitespace.cards.page).every((rows) => rows.length === 0),
    ).toBe(true);
    const emptyName = results[4]!.qualified.dto as {
      readonly cards: {
        readonly page: { readonly path: readonly { readonly views: number }[] };
      };
    };
    expect(
      emptyName.cards.page.path.reduce((sum, row) => sum + row.views, 0),
    ).toBeGreaterThan(results[0]!.baseline.dto.page.path[0]?.views ?? 0);
    writeEvidence({
      kind: "wave94e-event-context-qualified-selection-v1",
      scenarios: results,
      canonicalCards: [...EVENT_CONTEXT_CARD_KEYS],
    });
  }, 20_000);

  it("returns the empty DTO without SQL for direct empty selection and for empty qualification", async () => {
    const database = createFixture();
    const directTrace = newTrace();
    const direct = await queryEventAnalyticsContextCardsFromD1(
      testEnv(database, directTrace),
      SITE_ID,
      WINDOW,
      parseFilterDsl(
        'count(page { page.path eq "/qualifying" }) eq 1',
        analyticsFilterRegistry,
      ),
      10,
      "signup",
      [],
    );
    expect(direct).toEqual({
      page: {
        path: [],
        query: [],
        title: [],
        hostname: [],
        entry: [],
        exit: [],
      },
      source: { domain: [], link: [] },
      client: {
        browser: [],
        osVersion: [],
        deviceType: [],
        language: [],
        screenSize: [],
      },
      geo: {
        country: [],
        region: [],
        city: [],
        continent: [],
        timezone: [],
        organization: [],
      },
    });
    expect(directTrace.preparedSql).toHaveLength(0);
    const empty = await runScenario(database, {
      label: "empty-qualified-owner-result",
      scope: "visitor",
      limit: 10,
      countPath: "/not-present",
      selectedKeys: ["entry", "path"],
    });
    expect(empty.qualified.dto).toMatchObject({
      cards: {
        page: { entry: [], path: [] },
        source: { domain: [], link: [] },
      },
    });
    writeEvidence({ kind: "wave94e-event-context-empty-v1", scenario: empty });
  });

  it("falls back as a whole report for numeric compatibility and compile refusal", async () => {
    const numericDatabase = createFixture();
    numericDatabase
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-a-qualifying");
    const numeric = await runScenario(numericDatabase, {
      label: "numeric-compatibility-fallback",
      scope: "session",
      limit: 5,
      eventName: "signup",
      selectedKeys: ["entry", "path"],
      countDsl: "count(page { page.durationMs gt 5 }) eq 1",
      expectedFallback: "numeric-data-domain",
    });
    const budgetDatabase = createFixture();
    const terms = Array.from(
      { length: D1_MAX_BOUND_PARAMETERS + 1 },
      (_unused, index) =>
        `page.path contains ${JSON.stringify(`/budget-${index}`)}`,
    ).join(" OR ");
    const budget = await runScenario(budgetDatabase, {
      label: "compile-budget-fallback",
      scope: "visitor",
      limit: 5,
      eventName: "signup",
      selectedKeys: ["entry", "path"],
      countDsl: `count(page { ${terms} }) eq 1`,
      expectedFallback: "compile-budget",
    });
    writeEvidence({
      kind: "wave94e-event-context-fallbacks-v1",
      scenarios: [numeric, budget],
    });
  }, 20_000);

  it("keeps activity-cap errors, aborts, and database failures observable without report leakage", async () => {
    const database = createFixture();
    const capSitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE_ID) as { readonly site_pk: number }
      ).site_pk,
    );
    const insertCapVisit = database.prepare(
      `INSERT INTO visits (
         visit_id, site_id, site_pk, visitor_id, session_id, status,
         started_at, last_activity_at, pathname, hostname
       ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, '/cap', 'cap.test')`,
    );
    for (let index = 0; index < 20_001; index += 1) {
      const id = `visit-cap-${index}`;
      insertCapVisit.run(
        id,
        SITE_ID,
        capSitePk,
        `visitor-cap-${index}`,
        `session-cap-${index}`,
        WINDOW.startMs + 500,
        WINDOW.startMs + 500,
      );
    }
    const prepared = prepareContextQuery({
      scope: "session",
      limit: 5,
      countPath: "/cap",
      selectedKeys: ["entry"],
    });
    const capTrace = newTrace();
    const forwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, capTrace),
    )("event-context", prepared, async (value) => value);
    const deferred = deferredEventContextQualificationFromQuery(forwarded);
    if (!deferred) throw new Error("wave94e_cap_deferred_missing");
    await expect(
      prepareDeferredEventQualificationFallback(deferred),
    ).rejects.toMatchObject({
      domainError: { issues: [{ code: "filter_activity_limit_exceeded" }] },
    });
    const capProgram = compileEventContextQualificationProgram({
      deferred,
      query: {
        limit: 5,
        selectedKeys: ["entry"],
        eventName: "",
      },
    });
    expect(capProgram.kind).toBe("compiled");
    if (capProgram.kind !== "compiled")
      throw new Error("wave94e_cap_program_not_compiled");
    const rawRows = await queryD1CompiledAll(testEnv(database, newTrace()), {
      kind: "query",
      sql: capProgram.evidence.sql,
      bindings: [...capProgram.evidence.bindings],
      tag: capProgram.evidence.statementTag,
    } as CompiledQuery<Record<string, unknown>>);
    expect(rawRows.filter((row) => row.rowKind === "control")).toHaveLength(1);
    expect(
      rawRows.find((row) => row.rowKind === "control")!.rawCount,
    ).toBeGreaterThan(20_000);
    expect(rawRows.filter((row) => row.rowKind === "report")).toHaveLength(0);
    const capActualTrace = newTrace();
    const capProvider = createD1SiteProviderRegistry({
      env: testEnv(database, capActualTrace),
      siteId: SITE_ID,
    }).resolve("event-context");
    if (!capProvider) throw new Error("wave94e_cap_provider_missing");
    await expect(capProvider.execute(prepared as never)).rejects.toMatchObject({
      domainError: { issues: [{ code: "filter_activity_limit_exceeded" }] },
    });
    expect(capActualTrace.preparedSql).toHaveLength(2);

    const abortPrepared = prepareContextQuery({
      scope: "visitor",
      limit: 5,
      eventName: "signup",
      selectedKeys: ["entry"],
    });
    const abortTrace = newTrace();
    const abortProvider = createD1SiteProviderRegistry({
      env: testEnv(database, abortTrace),
      siteId: SITE_ID,
    }).resolve("event-context");
    if (!abortProvider) throw new Error("wave94e_abort_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortProvider.execute(abortPrepared as never, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortTrace.preparedSql).toHaveLength(0);

    const brokenEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error("wave94e-context-database-read-failed");
            },
          }),
        }),
      },
      MAIN_SECRET: "wave94e-event-context-qualified-test-secret",
    } as unknown as Env;
    const brokenProvider = createD1SiteProviderRegistry({
      env: brokenEnv,
      siteId: SITE_ID,
    }).resolve("event-context");
    if (!brokenProvider) throw new Error("wave94e_error_provider_missing");
    await expect(
      brokenProvider.execute(abortPrepared as never),
    ).rejects.toThrow("wave94e-context-database-read-failed");
    writeEvidence({
      kind: "wave94e-event-context-control-failure-evidence-v1",
      overCapActivityCount: rawRows.find((row) => row.rowKind === "control")!
        .rawCount,
      controlRows: rawRows.filter((row) => row.rowKind === "control"),
      leakedReportRows: rawRows.filter((row) => row.rowKind === "report")
        .length,
      actualStatementCount: capActualTrace.preparedSql.length,
      abortStatementCount: abortTrace.preparedSql.length,
      oldCapFailure: "filter_activity_limit_exceeded",
      newCapFailure: "filter_activity_limit_exceeded",
    });
  }, 45_000);
});
