import type { DatabaseSync } from "node:sqlite";

import { afterAll, describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { AnalyticsProviderDomainError } from "@/lib/edge/analytics/application/errors";
import {
  createSiteExactDimensionQualificationProjection,
  prepareSiteExactDimensionRequest,
  siteExactDimensionQualificationForRequest,
} from "@/lib/edge/analytics/application/site-exact-dimension";
import { createD1TeamQueryRuntime } from "@/lib/edge/analytics/composition/d1";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  teamQueryContext,
} from "@/lib/edge/analytics/contract";
import { attachScopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  prepareScopedQuery,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  planTeamExactDimensionExecution,
  type TeamExactDimensionQuery,
} from "@/lib/edge/analytics/engine/team-exact-dimension-plan";
import * as admission from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { prepareSiteExactDimensionInputs } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import { registerPreparedMembership } from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import { evaluateWholeFilterMembership as evaluateForSitesCore } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import { readSiteExactDimension } from "@/lib/edge/analytics/providers/d1/operations/site-exact-dimension";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";
import type { FilterDocument } from "@/lib/filter-contract/filters";

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

/** Historical producer preserved test-local after production deletion. Its joint
 * evaluator, authorization/error order, native arm and per-site registration are
 * the exact old implementation, rather than a mock of the replacement route. */
function invalidInput(
  path: string,
  code: string,
): AnalyticsProviderDomainError {
  return new AnalyticsProviderDomainError({
    kind: "invalid-input",
    issues: [{ path, code }],
  });
}

async function prepareSiteExactDimensionFilters(input: {
  readonly env: Env;
  readonly query: TeamExactDimensionQuery;
  readonly siteIds: readonly string[];
  readonly diagnostics?: D1ReadDiagnostics;
  readonly signal?: AbortSignal;
}): Promise<ReadonlyMap<string, FilterDocument>> {
  const { query } = input;
  const decision = planTeamExactDimensionExecution(query);
  if (decision.kind !== "exact")
    throw invalidInput(
      "filters",
      "site_exact_dimension_qualification_unavailable",
    );
  const subject = semanticSubjectFromQuerySubject(query.context.subject);
  if (
    input.siteIds.some((siteId) => !subject.siteIds.some((id) => id === siteId))
  )
    throw invalidInput(
      "filters",
      "advanced_filter_execution_site_context_mismatch",
    );
  const filters = query.filters ?? EMPTY_FILTER_DOCUMENT;
  if (decision.qualification === "native")
    return new Map(input.siteIds.map((siteId) => [siteId, filters]));
  const metadata = scopedFilterMetadata(filters)!;
  const matches = await evaluateForSitesCore({
    env: input.env,
    subject,
    // Preserve the old authorized-domain coverage and guard checks, including
    // authorized ids absent from the current team site listing.
    siteIds: metadata.siteIds,
    filters,
    plan: metadata.plan,
    time: metadata.time,
    diagnostics: input.diagnostics,
    signal: input.signal,
  });
  return new Map(
    input.siteIds.map((siteId) => {
      const plan = {
        ...metadata.plan,
        preparedMembership: registerPreparedMembership({
          siteIds: [siteId],
          mode: metadata.plan.mode,
          matches: matches.filter((match) => match.siteId === siteId),
        }),
      };
      return [
        siteId,
        attachScopedFilterMetadata(filters, {
          ...metadata,
          plan,
          siteIds: [siteId],
        }),
      ];
    }),
  );
}

