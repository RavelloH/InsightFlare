import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1TeamQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { prepareScopedQuery } from "@/lib/edge/analytics/contract/scoped-filter";
import { planTeamExactDimensionExecution } from "@/lib/edge/analytics/engine/team-exact-dimension-plan";
import {
  d1AdvancedFilterMiddleware,
  prepareSiteExactDimensionInputs,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { hasWholeOriginalCompletion } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import { readTeamBreakdown } from "@/lib/edge/analytics/providers/d1/operations/team-breakdown";
import { readTeamOverview } from "@/lib/edge/analytics/providers/d1/operations/team-overview";
import { readTeamTimeseries } from "@/lib/edge/analytics/providers/d1/operations/team-timeseries";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";

const TEAM = "b04-team";
const SITE_A = "b04-site-a";
const SITE_B = "b04-site-b";
// Same team name, but not authorized for this request.
const SITE_C = "b04-site-c";
const TIME = createQueryTime(100, 200, "UTC", 300);
const QUALIFIER =
  'count(event { event.name eq "qualifier" }) gte 1 and page.path neq "/excluded"';
const databases = new Set<DatabaseSync>();

afterAll(() => {
  for (const database of databases) database.close();
});

interface SeedVisit {
  readonly id: string;
  readonly sessionId: string;
  readonly visitorId: string;
  readonly path: string;
  readonly at: number;
  readonly event: boolean;
}

function seedSite(
  database: DatabaseSync,
  siteId: string,
  eventNameId: number,
  visits: readonly SeedVisit[],
): void {
  database
    .prepare("INSERT INTO site_identities (site_id) VALUES (?)")
    .run(siteId);
  const sitePk = Number(
    (
      database
        .prepare("SELECT site_pk FROM site_identities WHERE site_id = ?")
        .get(siteId) as { readonly site_pk: number }
    ).site_pk,
  );
  database
    .prepare(
      `INSERT INTO sites (id, team_id, name, domain, created_at)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .run(siteId, TEAM, siteId, `${siteId}.test`);
  database
    .prepare(
      `INSERT INTO custom_event_names (id, site_id, name, last_seen_at, site_pk)
       VALUES (?, ?, 'qualifier', 150, ?)`,
    )
    .run(eventNameId, siteId, sitePk);
  for (const visit of visits) {
    database
      .prepare(
        `INSERT INTO visits (
           visit_id, site_id, site_pk, visitor_id, session_id, status,
           started_at, last_activity_at, pathname, hostname, duration_ms
         ) VALUES (?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, 10)`,
      )
      .run(
        `${siteId}:${visit.id}`,
        siteId,
        sitePk,
        visit.visitorId,
        visit.sessionId,
        visit.at,
        visit.at,
        visit.path,
        `${siteId}.test`,
      );
    if (visit.event)
      database
        .prepare(
          `INSERT INTO custom_events (
             event_id, site_id, site_pk, visit_id, event_name_id, occurred_at,
             received_at, sequence, node_count, value_count
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, 0)`,
        )
        .run(
          `event-${siteId}:${visit.id}`,
          siteId,
          sitePk,
          `${siteId}:${visit.id}`,
          eventNameId,
          visit.at,
          visit.at,
        );
  }
}

/**
 * Every site reuses the same session and visitor ids. Site A qualifies s1,
 * site B qualifies s2 and site C qualifies both, so a membership that crossed
 * sites would change the totals.
 */
function createFixture(): DatabaseSync {
  const database = createMigratedDatabase();
  databases.add(database);
  database.exec("PRAGMA foreign_keys = OFF");
  seedSite(database, SITE_A, 1, [
    {
      id: "a1",
      sessionId: "s1",
      visitorId: "v1",
      path: "/q",
      at: 110,
      event: true,
    },
    {
      id: "a2",
      sessionId: "s1",
      visitorId: "v1",
      path: "/p",
      at: 111,
      event: false,
    },
    {
      id: "a3",
      sessionId: "s2",
      visitorId: "v2",
      path: "/p",
      at: 112,
      event: false,
    },
  ]);
  seedSite(database, SITE_B, 2, [
    {
      id: "b1",
      sessionId: "s1",
      visitorId: "v1",
      path: "/p",
      at: 120,
      event: false,
    },
    {
      id: "b2",
      sessionId: "s2",
      visitorId: "v2",
      path: "/q",
      at: 121,
      event: true,
    },
    {
      id: "b3",
      sessionId: "s2",
      visitorId: "v2",
      path: "/p",
      at: 122,
      event: false,
    },
    {
      id: "b4",
      sessionId: "s2",
      visitorId: "v2",
      path: "/p",
      at: 123,
      event: false,
    },
  ]);
  seedSite(database, SITE_C, 3, [
    {
      id: "c1",
      sessionId: "s1",
      visitorId: "v1",
      path: "/q",
      at: 130,
      event: true,
    },
    {
      id: "c2",
      sessionId: "s2",
      visitorId: "v2",
      path: "/q",
      at: 131,
      event: true,
    },
  ]);
  return database;
}

function envFor(database: DatabaseSync, trace: SqliteD1Trace): Env {
  return {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "b04-team-secret",
  } as unknown as Env;
}

function traceFor(): SqliteD1Trace {
  return { preparedSql: [], bindings: [] };
}

function teamRequest(scope: "session" | "visitor", dsl = QUALIFIER) {
  return {
    context: teamQueryContext(TEAM, "private-dashboard", [SITE_A, SITE_B]),
    time: TIME,
    filters: parseFilterDsl(dsl, analyticsFilterRegistry),
    scopePreference: scope,
    teamId: TEAM,
    allowedSiteIds: [SITE_A, SITE_B],
  };
}

async function jointBreakdown(
  database: DatabaseSync,
  request: ReturnType<typeof teamRequest> & {
    dimension: string;
    mode: "breakdown";
    limit: number;
  },
) {
  const env = envFor(database, traceFor());
  const prepared = prepareScopedQuery("dimension", request);
  const joint = (await d1AdvancedFilterMiddleware(env)(
    "dimension",
    prepared,
    async (value) => value,
  )) as typeof prepared;
  return readTeamBreakdown({
    env,
    teamId: TEAM,
    allowedSiteIds: request.allowedSiteIds,
    dimension: request.dimension,
    limit: request.limit,
    window: {
      startMs: TIME.range.startMs,
      endExclusiveMs: TIME.range.endExclusiveMs,
      nowMs: TIME.capturedAtMs,
      timeZone: TIME.reportingTimeZone,
    },
    filters: joint.filters,
    ...(hasWholeOriginalCompletion(joint, "team-exact-dimension")
      ? { wholeOriginalOwner: joint }
      : {}),
  });
}

describe("team exact page dimensions", () => {
  it("rejects an unauthorized qualification target before any storage read", async () => {
    const prepare = vi.fn();
    const query = prepareScopedQuery("dimension", {
      ...teamRequest("session"),
      mode: "breakdown",
      dimension: "page.path",
    });
    await expect(
      prepareSiteExactDimensionInputs({
        env: { DB: { prepare } } as unknown as Env,
        query,
        siteIds: [SITE_C],
      }),
    ).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [
          {
            path: "filters",
            code: "advanced_filter_execution_site_context_mismatch",
          },
        ],
      },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each(["public-share", "api-v1"] as const)(
    "retains the previous route for %s",
    (audience) => {
      const query = prepareScopedQuery("dimension", {
        ...teamRequest("session"),
        context: teamQueryContext(TEAM, audience, [SITE_A, SITE_B]),
        mode: "breakdown",
        dimension: "page.path",
      });
      expect(planTeamExactDimensionExecution(query)).toEqual({
        kind: "legacy",
        reason: "audience",
      });
    },
  );

  it("does not accept a scoped plan copied from another authorized domain", () => {
    const query = prepareScopedQuery("dimension", {
      ...teamRequest("session"),
      mode: "breakdown",
      dimension: "page.path",
    });
    expect(
      planTeamExactDimensionExecution({
        ...query,
        context: teamQueryContext(TEAM, "private-dashboard", [SITE_A]),
      }),
    ).toEqual({ kind: "legacy", reason: "request-context-mismatch" });
  });
  it.each(["session", "visitor"] as const)(
    "preserves the full DTO and site-local %s membership",
    async (scope) => {
      const database = createFixture();
      const request = {
        ...teamRequest(scope),
        mode: "breakdown" as const,
        dimension: "page.path",
        limit: 0,
      };
      const expected = await jointBreakdown(database, request);
      expect(expected.items.map(({ key, views }) => ({ key, views }))).toEqual([
        { key: "/p", views: 3 },
        { key: "/q", views: 2 },
      ]);
      const trace = traceFor();
      const actual = await createD1TeamQueryRuntime({
        env: envFor(database, trace),
      }).execute("dimension", request);
      expect(actual.ok).toBe(true);
      if (actual.ok) expect(actual.data).toEqual(expected);
      for (const values of trace.bindings)
        expect(values.map(String)).not.toContain(SITE_C);
    },
  );

  it.each(["page.path exists", "count(page) gte 0"])(
    "merges all keys before the final limit with %s",
    async (dsl) => {
      const database = createMigratedDatabase();
      databases.add(database);
      database.exec("PRAGMA foreign_keys = OFF");
      for (const [site, paths] of [
        [SITE_A, ["/a", "/a", "/x", "/x", ""]],
        [SITE_B, ["/b", "/b", "/b", "/x", "/x", ""]],
      ] as const)
        seedSite(
          database,
          site,
          site === SITE_A ? 1 : 2,
          paths.map((path, index) => ({
            id: String(index),
            sessionId: `s${index}`,
            visitorId: `v${index}`,
            path,
            at: 110 + index,
            event: false,
          })),
        );
      const request = {
        ...teamRequest("session", dsl),
        mode: "breakdown" as const,
        dimension: "page.path",
        limit: 1,
      };
      const expected = await jointBreakdown(database, request);
      const actual = await createD1TeamQueryRuntime({
        env: envFor(database, traceFor()),
      }).execute("dimension", request);
      expect(actual.ok).toBe(true);
      if (actual.ok) expect(actual.data).toEqual(expected);
      expect(expected.items).toEqual([
        { key: "/x", label: "/x", views: 4, sessions: 4, visitors: 4 },
      ]);
    },
  );

  it.each([
    [QUALIFIER, "exact"],
    [`${QUALIFIER} and time gte @range.start+1ms`, "independent-time-domains"],
    ["first(page).path exists", "independent-time-domains"],
    [
      'sequence([event { event.name eq "qualifier" }, page]) exists',
      "independent-time-domains",
    ],
    ['count(event { event.payload("/amount") gte 1 }) gte 1', "payload"],
  ])("keeps %s on its proven route (%s)", async (dsl, reason) => {
    const database = createFixture();
    const request = {
      ...teamRequest("session", dsl),
      mode: "breakdown" as const,
      dimension: "page.path",
      limit: 0,
    };
    const decision = planTeamExactDimensionExecution(
      prepareScopedQuery("dimension", request),
    );
    expect(decision).toMatchObject(
      reason === "exact"
        ? { kind: "exact", qualification: "sql-membership" }
        : { kind: "legacy", reason },
    );
    const expected = await jointBreakdown(database, request);
    const actual = await createD1TeamQueryRuntime({
      env: envFor(database, traceFor()),
    }).execute("dimension", request);
    expect(actual.ok).toBe(true);
    if (actual.ok) expect(actual.data).toEqual(expected);
  });

  it("preserves the single request-wide activity cap across sites", async () => {
    const database = createFixture();
    for (const site of [SITE_A, SITE_B]) {
      database
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001)
        INSERT INTO visits (visit_id, site_id, site_pk, visitor_id, session_id, status, started_at, last_activity_at, pathname, hostname, duration_ms)
        SELECT ? || i, ?, (SELECT site_pk FROM site_identities WHERE site_id=?), 'cap-v', 'cap-s', 'closed', 150,150,'/cap','cap.test',0 FROM n`,
        )
        .run(`cap-${site}-`, site, site);
    }
    const request = {
      ...teamRequest("session", "count(page) gte 0"),
      mode: "breakdown" as const,
      dimension: "page.path",
      limit: 0,
    };
    await expect(jointBreakdown(database, request)).rejects.toMatchObject({
      domainError: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    const actual = await createD1TeamQueryRuntime({
      env: envFor(database, traceFor()),
    }).execute("dimension", request);
    expect(actual).toMatchObject({ ok: false });
    expect(JSON.stringify(actual)).toContain("filter_activity_limit_exceeded");
  });
});

