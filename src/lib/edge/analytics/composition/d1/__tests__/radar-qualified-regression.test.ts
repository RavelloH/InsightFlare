import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
} from "@/lib/db";
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
  attachScopedFilterMetadata,
  createQueryTime,
  createScopedFilterPlan,
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  BROWSER_VERSION_BREAKDOWN_OUTPUT,
  buildBrowserVersionBreakdownPlan,
} from "@/lib/edge/analytics/engine/browser-version-breakdown-report-plan";
import type { TechnologyRadarDimension } from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import {
  buildTechnologyRadarPlan,
  TECHNOLOGY_RADAR_OUTPUTS,
} from "@/lib/edge/analytics/engine/technology-radar-report-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredRadarQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as advancedFilterExecution from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryBrowserVersionBreakdownFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/browser";
import {
  queryBrowserRadarFromD1,
  queryReferrerRadarFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/technology/radar";
import * as radarReaders from "@/lib/edge/analytics/providers/d1/internal/technology/radar";
import { compileRadarQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/technology/radar-qualification-program";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE = "wave96j-radar-native-shape";
const TIME: QueryTime = createQueryTime(
  Date.UTC(2026, 0, 1),
  Date.UTC(2026, 0, 2),
  "UTC",
  Date.UTC(2026, 0, 3),
);
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();
const FILTER_DSL =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
const REPORTING_SITE = "wave96j-radar-registry";
const REPORTING_BASE = Date.UTC(2026, 1, 1);
const REPORTING_TIME = createQueryTime(
  REPORTING_BASE,
  REPORTING_BASE + 3 * 60 * 60 * 1000,
  "UTC",
  REPORTING_BASE + 3 * 60 * 60 * 1000,
);

type ReportingScope = "session" | "visitor" | "event";
type RadarQuery = CanonicalQuery<"radar"> & {
  readonly browserLimit?: number;
  readonly versionLimit?: number;
};

interface SeedRadarPage {
  readonly id: string;
  readonly visitor: string;
  readonly session: string;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly pathname: string;
  readonly browser: string;
  readonly browserVersion?: string;
  readonly referrerHost: string;
}

let reportingDatabase: DatabaseSync;
let reportingSitePk: number;

function reportingTrace(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function reportingEnv(database: DatabaseSync, queryTrace: SqliteD1Trace): Env {
  return { DB: createSqliteD1Database(database, queryTrace) } as unknown as Env;
}

interface ReportingEnvHooks {
  readonly beforeAll?: (sql: string) => void;
  readonly afterAll?: (sql: string) => void;
  readonly transformRows?: (
    sql: string,
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[];
}

function reportingEnvWithHooks(
  database: DatabaseSync,
  queryTrace: SqliteD1Trace,
  hooks: ReportingEnvHooks,
): Env {
  const base = createSqliteD1Database(database, queryTrace);
  return {
    DB: {
      prepare(sql: string) {
        const prepared = base.prepare(sql);
        return {
          bind(...values: Parameters<typeof prepared.bind>) {
            const bound = prepared.bind(...values);
            return {
              async all<Row>() {
                hooks.beforeAll?.(sql);
                const result = await bound.all<Row>();
                hooks.afterAll?.(sql);
                const rows = result.results as unknown as Record<
                  string,
                  unknown
                >[];
                const transformed = hooks.transformRows?.(sql, rows);
                return {
                  ...result,
                  results: (transformed ?? rows) as unknown as Row[],
                };
              },
              async first<Row>() {
                hooks.beforeAll?.(sql);
                const result = await bound.first<Row>();
                hooks.afterAll?.(sql);
                return result;
              },
              async run() {
                return bound.run();
              },
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
      batch: (statements: D1PreparedStatement[]) => base.batch(statements),
    },
  } as unknown as Env;
}

function seedRadarPage(input: SeedRadarPage): void {
  reportingDatabase
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, browser,
        browser_version, language, screen_width, screen_height,
        referrer_host, utm_source, utm_medium
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'radar.test', ?, ?, 'en', 100, 100, ?, '', '')`,
    )
    .run(
      input.id,
      REPORTING_SITE,
      reportingSitePk,
      input.visitor,
      input.session,
      input.startedAt,
      input.lastActivityAt,
      input.pathname,
      input.browser,
      input.browserVersion ?? "1",
      input.referrerHost,
    );
  reportingDatabase
    .prepare(
      `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, 'qualifier', ?, ?)`,
    )
    .run(REPORTING_SITE, input.startedAt, reportingSitePk);
  const eventName = reportingDatabase
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(reportingSitePk, "qualifier") as { readonly id: number };
  reportingDatabase
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run(
      `qualifier-${input.id}`,
      REPORTING_SITE,
      reportingSitePk,
      input.id,
      eventName.id,
      input.startedAt,
      input.startedAt,
    );
}

function seedRadarNamedEvent(visitId: string, name: string): void {
  const visit = reportingDatabase
    .prepare(
      "SELECT site_id, site_pk, started_at FROM visits WHERE visit_id = ?",
    )
    .get(visitId) as {
    readonly site_id: string;
    readonly site_pk: number;
    readonly started_at: number;
  };
  reportingDatabase
    .prepare(
      `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, ?, ?)`,
    )
    .run(visit.site_id, name, visit.started_at, visit.site_pk);
  const eventName = reportingDatabase
    .prepare("SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?")
    .get(visit.site_pk, name) as { readonly id: number };
  reportingDatabase
    .prepare(
      `INSERT OR REPLACE INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
    )
    .run(
      `${name}-${visitId}`,
      visit.site_id,
      visit.site_pk,
      visitId,
      eventName.id,
      visit.started_at,
      visit.started_at,
    );
}

function deleteRadarNamedEvent(visitId: string, name: string): void {
  reportingDatabase
    .prepare(
      `DELETE FROM custom_events
       WHERE visit_id = ? AND event_name_id = (
         SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?
       )`,
    )
    .run(visitId, reportingSitePk, name);
}

const BROWSER_VERSION_EXTRA_PAGES: readonly SeedRadarPage[] = [
  {
    id: "browser-version-120-page-one",
    visitor: "browser-version-120",
    session: "browser-version-120-session",
    startedAt: REPORTING_BASE + 200,
    lastActivityAt: REPORTING_BASE + 210,
    pathname: "/version-120-one",
    browser: "Chrome",
    browserVersion: "120.4",
    referrerHost: "versions.example",
  },
  {
    id: "browser-version-120-page-two",
    visitor: "browser-version-120",
    session: "browser-version-120-session",
    startedAt: REPORTING_BASE + 220,
    lastActivityAt: REPORTING_BASE + 230,
    pathname: "/version-120-two",
    browser: "Chrome",
    browserVersion: "120.9",
    referrerHost: "versions.example",
  },
  {
    id: "browser-version-121-page",
    visitor: "browser-version-121",
    session: "browser-version-121-session",
    startedAt: REPORTING_BASE + 240,
    lastActivityAt: REPORTING_BASE + 250,
    pathname: "/version-121",
    browser: "Chrome",
    browserVersion: "121.4",
    referrerHost: "versions.example",
  },
  {
    id: "browser-version-unknown-page",
    visitor: "browser-version-unknown",
    session: "browser-version-unknown-session",
    startedAt: REPORTING_BASE + 260,
    lastActivityAt: REPORTING_BASE + 270,
    pathname: "/version-unknown",
    browser: "Chrome",
    browserVersion: "unknown",
    referrerHost: "versions.example",
  },
  {
    id: "browser-version-other-page",
    visitor: "browser-version-other",
    session: "browser-version-other-session",
    startedAt: REPORTING_BASE + 280,
    lastActivityAt: REPORTING_BASE + 290,
    pathname: "/version-other",
    browser: "Chrome",
    browserVersion: "other",
    referrerHost: "versions.example",
  },
  {
    id: "browser-version-unknown-token-page",
    visitor: "browser-version-unknown-token",
    session: "browser-version-unknown-token-session",
    startedAt: REPORTING_BASE + 300,
    lastActivityAt: REPORTING_BASE + 310,
    pathname: "/version-unknown-token",
    browser: "Chrome",
    browserVersion: "__browser_version_unknown__",
    referrerHost: "versions.example",
  },
];

async function withBrowserVersionExtraPages<T>(
  run: () => Promise<T>,
): Promise<T> {
  try {
    for (const page of BROWSER_VERSION_EXTRA_PAGES) seedRadarPage(page);
    return await run();
  } finally {
    const deleteEvents = reportingDatabase.prepare(
      "DELETE FROM custom_events WHERE visit_id = ?",
    );
    const deleteVisits = reportingDatabase.prepare(
      "DELETE FROM visits WHERE visit_id = ?",
    );
    for (const page of BROWSER_VERSION_EXTRA_PAGES) {
      deleteEvents.run(page.id);
      deleteVisits.run(page.id);
    }
  }
}

function seedReportingFixture(): DatabaseSync {
  reportingDatabase = createMigratedDatabase();
  reportingDatabase.exec("PRAGMA foreign_keys = OFF");
  reportingDatabase
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(REPORTING_SITE);
  reportingSitePk = Number(
    (
      reportingDatabase
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(REPORTING_SITE) as { readonly site_pk: number }
    ).site_pk,
  );
  reportingDatabase
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave96j-team', 'Radar qualification', 'radar.test', 0)`,
    )
    .run(REPORTING_SITE);
  const pages: readonly SeedRadarPage[] = [
    {
      id: "alpha-first-page",
      visitor: "alpha",
      session: "alpha-session-one",
      startedAt: REPORTING_BASE + 10,
      lastActivityAt: REPORTING_BASE + 30,
      pathname: "/first",
      browser: " Chrome ",
      referrerHost: " news.example ",
    },
    {
      id: "alpha-second-page",
      visitor: "alpha",
      session: "alpha-session-one",
      startedAt: REPORTING_BASE + 20,
      lastActivityAt: REPORTING_BASE + 15,
      pathname: "/second",
      browser: "Chrome",
      referrerHost: "news.example",
    },
    {
      id: "alpha-return-session",
      visitor: "alpha",
      session: "alpha-session-two",
      startedAt: REPORTING_BASE + 60,
      lastActivityAt: REPORTING_BASE + 60,
      pathname: "/third",
      browser: "Firefox",
      referrerHost: "docs.example",
    },
    {
      id: "beta-session",
      visitor: "beta",
      session: "beta-session-one",
      startedAt: REPORTING_BASE + 70,
      lastActivityAt: REPORTING_BASE + 90,
      pathname: "/fourth",
      browser: "Chrome",
      referrerHost: "docs.example",
    },
    {
      id: "gamma-session",
      visitor: "gamma",
      session: "gamma-session-one",
      startedAt: REPORTING_BASE + 80,
      lastActivityAt: REPORTING_BASE + 90,
      pathname: "/excluded",
      browser: "Safari",
      referrerHost: "mail.example",
    },
    {
      id: "empty-session",
      visitor: "empty-session-owner",
      session: "",
      startedAt: REPORTING_BASE + 100,
      lastActivityAt: REPORTING_BASE + 110,
      pathname: "/empty-session",
      browser: "Edge",
      referrerHost: "",
    },
    {
      id: "empty-visitor",
      visitor: "",
      session: "empty-visitor-session",
      startedAt: REPORTING_BASE + 120,
      lastActivityAt: REPORTING_BASE + 130,
      pathname: "/empty-visitor",
      browser: "Edge",
      referrerHost: "",
    },
    {
      id: "blank-browser",
      visitor: "blank-browser-owner",
      session: "blank-browser-session",
      startedAt: REPORTING_BASE + 140,
      lastActivityAt: REPORTING_BASE + 150,
      pathname: "/blank-browser",
      browser: "   ",
      referrerHost: "blank-browser.example",
    },
  ];
  for (const page of pages) seedRadarPage(page);
  return reportingDatabase;
}

function radarQuery(
  scope: ReportingScope,
  dimension: TechnologyRadarDimension,
  limit?: number,
  filterDsl = FILTER_DSL,
): RadarQuery {
  const filters = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("radar", {
    context: siteQueryContext(REPORTING_SITE, "private-dashboard"),
    time: REPORTING_TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time: REPORTING_TIME,
    ...(dimension === "referrer"
      ? {
          variant: "referrer" as const,
          ...(limit === undefined ? {} : { limit }),
        }
      : {}),
  } as unknown as RadarQuery;
}

function browserVersionQuery(
  scope: ReportingScope,
  input: {
    readonly browserLimit?: number;
    readonly versionLimit?: number;
    readonly filterDsl?: string;
  } = {},
): RadarQuery {
  const browser = radarQuery(
    scope,
    "browser",
    undefined,
    input.filterDsl ?? FILTER_DSL,
  );
  return {
    ...browser,
    variant: "version",
    ...(input.browserLimit === undefined
      ? {}
      : { browserLimit: input.browserLimit }),
    ...(input.versionLimit === undefined
      ? {}
      : { versionLimit: input.versionLimit }),
  } as unknown as RadarQuery;
}

function compileBrowserVersionNativeShape(query: RadarQuery) {
  const filters = query.filters;
  if (!filters) throw new Error("browser_version_filters_missing");
  const metadata = scopedFilterMetadata(filters);
  const plan = buildBrowserVersionBreakdownPlan({
    siteId: REPORTING_SITE,
    queryTime: REPORTING_TIME,
    filters,
    ...(metadata ? { scopePlan: metadata.plan } : {}),
    browserLimit: query.browserLimit ?? 0,
  });
  const output = plan.outputs.find(
    (candidate) => candidate.id === BROWSER_VERSION_BREAKDOWN_OUTPUT,
  );
  if (!output) throw new Error("browser_version_native_output_missing");
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: REPORTING_SITE,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map(({ name, slot }) => ({ name, slot })),
  );
  const compiled = compileD1Query(lowerLogicalPlan(relation), {
    tag: "analytics.technology_browser_version.native_shape",
  });
  const nodeKinds = plan.nodes.reduce<Record<string, number>>(
    (counts, node) => {
      counts[node.kind] = (counts[node.kind] ?? 0) + 1;
      return counts;
    },
    {},
  );
  return {
    scope: query.scopePlan?.scope ?? "plain",
    browserLimit: query.browserLimit ?? 0,
    versionLimit: query.versionLimit ?? 5,
    logical: {
      nodeCount: plan.nodes.length,
      nodeKinds,
      outputs: plan.outputs.map(({ id, fields }) => ({
        id,
        fields: fields.map(({ name }) => name),
      })),
    },
    sql: {
      sha256: createHash("sha256").update(compiled.sql).digest("hex"),
      bytes: new TextEncoder().encode(compiled.sql).byteLength,
      bindingCount: compiled.bindings?.length ?? 0,
      bindings: [...(compiled.bindings ?? [])],
      physicalPlanShape: compiled.physicalPlanShape ?? null,
    },
  };
}

async function qualifiedRadarCandidate(query: RadarQuery) {
  const queryTrace = reportingTrace();
  const diagnostics = createD1ReadDiagnostics();
  const forwarded = await d1AdvancedFilterMiddleware(
    reportingEnv(reportingDatabase, queryTrace),
    diagnostics,
    REPORTING_SITE,
  )("radar", query, async (next) => next);
  const deferred = deferredRadarQualificationFromQuery(forwarded);
  if (!deferred) return { kind: "legacy" as const, queryTrace };
  const compiled = compileRadarQualificationProgram({
    deferred,
    query: forwarded,
    configuration: deferred.configuration,
  });
  return { ...compiled, deferred, queryTrace };
}

async function legacyRadarReader(
  query: RadarQuery,
  queryTrace: SqliteD1Trace,
  env = reportingEnv(reportingDatabase, queryTrace),
): Promise<unknown> {
  const forwarded = await d1AdvancedFilterMiddleware(
    env,
    createD1ReadDiagnostics(),
    REPORTING_SITE,
  )("performance", query, async (next) => next);
  expect(deferredRadarQualificationFromQuery(forwarded)).toBeUndefined();
  const filters = (forwarded as QueryInput & { filters?: FilterDocument })
    .filters;
  if (!filters) throw new Error("radar_legacy_oracle_filters_missing");
  const window = {
    startMs: REPORTING_TIME.range.startMs,
    endExclusiveMs: REPORTING_TIME.range.endExclusiveMs,
    nowMs: REPORTING_TIME.capturedAtMs,
    timeZone: REPORTING_TIME.reportingTimeZone,
  };
  return query.variant === "version"
    ? queryBrowserVersionBreakdownFromD1(
        env,
        REPORTING_SITE,
        window,
        filters,
        query.browserLimit ?? 0,
        query.versionLimit ?? 5,
      )
    : query.variant === "referrer"
      ? queryReferrerRadarFromD1(
          env,
          REPORTING_SITE,
          window,
          filters,
          query.limit ?? 24,
        )
      : queryBrowserRadarFromD1(env, REPORTING_SITE, window, filters);
}

async function productionRadarProvider(
  query: RadarQuery,
  queryTrace: SqliteD1Trace,
  diagnostics = createD1ReadDiagnostics(),
  env = reportingEnv(reportingDatabase, queryTrace),
  signal?: AbortSignal,
): Promise<{ readonly value: unknown }> {
  const registry = createD1SiteProviderRegistry({
    env,
    siteId: REPORTING_SITE,
    diagnostics,
  });
  const provider = registry.resolve("radar");
  if (!provider) throw new Error("radar_provider_missing");
  return provider.execute(query, signal ? { signal } : undefined);
}

function writeEvidence(filename: string, contents: string): void {
  if (!EVIDENCE_DIRECTORY) return;
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(join(EVIDENCE_DIRECTORY, filename), contents, "utf8");
}

async function expectRadarWholeBooleanCase(input: {
  readonly name: string;
  readonly query: RadarQuery;
  readonly andBaseline: RadarQuery;
}): Promise<void> {
  const candidate = await qualifiedRadarCandidate(input.query);
  expect(candidate.kind, input.name).toBe("compiled");
  if (candidate.kind !== "compiled") return;
  expect(candidate.deferred.qualification.technologyFilterMode).toBe(
    "allow-whole-filter",
  );
  expect(
    candidate.deferred.qualification.metadata.plan.advancedMatches,
  ).toBeUndefined();
  expect(candidate.evidence.sqlBytes).toBeLessThanOrEqual(
    D1_MAX_SQL_UTF8_BYTES,
  );
  expect(candidate.evidence.bindingCount).toBeLessThanOrEqual(
    D1_MAX_BOUND_PARAMETERS,
  );
  if (input.name === "version-mixed-or")
    expect(candidate.evidence.configuration).toEqual({
      dimension: "version",
      browserLimit: 8,
      versionLimit: 3,
    });
  const actualTrace = reportingTrace();
  const diagnostics = createD1ReadDiagnostics();
  const actual = await productionRadarProvider(
    input.query,
    actualTrace,
    diagnostics,
  );
  const oracleTrace = reportingTrace();
  const oracle = await legacyRadarReader(input.query, oracleTrace);
  const andBaseline = await legacyRadarReader(
    input.andBaseline,
    reportingTrace(),
  );
  expect(actual.value, input.name).toEqual(oracle);
  expect(
    actual.value,
    `${input.name}: fixture exercises Boolean semantics`,
  ).not.toEqual(andBaseline);
  expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  expect(actualTrace.preparedSql).toHaveLength(2);
  expect(actualTrace.preparedSql).toContain(candidate.evidence.sql);
  writeEvidence(
    `97dq-radar-${input.name}.json`,
    JSON.stringify(
      {
        operation: "radar",
        name: input.name,
        variant: input.query.variant ?? "browser",
        scope: input.query.scopePlan?.scope,
        configuration: candidate.evidence.configuration,
        filter: input.query.filters?.root,
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
          reportRowCount: Array.isArray(actual.value)
            ? actual.value.length
            : null,
          actual: actual.value,
          legacyPreparedSql: oracleTrace.preparedSql,
          legacyBindings: oracleTrace.bindings,
          legacy: oracle,
          andBaseline,
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        },
      },
      null,
      2,
    ),
  );
}

function compileNativeShape(
  scope: "session" | "visitor",
  dimension: TechnologyRadarDimension,
) {
  const nativeFilters = parseFilterDsl(
    'page.path neq "/excluded"',
    analyticsFilterRegistry,
  );
  const scopePlan = createScopedFilterPlan("radar", nativeFilters, scope);
  if (!scopePlan) throw new Error("radar_native_scope_plan_missing");
  const filters = attachScopedFilterMetadata(nativeFilters, {
    requestedScope: scope,
    resolvedScope: scopePlan.scope,
    plan: scopePlan,
    time: TIME,
    siteIds: [SITE],
  });
  const plan = buildTechnologyRadarPlan({
    siteId: SITE,
    queryTime: TIME,
    filters,
    scopePlan,
    dimension,
    ...(dimension === "referrer" ? { limit: 24 } : {}),
  });
  const output = plan.outputs.find(
    (candidate) => candidate.id === TECHNOLOGY_RADAR_OUTPUTS[dimension],
  );
  if (!output) throw new Error("radar_native_output_missing");
  const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
    siteId: SITE,
    time: plan.context.time,
  });
  const lowered = lowerer.lower(output);
  const relation = lowerer.projectOutput(
    lowered,
    output.fields.map((field) => ({ name: field.name, slot: field.slot })),
  );
  const compiled = compileD1Query(lowerLogicalPlan(relation), {
    tag: "analytics.technology_radar.native_shape",
  });
  const sqlBytes = new TextEncoder().encode(compiled.sql).byteLength;
  const bindings = compiled.bindings ?? [];
  return {
    scope,
    dimension,
    outputId: output.id,
    logicalPlan: plan,
    sql: compiled.sql,
    sqlBytes,
    bindings,
    bindingCount: bindings.length,
    physicalPlanShape: compiled.physicalPlanShape ?? null,
  };
}