/** Exercise the former admission implementation through the actual runtime. */
async function executeExactRoute(
  database: DatabaseSync,
  request: ReturnType<typeof teamRequest> & {
    mode: "breakdown";
    dimension: string;
    limit: number;
  },
  route: "old-bridge" | "request-relation",
) {
  const trace = traceFor();
  const register = vi.spyOn(bridge, "registerPreparedMembership");
  const core = vi.spyOn(evaluator, "evaluateFilterDocument");
  const legacy =
    route === "old-bridge"
      ? vi
          .spyOn(admission, "prepareSiteExactDimensionInputs")
          .mockImplementation(async (input) => {
            const filtersBySite = await prepareSiteExactDimensionFilters(input);
            return new Map(
              [...filtersBySite].map(([siteId, filters]) => [
                siteId,
                {
                  filters,
                  ...(scopedFilterMetadata(filters)?.plan.preparedMembership
                    ? { qualifiedPlan: scopedFilterMetadata(filters)!.plan }
                    : {}),
                },
              ]),
            );
          })
      : undefined;
  try {
    const result = await createD1TeamQueryRuntime({
      env: envFor(database, trace),
    }).execute("dimension", request);
    expect(result.ok).toBe(true);
    return {
      result,
      sql: trace.preparedSql,
      params: trace.bindings,
      statementCount: trace.preparedSql.length,
      bridgeCalls: register.mock.calls.length,
      coreCalls: core.mock.calls.length,
    };
  } finally {
    legacy?.mockRestore();
    register.mockRestore();
    core.mockRestore();
  }
}
describe("team exact private recipe actual runtime parity", () => {
  it.each(
    (["session", "visitor"] as const).flatMap((scope) =>
      (["native", "count", "fallback"] as const).map((strategy) => ({
        scope,
        strategy,
      })),
    ),
  )(
    "$scope / $strategy preserves every SQL, binding and complete DTO",
    async ({ scope, strategy }) => {
      const database = createFixture();
      if (strategy === "fallback")
        database.exec(
          "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='b04-site-a:a1'",
        );
      const dsl =
        strategy === "native"
          ? "page.path exists"
          : strategy === "fallback"
            ? "count(page { page.durationMs gt 5 }) gte 1"
            : QUALIFIER;
      const request = {
        ...teamRequest(scope, dsl),
        mode: "breakdown" as const,
        dimension: "page.path",
        limit: 0,
      };
      database.exec("PRAGMA query_only=ON");
      const old = await executeExactRoute(database, request, "old-bridge");
      const current = await executeExactRoute(
        database,
        request,
        "request-relation",
      );
      expect(current.result).toEqual(old.result);
      expect(current.sql).toEqual(old.sql);
      expect(current.params).toEqual(old.params);
      expect(current.statementCount).toBe(old.statementCount);
      expect(current.coreCalls).toBe(old.coreCalls);
      expect(old.bridgeCalls).toBe(strategy === "native" ? 0 : 2);
      expect(current.bridgeCalls).toBe(0);
      if (strategy === "fallback") expect(current.coreCalls).toBe(2);
    },
  );
});
it.each(["session", "visitor"] as const)(
  "%s duplicated authorized IDs preserve the old joint Count route without registrations",
  async (scope) => {
    const database = createFixture();
    const siteIds = [SITE_A, SITE_A, SITE_B];
    const request = {
      ...teamRequest(scope),
      context: teamQueryContext(TEAM, "private-dashboard", siteIds),
      allowedSiteIds: siteIds,
      mode: "breakdown" as const,
      dimension: "page.path",
      limit: 0,
    };
    database.exec("PRAGMA query_only=ON");
    const old = await executeExactRoute(database, request, "old-bridge");
    const current = await executeExactRoute(
      database,
      request,
      "request-relation",
    );
    expect(current.result).toEqual(old.result);
    expect(current.sql).toEqual(old.sql);
    expect(current.params).toEqual(old.params);
    expect(current.statementCount).toBe(old.statementCount);
    expect(current.coreCalls).toBe(old.coreCalls);
    expect(old.bridgeCalls).toBe(3);
    expect(current.bridgeCalls).toBe(0);
  },
);

