import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { valuesRelation } from "@/lib/db";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { PAGE_DIMENSION_SELECTIONS } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { LogicalPlanBuilder } from "@/lib/edge/analytics/engine/logical/builder";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import { buildComparisonDimensionRollupPlan } from "@/lib/edge/analytics/providers/d1/internal/comparison-dimension-source";
import { sqliteBoundText } from "@/lib/edge/analytics/providers/d1/internal/lowering/scoped-source/selection-compatibility";
import {
  bindPageVisitQualificationPreparation,
  createPageVisitQualificationPreparation,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { createAnalysisResultQualificationExecutionInputsForTrustedPlan } from "@/lib/edge/analytics/providers/d1/internal/qualification-execution-inputs";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
async function execute(qualified: boolean) {
  const db = createMigratedDatabase();
  try {
    for (const sql of [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 100 }),
    ])
      db.exec(sql);
    const time = createQueryTime(
        SEED_BASE_MS,
        SEED_BASE_MS + 7 * SEED_DAY_MS,
        "UTC",
        SEED_BASE_MS + 8 * SEED_DAY_MS,
      ),
      query: any = prepareScopedQuery("dimension", {
        context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
        time,
        scopePreference: "session",
        filters: parseFilterDsl(
          qualified ? "count(event) gt 0" : "",
          analyticsFilterRegistry,
        ),
      } as never),
      metadata = scopedFilterMetadata(query.filters);
    const child = buildComparisonDimensionRollupPlan({
      siteId: SEED_SITE_ID,
      window: {
        startMs: time.range.startMs,
        endExclusiveMs: time.range.endExclusiveMs,
        nowMs: time.capturedAtMs,
        timeZone: "UTC",
      },
      filters: query.filters,
      selection: PAGE_DIMENSION_SELECTIONS.referrerDomain,
      ...(qualified ? { entityDependency: true } : {}),
    });
    const two = validateLogicalPlan({
      ...child,
      outputs: [
        ...child.outputs,
        { ...child.outputs[0]!, id: "second-rollup" },
      ],
    });
    const b = new LogicalPlanBuilder(two.context),
      fields = [
        { field: "value", as: "key" },
        { field: "views" },
        { field: "sessions" },
        { field: "visitors" },
      ],
      first = b.importAnalysisResult(
        two,
        "comparison-dimension-rollup",
        fields,
      ),
      second = b.importAnalysisResult(two, "second-rollup", fields),
      joined = b.join(first, second, [{ left: "key", right: "key" }], "inner");
    b.output("paired", joined, [
      { name: "key", slot: "key" },
      { name: "first", slot: "views" },
      { name: "second", slot: "right.views" },
    ]);
    const plan = snapshotPageVisitQualificationPlan(b.finish()),
      kids = plan.nodes.flatMap((n) =>
        n.kind === "analysis-result" ? [validateLogicalPlan(n.childPlan)] : [],
      );
    expect(kids).toHaveLength(2);
    expect(kids[0]).toBe(kids[1]);
    let inputs;
    if (qualified) {
      const matches = db
          .prepare(
            "SELECT DISTINCT session_id AS entityId FROM visits WHERE site_pk=1",
          )
          .all()
          .map((r) => ({ siteId: SEED_SITE_ID, entityId: String(r.entityId) })),
        key = { operation: "multi-output-generic" };
      const preparation = createPageVisitQualificationPreparation({
        siteId: SEED_SITE_ID,
        filters: query.filters,
        queryTime: metadata!.time!,
        scopePlan: metadata!.plan,
        consumerKey: key,
        relation: valuesRelation(
          {
            site_id: { affinity: "text", nullable: false },
            entity_id: { affinity: "text", nullable: false },
          },
          matches.map((r) => ({
            site_id: sqliteBoundText(r.siteId),
            entity_id: sqliteBoundText(r.entityId),
          })),
        ) as never,
        dependencyRef: "event-filter-entity-membership-v1",
      });
      const side = bindPageVisitQualificationPreparation({
        preparation,
        siteId: SEED_SITE_ID,
        filters: query.filters,
        queryTime: metadata!.time!,
        scopePlan: metadata!.plan,
        consumerKey: key,
        plan: kids[0]!,
        readerQueryTime: time,
      });
      inputs = createAnalysisResultQualificationExecutionInputsForTrustedPlan(
        [{ childPlan: kids[0]!, executionInputs: side }],
        plan,
      );
    }
    const trace: SqliteD1Trace = { preparedSql: [], bindings: [] },
      result = await queryAnalyticsReportOutputRowsFromD1(
        { DB: createSqliteD1Database(db, trace) } as Env,
        plan,
        "paired",
        undefined,
        undefined,
        inputs,
      );
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) expect(r.first).toBe(r.second);
    return { result, trace };
  } finally {
    db.close();
  }
}
it("preserves unqualified multi-output rows, SQL and binding order", async () => {
  const actual = await execute(false);
  expect(
    createHash("sha256").update(JSON.stringify(actual)).digest("hex"),
  ).toBe("e519776faaf6642a00bab1ddedb5364e083c1f5079b323a0aac7a033a0767911");
});
it("attaches a delegated child exactly once across multiple imported outputs", async () => {
  const actual = await execute(true);
  expect(actual.trace.preparedSql).toHaveLength(1);
});