describe("Radar qualified provider regression", () => {
  const radarReportCases = [
    { scope: "session", dimension: "browser" },
    { scope: "session", dimension: "referrer" },
    { scope: "visitor", dimension: "browser" },
    { scope: "visitor", dimension: "referrer" },
    { scope: "event", dimension: "browser" },
    { scope: "event", dimension: "referrer" },
  ] as const;
  const radarReferrerLimitCases = (["session", "visitor"] as const).flatMap(
    (scope) =>
      ([undefined, null, 0, 1, 24, -1, Number.MAX_SAFE_INTEGER] as const).map(
        (limit) => ({ scope, limit }),
      ),
  );
  const radarRegistryComparisons: Record<string, unknown>[] = [];

  it("captures and preserves exact native Browser and Referrer plan shapes", () => {
    const shapes = (["session", "visitor"] as const).flatMap((scope) =>
      (["browser", "referrer"] as const).map((dimension) =>
        compileNativeShape(scope, dimension),
      ),
    );
    expect(shapes).toHaveLength(4);
    for (const shape of shapes) {
      expect(shape.sqlBytes).toBeLessThanOrEqual(D1_MAX_SQL_UTF8_BYTES);
      expect(shape.bindingCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      expect(shape.physicalPlanShape).not.toBeNull();
    }

    const mode = process.env.INSIGHTFLARE_RADAR_NATIVE_SHAPE_MODE;
    if (mode === "before-extraction") {
      writeEvidence(
        "radar-native-shapes-before-extraction.json",
        JSON.stringify({ shapes }, null, 2),
      );
    } else if (mode === "after-extraction") {
      if (!EVIDENCE_DIRECTORY)
        throw new Error("radar_native_shape_evidence_directory_missing");
      const baseline = JSON.parse(
        readFileSync(
          join(
            EVIDENCE_DIRECTORY,
            "radar-native-shapes-before-extraction.json",
          ),
          "utf8",
        ),
      ) as { readonly shapes: readonly unknown[] };
      expect(shapes).toEqual(baseline.shapes);
      writeEvidence(
        "radar-native-shapes-after-extraction.json",
        JSON.stringify({ shapes }, null, 2),
      );
    }
  });

  it("preserves the ordinary Browser version Logical, SQL, bind, and DTO shape", async () => {
    const query = {
      filters: EMPTY_FILTER_DOCUMENT,
      browserLimit: 0,
      versionLimit: 5,
    } as unknown as RadarQuery;
    const shape = compileBrowserVersionNativeShape(query);
    const trace = reportingTrace();
    const actual = await queryBrowserVersionBreakdownFromD1(
      reportingEnv(reportingDatabase, trace),
      REPORTING_SITE,
      {
        startMs: REPORTING_TIME.range.startMs,
        endExclusiveMs: REPORTING_TIME.range.endExclusiveMs,
        nowMs: REPORTING_TIME.capturedAtMs,
        timeZone: REPORTING_TIME.reportingTimeZone,
      },
      query.filters!,
      query.browserLimit ?? 0,
      query.versionLimit ?? 5,
    );
    expect(trace.preparedSql).toHaveLength(1);
    expect(trace.preparedSql[0]).toBeDefined();
    expect(trace.bindings[0]).toEqual(shape.sql.bindings);
    const compiledSqlHash = createHash("sha256")
      .update(trace.preparedSql[0]!)
      .digest("hex");
    expect(compiledSqlHash).toBe(shape.sql.sha256);
    const snapshot = {
      shape,
      actualSql: {
        sha256: compiledSqlHash,
        bytes: new TextEncoder().encode(trace.preparedSql[0]!).byteLength,
        bindingCount: trace.bindings[0]?.length ?? 0,
        bindings: trace.bindings[0] ?? [],
        statementCount: trace.preparedSql.length,
      },
      dto: actual,
    };
    const mode = process.env.INSIGHTFLARE_BROWSER_VERSION_NATIVE_SHAPE_MODE;
    if (mode === "before-extraction")
      writeEvidence(
        "browser-version-ordinary-before-extraction.json",
        JSON.stringify(snapshot, null, 2),
      );
    else if (mode === "after-extraction") {
      if (!EVIDENCE_DIRECTORY)
        throw new Error("browser_version_evidence_directory_missing");
      const baseline = JSON.parse(
        readFileSync(
          join(
            EVIDENCE_DIRECTORY,
            "browser-version-ordinary-before-extraction.json",
          ),
          "utf8",
        ),
      );
      expect(snapshot).toEqual(baseline);
      writeEvidence(
        "browser-version-ordinary-after-extraction.json",
        JSON.stringify(snapshot, null, 2),
      );
    }
  });

  const browserVersionLimitCases = (
    ["session", "visitor", "event"] as const
  ).flatMap((scope) => [
    { id: `${scope}-default-limits`, scope, limits: {} },
    {
      id: `${scope}-fractional-limits`,
      scope,
      limits: { browserLimit: 0.25, versionLimit: 2.5 },
    },
    {
      id: `${scope}-decimal-limits`,
      scope,
      limits: { browserLimit: 1.2, versionLimit: 8 },
    },
  ]);
  const browserVersionCaseIds = [
    ...browserVersionLimitCases.map(({ id }) => id),
    "explicit-null-default-limits",
    "special-version-key-collision",
    "empty-control-envelope",
    "non-finite-version-limit-NaN",
    "non-finite-version-limit-Infinity",
    "no-advanced-expressions",
    "unexpected-ordinary-limit",
    "changed-version-limit-brand",
  ];
  const completedBrowserVersionCases = new Map<
    string,
    Record<string, unknown>
  >();
  const writeBrowserVersionProgress = () => {
    const completedCaseIds = [...completedBrowserVersionCases.keys()];
    const remainingCaseIds = browserVersionCaseIds.filter(
      (caseId) => !completedBrowserVersionCases.has(caseId),
    );
    writeEvidence(
      "radar-browser-version-qualified-registry.json",
      JSON.stringify(
        {
          status: remainingCaseIds.length === 0 ? "complete" : "partial",
          expectedCaseCount: browserVersionCaseIds.length,
          completedCaseCount: completedCaseIds.length,
          completedCaseIds,
          remainingCaseIds,
          cases: [...completedBrowserVersionCases.values()],
        },
        null,
        2,
      ),
    );
  };
  const recordBrowserVersionCase = (
    caseId: string,
    details: Record<string, unknown>,
  ) => {
    completedBrowserVersionCases.set(caseId, { caseId, ...details });
    writeBrowserVersionProgress();
  };
  writeBrowserVersionProgress();

  it.each(browserVersionLimitCases)(
    "qualifies Browser-version Count filters through the production registry ($id)",
    async ({ id, scope, limits }) =>
      withBrowserVersionExtraPages(async () => {
        const query = browserVersionQuery(scope, limits);
        const candidate = await qualifiedRadarCandidate(query);
        expect(candidate.kind, `${scope}:${JSON.stringify(limits)}`).toBe(
          "compiled",
        );
        if (candidate.kind !== "compiled") return;
        expect(candidate.evidence.dimension).toBe("version");
        expect(candidate.evidence.reportFields).toEqual([
          "browser",
          "views",
          "visitors",
          "sessions",
          "browserRank",
          "version",
          "versionLabel",
          "versionViews",
          "versionVisitors",
          "versionSessions",
        ]);

        const actualTrace = reportingTrace();
        const diagnostics = createD1ReadDiagnostics();
        const actual = await productionRadarProvider(
          query,
          actualTrace,
          diagnostics,
        );
        const oracle = await legacyRadarReader(query, reportingTrace());
        expect(actual.value, `${scope}:${JSON.stringify(limits)}`).toEqual(
          oracle,
        );
        expect(
          actualTrace.preparedSql.filter(
            (sql) => sql === candidate.evidence.sql,
          ),
        ).toHaveLength(1);
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        recordBrowserVersionCase(id, {
          scope,
          limits,
          configuration: candidate.evidence.configuration,
          reportFields: candidate.evidence.reportFields,
          ordering: candidate.evidence.ordering,
          sql: candidate.evidence.sql,
          sqlBytes: candidate.evidence.sqlBytes,
          bindings: candidate.evidence.bindings,
          bindingCount: candidate.evidence.bindingCount,
          groupWidth: candidate.evidence.groupWidth,
          physicalPlanShape: candidate.evidence.physicalPlanShape,
          reportSourceRelations: candidate.evidence.reportSourceRelations,
          actual: actual.value,
          legacy: oracle,
          actualSql: actualTrace.preparedSql,
          actualBindings: actualTrace.bindings,
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        });
      }),
  );

  it("normalizes explicit-null Browser-version limits independently", async () => {
    await withBrowserVersionExtraPages(async () => {
      const explicitNullLimits = {
        ...browserVersionQuery("session"),
        browserLimit: null,
        versionLimit: null,
      } as unknown as RadarQuery;
      const explicitNullCandidate =
        await qualifiedRadarCandidate(explicitNullLimits);
      expect(explicitNullCandidate.kind).toBe("compiled");
      if (explicitNullCandidate.kind === "compiled")
        expect(explicitNullCandidate.evidence.configuration).toEqual({
          dimension: "version",
          browserLimit: 0,
          versionLimit: 5,
        });
      const actualTrace = reportingTrace();
      const actual = await productionRadarProvider(
        explicitNullLimits,
        actualTrace,
      );
      const oracle = await legacyRadarReader(
        explicitNullLimits,
        reportingTrace(),
      );
      expect(actual.value).toEqual(oracle);
      if (explicitNullCandidate.kind === "compiled")
        expect(
          actualTrace.preparedSql.filter(
            (sql) => sql === explicitNullCandidate.evidence.sql,
          ),
        ).toHaveLength(1);
      recordBrowserVersionCase("explicit-null-default-limits", {
        configuration:
          explicitNullCandidate.kind === "compiled"
            ? explicitNullCandidate.evidence.configuration
            : null,
        actual: actual.value,
        legacy: oracle,
        actualSql: actualTrace.preparedSql,
        actualBindings: actualTrace.bindings,
      });
    });
  });

  it("preserves special Browser-version keys independently", async () => {
    await withBrowserVersionExtraPages(async () => {
      const query = browserVersionQuery("session", {
        browserLimit: 1,
        versionLimit: 8,
      });
      const allVersions = await productionRadarProvider(
        query,
        reportingTrace(),
      );
      const chrome = (
        allVersions.value as readonly {
          readonly browser: string;
          readonly versions: readonly {
            readonly key: string;
            readonly label: string;
            readonly isUnknown?: boolean;
          }[];
        }[]
      ).find((row) => row.browser === "Chrome");
      expect(chrome?.versions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "unknown-2", label: "unknown" }),
          expect.objectContaining({ key: "other-2", label: "other" }),
          expect.objectContaining({
            key: "unknown",
            label: "Unknown",
            isUnknown: true,
          }),
        ]),
      );
      recordBrowserVersionCase("special-version-key-collision", {
        chromeVersions: chrome?.versions,
      });
    });
  });

  it("preserves empty Browser-version control envelopes independently", async () => {
    await withBrowserVersionExtraPages(async () => {
      const emptyQuery = browserVersionQuery("visitor", {
        filterDsl:
          'page.path eq "/no-browser-version-match" and count(event { event.name eq "qualifier" }) gte 1',
      });
      const emptyCandidate = await qualifiedRadarCandidate(emptyQuery);
      expect(emptyCandidate.kind).toBe("compiled");
      if (emptyCandidate.kind !== "compiled") return;
      const emptyTrace = reportingTrace();
      const emptyDiagnostics = createD1ReadDiagnostics();
      const emptyActual = await productionRadarProvider(
        emptyQuery,
        emptyTrace,
        emptyDiagnostics,
      );
      const emptyOracle = await legacyRadarReader(emptyQuery, reportingTrace());
      expect(emptyActual.value).toEqual([]);
      expect(emptyActual.value).toEqual(emptyOracle);
      expect(
        emptyTrace.preparedSql.filter(
          (sql) => sql === emptyCandidate.evidence.sql,
        ),
      ).toHaveLength(1);
      expect(emptyDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      const evidence = {
        configuration: emptyCandidate.evidence.configuration,
        sql: emptyCandidate.evidence.sql,
        sqlBytes: emptyCandidate.evidence.sqlBytes,
        bindings: emptyCandidate.evidence.bindings,
        actualSql: emptyTrace.preparedSql,
        actualBindings: emptyTrace.bindings,
        actual: emptyActual.value,
        legacy: emptyOracle,
        fallbackReason: emptyDiagnostics.advancedCountSqlFallbackReason,
      };
      writeEvidence(
        "radar-browser-version-empty-controls.json",
        JSON.stringify(evidence, null, 2),
      );
      recordBrowserVersionCase("empty-control-envelope", evidence);
    });
  });

  it.each([
    {
      caseId: "non-finite-version-limit-NaN",
      versionLimit: Number.NaN,
    },
    {
      caseId: "non-finite-version-limit-Infinity",
      versionLimit: Number.POSITIVE_INFINITY,
    },
  ])(
    "falls back for unsupported Browser-version limits ($caseId)",
    async ({ caseId, versionLimit }) =>
      withBrowserVersionExtraPages(async () => {
        const unsupportedLimit = browserVersionQuery("session", {
          browserLimit: 0,
          versionLimit,
        });
        expect(await qualifiedRadarCandidate(unsupportedLimit)).toMatchObject({
          kind: "legacy",
        });
        const actual = await productionRadarProvider(
          unsupportedLimit,
          reportingTrace(),
        );
        const oracle = await legacyRadarReader(
          unsupportedLimit,
          reportingTrace(),
        );
        expect(actual.value).toEqual(oracle);
        recordBrowserVersionCase(caseId, {
          versionLimit: String(versionLimit),
          legacyFallback: true,
          actual: actual.value,
          legacy: oracle,
        });
      }),
  );

  it("preserves Browser-version fallback without advanced expressions", async () => {
    await withBrowserVersionExtraPages(async () => {
      const noAdvancedQuery = browserVersionQuery("session", {
        filterDsl: 'page.path neq "/excluded"',
      });
      expect(await qualifiedRadarCandidate(noAdvancedQuery)).toMatchObject({
        kind: "legacy",
      });
      const actual = await productionRadarProvider(
        noAdvancedQuery,
        reportingTrace(),
      );
      const oracle = await legacyRadarReader(noAdvancedQuery, reportingTrace());
      expect(actual.value).toEqual(oracle);
      recordBrowserVersionCase("no-advanced-expressions", {
        legacyFallback: true,
        actual: actual.value,
        legacy: oracle,
      });
    });
  });

  it("preserves Browser-version fallback for an unexpected ordinary limit", async () => {
    await withBrowserVersionExtraPages(async () => {
      const versionWithUnexpectedLimit = {
        ...browserVersionQuery("session"),
        limit: 1,
      } as unknown as RadarQuery;
      expect(
        await qualifiedRadarCandidate(versionWithUnexpectedLimit),
      ).toMatchObject({ kind: "legacy" });
      const actual = await productionRadarProvider(
        versionWithUnexpectedLimit,
        reportingTrace(),
      );
      const oracle = await legacyRadarReader(
        versionWithUnexpectedLimit,
        reportingTrace(),
      );
      expect(actual.value).toEqual(oracle);
      recordBrowserVersionCase("unexpected-ordinary-limit", {
        legacyFallback: true,
        actual: actual.value,
        legacy: oracle,
      });
    });
  });

  it("rejects a Browser-version query changed after deferral", async () => {
    await withBrowserVersionExtraPages(async () => {
      const brandedQuery = browserVersionQuery("session", {
        browserLimit: 1,
        versionLimit: 2,
      });
      const brandedForwarded = await d1AdvancedFilterMiddleware(
        reportingEnv(reportingDatabase, reportingTrace()),
        createD1ReadDiagnostics(),
        REPORTING_SITE,
      )("radar", brandedQuery, async (next) => next);
      expect(
        deferredRadarQualificationFromQuery(brandedForwarded),
      ).toBeDefined();
      Object.defineProperty(brandedForwarded, "versionLimit", {
        value: 3,
        enumerable: true,
        writable: true,
        configurable: true,
      });
      expect(() =>
        deferredRadarQualificationFromQuery(brandedForwarded),
      ).toThrow("radar_qualification_request_changed");
      recordBrowserVersionCase("changed-version-limit-brand", {
        deferredBrandPresent: true,
        changedVersionLimit: 3,
        error: "radar_qualification_request_changed",
      });
    });
  });
  it("preserves Browser-version DTOs with reverse_unordered_selects enabled", async () => {
    const extraPages: readonly SeedRadarPage[] = [
      {
        id: "reverse-order-version-120",
        visitor: "reverse-order-120",
        session: "reverse-order-120-session",
        startedAt: REPORTING_BASE + 400,
        lastActivityAt: REPORTING_BASE + 410,
        pathname: "/reverse-version-120",
        browser: "Chrome",
        browserVersion: "120.3",
        referrerHost: "versions.example",
      },
      {
        id: "reverse-order-version-121",
        visitor: "reverse-order-121",
        session: "reverse-order-121-session",
        startedAt: REPORTING_BASE + 420,
        lastActivityAt: REPORTING_BASE + 430,
        pathname: "/reverse-version-121",
        browser: "Chrome",
        browserVersion: "121.3",
        referrerHost: "versions.example",
      },
      {
        id: "reverse-order-version-122",
        visitor: "reverse-order-122",
        session: "reverse-order-122-session",
        startedAt: REPORTING_BASE + 440,
        lastActivityAt: REPORTING_BASE + 450,
        pathname: "/reverse-version-122",
        browser: "Chrome",
        browserVersion: "122.3",
        referrerHost: "versions.example",
      },
    ];
    const cases: readonly {
      readonly scope: ReportingScope;
      readonly name: string;
      readonly limits: {
        readonly browserLimit?: number;
        readonly versionLimit?: number;
      };
    }[] = [
      { scope: "session", name: "default", limits: {} },
      {
        scope: "session",
        name: "top-n-other",
        limits: { browserLimit: 1, versionLimit: 2 },
      },
      { scope: "visitor", name: "default", limits: {} },
      {
        scope: "visitor",
        name: "top-n-other",
        limits: { browserLimit: 1, versionLimit: 2 },
      },
    ];
    const pragmaRow = reportingDatabase
      .prepare("PRAGMA reverse_unordered_selects")
      .get() as Record<string, unknown>;
    const pragmaValue = Object.values(pragmaRow)[0];
    const restorePragma = Number(pragmaValue) === 1 ? "ON" : "OFF";
    const comparisons: Record<string, unknown>[] = [];
    let restoredPragmaValue: number | undefined;
    try {
      for (const page of extraPages) seedRadarPage(page);

      const offSnapshots = new Map<
        string,
        { readonly actual: unknown; readonly legacy: unknown }
      >();
      for (const item of cases) {
        const query = browserVersionQuery(item.scope, item.limits);
        const trace = reportingTrace();
        const actual = await productionRadarProvider(query, trace);
        const legacy = await legacyRadarReader(query, reportingTrace());
        expect(trace.preparedSql).toHaveLength(2);
        expect(actual.value).toEqual(legacy);
        offSnapshots.set(`${item.scope}:${item.name}`, {
          actual: actual.value,
          legacy,
        });
      }

      reportingDatabase.exec("PRAGMA reverse_unordered_selects = ON");
      expect(
        Number(
          Object.values(
            reportingDatabase
              .prepare("PRAGMA reverse_unordered_selects")
              .get() as Record<string, unknown>,
          )[0],
        ),
      ).toBe(1);

      for (const item of cases) {
        const key = `${item.scope}:${item.name}`;
        const query = browserVersionQuery(item.scope, item.limits);
        const candidate = await qualifiedRadarCandidate(query);
        expect(candidate.kind, key).toBe("compiled");
        if (candidate.kind !== "compiled") continue;

        const trace = reportingTrace();
        const diagnostics = createD1ReadDiagnostics();
        const actual = await productionRadarProvider(query, trace, diagnostics);
        const legacyTrace = reportingTrace();
        const legacy = await legacyRadarReader(query, legacyTrace);
        expect(
          trace.preparedSql,
          `${key}: actual statement count`,
        ).toHaveLength(2);
        expect(
          trace.preparedSql.filter((sql) => sql === candidate.evidence.sql),
          `${key}: one qualification envelope`,
        ).toHaveLength(1);
        expect(actual.value, `${key}: reverse vs OFF`).toEqual(
          offSnapshots.get(key)?.actual,
        );
        expect(actual.value, `${key}: reverse vs legacy`).toEqual(legacy);
        expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
        if (item.name === "top-n-other") {
          const chrome = (
            actual.value as readonly {
              readonly browser: string;
              readonly versions: readonly { readonly isOther?: boolean }[];
            }[]
          ).find((row) => row.browser === "Chrome");
          expect(chrome?.versions.some((version) => version.isOther)).toBe(
            true,
          );
        }
        comparisons.push({
          scope: item.scope,
          case: item.name,
          reverseUnorderedSelects: true,
          configuration: candidate.evidence.configuration,
          ordering: candidate.evidence.ordering,
          qualificationSql: candidate.evidence.sql,
          qualificationBindings: candidate.evidence.bindings,
          actualSql: trace.preparedSql,
          actualBindings: trace.bindings,
          legacySql: legacyTrace.preparedSql,
          legacyBindings: legacyTrace.bindings,
          actual: actual.value,
          reverseModeLegacy: legacy,
          unorderedModeActual: offSnapshots.get(key)?.actual,
          unorderedModeLegacy: offSnapshots.get(key)?.legacy,
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        });
      }
      expect(comparisons).toHaveLength(cases.length);
    } finally {
      reportingDatabase.exec(
        `PRAGMA reverse_unordered_selects = ${restorePragma}`,
      );
      const restoredRow = reportingDatabase
        .prepare("PRAGMA reverse_unordered_selects")
        .get() as Record<string, unknown>;
      restoredPragmaValue = Number(Object.values(restoredRow)[0]);
      const deleteEvents = reportingDatabase.prepare(
        "DELETE FROM custom_events WHERE visit_id = ?",
      );
      const deleteVisits = reportingDatabase.prepare(
        "DELETE FROM visits WHERE visit_id = ?",
      );
      for (const page of extraPages) {
        deleteEvents.run(page.id);
        deleteVisits.run(page.id);
      }
    }
    expect(restoredPragmaValue).toBe(Number(pragmaValue));
    writeEvidence(
      "radar-browser-version-reverse-unordered.json",
      JSON.stringify(
        {
          pragmaBefore: Number(pragmaValue),
          pragmaDuring: 1,
          pragmaRestored: restoredPragmaValue,
          comparisons,
        },
        null,
        2,
      ),
    );
  });

  it("observes real parameter admission for a three-Count Browser-version request", async () => {
    const filterDsl =
      'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1 and count(page { page.path eq "/first" }) gte 1 and count(page { page.path eq "/second" }) gte 1';
    const query = browserVersionQuery("session", {
      browserLimit: 1,
      versionLimit: 2,
      filterDsl,
    });
    const candidate = await qualifiedRadarCandidate(query);
    expect(candidate.kind).not.toBe("legacy");
    if (candidate.kind === "legacy")
      throw new Error("browser_version_three_count_not_qualified");
    const trace = reportingTrace();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await productionRadarProvider(query, trace, diagnostics);
    const legacyTrace = reportingTrace();
    const legacy = await legacyRadarReader(query, legacyTrace);
    expect(actual.value).toEqual(legacy);

    if (candidate.kind === "compiled") {
      const shape = candidate.evidence.physicalPlanShape;
      const parameterLayout =
        shape && "parameterOccurrenceCount" in shape ? shape : undefined;
      const occurrenceCount =
        parameterLayout?.parameterOccurrenceCount ??
        candidate.evidence.bindingCount;
      const slotCount =
        parameterLayout?.parameterSlotCount ?? candidate.evidence.bindingCount;
      expect(trace.preparedSql).toHaveLength(2);
      expect(
        trace.preparedSql.filter((sql) => sql === candidate.evidence.sql),
      ).toHaveLength(1);
      expect(candidate.evidence.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      if (occurrenceCount > D1_MAX_BOUND_PARAMETERS) {
        expect(parameterLayout?.parameterStrategy).toBe("numbered-reuse");
        expect(slotCount).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      }
      const reportIndex = trace.preparedSql.indexOf(candidate.evidence.sql);
      expect(trace.bindings[reportIndex]).toEqual(candidate.evidence.bindings);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      writeEvidence(
        "radar-browser-version-three-count-admission.json",
        JSON.stringify(
          {
            request: { scope: "session", filterDsl },
            route: "compiled-and-admitted",
            bindingStrategy: parameterLayout?.parameterStrategy ?? "anonymous",
            occurrenceCount,
            slotCount,
            finalBindingCount: candidate.evidence.bindingCount,
            sqlBytes: candidate.evidence.sqlBytes,
            qualificationSql: candidate.evidence.sql,
            qualificationBindings: candidate.evidence.bindings,
            actualSql: trace.preparedSql,
            actualBindings: trace.bindings,
            actualStatementCount: trace.preparedSql.length,
            actual: actual.value,
            legacySql: legacyTrace.preparedSql,
            legacyBindings: legacyTrace.bindings,
            legacy,
            fallbackReason: diagnostics.advancedCountSqlFallbackReason,
          },
          null,
          2,
        ),
      );
    } else {
      expect(
        trace.bindings.every(
          (bindings) => bindings.length <= D1_MAX_BOUND_PARAMETERS,
        ),
      ).toBe(true);
      expect(diagnostics.advancedCountSqlFallbackReason).toEqual(
        candidate.fallbackReason,
      );
      writeEvidence(
        "radar-browser-version-three-count-admission.json",
        JSON.stringify(
          {
            request: { scope: "session", filterDsl },
            route: "whole-tree-fallback",
            fallbackReason: candidate.fallbackReason,
            executedSql: trace.preparedSql,
            executedBindingCounts: trace.bindings.map(({ length }) => length),
            actual: actual.value,
            legacySql: legacyTrace.preparedSql,
            legacyBindings: legacyTrace.bindings,
            legacy,
          },
          null,
          2,
        ),
      );
    }
  });

  beforeAll(() => {
    seedReportingFixture();
  });

  afterAll(() => {
    if (radarRegistryComparisons.length === radarReportCases.length) {
      expect(radarRegistryComparisons).toHaveLength(radarReportCases.length);
      writeEvidence(
        "radar-qualified-registry-comparisons.json",
        JSON.stringify({ comparisons: radarRegistryComparisons }, null, 2),
      );
    }
    reportingDatabase.close();
  });

  it.each(radarReportCases)(
    "matches the independent legacy $scope/$dimension report through the production registry",
    async ({ scope, dimension }) => {
      const query = radarQuery(scope, dimension);
      const candidate = await qualifiedRadarCandidate(query);
      expect(candidate.kind, `${scope}:${dimension}:qualified`).toBe(
        "compiled",
      );
      if (candidate.kind !== "compiled") return;
      expect(candidate.evidence.sqlBytes).toBeLessThanOrEqual(
        D1_MAX_SQL_UTF8_BYTES,
      );
      expect(candidate.evidence.bindingCount).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMETERS,
      );
      expect(candidate.evidence.groupWidth).toBeLessThanOrEqual(16);
      expect(candidate.evidence.physicalPlanShape).not.toBeNull();
      expect(candidate.evidence.reportSourceRelations).toEqual([
        expect.objectContaining({ entity: "page" }),
      ]);

      const actualTrace = reportingTrace();
      const diagnostics = createD1ReadDiagnostics();
      const actual = await productionRadarProvider(
        query,
        actualTrace,
        diagnostics,
      );
      const oracleTrace = reportingTrace();
      const oracle = await legacyRadarReader(query, oracleTrace);
      expect(actual.value, `${scope}:${dimension}:DTO and row order`).toEqual(
        oracle,
      );
      expect(actualTrace.preparedSql).toContain(candidate.evidence.sql);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      radarRegistryComparisons.push({
        scope,
        dimension,
        configuration: candidate.evidence.configuration,
        logicalPlan: candidate.evidence.logicalPlan,
        sql: candidate.evidence.sql,
        sqlBytes: candidate.evidence.sqlBytes,
        bindings: candidate.evidence.bindings,
        bindingCount: candidate.evidence.bindingCount,
        groupWidth: candidate.evidence.groupWidth,
        physicalPlanShape: candidate.evidence.physicalPlanShape,
        reportSourceRelations: candidate.evidence.reportSourceRelations,
        outputDescriptors: candidate.evidence.outputDescriptors,
        ordering: candidate.evidence.ordering,
        actualValue: actual.value,
        legacyValue: oracle,
        actualSql: actualTrace.preparedSql,
        actualBindings: actualTrace.bindings,
        legacySql: oracleTrace.preparedSql,
        legacyBindings: oracleTrace.bindings,
      });
    },
  );

  it.each(radarReferrerLimitCases)(
    "preserves Referrer limit for $scope scope: $limit",
    async ({ scope, limit }) => {
      const query = radarQuery(scope, "referrer", limit as number | undefined);
      const candidate = await qualifiedRadarCandidate(query);
      expect(candidate.kind, `${scope}:referrer limit=${String(limit)}`).toBe(
        "compiled",
      );
      const actual = await productionRadarProvider(query, reportingTrace());
      const oracle = await legacyRadarReader(query, reportingTrace());
      expect(actual.value, `${scope}:referrer limit=${String(limit)}`).toEqual(
        oracle,
      );
    },
  );

  it.each(["session", "visitor"] as const)(
    "routes Browser queries with an ignored limit through legacy for %s scope",
    async (scope) => {
      const browser = radarQuery(scope, "browser");
      const browserWithIgnoredLimit = {
        ...browser,
        limit: 1,
      } as unknown as RadarQuery;
      expect(
        await qualifiedRadarCandidate(browserWithIgnoredLimit),
      ).toMatchObject({ kind: "legacy" });
      const browserActual = await productionRadarProvider(
        browserWithIgnoredLimit,
        reportingTrace(),
      );
      const browserOracle = await legacyRadarReader(
        browserWithIgnoredLimit,
        reportingTrace(),
      );
      expect(browserActual.value).toEqual(browserOracle);
    },
  );

  it.each(["session", "visitor"] as const)(
    "does not qualify unsupported Browser version variants for %s scope",
    async (scope) => {
      const browser = radarQuery(scope, "browser");
      const version = {
        ...browser,
        variant: "version",
        browserLimit: 0,
        versionLimit: 5,
        limit: 1,
      } as unknown as RadarQuery;
      const versionForwarded = await d1AdvancedFilterMiddleware(
        reportingEnv(reportingDatabase, reportingTrace()),
        createD1ReadDiagnostics(),
        REPORTING_SITE,
      )("radar", version, async (next) => next);
      expect(
        deferredRadarQualificationFromQuery(versionForwarded),
      ).toBeUndefined();
    },
  );

  it("rejects copied or modified qualification brands", async () => {
    const brandedQuery = radarQuery("session", "referrer", 1);
    const brandedForwarded = await d1AdvancedFilterMiddleware(
      reportingEnv(reportingDatabase, reportingTrace()),
      createD1ReadDiagnostics(),
      REPORTING_SITE,
    )("radar", brandedQuery, async (next) => next);
    const deferred = deferredRadarQualificationFromQuery(brandedForwarded);
    expect(deferred).toBeDefined();
    expect(
      deferredRadarQualificationFromQuery({
        ...(brandedForwarded as Record<string, unknown>),
      }),
    ).toBeUndefined();
    if (!deferred) throw new Error("radar_qualification_brand_missing");
    expect(() =>
      compileRadarQualificationProgram({
        deferred,
        query: brandedForwarded,
        configuration: { dimension: "referrer", limit: 2 },
      }),
    ).toThrow("radar_qualification_request_untrusted");
    Object.defineProperty(brandedForwarded, "limit", {
      value: 2,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    expect(() => deferredRadarQualificationFromQuery(brandedForwarded)).toThrow(
      "radar_qualification_request_changed",
    );
  });

  it("97DQ: qualifies mixed OR Browser Radar filters against the legacy reader", async () => {
    seedRadarNamedEvent("gamma-session", "whole-filter-owner");
    try {
      const filterDsl =
        'page.path neq "/excluded" or count(event { event.name eq "whole-filter-owner" }) gte 1';
      await expectRadarWholeBooleanCase({
        name: "browser-mixed-or",
        query: radarQuery("session", "browser", undefined, filterDsl),
        andBaseline: radarQuery("session", "browser"),
      });
    } finally {
      deleteRadarNamedEvent("gamma-session", "whole-filter-owner");
    }
  });

  it("97DQ: qualifies mixed NOT Referrer Radar filters against the legacy reader", async () => {
    seedRadarNamedEvent("gamma-session", "whole-filter-owner");
    try {
      const filterDsl =
        'not (page.path neq "/excluded" and count(event { event.name eq "whole-filter-owner" }) gte 1)';
      await expectRadarWholeBooleanCase({
        name: "referrer-mixed-not",
        query: radarQuery("visitor", "referrer", 4, filterDsl),
        andBaseline: radarQuery("visitor", "referrer", 4),
      });
    } finally {
      deleteRadarNamedEvent("gamma-session", "whole-filter-owner");
    }
  });

  it("97DQ: qualifies mixed OR Browser-version filters against the legacy reader", async () => {
    seedRadarNamedEvent("gamma-session", "whole-filter-owner");
    try {
      const filterDsl =
        'page.path neq "/excluded" or count(event { event.name eq "whole-filter-owner" }) gte 1';
      await expectRadarWholeBooleanCase({
        name: "version-mixed-or",
        query: browserVersionQuery("session", {
          browserLimit: 8,
          versionLimit: 3,
          filterDsl,
        }),
        andBaseline: browserVersionQuery("session", {
          browserLimit: 8,
          versionLimit: 3,
        }),
      });
    } finally {
      deleteRadarNamedEvent("gamma-session", "whole-filter-owner");
    }
  });

  it("leaves public-share Radar queries on legacy routing", async () => {
    const publicQuery = {
      ...radarQuery("session", "browser"),
      context: siteQueryContext(REPORTING_SITE, "public-share"),
    } as RadarQuery;
    expect(await qualifiedRadarCandidate(publicQuery)).toMatchObject({
      kind: "legacy",
    });
  });

  it("matches legacy Browser trimming for Unicode whitespace and trimmed collisions", async () => {
    const originalBrowsers = [
      ["alpha-first-page", " Chrome "],
      ["alpha-second-page", "Chrome"],
      ["alpha-return-session", "Firefox"],
      ["beta-session", "Chrome"],
      ["gamma-session", "Safari"],
      ["empty-session", "Edge"],
      ["empty-visitor", "Edge"],
      ["blank-browser", "   "],
    ] as const;
    const restoreBrowsers = () => {
      const update = reportingDatabase.prepare(
        "UPDATE visits SET browser = ? WHERE visit_id = ?",
      );
      for (const [visitId, browser] of originalBrowsers)
        update.run(browser, visitId);
    };
    const emptyComparisons: Record<string, unknown>[] = [];
    try {
      const update = reportingDatabase.prepare("UPDATE visits SET browser = ?");
      for (const whitespace of ["\u00a0", "\t\u2000\u3000"] as const) {
        update.run(whitespace);
        for (const scope of ["session", "visitor"] as const) {
          const query = radarQuery(scope, "browser");
          const actualTrace = reportingTrace();
          const actual = await productionRadarProvider(query, actualTrace);
          const oracleTrace = reportingTrace();
          const oracle = await legacyRadarReader(query, oracleTrace);
          expect(
            actual.value,
            `${scope}:${JSON.stringify(whitespace)}`,
          ).toEqual(oracle);
          expect(actual.value).toEqual([]);
          emptyComparisons.push({
            scope,
            whitespace: JSON.stringify(whitespace),
            actual: actual.value,
            legacy: oracle,
            actualSql: actualTrace.preparedSql,
            legacySql: oracleTrace.preparedSql,
          });
        }
      }
      writeEvidence(
        "radar-unicode-browser-empty.json",
        JSON.stringify({ comparisons: emptyComparisons }, null, 2),
      );

      const setBrowser = reportingDatabase.prepare(
        "UPDATE visits SET browser = ? WHERE visit_id = ?",
      );
      setBrowser.run("\u00a0Firefox\u00a0", "alpha-return-session");
      setBrowser.run("Firefox", "beta-session");
      setBrowser.run("Firefox", "empty-session");
      for (const scope of ["session", "visitor"] as const) {
        const query = radarQuery(scope, "browser");
        const actualTrace = reportingTrace();
        const actual = await productionRadarProvider(query, actualTrace);
        const oracleTrace = reportingTrace();
        const oracle = await legacyRadarReader(query, oracleTrace);
        expect(actual.value, `${scope}:trimmed label collision`).toEqual(
          oracle,
        );
        expect(
          (actual.value as readonly Record<string, unknown>[]).filter(
            (row) => row.browser === "Firefox",
          ),
        ).toHaveLength(2);
        writeEvidence(
          `radar-unicode-browser-${scope}.json`,
          JSON.stringify(
            {
              actual: actual.value,
              legacy: oracle,
              actualSql: actualTrace.preparedSql,
              legacySql: oracleTrace.preparedSql,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      restoreBrowsers();
    }
  });

  it("preserves legacy handling of infinite and nullable report metrics", async () => {
    const originalBrowsers = [
      ["alpha-first-page", " Chrome "],
      ["alpha-second-page", "Chrome"],
      ["alpha-return-session", "Firefox"],
      ["beta-session", "Chrome"],
      ["gamma-session", "Safari"],
      ["empty-session", "Edge"],
      ["empty-visitor", "Edge"],
      ["blank-browser", "   "],
    ] as const;
    const restoreFixture = () => {
      const updateBrowser = reportingDatabase.prepare(
        "UPDATE visits SET browser = ? WHERE visit_id = ?",
      );
      for (const [visitId, browser] of originalBrowsers)
        updateBrowser.run(browser, visitId);
      reportingDatabase.prepare("UPDATE visits SET duration_ms = NULL").run();
    };
    try {
      reportingDatabase
        .prepare("UPDATE visits SET browser = 'Firefox', duration_ms = ?")
        .run(1.7e308);
      for (const scope of ["session", "visitor"] as const) {
        const query = radarQuery(scope, "browser");
        const actualTrace = reportingTrace();
        const actual = await productionRadarProvider(query, actualTrace);
        const oracleTrace = reportingTrace();
        const oracle = await legacyRadarReader(query, oracleTrace);
        expect(actual.value, `${scope}:finite REAL overflow`).toEqual(oracle);
        expect(
          (actual.value as readonly Record<string, unknown>[]).some(
            (row) => row.avgDurationMs === Infinity,
          ),
        ).toBe(true);
        writeEvidence(
          `radar-duration-overflow-${scope}.json`,
          JSON.stringify(
            {
              inputDurationMs: 1.7e308,
              actual: actual.value,
              legacy: oracle,
              actualSql: actualTrace.preparedSql,
              actualBindings: actualTrace.bindings,
              legacySql: oracleTrace.preparedSql,
              legacyBindings: oracleTrace.bindings,
            },
            (_key, value: unknown) =>
              typeof value === "number" && !Number.isFinite(value)
                ? String(value)
                : value,
            2,
          ),
        );
      }

      reportingDatabase
        .prepare("UPDATE visits SET browser = 'Firefox', duration_ms = NULL")
        .run();
      for (const scope of ["session", "visitor"] as const) {
        const query = radarQuery(scope, "browser");
        const nullMetric = (
          sql: string,
          rows: readonly Record<string, unknown>[],
        ) =>
          rows.map((row) =>
            Object.hasOwn(row, "avgDepth") ? { ...row, avgDepth: null } : row,
          );
        const actualTrace = reportingTrace();
        const actual = await productionRadarProvider(
          query,
          actualTrace,
          createD1ReadDiagnostics(),
          reportingEnvWithHooks(reportingDatabase, actualTrace, {
            transformRows: nullMetric,
          }),
        );
        const oracleTrace = reportingTrace();
        const oracle = await legacyRadarReader(
          query,
          oracleTrace,
          reportingEnvWithHooks(reportingDatabase, oracleTrace, {
            transformRows: nullMetric,
          }),
        );
        expect(actual.value, `${scope}:nullable metric DTO`).toEqual(oracle);
        expect(
          (actual.value as readonly Record<string, unknown>[]).every(
            (row) => row.avgDepth === 0,
          ),
        ).toBe(true);
        writeEvidence(
          `radar-nullable-metric-${scope}.json`,
          JSON.stringify({ actual: actual.value, legacy: oracle }, null, 2),
        );
      }
    } finally {
      restoreFixture();
    }
  });

  it("uses the legacy report once for numeric-domain Count fallback", async () => {
    const query = radarQuery(
      "session",
      "browser",
      undefined,
      'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1',
    );
    const candidate = await qualifiedRadarCandidate(query);
    expect(candidate.kind).toBe("compiled");
    if (candidate.kind !== "compiled") return;
    reportingDatabase
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "alpha-second-page");
    try {
      const oracleTrace = reportingTrace();
      const oracle = await legacyRadarReader(query, oracleTrace);
      const fallbackSpy = vi.spyOn(
        advancedFilterExecution,
        "prepareDeferredEventQualificationFallback",
      );
      const oldReaderSpy = vi.spyOn(radarReaders, "queryBrowserRadarFromD1");
      const actualTrace = reportingTrace();
      const diagnostics = createD1ReadDiagnostics();
      try {
        const actual = await productionRadarProvider(
          query,
          actualTrace,
          diagnostics,
        );
        expect(actual.value).toEqual(oracle);
        expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
          kind: "numeric-data-domain",
          fieldIds: ["page.durationMs"],
        });
        expect(fallbackSpy).toHaveBeenCalledTimes(1);
        expect(oldReaderSpy).toHaveBeenCalledTimes(1);
        expect(
          actualTrace.preparedSql.filter(
            (sql) => sql === candidate.evidence.sql,
          ),
        ).toHaveLength(1);
        expect(actualTrace.preparedSql.length).toBeGreaterThan(
          oracleTrace.preparedSql.length,
        );
        writeEvidence(
          "radar-numeric-domain-fallback.json",
          JSON.stringify(
            {
              fallbackReason: diagnostics.advancedCountSqlFallbackReason,
              actual: actual.value,
              legacy: oracle,
              runtimeSql: actualTrace.preparedSql,
              legacySql: oracleTrace.preparedSql,
            },
            null,
            2,
          ),
        );
      } finally {
        fallbackSpy.mockRestore();
        oldReaderSpy.mockRestore();
      }
    } finally {
      reportingDatabase
        .prepare("UPDATE visits SET duration_ms = NULL WHERE visit_id = ?")
        .run("alpha-second-page");
    }
  });

  it("judges the raw activity cap before empty reports and numeric fallback", async () => {
    const query = radarQuery(
      "session",
      "browser",
      undefined,
      'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1',
    );
    const candidate = await qualifiedRadarCandidate(query);
    expect(candidate.kind).toBe("compiled");
    if (candidate.kind !== "compiled") return;
    const invalidCountFields = candidate.evidence.compatibilityFields.map(
      ({ outputName }) => outputName,
    );
    expect(invalidCountFields.length).toBeGreaterThan(0);
    let injected = false;
    const trace = reportingTrace();
    const diagnostics = createD1ReadDiagnostics();
    const env = reportingEnvWithHooks(reportingDatabase, trace, {
      transformRows: (sql, rows) => {
        if (sql !== candidate.evidence.sql) return rows;
        injected = true;
        return rows
          .filter((row) => row.rowKind === "control")
          .map((row) => ({
            ...row,
            rawCount: 20001,
            ...Object.fromEntries(
              invalidCountFields.map((field) => [field, 1]),
            ),
          }));
      },
    });
    await expect(
      productionRadarProvider(query, trace, diagnostics, env),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(injected).toBe(true);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(
      trace.preparedSql.filter((sql) => sql === candidate.evidence.sql),
    ).toHaveLength(1);
    writeEvidence(
      "radar-raw-count-cap-priority.json",
      JSON.stringify(
        {
          injectedFromCompiledD1Result: true,
          injectedControl: {
            rawCount: 20001,
            invalidCountFields,
            reportRowsRemoved: true,
          },
          preparedSql: trace.preparedSql,
          error: "filter_activity_limit_exceeded",
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
        },
        null,
        2,
      ),
    );
  });

  it("propagates compiled SQL errors and aborts without retrying the legacy reader", async () => {
    const query = radarQuery("session", "browser");
    const candidate = await qualifiedRadarCandidate(query);
    expect(candidate.kind).toBe("compiled");
    if (candidate.kind !== "compiled") return;
    const databaseError = new Error("radar_qualification_database_failure");
    const databaseErrorTrace = reportingTrace();
    const diagnostics = createD1ReadDiagnostics();
    const failedEnv = reportingEnvWithHooks(
      reportingDatabase,
      databaseErrorTrace,
      {
        beforeAll(sql) {
          if (sql === candidate.evidence.sql) throw databaseError;
        },
      },
    );
    await expect(
      productionRadarProvider(
        query,
        databaseErrorTrace,
        diagnostics,
        failedEnv,
      ),
    ).rejects.toBe(databaseError);
    expect(
      databaseErrorTrace.preparedSql.filter(
        (sql) => sql === candidate.evidence.sql,
      ),
    ).toHaveLength(1);
    expect(databaseErrorTrace.preparedSql).toHaveLength(2);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();

    const preAbortedController = new AbortController();
    preAbortedController.abort();
    const preAbortedTrace = reportingTrace();
    const preAbortedDiagnostics = createD1ReadDiagnostics();
    await expect(
      productionRadarProvider(
        query,
        preAbortedTrace,
        preAbortedDiagnostics,
        reportingEnv(reportingDatabase, preAbortedTrace),
        preAbortedController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      preAbortedTrace.preparedSql.filter(
        (sql) => sql === candidate.evidence.sql,
      ),
    ).toHaveLength(0);
    expect(
      preAbortedDiagnostics.advancedCountSqlFallbackReason,
    ).toBeUndefined();

    const afterQueryController = new AbortController();
    const afterQueryTrace = reportingTrace();
    const afterQueryDiagnostics = createD1ReadDiagnostics();
    const abortingEnv = reportingEnvWithHooks(
      reportingDatabase,
      afterQueryTrace,
      {
        afterAll(sql) {
          if (sql === candidate.evidence.sql) afterQueryController.abort();
        },
      },
    );
    await expect(
      productionRadarProvider(
        query,
        afterQueryTrace,
        afterQueryDiagnostics,
        abortingEnv,
        afterQueryController.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      afterQueryTrace.preparedSql.filter(
        (sql) => sql === candidate.evidence.sql,
      ),
    ).toHaveLength(1);
    expect(afterQueryTrace.preparedSql).toHaveLength(2);
    expect(
      afterQueryDiagnostics.advancedCountSqlFallbackReason,
    ).toBeUndefined();
    writeEvidence(
      "radar-database-error-abort-traces.json",
      JSON.stringify(
        {
          databaseError: databaseErrorTrace.preparedSql,
          databaseErrorMessage: databaseError.message,
          preAborted: preAbortedTrace.preparedSql,
          preAbortedName: "AbortError",
          asyncAborted: afterQueryTrace.preparedSql,
          asyncAbortedName: "AbortError",
          fallbackReasons: [
            diagnostics.advancedCountSqlFallbackReason,
            preAbortedDiagnostics.advancedCountSqlFallbackReason,
            afterQueryDiagnostics.advancedCountSqlFallbackReason,
          ],
        },
        null,
        2,
      ),
    );
  });

  it("executes controls for an event-only empty Radar and rejects mismatched site context before SQL", async () => {
    reportingDatabase
      .prepare(
        `INSERT OR IGNORE INTO custom_event_names (site_id, name, last_seen_at, site_pk)
         VALUES (?, 'event-only', ?, ?)`,
      )
      .run(REPORTING_SITE, REPORTING_BASE + 80, reportingSitePk);
    const eventName = reportingDatabase
      .prepare(
        "SELECT id FROM custom_event_names WHERE site_pk = ? AND name = ?",
      )
      .get(reportingSitePk, "event-only") as { readonly id: number };
    reportingDatabase
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, 'gamma-session', ?, ?, ?, 1, 0, 0)`,
      )
      .run(
        "event-only-gamma-session",
        REPORTING_SITE,
        reportingSitePk,
        eventName.id,
        REPORTING_BASE + 80,
        REPORTING_BASE + 80,
      );
    for (const scope of ["session", "visitor"] as const) {
      const query = radarQuery(
        scope,
        "browser",
        undefined,
        'page.path neq "/excluded" and count(event { event.name eq "event-only" }) gte 1',
      );
      const candidate = await qualifiedRadarCandidate(query);
      expect(candidate.kind).toBe("compiled");
      if (candidate.kind !== "compiled") continue;
      const trace = reportingTrace();
      const diagnostics = createD1ReadDiagnostics();
      const actual = await productionRadarProvider(query, trace, diagnostics);
      const oracle = await legacyRadarReader(query, reportingTrace());
      expect(actual.value).toEqual(oracle);
      expect(actual.value).toEqual([]);
      expect(
        trace.preparedSql.filter((sql) => sql === candidate.evidence.sql),
      ).toHaveLength(1);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      writeEvidence(
        `radar-event-only-empty-${scope}.json`,
        JSON.stringify(
          {
            actual: actual.value,
            legacy: oracle,
            preparedSql: trace.preparedSql,
            fallbackReason: diagnostics.advancedCountSqlFallbackReason,
          },
          null,
          2,
        ),
      );
    }

    const mismatchedQuery = {
      ...radarQuery("session", "browser"),
      context: siteQueryContext(`${REPORTING_SITE}-other`, "private-dashboard"),
    } as RadarQuery;
    const mismatchTrace = reportingTrace();
    await expect(
      productionRadarProvider(mismatchedQuery, mismatchTrace),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "siteId", code: "radar_request_context_mismatch" }],
      },
    });
    expect(mismatchTrace.preparedSql).toHaveLength(0);
  });
});
