import { mkdir, writeFile } from "node:fs/promises";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { D1_MAX_BOUND_PARAMETERS, D1_MAX_SQL_UTF8_BYTES } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  prepareScopedQuery,
  type QueryInput,
  type QueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { comparisonPageTab } from "@/lib/edge/analytics/engine/comparison-page-tabs";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredComparisonPageQualificationFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  decodeComparisonDimensionCursor,
  queryComparisonDimensionPageFromD1,
  tryQueryQualifiedComparisonDimensionPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/comparison-dimensions";
import { comparisonReportFamilyForTab } from "@/lib/edge/analytics/providers/d1/internal/comparison-report-family";
import {
  createD1ReadDiagnostics,
  type D1ReadDiagnostics,
} from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave95w-comparison-page";
const CURRENT_TIME = createQueryTime(100, 200, "UTC", 400);
const REFERENCE_TIME = createQueryTime(200, 300, "UTC", 400);
const CURRENT_WINDOW = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 400,
  timeZone: "UTC",
} as const;
const REFERENCE_WINDOW = {
  startMs: 200,
  endExclusiveMs: 300,
  nowMs: 400,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave95w-comparison-page-test-secret";
const BASE_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
const databases = new Set<DatabaseSync>();
const evidence: Array<Record<string, unknown>> = [];

interface ComparisonQuery extends QueryInput {
  readonly mode: "overview-tab";
  readonly time: QueryTime;
  readonly tab: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
  readonly search?: string;
  readonly current: {
    readonly time: QueryTime;
    readonly filters: NonNullable<QueryInput["filters"]>;
  };
  readonly reference: {
    readonly time: QueryTime;
    readonly filters: NonNullable<QueryInput["filters"]>;
  };
  readonly comparison: {
    readonly current: ComparisonQuery["current"];
    readonly reference: ComparisonQuery["reference"];
    readonly metric: "views" | "sessions" | "visitors";
    readonly sortBy: "current" | "reference" | "change";
    readonly direction: "asc" | "desc";
  };
}

interface ComparisonTestOptions {
  readonly tab?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly search?: string;
  readonly metric?: "views" | "sessions" | "visitors";
  readonly sortBy?: "current" | "reference" | "change";
  readonly direction?: "asc" | "desc";
  readonly audience?: "private-dashboard" | "api-v1" | "public-share";
  readonly currentScope?: "event" | "session" | "visitor";
  readonly referenceScope?: "event" | "session" | "visitor";
  readonly currentFilterDsl?: string;
  readonly referenceFilterDsl?: string;
}

interface OneSidedComparisonTestOptions extends ComparisonTestOptions {
  readonly qualifiedSide: "current" | "reference";
  readonly qualifiedScope: "session" | "visitor";
  readonly qualifiedFilterDsl?: string;
  readonly nativeFilterDsl?: string;
}

function traceFor(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function seedSide(
  database: DatabaseSync,
  side: "current" | "reference",
  viewsForKey: (keyIndex: number) => number,
  startedAt: number,
): void {
  for (let keyIndex = 0; keyIndex < 8; keyIndex += 1) {
    const views = viewsForKey(keyIndex);
    for (let occurrence = 0; occurrence < views; occurrence += 1) {
      const visitId = `${side}-visit-${keyIndex}-${occurrence}`;
      const sessionId = `${side}-session-${keyIndex}-${Math.floor(occurrence / 2)}`;
      const visitorId = `${side}-visitor-${keyIndex}-${Math.floor(occurrence / 3)}`;
      database
        .prepare(
          `INSERT INTO visits (
            visit_id, site_id, site_pk, visitor_id, session_id, status,
            started_at, last_activity_at, pathname, query_string, title,
            hostname, timezone, as_organization, duration_ms
          ) VALUES (?, ?, 1, ?, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, 25)`,
        )
        .run(
          visitId,
          SITE,
          visitorId,
          sessionId,
          startedAt,
          startedAt,
          `/p${keyIndex}`,
          `k=${keyIndex}`,
          `Title ${keyIndex}`,
          `host-${keyIndex % 3}.example`,
          keyIndex % 2 === 0 ? "UTC" : "Etc/GMT",
          `Org ${keyIndex % 4}`,
        );
      database
        .prepare(
          `INSERT INTO custom_events (
            event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
            received_at, sequence, node_count, value_count
          ) VALUES (?, ?, 1, ?, 1, ?, ?, 1, 0, 0)`,
        )
        .run(
          `${side}-event-${keyIndex}-${occurrence}`,
          SITE,
          visitId,
          startedAt + 1,
          startedAt + 1,
        );
    }
  }
}

function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(SITE);
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave95w-team', 'Comparison page qualification', 'compare.test', 0)`,
    )
    .run(SITE);
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', 250, 1)`,
    )
    .run(SITE);
  seedSide(database, "current", (key) => key + 1, 110);
  seedSide(database, "reference", (key) => 8 - key, 210);
  return database;
}

function seedWholeBooleanProofRows(
  database: DatabaseSync,
  side: "current" | "reference",
): void {
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, query_string, title,
      hostname, timezone, as_organization, duration_ms
    ) VALUES (?, ?, 1, ?, ?, 'closed', ?, ?, ?, '', '', 'proof.example', 'UTC', '', 1)`,
  );
  const insertQualifier = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, 1, ?, 1, ?, ?, 1, 0, 0)`,
  );
  const add = (input: {
    readonly suffix: string;
    readonly pathname: string;
    readonly startedAt: number;
    readonly sessionId?: string;
    readonly visitorId?: string;
    readonly qualifier: boolean;
  }) => {
    const visitId = `${side}-boolean-${input.suffix}`;
    insertVisit.run(
      visitId,
      SITE,
      input.visitorId ?? `${visitId}-visitor`,
      input.sessionId ?? `${visitId}-session`,
      input.startedAt,
      input.startedAt,
      input.pathname,
    );
    if (input.qualifier)
      insertQualifier.run(
        `${visitId}-qualifier`,
        SITE,
        visitId,
        input.startedAt + 1,
        input.startedAt + 1,
      );
  };

  if (side === "current") {
    add({
      suffix: "native-only",
      pathname: "/current-only",
      startedAt: 111,
      qualifier: false,
    });
    add({
      suffix: "count-only",
      pathname: "/count-only",
      startedAt: 112,
      qualifier: true,
    });
    return;
  }

  add({
    suffix: "not-true",
    pathname: "/excluded",
    startedAt: 211,
    qualifier: false,
  });
  add({
    suffix: "not-false",
    pathname: "/excluded",
    startedAt: 212,
    qualifier: true,
  });
}

function wholeBooleanFixtureOwnerRows(
  database: DatabaseSync,
  side: "current" | "reference",
): Record<string, unknown>[] {
  return database
    .prepare(
      `SELECT v.visit_id, v.pathname, v.started_at, v.session_id, v.visitor_id,
              COUNT(c.event_id) AS qualifier_count
       FROM visits AS v
       LEFT JOIN custom_events AS c
         ON c.visit_id = v.visit_id AND c.event_name_id = 1
       WHERE v.site_id = ? AND v.visit_id LIKE ?
       GROUP BY v.visit_id
       ORDER BY v.started_at, v.visit_id`,
    )
    .all(SITE, `${side}-boolean-%`) as Record<string, unknown>[];
}

function comparisonExecutionShape(
  trace: SqliteD1Trace,
  diagnostics: D1ReadDiagnostics,
) {
  const metadataIndexes = trace.preparedSql.flatMap((sql, index) =>
    /^\s*SELECT\b[\s\S]*?\bFROM\s+(?:"sites"(?=\s)|sites\b)/iu.test(sql)
      ? [index]
      : [],
  );
  const metadataIndexSet = new Set(metadataIndexes);
  return {
    statementCount: trace.preparedSql.length,
    metadataQueryCount: metadataIndexes.length,
    factQueryCount: trace.preparedSql.length - metadataIndexes.length,
    metadataQueries: metadataIndexes.map((index) => trace.preparedSql[index]),
    factQueries: trace.preparedSql.flatMap((sql, index) =>
      metadataIndexSet.has(index) ? [] : [sql],
    ),
    sqlUtf8Bytes: trace.preparedSql.map(
      (sql) => new TextEncoder().encode(sql).byteLength,
    ),
    bindingCounts: trace.bindings.map((bindings) => bindings.length),
    sqlUtf8ByteLimit: D1_MAX_SQL_UTF8_BYTES,
    bindingLimit: D1_MAX_BOUND_PARAMETERS,
    requestedScope: diagnostics.requestedScope,
    resolvedScope: diagnostics.resolvedScope,
    requiredSources: diagnostics.requiredSources,
    requiresRawSource: diagnostics.requiresRawSource,
  };
}

