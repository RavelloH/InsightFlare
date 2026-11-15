import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as classifier from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as bindings from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as prepared from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";
function request(scope: "session" | "visitor", dsl: string, cap = false) {
  const end = SEED_BASE_MS + 7 * SEED_DAY_MS;
  const current = {
    time: createQueryTime(
      cap ? SEED_BASE_MS : SEED_BASE_MS + 3 * SEED_DAY_MS,
      end,
      "UTC",
      end + SEED_DAY_MS,
    ),
    filters: parseFilterDsl(dsl, analyticsFilterRegistry),
    scopePreference: scope,
  };
  const reference = {
    time: createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + 3 * SEED_DAY_MS,
      "UTC",
      end + SEED_DAY_MS,
    ),
    filters: parseFilterDsl("count(event) gt 0", analyticsFilterRegistry),
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
    ...(cap ? { cursor: "bad-cursor" } : {}),
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
  db: ReturnType<typeof createMigratedDatabase>,
  input: ReturnType<typeof request>,
  oracle = false,
) {
  const diagnostics = createD1ReadDiagnostics(),
    bridge = vi.spyOn(prepared, "registerPreparedMembership"),
    bind = vi.spyOn(bindings, "bindPageVisitQualificationPreparation"),
    core = vi.spyOn(evaluator, "evaluateFilterDocument");
  const force = oracle
    ? vi.spyOn(classifier, "classifyAdvancedCountFilter").mockReturnValue({
        kind: "unsupported",
        code: "independent-core-oracle",
        path: "root",
        reason: "Full original Core oracle",
      })
    : undefined;
  try {
    const result = await createD1SiteQueryRuntime({
      env: {
        DB: createSqliteD1Database(db),
        MAIN_SECRET: "comparison-negative",
      } as Env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).execute("dimension", input as never);
    return {
      result,
      diagnostics,
      bridgeCalls: bridge.mock.calls.length,
      bindCalls: bind.mock.calls.length,
      coreCalls: core.mock.calls.length,
    };
  } finally {
    force?.mockRestore();
    bridge.mockRestore();
    bind.mockRestore();
    core.mockRestore();
  }
}
for (const scope of ["session", "visitor"] as const) {
  it.each(["'invalid-duration'", "x'6162'"])(
    `${scope} preserves real whole-Core numeric runtime fallback for %s`,
    async (value) => {
      const db = createMigratedDatabase();
      try {
        for (const sql of [
          ...buildSiteStatements(),
          ...buildDataStatements({ visits: 200 }),
        ])
          db.exec(sql);
        db.exec(`UPDATE visits SET duration_ms=${value} WHERE visit_id='v150'`);
        const input = request(
            scope,
            "count(page { page.durationMs gt 5 }) gte 1 and time gte @range.start+1d",
          ),
          actual = await execute(db, input),
          oracle = await execute(db, input, true);
        expect(actual.result).toEqual(oracle.result);
        expect(actual.result.ok).toBe(true);
        expect(actual.coreCalls).toBe(1);
        expect(actual.bridgeCalls).toBe(0);
        expect(actual.bindCalls).toBe(2);
        expect(
          actual.diagnostics.advancedFilterExecutionHistory?.some(
            (h) =>
              h.strategy === "bounded-core" &&
              h.reason === "sql-runtime-numeric-data-domain",
          ),
        ).toBe(true);
      } finally {
        db.close();
      }
    },
  );
  it(`${scope} preserves global cap before invalid numeric data and malformed cursor`, async () => {
    const db = createMigratedDatabase();
    try {
      for (const sql of [
        ...buildSiteStatements(),
        ...buildDataStatements({ visits: 16000 }),
      ])
        db.exec(sql);
      db.exec(
        "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='v8000'",
      );
      const input = request(
          scope,
          "count(page { page.durationMs gt 5 }) gte 1",
          true,
        ),
        actual = await execute(db, input),
        oracle = await execute(db, input, true);
      expect(actual.result).toEqual(oracle.result);
      expect(actual.result).toMatchObject({
        ok: false,
        error: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(actual.bridgeCalls).toBe(0);
      expect(actual.bindCalls).toBe(0);
      expect(actual.coreCalls).toBe(0);
    } finally {
      db.close();
    }
  }, 60000);
}
