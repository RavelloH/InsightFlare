import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { valuesRelation } from "@/lib/db";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { buildComparisonPagePlan } from "@/lib/edge/analytics/engine/comparison-report-plan";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import {
  comparisonMembershipDependenciesFromQuery,
  d1AdvancedFilterMiddleware,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { buildComparisonDimensionRollupPlan } from "@/lib/edge/analytics/providers/d1/internal/comparison-dimension-source";
import {
  bindPageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import {
  analysisResultQualificationExecutionInputsForLowerer,
  attachQualificationExecutionInputs,
  createAnalysisResultQualificationExecutionInputsForTrustedPlan,
  createQualificationExecutionInputsForTrustedPlan,
} from "@/lib/edge/analytics/providers/d1/internal/qualification-execution-inputs";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
function query(scope: "session" | "visitor" = "session") {
  const current = {
    time: createQueryTime(
      SEED_BASE_MS + 3 * SEED_DAY_MS,
      SEED_BASE_MS + 7 * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + 8 * SEED_DAY_MS,
    ),
    filters: parseFilterDsl(
      "count(event) gt 0 and time gte @range.start+1d",
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  };
  const reference = {
    time: createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + 3 * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + 8 * SEED_DAY_MS,
    ),
    filters: parseFilterDsl(
      "count(event) gt 0 and time gte @range.start+2d",
      analyticsFilterRegistry,
    ),
    scopePreference: scope,
  };
  return {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: current.time,
    filters: parseFilterDsl("", analyticsFilterRegistry),
    scopePreference: scope,
    mode: "overview-tab",
    tab: "source.domain",
    limit: 2,
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
async function fixture() {
  const db = createMigratedDatabase();
  for (const sql of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: 100 }),
  ])
    db.exec(sql);
  const env = {
    DB: createSqliteD1Database(db),
    MAIN_SECRET: "w12-comparison-secret",
  } as Env;
  async function prepare(limit = 2) {
    const input = prepareScopedQuery("dimension", {
      ...query(),
      limit,
    } as never);
    const forwarded: any = await d1AdvancedFilterMiddleware(
      env,
      undefined,
      SEED_SITE_ID,
    )("dimension", input, async (q) => q);
    return {
      forwarded,
      state: comparisonMembershipDependenciesFromQuery(forwarded)!,
    };
  }
  return { db, env, prepare };
}
function finalPlan(
  state: NonNullable<
    ReturnType<typeof comparisonMembershipDependenciesFromQuery>
  >,
) {
  const child = (side: "current" | "reference") => {
    const s = state[side],
      t = s.readerQueryTime;
    return buildComparisonDimensionRollupPlan({
      siteId: SEED_SITE_ID,
      window: {
        startMs: t.range.startMs,
        endExclusiveMs: t.range.endExclusiveMs,
        nowMs: t.capturedAtMs,
        timeZone: t.reportingTimeZone,
      },
      filters: s.filters,
      selection: PAGE_DIMENSION_SELECTIONS.referrerDomain,
      entityDependency: true,
    });
  };
  return snapshotPageVisitQualificationPlan(
    buildComparisonPagePlan({
      current: child("current"),
      reference: child("reference"),
      metric: "views",
      sortBy: "current",
      direction: "desc",
      cursor: null,
      limit: 2,
      childOutputId: "comparison-dimension-rollup",
    }),
  );
}
function children(plan: ReturnType<typeof finalPlan>) {
  return plan.nodes.flatMap((n) =>
    n.kind === "analysis-result" ? [validateLogicalPlan(n.childPlan)] : [],
  );
}
function bind(
  state: NonNullable<
    ReturnType<typeof comparisonMembershipDependenciesFromQuery>
  >,
  side: "current" | "reference",
  plan: ReturnType<typeof finalPlan>,
) {
  const s = state[side];
  return bindPageVisitQualificationPreparation({
    preparation: s.preparation,
    siteId: SEED_SITE_ID,
    filters: s.filters,
    queryTime: s.queryTime,
    scopePlan: s.scopePlan,
    consumerKey: s.consumerKey,
    plan,
    readerQueryTime: s.readerQueryTime,
  });
}
it("names independent C/F/R and ordered executable whole-tree steps", async () => {
  const f = await fixture();
  try {
    const { state } = await f.prepare();
    expect(state.enginePlan.steps.map((s) => s.kind)).toEqual([
      "prepare-membership",
      "prepare-membership",
      "read-report",
    ]);
    const [a, b] = state.enginePlan.steps;
    expect(a.queryTime.range).not.toEqual(b.queryTime.range);
    expect(a.queryTime.filterRange).not.toEqual(b.queryTime.filterRange);
    expect(a.readerQueryTime).not.toEqual(b.readerQueryTime);
    expect(a.queryTime.readRange).toEqual(a.queryTime.filterRange);
    expect(a.filters.root).toBeTruthy();
    expect(Object.isFrozen(a.filters.root)).toBe(true);
  } finally {
    f.db.close();
  }
});
it("rejects request clones, hidden metadata mutation and another consumer", async () => {
  const f = await fixture();
  try {
    const { state, forwarded } = await f.prepare();
    expect(
      comparisonMembershipDependenciesFromQuery({ ...forwarded }),
    ).toBeUndefined();
    const other = await f.prepare(3),
      plan = children(finalPlan(state))[0]!;
    expect(() =>
      bindPageVisitQualificationPreparation({
        preparation: state.current.preparation,
        siteId: SEED_SITE_ID,
        filters: state.current.filters,
        queryTime: state.current.queryTime,
        scopePlan: state.current.scopePlan,
        consumerKey: other.state.current.consumerKey,
        plan,
        readerQueryTime: state.current.readerQueryTime,
      }),
    ).toThrow("snapshot_mismatch");
    (
      scopedFilterMetadata(forwarded.current.filters)!.plan
        .requiredSources as Set<string>
    ).add("page");
    expect(() => comparisonMembershipDependenciesFromQuery(forwarded)).toThrow(
      "comparison_membership_request_changed",
    );
  } finally {
    f.db.close();
  }
});
it("rejects cross-side binding and preparation clone without consuming valid inputs", async () => {
  const f = await fixture();
  try {
    const { state } = await f.prepare(),
      plan = finalPlan(state),
      kids = children(plan);
    expect(() => bind(state, "current", kids[1]!)).toThrow("context_mismatch");
    expect(() =>
      bindPageVisitQualificationPreparation({
        preparation: { ...state.current.preparation },
        siteId: SEED_SITE_ID,
        filters: state.current.filters,
        queryTime: state.current.queryTime,
        scopePlan: state.current.scopePlan,
        consumerKey: state.current.consumerKey,
        plan: kids[0]!,
        readerQueryTime: state.current.readerQueryTime,
      }),
    ).toThrow("untrusted");
    expect(bind(state, "current", kids[0]!)).toBeTruthy();
    expect(() => bind(state, "current", kids[0]!)).toThrow("replayed");
  } finally {
    f.db.close();
  }
});
it("composes exact child identities, consumes original inputs, rejects swapped/clone/replayed parents", async () => {
  const f = await fixture();
  try {
    const { state } = await f.prepare(),
      plan = finalPlan(state),
      kids = children(plan),
      a = bind(state, "current", kids[0]!),
      b = bind(state, "reference", kids[1]!);
    expect(() =>
      createAnalysisResultQualificationExecutionInputsForTrustedPlan(
        [
          { childPlan: kids[0]!, executionInputs: b },
          { childPlan: kids[1]!, executionInputs: a },
        ],
        plan,
      ),
    ).toThrow("analysis_input_mismatch");
    expect(() =>
      createAnalysisResultQualificationExecutionInputsForTrustedPlan(
        [
          { childPlan: kids[0]!, executionInputs: a },
          { childPlan: kids[0]!, executionInputs: a },
        ],
        plan,
      ),
    ).toThrow("analysis_dependency_unexpected");
    const input =
      createAnalysisResultQualificationExecutionInputsForTrustedPlan(
        [
          { childPlan: kids[0]!, executionInputs: a },
          { childPlan: kids[1]!, executionInputs: b },
        ],
        plan,
      );
    expect(() => attachQualificationExecutionInputs(a, {}, kids[0]!)).toThrow(
      "plan_mismatch",
    );
    expect(() =>
      attachQualificationExecutionInputs({ ...input }, {}, plan),
    ).toThrow("untrusted");
    expect(() =>
      attachQualificationExecutionInputs(
        input,
        {},
        snapshotPageVisitQualificationPlan(plan),
      ),
    ).toThrow("plan_mismatch");
    const lowerer = {};
    expect(() =>
      analysisResultQualificationExecutionInputsForLowerer(
        input,
        lowerer,
        plan,
      ),
    ).toThrow("analysis_input_mismatch");
    expect(attachQualificationExecutionInputs(input, lowerer, plan)).toEqual(
      [],
    );
    const bound = analysisResultQualificationExecutionInputsForLowerer(
      input,
      lowerer,
      plan,
    );
    expect(bound.map((v) => v.childPlan)).toEqual(kids);
    expect(() =>
      analysisResultQualificationExecutionInputsForLowerer(input, {}, plan),
    ).toThrow("analysis_input_mismatch");
    expect(() =>
      attachQualificationExecutionInputs(input, lowerer, plan),
    ).toThrow("plan_mismatch");
    expect(
      attachQualificationExecutionInputs(
        bound[0]!.executionInputs,
        {},
        bound[0]!.childPlan,
      ),
    ).toHaveLength(1);
    expect(() =>
      attachQualificationExecutionInputs(input, lowerer, plan),
    ).toThrow("plan_mismatch");
    expect(() =>
      attachQualificationExecutionInputs(
        bound[0]!.executionInputs,
        {},
        bound[0]!.childPlan,
      ),
    ).toThrow("plan_mismatch");
    expect(
      attachQualificationExecutionInputs(
        bound[1]!.executionInputs,
        {},
        bound[1]!.childPlan,
      ),
    ).toHaveLength(1);
  } finally {
    f.db.close();
  }
});
it("executes the final frozen composition once and rejects a second execution", async () => {
  const f = await fixture();
  try {
    const { state } = await f.prepare(),
      plan = finalPlan(state),
      kids = children(plan),
      input = createAnalysisResultQualificationExecutionInputsForTrustedPlan(
        kids.map((childPlan, i) => ({
          childPlan,
          executionInputs: bind(
            state,
            i === 0 ? "current" : "reference",
            childPlan,
          ),
        })),
        plan,
      );
    const rows = await queryAnalyticsReportOutputRowsFromD1(
      f.env,
      plan,
      "comparison-page",
      undefined,
      undefined,
      input,
    );
    expect(rows.length).toBeGreaterThan(0);
    await expect(
      queryAnalyticsReportOutputRowsFromD1(
        f.env,
        plan,
        "comparison-page",
        undefined,
        undefined,
        input,
      ),
    ).rejects.toThrow("plan_mismatch");
  } finally {
    f.db.close();
  }
});

it("rejects unfrozen, unbound, untrusted and schema-mismatched physical inputs before consumption", async () => {
  const f = await fixture();
  try {
    const { state } = await f.prepare(),
      plan = finalPlan(state),
      kid = children(plan)[0]!;
    expect(() =>
      createAnalysisResultQualificationExecutionInputsForTrustedPlan([], {
        ...plan,
      }),
    ).toThrow("plan_not_frozen");
    expect(() =>
      createQualificationExecutionInputsForTrustedPlan([], { ...kid }),
    ).toThrow("plan_not_frozen");
    expect(() =>
      createQualificationExecutionInputsForTrustedPlan([], kid),
    ).toThrow("dependency_unexpected");
    expect(() =>
      attachQualificationExecutionInputs(undefined, {}, kid),
    ).toThrow("dependency_unbound");
    expect(() => attachQualificationExecutionInputs(1, {}, plan)).toThrow(
      "input_untrusted",
    );
    expect(() =>
      attachQualificationExecutionInputs(() => undefined, {}, plan),
    ).toThrow("input_untrusted");
    expect(
      analysisResultQualificationExecutionInputsForLowerer(undefined, {}, plan),
    ).toEqual([]);
    expect(() =>
      createQualificationExecutionInputsForTrustedPlan(
        [
          {
            dependencyRef: "event-filter-entity-membership-v1",
            relation: valuesRelation(
              { wrong: { affinity: "text", nullable: false } },
              [],
            ) as never,
          },
        ],
        kid,
      ),
    ).toThrow("relation_schema_mismatch");
  } finally {
    f.db.close();
  }
});
