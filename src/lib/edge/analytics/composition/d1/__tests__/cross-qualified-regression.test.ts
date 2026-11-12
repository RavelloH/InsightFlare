import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type { QueryInput, QueryTime } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import type { TechnologyCrossDimensionQualificationConfiguration } from "@/lib/edge/analytics/engine/technology-cross-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredCrossDimensionQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as advancedFilterExecution from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { resolveCrossBreakdownPageDimension } from "@/lib/edge/analytics/providers/d1/internal/core-dimensions";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryCrossDimensionFromD1 } from "@/lib/edge/analytics/providers/d1/internal/technology/client-cross";
import { compileCrossQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/technology/cross-qualification-program";
import type { Env } from "@/lib/edge/types";
import { parseFilterDsl } from "@/lib/filter-contract";
import { analyticsFilterRegistry } from "@/lib/filter-contract/filter-registry";

const SITE = "wave96q-cross-registry";
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
const EVENT_SCOPE_FILTER_DSL =
  'page.path neq "/excluded" and (count(event { event.name eq "qualifier" }) gte 1 or not (page.path neq "/unmatched"))';
const EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_QUERY_EVIDENCE_DIR?.trim();

type Scope = "session" | "visitor" | "event";
type CrossRequest = QueryInput & {
  readonly time: QueryTime;
  readonly primaryDimension: string;
  readonly secondaryDimension: string;
  readonly primaryLimit: number;
  readonly secondaryLimit: number;
  readonly variant?: string;
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
  readonly referrer: string;
  readonly country: string;
  readonly event: boolean;
  readonly siteId?: string;
  readonly sitePk?: number;
}

interface QueryHooks {
  readonly beforeAll?: (sql: string) => void;
  readonly afterAll?: (sql: string) => void;
  readonly transformRows?: (
    sql: string,
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[];
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

function envWithHooks(
  db: DatabaseSync,
  queryTrace: SqliteD1Trace,
  hooks: QueryHooks,
): Env {
  const base = createSqliteD1Database(db, queryTrace);
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

function seedPage(page: SeedPage): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, browser, os,
        device_type, referrer_host, country
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'cross.test', ?, ?, ?, ?, ?)`,
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
      page.referrer,
      page.country,
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

function crossQuery(
  scope: Scope,
  dimensions: readonly [string, string] = ["browser", "operatingSystem"],
  variant?: string,
  limits: {
    readonly primaryLimit?: number;
    readonly secondaryLimit?: number;
  } = {},
  filterDsl = FILTER_DSL,
): CrossRequest {
  const filters = parseFilterDsl(filterDsl, analyticsFilterRegistry);
  const prepared = prepareScopedQuery("cross-dimension", {
    context: siteQueryContext(SITE, "private-dashboard"),
    time: TIME,
    filters,
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return {
    ...prepared,
    time: TIME,
    ...(variant === undefined ? {} : { variant }),
    primaryDimension: dimensions[0],
    secondaryDimension: dimensions[1],
    primaryLimit: limits.primaryLimit ?? 12,
    secondaryLimit: limits.secondaryLimit ?? 8,
  } as CrossRequest;
}

function eventCrossQueryWithReaderWindowMismatch(): CrossRequest {
  return crossQuery(
    "event",
    ["browser", "operatingSystem"],
    undefined,
    {},
    'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1',
  );
}

async function forwardCandidate(query: CrossRequest) {
  const candidateTrace = trace();
  const forwarded = await d1AdvancedFilterMiddleware(
    envFor(database, candidateTrace),
    undefined,
    SITE,
  )("cross-dimension", query, async (next) => next);
  const deferred = deferredCrossDimensionQualificationFromQuery(forwarded);
  expect(deferred).toBeDefined();
  if (!deferred) throw new Error("cross_qualification_candidate_missing");
  return { deferred, forwarded, candidateTrace };
}

async function compileCandidate(query: CrossRequest) {
  const { deferred, forwarded } = await forwardCandidate(query);
  const compilation = compileCrossQualificationProgram({
    deferred,
    query: forwarded,
    configuration: deferred.configuration,
  });
  return { deferred, compilation };
}

async function productionCrossQuery(
  query: CrossRequest,
  queryTrace: SqliteD1Trace,
  env = envFor(database, queryTrace),
  diagnostics?: D1ReadDiagnostics,
  signal?: AbortSignal,
) {
  const registry = createD1SiteProviderRegistry({
    env,
    siteId: SITE,
    ...(diagnostics ? { diagnostics } : {}),
  });
  const provider = registry.resolve("cross-dimension");
  if (!provider) throw new Error("cross_dimension_provider_missing");
  return provider.execute(query as never, signal ? { signal } : undefined);
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

function reverseDataProperties(value: object): Record<string, unknown> {
  const keys = Reflect.ownKeys(value) as string[];
  return Object.fromEntries(
    [...keys]
      .reverse()
      .map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value]),
  );
}

function copyDataProperties(value: object): Record<string, unknown> {
  const copy = Object.create(Object.getPrototypeOf(value)) as Record<
    string,
    unknown
  >;
  for (const key of Reflect.ownKeys(value) as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor))
      throw new Error("trusted_test_configuration_invalid");
    Object.defineProperty(copy, key, {
      value: descriptor.value,
      enumerable: descriptor.enumerable,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("Cross qualified provider regression", () => {
  beforeAll(() => {
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
         VALUES (?, 'wave96q-team', 'Cross qualification', 'cross.test', 0)`,
      )
      .run(SITE);
    database
      .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
      .run("wave96q-cross-other-site");
    otherSitePk = Number(
      (
        database
          .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
          .get("wave96q-cross-other-site") as { readonly site_pk: number }
      ).site_pk,
    );
    database
      .prepare(
        `INSERT INTO sites (id, team_id, name, domain, created_at)
         VALUES ('wave96q-cross-other-site', 'wave96q-team', 'Other site', 'other.test', 0)`,
      )
      .run();
    [
      {
        id: "alpha-linux",
        visitor: "alpha",
        session: "alpha-session-one",
        startedAt: BASE + 10,
        pathname: "/first",
        browser: "Chrome",
        os: "Linux",
        deviceType: "desktop",
        referrer: "news.example",
        event: true,
        country: "US",
      },
      {
        id: "alpha-windows",
        visitor: "alpha",
        session: "alpha-session-one",
        startedAt: BASE + 20,
        pathname: "/second",
        browser: "Chrome",
        os: "Windows",
        deviceType: "mobile",
        referrer: "docs.example",
        event: true,
        country: "CA",
      },
      {
        id: "alpha-return",
        visitor: "alpha",
        session: "alpha-session-two",
        startedAt: BASE + 30,
        pathname: "/third",
        browser: "Firefox",
        os: "Linux",
        deviceType: "desktop",
        referrer: "news.example",
        event: true,
        country: "US",
      },
      {
        id: "beta-session",
        visitor: "beta",
        session: "beta-session",
        startedAt: BASE + 40,
        pathname: "/fourth",
        browser: "Firefox",
        os: "Linux",
        deviceType: "tablet",
        referrer: "docs.example",
        event: true,
        country: "CA",
      },
      {
        id: "no-event",
        visitor: "unmatched",
        session: "unmatched-session",
        startedAt: BASE + 50,
        pathname: "/unmatched",
        browser: "Safari",
        os: "Mac",
        deviceType: "desktop",
        referrer: "other.example",
        event: false,
        country: "US",
      },
      {
        id: "outside-window",
        visitor: "outside",
        session: "outside-session",
        startedAt: BASE + 4 * 60 * 60 * 1000,
        pathname: "/outside",
        browser: "Outside",
        os: "Outside",
        deviceType: "desktop",
        referrer: "outside.example",
        event: true,
        country: "US",
      },
      {
        id: "alpha-unknown-secondary",
        visitor: "alpha",
        session: "alpha-session-two",
        startedAt: BASE + 60,
        pathname: "/unknown-secondary",
        browser: "Chrome",
        os: "",
        deviceType: "desktop",
        referrer: "news.example",
        country: "US",
        event: true,
      },
      {
        id: "empty-primary",
        visitor: "empty-primary",
        session: "empty-primary-session",
        startedAt: BASE + 70,
        pathname: "/empty-primary",
        browser: "   ",
        os: "macOS",
        deviceType: "desktop",
        referrer: "empty.example",
        country: "US",
        event: true,
      },
      {
        id: "edge-tie",
        visitor: "edge-tie",
        session: "edge-tie-session",
        startedAt: BASE + 75,
        pathname: "/edge-tie",
        browser: "Edge",
        os: "Linux",
        deviceType: "desktop",
        referrer: "tie.example",
        country: "GB",
        event: true,
      },
      {
        id: "safari-tie",
        visitor: "safari-tie",
        session: "safari-tie-session",
        startedAt: BASE + 76,
        pathname: "/safari-tie",
        browser: "Safari",
        os: "Linux",
        deviceType: "desktop",
        referrer: "tie.example",
        country: "GB",
        event: true,
      },
      {
        id: "unknown-token-collision",
        visitor: "token-collision",
        session: "token-collision-session",
        startedAt: BASE + 77,
        pathname: "/token-collision",
        browser: "Other",
        os: "__client_cross_unknown__",
        deviceType: "desktop",
        referrer: "collision.example",
        country: "US",
        event: true,
      },
      {
        id: "foreign-site",
        visitor: "foreign",
        session: "foreign-session",
        startedAt: BASE + 80,
        pathname: "/foreign",
        browser: "Foreign",
        os: "Foreign",
        deviceType: "desktop",
        referrer: "foreign.example",
        country: "FR",
        event: true,
        siteId: "wave96q-cross-other-site",
        sitePk: otherSitePk,
      },
    ].forEach(seedPage);
  });

  afterAll(() => database.close());

  it("accepts equivalent public compiler configurations regardless of key insertion order", async () => {
    const { deferred, forwarded, candidateTrace } = await forwardCandidate(
      crossQuery("session"),
    );
    const compile = (configuration: typeof deferred.configuration) =>
      compileCrossQualificationProgram({
        deferred,
        query: forwarded,
        configuration,
      });
    const statementsBeforeCompile = [...candidateTrace.preparedSql];
    const original = compile(deferred.configuration);
    expect(original.kind).toBe("compiled");
    if (original.kind !== "compiled") return;

    const reorderedConfiguration: Record<string, unknown> =
      reverseDataProperties(deferred.configuration);
    reorderedConfiguration.primarySelection = reverseDataProperties(
      (
        deferred.configuration as TechnologyCrossDimensionQualificationConfiguration
      ).primarySelection,
    );
    reorderedConfiguration.secondarySelection = reverseDataProperties(
      (
        deferred.configuration as TechnologyCrossDimensionQualificationConfiguration
      ).secondarySelection,
    );
    const reordered = compile(
      reorderedConfiguration as unknown as typeof deferred.configuration,
    );
    expect(reordered.kind).toBe("compiled");
    if (reordered.kind !== "compiled") return;
    expect(reordered.evidence.sql).toBe(original.evidence.sql);
    expect(reordered.evidence.bindings).toEqual(original.evidence.bindings);
    expect(reordered.evidence.outputDescriptors).toEqual(
      original.evidence.outputDescriptors,
    );
    expect(reordered.evidence.configuration).toBe(deferred.configuration);
    expect(candidateTrace.preparedSql).toEqual(statementsBeforeCompile);
    writeEvidence("cross-configuration-reordered-keys.json", {
      compiled: true,
      sqlEqual: reordered.evidence.sql === original.evidence.sql,
      bindingsEqual: reordered.evidence.bindings.every((value, index) =>
        Object.is(value, original.evidence.bindings[index]),
      ),
      outputDescriptorsEqual: true,
      outputDescriptors: reordered.evidence.outputDescriptors,
      trustedConfigurationUsed:
        reordered.evidence.configuration === deferred.configuration,
      middlewareStatementCount: statementsBeforeCompile.length,
    });
  });

  it("rejects a changing direct compiler limit getter without invoking it", async () => {
    const { deferred, forwarded, candidateTrace } = await forwardCandidate(
      crossQuery("session"),
    );
    const compile = (configuration: typeof deferred.configuration) =>
      compileCrossQualificationProgram({
        deferred,
        query: forwarded,
        configuration,
      });
    const primaryLimit = (
      deferred.configuration as TechnologyCrossDimensionQualificationConfiguration
    ).primaryLimit;
    let primaryLimitReads = 0;
    const changingConfiguration = copyDataProperties(deferred.configuration);
    Object.defineProperty(changingConfiguration, "primaryLimit", {
      enumerable: true,
      configurable: true,
      get() {
        primaryLimitReads += 1;
        return primaryLimitReads === 1 ? primaryLimit : primaryLimit + 1;
      },
    });
    const statementsBeforeCompile = [...candidateTrace.preparedSql];
    const error = captureError(() =>
      compile(
        changingConfiguration as unknown as typeof deferred.configuration,
      ),
    );
    expect(primaryLimitReads).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "cross_dimension_qualification_request_untrusted",
    );
    expect(candidateTrace.preparedSql).toEqual(statementsBeforeCompile);
    writeEvidence("cross-configuration-own-getter.json", {
      rejected: true,
      getterCalls: primaryLimitReads,
      middlewareStatementCount: statementsBeforeCompile.length,
    });
  });

  it("rejects selection accessors without invoking them", async () => {
    const { deferred, forwarded, candidateTrace } = await forwardCandidate(
      crossQuery("session"),
    );
    const compile = (configuration: typeof deferred.configuration) =>
      compileCrossQualificationProgram({
        deferred,
        query: forwarded,
        configuration,
      });
    let nestedSelectionReads = 0;
    const accessorSelection = copyDataProperties(
      (
        deferred.configuration as TechnologyCrossDimensionQualificationConfiguration
      ).primarySelection,
    );
    const primarySelectionId = (
      deferred.configuration as TechnologyCrossDimensionQualificationConfiguration
    ).primarySelection.id;
    Object.defineProperty(accessorSelection, "id", {
      enumerable: true,
      configurable: true,
      get() {
        nestedSelectionReads += 1;
        return primarySelectionId;
      },
    });
    const statementsBeforeCompile = [...candidateTrace.preparedSql];
    const nestedAccessorConfiguration = copyDataProperties(
      deferred.configuration,
    );
    nestedAccessorConfiguration.primarySelection = accessorSelection;
    const error = captureError(() =>
      compile(
        nestedAccessorConfiguration as unknown as typeof deferred.configuration,
      ),
    );
    expect(nestedSelectionReads).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "cross_dimension_qualification_request_untrusted",
    );
    expect(candidateTrace.preparedSql).toEqual(statementsBeforeCompile);
    writeEvidence("cross-configuration-selection-accessor.json", {
      rejected: true,
      getterCalls: nestedSelectionReads,
      middlewareStatementCount: statementsBeforeCompile.length,
    });
  });

  it("rejects custom selection toJSON without invoking it", async () => {
    const { deferred, forwarded, candidateTrace } = await forwardCandidate(
      crossQuery("session"),
    );
    const compile = (configuration: typeof deferred.configuration) =>
      compileCrossQualificationProgram({
        deferred,
        query: forwarded,
        configuration,
      });
    let toJSONCalls = 0;
    const toJSONSelection = copyDataProperties(
      (
        deferred.configuration as TechnologyCrossDimensionQualificationConfiguration
      ).primarySelection,
    );
    Object.defineProperty(toJSONSelection, "toJSON", {
      enumerable: true,
      configurable: true,
      value() {
        toJSONCalls += 1;
        return (
          deferred.configuration as TechnologyCrossDimensionQualificationConfiguration
        ).primarySelection;
      },
    });
    const toJSONConfiguration = copyDataProperties(deferred.configuration);
    toJSONConfiguration.primarySelection = toJSONSelection;
    const statementsBeforeCompile = [...candidateTrace.preparedSql];
    const error = captureError(() =>
      compile(toJSONConfiguration as unknown as typeof deferred.configuration),
    );
    expect(toJSONCalls).toBe(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "cross_dimension_qualification_request_untrusted",
    );
    expect(candidateTrace.preparedSql).toEqual(statementsBeforeCompile);
    writeEvidence("cross-configuration-selection-tojson.json", {
      rejected: true,
      toJSONCalls,
      middlewareStatementCount: statementsBeforeCompile.length,
    });
  });

  it("compiles and executes the same three-report Cross DTO through Count qualification", async () => {
    const comparisonRows: Record<string, unknown>[] = [];
    try {
      for (const reverseUnordered of [false, true]) {
        database.exec(
          `PRAGMA reverse_unordered_selects = ${reverseUnordered ? "ON" : "OFF"}`,
        );
        for (const scope of ["session", "visitor", "event"] as const) {
          const query = crossQuery(
            scope,
            ["browser", "operatingSystem"],
            undefined,
            {},
            scope === "event" ? EVENT_SCOPE_FILTER_DSL : FILTER_DSL,
          );
          const { deferred, compilation } = await compileCandidate(query);
          expect(compilation.kind).toBe("compiled");
          if (compilation.kind !== "compiled") continue;

          expect(
            compilation.evidence.outputDescriptors.map(
              (output) => output.rowType,
            ),
          ).toEqual(["primary", "secondary", "pair"]);
          expect(compilation.evidence.outputDescriptors).toHaveLength(3);
          expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
          expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);
          expect(compilation.evidence.groupWidth).toBeLessThanOrEqual(16);

          const actualTrace = trace();
          const actual = await productionCrossQuery(query, actualTrace);
          const fallbackFilters =
            await prepareDeferredEventQualificationFallback(
              deferred.qualification,
            );
          const oracleTrace = trace();
          const primary = resolveCrossBreakdownPageDimension("browser");
          const secondary =
            resolveCrossBreakdownPageDimension("operatingSystem");
          if (!primary || !secondary)
            throw new Error("cross_dimension_fixture_invalid");
          const expected = await queryCrossDimensionFromD1(
            envFor(database, oracleTrace),
            SITE,
            WINDOW,
            fallbackFilters,
            query.primaryLimit,
            query.secondaryLimit,
            primary,
            secondary,
          );
          expect(actual.value).toEqual(expected);
          expect(actualTrace.preparedSql).toHaveLength(2);
          expect(
            actualTrace.preparedSql.filter(
              (sql) => sql === compilation.evidence.sql,
            ),
          ).toHaveLength(1);
          expect(actualTrace.bindings).toHaveLength(2);
          expect(
            (
              actual.value as { columns: readonly { isUnknown?: boolean }[] }
            ).columns.some((column) => column.isUnknown),
          ).toBe(true);
          comparisonRows.push({
            scope,
            reverseUnordered,
            sql: compilation.evidence.sql,
            sqlBytes: compilation.evidence.sqlBytes,
            bindings: compilation.evidence.bindings,
            bindingCount: compilation.evidence.bindingCount,
            groupWidth: compilation.evidence.groupWidth,
            sharedRelationCount: compilation.evidence.sharedRelationCount,
            outputDescriptors: compilation.evidence.outputDescriptors,
            actualTrace: {
              preparedSql: actualTrace.preparedSql,
              bindings: actualTrace.bindings,
            },
            oracleTrace: {
              preparedSql: oracleTrace.preparedSql,
              bindings: oracleTrace.bindings,
            },
            actual: actual.value,
            expected,
          });
        }
      }
    } finally {
      database.exec("PRAGMA reverse_unordered_selects = OFF");
    }
    writeEvidence(
      "cross-qualified-initial-registry-comparisons.json",
      comparisonRows,
    );
  });

  it("97DQ: qualifies mixed NOT generic Cross filters through the legacy DTO reader", async () => {
    const filterDsl =
      'not (page.path eq "/unmatched" and count(event { event.name eq "qualifier" }) gte 1)';
    const query = crossQuery(
      "session",
      ["browser", "operatingSystem"],
      "generic",
      {},
      filterDsl,
    );
    const { deferred, compilation } = await compileCandidate(query);
    expect(compilation.kind).toBe("compiled");
    if (compilation.kind !== "compiled") return;
    expect(deferred.qualification.technologyFilterMode).toBe(
      "allow-whole-filter",
    );
    expect(
      deferred.qualification.metadata.plan.preparedMembership,
    ).toBeUndefined();
    expect(compilation.evidence.outputDescriptors).toHaveLength(3);
    expect(compilation.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
    expect(compilation.evidence.bindingCount).toBeLessThanOrEqual(100);

    const actualTrace = trace();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await productionCrossQuery(
      query,
      actualTrace,
      envFor(database, actualTrace),
      diagnostics,
    );
    const fallbackFilters = await prepareDeferredEventQualificationFallback(
      deferred.qualification,
    );
    const primary = resolveCrossBreakdownPageDimension("browser");
    const secondary = resolveCrossBreakdownPageDimension("operatingSystem");
    if (!primary || !secondary)
      throw new Error("cross_dimension_fixture_invalid");
    const oracleTrace = trace();
    const oracle = await queryCrossDimensionFromD1(
      envFor(database, oracleTrace),
      SITE,
      WINDOW,
      fallbackFilters,
      query.primaryLimit,
      query.secondaryLimit,
      primary,
      secondary,
    );

    const andCandidate = await forwardCandidate(
      crossQuery("session", ["browser", "operatingSystem"], "generic"),
    );
    const andFilters = await prepareDeferredEventQualificationFallback(
      andCandidate.deferred.qualification,
    );
    const andBaseline = await queryCrossDimensionFromD1(
      envFor(database, trace()),
      SITE,
      WINDOW,
      andFilters,
      query.primaryLimit,
      query.secondaryLimit,
      primary,
      secondary,
    );
    expect(actual.value).toEqual(oracle);
    expect(actual.value).not.toEqual(andBaseline);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(actualTrace.preparedSql).toHaveLength(2);
    expect(actualTrace.preparedSql).toContain(compilation.evidence.sql);
    writeEvidence("97dq-cross-generic-mixed-not.json", {
      operation: "cross-dimension",
      variant: "generic",
      scope: "session",
      filterDsl,
      mode: deferred.qualification.technologyFilterMode,
      countScope: deferred.qualification.metadata.plan.scope,
      preparedMembership:
        deferred.qualification.metadata.plan.preparedMembership,
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

  it("qualifies stored and derived dimensions and preserves TopN, Other, aliases, and row ties", async () => {
    const records: Record<string, unknown>[] = [];
    for (const scope of ["session", "visitor"] as const) {
      const query = crossQuery(
        scope,
        ["referrer.domain", "geo.country"],
        "generic",
      );
      const { deferred, compilation } = await compileCandidate(query);
      expect(compilation.kind).toBe("compiled");
      if (compilation.kind !== "compiled") continue;
      const actualTrace = trace();
      const actual = await productionCrossQuery(query, actualTrace);
      const fallbackFilters = await prepareDeferredEventQualificationFallback(
        deferred.qualification,
      );
      const primary = resolveCrossBreakdownPageDimension("referrer.domain");
      const secondary = resolveCrossBreakdownPageDimension("geo.country");
      if (!primary || !secondary)
        throw new Error("cross_derived_dimension_fixture_invalid");
      const expected = await queryCrossDimensionFromD1(
        envFor(database, trace()),
        SITE,
        WINDOW,
        fallbackFilters,
        query.primaryLimit,
        query.secondaryLimit,
        primary,
        secondary,
      );
      expect(actual.value).toEqual(expected);
      expect(actualTrace.preparedSql).toHaveLength(2);
      expect(actualTrace.preparedSql[1]).toBe(compilation.evidence.sql);
      records.push({
        scope,
        dimensions: [query.primaryDimension, query.secondaryDimension],
        sql: compilation.evidence.sql,
        sqlBytes: compilation.evidence.sqlBytes,
        bindingCount: compilation.evidence.bindingCount,
        groupWidth: compilation.evidence.groupWidth,
        actual: actual.value,
        expected,
      });
    }

    const topNQuery = crossQuery(
      "visitor",
      ["browser", "operatingSystem"],
      undefined,
      { primaryLimit: 1, secondaryLimit: 1 },
    );
    const topNCandidate = await compileCandidate(topNQuery);
    expect(topNCandidate.compilation.kind).toBe("compiled");
    if (topNCandidate.compilation.kind === "compiled") {
      const actualTrace = trace();
      const actual = await productionCrossQuery(topNQuery, actualTrace);
      const filters = await prepareDeferredEventQualificationFallback(
        topNCandidate.deferred.qualification,
      );
      const primary = resolveCrossBreakdownPageDimension("browser");
      const secondary = resolveCrossBreakdownPageDimension("operatingSystem");
      if (!primary || !secondary)
        throw new Error("cross_topn_dimension_fixture_invalid");
      const expected = await queryCrossDimensionFromD1(
        envFor(database, trace()),
        SITE,
        WINDOW,
        filters,
        topNQuery.primaryLimit,
        topNQuery.secondaryLimit,
        primary,
        secondary,
      );
      expect(actual.value).toEqual(expected);
      const matrix = actual.value as {
        readonly rows: readonly {
          readonly label: string;
          readonly isOther?: boolean;
        }[];
        readonly columns: readonly {
          readonly label: string;
          readonly isOther?: boolean;
        }[];
      };
      expect(matrix.rows[0]?.label).toBe("Firefox");
      expect(matrix.rows.at(-1)).toMatchObject({
        label: "Other",
        isOther: true,
      });
      expect(matrix.columns.at(-1)).toMatchObject({
        label: "Other",
        isOther: true,
      });
      records.push({
        scope: "visitor",
        limits: [1, 1],
        sql: topNCandidate.compilation.evidence.sql,
        actual: actual.value,
        expected,
      });
    }

    const tiesQuery = crossQuery("visitor");
    const tiesCandidate = await compileCandidate(tiesQuery);
    expect(tiesCandidate.compilation.kind).toBe("compiled");
    const tiesTrace = trace();
    const tiesActual = await productionCrossQuery(tiesQuery, tiesTrace);
    const tieFallback = await prepareDeferredEventQualificationFallback(
      tiesCandidate.deferred.qualification,
    );
    const tiePrimary = resolveCrossBreakdownPageDimension("browser");
    const tieSecondary = resolveCrossBreakdownPageDimension("operatingSystem");
    if (!tiePrimary || !tieSecondary)
      throw new Error("cross_tie_dimension_fixture_invalid");
    expect(tiesActual.value).toEqual(
      await queryCrossDimensionFromD1(
        envFor(database, trace()),
        SITE,
        WINDOW,
        tieFallback,
        tiesQuery.primaryLimit,
        tiesQuery.secondaryLimit,
        tiePrimary,
        tieSecondary,
      ),
    );
    const tieMatrix = tiesActual.value as {
      readonly rows: readonly { readonly label: string }[];
      readonly columns: readonly { readonly label: string }[];
    };
    const tiedLabels = tieMatrix.rows.map((row) => row.label);
    expect(
      tieMatrix.columns.filter((column) => column.label === "Unknown"),
    ).toHaveLength(1);
    expect(tiedLabels.indexOf("Edge")).toBeLessThan(
      tiedLabels.indexOf("Safari"),
    );
    records.push({
      tieOrder: tiedLabels,
      sql:
        tiesCandidate.compilation.kind === "compiled"
          ? tiesCandidate.compilation.evidence.sql
          : null,
    });

    const aliasQuery = crossQuery("session", ["browser", "client.browser"]);
    const aliasCandidate = await compileCandidate(aliasQuery);
    expect(aliasCandidate.compilation.kind).toBe("compiled");
    const aliasTrace = trace();
    const aliasActual = await productionCrossQuery(aliasQuery, aliasTrace);
    const aliasFallback = await prepareDeferredEventQualificationFallback(
      aliasCandidate.deferred.qualification,
    );
    const aliasPrimary = resolveCrossBreakdownPageDimension("browser");
    const aliasSecondary = resolveCrossBreakdownPageDimension("client.browser");
    if (!aliasPrimary || !aliasSecondary)
      throw new Error("cross_alias_dimension_fixture_invalid");
    expect(aliasActual.value).toEqual(
      await queryCrossDimensionFromD1(
        envFor(database, trace()),
        SITE,
        WINDOW,
        aliasFallback,
        aliasQuery.primaryLimit,
        aliasQuery.secondaryLimit,
        aliasPrimary,
        aliasSecondary,
      ),
    );
    records.push({
      dimensions: [aliasQuery.primaryDimension, aliasQuery.secondaryDimension],
      sameSelection: true,
      sql:
        aliasCandidate.compilation.kind === "compiled"
          ? aliasCandidate.compilation.evidence.sql
          : null,
      actual: aliasActual.value,
    });
    writeEvidence("cross-qualified-dimensions-and-topn.json", records);
  });

  it("keeps empty reports and invalid or legacy Cross requests on their original paths", async () => {
    const emptyQuery = crossQuery(
      "session",
      ["browser", "operatingSystem"],
      undefined,
      {},
      'page.path neq "/excluded" and count(event { event.name eq "missing" }) gte 1',
    );
    const emptyCandidate = await compileCandidate(emptyQuery);
    expect(emptyCandidate.compilation.kind).toBe("compiled");
    const emptyTrace = trace();
    const emptyActual = await productionCrossQuery(emptyQuery, emptyTrace);
    expect(emptyActual.value).toEqual({
      columns: [],
      rows: [],
      totalVisitors: 0,
    });
    if (emptyCandidate.compilation.kind === "compiled") {
      expect(emptyTrace.preparedSql).toEqual([
        emptyTrace.preparedSql[0],
        emptyCandidate.compilation.evidence.sql,
      ]);
      writeEvidence("cross-qualified-empty-control.json", {
        sql: emptyCandidate.compilation.evidence.sql,
        outputDescriptors:
          emptyCandidate.compilation.evidence.outputDescriptors,
        actualTrace: emptyTrace.preparedSql,
        value: emptyActual.value,
      });
    }

    const sameRawDimension = crossQuery("session", ["browser", "browser"]);
    const sameTrace = trace();
    await expect(
      productionCrossQuery(sameRawDimension, sameTrace),
    ).rejects.toThrow("unsupported-dimension");

    const fractionalLimit = {
      ...crossQuery("session"),
      primaryLimit: 1.5,
    } as CrossRequest;
    await expect(
      productionCrossQuery(fractionalLimit, trace()),
    ).rejects.toThrow("logical_builder_invalid_limit");

    const clampedLimit = crossQuery(
      "session",
      ["browser", "operatingSystem"],
      undefined,
      { primaryLimit: -4, secondaryLimit: 100 },
    );
    const clampedCandidate = await compileCandidate(clampedLimit);
    expect(clampedCandidate.compilation.kind).toBe("compiled");
    const clampedTrace = trace();
    const clampedActual = await productionCrossQuery(
      clampedLimit,
      clampedTrace,
    );
    const clampedFilters = await prepareDeferredEventQualificationFallback(
      clampedCandidate.deferred.qualification,
    );
    const clampedPrimary = resolveCrossBreakdownPageDimension("browser");
    const clampedSecondary =
      resolveCrossBreakdownPageDimension("operatingSystem");
    if (!clampedPrimary || !clampedSecondary)
      throw new Error("cross_clamped_limit_fixture_invalid");
    expect(clampedActual.value).toEqual(
      await queryCrossDimensionFromD1(
        envFor(database, trace()),
        SITE,
        WINDOW,
        clampedFilters,
        clampedLimit.primaryLimit,
        clampedLimit.secondaryLimit,
        clampedPrimary,
        clampedSecondary,
      ),
    );

    const browserVariant = crossQuery("session", undefined, "browser");
    const forwarded = await d1AdvancedFilterMiddleware(
      envFor(database, trace()),
      undefined,
      SITE,
    )("cross-dimension", browserVariant, async (next) => next);
    expect(
      deferredCrossDimensionQualificationFromQuery(forwarded),
    ).toBeUndefined();
    const browserTrace = trace();
    await productionCrossQuery(browserVariant, browserTrace);
    expect(browserTrace.preparedSql.length).toBeGreaterThan(1);
    expect(browserTrace.preparedSql).not.toContain(
      emptyCandidate.compilation.kind === "compiled"
        ? emptyCandidate.compilation.evidence.sql
        : "",
    );
  });

  it.each(["session", "event"] as const)(
    "uses the complete numeric fallback for %s Count",
    async (scope) => {
      const numericQuery = crossQuery(
        scope,
        ["browser", "operatingSystem"],
        undefined,
        {},
        scope === "event"
          ? 'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1'
          : 'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) eq 1 and count(page { page.durationMs gt 5 }) eq 1',
      );
      const numericCandidate = await compileCandidate(numericQuery);
      expect(numericCandidate.compilation.kind).toBe("compiled");
      if (numericCandidate.compilation.kind !== "compiled") return;
      expect(
        numericCandidate.compilation.evidence.outputDescriptors,
      ).toHaveLength(3);
      expect(numericCandidate.deferred.qualification.countInput.scope).toBe(
        scope,
      );
      if (scope === "event")
        expect(
          "eventCandidateReportProjection" in
            numericCandidate.deferred.qualification
            ? numericCandidate.deferred.qualification
                .eventCandidateReportProjection
            : undefined,
        ).toBe("page-visits");
      const numericSql = numericCandidate.compilation.evidence.sql;

      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", "edge-tie");
      try {
        const diagnostics = createD1ReadDiagnostics();
        const actualTrace = trace();
        let envelopeRows: readonly Record<string, unknown>[] = [];
        const actual = await productionCrossQuery(
          numericQuery,
          actualTrace,
          envWithHooks(database, actualTrace, {
            transformRows(sql, rows) {
              if (sql === numericSql) envelopeRows = rows;
              return rows;
            },
          }),
          diagnostics,
        );
        const fallbackFilters = await prepareDeferredEventQualificationFallback(
          numericCandidate.deferred.qualification,
        );
        const primary = resolveCrossBreakdownPageDimension("browser");
        const secondary = resolveCrossBreakdownPageDimension("operatingSystem");
        if (!primary || !secondary)
          throw new Error("cross_numeric_fallback_fixture_invalid");
        const expected = await queryCrossDimensionFromD1(
          envFor(database, trace()),
          SITE,
          WINDOW,
          fallbackFilters,
          numericQuery.primaryLimit,
          numericQuery.secondaryLimit,
          primary,
          secondary,
        );
        expect(actual.value).toEqual(expected);
        expect(
          envelopeRows.filter((row) => row.rowKind === "report"),
        ).toHaveLength(0);
        expect(
          envelopeRows.filter((row) => row.rowKind === "control"),
        ).toHaveLength(1);
        if (scope === "event") {
          const compatibilitySql = actualTrace.preparedSql.at(-1);
          expect(compatibilitySql).toContain("visit_id");
          expect(compatibilitySql).not.toContain("entity_id");
        }
        expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
          kind: "numeric-data-domain",
          fieldIds: ["page.durationMs"],
        });
        expect(
          actualTrace.preparedSql.filter((sql) => sql === numericSql),
        ).toHaveLength(1);
        expect(actualTrace.preparedSql.length).toBeGreaterThan(2);
        writeEvidence(`cross-qualified-numeric-fallback-${scope}.json`, {
          envelopeRows,
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
          compiledSql: numericSql,
          actualSql: actualTrace.preparedSql,
          actual: actual.value,
          expected,
        });
      } finally {
        database
          .prepare("UPDATE visits SET duration_ms = NULL WHERE visit_id = ?")
          .run("edge-tie");
      }
    },
  );

  it("keeps the reader-window fallback when the reader domains differ", async () => {
    const query = eventCrossQueryWithReaderWindowMismatch();
    const candidate = await compileCandidate(query);
    expect(candidate.compilation.kind).toBe("compiled");
    if (candidate.compilation.kind !== "compiled") return;
    const originalDuration = database
      .prepare("SELECT duration_ms FROM visits WHERE visit_id = ?")
      .get("edge-tie") as { readonly duration_ms: number | string | null };
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "edge-tie");
    const preparePageVisit =
      advancedFilterExecution.prepareDeferredPageVisitQualification;
    const pagePreparationSpy = vi.spyOn(
      advancedFilterExecution,
      "prepareDeferredPageVisitQualification",
    );
    pagePreparationSpy.mockImplementation((deferred, consumerKey, options) =>
      preparePageVisit(deferred, consumerKey, {
        ...options,
        readerQueryTime: {
          ...query.time,
          filterRange: {
            startMs: query.time.range.startMs,
            endExclusiveMs: query.time.range.endExclusiveMs,
          },
        },
      }),
    );
    const fallbackSpy = vi.spyOn(
      advancedFilterExecution,
      "prepareDeferredEventQualificationFallback",
    );
    try {
      const diagnostics = createD1ReadDiagnostics();
      const actualTrace = trace();
      const actual = await productionCrossQuery(
        query,
        actualTrace,
        envFor(database, actualTrace),
        diagnostics,
      );
      expect(pagePreparationSpy).toHaveBeenCalledTimes(1);
      await expect(
        pagePreparationSpy.mock.results[0]?.value,
      ).resolves.toBeUndefined();
      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      const fallbackFilters = await prepareDeferredEventQualificationFallback(
        candidate.deferred.qualification,
      );
      const primary = resolveCrossBreakdownPageDimension("browser");
      const secondary = resolveCrossBreakdownPageDimension("operatingSystem");
      if (!primary || !secondary)
        throw new Error("cross_reader_window_mismatch_fixture_invalid");
      const expected = await queryCrossDimensionFromD1(
        envFor(database, trace()),
        SITE,
        WINDOW,
        fallbackFilters,
        query.primaryLimit,
        query.secondaryLimit,
        primary,
        secondary,
      );
      expect(actual.value).toEqual(expected);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
      });
    } finally {
      pagePreparationSpy.mockRestore();
      fallbackSpy.mockRestore();
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run(originalDuration.duration_ms, "edge-tie");
    }
  });

  it("rejects malformed Cross output without retry", async () => {
    const ordinaryQuery = crossQuery("session");
    const ordinaryCandidate = await compileCandidate(ordinaryQuery);
    expect(ordinaryCandidate.compilation.kind).toBe("compiled");
    if (ordinaryCandidate.compilation.kind !== "compiled") return;
    const ordinarySql = ordinaryCandidate.compilation.evidence.sql;
    const outputError = new Error("cross_qualification_database_failure");
    const errorTrace = trace();
    const diagnostics = createD1ReadDiagnostics();
    const errorEnv = envWithHooks(database, errorTrace, {
      beforeAll(sql) {
        if (sql === ordinarySql) throw outputError;
      },
    });
    await expect(
      productionCrossQuery(ordinaryQuery, errorTrace, errorEnv, diagnostics),
    ).rejects.toBe(outputError);
    expect(errorTrace.preparedSql).toHaveLength(2);
    expect(
      errorTrace.preparedSql.filter((sql) => sql === ordinarySql),
    ).toHaveLength(1);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();

    const malformedTrace = trace();
    const malformedEnv = envWithHooks(database, malformedTrace, {
      transformRows(sql, rows) {
        if (sql !== ordinarySql) return rows;
        return rows.filter((row) => row.rowKind !== "control");
      },
    });
    await expect(
      productionCrossQuery(ordinaryQuery, malformedTrace, malformedEnv),
    ).rejects.toThrow("cross_dimension_qualification_control_row_invalid");
    expect(malformedTrace.preparedSql).toHaveLength(2);
    expect(
      malformedTrace.preparedSql.filter((sql) => sql === ordinarySql),
    ).toHaveLength(1);

    const mismatchedOutputTrace = trace();
    const mismatchedOutputEnv = envWithHooks(database, mismatchedOutputTrace, {
      transformRows(sql, rows) {
        if (sql !== ordinarySql) return rows;
        return rows.map((row) =>
          row.rowKind === "report" &&
          row.outputId === "technology-cross-primary"
            ? { ...row, outputId: "technology-cross-secondary" }
            : row,
        );
      },
    });
    await expect(
      productionCrossQuery(
        ordinaryQuery,
        mismatchedOutputTrace,
        mismatchedOutputEnv,
      ),
    ).rejects.toThrow("cross_dimension_qualification_report_row_invalid");
    expect(mismatchedOutputTrace.preparedSql).toHaveLength(2);

    const mismatch = {
      ...ordinaryQuery,
      context: siteQueryContext(
        "wave96q-cross-other-site",
        "private-dashboard",
      ),
    } as CrossRequest;
    const mismatchTrace = trace();
    await expect(
      productionCrossQuery(mismatch, mismatchTrace),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [
          { path: "siteId", code: "cross_dimension_request_context_mismatch" },
        ],
      },
    });
    expect(mismatchTrace.preparedSql).toHaveLength(0);

    const aborted = new AbortController();
    aborted.abort();
    const abortedTrace = trace();
    const abortDiagnostics = createD1ReadDiagnostics();
    await expect(
      productionCrossQuery(
        ordinaryQuery,
        abortedTrace,
        envFor(database, abortedTrace),
        abortDiagnostics,
        aborted.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      abortedTrace.preparedSql.filter((sql) => sql === ordinarySql),
    ).toHaveLength(0);
    expect(abortDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();

    const mutationTrace = trace();
    const forwarded = await d1AdvancedFilterMiddleware(
      envFor(database, mutationTrace),
      undefined,
      SITE,
    )("cross-dimension", ordinaryQuery, async (next) => next);
    const deferred = deferredCrossDimensionQualificationFromQuery(forwarded);
    expect(deferred).toBeDefined();
    if (!deferred) return;
    const priorSql = [...mutationTrace.preparedSql];
    (forwarded as Record<string, unknown>).primaryDimension = "operatingSystem";
    expect(() =>
      deferredCrossDimensionQualificationFromQuery(forwarded),
    ).toThrow("cross_dimension_qualification_request_changed");
    expect(mutationTrace.preparedSql).toEqual(priorSql);
    writeEvidence("cross-qualified-error-boundaries.json", {
      databaseErrorSql: errorTrace.preparedSql,
      malformedControlSql: malformedTrace.preparedSql,
      mismatchedOutputSql: mismatchedOutputTrace.preparedSql,
      siteMismatchSql: mismatchTrace.preparedSql,
      preAbortedSql: abortedTrace.preparedSql,
      mutationSqlBeforeCheck: priorSql,
      fallbackReasons: [
        diagnostics.advancedCountSqlFallbackReason,
        abortDiagnostics.advancedCountSqlFallbackReason,
      ],
    });
  });
});
