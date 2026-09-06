import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  analyticsFilterRegistry,
  type FunnelConfigV2,
  type ScopedDatasetSql,
} from "@/lib/edge/analytics/contract";
import {
  assertFunnelSqlShapeWithinBudget,
  assertFunnelStructuralBudget,
  buildFunnelSqlPlan,
  FUNNEL_SQL_CTES_PER_STEP,
  FUNNEL_SQL_STRUCTURAL_BUDGET,
} from "@/lib/edge/analytics/providers/d1/internal/funnel-planner";
import {
  applyObservationFilterToScopedDataset,
  assertSafeScopedObservationCtePrefix,
} from "@/lib/edge/analytics/providers/d1/internal/scoped-dataset";
import { parseFilterDsl } from "@/lib/filter-contract";

const dataset: ScopedDatasetSql = {
  ctes: `
scope_final_visits(site_pk, session_id, visitor_id, started_at, visit_id, pathname) AS (
  VALUES
    (1, 'session-1', 'visitor-1', 100, 'visit-1', '/landing'),
    (1, 'session-1', 'visitor-1', 200, 'visit-2', '/landing'),
    (2, 'session-1', 'visitor-2', 100, 'visit-3', '/landing')
),
scope_final_events(event_pk, event_id, site_pk, session_id, visitor_id, occurred_at, sequence, event_name, pathname) AS (
  VALUES
    (1, 'event-1', 1, 'session-1', 'visitor-1', 160, 0, 'signup', '/landing'),
    (2, 'event-2', 2, 'session-1', 'visitor-2', 160, 0, 'signup', '/landing')
)`,
  bindings: [],
  visitRelation: "scope_final_visits",
  eventRelation: "scope_final_events",
  sessionRelation: "scope_final_sessions",
  visitorRelation: "scope_final_visitors",
  scope: "event",
};

function step(id: string, filterDsl: string) {
  return { id, filterDsl } as const;
}

function config(
  steps: FunnelConfigV2["steps"],
  progressionScope: FunnelConfigV2["progressionScope"] = "session",
  conversionWindowMs: number | null = null,
): FunnelConfigV2 {
  return {
    filterDslVersion: 1,
    progressionScope,
    conversionWindowMs,
    steps,
  };
}

function runPlan(plan: ReturnType<typeof buildFunnelSqlPlan>) {
  const database = new DatabaseSync(":memory:");
  try {
    return database
      .prepare(plan.sql)
      .all(...plan.bindings.map((binding) => binding.value)) as Array<{
      stepId: string;
      stepIndex: number;
      sessions: number;
      visitors: number;
    }>;
  } finally {
    database.close();
  }
}

describe("scoped observation filter primitive", () => {
  it("projects a step filter onto final dataset relations only", () => {
    const filter = parseFilterDsl(
      'page.path eq "/landing"',
      analyticsFilterRegistry,
    );
    const bundle = applyObservationFilterToScopedDataset(
      dataset,
      filter,
      "step_0",
    );

    expect(bundle.matchedVisitRelation).toBe("step_0_matched_visits");
    expect(bundle.matchedEventRelation).toBe("step_0_matched_events");
    expect(bundle.sessionRelation).toBe("step_0_sessions");
    expect(bundle.visitorRelation).toBe("step_0_visitors");
    expect(bundle.ctes).toContain(
      "FROM scope_final_visits step_0_visit_filter",
    );
    expect(bundle.ctes).toContain("FROM scope_final_events");
    expect(bundle.ctes).not.toContain("scope_raw_visits");
    expect(bundle.ctes).not.toContain("scope_raw_events");
    expect(bundle.bindings.map((binding) => binding.value)).toEqual([
      "/landing",
      "/landing",
    ]);

    const unfiltered = applyObservationFilterToScopedDataset(
      dataset,
      { version: 1, root: null },
      "step_all",
    );
    expect(unfiltered.ctes).toContain(
      "step_all_matched_visits AS (SELECT * FROM scope_final_visits)",
    );
  });

  it("rejects CTE-prefix interpolation that is not an identifier", () => {
    expect(() =>
      assertSafeScopedObservationCtePrefix("step_0; DROP TABLE visits"),
    ).toThrow(/internal SQL identifier/iu);
  });
});

