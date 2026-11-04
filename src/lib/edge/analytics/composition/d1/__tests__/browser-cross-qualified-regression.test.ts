import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type { QueryInput, QueryTime } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  d1AdvancedFilterMiddleware,
  deferredCrossDimensionQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { BrowserCrossBreakdownDimensionDataRow } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryBrowserCrossBreakdownFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/browser";
import { compileCrossQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/technology/cross-qualification-program";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE = "wave96r-browser-cross";
const OTHER_SITE = "wave96r-browser-cross-other";
const BASE = Date.UTC(2026, 1, 1);
const TIME: QueryTime = createQueryTime(
  BASE,
  BASE + 3 * 60 * 60 * 1000,
  "UTC",
  BASE + 3 * 60 * 60 * 1000,
);
const WINDOW = {
  startMs: TIME.range.startMs,
  endExclusiveMs: TIME.range.endExclusiveMs,
  nowMs: TIME.capturedAtMs,
  timeZone: TIME.reportingTimeZone,
};
const FILTER_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();
const EVIDENCE_PHASE = process.env.INSIGHTFLARE_QUERY_EVIDENCE_PHASE?.trim();

type Scope = "session" | "visitor";
type BrowserCrossRequest = QueryInput & {
  readonly time: QueryTime;
  readonly variant: "browser";
  readonly browserLimit?: number | null;
  readonly osLimit?: number | null;
  readonly deviceTypeLimit?: number | null;
};

interface SeedPage {
  readonly id: string;
  readonly visitor: string;
  readonly session: string;
  readonly startedAt: number;
  readonly pathname: string;
  readonly browser: string;
  readonly os: string;
  readonly deviceType: string;
  readonly event: boolean;
  readonly siteId?: string;
  readonly sitePk?: number;
}

let database: DatabaseSync;
let sitePk: number;
let otherSitePk: number;

function trace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function envFor(db: DatabaseSync, queryTrace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(db, queryTrace) } as unknown as Env;
}

