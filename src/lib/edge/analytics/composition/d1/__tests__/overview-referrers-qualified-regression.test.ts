import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { afterAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
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
import { ADVANCED_FILTER_MAX_ACTIVITIES } from "@/lib/edge/analytics/engine/advanced-filter-activity-plan";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  snapshotLogicalPlan,
  type ValidatedLogicalPlan,
} from "@/lib/edge/analytics/engine/logical/plan";
import { buildReferrerPageQualificationPlan } from "@/lib/edge/analytics/engine/referrer-page-qualification-plan";
import {
  buildReferrersPagePlan,
  normalizeReferrerOverviewTableRequest,
} from "@/lib/edge/analytics/engine/referrer-report-plan";
import { EVENT_FILTER_PAGE_VISIT_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import {
  d1AdvancedFilterMiddleware,
  deferredReferrerOverviewQualificationFromQuery,
  prepareDeferredEventQualificationFallback,
  prepareDeferredPageVisitQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { compilePageDimensionQualificationProgram } from "@/lib/edge/analytics/providers/d1/internal/analytics-qualification-program";
import { mapTabs } from "@/lib/edge/analytics/providers/d1/internal/core";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { queryDimensionPageFromD1 } from "@/lib/edge/analytics/providers/d1/internal/dimensions";
import {
  bindPageVisitQualificationPreparation,
  pageVisitQualificationConsumerKey,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import {
  decodeReferrersCursor,
  queryReferrersPageFromD1,
  type ReferrerAggregateCursor,
} from "@/lib/edge/analytics/providers/d1/internal/referrers";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import { InvalidCursorError } from "@/lib/pagination";

const SITE = "wave95m-overview-referrers";
const TIME = createQueryTime(120, 140, "UTC", 500);
const WINDOW = {
  startMs: 120,
  endExclusiveMs: 140,
  nowMs: 500,
  timeZone: "UTC",
} as const;
const CURSOR_SECRET = "wave95m-overview-referrers-test-secret";
const PLAN_SHA256 =
  "8C3586AC666FD8419B501E526CCB8BA245ECA263680705CD4D89CE8B5253EBD1";
const BASE_FILTER =
  'page.path neq "/excluded" and count(event { event.name eq "qualifier" }) gte 1';
const databases = new Set<DatabaseSync>();
const evidence: Array<Record<string, unknown>> = [];

interface TestSite {
  readonly id: string;
  readonly pk: number;
}

interface ReferrerOverviewQuery extends QueryInput {
  readonly mode: "overview-tab";
  readonly time: QueryTime;
  readonly tab: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
  readonly search?: string;
}

interface QueryOptions {
  readonly tab?: string;
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly sort?: string;
  readonly direction?: "asc" | "desc";
  readonly search?: string;
  readonly audience?: "private-dashboard" | "api-v1" | "public-share";
  readonly filterDsl?: string;
}

interface ReferrerItem {
  readonly label: string;
  readonly views: number;
  readonly sessions: number;
  readonly visitors: number;
}

interface ReferrerDto {
  readonly data: {
    readonly items: readonly ReferrerItem[];
    readonly pagination: {
      readonly limit: number;
      readonly returned: number;
      readonly hasMore: boolean;
      readonly nextCursor: string | null;
    };
  };
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
       VALUES (?, 'wave95m-team', 'Referrer qualification', 'referrer.test', 0)`,
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
  if (!input.event) return;
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (1, ?, 'qualifier', ?, ?) ON CONFLICT(id) DO NOTHING`,
    )
    .run(site.id, input.at, site.pk);
  database
    .prepare(
      `INSERT INTO custom_events (
        event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
        received_at, sequence, node_count, value_count
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 1, 0, 0)`,
    )
    .run(`event-${input.id}`, site.id, site.pk, input.id, input.at, input.at);
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
      id: "visit-host-a1",
      sessionId: "session-host-a",
      visitorId: "visitor-shared",
      path: "/host/a",
      referrerHost: "Host.Example",
      referrerUrl: "https://Host.Example/a?x=1",
      at: 121,
      event: true,
    },
    {
      id: "visit-host-a2",
      sessionId: "session-host-a",
      visitorId: "visitor-shared",
      path: "/host/b",
      referrerHost: "Host.Example",
      referrerUrl: "https://Host.Example/b?x=2",
      at: 122,
      event: true,
    },
    {
      id: "visit-host-b",
      sessionId: "session-host-b",
      visitorId: "visitor-shared",
      path: "/host/c",
      referrerHost: "host.example",
      referrerUrl: "https://host.example/c",
      at: 123,
      event: true,
    },
    {
      id: "visit-direct-a",
      sessionId: "session-direct",
      visitorId: "visitor-direct",
      path: "/direct/a",
      referrerHost: "",
      referrerUrl: "",
      at: 124,
      event: true,
    },
    {
      id: "visit-direct-b",
      sessionId: "session-direct",
      visitorId: "visitor-direct",
      path: "/direct/b",
      referrerHost: "",
      referrerUrl: "",
      at: 125,
      event: true,
    },
    {
      id: "visit-z-a",
      sessionId: "session-z",
      visitorId: "visitor-z",
      path: "/z/a",
      referrerHost: "z.example",
      referrerUrl: "https://z.example/a",
      at: 126,
      event: true,
    },
    {
      id: "visit-z-b",
      sessionId: "session-z",
      visitorId: "visitor-z",
      path: "/z/b",
      referrerHost: "z.example",
      referrerUrl: "https://z.example/b",
      at: 127,
      event: true,
    },
    {
      id: "visit-raw-space",
      sessionId: "session-space",
      visitorId: "visitor-space",
      path: "/space",
      referrerHost: " Host.Example ",
      referrerUrl: " https://Host.Example/space ",
      at: 128,
      event: true,
    },
    {
      id: "visit-no-match",
      sessionId: "session-no-match",
      visitorId: "visitor-no-match",
      path: "/no-match",
      referrerHost: "no-match.example",
      referrerUrl: "https://no-match.example/no-match",
      at: 129,
      event: false,
    },
    {
      id: "visit-excluded",
      sessionId: "session-excluded",
      visitorId: "visitor-excluded",
      path: "/excluded",
      referrerHost: "excluded.example",
      referrerUrl: "https://excluded.example/",
      at: 130,
      event: true,
    },
  ] as const;
  for (const visit of visits) addVisit(database, site, visit);
  return { database, site };
}

function testEnv(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: CURSOR_SECRET,
  } as unknown as Env;
}

function queryFor(
  scope: "session" | "visitor" | "event",
  options: QueryOptions = {},
): ReferrerOverviewQuery {
  const prepared = prepareScopedQuery("dimension", {
    context: siteQueryContext(SITE, options.audience ?? "private-dashboard"),
    time: TIME,
    filters: parseFilterDsl(
      options.filterDsl ?? BASE_FILTER,
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  } as QueryInput & { readonly time: typeof TIME });
  return {
    ...prepared,
    mode: "overview-tab",
    tab: options.tab ?? "source.domain",
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.sort !== undefined ? { sort: options.sort } : {}),
    ...(options.direction !== undefined
      ? { direction: options.direction }
      : {}),
    ...(options.search !== undefined ? { search: options.search } : {}),
  } as ReferrerOverviewQuery;
}