describe("FunnelSqlPlan", () => {
  it("runs session progression in one non-recursive query", () => {
    const plan = buildFunnelSqlPlan(
      config([
        step("landing", 'page.path eq "/landing"'),
        step("signup", 'event.name eq "signup"'),
      ]),
      dataset,
    );
    const rows = runPlan(plan);

    expect(rows).toEqual([
      { stepIndex: 0, stepId: "landing", sessions: 2, visitors: 2 },
      { stepIndex: 1, stepId: "signup", sessions: 2, visitors: 2 },
    ]);
    expect(plan.sql).not.toMatch(/WITH\s+RECURSIVE/iu);
    expect(plan.sql).toMatch(/reached_0\s+AS/iu);
    expect(plan.sql).toMatch(/reached_1\s+AS/iu);
    expect(plan.sql).toMatch(
      /ORDER BY candidate\.observed_at ASC,\s+candidate\.observation_rank ASC,\s+candidate\.sequence ASC,\s+candidate\.source_id ASC/iu,
    );
    expect(plan.sql).toContain("candidate.session_id = previous.session_id");
    expect(plan.sql).toContain("candidate.source_id > previous.last_source_id");
    expect(plan.sql).toContain("FROM funnel_step_0_sessions");
    expect(plan.sql).toContain("FROM funnel_step_0_visitors");
    expect(plan.bindings.map((binding) => binding.value).slice(-2)).toEqual([
      "landing",
      "signup",
    ]);
  });

  it("does not let one observation complete two steps", () => {
    const oneObservationDataset: ScopedDatasetSql = {
      ...dataset,
      ctes: `
scope_final_visits(site_pk, session_id, visitor_id, started_at, visit_id, pathname) AS (
  VALUES (1, 'session-1', 'visitor-1', 100, 'visit-1', '/landing')
),
scope_final_events(event_pk, event_id, site_pk, session_id, visitor_id, occurred_at, sequence, event_name, pathname) AS (
  VALUES (1, 'event-1', 1, 'session-1', 'visitor-1', 100, 0, 'other', '/other')
)`,
    };
    const rows = runPlan(
      buildFunnelSqlPlan(
        config([
          step("first", 'page.path eq "/landing"'),
          step("second", 'page.path eq "/landing"'),
        ]),
        oneObservationDataset,
      ),
    );

    expect(rows[0]).toMatchObject({ sessions: 1, visitors: 1 });
    expect(rows[1]).toMatchObject({ sessions: 0, visitors: 0 });
  });

  it("excludes blank identities and keeps progression keys site-scoped", () => {
    const scopedIdentityDataset: ScopedDatasetSql = {
      ...dataset,
      ctes: `
scope_final_visits(site_pk, session_id, visitor_id, started_at, visit_id, pathname) AS (
  VALUES
    (1, 'shared', 'shared-visitor', 100, 'site-1-visit', '/landing'),
    (1, NULL, 'blank-session', 110, 'blank-session-visit', '/landing'),
    (1, 'blank-visitor', NULL, 120, 'blank-visitor-visit', '/landing'),
    (1, NULL, NULL, 130, 'blank-both-visit', '/landing')
),
scope_final_events(event_pk, event_id, site_pk, session_id, visitor_id, occurred_at, sequence, event_name, pathname) AS (
  VALUES
    (1, 'site-2-event', 2, 'shared', 'shared-visitor', 160, 0, 'signup', ''),
    (2, 'blank-both-event', 1, NULL, NULL, 170, 0, 'signup', '')
)`,
    };

    const sessionRows = runPlan(
      buildFunnelSqlPlan(
        config([
          step("landing", 'page.path eq "/landing"'),
          step("signup", 'event.name eq "signup"'),
        ]),
        scopedIdentityDataset,
      ),
    );
    expect(sessionRows).toEqual([
      { stepIndex: 0, stepId: "landing", sessions: 2, visitors: 2 },
      { stepIndex: 1, stepId: "signup", sessions: 0, visitors: 0 },
    ]);

    const visitorRows = runPlan(
      buildFunnelSqlPlan(
        config(
          [
            step("landing", 'page.path eq "/landing"'),
            step("signup", 'event.name eq "signup"'),
          ],
          "visitor",
          1_000,
        ),
        scopedIdentityDataset,
      ),
    );
    expect(visitorRows).toEqual([
      { stepIndex: 0, stepId: "landing", sessions: 2, visitors: 2 },
      { stepIndex: 1, stepId: "signup", sessions: 0, visitors: 0 },
    ]);
  });

  it("deduplicates amplified witnesses by source id in SQL", () => {
    const duplicateSourceDataset: ScopedDatasetSql = {
      ...dataset,
      ctes: `
scope_final_visits(site_pk, session_id, visitor_id, started_at, visit_id, pathname) AS (
  VALUES (1, 'session-1', 'visitor-1', 100, 'visit-1', '/landing')
),
scope_final_events(event_pk, event_id, site_pk, session_id, visitor_id, occurred_at, sequence, event_name, pathname) AS (
  VALUES
    (1, 'same-event', 1, 'session-1', 'visitor-1', 90, 0, 'signup', ''),
    (2, 'same-event', 1, 'session-1', 'visitor-1', 120, 0, 'signup', '')
)`,
    };
    const rows = runPlan(
      buildFunnelSqlPlan(
        config([
          step("landing", 'page.path eq "/landing"'),
          step("signup", 'event.name eq "signup"'),
        ]),
        duplicateSourceDataset,
      ),
    );
    expect(rows[1]).toMatchObject({ sessions: 0, visitors: 0 });
  });

  it("carries visitor first observation through the total conversion window", () => {
    const plan = buildFunnelSqlPlan(
      config(
        [
          step("landing", 'page.path eq "/landing"'),
          step("signup", 'event.name eq "signup"'),
        ],
        "visitor",
        60,
      ),
      dataset,
    );
    const rows = runPlan(plan);

    expect(rows).toEqual([
      { stepIndex: 0, stepId: "landing", sessions: 2, visitors: 2 },
      { stepIndex: 1, stepId: "signup", sessions: 2, visitors: 2 },
    ]);
    expect(plan.sql).toContain("previous.first_observed_at");
    expect(plan.sql).toContain("conversion_window_ms");
    expect(plan.sql).toContain(
      "PARTITION BY previous.site_pk, previous.visitor_id",
    );
  });

  it("enforces every reachable structural budget and config guard", () => {
    expect(() => assertFunnelStructuralBudget(0)).toThrow(
      "funnel_steps_required",
    );
    expect(() => assertFunnelStructuralBudget(11)).toThrow(
      "funnel_sql_step_limit_exceeded",
    );

    const shape = {
      stepCount: 1,
      stagedCteCount: 1,
      funnelCteCount: 1,
      sqlLength: 1,
      bindingCount: 1,
    };
    expect(() =>
      assertFunnelSqlShapeWithinBudget(shape, { maxStagedCtes: 0 }),
    ).toThrow("funnel_sql_staged_cte_limit_exceeded");
    expect(() =>
      assertFunnelSqlShapeWithinBudget(shape, { maxFunnelCtes: 0 }),
    ).toThrow("funnel_sql_cte_limit_exceeded");
    expect(() =>
      assertFunnelSqlShapeWithinBudget(shape, { maxBindings: 0 }),
    ).toThrow("funnel_sql_binding_limit_exceeded");

    expect(() =>
      buildFunnelSqlPlan(
        config(
          [
            step("first", 'page.path eq "/first"'),
            step("second", 'page.path eq "/second"'),
          ],
          "visitor",
          null,
        ),
        dataset,
      ),
    ).toThrow("visitor_funnel_conversion_window_must_be_positive");
    expect(() =>
      buildFunnelSqlPlan(
        config(
          [
            step("first", 'page.path eq "/first"'),
            step("second", 'page.path eq "/second"'),
          ],
          "session",
          1,
        ),
        dataset,
      ),
    ).toThrow("session_funnel_conversion_window_must_be_null");
    expect(() =>
      buildFunnelSqlPlan(
        config(
          [
            step("first", 'page.path eq "/first"'),
            step("second", 'page.path eq "/second"'),
          ],
          "visitor",
          null,
        ),
        dataset,
        { allowHistoricalOverLimit: true },
      ),
    ).toThrow("visitor_funnel_conversion_window_must_be_positive");
    expect(() =>
      buildFunnelSqlPlan(
        config(
          [
            step("first", 'page.path eq "/first"'),
            step("second", 'page.path eq "/second"'),
          ],
          "session",
          1,
        ),
        dataset,
        { allowHistoricalOverLimit: true },
      ),
    ).toThrow("session_funnel_conversion_window_must_be_null");
  });

  it("reports the ten-step structural shape and catches explicit overages", () => {
    const tenStepPlan = buildFunnelSqlPlan(
      config(
        Array.from({ length: 10 }, (_, index) =>
          step(`step-${index}`, `page.path eq "/step-${index}"`),
        ),
      ),
      dataset,
    );

    expect(tenStepPlan.shape.stagedCteCount).toBe(10);
    expect(tenStepPlan.shape.funnelCteCount).toBe(
      10 * FUNNEL_SQL_CTES_PER_STEP,
    );
    expect(tenStepPlan.sql.match(/\breached_\d+\s+AS/giu)).toHaveLength(10);
    expect(tenStepPlan.shape.sqlLength).toBe(tenStepPlan.sql.length);
    expect(tenStepPlan.shape.bindingCount).toBe(30);
    expect(FUNNEL_SQL_STRUCTURAL_BUDGET.maxSteps).toBe(10);

    expect(() =>
      assertFunnelSqlShapeWithinBudget(tenStepPlan.shape, {
        maxSqlLength: tenStepPlan.shape.sqlLength - 1,
      }),
    ).toThrow("funnel_sql_length_exceeded");
    expect(() =>
      buildFunnelSqlPlan(
        config(
          Array.from({ length: 11 }, (_, index) =>
            step(`step-${index}`, `page.path eq "/step-${index}"`),
          ),
        ),
        dataset,
      ),
    ).toThrow("funnel_sql_step_limit_exceeded");

    const historicalPlan = buildFunnelSqlPlan(
      config(
        Array.from({ length: 11 }, (_, index) =>
          step(`historical-${index}`, `page.path eq "/step-${index}"`),
        ),
      ),
      dataset,
      { allowHistoricalOverLimit: true },
    );
    expect(historicalPlan.shape.stepCount).toBe(11);
  });
});
