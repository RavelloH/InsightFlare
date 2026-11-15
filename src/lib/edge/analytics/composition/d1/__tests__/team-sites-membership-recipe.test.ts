// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1TeamQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  prepareScopedQuery,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import { buildOverviewAggregatePlan } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import * as recipe from "@/lib/edge/analytics/engine/team-sites-membership-dependency-plan";
import * as wholeRecipe from "@/lib/edge/analytics/engine/team-sites-whole-reader-plan";
import { prepareTeamSitesQualification } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import {
  type TeamSitesQualification,
  teamSitesQualificationReaders,
} from "@/lib/edge/analytics/providers/d1/internal/team-sites-qualification";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

import { createFixture } from "./team-sites-membership-fixture";
const TIME = createQueryTime(100, 200, "UTC", 300);
const sites = ["b04-site-a", "b04-site-b"];
function request(
  scope: "session" | "visitor",
  trend = false,
  cursor: string | null = null,
) {
  return {
    context: teamQueryContext("b04-team", "private-dashboard", sites),
    time: createQueryTime(100, 200, "UTC", 300),
    filters: parseFilterDsl(
      'count(event { event.name eq "qualifier" }) gte 1',
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
    teamId: "b04-team",
    allowedSiteIds: sites,
    page: { limit: 1, cursor },
    ...(trend ? { interval: "day" as const } : {}),
  };
}
async function execute(
  query: ReturnType<typeof request>,
  forceLegacyFallback: boolean,
) {
  const db = createFixture();
  db.exec("PRAGMA query_only=ON");
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const registered = vi.spyOn(bridge, "registerPreparedMembership");
  const resolved = vi.spyOn(bridge, "resolvePreparedMembership");
  const fallback = forceLegacyFallback
    ? vi
        .spyOn(recipe, "planTeamSitesMembershipDependencies")
        .mockReturnValue(undefined)
    : undefined;
  // This arm explicitly tests the retained legacy fallback contract, rather
  // than a historical source version. Both finite declarations must decline
  // so the actual register/resolve path executes after normal whole evaluation.
  const wholeFallback = forceLegacyFallback
    ? vi
        .spyOn(wholeRecipe, "planTeamSitesWholeOriginalReaders")
        .mockReturnValue(undefined)
    : undefined;
  try {
    const result = await createD1TeamQueryRuntime({
      env: {
        DB: createSqliteD1Database(db, trace),
        MAIN_SECRET: "team-sites-private-native",
      } as unknown as Env,
    }).execute("team-sites", query);
    const value = {
      result,
      sql: trace.preparedSql,
      bindings: trace.bindings,
      registered: registered.mock.calls.length,
      resolved: resolved.mock.calls.length,
    };
    expect(result.ok).toBe(true);
    expect(value.registered).toBe(forceLegacyFallback ? 1 : 0);
    expect(value.resolved).toBe(forceLegacyFallback ? value.resolved : 0);
    return value;
  } finally {
    wholeFallback?.mockRestore();
    fallback?.mockRestore();
    registered.mockRestore();
    resolved.mockRestore();
  }
}
describe("team-sites finite recipes and retained legacy fallback", () => {
  it.each(["session", "visitor"] as const)(
    "preserves full DTO, all SQL and joint tuple params against forced legacy fallback for %s with/without trend and cursor",
    async (scope) => {
      for (const trend of [false, true]) {
        const firstOld = await execute(request(scope, trend), true);
        const firstNew = await execute(request(scope, trend), false);
        expect(firstNew.result).toEqual(firstOld.result);
        if (firstNew.result.ok)
          expect(firstNew.result.data.items[0]?.metrics.views).toBe(2);
        expect(firstNew.sql).toEqual(firstOld.sql);
        expect(firstNew.bindings).toEqual(firstOld.bindings);
        if (!firstNew.result.ok) throw new Error("expected first page");
        const cursor = firstNew.result.data.pagination.nextCursor;
        expect(cursor).toBeTypeOf("string");
        const nextOld = await execute(request(scope, trend, cursor), true);
        const nextNew = await execute(request(scope, trend, cursor), false);
        if (nextNew.result.ok)
          expect(nextNew.result.data.items[0]?.metrics.views).toBe(3);
        expect(nextNew.result).toEqual(nextOld.result);
        expect(nextNew.sql).toEqual(nextOld.sql);
        expect(nextNew.bindings).toEqual(nextOld.bindings);
      }
    },
  );
  it("keeps forced legacy fallback and finite recipes behind joint admission for empty listings and foreign same-ID sites", async () => {
    const q = { ...request("session"), allowedSiteIds: [] };
    const old = await execute(q, true),
      current = await execute(q, false);
    expect(current.result).toEqual(old.result);
    expect(current.sql).toEqual(old.sql);
    expect(current.bindings).toEqual(old.bindings);
    if (!current.result.ok) throw new Error("expected empty page");
    expect(current.result.data.items).toEqual([]);
    expect(current.sql.length).toBeGreaterThan(1);
  });
});

describe("finite team-sites engine declaration", () => {
  it("keeps one full-domain preparation and a closed2/3-plan per-site shape", () => {
    for (const trend of [false, true]) {
      const q = prepareScopedQuery("team-sites", request("session", trend));
      const p = recipe.planTeamSitesMembershipDependencies(q)!;
      expect(p).toBeDefined();
      expect(p.admission.siteIds).toEqual(sites);
      expect(p.children).toHaveLength(trend ? 6 : 4);
      expect(p.children.map((c) => c.maxSources)).toEqual(
        trend ? [2, 2, 1, 2, 2, 1] : [2, 1, 2, 1],
      );
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.admission.queryTime)).toBe(true);
      expect(JSON.parse(JSON.stringify(p.admission.filters))).toEqual(
        JSON.parse(JSON.stringify(q.filters)),
      );
      expect(
        scopedFilterMetadata(q.filters)?.plan.preparedMembership,
      ).toBeUndefined();
    }
  });
});
function envFor(
  db: ReturnType<typeof createFixture>,
  trace: SqliteD1Trace,
): Env {
  return {
    DB: createSqliteD1Database(db, trace),
    MAIN_SECRET: "team-sites-private-native",
  } as unknown as Env;
}
function readInput(query: ReturnType<typeof request>, env: Env) {
  return {
    env,
    teamId: query.teamId,
    window: {
      startMs: query.time.range.startMs,
      endExclusiveMs: query.time.range.endExclusiveMs,
      nowMs: query.time.capturedAtMs,
      timeZone: query.time.reportingTimeZone,
    },
    filters: query.filters,
    allowedSiteIds: query.allowedSiteIds,
    page: query.page,
    audience: query.context.policy.audience,
    ...(query.interval ? { interval: query.interval } : {}),
  };
}