function normalizedRequest(query: ReferrerOverviewQuery) {
  return normalizeReferrerOverviewTableRequest({
    mode: query.mode,
    tab: query.tab,
    limit: query.limit,
    cursor: query.cursor,
    sort: query.sort,
    direction: query.direction,
    search: query.search,
  });
}

function referrerDto(
  page: Awaited<ReturnType<typeof queryReferrersPageFromD1>>,
): ReferrerDto {
  return {
    data: {
      items: page.items.map((row) => ({
        label: row.referrer,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      })),
      pagination: page.pagination,
    },
  };
}

/** Independent legacy oracle: middleware Count evaluation plus the old reader. */
async function legacyReferrerFor(
  database: DatabaseSync,
  query: ReferrerOverviewQuery,
  trace: SqliteD1Trace,
) {
  const env = testEnv(database, trace);
  const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
    "dimension",
    query,
    async (prepared) => prepared,
  );
  const deferred = deferredReferrerOverviewQualificationFromQuery(forwarded);
  const filters = deferred
    ? await prepareDeferredEventQualificationFallback(deferred)
    : ((forwarded as ReferrerOverviewQuery).filters ?? query.filters);
  const normalized = normalizedRequest(query);
  if (!filters || !normalized)
    throw new Error("wave95m_legacy_referrer_request_invalid");
  const cursor = await decodeReferrersCursor(
    env,
    SITE,
    WINDOW,
    filters,
    normalized.includeFullUrl,
    normalized.search,
    normalized.cursorText,
    query.context.policy.audience,
    normalized.sortBy,
    normalized.sortDirection,
  );
  if (normalized.cursorText && !cursor)
    throw new InvalidCursorError("overview-tab");
  const page = await queryReferrersPageFromD1(
    env,
    SITE,
    WINDOW,
    filters,
    normalized.limit,
    normalized.includeFullUrl,
    normalized.search,
    cursor,
    undefined,
    query.context.policy.audience,
    normalized.sortBy,
    normalized.sortDirection,
  );
  return { dto: referrerDto(page), deferred, filters, normalized, cursor };
}

function qualifiedQuery(
  query: ReferrerOverviewQuery,
  normalized: NonNullable<ReturnType<typeof normalizedRequest>>,
  cursor: ReferrerAggregateCursor | null = null,
) {
  return {
    siteId: SITE,
    queryTime: query.time,
    filters: query.filters!,
    ...(query.scopePlan ? { scopePlan: query.scopePlan } : {}),
    family: "referrer-overview" as const,
    tab: normalized.tab,
    includeFullUrl: normalized.includeFullUrl,
    limit: normalized.limit,
    cursor,
    cursorToken: normalized.cursorText,
    ...(normalized.search !== undefined ? { search: normalized.search } : {}),
    sortBy: normalized.sortBy,
    sortDirection: normalized.sortDirection,
    audience: query.context.policy.audience,
  } as const;
}

function testEnvWithControlBehavior(
  database: DatabaseSync,
  trace: SqliteD1Trace,
  behavior:
    | "missing-control"
    | "duplicate-control"
    | "wrong-control-scope"
    | "invalid-report-schema",
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
          const control = result.results.find(
            (row) => row.rowKind === "control",
          );
          if (behavior === "missing-control")
            return {
              ...result,
              results: result.results.filter(
                (row) => row.rowKind !== "control",
              ),
            };
          if (behavior === "duplicate-control" && control)
            return { ...result, results: [...result.results, control] };
          if (behavior === "invalid-report-schema")
            return {
              ...result,
              results: result.results.map((row) =>
                row.rowKind === "report" ? { ...row, referrer: 10 } : row,
              ),
            };
          return {
            ...result,
            results: result.results.map((row) =>
              row.rowKind === "control"
                ? { ...row, entityKind: "visitor" }
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

function testEnvWithSqliteFailure(
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
          throw new Error("wave95m_sqlite_report_failure");
        },
      });
      return replacement;
    },
  } as unknown as D1Database;
  return { DB, MAIN_SECRET: CURSOR_SECRET } as unknown as Env;
}

function recordEvidence(kind: string, values: Record<string, unknown>): void {
  evidence.push({ kind, ...values });
}

afterAll(async () => {
  for (const database of databases) database.close();
  const artifactDir = process.env.WAVE97DE_EVIDENCE_DIRECTORY;
  if (!artifactDir) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    `${artifactDir}/overview-referrers-regression-evidence.json`,
    JSON.stringify({ planSha256: PLAN_SHA256, evidence }, null, 2),
    { encoding: "utf8", flag: "wx" },
  );
});

