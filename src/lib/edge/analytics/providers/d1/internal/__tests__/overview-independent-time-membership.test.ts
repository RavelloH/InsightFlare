// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as classifier from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import * as overviewRecipe from "@/lib/edge/analytics/engine/overview-membership-dependency-plan";
import { planOverviewMembershipDependencies } from "@/lib/edge/analytics/engine/overview-membership-dependency-plan";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY as ENTITY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { observeStatementAttempts } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/cost-guards";
import {
  observeCostDatabase,
  summarizeCost,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as afe from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as binding from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as prepared from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as overviewReader from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

const readersExpected = (shape: string) =>
  shape === "previous-detail"
    ? 3
    : shape === "previous" || shape === "detail"
      ? 2
      : 1;
const cases = ["aggregate", "detail", "previous", "previous-detail", "trend"];
function query(scope: "session" | "visitor", shape: string) {
  const end = SEED_BASE_MS + SEED_DAY_MS * SEED_DAYS,
    split = SEED_BASE_MS + 3 * SEED_DAY_MS;
  return {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: createQueryTime(split, end, "UTC", end + SEED_DAY_MS),
    scopePreference: scope,
    filters: parseFilterDsl(
      "count(page { page.durationMs gt 5 }) gte 1 and time gte @range.start+1d",
      analyticsFilterRegistry,
    ),
    ...(shape.includes("previous")
      ? {
          previousTime: createQueryTime(
            SEED_BASE_MS,
            split,
            "UTC",
            end + SEED_DAY_MS,
          ),
        }
      : {}),
    ...(shape.includes("detail") ? { detailInterval: "day" } : {}),
    ...(shape === "trend" ? { interval: "day" } : {}),
  };
}
async function execute(
  db: D1Database,
  scope: "session" | "visitor",
  shape: string,
  oracle = false,
  overrides: Record<string, unknown> = {},
  wholeFallback = false,
) {
  const attempts = observeStatementAttempts(db),
    observed = observeCostDatabase(attempts.database);
  const diagnostics = createD1ReadDiagnostics();
  const core = vi.spyOn(evaluator, "evaluateFilterDocument"),
    bridge = vi.spyOn(prepared, "registerPreparedMembership"),
    bind = vi.spyOn(binding, "bindPageVisitQualificationPreparation"),
    create = vi.spyOn(binding, "createPageVisitQualificationPreparation");
  const resolve = vi.spyOn(prepared, "resolvePreparedMembership");
  const wholeRoute = wholeFallback
    ? vi
        .spyOn(overviewRecipe, "planOverviewMembershipDependencies")
        .mockReturnValue(undefined)
    : undefined;
  const forced = oracle
    ? vi.spyOn(classifier, "classifyAdvancedCountFilter").mockReturnValue({
        kind: "unsupported",
        code: "independent-core-oracle",
        path: "root",
        reason: "Whole original Core oracle",
      })
    : undefined;
  const input = { ...query(scope, shape), ...overrides };
  try {
    const result = await createD1SiteQueryRuntime({
      env: {
        DB: observed.database,
        MAIN_SECRET: "overview-recipe-secret",
      } as Env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).execute(shape === "trend" ? "trend" : "overview", input as never, {
      onProviderError(e) {
        throw e;
      },
    });
    return {
      input,
      result,
      diagnostics,
      coreCalls: core.mock.calls.length,
      coreDomains: core.mock.calls.map(([, , options]) => options),
      bridgeCalls: bridge.mock.calls.length,
      resolveCalls: resolve.mock.calls.length,
      preparations: create.mock.calls.map(([input]) => input),
      preparationHandles: create.mock.results.map((result) =>
        result.type === "return" ? result.value : undefined,
      ),
      bound: bind.mock.calls.map(([c]) => ({
        preparation: c.preparation,
        siteId: c.siteId,
        scopePlan: c.scopePlan,
        consumer: c.consumerKey,
        readerTime: c.readerQueryTime,
        plan: c.plan,
      })),
      statementAttempts: attempts.attempts,
      statementDetail: observed.observations,
      ...summarizeCost(observed.observations, false),
    };
  } finally {
    wholeRoute?.mockRestore();
    forced?.mockRestore();
    core.mockRestore();
    bridge.mockRestore();
    resolve.mockRestore();
    bind.mockRestore();
    create.mockRestore();
  }
}

function expectWholeOriginalTransport(
  actual: Awaited<ReturnType<typeof execute>>,
  scope: "session" | "visitor",
  plans: number,
) {
  expect(actual.bridgeCalls).toBe(0);
  expect(actual.resolveCalls).toBe(0);
  expect(actual.preparations).toHaveLength(1);
  expect(actual.preparations[0]).toMatchObject({
    siteId: SEED_SITE_ID,
    scopePlan: { scope, mode: "entity" },
    qualificationSemantics: "whole-original",
    dependencyRef: ENTITY,
    maxSourcesPerRole: 2,
  });
  expect(actual.bound).toHaveLength(plans);
  for (const bound of actual.bound) {
    expect(bound.preparation).toBe(actual.preparationHandles[0]);
    expect(bound.siteId).toBe(SEED_SITE_ID);
    expect(bound.scopePlan.scope).toBe(scope);
    const sources = bound.plan.nodes.filter((node) => node.kind === "source");
    expect(sources.map((source) => source.entity)).toEqual(["page", "event"]);
    expect(
      sources.map((source) => source.selection?.qualificationDependencyRefs),
    ).toEqual([[ENTITY], [ENTITY]]);
  }
}
it("keeps independent Count and whole-original fallback routes equivalent across both scopes and all five reader configurations", async () => {
  const db = createMigratedDatabase();
  for (const sql of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: 200 }),
  ])
    db.exec(sql);
  try {
    for (const shape of cases)
      for (const scope of ["session", "visitor"] as const) {
        const candidate = await execute(
          createSqliteD1Database(db),
          scope,
          shape,
        );
        const wholeFallback = await execute(
          createSqliteD1Database(db),
          scope,
          shape,
          false,
          {},
          true,
        );
        const oracle = await execute(
          createSqliteD1Database(db),
          scope,
          shape,
          true,
        );
        expect(candidate.result.ok).toBe(true);
        expect(candidate.result).toEqual(wholeFallback.result);
        expect(candidate.result).toEqual(oracle.result);
        expect(candidate.coreCalls).toBe(0);
        expect(wholeFallback.coreCalls).toBe(0);
        expect(oracle.coreCalls).toBe(1);
        expect(candidate.bridgeCalls).toBe(0);
        expect(candidate.resolveCalls).toBe(0);
        expectWholeOriginalTransport(
          wholeFallback,
          scope,
          readersExpected(shape),
        );
        expect(candidate.bound).toHaveLength(readersExpected(shape));
        expect(candidate.preparations).toHaveLength(1);
        expect(candidate.bound[0]!.consumer).toMatchObject({
          configuration: {
            kind: "overview-membership-dependencies",
            preparation: { queryTime: { filterRange: expect.any(Object) } },
          },
        });
        expect(candidate.bound[0]!.readerTime).toEqual(
          query(scope, shape).time,
        );
        expect(candidate.statementDetail.map((s) => [s.sql, s.params])).toEqual(
          wholeFallback.statementDetail.map((s) => [s.sql, s.params]),
        );
      }
  } finally {
    db.close();
  }
}, 60000);
const dsl = (s: string) => parseFilterDsl(s, analyticsFilterRegistry);
function fixture(n = 200) {
  const db = createMigratedDatabase();
  for (const s of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: n }),
  ])
    db.exec(s);
  return db;
}
async function prepare(
  db: ReturnType<typeof fixture>,
  overrides: Record<string, unknown> = {},
) {
  const q = prepareScopedQuery("overview", {
    ...query("session", "aggregate"),
    ...overrides,
  } as never);
  const out = await afe.d1AdvancedFilterMiddleware(
    { DB: createSqliteD1Database(db) } as Env,
    undefined,
    SEED_SITE_ID,
  )("overview", q, async (v) => v);
  return {
    q,
    out,
    state: afe.independentOverviewMembershipDependencyFromQuery(
      out,
      "overview",
    ),
  };
}
it("keeps actual numeric runtime fallback whole-Core and never registers the old bridge", async () => {
  const db = fixture();
  db.exec("UPDATE visits SET duration_ms='invalid-duration'");
  try {
    for (const scope of ["session", "visitor"] as const) {
      const actual = await execute(
          createSqliteD1Database(db),
          scope,
          "previous-detail",
        ),
        oracle = await execute(
          createSqliteD1Database(db),
          scope,
          "previous-detail",
          true,
        );
      expect(actual.result).toEqual(oracle.result);
      expect(actual.result.ok).toBe(true);
      expect(actual.coreCalls).toBe(1);
      expect(actual.bridgeCalls).toBe(0);
      expect(actual.resolveCalls).toBe(0);
      expect(actual.bound).toHaveLength(3);
      expect(
        actual.diagnostics.advancedFilterExecutionHistory?.at(-1),
      ).toMatchObject({ strategy: "bounded-core" });
    }
  } finally {
    db.close();
  }
});
it("preserves private whole-original and nonprivate legacy routing for empty, full-history and unsupported filters", async () => {
  const db = fixture();
  const rows = [];
  try {
    for (const test of [
      {
        name: "empty",
        filters: dsl(
          "count(page) gt 0 and time gte @range.end+1ms and time lt @range.end",
        ),
      },
      {
        name: "full-history",
        filters: dsl(
          "count(page) gt 0 and time gte @range.start+1d and sequence([page,event]) exists",
        ),
      },
      {
        name: "unsupported",
        filters: dsl(
          "count(page) gt 0 and time gte @range.start+1d and sequence([window(page,@range.start,[0ms,99ms]),window(event,@range.start,[0ms,99ms])]) exists",
        ),
      },
      { name: "api", context: siteQueryContext(SEED_SITE_ID, "api-v1") },
    ]) {
      const { name, ...overrides } = test;
      const actual = await execute(
          createSqliteD1Database(db),
          "session",
          "aggregate",
          false,
          overrides,
        ),
        oracle = await execute(
          createSqliteD1Database(db),
          "session",
          "aggregate",
          true,
          overrides,
        );
      expect(actual.result).toEqual(oracle.result);
      if (name === "api") {
        expect(actual.bridgeCalls).toBe(1);
        expect(actual.resolveCalls).toBe(1);
        expect(actual.bound).toHaveLength(0);
        expect(actual.preparations).toHaveLength(0);
      } else {
        expectWholeOriginalTransport(actual, "session", 1);
      }
      rows.push({ name, actual, oracle });
    }
  } finally {
    db.close();
  }
});
it("binds complete independent preparation and reader domains, and rejects replay/metadata/mixed-request capabilities", async () => {
  const db = fixture();
  const create = overviewReader.createOverviewReader;
  let captured: any,
    build: any,
    readerTime: any,
    checks = 0;
  const readerSpy = vi
    .spyOn(overviewReader, "createOverviewReader")
    .mockImplementation((env, site, diag, membership) => {
      if (membership && !("bindPlan" in membership))
        throw new Error("expected_legacy_overview_membership");
      return create(
        env,
        site,
        diag,
        membership && {
          bindPlan(b, t) {
            captured = membership;
            build = b;
            readerTime = t;
            for (const wrong of [
              { ...t!, filterRange: { startMs: 1, endExclusiveMs: 2 } },
              { ...t!, readRange: { startMs: 1, endExclusiveMs: 2 } },
              { ...t!, range: { startMs: 1, endExclusiveMs: 2 } },
              { ...t!, capturedAtMs: t!.capturedAtMs + 1 },
              { ...t!, reportingTimeZone: "Asia/Shanghai" },
              { ...t!, fullHistory: true },
            ]) {
              expect(() => membership.bindPlan(b, wrong as typeof t)).toThrow(
                "overview_membership_reader_step_mismatch",
              );
              checks++;
            }
            return membership.bindPlan(b, t);
          },
        },
      );
    });
  try {
    const actual = await execute(
      createSqliteD1Database(db),
      "session",
      "aggregate",
    );
    expect(actual.result.ok, JSON.stringify(actual.result)).toBe(true);
    expect(checks).toBe(6);
    expect(() => captured.bindPlan(build, readerTime)).toThrow(
      "overview_membership_reader_step_mismatch",
    );
    const a = await prepare(db),
      b = await prepare(db);
    expect(a.state).toBeDefined();
    expect(b.state).toBeDefined();
    expect(a.state!.queryTime.filterRange).toBeDefined();
    expect(
      a.state!.enginePlan.children[0]!.queryTime.filterRange,
    ).toBeUndefined();
    expect(
      afe.independentOverviewMembershipDependencyFromQuery(
        { ...(a.out as object) },
        "overview",
      ),
    ).toBeUndefined();
    expect(() =>
      afe.independentOverviewMembershipDependencyFromQuery(a.out, "trend"),
    ).toThrow("overview_membership_request_changed");
    const makePlan = (s: typeof a.state) =>
      binding.snapshotPageVisitQualificationPlan(
        build({
          queryTime: s!.queryTime,
          scopePlan: s!.scopePlan,
          qualificationDependencyRefs: [
            s!.enginePlan.preparation.dependencyRef,
          ],
          pageVisitDependencyRefs: [s!.enginePlan.preparation.dependencyRef],
        }),
      );
    const params = (s: typeof a.state) => ({
      preparation: s!.preparation,
      siteId: SEED_SITE_ID,
      filters: s!.filters,
      queryTime: s!.queryTime,
      scopePlan: s!.scopePlan,
      consumerKey: s!.consumerKey,
      plan: makePlan(s),
      readerQueryTime: s!.enginePlan.children[0]!.queryTime,
    });
    expect(() =>
      binding.bindPageVisitQualificationPreparation({
        ...params(a.state),
        consumerKey: b.state!.consumerKey,
      }),
    ).toThrow();
    expect(() =>
      binding.bindPageVisitQualificationPreparation({
        ...params(a.state),
        queryTime: b.state!.enginePlan.children[0]!.queryTime,
      }),
    ).toThrow();
    const metadata = scopedFilterMetadata((a.out as any).filters)!;
    (metadata.plan as { requiresRawSource: boolean }).requiresRawSource =
      !metadata.plan.requiresRawSource;
    expect(() =>
      afe.independentOverviewMembershipDependencyFromQuery(a.out, "overview"),
    ).toThrow("overview_membership_request_changed");
    const q = prepareScopedQuery(
      "overview",
      query("session", "aggregate") as never,
    );
    db.exec("UPDATE visits SET duration_ms='invalid-duration'");
    const evaluate = evaluator.evaluateFilterDocument;
    const mutation = vi
      .spyOn(evaluator, "evaluateFilterDocument")
      .mockImplementation((...args) => {
        const result = evaluate(...args);
        const m = scopedFilterMetadata((q as any).filters)!;
        (m.plan as { requiresRawSource: boolean }).requiresRawSource =
          !m.plan.requiresRawSource;
        return result;
      });
    try {
      await expect(
        afe.d1AdvancedFilterMiddleware(
          { DB: createSqliteD1Database(db) } as Env,
          undefined,
          SEED_SITE_ID,
        )("overview", q, async (v) => v),
      ).rejects.toThrow("overview_membership_request_changed");
    } finally {
      mutation.mockRestore();
    }
  } finally {
    readerSpy.mockRestore();
    db.close();
  }
});
it("does not let supported narrow Seq strategy grant Count-only recipe admission", async () => {
  const db = fixture();
  try {
    const filters = dsl(
      "sequence([window(page,@range.start,[0ms,345599999ms]),window(event,@range.start,[0ms,345599999ms])]) exists",
    );
    const q = query("session", "aggregate");
    const execution = planAdvancedFilterExecution({
      subject: semanticSubjectFromQuerySubject(q.context.subject),
      filters,
      scope: "session",
      time: q.time,
      reportFusionAvailable: false,
    });
    expect(execution.decision.strategy).toBe("sql-membership");
    expect(execution.sequenceSupport?.kind).toBe("supported");
    expect(execution.support.kind).toBe("unsupported");
    expect(
      planOverviewMembershipDependencies({
        preparation: { key: "original", execution, filters, queryTime: q.time },
        readerQueryTime: q.time,
        operation: "overview",
        configuration: { kind: "aggregate" },
        importedOutputs: [
          { childKey: "current-overview", outputId: "current" },
        ],
        consumer: {},
      }),
    ).toBeUndefined();
    const actual = await execute(
      createSqliteD1Database(db),
      "session",
      "aggregate",
      false,
      { filters },
    );
    expect(actual.result.ok, JSON.stringify(actual.result)).toBe(true);
    expectWholeOriginalTransport(actual, "session", 1);
    expect(actual.coreCalls).toBe(0);
    expect(
      actual.diagnostics.advancedFilterExecutionHistory?.at(-1)?.strategy,
    ).toBe("sql-membership");
  } finally {
    db.close();
  }
});
it("preserves activity-cap priority before numeric fallback and does not bind or register", async () => {
  const db = fixture(16000);
  db.exec(
    "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='v8000'",
  );
  const overrides = {
    time: createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + SEED_DAY_MS * SEED_DAYS,
      "UTC",
      SEED_BASE_MS + SEED_DAY_MS * (SEED_DAYS + 1),
    ),
  };
  try {
    const actual = await execute(
        createSqliteD1Database(db),
        "session",
        "aggregate",
        false,
        overrides,
      ),
      oracle = await execute(
        createSqliteD1Database(db),
        "session",
        "aggregate",
        true,
        overrides,
      );
    expect(actual.result).toEqual(oracle.result);
    expect(actual.result).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(actual.bound).toHaveLength(0);
    expect(actual.bridgeCalls).toBe(0);
    expect(actual.resolveCalls).toBe(0);
  } finally {
    db.close();
  }
}, 60000);