/** The previous behaviour: one joint evaluation, then a packed membership. */
async function jointOverview(
  database: DatabaseSync,
  scope: "session" | "visitor",
  dsl?: string,
) {
  const trace = traceFor();
  const env = envFor(database, trace);
  const prepared = prepareScopedQuery(
    "overview",
    teamRequest(scope, dsl) as never,
  );
  const joint = await d1AdvancedFilterMiddleware(env)(
    "overview",
    prepared,
    async (value) => value,
  );
  const request = joint as ReturnType<typeof teamRequest>;
  return readTeamOverview({
    env,
    teamId: TEAM,
    allowedSiteIds: [SITE_A, SITE_B],
    window: {
      startMs: TIME.range.startMs,
      endExclusiveMs: TIME.range.endExclusiveMs,
      nowMs: TIME.capturedAtMs,
      timeZone: TIME.reportingTimeZone,
    },
    filters: request.filters,
  });
}

describe("team advanced filters qualify each site in its own pipeline", () => {
  it.each(["session", "visitor"] as const)(
    "keeps site-local %s identities apart and matches the joint evaluation for Overview",
    async (scope) => {
      const database = createFixture();
      const expected = await jointOverview(database, scope);
      // The reused ids must make the answer depend on site-local qualification:
      // A qualifies s1 (2 views), B qualifies s2 (3 views), C is not authorized.
      expect(expected.data).toMatchObject({ views: 5 });

      const trace = traceFor();
      const runtime = createD1TeamQueryRuntime({
        env: envFor(database, trace),
      });
      const actual = await runtime.execute(
        "overview",
        teamRequest(scope) as never,
      );
      expect(actual.ok).toBe(true);
      if (!actual.ok) return;
      expect(actual.data).toEqual({ current: expected.data });
      // No statement evaluates two sites at once and the unauthorized site is
      // never read.
      for (const [index, sql] of trace.preparedSql.entries()) {
        const bound = (trace.bindings[index] ?? []).map(String);
        expect(
          bound.includes(SITE_A) && bound.includes(SITE_B),
          sql.slice(0, 80),
        ).toBe(false);
        expect(bound).not.toContain(SITE_C);
      }
    },
  );

  it("matches the joint evaluation for Trend", async () => {
    const database = createFixture();
    const trace = traceFor();
    const env = envFor(database, trace);
    const prepared = prepareScopedQuery("trend", {
      ...teamRequest("session"),
      interval: "day",
    } as never);
    const joint = (await d1AdvancedFilterMiddleware(env)(
      "trend",
      prepared,
      async (value) => value,
    )) as ReturnType<typeof teamRequest>;
    const expected = await readTeamTimeseries({
      env,
      teamId: TEAM,
      allowedSiteIds: [SITE_A, SITE_B],
      interval: "day",
      window: {
        startMs: TIME.range.startMs,
        endExclusiveMs: TIME.range.endExclusiveMs,
        nowMs: TIME.capturedAtMs,
        timeZone: TIME.reportingTimeZone,
      },
      filters: joint.filters,
    });
    expect(expected.data.points.length).toBeGreaterThan(0);

    const actualTrace = traceFor();
    const runtime = createD1TeamQueryRuntime({
      env: envFor(database, actualTrace),
    });
    const actual = await runtime.execute("trend", {
      ...teamRequest("session"),
      interval: "day",
    } as never);
    expect(actual.ok).toBe(true);
    if (!actual.ok) return;
    expect(actual.data).toEqual(expected.data);
    for (const [index, sql] of actualTrace.preparedSql.entries()) {
      const bound = (actualTrace.bindings[index] ?? []).map(String);
      expect(
        bound.includes(SITE_A) && bound.includes(SITE_B),
        sql.slice(0, 80),
      ).toBe(false);
      expect(bound).not.toContain(SITE_C);
    }
  });

  it("keeps native filters on the direct per-site read", async () => {
    const database = createFixture();
    const runtime = createD1TeamQueryRuntime({
      env: envFor(database, traceFor()),
    });
    const result = await runtime.execute("overview", {
      ...teamRequest("session", 'page.path eq "/q"'),
    } as never);
    expect(result.ok).toBe(true);
  });
});