function envWithRowTransform(
  db: DatabaseSync,
  queryTrace: SqliteD1Trace,
  transformRows: (
    sql: string,
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[],
): Env {
  const base = envFor(db, queryTrace);
  return {
    DB: {
      prepare(sql: string) {
        const prepared = base.DB.prepare(sql);
        return {
          bind(...values: Parameters<typeof prepared.bind>) {
            const bound = prepared.bind(...values);
            return {
              async all<Row>() {
                const result = await bound.all<Row>();
                const rows = result.results as unknown as Record<
                  string,
                  unknown
                >[];
                return {
                  ...result,
                  results: transformRows(sql, rows) as unknown as Row[],
                };
              },
              async first<Row>() {
                return bound.first<Row>();
              },
              async run() {
                return bound.run();
              },
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
      batch: base.DB.batch.bind(base.DB),
    },
  } as unknown as Env;
}

function seedPage(page: SeedPage): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, browser, os,
        device_type, referrer_host, country
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'cross.test', ?, ?, ?, 'direct.test', 'US')`,
    )
    .run(
      page.id,
      page.siteId ?? SITE,
      page.sitePk ?? sitePk,
      page.visitor,
      page.session,
      page.startedAt,
      page.startedAt + 10,
      page.pathname,
      page.browser,
      page.os,
      page.deviceType,
    );
  if (!page.event) return;
  database
    .prepare(
      `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, 'qualifier', ?, ?)`,
    )
    .run(page.siteId ?? SITE, page.startedAt, page.sitePk ?? sitePk);
  const eventName = database
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(page.sitePk ?? sitePk, "qualifier") as { readonly id: number };
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run(
      `qualifier-${page.id}`,
      page.siteId ?? SITE,
      page.sitePk ?? sitePk,
      page.id,
      eventName.id,
      page.startedAt,
      page.startedAt,
    );
}

function browserQuery(
  scope: Scope,
  limits: {
    readonly browserLimit?: number | null;
    readonly osLimit?: number | null;
    readonly deviceTypeLimit?: number | null;
  } = {},
  filterDsl: string | null = FILTER_DSL,
): BrowserCrossRequest {
  const filters =
    filterDsl === null
      ? EMPTY_FILTER_DOCUMENT
      : parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("cross-dimension", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time: TIME,
    variant: "browser",
    ...limits,
  } as BrowserCrossRequest;
}

async function forwardBrowserCandidate(query: BrowserCrossRequest) {
  const candidateTrace = trace();
  const forwarded = await d1AdvancedFilterMiddleware(
    envFor(database, candidateTrace),
    undefined,
    SITE,
  )("cross-dimension", query as never, async (next) => next);
  const deferred = deferredCrossDimensionQualificationFromQuery(forwarded);
  if (!deferred)
    throw new Error("browser_cross_qualification_candidate_missing");
  return { deferred, forwarded, candidateTrace };
}

async function executeBrowser(
  query: BrowserCrossRequest,
  queryTrace: SqliteD1Trace,
  env = envFor(database, queryTrace),
  diagnostics?: ReturnType<typeof createD1ReadDiagnostics>,
) {
  const registry = createD1SiteProviderRegistry({
    env,
    siteId: SITE,
    ...(diagnostics ? { diagnostics } : {}),
  });
  const provider = registry.resolve("cross-dimension");
  if (!provider) throw new Error("browser_cross_provider_missing");
  return provider.execute(query as never);
}

function writeEvidence(filename: string, contents: unknown): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIRECTORY, filename),
    `${JSON.stringify(contents, null, 2)}\n`,
    "utf8",
  );
}

function emptyMatrix(): BrowserCrossBreakdownDimensionDataRow {
  return { columns: [], rows: [], totalVisitors: 0 };
}

describe("Browser Cross qualified regression", () => {
  beforeAll(() => {
    database = createMigratedDatabase();
    database.exec("PRAGMA foreign_keys = OFF");
    for (const id of [SITE, OTHER_SITE])
      database
        .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
        .run(id);
    sitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(SITE) as { readonly site_pk: number }
      ).site_pk,
    );
    otherSitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get(OTHER_SITE) as { readonly site_pk: number }
      ).site_pk,
    );
    database
      .prepare(
        `INSERT INTO sites (id, team_id, name, domain, created_at)
         VALUES (?, 'wave96r-team', 'Browser Cross', 'cross.test', 0)`,
      )
      .run(SITE);
    database
      .prepare(
        `INSERT INTO sites (id, team_id, name, domain, created_at)
         VALUES (?, 'wave96r-team', 'Other Browser Cross', 'other.test', 0)`,
      )
      .run(OTHER_SITE);

    const fixture: SeedPage[] = [
      {
        id: "chrome-win-1",
        visitor: "shared",
        session: "s1",
        pathname: "/one",
        browser: "Chrome",
        os: "Windows",
        deviceType: "desktop",
        startedAt: BASE + 1_000,
        event: true,
      },
      {
        id: "chrome-linux-1",
        visitor: "shared",
        session: "s1",
        pathname: "/two",
        browser: "Chrome",
        os: "Linux",
        deviceType: "mobile",
        startedAt: BASE + 2_000,
        event: true,
      },
      {
        id: "chrome-win-2",
        visitor: "visitor-b",
        session: "s2",
        pathname: "/three",
        browser: "Chrome",
        os: "Windows",
        deviceType: "desktop",
        startedAt: BASE + 3_000,
        event: true,
      },
      {
        id: "firefox-mac",
        visitor: "shared",
        session: "s3",
        pathname: "/four",
        browser: "Firefox",
        os: "macOS",
        deviceType: "tablet",
        startedAt: BASE + 4_000,
        event: true,
      },
      {
        id: "safari-ios",
        visitor: "visitor-c",
        session: "s4",
        pathname: "/five",
        browser: "Safari",
        os: "iOS",
        deviceType: "mobile",
        startedAt: BASE + 5_000,
        event: true,
      },
      {
        id: "edge-chromeos",
        visitor: "visitor-d",
        session: "s5",
        pathname: "/six",
        browser: "Edge",
        os: "ChromeOS",
        deviceType: "desktop",
        startedAt: BASE + 6_000,
        event: true,
      },
      {
        id: "nbsp-chrome",
        visitor: "visitor-e",
        session: "s6",
        pathname: "/seven",
        browser: "\u00a0Chrome\u00a0",
        os: "Windows",
        deviceType: "desktop",
        startedAt: BASE + 7_000,
        event: true,
      },
      {
        id: "empty-identity",
        visitor: "",
        session: "",
        pathname: "/eight",
        browser: "Vivaldi",
        os: "UnknownOS",
        deviceType: "unknown-device",
        startedAt: BASE + 8_000,
        event: true,
      },
      {
        id: "without-event",
        visitor: "visitor-no-event",
        session: "s-no-event",
        pathname: "/nine",
        browser: "Brave",
        os: "Windows",
        deviceType: "desktop",
        startedAt: BASE + 9_000,
        event: false,
      },
      {
        id: "excluded-path",
        visitor: "visitor-excluded",
        session: "s-excluded",
        pathname: "/excluded",
        browser: "Chrome",
        os: "Windows",
        deviceType: "desktop",
        startedAt: BASE + 10_000,
        event: true,
      },
      {
        id: "outside-window",
        visitor: "visitor-outside",
        session: "s-outside",
        pathname: "/outside",
        browser: "Opera",
        os: "Linux",
        deviceType: "mobile",
        startedAt: BASE + 4 * 60 * 60 * 1000,
        event: true,
      },
      {
        id: "other-site-row",
        visitor: "visitor-other",
        session: "s-other",
        pathname: "/other",
        browser: "OtherBrowser",
        os: "OtherOS",
        deviceType: "other-device",
        startedAt: BASE + 11_000,
        event: true,
        siteId: OTHER_SITE,
        sitePk: otherSitePk,
      },
    ];
    fixture.forEach(seedPage);
  });

  afterAll(() => database.close());

  it("keeps ordinary browser requests on the legacy two-matrix route", async () => {
    const limits = { browserLimit: 2, osLimit: 1, deviceTypeLimit: 2 };
    const query = browserQuery("session", limits, null);
    const middlewareTrace = trace();
    const forwarded = await d1AdvancedFilterMiddleware(
      envFor(database, middlewareTrace),
      undefined,
      SITE,
    )("cross-dimension", query as never, async (next) => next);
    expect(
      deferredCrossDimensionQualificationFromQuery(forwarded),
    ).toBeUndefined();

    const queryTrace = trace();
    const registry = createD1SiteProviderRegistry({
      env: envFor(database, queryTrace),
      siteId: SITE,
    });
    const provider = registry.resolve("cross-dimension");
    if (!provider) throw new Error("browser_cross_provider_missing");
    const result = await provider.execute(query as never);
    const value = result.value as {
      readonly operatingSystem: BrowserCrossBreakdownDimensionDataRow;
      readonly deviceType: BrowserCrossBreakdownDimensionDataRow;
    };
    expect(value.operatingSystem.rows.length).toBeGreaterThan(0);
    expect(value.deviceType.rows.length).toBeGreaterThan(0);
    expect(queryTrace.preparedSql).toHaveLength(2);
    expect(queryTrace.preparedSql[0]).toContain('AS "browser"');
    expect(queryTrace.preparedSql[1]).toContain('AS "dimension"');
    const phase = EVIDENCE_PHASE === "before" ? "before" : "after";
    writeEvidence(`browser-ordinary-unfiltered-${phase}.json`, {
      request: {
        siteId: SITE,
        scope: "session",
        time: TIME,
        filterDsl: null,
        limits,
      },
      sql: queryTrace.preparedSql,
      bindings: queryTrace.bindings,
      value,
      qualified: false,
    });
  });
  it("verifies empty six-output controls, rejects malformed rows, and falls back on numeric incompatibility", async () => {
    const limits = { browserLimit: 2, osLimit: 1, deviceTypeLimit: 2 };
    const emptyQuery = browserQuery(
      "session",
      limits,
      'page.path eq "/no-such-page" and count(event { event.name eq "qualifier" }) gte 1',
    );
    const emptyCandidate = await forwardBrowserCandidate(emptyQuery);
    const emptyCompilation = compileCrossQualificationProgram({
      deferred: emptyCandidate.deferred,
      query: emptyCandidate.forwarded,
      configuration: emptyCandidate.deferred.configuration,
    });
    expect(emptyCompilation.kind).toBe("compiled");
    if (emptyCompilation.kind !== "compiled") return;
    expect(emptyCompilation.evidence.family).toBe("browser");
    expect(emptyCompilation.evidence.outputDescriptors).toHaveLength(6);
    const rawEmptyRows = database
      .prepare(emptyCompilation.evidence.sql)
      .all(
        ...(emptyCompilation.evidence.bindings.map((value) =>
          typeof value === "boolean" ? (value ? 1 : 0) : value,
        ) as SQLInputValue[]),
      ) as Record<string, unknown>[];
    expect(rawEmptyRows).toHaveLength(1);
    expect(rawEmptyRows[0]?.rowKind).toBe("control");
    expect(rawEmptyRows[0]?.outputId).toBe(
      emptyCompilation.evidence.controlOutputId,
    );

    const emptyTrace = trace();
    const emptyResult = await executeBrowser(emptyQuery, emptyTrace);
    const emptyValue = emptyResult.value as {
      readonly operatingSystem: BrowserCrossBreakdownDimensionDataRow;
      readonly deviceType: BrowserCrossBreakdownDimensionDataRow;
    };
    expect(emptyValue.operatingSystem).toEqual(emptyMatrix());
    expect(emptyValue.deviceType).toEqual(emptyMatrix());
    expect(emptyTrace.preparedSql).toHaveLength(2);
    expect(emptyTrace.preparedSql[1]).toBe(emptyCompilation.evidence.sql);

    const validQuery = browserQuery("session", limits);
    const validCandidate = await forwardBrowserCandidate(validQuery);
    const validCompilation = compileCrossQualificationProgram({
      deferred: validCandidate.deferred,
      query: validCandidate.forwarded,
      configuration: validCandidate.deferred.configuration,
    });
    expect(validCompilation.kind).toBe("compiled");
    if (validCompilation.kind !== "compiled") return;
    const reportSql = validCompilation.evidence.sql;
    const malformedCases = [
      {
        name: "missing-control",
        expectedError: "cross_dimension_qualification_control_row_invalid",
        transform(rows: readonly Record<string, unknown>[]) {
          return rows.filter((row) => row.rowKind !== "control");
        },
      },
      {
        name: "output-id-mismatch",
        expectedError: "cross_dimension_qualification_report_row_invalid",
        transform(rows: readonly Record<string, unknown>[]) {
          let changed = false;
          return rows.map((row) => {
            if (changed || row.rowKind !== "report") return row;
            changed = true;
            return { ...row, outputId: "unexpected-browser-cross-output" };
          });
        },
      },
      {
        name: "row-type-mismatch",
        expectedError: "cross_dimension_qualification_report_row_invalid",
        transform(rows: readonly Record<string, unknown>[]) {
          let changed = false;
          return rows.map((row) => {
            if (changed || row.rowKind !== "report") return row;
            changed = true;
            return { ...row, rowType: "unexpected-browser-cross-row" };
          });
        },
      },
    ];
    const malformedEvidence: unknown[] = [];
    for (const malformed of malformedCases) {
      const malformedTrace = trace();
      const malformedEnv = envWithRowTransform(
        database,
        malformedTrace,
        (sql, rows) => (sql === reportSql ? malformed.transform(rows) : rows),
      );
      await expect(
        executeBrowser(validQuery, malformedTrace, malformedEnv),
      ).rejects.toThrow(malformed.expectedError);
      expect(malformedTrace.preparedSql).toHaveLength(2);
      expect(
        malformedTrace.preparedSql.filter((sql) => sql === reportSql),
      ).toHaveLength(1);
      malformedEvidence.push({
        name: malformed.name,
        sql: malformedTrace.preparedSql,
        reportAttempts: malformedTrace.preparedSql.filter(
          (sql) => sql === reportSql,
        ).length,
      });
    }

    const numericDsl =
      'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1';
    const numericQuery = browserQuery("session", limits, numericDsl);
    const numericCandidate = await forwardBrowserCandidate(numericQuery);
    const numericCompilation = compileCrossQualificationProgram({
      deferred: numericCandidate.deferred,
      query: numericCandidate.forwarded,
      configuration: numericCandidate.deferred.configuration,
    });
    expect(numericCompilation.kind).toBe("compiled");
    if (numericCompilation.kind !== "compiled") return;
    const durationBefore = database
      .prepare("SELECT duration_ms FROM visits WHERE visit_id = ?")
      .get("chrome-win-1") as { readonly duration_ms: number | string | null };
    try {
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "chrome-win-1");
      const diagnostics = createD1ReadDiagnostics();
      const numericTrace = trace();
      const numericResult = await executeBrowser(
        numericQuery,
        numericTrace,
        envFor(database, numericTrace),
        diagnostics,
      );
      const fallbackFilters = await prepareDeferredEventQualificationFallback(
        numericCandidate.deferred.qualification,
      );
      const oracleTrace = trace();
      const oracle = await queryBrowserCrossBreakdownFromD1(
        envFor(database, oracleTrace),
        SITE,
        WINDOW,
        fallbackFilters,
        numericQuery.browserLimit ?? 8,
        numericQuery.osLimit ?? 8,
        numericQuery.deviceTypeLimit ?? 8,
      );
      expect(numericResult.value).toEqual(oracle);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
        fieldIds: ["page.durationMs"],
      });
      expect(
        numericTrace.preparedSql.filter(
          (sql) => sql === numericCompilation.evidence.sql,
        ),
      ).toHaveLength(1);
      expect(numericTrace.preparedSql.slice(-2)).toEqual(
        oracleTrace.preparedSql,
      );
      expect(numericTrace.bindings.slice(-2)).toEqual(oracleTrace.bindings);
      expect(oracleTrace.preparedSql).toHaveLength(2);
      writeEvidence("browser-six-output-contract.json", {
        empty: {
          reportSql: emptyCompilation.evidence.sql,
          reportBindings: emptyCompilation.evidence.bindings,
          rawRows: rawEmptyRows,
          dto: emptyValue,
          controlOutputId: emptyCompilation.evidence.controlOutputId,
          outputDescriptorCount:
            emptyCompilation.evidence.outputDescriptors.length,
        },
        malformed: malformedEvidence,
        numericFallback: {
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
          compiledSql: numericCompilation.evidence.sql,
          actualSql: numericTrace.preparedSql,
          fallbackSql: numericTrace.preparedSql.slice(-2),
          actualBindings: numericTrace.bindings,
          fallbackBindings: numericTrace.bindings.slice(-2),
          actual: numericResult.value,
          expected: oracle,
        },
      });
    } finally {
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run(durationBefore.duration_ms, "chrome-win-1");
    }
  });
  it("97DQ: qualifies mixed NOT Browser Cross filters for both matrices", async () => {
    const filterDsl =
      'not (page.path eq "/nine" and count(event { event.name eq "qualifier" }) gte 1)';
    const query = browserQuery("session", {}, filterDsl);
    const { deferred, forwarded } = await forwardBrowserCandidate(query);
    expect(deferred.qualification.technologyFilterMode).toBe(
      "allow-whole-filter",
    );
    expect(
      deferred.qualification.metadata.plan.advancedMatches,
    ).toBeUndefined();
    const compilation = compileCrossQualificationProgram({
      deferred,
      query: forwarded,
      configuration: deferred.configuration,
    });
    expect(compilation.kind).toBe("compiled");
    if (compilation.kind !== "compiled") return;
    expect(compilation.evidence.outputDescriptors).toHaveLength(6);
    expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
    expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);

    const actualTrace = trace();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await executeBrowser(
      query,
      actualTrace,
      envFor(database, actualTrace),
      diagnostics,
    );
    const fallbackFilters = await prepareDeferredEventQualificationFallback(
      deferred.qualification,
    );
    const oracleTrace = trace();
    const oracle = await queryBrowserCrossBreakdownFromD1(
      envFor(database, oracleTrace),
      SITE,
      WINDOW,
      fallbackFilters,
      query.browserLimit ?? 8,
      query.osLimit ?? 8,
      query.deviceTypeLimit ?? 8,
    );

    const andCandidate = await forwardBrowserCandidate(browserQuery("session"));
    const andFilters = await prepareDeferredEventQualificationFallback(
      andCandidate.deferred.qualification,
    );
    const andBaseline = await queryBrowserCrossBreakdownFromD1(
      envFor(database, trace()),
      SITE,
      WINDOW,
      andFilters,
      query.browserLimit ?? 8,
      query.osLimit ?? 8,
      query.deviceTypeLimit ?? 8,
    );
    expect(actual.value).toEqual(oracle);
    expect(actual.value).not.toEqual(andBaseline);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(actualTrace.preparedSql).toHaveLength(2);
    expect(actualTrace.preparedSql).toContain(compilation.evidence.sql);
    writeEvidence("97dq-browser-cross-mixed-not.json", {
      operation: "cross-dimension",
      variant: "browser",
      scope: "session",
      filterDsl,
      mode: deferred.qualification.technologyFilterMode,
      countScope: deferred.qualification.metadata.plan.scope,
      advancedMatches: deferred.qualification.metadata.plan.advancedMatches,
      siteMetadataCount: deferred.qualification.metadata.siteIds.length,
      compilation: {
        statementTag: compilation.evidence.statementTag,
        sql: compilation.evidence.sql,
        sqlUtf8Bytes: new TextEncoder().encode(compilation.evidence.sql)
          .byteLength,
        bindings: compilation.evidence.bindings,
        bindingCount: compilation.evidence.bindingCount,
        groupWidth: compilation.evidence.groupWidth,
        sharedRelationCount: compilation.evidence.sharedRelationCount,
        physicalPlanShape: compilation.evidence.physicalPlanShape,
        reportSourceRelations: compilation.evidence.reportSourceRelations,
        controlOutputId: compilation.evidence.controlOutputId,
        controlFields: compilation.evidence.controlFields,
        outputDescriptors: compilation.evidence.outputDescriptors,
        ordering: compilation.evidence.ordering,
      },
      runtime: {
        preparedSql: actualTrace.preparedSql,
        bindings: actualTrace.bindings,
        statementCount: actualTrace.preparedSql.length,
        actual: actual.value,
        legacyPreparedSql: oracleTrace.preparedSql,
        legacyBindings: oracleTrace.bindings,
        legacy: oracle,
        andBaseline,
        fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      },
    });
  });

  it("runs one shared Page and Count qualification for both Browser Cross matrices", async () => {
    const evidence: unknown[] = [];
    const reverseState = database
      .prepare("PRAGMA reverse_unordered_selects")
      .get() as { readonly reverse_unordered_selects: number };
    const reverseInitiallyEnabled =
      reverseState.reverse_unordered_selects === 1;
    let reverseRestoredValue: number | undefined;
    try {
      for (const scope of ["session", "visitor"] as const) {
        for (const reverseUnordered of [false, true]) {
          database.exec(
            `PRAGMA reverse_unordered_selects = ${reverseUnordered ? "ON" : "OFF"}`,
          );
          const limits = { browserLimit: 2, osLimit: 1, deviceTypeLimit: 2 };
          const query = browserQuery(scope, limits);
          const { deferred, forwarded } = await forwardBrowserCandidate(query);
          const compilation = compileCrossQualificationProgram({
            deferred,
            query: forwarded,
            configuration: deferred.configuration,
          });
          expect(compilation.kind).toBe("compiled");
          if (compilation.kind !== "compiled") continue;
          expect(compilation.evidence.family).toBe("browser");
          expect(compilation.evidence.outputDescriptors).toHaveLength(6);
          expect(compilation.evidence.reportSourceRelations).toHaveLength(1);
          expect(compilation.evidence.reportSourceRelations[0]?.entity).toBe(
            "page",
          );
          expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
          expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
          expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);

          const queryTrace = trace();
          const result = await executeBrowser(query, queryTrace);
          const value = result.value as {
            readonly operatingSystem: BrowserCrossBreakdownDimensionDataRow;
            readonly deviceType: BrowserCrossBreakdownDimensionDataRow;
          };
          const fallbackFilters =
            await prepareDeferredEventQualificationFallback(
              deferred.qualification,
            );
          const oracleTrace = trace();
          const oracle = await queryBrowserCrossBreakdownFromD1(
            envFor(database, oracleTrace),
            SITE,
            WINDOW,
            fallbackFilters,
            limits.browserLimit,
            limits.osLimit,
            limits.deviceTypeLimit,
          );
          expect(value).toEqual(oracle);
          expect(queryTrace.preparedSql).toHaveLength(2);
          expect(queryTrace.preparedSql[1]).toBe(compilation.evidence.sql);
          expect(queryTrace.bindings[1]).toEqual(compilation.evidence.bindings);
          expect(oracleTrace.preparedSql).toHaveLength(2);
          expect(value.operatingSystem.columns.length).not.toBe(
            value.deviceType.columns.length,
          );
          evidence.push({
            scope,
            reverseUnordered,
            preparedSqlCount: queryTrace.preparedSql.length,
            reportSql: queryTrace.preparedSql[1],
            reportBindings: queryTrace.bindings[1],
            dto: value,
            legacyOracle: oracle,
            compilation: {
              sqlBytes: compilation.evidence.sqlBytes,
              bindingCount: compilation.evidence.bindingCount,
              groupWidth: compilation.evidence.groupWidth,
              sharedRelationCount: compilation.evidence.sharedRelationCount,
              outputDescriptors: compilation.evidence.outputDescriptors,
              controlOutputId: compilation.evidence.controlOutputId,
              controlFields: compilation.evidence.controlFields,
            },
          });
        }
      }
    } finally {
      database.exec(
        `PRAGMA reverse_unordered_selects = ${reverseInitiallyEnabled ? "ON" : "OFF"}`,
      );
      const restored = database
        .prepare("PRAGMA reverse_unordered_selects")
        .get() as { readonly reverse_unordered_selects: number };
      reverseRestoredValue = restored.reverse_unordered_selects;
      expect(restored.reverse_unordered_selects).toBe(
        reverseInitiallyEnabled ? 1 : 0,
      );
    }
    writeEvidence("browser-qualified-matrices.json", {
      reverseUnorderedInitiallyEnabled: reverseInitiallyEnabled,
      reverseUnorderedRestoredValue: reverseRestoredValue,
      reverseUnorderedRestored:
        reverseRestoredValue === (reverseInitiallyEnabled ? 1 : 0),
      cases: evidence,
    });
  });

  it("aborts before reads, rejects site mismatches, and does not retry report errors", async () => {
    const abortedTrace = trace();
    const abortedRegistry = createD1SiteProviderRegistry({
      env: envFor(database, abortedTrace),
      siteId: SITE,
    });
    const abortedProvider = abortedRegistry.resolve("cross-dimension");
    if (!abortedProvider) throw new Error("browser_cross_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortedProvider.execute(browserQuery("session") as never, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedTrace.preparedSql).toHaveLength(0);

    const mismatchTrace = trace();
    const mismatchRegistry = createD1SiteProviderRegistry({
      env: envFor(database, mismatchTrace),
      siteId: OTHER_SITE,
    });
    const mismatchProvider = mismatchRegistry.resolve("cross-dimension");
    if (!mismatchProvider) throw new Error("browser_cross_provider_missing");
    await expect(
      mismatchProvider.execute(browserQuery("session") as never),
    ).rejects.toBeInstanceOf(Error);
    expect(mismatchTrace.preparedSql).toHaveLength(0);

    const failedTrace = trace();
    const baseEnv = envFor(database, failedTrace);
    let reportExecutionAttempts = 0;
    const failingDatabase = {
      prepare(sql: string) {
        const statement = baseEnv.DB.prepare(sql);
        if (!sql.startsWith("WITH _d1_shared_")) return statement;
        const failedStatement = {
          bind(...values: unknown[]) {
            (statement.bind as unknown as (...items: unknown[]) => unknown)(
              ...values,
            );
            return failedStatement;
          },
          async first() {
            reportExecutionAttempts += 1;
            throw new Error("forced_browser_report_failure");
          },
          async all() {
            reportExecutionAttempts += 1;
            throw new Error("forced_browser_report_failure");
          },
          async run() {
            reportExecutionAttempts += 1;
            throw new Error("forced_browser_report_failure");
          },
        };
        return failedStatement as unknown as ReturnType<
          typeof baseEnv.DB.prepare
        >;
      },
      batch: baseEnv.DB.batch.bind(baseEnv.DB),
    };
    const failingRegistry = createD1SiteProviderRegistry({
      env: { DB: failingDatabase } as unknown as Env,
      siteId: SITE,
    });
    const failingProvider = failingRegistry.resolve("cross-dimension");
    if (!failingProvider) throw new Error("browser_cross_provider_missing");
    await expect(
      failingProvider.execute(browserQuery("session") as never),
    ).rejects.toThrow("forced_browser_report_failure");
    expect(reportExecutionAttempts).toBe(1);
    expect(failedTrace.preparedSql).toHaveLength(2);
    writeEvidence("browser-boundaries.json", {
      abortedReads: abortedTrace.preparedSql.length,
      mismatchReads: mismatchTrace.preparedSql.length,
      reportPreparationCount: failedTrace.preparedSql.length,
      reportExecutionAttempts,
    });
  });
  it("preserves browser limit presence and excludes fractional limits from qualification", async () => {
    const { deferred, forwarded } = await forwardBrowserCandidate(
      browserQuery("session", {
        browserLimit: null,
        osLimit: null,
        deviceTypeLimit: 0,
      }),
    );
    expect(deferred.configuration).toMatchObject({
      family: "browser",
      variant: "browser",
      browserLimitPresent: true,
      browserLimit: null,
      osLimitPresent: true,
      osLimit: null,
      deviceTypeLimitPresent: true,
      deviceTypeLimit: 0,
    });
    const compilation = compileCrossQualificationProgram({
      deferred,
      query: forwarded,
      configuration: deferred.configuration,
    });
    expect(compilation.kind).toBe("compiled");

    const fractional = browserQuery("session", { browserLimit: 1.5 });
    const candidateTrace = trace();
    const forwardedFractional = await d1AdvancedFilterMiddleware(
      envFor(database, candidateTrace),
      undefined,
      SITE,
    )("cross-dimension", fractional as never, async (next) => next);
    expect(
      deferredCrossDimensionQualificationFromQuery(forwardedFractional),
    ).toBeUndefined();
    writeEvidence("browser-limit-admission.json", {
      nullAndZeroPreserved: true,
      fractionalQualified: false,
    });
  });
});