function addQualifyingVisits(
  database: DatabaseSync,
  input: {
    readonly prefix: string;
    readonly count: number;
    readonly at: number;
  },
): void {
  const insertVisit = database.prepare(
    `INSERT INTO visits (
      visit_id, site_id, site_pk, visitor_id, session_id, status,
      started_at, last_activity_at, pathname, query_string, title,
      hostname, timezone, as_organization, duration_ms
    ) VALUES (?, ?, 1, ?, ?, 'closed', ?, ?, ?, '', ?, 'bulk.example', 'UTC', 'Bulk', 1)`,
  );
  const insert = database.prepare(
    `INSERT INTO custom_events (
      event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
      received_at, sequence, node_count, value_count
    ) VALUES (?, ?, 1, ?, 1, ?, ?, ?, 0, 0)`,
  );
  database.exec("BEGIN");
  try {
    for (let index = 0; index < input.count; index += 1) {
      const visitId = `${input.prefix}-visit-${index}`;
      insertVisit.run(
        visitId,
        SITE,
        `${input.prefix}-visitor-${index}`,
        `${input.prefix}-session-${index}`,
        input.at,
        input.at,
        `/bulk-${input.prefix}`,
        `Bulk ${input.prefix}`,
      );
      insert.run(
        `${input.prefix}-${index}`,
        SITE,
        visitId,
        input.at,
        input.at,
        index + 2,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

function testEnvWithResultMutation(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  mutateRows: (
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[],
  observeRows?: (sql: string, rows: readonly Record<string, unknown>[]) => void,
): Env {
  const adapter = createSqliteD1Database(database, trace);
  const DB = {
    ...adapter,
    prepare(sql: string) {
      const statement = adapter.prepare(sql);
      return {
        ...statement,
        bind(...values: Parameters<typeof statement.bind>) {
          statement.bind(...values);
          return this;
        },
        async all<Row>() {
          const result = await statement.all<Row>();
          const rows = Array.isArray(result.results) ? result.results : [];
          observeRows?.(
            sql,
            rows as unknown as readonly Record<string, unknown>[],
          );
          return {
            ...result,
            results: mutateRows(
              rows as unknown as readonly Record<string, unknown>[],
            ) as Row[],
          };
        },
      } as unknown as D1PreparedStatement;
    },
  };
  return {
    DB,
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

function testEnvWithQueryFailure(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  failure: Error,
): Env {
  const adapter = createSqliteD1Database(database, trace);
  const DB = {
    ...adapter,
    prepare(sql: string) {
      const statement = adapter.prepare(sql);
      return {
        ...statement,
        bind(...values: Parameters<typeof statement.bind>) {
          statement.bind(...values);
          return this;
        },
        async all<Row>() {
          throw failure;
        },
      } as unknown as D1PreparedStatement;
    },
  };
  return {
    DB,
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

function scopedSide(
  time: QueryTime,
  scope: "event" | "session" | "visitor",
  filterDsl: string,
  audience: "private-dashboard" | "api-v1" | "public-share",
) {
  const prepared = prepareScopedQuery("dimension", {
    context: siteQueryContext(SITE, audience),
    time,
    filters: parseFilterDsl(filterDsl, analyticsFilterRegistry),
    scopePreference: scope,
  } as QueryInput & { readonly time: QueryTime });
  return { time, filters: prepared.filters! };
}

function queryFor(options: ComparisonTestOptions = {}): ComparisonQuery {
  const audience = options.audience ?? "private-dashboard";
  const current = scopedSide(
    CURRENT_TIME,
    options.currentScope ?? "session",
    options.currentFilterDsl ??
      `${BASE_FILTER} and page.path neq "/current-only"`,
    audience,
  );
  const reference = scopedSide(
    REFERENCE_TIME,
    options.referenceScope ?? "visitor",
    options.referenceFilterDsl ??
      `${BASE_FILTER} and page.path neq "/reference-only"`,
    audience,
  );
  const base = prepareScopedQuery("dimension", {
    context: siteQueryContext(SITE, audience),
    time: CURRENT_TIME,
    filters: EMPTY_FILTER_DOCUMENT,
    scopePreference: "event",
  } as QueryInput & { readonly time: QueryTime });
  const metric = options.metric ?? "views";
  const sortBy = options.sortBy ?? "current";
  const direction = options.direction ?? "desc";
  return {
    ...base,
    mode: "overview-tab",
    time: CURRENT_TIME,
    tab: options.tab ?? "page.path",
    limit: options.limit ?? 2,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.search !== undefined ? { search: options.search } : {}),
    current,
    reference,
    comparison: {
      current,
      reference,
      metric,
      sortBy,
      direction,
    },
  } as ComparisonQuery;
}

function oneSidedQueryFor(
  options: OneSidedComparisonTestOptions,
): ComparisonQuery {
  const qualifiedFilterDsl = options.qualifiedFilterDsl ?? BASE_FILTER;
  const nativeFilterDsl =
    options.nativeFilterDsl ??
    'page.path neq "/excluded" and page.path neq "/native-only"';
  return queryFor({
    ...options,
    currentScope:
      options.qualifiedSide === "current" ? options.qualifiedScope : "event",
    referenceScope:
      options.qualifiedSide === "reference" ? options.qualifiedScope : "event",
    currentFilterDsl:
      options.qualifiedSide === "current"
        ? qualifiedFilterDsl
        : nativeFilterDsl,
    referenceFilterDsl:
      options.qualifiedSide === "reference"
        ? qualifiedFilterDsl
        : nativeFilterDsl,
  });
}

function overviewDto(
  page: Awaited<ReturnType<typeof queryComparisonDimensionPageFromD1>>,
) {
  return {
    data: {
      items: page.items.map((row) => ({
        key: row.key,
        value: row.key,
        label: row.key,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
        reference: row.reference,
        change: row.change,
      })),
      pagination: page.pagination,
    },
  };
}

async function legacyComparisonPage(
  database: DatabaseSync,
  query: ComparisonQuery,
  trace: SqliteD1Trace,
) {
  const env = testEnv(database, trace);
  const forwarded = (await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "pages",
    query,
    async (prepared) => prepared,
  )) as ComparisonQuery;
  const preparedFilters = {
    currentFilters: forwarded.current.filters ?? query.current.filters,
    referenceFilters: forwarded.reference.filters ?? query.reference.filters,
  };
  const tab = comparisonPageTab(query.tab);
  const reportFamily = comparisonReportFamilyForTab(query.tab);
  const legacyTab =
    (tab && reportFamily
      ? { expression: reportFamily.cursorExpression, selection: tab.selection }
      : undefined) ??
    (query.tab === "geo.country"
      ? {
          expression: "TRIM(COALESCE(country, ''))",
          selection: PAGE_DIMENSION_SELECTIONS.countryTrimmed,
        }
      : undefined);
  if (!legacyTab) throw new Error("wave95w_legacy_page_tab_missing");
  const cursor = await decodeComparisonDimensionCursor(
    env,
    SITE,
    CURRENT_WINDOW,
    preparedFilters.currentFilters,
    REFERENCE_WINDOW,
    preparedFilters.referenceFilters,
    legacyTab.expression,
    query.search,
    query.cursor ?? null,
    query.context.policy.audience,
    query.comparison.metric,
    query.comparison.sortBy,
    query.comparison.direction,
  );
  const page = await queryComparisonDimensionPageFromD1(
    env,
    SITE,
    CURRENT_WINDOW,
    preparedFilters.currentFilters,
    REFERENCE_WINDOW,
    preparedFilters.referenceFilters,
    query.limit,
    legacyTab.expression,
    {
      metric: query.comparison.metric,
      sortBy: query.comparison.sortBy,
      direction: query.comparison.direction,
      ...(query.search ? { search: query.search } : {}),
      selection: legacyTab.selection,
    },
    cursor,
    query.context.policy.audience,
  );
  return {
    deferred: undefined,
    dto: overviewDto(page),
  };
}

function makeProvider(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  diagnostics?: D1ReadDiagnostics,
  env?: Env,
) {
  const provider = createD1SiteProviderRegistry({
    env: env ?? testEnv(database, trace),
    siteId: SITE,
    ...(diagnostics ? { diagnostics } : {}),
  }).resolve("dimension");
  if (!provider) throw new Error("wave95w_comparison_provider_missing");
  return provider;
}

async function qualifiedReaderInput(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  query: ComparisonQuery,
  signal?: AbortSignal,
  env = testEnv(database, trace),
) {
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "dimension",
    query,
    async (prepared) => prepared,
    signal ? { signal } : undefined,
  );
  const deferred = deferredComparisonPageQualificationFromQuery(forwarded);
  const tab = comparisonPageTab(query.tab);
  const reportFamily = comparisonReportFamilyForTab(query.tab);
  if (!deferred || !tab || !reportFamily)
    throw new Error("wave95w_comparison_deferred_missing");
  return {
    env,
    request: forwarded as QueryInput,
    siteId: SITE,
    current: CURRENT_WINDOW,
    currentFilters: query.current.filters,
    reference: REFERENCE_WINDOW,
    referenceFilters: query.reference.filters,
    selectExpr: reportFamily.cursorExpression,
    audience: query.context.policy.audience,
    cursor: null,
    cursorToken: query.cursor ?? null,
    deferred,
  } satisfies Parameters<
    typeof tryQueryQualifiedComparisonDimensionPageFromD1
  >[0];
}

async function deferredPreparationStatementCount(
  database: DatabaseSync,
  query: ComparisonQuery,
): Promise<number> {
  const trace = traceFor();
  await d1AdvancedFilterMiddleware(testEnv(database, trace), undefined, SITE)(
    "dimension",
    query,
    async (prepared) => prepared,
  );
  return trace.preparedSql.length;
}

interface EnvelopeMutationFault {
  readonly name: string;
  readonly expected: string;
  readonly mutate: (
    rows: readonly Record<string, unknown>[],
  ) => readonly Record<string, unknown>[];
}

function oneSidedEnvelopeFaultCases() {
  return (["current", "reference"] as const).flatMap((qualifiedSide) => {
    const nativeSide = qualifiedSide === "current" ? "reference" : "current";
    const faults: readonly EnvelopeMutationFault[] = [
      {
        name: "missing-control",
        expected: "comparison_page_qualification_envelope_invalid",
        mutate: (rows) =>
          rows.filter((row) => row.rowKind !== `${qualifiedSide}-control`),
      },
      {
        name: "duplicate-control",
        expected: "comparison_page_qualification_envelope_invalid",
        mutate: (rows) => [
          ...rows,
          ...rows.filter((row) => row.rowKind === `${qualifiedSide}-control`),
        ],
      },
      {
        name: "wrong-control-scope",
        expected: "comparison_page_qualification_control_scope_mismatch",
        mutate: (rows) =>
          rows.map((row) =>
            row.rowKind === `${qualifiedSide}-control`
              ? {
                  ...row,
                  [`${qualifiedSide}__entityKind`]:
                    qualifiedSide === "current" ? "visitor" : "session",
                }
              : row,
          ),
      },
      {
        name: "native-side-fake-control-field",
        expected: "comparison_page_qualification_envelope_invalid",
        mutate: (rows) =>
          rows.map((row) =>
            row.rowKind === `${qualifiedSide}-control`
              ? { ...row, [`${nativeSide}__rawCount`]: 0 }
              : row,
          ),
      },
    ];
    return faults.map((fault) => ({ ...fault, qualifiedSide, nativeSide }));
  });
}

const TWO_SIDE_ENVELOPE_FAULTS: readonly EnvelopeMutationFault[] = [
  {
    name: "missing-current-control",
    expected: "comparison_page_qualification_envelope_invalid",
    mutate: (rows) => rows.filter((row) => row.rowKind !== "current-control"),
  },
  {
    name: "duplicate-current-control",
    expected: "comparison_page_qualification_envelope_invalid",
    mutate: (rows) => [
      ...rows,
      ...rows.filter((row) => row.rowKind === "current-control"),
    ],
  },
  {
    name: "wrong-current-control-output",
    expected: "comparison_page_qualification_control_output_invalid",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "current-control"
          ? { ...row, outputId: "unexpected-current" }
          : row,
      ),
  },
  {
    name: "wrong-current-control-scope",
    expected: "comparison_page_qualification_control_scope_mismatch",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "current-control"
          ? { ...row, current__entityKind: "visitor" }
          : row,
      ),
  },
  {
    name: "malformed-current-control-field",
    expected: "comparison_page_qualification_control_invalid:current.rawCount",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "current-control"
          ? { ...row, current__rawCount: "not-a-number" }
          : row,
      ),
  },
  {
    name: "missing-reference-control",
    expected: "comparison_page_qualification_envelope_invalid",
    mutate: (rows) => rows.filter((row) => row.rowKind !== "reference-control"),
  },
  {
    name: "duplicate-reference-control",
    expected: "comparison_page_qualification_envelope_invalid",
    mutate: (rows) => [
      ...rows,
      ...rows.filter((row) => row.rowKind === "reference-control"),
    ],
  },
  {
    name: "wrong-reference-control-output",
    expected: "comparison_page_qualification_control_output_invalid",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "reference-control"
          ? { ...row, outputId: "unexpected-reference" }
          : row,
      ),
  },
  {
    name: "wrong-reference-control-scope",
    expected: "comparison_page_qualification_control_scope_mismatch",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "reference-control"
          ? { ...row, reference__entityKind: "session" }
          : row,
      ),
  },
  {
    name: "malformed-reference-control-field",
    expected:
      "comparison_page_qualification_control_invalid:reference.rawCount",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "reference-control"
          ? { ...row, reference__rawCount: "not-a-number" }
          : row,
      ),
  },
  {
    name: "opposite-side-control-is-non-null",
    expected: "comparison_page_qualification_control_row_invalid",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "current-control"
          ? { ...row, reference__rawCount: 0 }
          : row,
      ),
  },
  {
    name: "control-report-field-is-non-null",
    expected: "comparison_page_qualification_control_row_invalid",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "reference-control"
          ? { ...row, key: "/injected" }
          : row,
      ),
  },
  {
    name: "malformed-report-row",
    expected: "comparison_page_qualification_report_row_invalid",
    mutate: (rows) =>
      rows.map((row) =>
        row.rowKind === "report"
          ? { ...row, currentViews: "not-a-number" }
          : row,
      ),
  },
];

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