describe("qualified source.domain and source.link Referrer tables", () => {
  const defaultCases = (["source.domain", "source.link"] as const).flatMap(
    (tab) =>
      (["session", "visitor", "event"] as const).map((scope) => ({
        tab,
        scope,
      })),
  );
  const cursorCases = (["source.domain", "source.link"] as const).flatMap(
    (tab) =>
      (["session", "visitor", "event"] as const).flatMap((scope) =>
        (["views", "visitors"] as const).flatMap((sort) =>
          (["asc", "desc"] as const).map((direction) => ({
            tab,
            scope,
            sort,
            direction,
          })),
        ),
      ),
  );

  describe("Private Referrer overview whole Boolean qualification", () => {
    const wholeBooleanCases: {
      readonly tab: "source.domain" | "source.link";
      readonly scope: "session" | "visitor";
      readonly filterDsl: string;
      readonly cursorWalk: boolean;
      readonly expectedItems: readonly ReferrerItem[];
    }[] = [
      {
        tab: "source.domain",
        scope: "session",
        filterDsl:
          'page.path eq "/no-match" or count(event { event.name eq "qualifier" }) eq 2',
        cursorWalk: false,
        expectedItems: [
          { label: "", views: 2, sessions: 1, visitors: 1 },
          { label: "Host.Example", views: 2, sessions: 1, visitors: 1 },
          { label: "no-match.example", views: 1, sessions: 1, visitors: 1 },
          { label: "z.example", views: 2, sessions: 1, visitors: 1 },
        ],
      },
      {
        tab: "source.link",
        scope: "visitor",
        filterDsl:
          'page.path eq "/no-match" or count(event { event.name eq "qualifier" }) eq 3',
        cursorWalk: true,
        expectedItems: [
          {
            label: "https://Host.Example/a?x=1",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            label: "https://Host.Example/b?x=2",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            label: "https://host.example/c",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            label: "https://no-match.example/no-match",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
      },
      {
        tab: "source.domain",
        scope: "visitor",
        filterDsl:
          'not (page.path eq "/excluded" and count(event { event.name eq "qualifier" }) eq 1)',
        cursorWalk: false,
        expectedItems: [
          { label: "", views: 2, sessions: 1, visitors: 1 },
          {
            label: " Host.Example ",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          { label: "Host.Example", views: 2, sessions: 1, visitors: 1 },
          { label: "host.example", views: 1, sessions: 1, visitors: 1 },
          {
            label: "no-match.example",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          { label: "z.example", views: 2, sessions: 1, visitors: 1 },
        ],
      },
      {
        tab: "source.link",
        scope: "session",
        filterDsl:
          'not (page.path eq "/excluded" and count(event { event.name eq "qualifier" }) eq 1)',
        cursorWalk: false,
        expectedItems: [
          { label: "", views: 2, sessions: 1, visitors: 1 },
          {
            label: " https://Host.Example/space ",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            label: "https://Host.Example/a?x=1",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            label: "https://Host.Example/b?x=2",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            label: "https://host.example/c",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            label: "https://no-match.example/no-match",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            label: "https://z.example/a",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
          {
            label: "https://z.example/b",
            views: 1,
            sessions: 1,
            visitors: 1,
          },
        ],
      },
    ];

    it.each(wholeBooleanCases)(
      "matches the complete legacy DTO and request trace for $tab/$scope",
      async ({ tab, scope, filterDsl, cursorWalk, expectedItems }) => {
        const { database } = createFixture();
        const runtimeTrace = traceFor();
        const diagnostics = createD1ReadDiagnostics();
        const provider = createD1SiteProviderRegistry({
          env: testEnv(database, runtimeTrace),
          siteId: SITE,
          diagnostics,
        }).resolve("dimension");
        if (!provider)
          throw new Error("wave97de_private_referrer_provider_missing");

        const actualPages: ReferrerDto[] = [];
        const pageEvidence: Array<Record<string, unknown>> = [];
        let cursor: string | null = null;
        let finished = false;
        for (let pageNumber = 0; pageNumber < 12; pageNumber += 1) {
          const query = queryFor(scope, {
            tab,
            filterDsl,
            limit: cursorWalk ? 1 : 100,
            cursor,
          });
          const legacyTrace = traceFor();
          const legacy = await legacyReferrerFor(database, query, legacyTrace);
          expect(legacy.deferred).toBeDefined();
          if (!legacy.deferred || !legacy.normalized)
            throw new Error(
              "wave97de_private_referrer_legacy_preflight_missing",
            );

          const normalizedPage = qualifiedQuery(
            query,
            legacy.normalized,
            legacy.cursor,
          );
          if (
            tab === "source.domain" &&
            scope === "session" &&
            pageNumber === 0
          ) {
            const planInput = {
              siteId: SITE,
              queryTime: query.time,
              filters: query.filters!,
              scopePlan: query.scopePlan!,
              count: legacy.deferred.countInput,
              options: {
                limit: legacy.normalized.limit,
                includeFullUrl: legacy.normalized.includeFullUrl,
                sortBy: legacy.normalized.sortBy,
                sortDirection: legacy.normalized.sortDirection,
                cursor: null,
              },
            };
            expect(() => buildReferrerPageQualificationPlan(planInput)).toThrow(
              "page_dimension_qualification_native_filter_split_unsupported",
            );
            const mismatchedCount = {
              ...legacy.deferred.countInput,
              analysis: {
                ...legacy.deferred.countInput.analysis,
                document: { version: 1 as const, root: null },
              },
            } as typeof legacy.deferred.countInput;
            expect(() =>
              buildReferrerPageQualificationPlan({
                ...planInput,
                filterMode: "allow-whole-filter",
                count: mismatchedCount,
              }),
            ).toThrow(
              "page_dimension_qualification_whole_filter_count_document_mismatch",
            );
          }

          const compiled = compilePageDimensionQualificationProgram({
            deferred: legacy.deferred,
            query: normalizedPage,
          });
          expect(compiled.kind).toBe("compiled");
          if (compiled.kind !== "compiled")
            throw new Error("wave97de_private_referrer_compile_unavailable");
          expect(compiled.evidence.statementTag).toBe(
            "analytics.referrer_overview_qualification",
          );
          expect(compiled.evidence.sqlBytes).toBeLessThanOrEqual(100_000);
          expect(compiled.evidence.bindingCount).toBeLessThanOrEqual(100);
          expect(compiled.evidence.groupWidth).toBeLessThanOrEqual(16);

          const statementOffset = runtimeTrace.preparedSql.length;
          const actual = (await provider.execute(query)).value as ReferrerDto;
          expect(actual).toEqual(legacy.dto);
          const runtimeStatements = runtimeTrace.preparedSql
            .slice(statementOffset)
            .map((sql, index) => ({
              sql,
              bindings: runtimeTrace.bindings[statementOffset + index] ?? [],
            }));
          expect(runtimeStatements).toHaveLength(2);
          expect(runtimeStatements[1]!.sql).toBe(compiled.evidence.sql);
          expect(runtimeStatements[1]!.bindings).toEqual(
            compiled.evidence.bindings,
          );
          expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
          actualPages.push(actual);
          pageEvidence.push({
            pageNumber,
            inputCursor: cursor,
            actualDto: actual,
            legacyDto: legacy.dto,
            legacyStatements: legacyTrace.preparedSql.map((sql, index) => ({
              sql,
              bindings: legacyTrace.bindings[index] ?? [],
            })),
            runtimeStatements,
            compileEvidence: compiled.evidence,
          });

          const nextCursor = legacy.dto.data.pagination.nextCursor;
          if (nextCursor === null) {
            finished = true;
            break;
          }
          if (!cursorWalk) break;
          cursor = nextCursor;
        }

        expect(finished).toBe(true);
        const actualItems = actualPages.flatMap((page) => page.data.items);
        const sortByLabel = (items: readonly ReferrerItem[]) =>
          [...items].sort((left, right) =>
            left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
          );
        expect(sortByLabel(actualItems)).toEqual(sortByLabel(expectedItems));
        expect(new Set(actualItems.map((item) => item.label)).size).toBe(
          actualItems.length,
        );
        if (filterDsl.includes('page.path eq "/no-match"')) {
          expect(actualItems.map((item) => item.label)).toContain(
            tab === "source.domain"
              ? "no-match.example"
              : "https://no-match.example/no-match",
          );
          expect(actualItems.map((item) => item.label)).not.toContain(
            tab === "source.domain"
              ? "excluded.example"
              : "https://excluded.example/",
          );
        }
        expect(actualItems.map((item) => item.label)).not.toContain(
          tab === "source.domain"
            ? "excluded.example"
            : "https://excluded.example/",
        );
        if (tab === "source.link")
          expect(actualItems.map((item) => item.label)).not.toContain(
            "host.example",
          );
        if (scope === "visitor" && filterDsl.includes("eq 3"))
          expect(actualItems.map((item) => item.label)).toContain(
            "https://host.example/c",
          );
        recordEvidence("private-referrer-overview-whole-boolean", {
          tab,
          scope,
          filterDsl,
          expectedItems,
          actualItems,
          pages: pageEvidence,
          distinctReferrers: new Set(actualItems.map((item) => item.label))
            .size,
          pageStatementCounts: pageEvidence.map(
            (page) => (page.runtimeStatements as unknown[]).length,
          ),
          fallbackReason: diagnostics.advancedCountSqlFallbackReason,
          cursorWalk,
        });
      },
    );
  });

  it.each(defaultCases)(
    "matches complete legacy DTO and compile evidence for $tab/$scope",
    async ({ tab, scope }) => {
      const { database } = createFixture();
      const query = queryFor(scope, { tab });
      const oldTrace = traceFor();
      const legacy = await legacyReferrerFor(database, query, oldTrace);
      expect(legacy.deferred).toBeDefined();
      if (!legacy.deferred || !legacy.normalized)
        throw new Error("wave95m_referrer_deferred_missing");
      const qualification = buildReferrerPageQualificationPlan({
        ...(scope === "event"
          ? { filterMode: "allow-whole-filter" as const }
          : {}),
        siteId: SITE,
        queryTime: query.time,
        filters: query.filters!,
        scopePlan: query.scopePlan!,
        count: legacy.deferred.countInput,
        ...("eventCandidateReportProjection" in legacy.deferred &&
        legacy.deferred.eventCandidateReportProjection === "page-visits"
          ? { eventCandidateReportProjection: "page-visits" as const }
          : {}),
        options: {
          limit: legacy.normalized.limit,
          includeFullUrl: legacy.normalized.includeFullUrl,
          ...(legacy.normalized.search !== undefined
            ? { search: legacy.normalized.search }
            : {}),
          sortBy: legacy.normalized.sortBy,
          sortDirection: legacy.normalized.sortDirection,
          cursor: null,
        },
      });
      const compiled = compilePageDimensionQualificationProgram({
        deferred: legacy.deferred,
        query: qualifiedQuery(query, legacy.normalized),
      });
      expect(compiled.kind).toBe("compiled");
      if (compiled.kind !== "compiled")
        throw new Error("wave95m_referrer_compile_unavailable");
      const runtimeTrace = traceFor();
      const diagnostics = createD1ReadDiagnostics();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
        diagnostics,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95m_referrer_provider_missing");
      const actual = await provider.execute(query);
      expect(actual.value).toEqual(legacy.dto);
      expect(runtimeTrace.preparedSql).toHaveLength(2);
      expect(runtimeTrace.preparedSql[1]).toBe(compiled.evidence.sql);
      expect(runtimeTrace.bindings[1]).toEqual(compiled.evidence.bindings);
      expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
      const dto = actual.value as ReferrerDto;
      expect(dto.data.items).not.toContainEqual(
        expect.objectContaining({ key: expect.anything() }),
      );
      expect(dto.data.items).not.toContainEqual(
        expect.objectContaining({ value: expect.anything() }),
      );
      for (const item of dto.data.items)
        expect(Object.keys(item).sort()).toEqual(
          ["label", "views", "sessions", "visitors"].sort(),
        );
      if (tab === "source.domain") {
        expect(dto.data.items.map((row) => row.label)).toContain("");
        expect(dto.data.items.map((row) => row.label)).toContain(
          " Host.Example ",
        );
        expect(dto.data.items.map((row) => row.label)).toContain(
          "Host.Example",
        );
        expect(dto.data.items.map((row) => row.label)).not.toContain(
          "no-match.example",
        );
      } else
        expect(dto.data.items.map((row) => row.label)).toContain(
          " https://Host.Example/space ",
        );
      const rawColumns = database
        .prepare(
          "SELECT referrer_host, referrer_url FROM visits WHERE visit_id = ?",
        )
        .get("visit-raw-space") as {
        readonly referrer_host: string;
        readonly referrer_url: string;
      };
      expect(rawColumns.referrer_host).toBe(" Host.Example ");
      expect(rawColumns.referrer_url).toBe(" https://Host.Example/space ");
      const logicalGraph = JSON.stringify(qualification.plan, null, 2);
      const physicalShape = JSON.stringify({
        sql: compiled.evidence.sql,
        bindings: compiled.evidence.bindings,
      });
      recordEvidence("default-referrer-overview", {
        tab,
        scope,
        rawReferrerHost: rawColumns.referrer_host,
        rawReferrerUrl: rawColumns.referrer_url,
        directTrafficEmptyKeyPreserved:
          tab === "source.domain"
            ? dto.data.items.some((row) => row.label === "")
            : true,
        exactOutputKeys: ["label", "views", "sessions", "visitors"],
        actualDto: actual.value,
        legacyDto: legacy.dto,
        statementCount: runtimeTrace.preparedSql.length,
        statementTag: compiled.evidence.statementTag,
        sqlBytes: compiled.evidence.sqlBytes,
        bindingCount: compiled.evidence.bindingCount,
        sqlSha256: createHash("sha256")
          .update(compiled.evidence.sql, "utf8")
          .digest("hex"),
        physicalSha256: createHash("sha256")
          .update(physicalShape, "utf8")
          .digest("hex"),
        logicalGraphSha256: createHash("sha256")
          .update(logicalGraph, "utf8")
          .digest("hex"),
        admission: {
          primaryReportSourceRelationId:
            qualification.primaryReportSourceRelationId,
          reportSourceRelations: qualification.reportSourceRelations,
          matchesRelationId: qualification.matchesRelationId,
          controlsRelationId: qualification.controlsRelationId,
          groupedSummaryRelationId: qualification.groupedSummaryRelationId,
          controlOutputId: qualification.controlOutputId,
          reportOutputIds: qualification.reportOutputIds,
          scope: qualification.scope,
        },
        compileEvidence: compiled.evidence,
        legacyStatements: oldTrace.preparedSql.map((sql, index) => ({
          sqlSha256: createHash("sha256").update(sql, "utf8").digest("hex"),
          bindingCount: oldTrace.bindings[index]?.length ?? 0,
        })),
      });
    },
  );

  it.each(cursorCases)(
    "walks old Referrer cursor/HMAC chain to null for $tab/$scope/$sort/$direction",
    async ({ tab, scope, sort, direction }) => {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnv(database, trace),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95m_cursor_provider_missing");
      const actualPages: ReferrerDto[] = [];
      const pageEvidence: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      let finished = false;
      for (let pageNumber = 0; pageNumber < 12; pageNumber += 1) {
        const query = queryFor(scope, {
          tab,
          limit: 1,
          cursor,
          sort,
          direction,
        });
        const legacy = await legacyReferrerFor(database, query, traceFor());
        expect(legacy.deferred).toBeDefined();
        const statementOffset = trace.preparedSql.length;
        const actual = (await provider.execute(query)).value as ReferrerDto;
        expect(actual).toEqual(legacy.dto);
        expect(trace.preparedSql.length - statementOffset).toBe(2);
        expect(actual.data.pagination.limit).toBe(1);
        expect(actual.data.pagination.returned).toBe(actual.data.items.length);
        expect(actual.data.pagination.hasMore).toBe(
          actual.data.pagination.nextCursor !== null,
        );
        expect(actual.data.pagination.nextCursor).toBe(
          legacy.dto.data.pagination.nextCursor,
        );
        actualPages.push(actual);
        pageEvidence.push({
          pageNumber,
          inputCursor: cursor,
          actualDto: actual,
          legacyDto: legacy.dto,
          runtimeStatementCount: trace.preparedSql.length - statementOffset,
          runtimeSqlSha256: trace.preparedSql
            .slice(statementOffset)
            .map((sql) =>
              createHash("sha256").update(sql, "utf8").digest("hex"),
            ),
        });
        const nextCursor = legacy.dto.data.pagination.nextCursor;
        if (nextCursor === null) {
          expect(actual.data.pagination.hasMore).toBe(false);
          finished = true;
          break;
        }
        expect(pageNumber + 1).toBeLessThan(12);
        cursor = nextCursor;
      }
      expect(finished).toBe(true);
      const fullQuery = queryFor(scope, { tab, limit: 100, sort, direction });
      const fullLegacy = await legacyReferrerFor(
        database,
        fullQuery,
        traceFor(),
      );
      const actualItems = actualPages.flatMap((page) => page.data.items);
      const actualLabels = actualItems.map((row) => row.label);
      const expectedLabels = fullLegacy.dto.data.items.map((row) => row.label);
      expect(actualLabels).toEqual(expectedLabels);
      expect(new Set(actualLabels).size).toBe(actualLabels.length);
      expect(actualLabels.length).toBeGreaterThan(1);
      recordEvidence("referrer-cursor-chain", {
        tab,
        scope,
        sort,
        direction,
        pages: pageEvidence,
        actualLabels,
        expectedLabels,
        noDuplicates: true,
        completedAtNullCursor: true,
      });
    },
  );

  it("preserves raw values, empty-key tie cursor, sessions alias and search behavior", async () => {
    const { database } = createFixture();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95m_semantics_provider_missing");

    const directFirst = queryFor("session", {
      tab: "source.domain",
      limit: 1,
      sort: "views",
      direction: "desc",
    });
    const directPage = (await provider.execute(directFirst))
      .value as ReferrerDto;
    expect(directPage.data.items[0]?.label).toBe("");
    expect(directPage.data.pagination.nextCursor).not.toBeNull();
    const directLegacy = await legacyReferrerFor(
      database,
      directFirst,
      traceFor(),
    );
    expect(directPage).toEqual(directLegacy.dto);

    const viewsQuery = queryFor("visitor", {
      tab: "source.domain",
      limit: 2,
      sort: "views",
      direction: "desc",
    });
    const sessionsQuery = queryFor("visitor", {
      tab: "source.domain",
      limit: 2,
      sort: "sessions",
      direction: "desc",
    });
    const viewsPage = (await provider.execute(viewsQuery)).value as ReferrerDto;
    const sessionsPage = (await provider.execute(sessionsQuery))
      .value as ReferrerDto;
    expect(sessionsPage).toEqual(viewsPage);

    for (const search of ["  HOST.EXAMPLE  ", " ", "not-present-referrer"]) {
      const query = queryFor("visitor", {
        tab: "source.domain",
        limit: 100,
        search,
      });
      const actual = (await provider.execute(query)).value as ReferrerDto;
      const legacy = await legacyReferrerFor(database, query, traceFor());
      expect(actual).toEqual(legacy.dto);
      if (search === "not-present-referrer")
        expect(actual.data.items).toHaveLength(0);
    }
    recordEvidence("referrer-order-search-and-direct-cursor", {
      directEmptyKeyFirstOnTie: directPage.data.items[0]?.label === "",
      emptyKeyHasNonfinalCursor: directPage.data.pagination.nextCursor !== null,
      sessionsSortMatchesViews:
        sessionsPage === viewsPage ||
        JSON.stringify(sessionsPage) === JSON.stringify(viewsPage),
      searchCases: ["  HOST.EXAMPLE  ", " ", "not-present-referrer"],
    });
  });

  it("invalidates cursor tokens when tab, sort, search or audience changes", async () => {
    const { database } = createFixture();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95m_binding_provider_missing");
    const initial = (
      await provider.execute(
        queryFor("visitor", { tab: "source.domain", limit: 1 }),
      )
    ).value as ReferrerDto;
    const cursor = initial.data.pagination.nextCursor;
    if (!cursor) throw new Error("wave95m_binding_cursor_missing");
    const cases = [
      queryFor("visitor", { tab: "source.link", limit: 1, cursor }),
      queryFor("visitor", {
        tab: "source.domain",
        limit: 1,
        cursor,
        sort: "visitors",
      }),
      queryFor("visitor", {
        tab: "source.domain",
        limit: 1,
        cursor,
        search: "host",
      }),
      queryFor("visitor", {
        tab: "source.domain",
        limit: 1,
        cursor,
        audience: "api-v1",
      }),
    ];
    for (const query of cases)
      await expect(provider.execute(query)).rejects.toBeInstanceOf(
        InvalidCursorError,
      );
    const invalidTrace = traceFor();
    const invalidProvider = createD1SiteProviderRegistry({
      env: testEnv(database, invalidTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!invalidProvider)
      throw new Error("wave95m_invalid_cursor_provider_missing");
    await expect(
      invalidProvider.execute(
        queryFor("visitor", {
          tab: "source.domain",
          limit: 1,
          cursor: "malformed-cursor",
        }),
      ),
    ).rejects.toMatchObject({ cursorKind: "overview-tab" });
    expect(invalidTrace.preparedSql).toHaveLength(2);
    recordEvidence("referrer-cursor-binding-rejections", {
      rejectedBindings: ["tab/includeFullUrl", "sort", "search", "audience"],
      allRejected: true,
      malformedCursorKind: "overview-tab",
      malformedCursorPreflightStatements: invalidTrace.preparedSql.length,
    });
  });

  it("Private Referrer overview whole Boolean qualification keeps neighboring routes on the old path", async () => {
    const { database } = createFixture();

    const channelFilters = parseFilterDsl(
      'page.path neq "/excluded"',
      analyticsFilterRegistry,
    );
    const channelQuery = {
      ...prepareScopedQuery("channels", {
        context: siteQueryContext(SITE, "private-dashboard"),
        time: TIME,
        filters: channelFilters,
        scopePreference: "session",
      } as QueryInput & { readonly time: typeof TIME }),
      mode: "overview-tab",
      tab: "source.channel",
    } as ReferrerOverviewQuery;
    const channelTrace = traceFor();
    const channelProvider = createD1SiteProviderRegistry({
      env: testEnv(database, channelTrace),
      siteId: SITE,
    }).resolve("channels");
    if (!channelProvider) throw new Error("wave95m_channels_provider_missing");
    const channelActual = await channelProvider.execute(channelQuery as never);
    const channelPage = await queryDimensionPageFromD1(
      testEnv(database, traceFor()),
      SITE,
      WINDOW,
      channelFilters,
      100,
      PAGE_DIMENSION_SELECTIONS.trafficChannel,
      { excludeEmpty: true, sortBy: "views", sortDirection: "desc" },
      null,
      undefined,
      "private-dashboard",
    );
    expect(channelActual.value).toEqual({
      data: {
        items: mapTabs([...channelPage.items]),
        pagination: channelPage.pagination,
      },
    });
    expect(channelTrace.preparedSql).toHaveLength(1);

    const dimensionProvider = createD1SiteProviderRegistry({
      env: testEnv(database, traceFor()),
      siteId: SITE,
    }).resolve("dimension");
    if (!dimensionProvider) throw new Error("wave95m_legacy_provider_missing");
    const oldRouteCases = [
      {
        ...queryFor("session", {
          tab: "source.domain",
          filterDsl: 'page.path neq "/excluded"',
        }),
        comparison: { metric: "views" },
      } as ReferrerOverviewQuery,
      {
        ...queryFor("session", {
          tab: "source.domain",
          filterDsl: 'page.path neq "/excluded"',
        }),
        current: { time: TIME },
        reference: { time: TIME },
      } as ReferrerOverviewQuery,
      queryFor("session", {
        tab: "source.domain",
        audience: "public-share",
        filterDsl: 'page.path neq "/excluded"',
      }),
    ];
    const rows: Array<Record<string, unknown>> = [];
    for (const query of oldRouteCases) {
      const oldTrace = traceFor();
      const legacy = await legacyReferrerFor(database, query, oldTrace);
      expect(legacy.deferred).toBeUndefined();
      const runtimeTrace = traceFor();
      const actualProvider = createD1SiteProviderRegistry({
        env: testEnv(database, runtimeTrace),
        siteId: SITE,
      }).resolve("dimension");
      if (!actualProvider)
        throw new Error("wave95m_legacy_route_provider_missing");
      const actual = await actualProvider.execute(query);
      expect(actual.value).toEqual(legacy.dto);
      expect(runtimeTrace.preparedSql).toEqual(oldTrace.preparedSql);
      rows.push({
        tab: query.tab,
        audience: query.context.policy.audience,
        actualDto: actual.value,
        legacyDto: legacy.dto,
        statementCount: runtimeTrace.preparedSql.length,
      });
    }

    const unknownTab = queryFor("session", {
      tab: "source.unknown",
      filterDsl: 'page.path neq "/excluded"',
    });
    const unknownOldTrace = traceFor();
    const unknownForwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, unknownOldTrace),
      undefined,
      SITE,
    )("dimension", unknownTab, async (prepared) => prepared);
    expect(
      deferredReferrerOverviewQualificationFromQuery(unknownForwarded),
    ).toBeUndefined();
    const unknownFilters =
      (unknownForwarded as ReferrerOverviewQuery).filters ??
      unknownTab.filters!;
    const unknownLegacy = referrerDto(
      await queryReferrersPageFromD1(
        testEnv(database, unknownOldTrace),
        SITE,
        WINDOW,
        unknownFilters,
        100,
        false,
        undefined,
        null,
        undefined,
        "private-dashboard",
        "views",
        "desc",
      ),
    );
    const unknownRuntimeTrace = traceFor();
    const unknownProvider = createD1SiteProviderRegistry({
      env: testEnv(database, unknownRuntimeTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!unknownProvider)
      throw new Error("wave95m_unknown_tab_provider_missing");
    const unknownActual = await unknownProvider.execute(unknownTab);
    expect(unknownActual.value).toEqual(unknownLegacy);
    expect(unknownRuntimeTrace.preparedSql).toHaveLength(1);
    rows.push({
      tab: unknownTab.tab,
      actualDto: unknownActual.value,
      legacyDto: unknownLegacy,
      statementCount: unknownRuntimeTrace.preparedSql.length,
    });

    const invalidLimit = queryFor("session", {
      tab: "source.domain",
      limit: 1.5,
    });
    const invalidForwarded = await d1AdvancedFilterMiddleware(
      testEnv(database, traceFor()),
      undefined,
      SITE,
    )("dimension", invalidLimit, async (prepared) => prepared);
    expect(
      deferredReferrerOverviewQualificationFromQuery(invalidForwarded),
    ).toBeUndefined();
    recordEvidence("referrer-old-route-neighbors", {
      sourceChannelOperation: "channels",
      sourceChannelStatementCount: channelTrace.preparedSql.length,
      actualOldRouteDtos: rows,
      invalidFractionalLimitNotDeferred: true,
    });
  });

  it("Private Referrer overview whole Boolean qualification keeps unsupported audiences and request gates closed", async () => {
    const { database } = createFixture();
    const env = testEnv(database, traceFor());
    const middleware = d1AdvancedFilterMiddleware(env, undefined, SITE);
    const forward = async (
      query: ReferrerOverviewQuery,
      operation: "dimension" | "channels" = "dimension",
    ) => middleware(operation, query, async (prepared) => prepared);
    const eligible = queryFor("session", { tab: "source.domain" });
    const eligibleForwarded = await forward(eligible);
    const eligibleDeferred =
      deferredReferrerOverviewQualificationFromQuery(eligibleForwarded);
    expect(eligibleDeferred?.referrerOverviewRequest.tab).toBe("source.domain");
    const normalized = normalizedRequest(eligible);
    if (!eligibleDeferred || !normalized)
      throw new Error("wave95m_context_gate_setup_invalid");
    const tampered = [
      { ...qualifiedQuery(eligible, normalized), tab: "source.link" as const },
      { ...qualifiedQuery(eligible, normalized), includeFullUrl: true },
      { ...qualifiedQuery(eligible, normalized), limit: 5 },
      { ...qualifiedQuery(eligible, normalized), sortBy: "visitors" as const },
      { ...qualifiedQuery(eligible, normalized), siteId: "other-site" },
      {
        ...qualifiedQuery(eligible, normalized),
        queryTime: { ...TIME, capturedAtMs: TIME.capturedAtMs + 1 },
      },
      {
        ...qualifiedQuery(eligible, normalized),
        scopePlan: { ...eligible.scopePlan!, scope: "visitor" as const },
      },
    ];
    const mismatchCodes = new Set<string>();
    for (const query of tampered) {
      try {
        compilePageDimensionQualificationProgram({
          deferred: eligibleDeferred,
          query: query as never,
        });
      } catch (error) {
        const code = (
          error as { domainError?: { issues?: { code?: string }[] } }
        ).domainError?.issues?.[0]?.code;
        if (code) mismatchCodes.add(code);
      }
    }
    expect(mismatchCodes).toContain("page_dimension_request_context_mismatch");

    const excluded = [
      queryFor("session", { tab: "source.channel" }),
      queryFor("session", { tab: "source.unknown" }),
      queryFor("session", { tab: "page.entry" }),
      queryFor("session", { tab: "source.domain", limit: 1.5 }),
      {
        ...eligible,
        comparison: { metric: "views" },
      } as ReferrerOverviewQuery,
      {
        ...eligible,
        current: { time: TIME },
        reference: { time: TIME },
      } as ReferrerOverviewQuery,
    ];
    for (const query of excluded) {
      const forwarded = await forward(query);
      expect(
        deferredReferrerOverviewQualificationFromQuery(forwarded),
        JSON.stringify({
          tab: query.tab,
          limit: query.limit,
          hasComparison: "comparison" in query,
          hasCurrent: "current" in query,
          hasReference: "reference" in query,
        }),
      ).toBeUndefined();
    }
    const publicNativeOnly = queryFor("session", {
      tab: "source.domain",
      audience: "public-share",
      filterDsl: 'page.path neq "/excluded"',
    });
    expect(
      deferredReferrerOverviewQualificationFromQuery(
        await forward(publicNativeOnly),
      ),
    ).toBeUndefined();

    const wholeBooleanFilters = [
      'page.path eq "/no-match" or count(event { event.name eq "qualifier" }) eq 2',
      'not (page.path eq "/excluded" and count(event { event.name eq "qualifier" }) eq 1)',
    ] as const;
    const audienceResults: Array<Record<string, unknown>> = [];
    for (const audience of ["public-share", "api-v1"] as const) {
      const conjunctive = queryFor("session", {
        tab: "source.domain",
        audience,
        filterDsl: BASE_FILTER,
      });
      const conjunctiveDeferred =
        deferredReferrerOverviewQualificationFromQuery(
          await forward(conjunctive),
        );
      expect(conjunctiveDeferred?.referrerOverviewRequest.audience).toBe(
        audience,
      );
      for (const filterDsl of wholeBooleanFilters) {
        const query = queryFor("session", {
          tab: "source.domain",
          audience,
          filterDsl,
        });
        const forwarded = await forward(query);
        const deferred =
          deferredReferrerOverviewQualificationFromQuery(forwarded);
        expect(deferred).toBeUndefined();
        audienceResults.push({
          audience,
          filterDsl,
          deferred: deferred !== undefined,
        });
      }
    }
    recordEvidence("private-referrer-overview-audience-gate", {
      preservedConjunctiveAudiences: ["public-share", "api-v1"],
      rejectedWholeBoolean: audienceResults,
    });
    await expect(
      d1AdvancedFilterMiddleware(env, undefined, "another-site")(
        "dimension",
        eligible,
        async (prepared) => prepared,
      ),
    ).rejects.toMatchObject({
      domainError: {
        issues: [
          { path: "siteId", code: "page_dimension_request_context_mismatch" },
        ],
      },
    });
    await expect(
      forward({
        ...eligible,
        time: createQueryTime(120, 140, "UTC", 501),
      }),
    ).rejects.toMatchObject({
      domainError: {
        issues: [
          { path: "time", code: "page_dimension_request_context_mismatch" },
        ],
      },
    });

    const abortedTrace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, abortedTrace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95m_aborted_provider_missing");
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.execute(eligible, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(abortedTrace.preparedSql).toHaveLength(0);

    const sourceChannel = prepareScopedQuery("channels", {
      context: siteQueryContext(SITE, "private-dashboard"),
      time: TIME,
      filters: eligible.filters!,
      scopePreference: "session",
    } as QueryInput & { readonly time: typeof TIME });
    const channelsForwarded = await forward(
      {
        ...sourceChannel,
        mode: "overview-tab",
        tab: "source.channel",
      } as ReferrerOverviewQuery,
      "channels",
    );
    expect(
      deferredReferrerOverviewQualificationFromQuery(channelsForwarded),
    ).toBeUndefined();
    recordEvidence("referrer-qualification-gates", {
      eligibleTabs: ["source.domain", "source.link"],
      excluded: [
        "channels operation source.channel",
        "unknown source tab",
        "entry/exit",
        "fractional limit",
        "mixed OR",
        "mixed NOT",
        "comparison",
        "current/reference",
        "public native-only",
      ],
      requestMismatchCodes: [...mismatchCodes],
      siteMismatchRejected: true,
      requestTimeMismatchRejected: true,
      preabortReads: abortedTrace.preparedSql.length,
      channelOperationNotDeferred: true,
    });
  });

  it("uses one legacy fallback for numeric compatibility and returns the old DTO", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run(10, "visit-host-a1");
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-host-a2");
    const query = queryFor("session", {
      tab: "source.domain",
      filterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) eq 1`,
    });
    const oldTrace = traceFor();
    const legacy = await legacyReferrerFor(database, query, oldTrace);
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95m_numeric_provider_missing");
    const actual = await provider.execute(query);
    expect(actual.value).toEqual(legacy.dto);
    recordEvidence("referrer-numeric-fallback", {
      completeDtoMatches: true,
      runtimeStatementCount: trace.preparedSql.length,
      legacyStatementCount: oldTrace.preparedSql.length,
      runtimeSql: trace.preparedSql,
      legacySql: oldTrace.preparedSql,
      runtimeBindings: trace.bindings,
      legacyBindings: oldTrace.bindings,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason ?? null,
    });
    expect(trace.preparedSql.length).toBe(oldTrace.preparedSql.length + 1);
    expect(trace.preparedSql.slice(2)).toEqual(oldTrace.preparedSql.slice(1));
  });

  it("binds the Event Page Source after numeric refusal for Referrer overview", async () => {
    const { database } = createFixture();
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "visit-host-a2");
    const query = queryFor("event", {
      tab: "source.domain",
      filterDsl: `${BASE_FILTER} and count(page { page.durationMs gt 5 }) eq 1`,
    });
    const legacyTrace = traceFor();
    const legacy = await legacyReferrerFor(database, query, legacyTrace);
    expect(legacy.deferred?.countInput.scope).toBe("event");
    expect(
      legacy.deferred?.countInput.numericCompatibilityRequirements,
    ).not.toHaveLength(0);
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: SITE,
      diagnostics,
    }).resolve("dimension");
    if (!provider)
      throw new Error("wave95m_event_numeric_referrer_provider_missing");
    const actual = await provider.execute(query);

    expect(actual.value).toEqual(legacy.dto);
    expect((actual.value as ReferrerDto).data.items).not.toHaveLength(0);
    const guardStatementIndex = trace.preparedSql.findIndex((sql) =>
      sql.includes("invalidContextPageDurationMsCount"),
    );
    expect(guardStatementIndex).toBeGreaterThanOrEqual(0);
    const guardRows = database
      .prepare(trace.preparedSql[guardStatementIndex]!)
      .all(...(trace.bindings[guardStatementIndex] ?? [])) as Array<
      Record<string, unknown>
    >;
    expect(guardRows).toHaveLength(1);
    expect(guardRows[0]).toMatchObject({
      rowKind: "control",
      invalidContextPageDurationMsCount: 1,
    });
    expect(guardRows.some((row) => row.rowKind === "report")).toBe(false);
    const reportSql = trace.preparedSql.at(-1);
    expect(reportSql).toMatch(/\bvisit_id\b/i);
    expect(reportSql).not.toMatch(/\bentity_id\b/i);
  });

  it("rejects a canonical plan whose qualified Page Source differs from its preparation", async () => {
    const { database } = createFixture();
    const trace = traceFor();
    const env = testEnv(database, trace);
    const query = queryFor("event", { limit: 1 });
    const forwarded = await d1AdvancedFilterMiddleware(env, undefined, SITE)(
      "dimension",
      query,
      async (value) => value,
    );
    const deferred = deferredReferrerOverviewQualificationFromQuery(forwarded);
    if (!deferred?.requestTime)
      throw new Error("wave95m_page_visit_binding_deferred_missing");
    const consumerKey = pageVisitQualificationConsumerKey(
      "source-binding-regression",
      { limit: 1 },
    );
    const preparation = await prepareDeferredPageVisitQualification(
      deferred,
      consumerKey,
    );
    if (!preparation)
      throw new Error("wave95m_page_visit_binding_preparation_missing");

    const planFor = (
      siteId: string,
      queryTime: QueryTime,
      filterDsl = BASE_FILTER,
    ) => {
      const prepared = prepareScopedQuery("dimension", {
        context: siteQueryContext(siteId, "private-dashboard"),
        time: queryTime,
        filters: parseFilterDsl(filterDsl, analyticsFilterRegistry),
        scopePreference: "event",
      } as QueryInput & { readonly time: QueryTime });
      if (!prepared.filters || !prepared.scopePlan)
        throw new Error("wave95m_page_visit_binding_plan_setup_invalid");
      return snapshotPageVisitQualificationPlan(
        buildReferrersPagePlan({
          siteId,
          queryTime: prepared.time as QueryTime,
          filters: prepared.filters,
          scopePlan: prepared.scopePlan,
          qualificationDependencyRefs: [EVENT_FILTER_PAGE_VISIT_DEPENDENCY],
          limit: 1,
          includeFullUrl: false,
          sortBy: "views",
          sortDirection: "desc",
        }),
      );
    };
    const expectedInput = {
      preparation,
      siteId: SITE,
      filters: deferred.filters,
      queryTime: deferred.requestTime,
      scopePlan: deferred.metadata.plan,
      consumerKey,
    };
    const wrongFilterPlan = planFor(
      SITE,
      deferred.requestTime,
      `${BASE_FILTER} and page.path neq "/other"`,
    );
    const basePlan = planFor(SITE, deferred.requestTime);
    const wrongRolePlan = snapshotLogicalPlan({
      ...basePlan,
      nodes: basePlan.nodes.map((node) =>
        node.kind === "source" &&
        node.selection?.qualificationDependencyRefs?.length
          ? { ...node, entity: "event" as const }
          : node,
      ),
    }) as ValidatedLogicalPlan;
    const wrongSitePlan = planFor(`${SITE}-other`, deferred.requestTime);
    const wrongTimePlan = planFor(
      SITE,
      createQueryTime(121, 141, "UTC", TIME.capturedAtMs),
    );
    const statementsBefore = trace.preparedSql.length;

    for (const plan of [
      wrongFilterPlan,
      wrongRolePlan,
      wrongSitePlan,
      wrongTimePlan,
    ]) {
      expect(() =>
        bindPageVisitQualificationPreparation({ ...expectedInput, plan }),
      ).toThrow("qualification_execution_plan_context_mismatch");
    }
    expect(trace.preparedSql).toHaveLength(statementsBefore);
  });

  it("preserves Count cap precedence over malformed cursors and numeric data", async () => {
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
        ) SELECT 'wave95m-cap-' || n, ?, ?, 'wave95m-cap-visitor',
          'wave95m-cap-session', 'closed', ?, ?, '/bulk', 'site.test',
          'bulk.example', 'https://bulk.example/', 10 FROM generated`,
      )
      .run(bulkCount, site.id, site.pk, 125, 125);
    database
      .prepare("UPDATE visits SET duration_ms = ? WHERE visit_id = ?")
      .run("invalid-duration", "wave95m-cap-1");
    const trace = traceFor();
    const diagnostics = createD1ReadDiagnostics();
    const provider = createD1SiteProviderRegistry({
      env: testEnv(database, trace),
      siteId: site.id,
      diagnostics,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95m_cap_provider_missing");
    const query = queryFor("session", {
      tab: "source.domain",
      cursor: "malformed-cursor",
      filterDsl:
        'page.path eq "/bulk" and count(page { page.durationMs gt 5 }) eq 1',
    });
    await expect(provider.execute(query)).rejects.toMatchObject({
      domainError: {
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(trace.preparedSql).toHaveLength(2);
    const rows = database
      .prepare(trace.preparedSql[1]!)
      .all(...(trace.bindings[1] ?? [])) as Record<string, unknown>[];
    const controls = rows.filter((row) => row.rowKind === "control");
    expect(controls).toHaveLength(1);
    expect(Number(controls[0]!.rawCount)).toBe(bulkCount);
    expect(rows.filter((row) => row.rowKind === "report")).toHaveLength(0);
    expect(diagnostics.advancedCountSqlFallbackReason).toBeUndefined();
    recordEvidence("referrer-cap-before-cursor", {
      activityLimit: ADVANCED_FILTER_MAX_ACTIVITIES,
      rawCount: Number(controls[0]!.rawCount),
      reportRows: 0,
      errorCode: "filter_activity_limit_exceeded",
      statementCount: trace.preparedSql.length,
      numericCorruptionPresent: true,
      fallbackReason: diagnostics.advancedCountSqlFallbackReason,
    });
  });

  it("propagates malformed controls, output schema and SQLite failures", async () => {
    const cases = [
      [
        "missing-control",
        "analytics_event_summary_qualification_control_row_invalid",
      ],
      [
        "duplicate-control",
        "analytics_event_summary_qualification_control_row_invalid",
      ],
      [
        "wrong-control-scope",
        "analytics_event_summary_qualification_control_kind_mismatch",
      ],
      [
        "invalid-report-schema",
        "analytics_event_summary_qualification_report_row_invalid",
      ],
    ] as const;
    for (const [behavior, error] of cases) {
      const { database } = createFixture();
      const trace = traceFor();
      const provider = createD1SiteProviderRegistry({
        env: testEnvWithControlBehavior(database, trace, behavior),
        siteId: SITE,
      }).resolve("dimension");
      if (!provider) throw new Error("wave95m_malformed_provider_missing");
      await expect(
        provider.execute(queryFor("session", { tab: "source.domain" })),
      ).rejects.toThrow(error);
      expect(trace.preparedSql).toHaveLength(2);
      recordEvidence("referrer-malformed-envelope", {
        behavior,
        error,
        statementCount: trace.preparedSql.length,
        fallbackRan: false,
      });
    }
    const { database } = createFixture();
    const trace = traceFor();
    const provider = createD1SiteProviderRegistry({
      env: testEnvWithSqliteFailure(database, trace),
      siteId: SITE,
    }).resolve("dimension");
    if (!provider) throw new Error("wave95m_sqlite_provider_missing");
    await expect(
      provider.execute(queryFor("session", { tab: "source.domain" })),
    ).rejects.toThrow("wave95m_sqlite_report_failure");
    expect(trace.preparedSql).toHaveLength(2);
    recordEvidence("referrer-sqlite-error", {
      statementCount: trace.preparedSql.length,
      fallbackRan: false,
    });
  });
});
