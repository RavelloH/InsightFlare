import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  compileD1Query,
  D1_MAX_BOUND_PARAMETERS,
  D1_MAX_SQL_UTF8_BYTES,
  lowerLogicalPlan,
  sort,
  union,
} from "@/lib/db";
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
import { buildReferrerSummaryPlan } from "@/lib/edge/analytics/engine/referrer-report-plan";
import { buildReferrersQualificationPlan } from "@/lib/edge/analytics/engine/referrers-qualification-plan";
import {
  d1AdvancedFilterMiddleware,
  deferredReferrersQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import {
  compilePageDimensionQualificationProgram,
  compileReferrersQualificationProgram,
  type ReferrersQualificationReportQuery,
} from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { AnalyticsLogicalToDbLowerer } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-lowering";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  decodeReferrersCursor,
  queryReferrersPageFromD1,
  queryReferrerSummaryFromD1,
  type ReferrerAggregateCursor,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { FilterDocument } from "@/lib/filter-contract/filters";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave96e-referrers";
const TIME = createQueryTime(100, 200, "UTC", 300);
const WINDOW = {
  startMs: 100,
  endExclusiveMs: 200,
  nowMs: 300,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave96e-referrers-test-secret";
const WAVE97DB_EVIDENCE_DIRECTORY = process.env.INSIGHTFLARE_97DB_EVIDENCE_DIR
  ? resolve(process.env.INSIGHTFLARE_97DB_EVIDENCE_DIR)
  : undefined;
const BASE_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
const databases = new Set<DatabaseSync>();
const evidence: Array<Record<string, unknown>> = [];

interface TestSite {
  readonly id: string;
  readonly pk: number;
}

type ReferrersQuery = QueryInput & {
  readonly time: QueryTime;
  readonly variant?: unknown;
  readonly topN?: unknown;
  readonly limit?: unknown;
  readonly page?: unknown;
  readonly includeFullUrl?: unknown;
  readonly search?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
};

interface QueryOptions {
  readonly variant?: "summary";
  readonly scope?: "session" | "visitor" | "event";
  readonly audience?: "private-dashboard" | "api-v1" | "public-share";
  readonly filterDsl?: string;
  readonly topN?: number;
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly includeFullUrl?: boolean;
  readonly search?: string | null;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
}

function traceFor(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function addSite(database: DatabaseSync, id = SITE): TestSite {
  database.prepare("INSERT INTO site_identities (site_id) VALUES (?)").run(id);
  const identity = database
    .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
    .get(id) as { readonly site_pk: number };
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, 'wave96e-team', 'Referrers', 'referrers.test', 0)`,
    )
    .run(id);
  return { id, pk: Number(identity.site_pk) };
}

function addVisit(
  database: DatabaseSync,
  site: TestSite,
  input: {
    readonly id: string;
    readonly sessionId: string;
    readonly visitorId: string;
    readonly path: string;
    readonly referrerHost: string;
    readonly referrerUrl: string;
    readonly at: number;
    readonly event?: boolean;
    readonly eventCopies?: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO visits (
        visit_id, site_id, site_pk, visitor_id, session_id, status,
        started_at, last_activity_at, pathname, hostname, referrer_host,
        referrer_url, duration_ms
      ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, 'site.test', ?, ?, 10)`,
    )
    .run(
      input.id,
      site.id,
      site.pk,
      input.visitorId,
      input.sessionId,
      input.at,
      input.at,
      input.path,
      input.referrerHost,
      input.referrerUrl,
    );
  const eventCopies = input.eventCopies ?? (input.event ? 1 : 0);
  if (eventCopies === 0) return;
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(site.id, input.at, site.pk);
  for (let index = 0; index < eventCopies; index += 1)
    database
      .prepare(
        `INSERT INTO custom_events (
          event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
          received_at, sequence, node_count, value_count
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0, 0)`,
      )
      .run(
        `event-${input.id}-${index}`,
        site.id,
        site.pk,
        input.id,
        input.at,
        input.at,
        index + 1,
      );
}

function createFixture(): {
  readonly database: DatabaseSync;
  readonly site: TestSite;
} {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  const site = addSite(database);
  const visits = [
    {
      id: "a-source",
      sessionId: "session-a1",
      visitorId: "visitor-shared",
      path: "/qualifier-source",
      referrerHost: " Host.Example ",
      referrerUrl: " https://Host.Example/a ",
      at: 111,
      eventCopies: 2,
    },
    {
      id: "a-page",
      sessionId: "session-a1",
      visitorId: "visitor-shared",
      path: "/shared/a",
      referrerHost: "Host.Example",
      referrerUrl: "https://Host.Example/a",
      at: 112,
    },
    {
      id: "a-second-session",
      sessionId: "session-a2",
      visitorId: "visitor-shared",
      path: "/shared/a2",
      referrerHost: "Host.Example",
      referrerUrl: "https://Host.Example/a2",
      at: 113,
    },
    {
      id: "b-source",
      sessionId: "session-b",
      visitorId: "visitor-b",
      path: "/qualifier-source",
      referrerHost: "host.example",
      referrerUrl: "https://host.example/b",
      at: 114,
      event: true,
    },
    {
      id: "b-page",
      sessionId: "session-b",
      visitorId: "visitor-b",
      path: "/b/page",
      referrerHost: "host.example",
      referrerUrl: "https://host.example/b2",
      at: 115,
    },
    {
      id: "direct-source",
      sessionId: "session-direct",
      visitorId: "visitor-direct",
      path: "/qualifier-source",
      referrerHost: "",
      referrerUrl: "",
      at: 116,
      event: true,
    },
    {
      id: "direct-page",
      sessionId: "session-direct",
      visitorId: "visitor-direct",
      path: "/direct/page",
      referrerHost: "",
      referrerUrl: "",
      at: 117,
    },
    {
      id: "excluded-page",
      sessionId: "session-b",
      visitorId: "visitor-b",
      path: "/excluded",
      referrerHost: "excluded.example",
      referrerUrl: "https://excluded.example/",
      at: 118,
    },
    {
      id: "unqualified",
      sessionId: "session-unqualified",
      visitorId: "visitor-unqualified",
      path: "/unqualified",
      referrerHost: "unqualified.example",
      referrerUrl: "https://unqualified.example/",
      at: 119,
    },
  ] as const;
  for (const visit of visits) addVisit(database, site, visit);
  return { database, site };
}

function addWholeBooleanOrVisits(database: DatabaseSync, site: TestSite): void {
  addVisit(database, site, {
    id: "or-native-only",
    sessionId: "or-native-only-session",
    visitorId: "or-native-only-visitor",
    path: "/native-only",
    referrerHost: "native-only.example",
    referrerUrl: "https://native-only.example/",
    at: 120,
  });
  addVisit(database, site, {
    id: "or-count-only-source",
    sessionId: "or-count-only-source-session",
    visitorId: "or-count-only-visitor",
    path: "/count-source",
    referrerHost: "count-source.example",
    referrerUrl: "https://count-source.example/",
    at: 121,
    event: true,
  });
  addVisit(database, site, {
    id: "or-count-only-report-page",
    sessionId: "or-count-only-other-session",
    visitorId: "or-count-only-visitor",
    path: "/count-report",
    referrerHost: "count-page.example",
    referrerUrl: "https://count-page.example/",
    at: 122,
  });
  addVisit(database, site, {
    id: "or-neither",
    sessionId: "or-neither-session",
    visitorId: "or-neither-visitor",
    path: "/neither",
    referrerHost: "neither.example",
    referrerUrl: "https://neither.example/",
    at: 123,
  });
}

function addWholeBooleanNotVisits(
  database: DatabaseSync,
  site: TestSite,
): void {
  addVisit(database, site, {
    id: "not-native-only",
    sessionId: "not-native-only-session",
    visitorId: "not-native-only-visitor",
    path: "/excluded",
    referrerHost: "not-native-only.example",
    referrerUrl: "https://not-native-only.example/",
    at: 120,
  });
  addVisit(database, site, {
    id: "not-count-only",
    sessionId: "not-count-only-session",
    visitorId: "not-count-only-visitor",
    path: "/not-excluded",
    referrerHost: "not-count-only.example",
    referrerUrl: "https://not-count-only.example/",
    at: 121,
    event: true,
  });
  addVisit(database, site, {
    id: "not-neither",
    sessionId: "not-neither-session",
    visitorId: "not-neither-visitor",
    path: "/not-neither",
    referrerHost: "not-neither.example",
    referrerUrl: "https://not-neither.example/",
    at: 122,
  });
  addVisit(database, site, {
    id: "not-scope-neither",
    sessionId: "not-scope-neither-session",
    visitorId: "not-scope-proof-visitor",
    path: "/scope-neither",
    referrerHost: "scope-neither.example",
    referrerUrl: "https://scope-neither.example/",
    at: 123,
  });
  addVisit(database, site, {
    id: "not-scope-counted-sibling",
    sessionId: "not-scope-counted-session",
    visitorId: "not-scope-proof-visitor",
    path: "/scope-counted",
    referrerHost: "scope-counted.example",
    referrerUrl: "https://scope-counted.example/",
    at: 124,
    event: true,
  });
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

function queryFor(options: QueryOptions = {}): ReferrersQuery {
  const filters = parseFilterDsl(
    options.filterDsl ?? BASE_FILTER,
    analyticsFilterRegistry,
  );
  const prepared = prepareScopedQuery("referrers", {
    context: siteQueryContext(SITE, options.audience ?? "private-dashboard"),
    time: TIME,
    filters,
    scopePreference: options.scope ?? "session",
  } as QueryInput & { readonly time: typeof TIME });
  return {
    ...prepared,
    time: TIME,
    ...(options.variant ? { variant: options.variant } : {}),
    ...(options.topN !== undefined ? { topN: options.topN } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.cursor !== undefined
      ? { page: { limit: options.limit, cursor: options.cursor } }
      : options.limit !== undefined
        ? { page: { limit: options.limit } }
        : {}),
    ...(options.includeFullUrl !== undefined
      ? { includeFullUrl: options.includeFullUrl }
      : {}),
    ...(options.search !== undefined ? { search: options.search } : {}),
    ...(options.sort !== undefined ? { sort: options.sort } : {}),
    ...(options.direction !== undefined
      ? { direction: options.direction }
      : {}),
  } as ReferrersQuery;
}

function summaryTopN(query: ReferrersQuery): number {
  return typeof query.topN === "number" && Number.isFinite(query.topN)
    ? query.topN
    : typeof query.limit === "number" && Number.isFinite(query.limit)
      ? query.limit
      : 5;
}

function pageParameters(query: ReferrersQuery) {
  const page =
    query.page && typeof query.page === "object"
      ? (query.page as Record<string, unknown>)
      : {};
  const limit =
    typeof page.limit === "number" && Number.isFinite(page.limit)
      ? page.limit
      : typeof query.limit === "number" && Number.isFinite(query.limit)
        ? query.limit
        : 20;
  return {
    limit,
    cursorText: typeof page.cursor === "string" ? page.cursor : null,
    includeFullUrl: query.includeFullUrl === true,
    search: typeof query.search === "string" ? query.search : undefined,
    sortBy: query.sort === "visitors" ? "visitors" : "views",
    sortDirection: query.direction === "asc" ? "asc" : "desc",
  } as const;
}

async function legacyRead(
  database: DatabaseSync,
  query: ReferrersQuery,
  trace: SqliteD1Trace,
): Promise<{ readonly value: unknown; readonly deferred: unknown }> {
  const env = testEnv(database, trace);
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "referrers",
    query,
    async (prepared) => prepared,
  );
  const deferred = deferredReferrersQualificationFromQuery(forwarded);
  const forwardedQuery = forwarded as ReferrersQuery;
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : (forwardedQuery.filters ?? query.filters ?? EMPTY_FILTER_DOCUMENT);
  if (query.variant === "summary")
    return {
      value: await queryReferrerSummaryFromD1(
        env,
        SITE,
        WINDOW,
        filters,
        summaryTopN(query),
      ),
      deferred,
    };
  const page = pageParameters(query);
  const cursor = await decodeReferrersCursor(
    env,
    SITE,
    WINDOW,
    filters,
    page.includeFullUrl,
    page.search,
    page.cursorText,
    query.context.policy.audience,
    page.sortBy,
    page.sortDirection,
  );
  if (page.cursorText && !cursor) throw new InvalidCursorError("referrers");
  return {
    value: await queryReferrersPageFromD1(
      env,
      SITE,
      WINDOW,
      filters,
      page.limit,
      page.includeFullUrl,
      page.search,
      cursor,
      undefined,
      query.context.policy.audience,
      page.sortBy,
      page.sortDirection,
    ),
    deferred,
  };
}

async function deferredFor(database: DatabaseSync, query: ReferrersQuery) {
  const forwarded = await d1AdvancedFilterMiddleware(
    testEnv(database, traceFor()),
    undefined,
    SITE,
  )("referrers", query, async (prepared) => prepared);
  const deferred = deferredReferrersQualificationFromQuery(forwarded);
  if (!deferred) throw new Error("wave96e_referrers_deferred_missing");
  return deferred;
}

function compileQuery(
  deferred: NonNullable<
    ReturnType<typeof deferredReferrersQualificationFromQuery>
  >,
  query: ReferrersQuery,
): ReturnType<typeof compileReferrersQualificationProgram> {
  const page = pageParameters(query);
  const reportQuery: ReferrersQualificationReportQuery = {
    siteId: SITE,
    queryTime: query.time,
    filters: query.filters!,
    ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
    configuration:
      query.variant === "summary"
        ? { kind: "summary", topN: summaryTopN(query) }
        : {
            kind: "page",
            limit: page.limit,
            includeFullUrl: page.includeFullUrl,
            ...(page.search !== undefined ? { search: page.search } : {}),
            sortBy: page.sortBy,
            sortDirection: page.sortDirection,
            cursor: null,
          },
    cursorToken: query.variant === "summary" ? null : page.cursorText,
    audience: query.context.policy.audience,
  };
  return compileReferrersQualificationProgram({ deferred, query: reportQuery });
}

function recordEvidence(kind: string, values: Record<string, unknown>): void {
  evidence.push({ kind, ...values });
}

function persistWholeBooleanEvidence(
  name: string,
  values: Record<string, unknown>,
): void {
  if (!WAVE97DB_EVIDENCE_DIRECTORY) return;
  mkdirSync(WAVE97DB_EVIDENCE_DIRECTORY, { recursive: true });
  writeFileSync(
    resolve(WAVE97DB_EVIDENCE_DIRECTORY, `${name}.json`),
    JSON.stringify(values, null, 2),
    "utf8",
  );
}

function readEnvelopeRows(
  database: DatabaseSync,
  trace: SqliteD1Trace,
): Record<string, unknown>[] {
  const sql = trace.preparedSql[1];
  if (!sql) throw new Error("wave97db_referrers_report_sql_missing");
  return database.prepare(sql).all(...(trace.bindings[1] ?? [])) as Record<
    string,
    unknown
  >[];
}

function testEnvWithReportBehavior(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  behavior:
    | "missing-control"
    | "duplicate-summary"
    | "wrong-row-type"
    | "invalid-schema",
): Env {
  const baseDatabase = createSqliteD1Database(database, trace);
  let prepareCount = 0;
  const DB = {
    prepare(sql: string) {
      prepareCount += 1;
      const statement = baseDatabase.prepare(sql);
      if (prepareCount !== 2) return statement;
      const replacement = Object.create(statement) as D1PreparedStatement;
      Object.defineProperty(replacement, "bind", {
        value: (...values: SQLInputValue[]) => {
          statement.bind(...values);
          return replacement;
        },
      });
      const originalAll = statement.all.bind(statement);
      Object.defineProperty(replacement, "all", {
        value: async () => {
          const result = await originalAll<Record<string, unknown>>();
          if (behavior === "missing-control")
            return {
              ...result,
              results: result.results.filter(
                (row) => row.rowKind !== "control",
              ),
            };
          if (behavior === "duplicate-summary") {
            const summary = result.results.find(
              (row) => row.outputId === "referrer-summary",
            );
            return {
              ...result,
              results: summary ? [...result.results, summary] : result.results,
            };
          }
          return {
            ...result,
            results: result.results.map((row) =>
              row.rowKind !== "report"
                ? row
                : behavior === "wrong-row-type" &&
                    row.outputId === "referrer-summary"
                  ? { ...row, rowType: "top" }
                  : behavior === "invalid-schema"
                    ? { ...row, referrer: 42 }
                    : row,
            ),
          };
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

function testEnvWithDatabaseFailure(
  database: DatabaseSync,
  trace: SqliteD1Trace,
): Env {
  const baseDatabase = createSqliteD1Database(database, trace);
  let prepareCount = 0;
  const DB = {
    prepare(sql: string) {
      prepareCount += 1;
      const statement = baseDatabase.prepare(sql);
      if (prepareCount !== 2) return statement;
      const replacement = Object.create(statement) as D1PreparedStatement;
      Object.defineProperty(replacement, "bind", {
        value: (...values: SQLInputValue[]) => {
          statement.bind(...values);
          return replacement;
        },
      });
      Object.defineProperty(replacement, "all", {
        value: async () => {
          throw new Error("wave96e_referrers_database_failure");
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

function testEnvThatAbortsAfterCount(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  controller: AbortController,
): Env {
  const baseDatabase = createSqliteD1Database(database, trace);
  let prepareCount = 0;
  const DB = {
    prepare(sql: string) {
      prepareCount += 1;
      const statement = baseDatabase.prepare(sql);
      if (prepareCount !== 1) return statement;
      const replacement = Object.create(statement) as D1PreparedStatement;
      Object.defineProperty(replacement, "bind", {
        value: (...values: SQLInputValue[]) => {
          statement.bind(...values);
          return replacement;
        },
      });
      const originalAll = statement.all.bind(statement);
      Object.defineProperty(replacement, "all", {
        value: async () => {
          const result = await originalAll<Record<string, unknown>>();
          controller.abort();
          return result;
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

afterAll(() => {
  for (const database of databases) database.close();
  if (process.env.WAVE97DB_DIRECT_REFERRERS_CAPTURE === "1") return;
  const evidenceDirectory = resolve(
    process.cwd(),
    "plan/execution-wave96e-referrers-summary-and-page-qualification/run-2-root-review/evidence",
  );
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    resolve(evidenceDirectory, "referrers-qualified-regression.json"),
    JSON.stringify({ evidence }, null, 2),
    "utf8",
  );
});

describe("qualified flat Referrers pages and summary", () => {
  it("preserves the native summary logical, SQL, bindings and physical preimage", () => {
    const queryTime = {
      range: { startMs: 1_700_000_000_000, endExclusiveMs: 1_700_086_400_000 },
      reportingTimeZone: "UTC",
      capturedAtMs: 1_700_086_400_000,
    } as QueryTime;
    const plan = buildReferrerSummaryPlan({
      siteId: "wave96e-preimage-site",
      queryTime,
      filters: EMPTY_FILTER_DOCUMENT,
      topN: 5,
    });
    const outputs = ["referrer-summary", "referrer-top-sources"].map((id) => {
      const matches = plan.outputs.filter((output) => output.id === id);
      expect(matches).toHaveLength(1);
      return matches[0]!;
    });
    const lowerer = new AnalyticsLogicalToDbLowerer(plan, {
      siteId: plan.context.subject.siteIds[0]!,
      time: plan.context.time,
    });
    const lowered = lowerer.lowerMany(outputs);
    const branches = outputs.map((output, index) =>
      lowerer.projectOutput(
        lowered[index]!,
        output.fields.map(({ name, slot }) => ({ name, slot })),
      ),
    );
    let combined = branches[0]!;
    for (const branch of branches.slice(1))
      combined = union(combined, branch, true);
    const ordered = sort(combined, [
      { expression: combined.columns.rowType!, direction: "ASC" },
      { expression: combined.columns.views!, direction: "DESC" },
      { expression: combined.columns.referrer!, direction: "ASC" },
    ]);
    const compiled = compileD1Query(lowerLogicalPlan(ordered), {
      tag: "analytics.referrer_summary_native_preimage",
    });
    const hash = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value)).digest("hex");
    expect(hash(plan)).toBe(
      "0104cde96b973155385e5236f9b7ca26d704fe5fb15e5939687306059a7de27b",
    );
    expect(
      createHash("sha256").update(compiled.sql, "utf8").digest("hex"),
    ).toBe("8ee4e251ed1f2fec6684cc83277e6c1e6c4345c9ecca9ab59668bca580f3a6af");
    expect(hash(compiled.bindings ?? [])).toBe(
      "33edf07f410c0dce07c89b693971dd452e3e464ca4b9ac5f7bc82e5eed725e51",
    );
    expect(hash(compiled.physicalPlanShape)).toBe(
      "7bbfad54fcd7af86710411ba84c71d7442227fef67b3b0f84e47ece2bbbbd3c1",
    );
    expect(Buffer.byteLength(compiled.sql)).toBe(2214);
    expect(compiled.bindings).toHaveLength(11);
    expect(compiled.physicalPlanShape).toMatchObject({
      version: 8,
      cteCount: 1,
      nativeMembershipCount: 1,
      jsonMembershipCount: 0,
    });
    recordEvidence("native-summary-preimage", {
      logicalPlanSha256: hash(plan),
      sqlSha256: createHash("sha256").update(compiled.sql).digest("hex"),
      bindingsSha256: hash(compiled.bindings ?? []),
      physicalPlanShapeSha256: hash(compiled.physicalPlanShape),
      sqlBytes: Buffer.byteLength(compiled.sql),
      bindingCount: compiled.bindings?.length ?? 0,
      physicalPlanShape: compiled.physicalPlanShape,
    });
  });

  const defaults = [
    { scope: "event", kind: "summary" },
    { scope: "event", kind: "page", includeFullUrl: false },
    { scope: "session", kind: "summary" },
    { scope: "visitor", kind: "summary" },
    { scope: "session", kind: "page", includeFullUrl: false },
    { scope: "session", kind: "page", includeFullUrl: true },
    { scope: "visitor", kind: "page", includeFullUrl: false },
    { scope: "visitor", kind: "page", includeFullUrl: true },
  ] as const;

  it("matches Event candidate summary and a real Referrers cursor continuation", async () => {
    const { database } = createFixture();
    const readActual = async (query: ReferrersQuery) => {
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
        diagnostics,
      }).resolve("referrers");
      if (!provider)
        throw new Error("wave97ep_event_referrers_provider_missing");
      const result = await provider.execute(query as never);
      return { value: result.value, trace, diagnostics };
    };

    const summaryQuery = queryFor({
      scope: "event",
      variant: "summary",
      topN: 5,
    });
    const summaryLegacy = await legacyRead(database, summaryQuery, traceFor());
    const summaryActual = await readActual(summaryQuery);
    expect(summaryActual.value).toEqual(summaryLegacy.value);
    expect(summaryLegacy.deferred).toBeDefined();
    expect(
      summaryActual.diagnostics.advancedCountSqlFallbackReason,
    ).toBeUndefined();

    const firstQuery = queryFor({
      scope: "event",
      limit: 1,
      includeFullUrl: true,
    });
    const firstLegacy = await legacyRead(database, firstQuery, traceFor());
    const firstPage = firstLegacy.value as {
      readonly items: readonly unknown[];
      readonly pagination: { readonly nextCursor: string | null };
    };
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.pagination.nextCursor).toBeTruthy();
    const secondQuery = queryFor({
      scope: "event",
      limit: 1,
      includeFullUrl: true,
      cursor: firstPage.pagination.nextCursor,
    });
    const secondLegacy = await legacyRead(database, secondQuery, traceFor());
    const secondActual = await readActual(secondQuery);
    expect(secondActual.value).toEqual(secondLegacy.value);
    expect(secondLegacy.deferred).toBeDefined();
    expect(
      secondActual.diagnostics.advancedCountSqlFallbackReason,
    ).toBeUndefined();
    expect(secondActual.trace.preparedSql).toHaveLength(2);
    expect(
      (secondActual.value as { readonly items: readonly unknown[] }).items,
    ).not.toEqual(firstPage.items);
  });

  it("suppresses every Event candidate summary root and keeps controls for numeric fallback", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "a-source");
    const query = queryFor({
      scope: "event",
      variant: "summary",
      topN: 5,
      filterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) gte 1`,
    });
    const oldTrace = traceFor();
    const legacy = await legacyRead(database, query, oldTrace);
    if (!legacy.deferred)
      throw new Error("wave97ep_event_referrers_numeric_deferred_missing");
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("referrers");
    if (!provider)
      throw new Error("wave97ep_event_referrers_numeric_provider_missing");
    const actual = await provider.execute(query as never);
    const envelopeRows = readEnvelopeRows(database, trace);

    expect(actual.value).toEqual(legacy.value);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
      fieldIds: ["page.durationMs"],
    });
    expect(
      envelopeRows.filter((row) => row.rowKind === "control"),
    ).toHaveLength(1);
    expect(envelopeRows.filter((row) => row.rowKind === "report")).toHaveLength(
      0,
    );
    expect(trace.preparedSql.length).toBe(oldTrace.preparedSql.length + 1);
  });

  it.each(defaults)(
    "admits and matches the old complete reader for $scope/$kind/$includeFullUrl",
    async (testCase) => {
      const { scope, kind } = testCase;
      const includeFullUrl = kind === "page" ? testCase.includeFullUrl : false;
      const { database } = createFixture();
      const query =
        kind === "summary"
          ? queryFor({ scope, variant: "summary" })
          : queryFor({ scope, limit: 20, includeFullUrl });
      const deferred = await deferredFor(database, query);
      const compiled = compileQuery(deferred, query);
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave96e_default_referrers_compile_unavailable");

      const page = pageParameters(query);
      const configuration =
        kind === "summary"
          ? { kind: "summary" as const, topN: summaryTopN(query) }
          : {
              kind: "page" as const,
              limit: page.limit,
              includeFullUrl,
              ...(page.search !== undefined ? { search: page.search } : {}),
              sortBy: page.sortBy,
              sortDirection: page.sortDirection,
              cursor: null,
            };
      const qualificationPlan = buildReferrersQualificationPlan({
        siteId: SITE,
        queryTime: query.time,
        filters: query.filters!,
        scopePlan: query.scopePlan ?? deferred.metadata.plan,
        count: deferred.countInput,
        ...("eventCandidateReportProjection" in deferred &&
        deferred.eventCandidateReportProjection === "page-visits"
          ? { eventCandidateReportProjection: "page-visits" as const }
          : {}),
        configuration,
      });
      const controlOutput = qualificationPlan.plan.outputs.find(
        (output) => output.id === qualificationPlan.controlOutputId,
      );
      if (!controlOutput)
        throw new Error("wave96e_default_referrers_control_output_missing");

      const oldTrace = traceFor();
      const legacy = await legacyRead(database, query, oldTrace);
      expect(legacy.deferred).toBeDefined();
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
        diagnostics,
      }).resolve("referrers");
      if (!provider) throw new Error("wave96e_referrers_provider_missing");
      const actual = await provider.execute(query as never);
      expect(actual.value).toEqual(legacy.value);
      expect(trace.preparedSql).toHaveLength(2);
      expect(trace.preparedSql[1]).toBe(compiled.evidence.sql);
      expect(trace.bindings[1]).toEqual(compiled.evidence.bindings);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      expect(compiled.evidence.sqlBytes).toBeGreaterThan(0);
      expect(compiled.evidence.bindingCount).toBeGreaterThan(0);
      expect(compiled.evidence.sharedRelationCount).toBeGreaterThan(0);
      recordEvidence("default-qualified-referrers", {
        scope,
        kind,
        includeFullUrl: kind === "page" ? includeFullUrl : null,
        statementCount: trace.preparedSql.length,
        legacyStatementCount: oldTrace.preparedSql.length,
        sqlBytes: compiled.evidence.sqlBytes,
        bindingCount: compiled.evidence.bindingCount,
        sharedRelationCount: compiled.evidence.sharedRelationCount,
        physicalPlanShape: compiled.evidence.physicalPlanShape ?? null,
        qualificationIdentity: {
          scope: qualificationPlan.scope,
          primaryReportSourceRelationId:
            qualificationPlan.primaryReportSourceRelationId,
          reportSourceRelations: qualificationPlan.reportSourceRelations,
          matchesRelationId: qualificationPlan.matchesRelationId,
          controlsRelationId: qualificationPlan.controlsRelationId,
          groupedSummaryRelationId: qualificationPlan.groupedSummaryRelationId,
          reportOutputIds: qualificationPlan.reportOutputIds,
          controlOutputId: qualificationPlan.controlOutputId,
          controlOutputRelationId: controlOutput.relation,
          controlOutputFieldNames: controlOutput.fields.map(({ name }) => name),
        },
        actual: actual.value,
        legacy: legacy.value,
      });
    },
  );

  it.each(["session", "visitor"] as const)(
    "preserves summary limits, normalized hosts, direct totals and empty scalar output for %s scope",
    async (scope) => {
      const { database } = createFixture();
      for (const topN of [0, 1, 2, 5]) {
        const query = queryFor({ scope, variant: "summary", topN });
        const legacy = await legacyRead(database, query, traceFor());
        const trace = traceFor();
        const provider = createD1SiteProviderRegistry({
          env: testEnv(database, trace),
          siteId: SITE,
        }).resolve("referrers");
        if (!provider) throw new Error("wave96e_summary_provider_missing");
        const actual = await provider.execute(query as never);
        expect(actual.value).toEqual(legacy.value);
        const summary = actual.value as {
          readonly totalViews: number;
          readonly directViews: number;
          readonly externalViews: number;
          readonly uniqueDomains: number;
          readonly truncated: boolean;
          readonly topSources: readonly { referrer: string; views: number }[];
        };
        expect(summary.totalViews).toBe(scope === "session" ? 7 : 8);
        expect(summary.directViews).toBe(2);
        expect(summary.uniqueDomains).toBe(3);
        if (topN === 0) {
          expect(summary.topSources).toEqual([]);
          expect(summary.truncated).toBe(true);
        }
        if (topN === 1) {
          expect(summary.topSources).toEqual([
            { referrer: "Host.Example", views: scope === "session" ? 2 : 3 },
          ]);
          expect(summary.truncated).toBe(true);
        }
        recordEvidence("summary-topn", {
          scope,
          topN,
          summary,
          statementCount: trace.preparedSql.length,
        });
      }

      const emptyQuery = queryFor({
        scope,
        variant: "summary",
        topN: 5,
        filterDsl:
          'page.path eq "/never-present" and count(event { event.name eq "qualifier" }) gte 1',
      });
      const emptyTrace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, emptyTrace),
        siteId: SITE,
      }).resolve("referrers");
      if (!provider) throw new Error("wave96e_empty_summary_provider_missing");
      const emptyActual = await provider.execute(emptyQuery as never);
      expect(emptyActual.value).toEqual({
        totalViews: 0,
        directViews: 0,
        externalViews: 0,
        uniqueDomains: 0,
        uniqueLinks: 0,
        truncated: false,
        topSources: [],
      });
      const rows = database
        .prepare(emptyTrace.preparedSql[1]!)
        .all(...(emptyTrace.bindings[1] ?? [])) as Record<string, unknown>[];
      expect(
        rows.filter(
          (row) =>
            row.rowKind === "report" && row.outputId === "referrer-summary",
        ),
      ).toHaveLength(1);
      expect(
        rows.filter(
          (row) =>
            row.rowKind === "report" && row.outputId === "referrer-top-sources",
        ),
      ).toHaveLength(0);
      recordEvidence("summary-empty-scalar", {
        scope,
        value: emptyActual.value,
        summaryScalarRows: 1,
        topRows: 0,
      });
    },
  );

  const pageChains = (["session", "visitor"] as const).flatMap((scope) =>
    ([false, true] as const).flatMap((includeFullUrl) =>
      ([1, 2] as const).map((limit) => ({
        scope,
        includeFullUrl,
        limit,
        sort: includeFullUrl ? ("visitors" as const) : ("views" as const),
        direction: scope === "session" ? ("asc" as const) : ("desc" as const),
      })),
    ),
  );

  it("admits a zero-limit flat Referrers page and preserves its DTO", async () => {
    const { database } = createFixture();
    const query = queryFor({ limit: 0 });
    const deferred = await deferredFor(database, query);
    expect(deferred.referrersRequest).toMatchObject({
      kind: "page",
      limit: 0,
    });
    const legacy = await legacyRead(database, query, traceFor());
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
    }).resolve("referrers");
    if (!provider) throw new Error("wave96e_zero_limit_provider_missing");
    const actual = await provider.execute(query as never);
    expect(actual.value).toEqual(legacy.value);
    const page = actual.value as {
      readonly items: readonly unknown[];
      readonly pagination: {
        readonly limit: number;
        readonly returned: number;
      };
    };
    expect(page.items).toEqual([]);
    expect(page.pagination).toMatchObject({ limit: 0, returned: 0 });
    recordEvidence("zero-limit-flat-page", {
      page: actual.value,
      statementCount: trace.preparedSql.length,
    });
  });

  it.each(pageChains)(
    "walks the exact old DTO and HMAC chain to completion for $scope/fullUrl=$includeFullUrl/limit=$limit",
    async ({ scope, includeFullUrl, limit, sort, direction }) => {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("referrers");
      if (!provider) throw new Error("wave96e_page_provider_missing");
      let cursor: string | null = null;
      let finished = false;
      const actualPages: unknown[] = [];
      const legacyPages: unknown[] = [];
      for (let index = 0; index < 20; index += 1) {
        const query = queryFor({
          scope,
          limit,
          includeFullUrl,
          cursor,
          sort,
          direction,
        });
        const actual = await provider.execute(query as never);
        const legacy = await legacyRead(database, query, traceFor());
        expect(actual.value).toEqual(legacy.value);
        actualPages.push(actual.value);
        legacyPages.push(legacy.value);
        const page = actual.value as {
          readonly items: readonly unknown[];
          readonly pagination: {
            readonly limit: number;
            readonly returned: number;
            readonly hasMore: boolean;
            readonly nextCursor: string | null;
          };
        };
        expect(page.pagination.limit).toBe(limit);
        expect(page.pagination.returned).toBe(page.items.length);
        cursor = page.pagination.nextCursor;
        if (cursor === null) {
          finished = true;
          break;
        }
      }
      expect(finished).toBe(true);
      expect(actualPages).toEqual(legacyPages);
      expect(trace.preparedSql).toHaveLength(actualPages.length * 2);
      recordEvidence("flat-page-cursor-chain", {
        scope,
        includeFullUrl,
        limit,
        pageCount: actualPages.length,
        completedAtNullCursor: finished,
        exactHmacBoundPages: true,
        actualPages,
      });
    },
  );

  it("keeps raw host and URL keys for flat pages while summary trims host values", async () => {
    const { database } = createFixture();
    const summaryQuery = queryFor({
      variant: "summary",
      scope: "session",
      topN: 5,
    });
    const summaryProvider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("referrers");
    if (!summaryProvider)
      throw new Error("wave96e_raw_summary_provider_missing");
    const summary = (await summaryProvider.execute(summaryQuery as never))
      .value as { readonly topSources: readonly { referrer: string }[] };
    expect(summary.topSources.map(({ referrer }) => referrer)).toContain(
      "Host.Example",
    );
    expect(summary.topSources.map(({ referrer }) => referrer)).not.toContain(
      " Host.Example ",
    );

    for (const includeFullUrl of [false, true]) {
      for (const search of [undefined, "", " ", "HOST.EXAMPLE", null]) {
        const query = queryFor({
          scope: "visitor",
          limit: 50,
          includeFullUrl,
          ...(search !== undefined ? { search } : {}),
        });
        const actualTrace = traceFor();
        const provider = createD1SiteProviderRegistry({
          env: testEnv(database, actualTrace),
          siteId: SITE,
        }).resolve("referrers");
        if (!provider) throw new Error("wave96e_raw_page_provider_missing");
        const actual = await provider.execute(query as never);
        const legacy = await legacyRead(database, query, traceFor());
        expect(actual.value).toEqual(legacy.value);
        const labels = (
          actual.value as unknown as { items: { referrer: string }[] }
        ).items.map(({ referrer }) => referrer);
        if (!includeFullUrl) {
          expect(labels).toContain(" Host.Example ");
          expect(labels).toContain("Host.Example");
        } else {
          expect(labels).toContain(" https://Host.Example/a ");
          expect(labels).toContain("https://Host.Example/a");
        }
      }
    }
    recordEvidence("raw-flat-keys-and-search", {
      normalizedSummaryHosts: summary.topSources,
      rawHostAndUrlKeysPreserved: true,
      searchInputs: [null, "", " ", "HOST.EXAMPLE"],
    });
  });

  it("Direct Referrers whole Boolean qualification keeps request gates and an operation brand", async () => {
    const { database } = createFixture();
    const env = testEnv(database, traceFor());
    const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const eligible = queryFor({ variant: "summary", topN: 0 });
    const forwarded = await middleware(
      "referrers",
      eligible,
      async (prepared) => prepared,
    );
    const deferred = deferredReferrersQualificationFromQuery(forwarded);
    expect(deferred?.referrersRequest).toMatchObject({
      kind: "summary",
      topN: 0,
      audience: "private-dashboard",
    });
    const compiled = compileQuery(deferred!, eligible);
    expect(compiled.kind).toBe("compiled");

    const crossConfiguration: ReferrersQualificationReportQuery = {
      siteId: SITE,
      queryTime: eligible.time,
      filters: eligible.filters!,
      scopePlan: eligible.scopePlan,
      configuration: {
        kind: "page",
        limit: 20,
        includeFullUrl: false,
        sortBy: "views",
        sortDirection: "desc",
        cursor: null,
      },
      cursorToken: null,
      audience: "private-dashboard",
    };
    let crossConfigurationError: unknown;
    try {
      compileReferrersQualificationProgram({
        deferred: deferred!,
        query: crossConfiguration,
      });
    } catch (error) {
      crossConfigurationError = error;
    }
    expect(crossConfigurationError).toMatchObject({
      domainError: {
        issues: [{ path: "query", code: "referrers_request_context_mismatch" }],
      },
    });
    expect(() =>
      compilePageDimensionQualificationProgram({
        deferred: deferred as never,
        query: {} as never,
      }),
    ).toThrow("analytics_event_qualification_request_mismatch");

    const unsupported = [
      queryFor({
        variant: "summary",
        audience: "public-share",
        filterDsl: 'count(event { event.name eq "qualifier" }) gte 1',
      }),
      queryFor({ variant: "summary", topN: -1 }),
      queryFor({ limit: 1.5 }),
    ];
    for (const candidate of unsupported) {
      const prepared = await middleware(
        "referrers",
        candidate,
        async (value) => value,
      );
      expect(deferredReferrersQualificationFromQuery(prepared)).toBeUndefined();
    }
    const wholeBooleanCandidates = [
      queryFor({
        variant: "summary",
        filterDsl:
          'page.path eq "/native-only" or count(event { event.name eq "qualifier" }) gte 1',
      }),
      queryFor({
        variant: "summary",
        filterDsl:
          'not (page.path eq "/excluded" or count(event { event.name eq "qualifier" }) gte 1)',
      }),
    ];
    for (const candidate of wholeBooleanCandidates) {
      const prepared = await middleware(
        "referrers",
        candidate,
        async (value) => value,
      );
      const wholeDeferred = deferredReferrersQualificationFromQuery(prepared);
      expect(wholeDeferred).toBeDefined();
      expect(wholeDeferred?.filters.root).toEqual(candidate.filters?.root);
      expect(wholeDeferred?.countInput.analysis.document.root).toEqual(
        candidate.filters?.root,
      );
      const wholeCompiled = compileQuery(wholeDeferred!, candidate);
      expect(wholeCompiled.kind).toBe("compiled");
      recordEvidence("whole-boolean-request-gate", {
        rootKind: candidate.filters?.root?.kind,
        countDocument: wholeDeferred?.countInput.analysis.document,
        compilation: wholeCompiled.kind,
      });
    }
    const ignoredSummaryFields = {
      ...eligible,
      page: { limit: 2, cursor: "ignored" },
      search: "ignored",
      includeFullUrl: true,
    };
    const ignoredForwarded = await middleware(
      "referrers",
      ignoredSummaryFields,
      async (value) => value,
    );
    expect(
      deferredReferrersQualificationFromQuery(ignoredForwarded)
        ?.referrersRequest.kind,
    ).toBe("summary");
    await expect(
      d1AdvancedFilterMiddleware(env, undefined, "another-site")(
        "referrers",
        eligible,
        async (value) => value,
      ),
    ).rejects.toMatchObject({
      domainError: {
        issues: [
          { path: "siteId", code: "referrers_request_context_mismatch" },
        ],
      },
    });
    recordEvidence("referrers-request-gates", {
      eligibleSummaryTopNZero: true,
      summaryIgnoredParameters: true,
      rejected: [
        "public audience",
        "event scope",
        "negative summary topN",
        "fractional page limit",
      ],
      admittedWholeBoolean: ["mixed OR", "mixed NOT"],
      referrersBrandIndependentFromPageDimension: true,
    });
  });

  it("Direct Referrers whole Boolean qualification matches visitor OR and the old cursor", async () => {
    const { database, site } = createFixture();
    addWholeBooleanOrVisits(database, site);
    const filterDsl =
      'page.path eq "/native-only" or count(event { event.name eq "qualifier" }) gte 1';
    const expectedSummary = {
      totalViews: 11,
      directViews: 2,
      externalViews: 9,
      uniqueDomains: 6,
      uniqueLinks: 8,
      truncated: false,
      topSources: [
        { referrer: "Host.Example", views: 3 },
        { referrer: "host.example", views: 2 },
        { referrer: "count-page.example", views: 1 },
        { referrer: "count-source.example", views: 1 },
        { referrer: "excluded.example", views: 1 },
        { referrer: "native-only.example", views: 1 },
      ],
    };
    const expectedPagePrefix = [
      { referrer: "", views: 2, sessions: 1, visitors: 1 },
      {
        referrer: " https://Host.Example/a ",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
      {
        referrer: "https://Host.Example/a",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
      {
        referrer: "https://Host.Example/a2",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
    ];
    const summaryQuery = queryFor({
      scope: "visitor",
      variant: "summary",
      topN: 20,
      filterDsl,
    });
    const oldSummaryTrace = traceFor();
    const oldSummary = await legacyRead(
      database,
      summaryQuery,
      oldSummaryTrace,
    );
    const summaryDeferred = await deferredFor(database, summaryQuery);
    const compiledSummary = compileQuery(summaryDeferred, summaryQuery);
    if (compiledSummary.kind !== "compiled")
      throw new Error("wave97db_or_summary_compile_unavailable");

    const pageOneQuery = queryFor({
      scope: "visitor",
      limit: 2,
      includeFullUrl: true,
      sort: "visitors",
      direction: "desc",
      filterDsl,
    });
    const oldPageOneTrace = traceFor();
    const oldPageOne = await legacyRead(
      database,
      pageOneQuery,
      oldPageOneTrace,
    );
    const oldPageOneValue = oldPageOne.value as {
      readonly items: readonly unknown[];
      readonly pagination: { readonly nextCursor: string | null };
    };
    if (!oldPageOneValue.pagination.nextCursor)
      throw new Error("wave97db_or_old_cursor_missing");
    const pageTwoQuery = queryFor({
      scope: "visitor",
      limit: 2,
      includeFullUrl: true,
      sort: "visitors",
      direction: "desc",
      cursor: oldPageOneValue.pagination.nextCursor,
      filterDsl,
    });
    const oldPageTwoTrace = traceFor();
    const oldPageTwo = await legacyRead(
      database,
      pageTwoQuery,
      oldPageTwoTrace,
    );

    const readActual = async (query: ReferrersQuery) => {
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
        diagnostics,
      }).resolve("referrers");
      if (!provider) throw new Error("wave97db_or_provider_missing");
      const result = await provider.execute(query as never);
      return {
        value: result.value,
        trace,
        diagnostics,
        envelopeRows: readEnvelopeRows(database, trace),
      };
    };
    const actualSummary = await readActual(summaryQuery);
    const actualPageOne = await readActual(pageOneQuery);
    const actualPageTwo = await readActual(pageTwoQuery);
    const pageOneDeferred = await deferredFor(database, pageOneQuery);
    const compiledPageOne = compileQuery(pageOneDeferred, pageOneQuery);
    if (compiledPageOne.kind !== "compiled")
      throw new Error("wave97db_or_page_compile_unavailable");
    persistWholeBooleanEvidence("visitor-or", {
      case: "visitor-scope mixed OR",
      filters: summaryQuery.filters,
      countDocument: summaryDeferred.countInput.analysis.document,
      expected: {
        summary: expectedSummary,
        pagePrefix: expectedPagePrefix,
        ownerSemantics: {
          nativeOnly: "or-native-only-visitor",
          countOnlyCrossSession: "or-count-only-visitor",
          neitherExcluded: "or-neither-visitor",
        },
      },
      oldProducerReader: {
        summary: oldSummary.value,
        summaryTrace: oldSummaryTrace,
        pageOne: oldPageOne.value,
        pageOneTrace: oldPageOneTrace,
        oldCursor: oldPageOneValue.pagination.nextCursor,
        pageTwo: oldPageTwo.value,
        pageTwoTrace: oldPageTwoTrace,
      },
      newFusedReader: {
        summary: actualSummary.value,
        summaryTrace: actualSummary.trace,
        summaryEnvelopeRows: actualSummary.envelopeRows,
        summaryDiagnostics: actualSummary.diagnostics,
        pageOne: actualPageOne.value,
        pageOneTrace: actualPageOne.trace,
        pageOneEnvelopeRows: actualPageOne.envelopeRows,
        pageOneDiagnostics: actualPageOne.diagnostics,
        pageTwoUsingOldCursor: actualPageTwo.value,
        pageTwoTrace: actualPageTwo.trace,
        pageTwoEnvelopeRows: actualPageTwo.envelopeRows,
        pageTwoDiagnostics: actualPageTwo.diagnostics,
      },
      compiled: {
        summary: compiledSummary.evidence,
        pageOne: compiledPageOne.evidence,
      },
    });

    expect(summaryDeferred.filters.root).toEqual(summaryQuery.filters?.root);
    expect(summaryDeferred.countInput.analysis.document.root).toEqual(
      summaryQuery.filters?.root,
    );
    expect(oldSummary.value).toEqual(expectedSummary);
    expect(actualSummary.value).toEqual(oldSummary.value);
    expect(actualSummary.value).toEqual(expectedSummary);
    expect(oldPageOne.value).toMatchObject({
      items: expectedPagePrefix.slice(0, 2),
      pagination: { limit: 2, returned: 2, hasMore: true },
    });
    expect(actualPageOne.value).toEqual(oldPageOne.value);
    expect(oldPageTwo.value).toMatchObject({
      items: expectedPagePrefix.slice(2, 4),
      pagination: { limit: 2, returned: 2, hasMore: true },
    });
    expect(actualPageTwo.value).toEqual(oldPageTwo.value);
    const pagedItems = [
      ...(
        actualPageOne.value as {
          readonly items: readonly { readonly referrer: string }[];
        }
      ).items,
      ...(
        actualPageTwo.value as {
          readonly items: readonly { readonly referrer: string }[];
        }
      ).items,
    ];
    expect(pagedItems.map(({ referrer }) => referrer)).toEqual(
      expectedPagePrefix.map(({ referrer }) => referrer),
    );
    expect(new Set(pagedItems.map(({ referrer }) => referrer)).size).toBe(4);
    for (const actual of [actualSummary, actualPageOne, actualPageTwo]) {
      expect(actual.trace.preparedSql).toHaveLength(2);
      expect(actual.trace.preparedSql.slice(1)).toHaveLength(1);
      expect(actual.diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      for (const [index, sql] of actual.trace.preparedSql.entries()) {
        expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(
          D1_MAX_SQL_UTF8_BYTES,
        );
        expect(actual.trace.bindings[index]?.length ?? 0).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      }
    }
    expect(actualSummary.trace.preparedSql[1]).toBe(
      compiledSummary.evidence.sql,
    );
    expect(actualSummary.trace.bindings[1]).toEqual(
      compiledSummary.evidence.bindings,
    );
    expect(actualPageOne.trace.preparedSql[1]).toBe(
      compiledPageOne.evidence.sql,
    );
    expect(actualPageOne.trace.bindings[1]).toEqual(
      compiledPageOne.evidence.bindings,
    );
    expect(
      actualSummary.envelopeRows.some((row) => row.rowKind === "control"),
    ).toBe(true);
    expect(
      new Set(
        actualSummary.envelopeRows
          .filter((row) => row.rowKind === "report")
          .map((row) => row.outputId),
      ),
    ).toEqual(new Set(["referrer-summary", "referrer-top-sources"]));
    expect(
      actualPageOne.envelopeRows.some((row) => row.rowKind === "control"),
    ).toBe(true);
    expect(
      new Set(
        actualPageOne.envelopeRows
          .filter((row) => row.rowKind === "report")
          .map((row) => row.outputId),
      ),
    ).toEqual(new Set(["referrers-page"]));
  });

  it("Direct Referrers whole Boolean qualification matches session NOT as an entity complement", async () => {
    const { database, site } = createFixture();
    addWholeBooleanNotVisits(database, site);
    const filterDsl =
      'not (page.path eq "/excluded" or count(event { event.name eq "qualifier" }) gte 1)';
    const expectedSummary = {
      totalViews: 4,
      directViews: 0,
      externalViews: 4,
      uniqueDomains: 4,
      uniqueLinks: 4,
      truncated: false,
      topSources: [
        { referrer: "Host.Example", views: 1 },
        { referrer: "not-neither.example", views: 1 },
        { referrer: "scope-neither.example", views: 1 },
        { referrer: "unqualified.example", views: 1 },
      ],
    };
    const expectedPagePrefix = [
      {
        referrer: "https://Host.Example/a2",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
      {
        referrer: "https://not-neither.example/",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
      {
        referrer: "https://scope-neither.example/",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
      {
        referrer: "https://unqualified.example/",
        views: 1,
        sessions: 1,
        visitors: 1,
      },
    ];
    const summaryQuery = queryFor({
      scope: "session",
      variant: "summary",
      topN: 20,
      filterDsl,
    });
    const oldSummaryTrace = traceFor();
    const oldSummary = await legacyRead(
      database,
      summaryQuery,
      oldSummaryTrace,
    );
    const summaryDeferred = await deferredFor(database, summaryQuery);
    const compiledSummary = compileQuery(summaryDeferred, summaryQuery);
    if (compiledSummary.kind !== "compiled")
      throw new Error("wave97db_not_summary_compile_unavailable");

    const pageOneQuery = queryFor({
      scope: "session",
      limit: 2,
      includeFullUrl: true,
      sort: "visitors",
      direction: "desc",
      filterDsl,
    });
    const oldPageOneTrace = traceFor();
    const oldPageOne = await legacyRead(
      database,
      pageOneQuery,
      oldPageOneTrace,
    );
    const oldPageOneValue = oldPageOne.value as {
      readonly items: readonly unknown[];
      readonly pagination: { readonly nextCursor: string | null };
    };
    if (!oldPageOneValue.pagination.nextCursor)
      throw new Error("wave97db_not_old_cursor_missing");
    const pageTwoQuery = queryFor({
      scope: "session",
      limit: 2,
      includeFullUrl: true,
      sort: "visitors",
      direction: "desc",
      cursor: oldPageOneValue.pagination.nextCursor,
      filterDsl,
    });
    const oldPageTwoTrace = traceFor();
    const oldPageTwo = await legacyRead(
      database,
      pageTwoQuery,
      oldPageTwoTrace,
    );

    const readActual = async (query: ReferrersQuery) => {
      const trace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
        diagnostics,
      }).resolve("referrers");
      if (!provider) throw new Error("wave97db_not_provider_missing");
      const result = await provider.execute(query as never);
      return {
        value: result.value,
        trace,
        diagnostics,
        envelopeRows: readEnvelopeRows(database, trace),
      };
    };
    const actualSummary = await readActual(summaryQuery);
    const actualPageOne = await readActual(pageOneQuery);
    const actualPageTwo = await readActual(pageTwoQuery);
    const pageOneDeferred = await deferredFor(database, pageOneQuery);
    const compiledPageOne = compileQuery(pageOneDeferred, pageOneQuery);
    if (compiledPageOne.kind !== "compiled")
      throw new Error("wave97db_not_page_compile_unavailable");
    persistWholeBooleanEvidence("session-not", {
      case: "session-scope whole NOT complement",
      filters: summaryQuery.filters,
      countDocument: summaryDeferred.countInput.analysis.document,
      expected: {
        summary: expectedSummary,
        pagePrefix: expectedPagePrefix,
        ownerSemantics: {
          nativeOnlyExcluded: "not-native-only-session",
          countOnlyExcluded: "not-count-only-session",
          neitherIncluded: "not-neither-session",
          countedVisitorSiblingExcluded: "not-scope-counted-session",
          matchingSessionIncluded: "not-scope-neither-session",
        },
      },
      oldProducerReader: {
        summary: oldSummary.value,
        summaryTrace: oldSummaryTrace,
        pageOne: oldPageOne.value,
        pageOneTrace: oldPageOneTrace,
        oldCursor: oldPageOneValue.pagination.nextCursor,
        pageTwo: oldPageTwo.value,
        pageTwoTrace: oldPageTwoTrace,
      },
      newFusedReader: {
        summary: actualSummary.value,
        summaryTrace: actualSummary.trace,
        summaryEnvelopeRows: actualSummary.envelopeRows,
        summaryDiagnostics: actualSummary.diagnostics,
        pageOne: actualPageOne.value,
        pageOneTrace: actualPageOne.trace,
        pageOneEnvelopeRows: actualPageOne.envelopeRows,
        pageOneDiagnostics: actualPageOne.diagnostics,
        pageTwoUsingOldCursor: actualPageTwo.value,
        pageTwoTrace: actualPageTwo.trace,
        pageTwoEnvelopeRows: actualPageTwo.envelopeRows,
        pageTwoDiagnostics: actualPageTwo.diagnostics,
      },
      compiled: {
        summary: compiledSummary.evidence,
        pageOne: compiledPageOne.evidence,
      },
    });

    expect(summaryDeferred.filters.root).toEqual(summaryQuery.filters?.root);
    expect(summaryDeferred.countInput.analysis.document.root).toEqual(
      summaryQuery.filters?.root,
    );
    expect(oldSummary.value).toEqual(expectedSummary);
    expect(actualSummary.value).toEqual(oldSummary.value);
    expect(actualSummary.value).toEqual(expectedSummary);
    expect(oldPageOne.value).toMatchObject({
      items: expectedPagePrefix.slice(0, 2),
      pagination: { limit: 2, returned: 2, hasMore: true },
    });
    expect(actualPageOne.value).toEqual(oldPageOne.value);
    expect(oldPageTwo.value).toMatchObject({
      items: expectedPagePrefix.slice(2, 4),
      pagination: { limit: 2, returned: 2, hasMore: false },
    });
    expect(actualPageTwo.value).toEqual(oldPageTwo.value);
    const pagedItems = [
      ...(
        actualPageOne.value as {
          readonly items: readonly { readonly referrer: string }[];
        }
      ).items,
      ...(
        actualPageTwo.value as {
          readonly items: readonly { readonly referrer: string }[];
        }
      ).items,
    ];
    expect(pagedItems.map(({ referrer }) => referrer)).toEqual(
      expectedPagePrefix.map(({ referrer }) => referrer),
    );
    expect(new Set(pagedItems.map(({ referrer }) => referrer)).size).toBe(4);
    for (const actual of [actualSummary, actualPageOne, actualPageTwo]) {
      expect(actual.trace.preparedSql).toHaveLength(2);
      expect(actual.trace.preparedSql.slice(1)).toHaveLength(1);
      expect(actual.diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      for (const [index, sql] of actual.trace.preparedSql.entries()) {
        expect(new TextEncoder().encode(sql).byteLength).toBeLessThanOrEqual(
          D1_MAX_SQL_UTF8_BYTES,
        );
        expect(actual.trace.bindings[index]?.length ?? 0).toBeLessThanOrEqual(
          D1_MAX_BOUND_PARAMETERS,
        );
      }
    }
    expect(actualSummary.trace.preparedSql[1]).toBe(
      compiledSummary.evidence.sql,
    );
    expect(actualSummary.trace.bindings[1]).toEqual(
      compiledSummary.evidence.bindings,
    );
    expect(actualPageOne.trace.preparedSql[1]).toBe(
      compiledPageOne.evidence.sql,
    );
    expect(actualPageOne.trace.bindings[1]).toEqual(
      compiledPageOne.evidence.bindings,
    );
    expect(
      actualSummary.envelopeRows.some((row) => row.rowKind === "control"),
    ).toBe(true);
    expect(
      new Set(
        actualSummary.envelopeRows
          .filter((row) => row.rowKind === "report")
          .map((row) => row.outputId),
      ),
    ).toEqual(new Set(["referrer-summary", "referrer-top-sources"]));
    expect(
      actualPageOne.envelopeRows.some((row) => row.rowKind === "control"),
    ).toBe(true);
    expect(
      new Set(
        actualPageOne.envelopeRows
          .filter((row) => row.rowKind === "report")
          .map((row) => row.outputId),
      ),
    ).toEqual(new Set(["referrers-page"]));
  });

  it("uses one whole-reader legacy fallback for numeric incompatibility", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "a-source");
    const query = queryFor({
      scope: "session",
      limit: 2,
      filterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) gte 1`,
    });
    const oldTrace = traceFor();
    const legacy = await legacyRead(database, query, oldTrace);
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("referrers");
    if (!provider) throw new Error("wave96e_numeric_provider_missing");
    const actual = await provider.execute(query as never);
    expect(actual.value).toEqual(legacy.value);
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });
    expect(trace.preparedSql.length).toBe(oldTrace.preparedSql.length + 1);
    for (const sql of oldTrace.preparedSql) {
      expect(
        trace.preparedSql.filter((prepared) => prepared === sql),
      ).toHaveLength(1);
    }
    recordEvidence("numeric-whole-reader-fallback", {
      actual: actual.value,
      legacy: legacy.value,
      runtimeStatements: trace.preparedSql,
      legacyStatements: oldTrace.preparedSql,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
    });
  });

  it("keeps malformed cursor precedence after numeric fallback without an old report read", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "a-source");
    const query = queryFor({
      scope: "session",
      limit: 2,
      cursor: "malformed-cursor",
      filterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) gte 1`,
    });

    const legacyTrace = traceFor();
    let legacyError: unknown;
    try {
      await legacyRead(database, query, legacyTrace);
    } catch (error) {
      legacyError = error;
    }
    expect(legacyError).toBeInstanceOf(InvalidCursorError);

    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("referrers");
    if (!provider)
      throw new Error("wave96e_invalid_cursor_numeric_provider_missing");
    let actualError: unknown;
    try {
      await provider.execute(query as never);
    } catch (error) {
      actualError = error;
    }
    expect(actualError).toBeInstanceOf(InvalidCursorError);
    expect(actualError).toMatchObject({
      name: (legacyError as Error).name,
      kind: (legacyError as { readonly kind: unknown }).kind,
      cursorKind: (legacyError as { readonly cursorKind: unknown }).cursorKind,
    });
    expect(diagnostics.advancedCountSqlFallbackReason).toMatchObject({
      kind: "numeric-data-domain",
    });

    expect(trace.preparedSql.length).toBe(legacyTrace.preparedSql.length + 1);
    for (const sql of legacyTrace.preparedSql) {
      expect(
        trace.preparedSql.filter((prepared) => prepared === sql),
      ).toHaveLength(1);
    }
    const qualificationSql = trace.preparedSql.filter(
      (sql) => !legacyTrace.preparedSql.includes(sql),
    );
    expect(qualificationSql).toHaveLength(1);
    expect(qualificationSql[0]).toContain("referrers-page");
    recordEvidence("numeric-fallback-invalid-cursor-no-old-report", {
      legacyError: {
        name: (legacyError as Error).name,
        kind: (legacyError as { readonly kind: unknown }).kind,
        cursorKind: (legacyError as { readonly cursorKind: unknown })
          .cursorKind,
      },
      actualError: {
        name: (actualError as Error).name,
        kind: (actualError as { readonly kind: unknown }).kind,
        cursorKind: (actualError as { readonly cursorKind: unknown })
          .cursorKind,
      },
      legacyPreparationAndDecodeStatementCount: legacyTrace.preparedSql.length,
      runtimeStatementCount: trace.preparedSql.length,
      runtimeStatementHashes: trace.preparedSql.map((sql) =>
        createHash("sha256").update(sql).digest("hex"),
      ),
      legacyStatementHashes: legacyTrace.preparedSql.map((sql) =>
        createHash("sha256").update(sql).digest("hex"),
      ),
      qualificationSqlBytes: Buffer.byteLength(qualificationSql[0]!),
      oldReportSqlCount: 0,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
    });
  });

  it("checks Count cap before malformed cursor handling", async () => {
    const database = createMigratedDatabase();
    databases.add(database);
    database.exec("PRAGMA foreign_keys = OFF");
    const site = addSite(database);
    const bulkCount = ADVANCED_FILTER_MAX_ACTIVITIES + 1;
    database
      .prepare(
        `WITH RECURSIVE generated(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM generated WHERE n < ?
        ) INSERT INTO visits (
          visit_id, site_id, site_pk, visitor_id, session_id, status,
          started_at, last_activity_at, pathname, hostname, referrer_host,
          referrer_url, duration_ms
        ) SELECT 'wave96e-cap-' || n, ?, ?, 'wave96e-cap-visitor',
          'wave96e-cap-session', 'closed', 125, 125, '/bulk', 'site.test',
          'bulk.example', 'https://bulk.example/', 10 FROM generated`,
      )
      .run(bulkCount, site.id, site.pk);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave96e-cap-1");
    const query = queryFor({
      limit: 2,
      cursor: "malformed-cursor",
      filterDsl:
        'page.path eq "/bulk" and count(page { page.durationMs gt 5 }) eq 1',
    });
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const gateProbe = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      site.id,
    )("referrers", query, async (prepared) => prepared);
    const gateDeferred = deferredReferrersQualificationFromQuery(gateProbe);
    expect(gateDeferred?.referrersRequest).toMatchObject({
      kind: "page",
      limit: 2,
      cursorText: "malformed-cursor",
    });
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: site.id,
      diagnostics,
    }).resolve("referrers");
    if (!provider) throw new Error("wave96e_cap_provider_missing");
    let capError: unknown;
    try {
      await provider.execute(query as never);
    } catch (error) {
      capError = error;
    }
    const controlRows = trace.preparedSql.flatMap((sql, index) =>
      database
        .prepare(sql)
        .all(...trace.bindings[index]!)
        .filter((row) => row.rowKind === "control"),
    );
    expect(capError).toMatchObject({
      domainError: {
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(trace.preparedSql).toHaveLength(2);
    expect(controlRows).toHaveLength(1);
    expect(Number(controlRows[0]!.rawCount)).toBe(bulkCount);
    expect(
      Object.entries(controlRows[0]!).some(
        ([name, value]) =>
          name.toLowerCase().includes("duration") && Number(value) > 0,
      ),
    ).toBe(true);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    recordEvidence("count-cap-before-invalid-cursor", {
      rawCount: bulkCount,
      limit: ADVANCED_FILTER_MAX_ACTIVITIES,
      statementCount: trace.preparedSql.length,
      numericMismatch: true,
      error: "filter_activity_limit_exceeded",
    });
  });

  it("rejects malformed summary rows, duplicate scalars, database failures and aborts", async () => {
    const invalidCases = [
      [
        "missing-control",
        "analytics_event_summary_qualification_control_row_invalid",
      ],
      [
        "duplicate-summary",
        "analytics_referrers_qualification_summary_cardinality",
      ],
      [
        "wrong-row-type",
        "analytics_event_summary_qualification_report_row_invalid",
      ],
      [
        "invalid-schema",
        "analytics_event_summary_qualification_report_row_invalid",
      ],
    ] as const;
    for (const [behavior, error] of invalidCases) {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnvWithReportBehavior(database, trace, behavior),
        siteId: SITE,
      }).resolve("referrers");
      if (!provider) throw new Error("wave96e_invalid_rows_provider_missing");
      await expect(
        provider.execute(queryFor({ variant: "summary" }) as never),
      ).rejects.toThrow(error);
      expect(trace.preparedSql).toHaveLength(2);
      recordEvidence("malformed-referrer-envelope", {
        behavior,
        error,
        statementCount: trace.preparedSql.length,
        fallbackRan: false,
      });
    }

    const { database } = createFixture();
    const dbTrace = traceFor();
    const dbProvider = createD1SiteProviderRegistry({
      env: testEnvWithDatabaseFailure(database, dbTrace),
      siteId: SITE,
    }).resolve("referrers");
    if (!dbProvider) throw new Error("wave96e_db_failure_provider_missing");
    await expect(
      dbProvider.execute(queryFor({ variant: "summary" }) as never),
    ).rejects.toThrow("wave96e_referrers_database_failure");
    expect(dbTrace.preparedSql).toHaveLength(2);

    const preAbortTrace = traceFor();
    const preAbortProvider = createD1SiteProviderRegistry({
      env: testEnv(database, preAbortTrace),
      siteId: SITE,
    }).resolve("referrers");
    if (!preAbortProvider) throw new Error("wave96e_preabort_provider_missing");
    const preAbort = new AbortController();
    preAbort.abort();
    await expect(
      preAbortProvider.execute(queryFor({ variant: "summary" }) as never, {
        signal: preAbort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(preAbortTrace.preparedSql).toHaveLength(0);

    const postAbortTrace = traceFor();
    const postAbort = new AbortController();
    const postAbortProvider = createD1SiteProviderRegistry({
      env: testEnvThatAbortsAfterCount(database, postAbortTrace, postAbort),
      siteId: SITE,
    }).resolve("referrers");
    if (!postAbortProvider)
      throw new Error("wave96e_postabort_provider_missing");
    await expect(
      postAbortProvider.execute(queryFor({ variant: "summary" }) as never, {
        signal: postAbort.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(postAbortTrace.preparedSql).toHaveLength(1);
    recordEvidence("referrer-db-and-abort-errors", {
      databaseErrorPropagated: true,
      preAbortStatements: preAbortTrace.preparedSql.length,
      postAbortStatements: postAbortTrace.preparedSql.length,
    });
  });
});
