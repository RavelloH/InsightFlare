import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

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
import {
  d1AdvancedFilterMiddleware,
  deferredEventTrendQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  compileEventTrendQualificationProgram,
  type EventTrendQualificationQuery,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import {
  type Interval,
  queryD1CompiledAll,
  type QueryWindow,
  SHARE_TREND_OTHER_KEY,
  SHARE_TREND_OTHER_LABEL,
  SHARE_TREND_OTHER_TOKEN,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryEventsTrendFromD1 } from "@/lib/edge/analytics/providers/d1/internal/events-trend";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";

const SITE_ID = "wave94d-event-trend";
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

interface PreparedEventTrendQuery extends QueryInput {
  readonly filters: FilterDocument;
  readonly time: QueryTime;
  readonly interval: Interval;
  readonly limit: number;
  readonly eventName?: string;
}

interface TrendScenario {
  readonly label: string;
  readonly scope: "session" | "visitor";
  readonly limit: number;
  readonly interval: Interval;
  readonly eventName?: string;
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
    MAIN_SECRET: "wave94d-event-trend-qualified-test-secret",
  } as unknown as Env;
}

function createFixture(options?: {
  readonly includePreparedNameCompatibilityRows?: boolean;
}): DatabaseSync {
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
    .run(SITE_ID, "wave94d-team", "Event trend qualification", "trend.test");

  const eventNames = [
    "alpha",
    "beta",
    "gamma",
    "other",
    SHARE_TREND_OTHER_TOKEN,
    "delta",
    "zeta",
    "",
    "   ",
    ...(options?.includePreparedNameCompatibilityRows ? [" alpha "] : []),
  ];
  const nameIds = new Map<string, number>();
  eventNames.forEach((name, index) => {
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

  const visits = [
    {
      id: "visit-wave94d-scoped",
      visitorId: "wave94d-scoped-visitor",
      sessionId: "wave94d-scoped-session",
      pathname: "/scoped",
    },
    {
      id: "visit-wave94d-outside",
      visitorId: "wave94d-outside-visitor",
      sessionId: "wave94d-outside-session",
      pathname: "/outside",
    },
  ];
  for (const visit of visits) {
    database
      .prepare(
        `INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname
         ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'trend.test')`,
      )
      .run(
        visit.id,
        SITE_ID,
        sitePk,
        visit.visitorId,
        visit.sessionId,
        WINDOW.startMs + 1,
        WINDOW.startMs + 1,
        visit.pathname,
      );
  }

  const eventRows: readonly {
    readonly name: string;
    readonly day: number;
    readonly hour: number;
    readonly count: number;
    readonly outside?: boolean;
  }[] = [
    { name: "alpha", day: 1, hour: 9, count: 3 },
    { name: "beta", day: 1, hour: 10, count: 2 },
    { name: "gamma", day: 3, hour: 11, count: 2 },
    { name: "other", day: 1, hour: 13, count: 2 },
    { name: SHARE_TREND_OTHER_TOKEN, day: 3, hour: 15, count: 1 },
    { name: "delta", day: 3, hour: 17, count: 1 },
    { name: "", day: 1, hour: 14, count: 1 },
    { name: "   ", day: 3, hour: 18, count: 1 },
    { name: "zeta", day: 1, hour: 9, count: 1, outside: true },
    ...(options?.includePreparedNameCompatibilityRows
      ? [{ name: " alpha ", day: 2, hour: 12, count: 1 }]
      : []),
  ];
  let eventIndex = 0;
  for (const entry of eventRows) {
    const eventNameId = nameIds.get(entry.name);
    if (eventNameId === undefined)
      throw new Error(`wave94d_event_name_missing:${entry.name}`);
    for (let index = 0; index < entry.count; index += 1) {
      eventIndex += 1;
      const outside = entry.outside === true;
      database
        .prepare(
          `INSERT INTO custom_events (
             event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
             received_at, sequence, node_count, value_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1)`,
        )
        .run(
          `wave94d-event-${eventIndex}`,
          SITE_ID,
          sitePk,
          outside ? "visit-wave94d-outside" : "visit-wave94d-scoped",
          eventNameId,
          Date.UTC(2026, 0, entry.day, entry.hour),
          WINDOW.nowMs,
        );
    }
  }
  return database;
}

function prepareTrendQuery(input: {
  readonly countPath?: string;
  readonly countDsl?: string;
  readonly scope: TrendScenario["scope"];
  readonly limit: number;
  readonly interval: Interval;
  readonly eventName?: string;
}): PreparedEventTrendQuery {
  const countPath = input.countPath ?? "/scoped";
  const filters = parseFilterDsl(
    input.countDsl ??
      `count(page { page.path eq ${JSON.stringify(countPath)} }) eq 1`,
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("event-trend", {
    context: siteQueryContext(SITE_ID, "private-dashboard"),
    time: QUERY_TIME,
    filters,
    scopePreference: input.scope,
  } as QueryInput & { readonly time: QueryTime }) as QueryInput & {
    readonly filters?: FilterDocument;
    readonly time?: QueryTime;
  };
  if (!prepared.filters || !prepared.time)
    throw new Error("wave94d_event_trend_preparation_failed");
  return {
    ...prepared,
    filters: prepared.filters,
    time: prepared.time,
    limit: input.limit,
    interval: input.interval,
    ...(input.eventName !== undefined ? { eventName: input.eventName } : {}),
  } as PreparedEventTrendQuery;
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

async function runScenario(
  database: DatabaseSync,
  scenario: TrendScenario,
  options: { readonly assertDtoEqual?: boolean } = {},
) {
  const prepared = prepareTrendQuery(scenario);
  const oldTrace = newTrace();
  const oldEnv = testEnv(database, oldTrace);
  const forwarded = await d1AdvancedFilterMiddleware(oldEnv)(
    "event-trend",
    prepared,
    async (value) => value,
  );
  const deferred = deferredEventTrendQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("wave94d_legacy_event_trend_deferred_missing");
  const oldFilters = await prepareDeferredEventQualificationFallback(deferred);
  const baselineDto = await queryEventsTrendFromD1(
    oldEnv,
    SITE_ID,
    WINDOW,
    scenario.interval,
    oldFilters,
    scenario.limit,
    scenario.eventName,
  );

  const diagnostics = createD1ReadDiagnostics();
  const actualTrace = newTrace();
  const provider = createD1SiteProviderRegistry({
    env: testEnv(database, actualTrace),
    siteId: SITE_ID,
    diagnostics,
  }).resolve("event-trend");
  if (!provider) throw new Error("wave94d_event_trend_provider_missing");
  const actual = await provider.execute(prepared as never);
  const expectedDto = { interval: scenario.interval, ...baselineDto };
  const dtoEqual = isDeepStrictEqual(actual.value, expectedDto);
  if (options.assertDtoEqual !== false)
    expect(actual.value).toEqual(expectedDto);

  const proofTrace = newTrace();
  const proofForwarded = await d1AdvancedFilterMiddleware(
    testEnv(database, proofTrace),
  )("event-trend", prepared, async (value) => value);
  const proofDeferred =
    deferredEventTrendQualificationFromQuery(proofForwarded);
  if (!proofDeferred)
    throw new Error("wave94d_event_trend_proof_deferred_missing");
  const compileQuery: EventTrendQualificationQuery = {
    interval: scenario.interval,
    limit: scenario.limit,
    otherToken: SHARE_TREND_OTHER_TOKEN,
    otherLabel: SHARE_TREND_OTHER_LABEL,
    ...(scenario.eventName !== undefined
      ? { eventName: scenario.eventName }
      : {}),
  };
  const compilation = compileEventTrendQualificationProgram({
    deferred: proofDeferred,
    query: compileQuery,
  });
  let rawRows: readonly Record<string, unknown>[] = [];
  if (scenario.expectedFallback === "compile-budget") {
    expect(compilation.kind).toBe("unavailable");
    if (compilation.kind !== "unavailable")
      throw new Error("wave94d_event_trend_budget_not_refused");
    expect(compilation.fallbackReason.kind).toBe("compile-budget");
    expect(diagnostics.advancedCountSqlFallbackReason?.kind).toBe(
      "compile-budget",
    );
    expect(actualTrace.preparedSql.length).toBeGreaterThan(2);
  } else {
    expect(compilation.kind).toBe("compiled");
    if (compilation.kind !== "compiled")
      throw new Error("wave94d_event_trend_compilation_unavailable");
    expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);
    expect(compilation.evidence.groupedSummaryMaterialization).toBe(
      "materialized",
    );
    expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(
      D1_MAX_SQL_UTF8_BYTES,
    );
    expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(
      D1_MAX_BOUND_PARAMETERS,
    );
    if (scenario.expectedFallback === "numeric-data-domain") {
      expect(diagnostics.advancedCountSqlFallbackReason?.kind).toBe(
        "numeric-data-domain",
      );
      expect(actualTrace.preparedSql.length).toBeGreaterThan(2);
    } else {
      expect(actualTrace.preparedSql).toHaveLength(2);
    }
  }
  expect(oldTrace.preparedSql.length).toBeGreaterThan(2);
  if (
    compilation.kind === "compiled" &&
    scenario.expectedFallback !== "numeric-data-domain"
  )
    expect(actualTrace.preparedSql.at(-1)).toBe(compilation.evidence.sql);
  if (compilation.kind === "compiled") {
    rawRows = await queryD1CompiledAll(testEnv(database, newTrace()), {
      kind: "query",
      sql: compilation.evidence.sql,
      bindings: [...compilation.evidence.bindings],
      tag: compilation.evidence.statementTag,
    } as CompiledQuery<Record<string, unknown>>);
    const controlRows = rawRows.filter((row) => row.rowKind === "control");
    expect(controlRows).toHaveLength(1);
    expect(controlRows[0]!.entityKind).toBe(scenario.scope);
    expect(controlRows[0]!.rawCount).toBeGreaterThanOrEqual(0);
    expect(controlRows[0]!.rawCount).toBeLessThanOrEqual(20_000);
  }
  const ownerIdentifiers = ["wave94d-scoped-session", "wave94d-scoped-visitor"];
  expect(
    JSON.stringify(actualTrace.bindings).includes(ownerIdentifiers[0]!),
  ).toBe(false);
  expect(
    JSON.stringify(actualTrace.bindings).includes(ownerIdentifiers[1]!),
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
      dtoEqual,
      compilation:
        compilation.kind === "compiled"
          ? { kind: compilation.kind, evidence: compilation.evidence }
          : {
              kind: compilation.kind,
              fallbackReason: compilation.fallbackReason,
            },
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
  const evidencePath = process.env.WAVE94D_EVENT_TREND_EVIDENCE_PATH;
  if (evidencePath) {
    const absolutePath = resolve(evidencePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      JSON.stringify(
        { kind: "wave94d-event-trend-qualified-evidence-v1", evidenceBatches },
        null,
        2,
      ),
      "utf8",
    );
  }
});

describe("Wave94D qualified Event trend", () => {
  it("verifies prepared event-name compatibility for raw whitespace labels and parameters", async () => {
    const database = createFixture({
      includePreparedNameCompatibilityRows: true,
    });
    const cases = [
      { label: "all-space-label-same-parameter", eventName: "   " },
      { label: "padded-label-same-parameter", eventName: " alpha " },
      { label: "padded-label-trimmed-parameter", eventName: "alpha" },
      { label: "empty-parameter-no-gate-control", eventName: "" },
      { label: "ordinary-name-control", eventName: "beta" },
    ] as const;
    const results = [];
    for (const scope of ["session", "visitor"] as const) {
      for (const item of cases) {
        results.push(
          await runScenario(
            database,
            {
              label: `${scope}-${item.label}`,
              scope,
              limit: 20,
              interval: "day",
              eventName: item.eventName,
            },
            { assertDtoEqual: false },
          ),
        );
      }
    }
    writeEvidence({
      kind: "wave94g-event-trend-prepared-name-differential-v1",
      comparison: "old-complete-prepare-chain-vs-qualified-provider",
      cases: results,
    });
    expect(
      results
        .filter((result) => !result.qualified.dtoEqual)
        .map((result) => ({
          label: result.scenario.label,
          baseline: result.baseline.dto,
          qualified: result.qualified.dto,
        })),
    ).toEqual([]);
  }, 30_000);

  it.each(["session", "visitor"] as const)(
    "matches the full legacy DTO for %s Count qualification",
    async (scope) => {
      const database = createFixture();
      const result = await runScenario(database, {
        label: `${scope}-top-three`,
        scope,
        limit: 3,
        interval: "day",
      });
      if (result.qualified.compilation.kind !== "compiled")
        throw new Error("wave94d_event_trend_normal_compile_missing");
      expect(
        (
          result.qualified.dto as {
            readonly series: readonly { readonly eventName: string }[];
          }
        ).series.map((series) => series.eventName),
      ).toEqual(["alpha", "beta", "gamma", SHARE_TREND_OTHER_LABEL]);
      expect(result.qualified.compilation.evidence.physicalScanKinds).toContain(
        "custom_events",
      );
      writeEvidence({
        kind: "wave94d-event-trend-qualified-differential-v1",
        scenarios: [result],
      });
    },
  );

  it("preserves zero limit, bucket gaps, raw names, Other, and public key collisions", async () => {
    const database = createFixture();
    const scenarios: TrendScenario[] = [
      {
        label: "zero-limit-all-events-become-other",
        scope: "session",
        limit: 0,
        interval: "day",
      },
      {
        label: "other-and-token-key-collision",
        scope: "visitor",
        limit: 5,
        interval: "hour",
      },
      {
        label: "selected-other-token-membership-collision",
        scope: "visitor",
        limit: 7,
        interval: "hour",
      },
      {
        label: "legacy-truthy-raw-event-name",
        scope: "session",
        limit: 8,
        interval: "day",
        eventName: " ",
      },
      {
        label: "empty-qualified-owner-result",
        scope: "visitor",
        limit: 8,
        interval: "day",
        countPath: "/not-present",
      },
    ];
    const results = [];
    for (const scenario of scenarios)
      results.push(await runScenario(database, scenario));
    const zeroLimit = results[0]!.qualified.dto as {
      readonly series: readonly { readonly label: string }[];
      readonly data: readonly { readonly totalEvents: number }[];
    };
    expect(zeroLimit.series.map((series) => series.label)).toEqual([
      SHARE_TREND_OTHER_LABEL,
    ]);
    expect(zeroLimit.data.some((point) => point.totalEvents === 0)).toBe(true);
    const collisions = results[1]!.qualified.dto as {
      readonly series: readonly { readonly key: string }[];
      readonly data: readonly {
        readonly eventsBySeries: Record<string, number>;
      }[];
    };
    expect(
      collisions.series.filter(
        (series) => series.key === SHARE_TREND_OTHER_KEY,
      ),
    ).toHaveLength(2);
    expect(
      collisions.data.some((point) => point.eventsBySeries.other !== undefined),
    ).toBe(true);
    const tokenCollision = results[2]!.qualified.dto as {
      readonly series: readonly { readonly eventName: string }[];
      readonly data: readonly {
        readonly eventsBySeries: Record<string, number>;
      }[];
    };
    expect(
      tokenCollision.series.some(
        (series) => series.eventName === SHARE_TREND_OTHER_TOKEN,
      ),
    ).toBe(true);
    expect(
      tokenCollision.data.some(
        (point) => point.eventsBySeries[SHARE_TREND_OTHER_KEY] !== undefined,
      ),
    ).toBe(true);
    const rawName = results[3]!.qualified.dto as {
      readonly series: readonly unknown[];
      readonly data: readonly { readonly totalEvents: number }[];
    };
    expect(rawName.series).toEqual([]);
    expect(rawName.data.every((point) => point.totalEvents === 0)).toBe(true);
    const empty = results[4]!.qualified.dto as {
      readonly series: readonly unknown[];
      readonly data: readonly { readonly totalEvents: number }[];
    };
    expect(empty.series).toEqual([]);
    expect(empty.data.every((point) => point.totalEvents === 0)).toBe(true);
    writeEvidence({
      kind: "wave94d-event-trend-qualified-differential-v1",
      scenarios: results,
      nullableEventNameEvidence: {
        eventNamesSchema:
          "docs/schema.sql: custom_event_names.name TEXT NOT NULL",
        eventNameIdSchema:
          "docs/schema.sql: custom_events.event_name_id INTEGER NOT NULL with a foreign key to custom_event_names(id)",
        fixtureRelaxesSchema: false,
        behavior:
          "qualified decoder preserves nullable private eventName; deployed joined name rows cannot contain NULL under the existing DDL",
      },
    });
  }, 15_000);

  it("keeps aborts and database failures observable", async () => {
    const database = createFixture();
    const prepared = prepareTrendQuery({
      scope: "session",
      limit: 5,
      interval: "day",
    });
    const trace = newTrace();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE_ID,
    }).resolve("event-trend");
    if (!provider) throw new Error("wave94d_event_trend_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.execute(prepared as never, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(trace.preparedSql).toHaveLength(0);

    const brokenEnv = {
      DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              throw new Error("wave94d-database-read-failed");
            },
          }),
        }),
      },
      MAIN_SECRET: "wave94d-event-trend-qualified-test-secret",
    } as unknown as Env;
    const brokenProvider = createD1SiteProviderRegistry({
      env: brokenEnv,
      siteId: SITE_ID,
    }).resolve("event-trend");
    if (!brokenProvider)
      throw new Error("wave94d_event_trend_provider_missing");
    await expect(brokenProvider.execute(prepared as never)).rejects.toThrow(
      "wave94d-database-read-failed",
    );
  });

  it("falls back as a whole report for numeric compatibility and compile refusal", async () => {
    const numericDatabase = createFixture();
    numericDatabase
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-wave94d-scoped");
    const numeric = await runScenario(numericDatabase, {
      label: "numeric-compatibility-fallback",
      scope: "session",
      limit: 5,
      interval: "day",
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
      interval: "day",
      countDsl: `count(page { ${terms} }) eq 1`,
      expectedFallback: "compile-budget",
    });
    writeEvidence({
      kind: "wave94d-event-trend-qualified-fallbacks-v1",
      scenarios: [numeric, budget],
    });
  });
});
