import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as classifier from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import * as comparisonPlans from "@/lib/edge/analytics/engine/comparison-report-plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
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
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as bindings from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as prepared from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";
function query(
  scope: "session" | "visitor",
  cursor?: string,
  variant = "count",
) {
  const end = SEED_BASE_MS + SEED_DAY_MS * SEED_DAYS,
    split = SEED_BASE_MS + SEED_DAY_MS * 3,
    captured = end + SEED_DAY_MS;
  const current = {
    time: createQueryTime(split, end, "UTC", captured),
    filters: parseFilterDsl(
      'count(event { event.name eq "qualifier" }) gte 1' +
        (variant === "time" ? " and time gte @range.start+1d" : ""),
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  };
  const reference = {
    time: createQueryTime(SEED_BASE_MS, split, "UTC", captured),
    filters: parseFilterDsl(
      'count(event { event.name eq "qualifier" }) gte 1' +
        (variant === "time" ? " and time gte @range.start+1d" : ""),
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  };
  return {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: current.time,
    scopePreference: scope,
    filters: parseFilterDsl("", analyticsFilterRegistry),
    mode: "overview-tab",
    tab: "source.domain",
    limit: 2,
    ...(cursor ? { cursor } : {}),
    current,
    reference,
    comparison: {
      current,
      reference,
      metric: "views",
      sortBy: "current",
      direction: "desc",
    },
  };
}
async function execute(
  db: D1Database,
  input: ReturnType<typeof query>,
  oracle = false,
  metadata = false,
) {
  const attempted = observeStatementAttempts(db),
    observed = observeCostDatabase(attempted.database),
    diagnostics = createD1ReadDiagnostics();
  const core = vi.spyOn(evaluator, "evaluateFilterDocument"),
    bridge = vi.spyOn(prepared, "registerPreparedMembership"),
    bind = vi.spyOn(bindings, "bindPageVisitQualificationPreparation");
  const forced = oracle
    ? vi.spyOn(classifier, "classifyAdvancedCountFilter").mockReturnValue({
        kind: "unsupported",
        code: "independent-core-oracle",
        path: "root",
        reason: "Independent full original filter Core oracle",
      })
    : undefined;
  const started = performance.now();
  try {
    const result = await createD1SiteQueryRuntime({
      env: {
        DB: observed.database,
        MAIN_SECRET: "w12-comparison-secret",
      } as Env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).execute("dimension", input as never, {
      onProviderError(e) {
        throw e;
      },
    });
    return {
      result,
      coreCalls: core.mock.calls.length,
      bridgeCalls: bridge.mock.calls.length,
      bindCalls: bind.mock.calls.length,
      boundPlans: bind.mock.calls.map(([c]) => ({
        plan: c.plan,
        time: c.queryTime,
        readerTime: c.readerQueryTime,
        consumer: c.consumerKey,
      })),
      diagnostics,
      elapsedMs: performance.now() - started,
      ...summarizeCost(observed.observations, metadata),
      statementAttempts: attempted.attempts,
      statementDetail: observed.observations,
    };
  } finally {
    forced?.mockRestore();
    core.mockRestore();
    bridge.mockRestore();
    bind.mockRestore();
  }
}

it("preserves legal consumer defaults, boundaries, search, metrics, sort and cursor normalization", async () => {
  const native = createMigratedDatabase();
  try {
    for (const sql of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 100 }),
    ])
      native.exec(sql);
    const patches = [
      { limit: undefined },
      { limit: 1 },
      { limit: 500 },
      { search: "" },
      { search: " " },
      { search: "example" },
      {
        comparison: {
          metric: "sessions",
          sortBy: "reference",
          direction: "asc",
        },
      },
      {
        comparison: { metric: "visitors", sortBy: "change", direction: "desc" },
      },
    ];
    for (const patch of patches) {
      const input = query("session");
      Object.assign(input, {
        ...patch,
        ...(patch.comparison
          ? { comparison: { ...input.comparison, ...patch.comparison } }
          : {}),
      });
      const actual = await execute(createSqliteD1Database(native), input),
        oracle = await execute(
          createSqliteD1Database(native),
          input,
          true,
          false,
        );
      expect(actual.result).toEqual(oracle.result);
      expect(
        actual.result.ok,
        JSON.stringify({ patch, result: actual.result }),
      ).toBe(true);
      expect(actual.bridgeCalls).toBe(0);
      expect(actual.bindCalls).toBe(2);
    }
  } finally {
    native.close();
  }
});
it("maps each comparison side by explicit output identity after analysis node permutation", async () => {
  const native = createMigratedDatabase();
  try {
    for (const sql of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 100 }),
    ])
      native.exec(sql);
    const input = query("visitor", undefined, "time"),
      expected = await execute(createSqliteD1Database(native), input),
      original = comparisonPlans.buildComparisonPagePlan;
    const spy = vi
      .spyOn(comparisonPlans, "buildComparisonPagePlan")
      .mockImplementation((...args) => {
        const plan = original(...args),
          nodes = [...plan.nodes],
          positions = nodes.flatMap((n, i) =>
            n.kind === "analysis-result" ? [i] : [],
          );
        expect(positions).toHaveLength(2);
        [nodes[positions[0]!], nodes[positions[1]!]] = [
          nodes[positions[1]!]!,
          nodes[positions[0]!]!,
        ];
        return validateLogicalPlan({ ...plan, nodes });
      });
    try {
      const actual = await execute(createSqliteD1Database(native), input);
      expect(actual.result).toEqual(expected.result);
      expect(actual.bridgeCalls).toBe(0);
      expect(actual.bindCalls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  } finally {
    native.close();
  }
});

it("preserves both scopes and independent time domains through full Core DTO and cursor comparison", async () => {
  const native = createMigratedDatabase();
  try {
    for (const sql of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 200 }),
    ])
      native.exec(sql);
    for (const scope of ["session", "visitor"] as const)
      for (const variant of ["count", "time"]) {
        const input = query(scope, undefined, variant),
          actual = await execute(createSqliteD1Database(native), input),
          oracle = await execute(createSqliteD1Database(native), input, true);
        expect(actual.result).toEqual(oracle.result);
        expect(actual.coreCalls).toBe(0);
        expect(actual.bridgeCalls).toBe(0);
        expect(actual.bindCalls).toBe(2);
        expect(actual.statementAttempts).toHaveLength(
          variant === "count" ? 5 : 7,
        );
        if (!actual.result.ok) throw new Error("expected_success");
        const cursor = (
          actual.result.data as unknown as {
            data: { pagination: { nextCursor?: string } };
          }
        ).data.pagination.nextCursor;
        expect(cursor).toBeTruthy();
        const second = query(scope, cursor, variant),
          page = await execute(createSqliteD1Database(native), second),
          pageOracle = await execute(
            createSqliteD1Database(native),
            second,
            true,
          );
        expect(page.result).toEqual(pageOracle.result);
      }
  } finally {
    native.close();
  }
});