async function preparedParts() {
  const database = createFixture();
  const query = prepareScopedQuery("dimension", {
    ...teamRequest("session"),
    mode: "breakdown",
    dimension: "page.path",
  });
  const inputs = await prepareSiteExactDimensionInputs({
    env: envFor(database, traceFor()),
    query,
    siteIds: [SITE_A, SITE_B],
  });
  return { database, query, a: inputs.get(SITE_A)!, b: inputs.get(SITE_B)! };
}
function childInput(
  parts: Awaited<ReturnType<typeof preparedParts>>,
  siteId = SITE_A,
) {
  const value = siteId === SITE_A ? parts.a : parts.b;
  return {
    siteId,
    audience: "private-dashboard" as const,
    dimension: "page.path",
    time: parts.query.time,
    filters: value.filters,
    scopePreference: parts.query.scopePreference,
    qualifiedPlan: value.qualifiedPlan!,
    qualification: value.qualification!,
  };
}
// The application projection is checked again by the D1 preparation owner.
const candidateOnly = it;
describe("joint-admission private per-site execution boundary", () => {
  candidateOnly.each([
    "scope",
    "time",
    "filter",
    "domain",
    "subject",
    "reader",
    "filter-clone",
  ] as const)(
    "rejects %s mutation during joint Core before any child preparation",
    async (kind) => {
      const database = createFixture();
      database.exec("UPDATE visits SET duration_ms='invalid-duration'");
      const query = prepareScopedQuery("dimension", {
        ...teamRequest("session", "count(page { page.durationMs gt 5 }) gte 1"),
        time: createQueryTime(100, 200, "UTC", 300),
        mode: "breakdown",
        dimension: "page.path",
        limit: 0,
      });
      const metadata = scopedFilterMetadata(query.filters)!;
      const evaluate = evaluator.evaluateFilterDocument;
      let calls = 0;
      const core = vi
        .spyOn(evaluator, "evaluateFilterDocument")
        .mockImplementation((...args) => {
          const result = evaluate(...args);
          if (++calls === 2) {
            if (kind === "scope")
              Object.assign(metadata.plan, { expansion: "matching-visitors" });
            if (kind === "time")
              Object.assign(query.time.range, { startMs: 101 });
            if (kind === "filter")
              Object.assign(query.filters!, { root: null });
            if (kind === "filter-clone")
              Object.assign(query, { filters: { ...query.filters } });
            if (kind === "domain")
              Object.assign(metadata.siteIds, { 0: SITE_C });
            if (kind === "subject")
              Object.assign(query.context.subject, { teamId: "other-team" });
            if (kind === "reader")
              Object.assign(query, { dimension: "page.title" });
          }
          return result;
        });
      const register = vi.spyOn(bridge, "registerPreparedMembership");
      const trace = traceFor();
      try {
        await expect(
          prepareSiteExactDimensionInputs({
            env: envFor(database, trace),
            query,
            siteIds: [SITE_A, SITE_B],
          }),
        ).rejects.toMatchObject({
          domainError: {
            kind: "invalid-input",
            issues: [
              {
                path: "filters",
                code: "team_exact_membership_admission_context_mismatch",
              },
            ],
          },
        });
        expect(calls).toBe(2);
        expect(register).not.toHaveBeenCalled();
        expect(
          trace.preparedSql.some((sql) => sql.includes('AS "publicEnabled"')),
        ).toBe(false);
      } finally {
        core.mockRestore();
        register.mockRestore();
      }
    },
  );
  candidateOnly.each([
    "forged",
    "clone",
    "site",
    "time-clone",
    "filter-clone",
    "scope-clone",
    "dimension",
    "scope-preference",
  ] as const)("rejects %s projection context before storage", async (kind) => {
    const parts = await preparedParts();
    const original = childInput(parts);
    const input = { ...original };
    if (kind === "forged")
      input.qualification = {} as typeof input.qualification;
    if (kind === "clone") input.qualification = { ...input.qualification };
    if (kind === "site") input.siteId = SITE_B;
    if (kind === "time-clone") input.time = { ...input.time };
    if (kind === "filter-clone") input.filters = { ...input.filters };
    if (kind === "scope-clone")
      input.qualifiedPlan = { ...input.qualifiedPlan };
    if (kind === "dimension") input.dimension = "page.title";
    if (kind === "scope-preference") input.scopePreference = "visitor";
    expect(() => prepareSiteExactDimensionRequest(input)).toThrow(
      "site_exact_dimension_qualification_projection_context_mismatch",
    );
  });
  candidateOnly("rejects a projection reused by a second request", async () => {
    const parts = await preparedParts();
    const input = childInput(parts);
    prepareSiteExactDimensionRequest(input);
    expect(() => prepareSiteExactDimensionRequest(input)).toThrow(
      "site_exact_dimension_qualification_projection_context_mismatch",
    );
  });
  candidateOnly.each([
    "request-clone",
    "context",
    "time",
    "filter",
    "plan",
  ] as const)("rejects %s request mutation before storage", async (kind) => {
    const parts = await preparedParts();
    const request = prepareSiteExactDimensionRequest(childInput(parts));
    const candidate = kind === "request-clone" ? { ...request } : request;
    if (kind === "context")
      Object.assign(request.context.subject, { siteId: SITE_B });
    if (kind === "time") Object.assign(request.time.range, { startMs: 101 });
    if (kind === "filter") Object.assign(request.filters, { root: null });
    if (kind === "plan")
      Object.assign(request.scopePlan!, { expansion: "matching-visitors" });
    const prepare = vi.fn();
    await expect(
      readSiteExactDimension({ DB: { prepare } } as unknown as Env, candidate),
    ).rejects.toThrow("site_exact_dimension_request_context_mismatch");
    expect(prepare).not.toHaveBeenCalled();
  });
  candidateOnly.each([
    "foreign-preparation",
    "other-site-preparation",
    "other-reader-preparation",
  ] as const)(
    "does not treat an application token as authority: %s",
    async (kind) => {
      const parts = await preparedParts();
      const inputA = childInput(parts);
      const sealedA = prepareSiteExactDimensionRequest(inputA);
      const actual = siteExactDimensionQualificationForRequest(sealedA)!;
      const input = childInput(
        parts,
        kind === "other-site-preparation" ? SITE_B : SITE_A,
      );
      if (kind === "other-reader-preparation") input.dimension = "page.title";
      input.qualification = createSiteExactDimensionQualificationProjection({
        siteId: input.siteId,
        audience: input.audience,
        dimension: input.dimension,
        time: input.time,
        filters: input.filters,
        scopePlan: input.qualifiedPlan,
        scopePreference: input.scopePreference,
        preparation:
          kind === "foreign-preparation" ? {} : (actual.preparation as object),
      });
      const request = prepareSiteExactDimensionRequest(input);
      const prepare = vi.fn();
      await expect(
        readSiteExactDimension({ DB: { prepare } } as unknown as Env, request),
      ).rejects.toThrow(
        kind === "foreign-preparation"
          ? "qualification_execution_preparation_untrusted"
          : "qualification_execution_plan_snapshot_mismatch",
      );
      expect(prepare).not.toHaveBeenCalled();
    },
  );
  candidateOnly("cannot replay an already bound preparation", async () => {
    const parts = await preparedParts();
    const request = prepareSiteExactDimensionRequest(childInput(parts));
    const result = await readSiteExactDimension(
      envFor(parts.database, traceFor()),
      request,
    );
    expect(result.items.length).toBeGreaterThan(0);
    const prepare = vi.fn();
    await expect(
      readSiteExactDimension({ DB: { prepare } } as unknown as Env, request),
    ).rejects.toThrow("qualification_execution_preparation_replayed");
    expect(prepare).not.toHaveBeenCalled();
  });
  candidateOnly(
    "executes the zero-site admission decision even without a report child",
    async () => {
      const query = prepareScopedQuery("dimension", {
        ...teamRequest("session"),
        context: teamQueryContext(TEAM, "private-dashboard", []),
        allowedSiteIds: [],
        mode: "breakdown",
        dimension: "page.path",
      });
      const diagnostics = createD1ReadDiagnostics();
      const prepare = vi.fn();
      const inputs = await prepareSiteExactDimensionInputs({
        env: { DB: { prepare } } as unknown as Env,
        query,
        siteIds: [],
        diagnostics,
      });
      expect(inputs.size).toBe(0);
      expect(diagnostics.advancedFilterExecutionHistory).toHaveLength(1);
      expect(diagnostics.advancedFilterExecution?.strategy).toBe(
        "sql-membership",
      );
      expect(prepare).not.toHaveBeenCalled();
    },
  );
  candidateOnly.each(["missing", "too-new"] as const)(
    "checks full authorized %s coverage before an empty allowed listing",
    async (kind) => {
      const database = createFixture();
      database.exec(
        kind === "missing"
          ? `DELETE FROM sites WHERE id='${SITE_B}'`
          : `UPDATE sites SET created_at=1 WHERE id='${SITE_B}'`,
      );
      const trace = traceFor();
      const result = await createD1TeamQueryRuntime({
        env: envFor(database, trace),
      }).execute("dimension", {
        ...teamRequest("session"),
        allowedSiteIds: [],
        mode: "breakdown",
        dimension: "page.path",
        limit: 0,
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain(
        "filter_evaluation_range_unavailable",
      );
      expect(trace.preparedSql).toHaveLength(1);
      expect(trace.bindings[0]).toEqual([SITE_A, SITE_B]);
    },
  );
  candidateOnly(
    "retains fallback admission before an empty actual team listing",
    async () => {
      const database = createFixture();
      database.exec(
        "UPDATE sites SET team_id='not-this-team'; UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='b04-site-a:a1'",
      );
      const trace = traceFor();
      const core = vi.spyOn(evaluator, "evaluateFilterDocument");
      try {
        const result = await createD1TeamQueryRuntime({
          env: envFor(database, trace),
        }).execute("dimension", {
          ...teamRequest(
            "session",
            "count(page { page.durationMs gt 5 }) gte 1",
          ),
          mode: "breakdown",
          dimension: "page.path",
          limit: 0,
        });
        expect(result).toMatchObject({ ok: true, data: { items: [] } });
        expect(core.mock.calls.length).toBe(2);
        expect(
          trace.preparedSql.filter((sql) =>
            sql.includes('AS "createdAtSeconds"'),
          ),
        ).toHaveLength(1);
      } finally {
        core.mockRestore();
      }
    },
  );
  candidateOnly(
    "retains the request-wide total cap even when metadata listing excludes the second site",
    async () => {
      const database = createFixture();
      for (const site of [SITE_A, SITE_B])
        database
          .prepare(
            `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10001) INSERT INTO visits (visit_id,site_id,site_pk,visitor_id,session_id,status,started_at,last_activity_at,pathname,hostname,duration_ms) SELECT ?||i,?,(SELECT site_pk FROM site_identities WHERE site_id=?),'v-cap','s-cap','closed',150,150,'/cap','cap.test',0 FROM n`,
          )
          .run(`hidden-${site}-`, site, site);
      const trace = traceFor();
      const result = await createD1TeamQueryRuntime({
        env: envFor(database, trace),
      }).execute("dimension", {
        ...teamRequest("session", "count(page) gte 0"),
        allowedSiteIds: [],
        mode: "breakdown",
        dimension: "page.path",
        limit: 0,
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain(
        "filter_activity_limit_exceeded",
      );
      expect(
        trace.preparedSql.some((sql) => sql.includes('AS "publicEnabled"')),
      ).toBe(false);
    },
  );
});