describe("joint admission and private capability rejection", () => {
  it.each([
    "scope",
    "time",
    "filters",
    "domain",
    "subject",
    "reader",
    "filter-clone",
    "requestedScope",
    "resolvedScope",
    "metadata-getter",
    "metadata-toJSON",
  ] as const)(
    "reproves %s mutation across Core await before any report or listing",
    async (kind) => {
      const db = createFixture();
      db.exec("UPDATE visits SET duration_ms='invalid-duration'");
      const query = prepareScopedQuery("team-sites", {
        ...request("session"),
        filters: parseFilterDsl(
          "count(page { page.durationMs gt 5 }) gte 1",
          analyticsFilterRegistry,
        ),
      });
      const metadata = scopedFilterMetadata(query.filters)!;
      const real = evaluator.evaluateFilterDocument;
      let calls = 0;
      const core = vi
        .spyOn(evaluator, "evaluateFilterDocument")
        .mockImplementation((...args) => {
          const result = real(...args);
          if (++calls === 2) {
            if (kind === "requestedScope" || kind === "resolvedScope")
              Object.assign(metadata, { [kind]: "visitor" });
            if (kind === "metadata-getter")
              Object.defineProperty(metadata, "requestedScope", {
                enumerable: true,
                get() {
                  throw new Error("getter_must_not_run");
                },
              });
            if (kind === "metadata-toJSON")
              Object.assign(metadata, {
                toJSON() {
                  throw new Error("toJSON_must_not_run");
                },
              });
            if (kind === "scope")
              Object.assign(metadata.plan, { expansion: "matching-visitors" });
            if (kind === "time")
              Object.assign(query.time.range, { startMs: 101 });
            if (kind === "filters")
              Object.assign(query.filters!, { root: null });
            if (kind === "filter-clone")
              Object.assign(query, { filters: { ...query.filters } });
            if (kind === "domain")
              Object.assign(metadata.siteIds, { 0: "b04-site-c" });
            if (kind === "subject")
              Object.assign(query.context.subject, { teamId: "other-team" });
            if (kind === "reader") Object.assign(query, { interval: "hour" });
          }
          return result;
        });
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const register = vi.spyOn(bridge, "registerPreparedMembership");
      try {
        await expect(
          prepareTeamSitesQualification({ env: envFor(db, trace), query }),
        ).rejects.toMatchObject({
          domainError: {
            issues: [
              { code: "team_sites_membership_admission_context_mismatch" },
            ],
          },
        });
        expect(calls).toBe(2);
        expect(register).not.toHaveBeenCalled();
        expect(
          trace.preparedSql.every((sql) => !sql.includes('AS "createdAt"')),
        ).toBe(true);
      } finally {
        core.mockRestore();
        register.mockRestore();
      }
    },
  );
  it.each(["missing", "too-new"] as const)(
    "checks full authorized %s coverage before invalid cursor and empty listing",
    async (kind) => {
      const db = createFixture();
      db.exec(
        kind === "missing"
          ? "DELETE FROM sites WHERE id='b04-site-b'"
          : "UPDATE sites SET created_at=1 WHERE id='b04-site-b'",
      );
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
      const result = await createD1TeamQueryRuntime({
        env: envFor(db, trace),
      }).execute("team-sites", {
        ...request("session", false, "invalid-cursor"),
        allowedSiteIds: [],
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain(
        "filter_evaluation_range_unavailable",
      );
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.bindings[0]).toEqual(sites);
    },
  );
  it("retains joint admission for zero authorized sites before rejecting an invalid cursor", async () => {
    const db = createFixture(),
      trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const query = prepareScopedQuery("team-sites", {
      ...request("session"),
      context: teamQueryContext("b04-team", "private-dashboard", []),
      allowedSiteIds: [],
      page: { limit: 1, cursor: "invalid-cursor" },
    });
    const core = vi.spyOn(bridge, "entityMembershipRelation");
    try {
      const qualification = await prepareTeamSitesQualification({
        env: envFor(db, trace),
        query,
      });
      expect(qualification).toBeDefined();
      expect(core).toHaveBeenCalledTimes(1);
      expect(core).toHaveBeenCalledWith([], []);
      expect(trace.preparedSql).toHaveLength(0);
      await expect(
        readTeamSites({
          ...readInput(query, envFor(db, trace)),
          qualification,
        }),
      ).rejects.toBeDefined();
      expect(trace.preparedSql).toHaveLength(0);
    } finally {
      core.mockRestore();
    }
  });
  it("rejects cloned/foreign capabilities, changed request data, extra sites and repeated children before storage", async () => {
    const db = createFixture(),
      trace: SqliteD1Trace = { preparedSql: [], bindings: [] },
      env = envFor(db, trace);
    const query = prepareScopedQuery("team-sites", request("session"));
    const qualification = await prepareTeamSitesQualification({ env, query });
    expect(qualification).toBeDefined();
    const input = readInput(query, env),
      before = trace.preparedSql.length;
    expect(() =>
      teamSitesQualificationReaders(input, {} as TeamSitesQualification),
    ).toThrow("team_sites_qualification_untrusted_or_replayed");
    expect(() =>
      teamSitesQualificationReaders(
        { ...input, filters: { ...input.filters } },
        qualification,
      ),
    ).toThrow("team_sites_qualification_request_mismatch");
    const readers = teamSitesQualificationReaders(input, qualification);
    expect(() => readers.site("b04-site-c")).toThrow(
      "team_sites_qualification_site_mismatch",
    );
    const child = readers.site("b04-site-a");
    expect(() => readers.site("b04-site-a")).toThrow(
      "team_sites_qualification_site_mismatch",
    );
    expect(() =>
      child.membership.bindPlan(
        (context) =>
          buildOverviewAggregatePlan({
            siteId: "b04-site-b",
            queryTime: query.time,
            filters: child.filters,
            scopePlan: context.scopePlan,
            qualificationDependencyRefs: context.qualificationDependencyRefs,
          }),
        query.time,
      ),
    ).toThrow(
      "invalid_semantic_scoped_source_selection:subject_outside_prepared_authorization",
    );
    const bind = () =>
      child.membership.bindPlan(
        (context) =>
          buildOverviewAggregatePlan({
            siteId: "b04-site-a",
            queryTime: query.time,
            filters: child.filters,
            scopePlan: context.scopePlan,
            qualificationDependencyRefs: context.qualificationDependencyRefs,
          }),
        query.time,
      );
    expect(bind()).toHaveProperty("executionInputs");
    expect(bind).toThrow("team_sites_qualification_reader_mismatch");
    expect(() => teamSitesQualificationReaders(input, qualification)).toThrow(
      "team_sites_qualification_untrusted_or_replayed",
    );
    expect(trace.preparedSql).toHaveLength(before);
  });
});

describe("unchanged eligibility boundaries", () => {
  it.each([
    "event",
    "public",
    "api",
    "independent-filter",
    "independent-read",
    "history",
    "payload",
    "native",
    "metadata-clone",
  ] as const)("keeps %s outside the new recipe", (kind) => {
    const base = request("session");
    const input =
      kind === "event"
        ? { ...base, scopePreference: "event" as const }
        : kind === "public"
          ? {
              ...base,
              context: teamQueryContext("b04-team", "public-share", sites),
            }
          : kind === "api"
            ? {
                ...base,
                context: teamQueryContext("b04-team", "api-v1", sites),
              }
            : kind === "payload"
              ? {
                  ...base,
                  filters: parseFilterDsl(
                    'count(event { event.payload("/amount") gt 1 }) gte 1',
                    analyticsFilterRegistry,
                  ),
                }
              : kind === "native"
                ? {
                    ...base,
                    filters: parseFilterDsl(
                      'page.path eq "/q"',
                      analyticsFilterRegistry,
                    ),
                  }
                : base;
    const query = prepareScopedQuery("team-sites", input);
    if (kind === "independent-filter")
      Object.assign(query.time, {
        filterRange: { startMs: 101, endExclusiveMs: 199 },
      });
    if (kind === "independent-read")
      Object.assign(query.time, {
        readRange: { startMs: 99, endExclusiveMs: 200 },
      });
    if (kind === "history") Object.assign(query.time, { fullHistory: true });
    if (kind === "metadata-clone")
      Object.assign(query, { scopePlan: { ...query.scopePlan } });
    expect(recipe.planTeamSitesMembershipDependencies(query)).toBeUndefined();
  });
});

describe("total cap, listing timing and request freshness", () => {
  it("retains the joint20k activity cap even when listing excludes the larger authorization domain", async () => {
    const db = createFixture();
    for (const site of sites)
      db.prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001) INSERT INTO visits(visit_id,site_id,site_pk,visitor_id,session_id,status,started_at,last_activity_at,pathname,hostname,duration_ms) SELECT ?||i,?,(SELECT site_pk FROM site_identities WHERE site_id=?),'v-cap','s-cap','closed',150,150,'/cap','cap.test',0 FROM n`,
      ).run(`hidden-${site}-`, site, site);
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
    const result = await createD1TeamQueryRuntime({
      env: envFor(db, trace),
    }).execute("team-sites", {
      ...request("session", false, "invalid-cursor"),
      filters: parseFilterDsl("count(page) gte 0", analyticsFilterRegistry),
      allowedSiteIds: [],
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("filter_activity_limit_exceeded");
    expect(
      trace.preparedSql.some((sql) => sql.includes('AS "publicEnabled"')),
    ).toBe(false);
  });
  it.each([
    "page",
    "time",
    "filter",
    "scope",
    "authorized-domain",
    "requestedScope",
    "resolvedScope",
    "metadata-getter",
    "metadata-toJSON",
  ] as const)(
    "rejects %s after admission before cursor/listing",
    async (kind) => {
      const db = createFixture(),
        trace: SqliteD1Trace = { preparedSql: [], bindings: [] },
        env = envFor(db, trace);
      const query = prepareScopedQuery("team-sites", request("session"));
      const qualification = await prepareTeamSitesQualification({ env, query });
      const input = readInput(query, env),
        before = trace.preparedSql.length;
      const metadata = scopedFilterMetadata(query.filters)!;
      let accessorCalls = 0;
      if (kind === "requestedScope" || kind === "resolvedScope")
        Object.assign(metadata, { [kind]: "visitor" });
      if (kind === "metadata-getter")
        Object.defineProperty(metadata, "requestedScope", {
          enumerable: true,
          get() {
            accessorCalls++;
            throw new Error("getter_must_not_run");
          },
        });
      if (kind === "metadata-toJSON")
        Object.assign(metadata, {
          toJSON() {
            accessorCalls++;
            throw new Error("toJSON_must_not_run");
          },
        });
      if (kind === "page") Object.assign(query.page, { limit: 2 });
      if (kind === "time")
        Object.assign(query.time.range, { endExclusiveMs: 199 });
      if (kind === "filter") Object.assign(query.filters!, { root: null });
      if (kind === "scope")
        Object.assign(scopedFilterMetadata(query.filters)!.plan, {
          expansion: "matching-visitors",
        });
      if (kind === "authorized-domain")
        Object.assign(query.context.subject, {
          authorizedSiteIds: ["b04-site-a"],
        });
      await expect(
        readTeamSites({ ...input, qualification }),
      ).rejects.toBeDefined();
      expect(trace.preparedSql).toHaveLength(before);
      expect(accessorCalls).toBe(0);
    },
  );
});

it("keeps actual narrow Seq SQL membership outside the Count recipe", async () => {
  const { planAdvancedFilterExecution } =
    await import("@/lib/edge/analytics/engine/advanced-filter-execution-plan");
  const { semanticSubjectFromQuerySubject } =
    await import("@/lib/edge/analytics/engine/semantic/subject");
  const query = prepareScopedQuery("team-sites", {
    ...request("session"),
    filters: parseFilterDsl(
      'sequence([window(page { page.path eq "/p" },@range.start,[0ms,99ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,99ms])]) exists',
      analyticsFilterRegistry,
    ),
  });
  const execution = planAdvancedFilterExecution({
    subject: semanticSubjectFromQuerySubject(query.context.subject),
    filters: query.filters!,
    scope: "session",
    time: query.time,
    reportFusionAvailable: false,
  });
  expect(execution.decision.strategy).toBe("sql-membership");
  expect(execution.support.kind).not.toBe("supported");
  expect(recipe.planTeamSitesMembershipDependencies(query)).toBeUndefined();
});