afterAll(async () => {
  const directory = process.env.WAVE97DY_COMPARISON_EVIDENCE_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${directory}/comparison-page-regression.json`,
    JSON.stringify({ evidence }, null, 2),
    "utf8",
  );
});

describe("qualified Page comparison tabs", () => {
  it.each([
    "page.path",
    "page.query",
    "page.title",
    "page.hostname",
    "geo.timezone",
    "geo.organization",
  ] as const)("qualifies both sides for %s", async (tab) => {
    const database = createFixture();
    const query = queryFor({ tab, limit: 5 });
    const actualTrace = traceFor();
    const actual = await makeProvider(database, actualTrace).execute(query);
    const legacy = await legacyComparisonPage(database, query, traceFor());
    expect(legacy.deferred).toBeUndefined();
    expect(actual.value).toEqual(legacy.dto);
    expect(
      (actual.value as typeof legacy.dto).data.items.length,
    ).toBeGreaterThan(0);
    evidence.push({
      tab,
      deferred: Boolean(legacy.deferred),
      actual: actual.value,
      matchesLegacy: true,
      ...(tab === "page.path"
        ? {
            qualifiedStatements: actualTrace.preparedSql,
            qualifiedBindings: actualTrace.bindings,
            sqlBytes: actualTrace.preparedSql.map(
              (sql) => new TextEncoder().encode(sql).byteLength,
            ),
          }
        : {}),
    });
  });

  it.each([
    "page.path",
    "page.query",
    "page.title",
    "page.hostname",
    "geo.timezone",
    "geo.organization",
  ] as const)("qualifies either single side for %s", async (tab) => {
    const database = createFixture();
    const cases = [
      { qualifiedSide: "current", qualifiedScope: "session" },
      { qualifiedSide: "reference", qualifiedScope: "visitor" },
    ] as const;
    for (const options of cases) {
      const query = oneSidedQueryFor({ ...options, tab, limit: 8 });
      const preparationTrace = traceFor();
      const forwarded = await d1AdvancedFilterMiddleware(
        testEnv(database, preparationTrace),
        undefined,
        SITE,
      )("dimension", query, async (prepared) => prepared);
      const deferred = deferredComparisonPageQualificationFromQuery(forwarded);
      expect(deferred).toBeDefined();
      expect(preparationTrace.preparedSql).toHaveLength(1);
      expect(deferred?.current.kind).toBe(
        options.qualifiedSide === "current" ? "qualified" : "native",
      );
      expect(deferred?.reference.kind).toBe(
        options.qualifiedSide === "reference" ? "qualified" : "native",
      );
      const actualTrace = traceFor();
      const actual = await makeProvider(database, actualTrace).execute(query);
      const legacy = await legacyComparisonPage(database, query, traceFor());
      expect(legacy.deferred).toBeUndefined();
      expect(actual.value).toEqual(legacy.dto);
      if (tab === "page.path") {
        const qualificationTrace = traceFor();
        const qualificationInput = await qualifiedReaderInput(
          database,
          qualificationTrace,
          query,
        );
        const execution =
          await tryQueryQualifiedComparisonDimensionPageFromD1(
            qualificationInput,
          );
        expect(execution.kind).toBe("executed");
        if (execution.kind !== "executed")
          throw new Error("wave95y_expected_qualified_page_comparison");
        const statementIndex = qualificationTrace.preparedSql.findIndex((sql) =>
          sql.includes(`'${options.qualifiedSide}-control'`),
        );
        expect(statementIndex).toBeGreaterThanOrEqual(0);
        const statement = qualificationTrace.preparedSql[statementIndex]!;
        const bindings = qualificationTrace.bindings[statementIndex]!;
        evidence.push({
          kind: "one-sided-default-sql-evidence",
          qualifiedSide: options.qualifiedSide,
          nativeSide:
            options.qualifiedSide === "current" ? "reference" : "current",
          statementTag: execution.evidence.statementTag,
          sql: statement,
          sqlBytes: new TextEncoder().encode(statement).byteLength,
          bindings,
          bindingCount: bindings.length,
          statementCount: qualificationTrace.preparedSql.length,
          statements: qualificationTrace.preparedSql,
          statementBindings: qualificationTrace.bindings,
          statementBytes: qualificationTrace.preparedSql.map(
            (sql) => new TextEncoder().encode(sql).byteLength,
          ),
          statementBindingCounts: qualificationTrace.bindings.map(
            (statementBindings) => statementBindings.length,
          ),
          sharedRelationCount: execution.evidence.sharedRelationCount,
          nativeControlRows: 0,
        });
      }
      evidence.push({
        kind: "one-sided-selection-qualification",
        tab,
        qualifiedSide: options.qualifiedSide,
        qualifiedScope: options.qualifiedScope,
        nativeScope: "event",
        nativeFilterIsOrdinary: true,
        preparationStatementCount: preparationTrace.preparedSql.length,
        matchesLegacy: true,
      });
    }
  });

  const cursorMatrix = [
    ...(["views", "sessions", "visitors"] as const).flatMap((metric) =>
      (["current", "reference", "change"] as const).flatMap((sortBy) =>
        (["asc", "desc"] as const).map((direction) => ({
          metric,
          sortBy,
          direction,
        })),
      ),
    ),
  ].map((options, matrixIndex) => ({
    ...options,
    matrixIndex,
    qualifiedSide:
      matrixIndex % 2 === 0 ? ("current" as const) : ("reference" as const),
    qualifiedScope:
      matrixIndex % 4 < 2 ? ("session" as const) : ("visitor" as const),
  }));

  it.each(cursorMatrix)(
    "matches the complete legacy cursor chain for matrix item $matrixIndex ($metric/$sortBy/$direction)",
    async ({
      metric,
      sortBy,
      direction,
      matrixIndex,
      qualifiedSide,
      qualifiedScope,
    }) => {
      const database = createFixture();
      const trace = traceFor();
      const provider = makeProvider(database, trace);
      let cursor: string | null = null;
      let pageCount = 0;
      let hasMore = true;
      while (hasMore) {
        if (pageCount >= 8)
          throw new Error("wave95w_cursor_chain_did_not_finish");
        const query = oneSidedQueryFor({
          metric,
          sortBy,
          direction,
          qualifiedSide,
          qualifiedScope,
          limit: 2,
          cursor,
        });
        const actual = await provider.execute(query);
        const legacy = await legacyComparisonPage(database, query, traceFor());
        expect(legacy.deferred).toBeUndefined();
        expect(actual.value).toEqual(legacy.dto);
        const dto = actual.value as typeof legacy.dto;
        cursor = dto.data.pagination.nextCursor;
        hasMore = dto.data.pagination.hasMore;
        pageCount += 1;
      }
      expect(pageCount).toBe(4);
      evidence.push({
        kind: "one-sided-complete-cursor-chain",
        matrixIndex,
        metric,
        sortBy,
        direction,
        qualifiedSide,
        qualifiedScope,
        nativeScope: "event",
        pageCount,
        finished: true,
      });
    },
  );

  it("keeps current and reference qualification independent at the same scope", async () => {
    const database = createFixture();
    const query = queryFor({
      limit: 10,
      currentScope: "session",
      referenceScope: "session",
      sortBy: "change",
      direction: "asc",
    });
    const trace = traceFor();
    const actual = await makeProvider(database, trace).execute(query);
    const legacy = await legacyComparisonPage(database, query, traceFor());
    expect(legacy.deferred).toBeUndefined();
    expect(actual.value).toEqual(legacy.dto);
    evidence.push({
      kind: "same-scope-comparison",
      currentScope: "session",
      referenceScope: "session",
      currentAndReferenceFiltersDiffer: true,
      qualifiedStatements: trace.preparedSql,
      qualifiedBindings: trace.bindings,
      matchesLegacy: true,
    });
  });

  it("keeps current-only and reference-only keys and returns controls for empty reports", async () => {
    const database = createFixture();
    const oneSided = queryFor({
      limit: 10,
      currentFilterDsl: `${BASE_FILTER} and page.path eq "/p0"`,
      referenceFilterDsl: `${BASE_FILTER} and page.path eq "/p1"`,
    });
    const actual = await makeProvider(database, traceFor()).execute(oneSided);
    const legacy = await legacyComparisonPage(database, oneSided, traceFor());
    expect(legacy.deferred).toBeUndefined();
    expect(actual.value).toEqual(legacy.dto);
    const rows = (actual.value as typeof legacy.dto).data.items;
    expect(rows.map(({ key }) => key).sort()).toEqual(["/p0", "/p1"]);
    expect(rows.find(({ key }) => key === "/p0")?.reference.views).toBe(0);
    expect(rows.find(({ key }) => key === "/p1")?.views).toBe(0);

    const empty = queryFor({
      limit: 2,
      currentFilterDsl: `${BASE_FILTER} and page.path eq "/missing"`,
      referenceFilterDsl: `${BASE_FILTER} and page.path eq "/missing"`,
    });
    const emptyTrace = traceFor();
    const emptyActual = await makeProvider(database, emptyTrace).execute(empty);
    const emptyLegacy = await legacyComparisonPage(database, empty, traceFor());
    expect(emptyLegacy.deferred).toBeUndefined();
    expect(emptyActual.value).toEqual(emptyLegacy.dto);
    expect((emptyActual.value as typeof emptyLegacy.dto).data.items).toEqual(
      [],
    );
    evidence.push({
      kind: "one-sided-and-empty-report-controls",
      keys: rows.map(({ key }) => key).sort(),
      emptyReportReturned: true,
      controlEnvelopeQueryCount: emptyTrace.preparedSql.length,
      matchesLegacy: true,
    });
  });

  it("applies the twenty-thousand cap per side rather than across both sides", async () => {
    const database = createFixture();
    addQualifyingVisits(database, {
      prefix: "bulk-current",
      count: 9_000,
      at: 110,
    });
    addQualifyingVisits(database, {
      prefix: "bulk-reference",
      count: 9_000,
      at: 210,
    });
    const diagnostics = createD1ReadDiagnostics();
    const trace = traceFor();
    const query = queryFor({ limit: 20 });
    let productionEnvelopeRows: readonly Record<string, unknown>[] = [];
    let productionEnvelopeSql: string | undefined;
    let productionEnvelopeExecutionCount = 0;
    const executionObserver = (
      sql: string,
      rows: readonly Record<string, unknown>[],
    ) => {
      const isEnvelope =
        sql.includes("'current-control'") &&
        sql.includes("'reference-control'");
      if (isEnvelope) {
        productionEnvelopeSql = sql;
        productionEnvelopeExecutionCount += 1;
        productionEnvelopeRows = rows.filter(
          (row) =>
            row.rowKind === "current-control" ||
            row.rowKind === "reference-control",
        );
      }
    };
    const providerEnv = testEnvWithResultMutation(
      database,
      trace,
      (rows) => rows,
      executionObserver,
    );
    const actual = await makeProvider(
      database,
      trace,
      diagnostics,
      providerEnv,
    ).execute(query);
    const rows = (actual.value as ReturnType<typeof overviewDto>)["data"][
      "items"
    ];
    expect(rows.find(({ key }) => key === "/bulk-bulk-current")?.views).toBe(
      9_000,
    );
    expect(
      rows.find(({ key }) => key === "/bulk-bulk-reference")?.reference.views,
    ).toBe(9_000);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    const envelopeIndex = trace.preparedSql.findIndex(
      (sql) =>
        sql.includes("'current-control'") &&
        sql.includes("'reference-control'"),
    );
    expect(envelopeIndex).toBeGreaterThanOrEqual(0);
    expect(productionEnvelopeExecutionCount).toBe(1);
    expect(productionEnvelopeSql).toBe(trace.preparedSql[envelopeIndex]);
    const currentControlRows = productionEnvelopeRows.filter(
      (row) => row.rowKind === "current-control",
    );
    const referenceControlRows = productionEnvelopeRows.filter(
      (row) => row.rowKind === "reference-control",
    );
    expect(currentControlRows).toHaveLength(1);
    expect(referenceControlRows).toHaveLength(1);
    const currentControl = currentControlRows[0];
    const referenceControl = referenceControlRows[0];
    const currentRawCount = Number(currentControl!.current__rawCount);
    const referenceRawCount = Number(referenceControl!.reference__rawCount);
    expect(currentRawCount).toBeLessThan(20_000);
    expect(referenceRawCount).toBeLessThan(20_000);
    expect(currentRawCount + referenceRawCount).toBeGreaterThan(20_000);
    expect(trace.preparedSql.length).toBeGreaterThan(0);
    evidence.push({
      kind: "independent-side-caps",
      currentInsertedVisits: 9_000,
      referenceInsertedVisits: 9_000,
      combinedInsertedVisits: 18_000,
      currentRawCount,
      referenceRawCount,
      combinedRawCount: currentRawCount + referenceRawCount,
      fallback: false,
      qualifiedStatementCount: trace.preparedSql.length,
      qualifiedStatements: trace.preparedSql,
      bindingCounts: trace.bindings.map((bindings) => bindings.length),
      statementSqlBytes: trace.preparedSql.map(
        (sql) => new TextEncoder().encode(sql).byteLength,
      ),
      matchesExpected: true,
      controlRowsCapturedFromProductionExecution: true,
      productionEnvelopeExecutionCount,
      repeatedEnvelopeExecution: false,
    });
  }, 60_000);

  it("does not apply the qualified activity cap to a large native side", async () => {
    const database = createFixture();
    addQualifyingVisits(database, {
      prefix: "native-reference-over-cap",
      count: ADVANCED_FILTER_MAX_ACTIVITIES + 1,
      at: 220,
    });
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const query = oneSidedQueryFor({
      qualifiedSide: "current",
      qualifiedScope: "session",
      limit: 20,
      nativeFilterDsl:
        'page.path neq "/excluded" and page.path neq "/native-only"',
    });
    const actual = await makeProvider(database, trace, diagnostics).execute(
      query,
    );
    const legacy = await legacyComparisonPage(database, query, traceFor());
    expect(actual.value).toEqual(legacy.dto);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    const envelopeIndex = trace.preparedSql.findIndex((sql) =>
      sql.includes("'current-control'"),
    );
    expect(envelopeIndex).toBeGreaterThanOrEqual(0);
    const envelopeRows = database
      .prepare(trace.preparedSql[envelopeIndex]!)
      .all(...(trace.bindings[envelopeIndex] as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    expect(
      envelopeRows.filter((row) => row.rowKind === "current-control"),
    ).toHaveLength(1);
    expect(
      envelopeRows.some((row) => row.rowKind === "reference-control"),
    ).toBe(false);
    expect(
      Number(
        envelopeRows.find((row) => row.rowKind === "current-control")!
          .current__rawCount,
      ),
    ).toBeLessThan(ADVANCED_FILTER_MAX_ACTIVITIES);
    expect(
      (actual.value as ReturnType<typeof overviewDto>).data.items.find(
        ({ key }) => key === "/bulk-native-reference-over-cap",
      )?.reference.views,
    ).toBe(ADVANCED_FILTER_MAX_ACTIVITIES + 1);
    evidence.push({
      kind: "native-side-over-qualified-cap",
      nativeSide: "reference",
      nativeActivityCount: ADVANCED_FILTER_MAX_ACTIVITIES + 1,
      qualifiedSide: "current",
      qualifiedControlCount: 1,
      nativeControlRows: 0,
      fallback: false,
      matchesLegacy: true,
    });
  }, 60_000);

  it.each(oneSidedEnvelopeFaultCases())(
    "fails closed for one-sided $qualifiedSide control fault $name",
    async ({ qualifiedSide, nativeSide, name, expected, mutate }) => {
      const database = createFixture();
      const query = oneSidedQueryFor({
        qualifiedSide,
        qualifiedScope: qualifiedSide === "current" ? "session" : "visitor",
        limit: 8,
      });
      const baselineTrace = traceFor();
      const baseline = await makeProvider(database, baselineTrace).execute(
        query,
      );
      expect(baseline.value).toBeDefined();
      const envelopeIndex = baselineTrace.preparedSql.findIndex((sql) =>
        sql.includes(`'${qualifiedSide}-control'`),
      );
      expect(envelopeIndex).toBeGreaterThanOrEqual(0);
      const envelopeRows = database
        .prepare(baselineTrace.preparedSql[envelopeIndex]!)
        .all(
          ...(baselineTrace.bindings[envelopeIndex] as SQLInputValue[]),
        ) as Record<string, unknown>[];
      expect(
        envelopeRows.some((row) => row.rowKind === `${nativeSide}-control`),
      ).toBe(false);
      expect(
        Object.keys(envelopeRows[0]!).some((key) =>
          key.startsWith(`${nativeSide}__`),
        ),
      ).toBe(false);

      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const preparationCount = await deferredPreparationStatementCount(
        database,
        query,
      );
      const env = testEnvWithResultMutation(database, trace, mutate);
      await expect(
        makeProvider(database, trace, diagnostics, env).execute(query),
      ).rejects.toThrow(expected);
      expect(trace.preparedSql).toHaveLength(preparationCount + 1);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      evidence.push({
        kind: "one-sided-envelope-fail-closed",
        qualifiedSide,
        nativeSide,
        fault: name,
        fallbackQueries: 0,
        completed: true,
      });
    },
  );

  it.each(TWO_SIDE_ENVELOPE_FAULTS)(
    "fails closed for two-side envelope fault $name",
    async ({ name, expected, mutate }) => {
      const database = createFixture();
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const query = queryFor({ limit: 8 });
      const preparationCount = await deferredPreparationStatementCount(
        database,
        query,
      );
      const env = testEnvWithResultMutation(database, trace, mutate);
      await expect(
        makeProvider(database, trace, diagnostics, env).execute(query),
      ).rejects.toThrow(expected);
      expect(trace.preparedSql).toHaveLength(preparationCount + 1);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      evidence.push({
        kind: "two-side-envelope-fail-closed",
        fault: name,
        fallbackQueries: 0,
        completed: true,
      });
    },
  );

  it("keeps current control errors ahead of reference cap errors", async () => {
    const database = createFixture();
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const query = queryFor({ limit: 8, cursor: "invalid-cursor" });
    const preparationCount = await deferredPreparationStatementCount(
      database,
      query,
    );
    const env = testEnvWithResultMutation(database, trace, (rows) =>
      rows.map((row) =>
        row.rowKind === "current-control"
          ? { ...row, current__invalidIdentityCount: 1 }
          : row.rowKind === "reference-control"
            ? {
                ...row,
                reference__rawCount: ADVANCED_FILTER_MAX_ACTIVITIES + 1,
              }
            : row,
      ),
    );
    await expect(
      makeProvider(database, trace, diagnostics, env).execute(query),
    ).rejects.toThrow("comparison_page_qualification_current_identity_invalid");
    expect(trace.preparedSql).toHaveLength(preparationCount + 1);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
  });

  it("preserves per-side cap priority over invalid cursors", async () => {
    for (const side of ["current", "reference"] as const) {
      const database = createFixture();
      addQualifyingVisits(database, {
        prefix: `over-cap-${side}`,
        count: ADVANCED_FILTER_MAX_ACTIVITIES + 1,
        at: side === "current" ? 120 : 220,
      });
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const query = oneSidedQueryFor({
        qualifiedSide: side,
        qualifiedScope: side === "current" ? "session" : "visitor",
        limit: 8,
        cursor: "invalid-cursor",
      });
      const preparationCount = await deferredPreparationStatementCount(
        database,
        query,
      );
      await expect(
        makeProvider(database, trace, diagnostics).execute(query),
      ).rejects.toMatchObject({
        domainError: {
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(trace.preparedSql).toHaveLength(preparationCount + 1);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    }
    evidence.push({
      kind: "one-sided-cap-before-invalid-cursor",
      currentAndReference: true,
      qualifiedStatementsPerRequest: 1,
      fallback: false,
    });
  }, 60_000);

  it("uses current-to-reference legacy preparation for either numeric fallback", async () => {
    const numericFilter = `${BASE_FILTER} and count(page { page.durationMs gt 5 }) eq 1`;
    for (const side of ["current", "reference"] as const) {
      const database = createFixture();
      database
        .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
        .run("invalid-duration", `${side}-visit-0-0`);
      const query = oneSidedQueryFor({
        qualifiedSide: side,
        qualifiedScope: side === "current" ? "session" : "visitor",
        limit: 8,
        qualifiedFilterDsl: numericFilter,
      });
      const legacyTrace = traceFor();
      const legacy = await legacyComparisonPage(database, query, legacyTrace);
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const actual = await makeProvider(database, trace, diagnostics).execute(
        query,
      );
      expect(actual.value).toEqual(legacy.dto);
      expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
        kind: "numeric-data-domain",
      });
      expect(trace.preparedSql).toHaveLength(
        legacyTrace.preparedSql.length + 1,
      );
      const qualifiedKind = `${side}-control`;
      const nativeSide = side === "current" ? "reference" : "current";
      const qualifiedIndex = trace.preparedSql.findIndex((sql) =>
        sql.includes(`'${qualifiedKind}'`),
      );
      expect(qualifiedIndex).toBeGreaterThanOrEqual(0);
      const qualifiedRows = database
        .prepare(trace.preparedSql[qualifiedIndex]!)
        .all(...(trace.bindings[qualifiedIndex] as SQLInputValue[])) as Record<
        string,
        unknown
      >[];
      expect(
        qualifiedRows.filter((row) => row.rowKind === qualifiedKind),
      ).toHaveLength(1);
      expect(
        qualifiedRows.filter((row) => row.rowKind === `${nativeSide}-control`),
      ).toHaveLength(0);
      expect(
        qualifiedRows.filter((row) => row.rowKind === "report"),
      ).toHaveLength(0);
    }
    evidence.push({
      kind: "current-and-reference-numeric-fallback",
      actualD1NumericEvidence: true,
      legacyOracleUsesPagesMiddleware: true,
      qualifiedOrientations: ["current", "reference"],
      partialReportRows: 0,
      fullLegacyFallbackPerCase: true,
    });
  }, 60_000);

  it("validates both control protocols before current numeric fallback", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "current-visit-0-0");
    const query = queryFor({
      limit: 8,
      currentFilterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) eq 1`,
    });
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const preparationCount = await deferredPreparationStatementCount(
      database,
      query,
    );
    const env = testEnvWithResultMutation(database, trace, (rows) =>
      rows.map((row) =>
        row.rowKind === "reference-control"
          ? { ...row, reference__rawCount: "malformed-reference-count" }
          : row,
      ),
    );
    const actual = makeProvider(database, trace, diagnostics, env).execute(
      query,
    );
    await expect(actual).rejects.toThrow(
      "comparison_page_qualification_control_invalid:reference.rawCount",
    );
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    expect(trace.preparedSql).toHaveLength(preparationCount + 1);
    evidence.push({
      kind: "reference-protocol-before-current-fallback",
      currentNumericCompatibilityEvidence: true,
      referenceControlWasMalformed: true,
      protocolError:
        "comparison_page_qualification_control_invalid:reference.rawCount",
      legacyFallbackQueries: 0,
      qualificationQueries: 1,
    });
  }, 60_000);

  it("runs current numeric fallback before a valid reference cap judgment", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "current-visit-0-0");
    const query = queryFor({
      limit: 8,
      currentFilterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) eq 1`,
    });
    const legacyTrace = traceFor();
    const legacy = await legacyComparisonPage(database, query, legacyTrace);
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const env = testEnvWithResultMutation(database, trace, (rows) =>
      rows.map((row) =>
        row.rowKind === "reference-control"
          ? {
              ...row,
              reference__rawCount: ADVANCED_FILTER_MAX_ACTIVITIES + 1,
            }
          : row,
      ),
    );
    const actual = await makeProvider(
      database,
      trace,
      diagnostics,
      env,
    ).execute(query);
    expect(actual.value).toEqual(legacy.dto);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(trace.preparedSql).toHaveLength(legacyTrace.preparedSql.length + 1);
    evidence.push({
      kind: "current-numeric-fallback-before-reference-business-cap",
      referenceCapIsTypedInteger: true,
      referenceRawCount: ADVANCED_FILTER_MAX_ACTIVITIES + 1,
      actualDtoMatchesIndependentLegacyOracle: true,
      wholeRequestLegacyFallback: true,
      fallbackPreparationOrder: ["current", "reference"],
    });
  }, 60_000);

  it("falls back before D1 when the complete two-side Count program exceeds budget", async () => {
    const conditions = Array.from(
      { length: 24 },
      (_, index) => `count(page { page.path eq "/budget-${index}" }) eq 0`,
    ).join(" and ");
    const filterDsl = `${BASE_FILTER} and ${conditions}`;
    const database = createFixture();
    const query = queryFor({
      limit: 8,
      currentFilterDsl: filterDsl,
      referenceFilterDsl: filterDsl,
    });
    const legacyTrace = traceFor();
    const legacy = await legacyComparisonPage(database, query, legacyTrace);
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await makeProvider(database, trace, diagnostics).execute(
      query,
    );
    expect(actual.value).toEqual(legacy.dto);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "compile-budget",
      actual: expect.any(Number),
      limit: expect.any(Number),
    });
    const reason = diagnostics.advancedCountSqlFallbackReason;
    if (reason?.kind !== "compile-budget")
      throw new Error("wave95w_expected_complete_compile_budget_fallback");
    expect(reason.actual).toBeGreaterThan(reason.limit);
    expect(trace.preparedSql).toHaveLength(legacyTrace.preparedSql.length);
    expect(
      trace.preparedSql.some(
        (sql) =>
          sql.includes("'current-control'") &&
          sql.includes("'reference-control'"),
      ),
    ).toBe(false);
    evidence.push({
      kind: "complete-two-side-count-compile-budget-fallback",
      countConditionsPerSide: 24,
      fallbackReason: reason,
      fusedD1ExecutionBeforeFallback: false,
      matchesIndependentLegacyOracle: true,
    });
  }, 60_000);

  it("preflights a one-sided Count statement budget before fused D1", async () => {
    const conditions = Array.from(
      { length: 24 },
      (_, index) =>
        `count(page { page.path eq "/single-budget-${index}" }) eq 0`,
    ).join(" and ");
    const database = createFixture();
    const query = oneSidedQueryFor({
      qualifiedSide: "current",
      qualifiedScope: "session",
      limit: 8,
      qualifiedFilterDsl: `${BASE_FILTER} and ${conditions}`,
    });
    const legacyTrace = traceFor();
    const legacy = await legacyComparisonPage(database, query, legacyTrace);
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await makeProvider(database, trace, diagnostics).execute(
      query,
    );
    expect(actual.value).toEqual(legacy.dto);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "compile-budget",
      actual: expect.any(Number),
      limit: expect.any(Number),
    });
    const reason = diagnostics.advancedCountSqlFallbackReason;
    if (reason?.kind !== "compile-budget")
      throw new Error("wave95y_expected_one_side_compile_budget_fallback");
    expect(reason.actual).toBeGreaterThan(reason.limit);
    expect(trace.preparedSql).toHaveLength(legacyTrace.preparedSql.length);
    expect(
      trace.preparedSql.some(
        (sql) =>
          sql.includes("'current-control'") ||
          sql.includes("'reference-control'"),
      ),
    ).toBe(false);
    evidence.push({
      kind: "one-sided-count-compile-budget-fallback",
      qualifiedSide: "current",
      countConditions: 24,
      fallbackReason: reason,
      fusedD1ExecutionBeforeFallback: false,
      matchesIndependentLegacyOracle: true,
    });
  }, 60_000);

  it("honors request brands, pre-abort, post-query abort, and D1 errors", async () => {
    const query = oneSidedQueryFor({
      qualifiedSide: "current",
      qualifiedScope: "session",
      limit: 8,
    });

    const brandDatabase = createFixture();
    const brandTrace = traceFor();
    const brandInput = await qualifiedReaderInput(
      brandDatabase,
      brandTrace,
      query,
    );
    const brandPreparationCount = brandTrace.preparedSql.length;
    const forgedInput = {
      ...brandInput,
      deferred: { ...brandInput.deferred },
    } as typeof brandInput;
    await expect(
      tryQueryQualifiedComparisonDimensionPageFromD1(forgedInput),
    ).rejects.toThrow("comparison_page_qualification_request_mismatch");
    expect(brandTrace.preparedSql).toHaveLength(brandPreparationCount);
    const mutableRequest = brandInput.request as unknown as Record<
      string,
      unknown
    >;
    mutableRequest.limit = query.limit + 1;
    await expect(
      tryQueryQualifiedComparisonDimensionPageFromD1(brandInput),
    ).rejects.toThrow("deferred_comparison_page_request_changed");
    expect(brandTrace.preparedSql).toHaveLength(brandPreparationCount);

    const snapshotMutations = [
      {
        name: "qualified-filter",
        side: "current",
        property: "filters",
        value: EMPTY_FILTER_DOCUMENT,
      },
      {
        name: "native-filter",
        side: "reference",
        property: "filters",
        value: EMPTY_FILTER_DOCUMENT,
      },
      {
        name: "qualified-time",
        side: "current",
        property: "time",
        value: createQueryTime(101, 200, "UTC", 400),
      },
      {
        name: "native-time",
        side: "reference",
        property: "time",
        value: createQueryTime(200, 301, "UTC", 400),
      },
      {
        name: "native-scope-preference",
        side: "reference",
        property: "scopePreference",
        value: "visitor",
      },
    ] as const;
    for (const mutation of snapshotMutations) {
      const snapshotDatabase = createFixture();
      const snapshotTrace = traceFor();
      const snapshotInput = await qualifiedReaderInput(
        snapshotDatabase,
        snapshotTrace,
        query,
      );
      const preparationCount = snapshotTrace.preparedSql.length;
      const mutableSnapshotRequest = snapshotInput.request as unknown as Record<
        string,
        unknown
      >;
      const sideRequest = mutableSnapshotRequest[mutation.side] as Record<
        string,
        unknown
      >;
      mutableSnapshotRequest[mutation.side] = {
        ...sideRequest,
        [mutation.property]: mutation.value,
      };
      await expect(
        tryQueryQualifiedComparisonDimensionPageFromD1(snapshotInput),
      ).rejects.toThrow("deferred_comparison_page_request_changed");
      expect(snapshotTrace.preparedSql).toHaveLength(preparationCount);
      evidence.push({
        kind: "request-snapshot-mutation-rejected",
        mutation: mutation.name,
        queriesAfterMutation: 0,
      });
    }

    const preAbortDatabase = createFixture();
    const preAbortTrace = traceFor();
    const preAbortController = new AbortController();
    const preAbortInput = await qualifiedReaderInput(
      preAbortDatabase,
      preAbortTrace,
      query,
      preAbortController.signal,
    );
    const preAbortPreparationCount = preAbortTrace.preparedSql.length;
    preAbortController.abort();
    await expect(
      tryQueryQualifiedComparisonDimensionPageFromD1(preAbortInput),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preAbortTrace.preparedSql).toHaveLength(preAbortPreparationCount);
    const rejectedBeforeMiddlewareDatabase = createFixture();
    const rejectedBeforeMiddlewareTrace = traceFor();
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      makeProvider(
        rejectedBeforeMiddlewareDatabase,
        rejectedBeforeMiddlewareTrace,
      ).execute(query, { signal: alreadyAborted.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(rejectedBeforeMiddlewareTrace.preparedSql).toHaveLength(0);

    const postAbortDatabase = createFixture();
    const postAbortTrace = traceFor();
    const postAbortController = new AbortController();
    const postAbortEnv = testEnvWithResultMutation(
      postAbortDatabase,
      postAbortTrace,
      (rows) => {
        postAbortController.abort();
        return rows;
      },
    );
    const preparedPostAbortInput = await qualifiedReaderInput(
      postAbortDatabase,
      postAbortTrace,
      query,
      postAbortController.signal,
    );
    const postAbortInput = { ...preparedPostAbortInput, env: postAbortEnv };
    const postAbortPreparationCount = postAbortTrace.preparedSql.length;
    const postAbortDiagnostics = createD1ReadDiagnostics();
    await expect(
      tryQueryQualifiedComparisonDimensionPageFromD1({
        ...postAbortInput,
        diagnostics: postAbortDiagnostics,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(postAbortTrace.preparedSql).toHaveLength(
      postAbortPreparationCount + 1,
    );
    expect(postAbortDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();

    const errorDatabase = createFixture();
    const errorTrace = traceFor();
    const databaseError = new Error("comparison-test-d1-failure");
    const errorEnv = testEnvWithQueryFailure(
      errorDatabase,
      errorTrace,
      databaseError,
    );
    const preparedErrorInput = await qualifiedReaderInput(
      errorDatabase,
      errorTrace,
      query,
    );
    const errorInput = { ...preparedErrorInput, env: errorEnv };
    const errorPreparationCount = errorTrace.preparedSql.length;
    const errorDiagnostics = createD1ReadDiagnostics();
    await expect(
      tryQueryQualifiedComparisonDimensionPageFromD1({
        ...errorInput,
        diagnostics: errorDiagnostics,
      }),
    ).rejects.toThrow("comparison-test-d1-failure");
    expect(errorTrace.preparedSql).toHaveLength(errorPreparationCount + 1);
    expect(errorDiagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    evidence.push({
      kind: "one-sided-brand-abort-and-d1-failure-lifecycle",
      forgedBrandQueries: 0,
      mutatedSnapshotQueries: 0,
      preAbortQueries: 0,
      postAbortQueries: 1,
      postAbortDidNotSucceedOrFallback: true,
      databaseErrorQueries: 1,
      databaseErrorDidNotFallback: true,
    });
  }, 60_000);

  it("leaves unsupported and public-share comparisons on the native path", async () => {
    const database = createFixture();
    for (const query of [
      queryFor({ tab: "geo.country", limit: 3 }),
      queryFor({ tab: "page.path", audience: "public-share", limit: 3 }),
    ]) {
      const forwarded = await d1AdvancedFilterMiddleware(
        testEnv(database, traceFor()),
        undefined,
        SITE,
      )("dimension", query, async (prepared) => prepared);
      expect(
        deferredComparisonPageQualificationFromQuery(forwarded),
      ).toBeUndefined();
      const actual = await makeProvider(database, traceFor()).execute(query);
      const legacy = await legacyComparisonPage(database, query, traceFor());
      expect(legacy.deferred).toBeUndefined();
      expect(actual.value).toEqual(legacy.dto);
    }
    evidence.push({
      kind: "unsupported-native-paths",
      selections: ["geo.country", "page.path/public-share"],
      deferred: false,
      matchesLegacy: true,
    });
  });

  it("qualifies whole-boolean Page comparisons across supported scopes and cursor pages", async () => {
    for (const scope of ["session", "visitor"] as const) {
      const database = createFixture();
      seedWholeBooleanProofRows(database, "current");
      seedWholeBooleanProofRows(database, "reference");
      const options = {
        currentScope: scope,
        referenceScope: scope,
        currentFilterDsl:
          'page.path eq "/current-only" or count(event { event.name eq "qualifier" }) gte 1',
        referenceFilterDsl:
          'not (page.path eq "/excluded" and count(event { event.name eq "qualifier" }) eq 1)',
        limit: 2,
        metric: "visitors" as const,
        sortBy: "change" as const,
        direction: "asc" as const,
      };
      const query = queryFor(options);
      const preparationTrace = traceFor();
      const forwarded = await d1AdvancedFilterMiddleware(
        testEnv(database, preparationTrace),
        undefined,
        SITE,
      )("dimension", query, async (prepared) => prepared);
      const deferred = deferredComparisonPageQualificationFromQuery(forwarded);
      const trace = traceFor();
      const actual = await makeProvider(database, trace).execute(query);
      const legacyTrace = traceFor();
      const legacy = await legacyComparisonPage(database, query, legacyTrace);
      const firstPage = actual.value as typeof legacy.dto;
      const nextCursor = firstPage.data.pagination.nextCursor;

      const nextQuery = queryFor({
        ...options,
        cursor: typeof nextCursor === "string" ? nextCursor : null,
      });
      const nextTrace = traceFor();
      const nextActual = await makeProvider(database, nextTrace).execute(
        nextQuery,
      );
      const nextLegacyTrace = traceFor();
      const nextLegacy = await legacyComparisonPage(
        database,
        nextQuery,
        nextLegacyTrace,
      );

      const fullQuery = queryFor({ ...options, limit: 100 });
      const fullTrace = traceFor();
      const fullDiagnostics = createD1ReadDiagnostics();
      const rawReportControlRows: Array<{
        readonly sql: string;
        readonly rows: readonly Record<string, unknown>[];
      }> = [];
      const fullEnv = testEnvWithResultMutation(
        database,
        fullTrace,
        (rows) => rows,
        (sql, rows) => rawReportControlRows.push({ sql, rows }),
      );
      const fullActual = await makeProvider(
        database,
        fullTrace,
        fullDiagnostics,
        fullEnv,
      ).execute(fullQuery);
      const fullLegacyTrace = traceFor();
      const fullLegacy = await legacyComparisonPage(
        database,
        fullQuery,
        fullLegacyTrace,
      );
      const incorrectAndQuery = queryFor({
        ...options,
        currentFilterDsl:
          'page.path eq "/current-only" and count(event { event.name eq "qualifier" }) gte 1',
        limit: 100,
      });
      const incorrectAndTrace = traceFor();
      const incorrectAndDiagnostics = createD1ReadDiagnostics();
      const incorrectAnd = await makeProvider(
        database,
        incorrectAndTrace,
        incorrectAndDiagnostics,
      ).execute(incorrectAndQuery);
      const wholeBooleanEvidence = {
        kind: "whole-boolean-page-comparison",
        scope,
        qualifiedSides: [deferred?.current.kind, deferred?.reference.kind],
        qualificationModes: [
          deferred?.current.kind === "qualified"
            ? deferred.current.qualification.pageDimensionFilterMode
            : undefined,
          deferred?.reference.kind === "qualified"
            ? deferred.reference.qualification.pageDimensionFilterMode
            : undefined,
        ],
        currentWindow: query.current.time.range,
        referenceWindow: query.reference.time.range,
        currentFilter:
          deferred?.current.kind === "qualified"
            ? deferred.current.qualification.filters.root
            : undefined,
        referenceFilter:
          deferred?.reference.kind === "qualified"
            ? deferred.reference.qualification.filters.root
            : undefined,
        fixtureOwnerRows: {
          current: wholeBooleanFixtureOwnerRows(database, "current"),
          reference: wholeBooleanFixtureOwnerRows(database, "reference"),
        },
        middlewareSql: preparationTrace.preparedSql,
        reportSql: fullTrace.preparedSql,
        reportBindings: fullTrace.bindings,
        reportShape: comparisonExecutionShape(fullTrace, fullDiagnostics),
        legacySql: fullLegacyTrace.preparedSql,
        legacyBindings: fullLegacyTrace.bindings,
        incorrectAndSql: incorrectAndTrace.preparedSql,
        incorrectAndBindings: incorrectAndTrace.bindings,
        incorrectAndShape: comparisonExecutionShape(
          incorrectAndTrace,
          incorrectAndDiagnostics,
        ),
        actual: fullActual.value,
        legacy: fullLegacy.dto,
        incorrectAnd: incorrectAnd.value,
        actualReportRows: (fullActual.value as typeof fullLegacy.dto).data
          .items,
        rawReportControlRows,
        incorrectAndControlRows: (incorrectAnd.value as typeof fullLegacy.dto)
          .data.items,
        cursorPages: {
          first: actual.value,
          firstSql: trace.preparedSql,
          firstBindings: trace.bindings,
          next: nextActual.value,
          nextSql: nextTrace.preparedSql,
          nextBindings: nextTrace.bindings,
          nextLegacySql: nextLegacyTrace.preparedSql,
        },
      };
      evidence.push(wholeBooleanEvidence);

      expect(deferred?.current.kind).toBe("qualified");
      expect(deferred?.reference.kind).toBe("qualified");
      expect(wholeBooleanEvidence.qualificationModes).toEqual([
        "allow-whole-filter",
        "allow-whole-filter",
      ]);
      expect(preparationTrace.preparedSql).toHaveLength(2);
      expect(legacy.deferred).toBeUndefined();
      expect(actual.value).toEqual(legacy.dto);
      expect(nextLegacy.deferred).toBeUndefined();
      expect(nextActual.value).toEqual(nextLegacy.dto);
      expect(nextCursor).toEqual(expect.any(String));
      expect(fullLegacy.deferred).toBeUndefined();
      expect(fullActual.value).toEqual(fullLegacy.dto);
      expect(
        fullTrace.preparedSql.every(
          (sql) =>
            new TextEncoder().encode(sql).byteLength <= D1_MAX_SQL_UTF8_BYTES,
        ),
      ).toBe(true);
      expect(
        fullTrace.bindings.every(
          (bindings) => bindings.length <= D1_MAX_BOUND_PARAMETERS,
        ),
      ).toBe(true);
      const fullItems = (fullActual.value as typeof fullLegacy.dto).data.items;
      expect(
        fullItems.find((row) => row.key === "/current-only")?.views,
      ).toBeGreaterThan(0);
      expect(
        fullItems.find((row) => row.key === "/count-only")?.views,
      ).toBeGreaterThan(0);
      const incorrectAndItems = (incorrectAnd.value as typeof fullLegacy.dto)
        .data.items;
      expect(
        incorrectAndItems.find((row) => row.key === "/current-only")?.views ??
          0,
      ).toBe(0);
      expect(incorrectAnd.value).not.toEqual(fullActual.value);
    }
  });

  it("keeps a native Page side paired with one whole-boolean qualified side", async () => {
    const database = createFixture();
    seedWholeBooleanProofRows(database, "current");
    seedWholeBooleanProofRows(database, "reference");
    const query = queryFor({
      currentScope: "session",
      referenceScope: "session",
      currentFilterDsl:
        'page.path eq "/current-only" or count(event { event.name eq "qualifier" }) gte 1',
      referenceFilterDsl: 'page.path neq "/reference-only"',
      limit: 8,
    });
    const preparationTrace = traceFor();
    const forwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, preparationTrace),
      undefined,
      SITE,
    )("dimension", query, async (prepared) => prepared);
    const deferred = deferredComparisonPageQualificationFromQuery(forwarded);
    expect(deferred?.current.kind).toBe("qualified");
    expect(deferred?.reference.kind).toBe("native");
    expect(preparationTrace.preparedSql).toHaveLength(1);

    const trace = traceFor();
    const actual = await makeProvider(database, trace).execute(query);
    const legacy = await legacyComparisonPage(database, query, traceFor());
    expect(legacy.deferred).toBeUndefined();
    expect(actual.value).toEqual(legacy.dto);
    evidence.push({
      kind: "whole-boolean-qualified-with-native-side",
      currentKind: deferred?.current.kind,
      referenceKind: deferred?.reference.kind,
      currentWindow: query.current.time.range,
      referenceWindow: query.reference.time.range,
      preparationSql: preparationTrace.preparedSql,
      reportSql: trace.preparedSql,
      reportBindings: trace.bindings,
      actual: actual.value,
      matchesLegacy: true,
    });
  });

  it("accepts cloned comparison configs, gates parent mismatches, and rejects getters without reading them", async () => {
    const database = createFixture();
    const query = queryFor({
      currentScope: "visitor",
      referenceScope: "visitor",
      currentFilterDsl:
        'page.path eq "/current-only" or count(event { event.name eq "qualifier" }) gte 1',
      referenceFilterDsl:
        'not (page.path eq "/excluded" and count(event { event.name eq "qualifier" }) eq 1)',
      limit: 8,
    });
    const clonedQuery = {
      ...query,
      comparison: {
        ...query.comparison,
        current: { ...query.current },
        reference: { ...query.reference },
      },
    } as ComparisonQuery;
    const clonedForwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    )("dimension", clonedQuery, async (prepared) => prepared);
    expect(
      deferredComparisonPageQualificationFromQuery(clonedForwarded),
    ).toBeDefined();

    const mismatchedQuery = {
      ...query,
      comparison: {
        ...query.comparison,
        current: {
          ...query.comparison.current,
          time: createQueryTime(101, 200, "UTC", 400),
        },
      },
    } as ComparisonQuery;
    const mismatchForwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    )("dimension", mismatchedQuery, async (prepared) => prepared);
    expect(
      deferredComparisonPageQualificationFromQuery(mismatchForwarded),
    ).toBeUndefined();
    const mismatchActual = await makeProvider(database, traceFor()).execute(
      mismatchedQuery,
    );
    const mismatchLegacy = await legacyComparisonPage(
      database,
      mismatchedQuery,
      traceFor(),
    );
    expect(mismatchLegacy.deferred).toBeUndefined();
    expect(mismatchActual.value).toEqual(mismatchLegacy.dto);

    let getterReads = 0;
    const comparisonWithGetter = { ...query.comparison };
    Object.defineProperty(comparisonWithGetter, "current", {
      enumerable: true,
      get() {
        getterReads += 1;
        return query.current;
      },
    });
    const getterQuery = {
      ...query,
      comparison: comparisonWithGetter,
    } as ComparisonQuery;
    await expect(
      d1AdvancedFilterMiddleware(
        testEnv(database, traceFor()),
        undefined,
        SITE,
      )("dimension", getterQuery, async (prepared) => prepared),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [
          {
            path: "comparison",
            code: "comparison_request_own_data_required",
          },
        ],
      },
    });
    expect(getterReads).toBe(0);
    evidence.push({
      kind: "comparison-parent-own-data-gate",
      structuralCloneAccepted: true,
      parentMismatchDeferred: false,
      parentMismatchMatchesLegacy: true,
      getterReads,
    });
  });

  it("keeps explicit undefined comparison slots on the ordinary page path", async () => {
    const database = createFixture();
    const scoped = prepareScopedQuery("dimension", {
      context: siteQueryContext(SITE, "private-dashboard"),
      time: CURRENT_TIME,
      filters: parseFilterDsl(BASE_FILTER, analyticsFilterRegistry),
      scopePreference: "session",
    } as QueryInput & { readonly time: QueryTime });
    const query = {
      ...scoped,
      mode: "overview-tab",
      tab: "page.path",
      limit: 5,
      comparison: undefined,
      current: undefined,
      reference: undefined,
    };
    const forwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    )("dimension", query, async (prepared) => prepared);
    const result = {
      forwardedMode: (forwarded as typeof query).mode,
      forwardedTab: (forwarded as typeof query).tab,
      deferredComparison: Boolean(
        deferredComparisonPageQualificationFromQuery(forwarded),
      ),
    };
    evidence.push({
      kind: "ordinary-page-undefined-comparison-slots",
      ...result,
    });
    expect(result).toEqual({
      forwardedMode: "overview-tab",
      forwardedTab: "page.path",
      deferredComparison: false,
    });
  });

  it("falls back both sides when a whole-filter Count numeric check mismatches", async () => {
    const database = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "current-visit-0-0");
    const numericBooleanFilter =
      'page.path eq "/not-a-real-path" or (count(event { event.name eq "qualifier" }) gte 1 and count(page { page.durationMs gt 5 }) eq 1)';
    const query = queryFor({
      currentScope: "session",
      referenceScope: "session",
      currentFilterDsl: numericBooleanFilter,
      referenceFilterDsl: 'page.path neq "/reference-only"',
      limit: 8,
    });
    const legacyTrace = traceFor();
    const legacy = await legacyComparisonPage(database, query, legacyTrace);
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const actual = await makeProvider(database, trace, diagnostics).execute(
      query,
    );
    expect(legacy.deferred).toBeUndefined();
    expect(actual.value).toEqual(legacy.dto);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(trace.preparedSql).toHaveLength(legacyTrace.preparedSql.length + 1);
    const qualifiedIndex = trace.preparedSql.findIndex((sql) =>
      sql.includes("'current-control'"),
    );
    expect(qualifiedIndex).toBeGreaterThanOrEqual(0);
    const qualifiedRows = database
      .prepare(trace.preparedSql[qualifiedIndex]!)
      .all(...(trace.bindings[qualifiedIndex] as SQLInputValue[])) as Record<
      string,
      unknown
    >[];
    expect(
      qualifiedRows.filter((row) => row.rowKind === "current-control"),
    ).toHaveLength(1);
    expect(
      qualifiedRows.filter((row) => row.rowKind === "reference-control"),
    ).toHaveLength(0);
    expect(
      qualifiedRows.filter((row) => row.rowKind === "report"),
    ).toHaveLength(0);
    evidence.push({
      kind: "whole-boolean-one-sided-numeric-fallback",
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
      currentWindow: query.current.time.range,
      referenceWindow: query.reference.time.range,
      qualificationSql: trace.preparedSql[qualifiedIndex],
      qualificationBindings: trace.bindings[qualifiedIndex],
      reportSqlWasProduced: false,
      matchesLegacy: true,
    });
  });

  it("keeps an unsupported Advanced side on the complete legacy path", async () => {
    const database = createFixture();
    const unsupportedCount =
      'page.path neq "/excluded" and count(event { event.payload("/kind") exists }) eq 1';
    for (const qualifiedSide of ["current", "reference"] as const) {
      const query = queryFor({
        limit: 8,
        currentScope: qualifiedSide === "current" ? "session" : "event",
        referenceScope: qualifiedSide === "reference" ? "visitor" : "event",
        currentFilterDsl:
          qualifiedSide === "current" ? BASE_FILTER : unsupportedCount,
        referenceFilterDsl:
          qualifiedSide === "reference" ? BASE_FILTER : unsupportedCount,
      });
      const trace = traceFor();
      const forwarded = await d1AdvancedFilterMiddleware(
        testEnv(database, trace),
        undefined,
        SITE,
      )("dimension", query, async (prepared) => prepared);
      expect(
        deferredComparisonPageQualificationFromQuery(forwarded),
      ).toBeUndefined();
      const actual = await makeProvider(database, traceFor()).execute(query);
      const legacy = await legacyComparisonPage(database, query, traceFor());
      expect(legacy.deferred).toBeUndefined();
      expect(actual.value).toEqual(legacy.dto);
      evidence.push({
        kind: "unsupported-advanced-side-whole-request-fallback",
        qualifiedSide,
        unsupportedSide: qualifiedSide === "current" ? "reference" : "current",
        deferred: false,
        matchesLegacy: true,
      });
    }
  });

  it("runs both side controls before rejecting an invalid cursor", async () => {
    const database = createFixture();
    const query = queryFor({ limit: 2, cursor: "invalid-cursor" });
    const baselineTrace = traceFor();
    const forwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, baselineTrace),
      undefined,
      SITE,
    )("dimension", query, async (prepared) => prepared);
    expect(
      deferredComparisonPageQualificationFromQuery(forwarded),
    ).toBeDefined();
    const trace = traceFor();
    await expect(
      makeProvider(database, trace).execute(query),
    ).rejects.toBeInstanceOf(InvalidCursorError);
    expect(trace.preparedSql.length).toBeGreaterThan(
      baselineTrace.preparedSql.length,
    );
    evidence.push({
      kind: "invalid-cursor-order",
      qualificationQueryRan: true,
      rejected: true,
    });
  });
});
