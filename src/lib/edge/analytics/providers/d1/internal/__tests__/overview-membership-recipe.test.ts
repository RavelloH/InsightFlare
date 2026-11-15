import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as classifier from "@/lib/edge/analytics/engine/advanced-filter-count-support";
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
import type { EventMembershipFallback } from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import * as binding from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as prepared from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as overviewReader from "@/lib/edge/analytics/providers/d1/operations/overview-reader";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

const cases = ["aggregate", "detail", "previous", "previous-detail", "trend"];
function query(scope: "session" | "visitor", shape: string) {
  const end = SEED_BASE_MS + SEED_DAY_MS * SEED_DAYS,
    split = SEED_BASE_MS + 3 * SEED_DAY_MS;
  return {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: createQueryTime(split, end, "UTC", end + SEED_DAY_MS),
    scopePreference: scope,
    filters: parseFilterDsl(
      "count(page { page.durationMs gt 5 }) gte 1",
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
  legacy = false,
) {
  const attempts = observeStatementAttempts(db),
    observed = observeCostDatabase(attempts.database);
  const diagnostics = createD1ReadDiagnostics();
  const core = vi.spyOn(evaluator, "evaluateFilterDocument"),
    bridge = vi.spyOn(prepared, "registerPreparedMembership"),
    bind = vi.spyOn(binding, "bindPageVisitQualificationPreparation");
  const forced = oracle
    ? vi.spyOn(classifier, "classifyAdvancedCountFilter").mockReturnValue({
        kind: "unsupported",
        code: "independent-core-oracle",
        path: "root",
        reason: "Whole original Core oracle",
      })
    : undefined;
  const oldRoute = legacy
    ? vi
        .spyOn(afe, "prepareDeferredOverviewMembershipRecipe")
        .mockResolvedValue(undefined)
    : undefined;
  const input = query(scope, shape);
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
      bridgeCalls: bridge.mock.calls.length,
      bound: bind.mock.calls.map(([c]) => ({
        consumer: c.consumerKey,
        readerTime: c.readerQueryTime,
        plan: c.plan,
      })),
      statementAttempts: attempts.attempts,
      statementDetail: observed.observations,
      ...summarizeCost(observed.observations, false),
    };
  } finally {
    oldRoute?.mockRestore();
    forced?.mockRestore();
    core.mockRestore();
    bridge.mockRestore();
    bind.mockRestore();
  }
}

it.each(cases)(
  "preserves one qualification and the exact original %s readers",
  async (shape) => {
    const db = createMigratedDatabase();
    const setup = [
      ...buildSiteStatements(),
      ...buildDataStatements({ visits: 200 }),
      `UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id=(SELECT visit_id FROM visits WHERE started_at>=${SEED_BASE_MS + 3 * SEED_DAY_MS} ORDER BY visit_id LIMIT 1)`,
    ];
    for (const sql of setup) db.exec(sql);
    try {
      for (const scope of ["session", "visitor"] as const) {
        const candidate = await execute(
          createSqliteD1Database(db),
          scope,
          shape,
        );
        const baseline = await execute(
          createSqliteD1Database(db),
          scope,
          shape,
          false,
          true,
        );
        const oracle = await execute(
          createSqliteD1Database(db),
          scope,
          shape,
          true,
        );
        expect(candidate.result.ok).toBe(true);
        expect(candidate.result).toEqual(baseline.result);
        expect(candidate.result).toEqual(oracle.result);
        expect(candidate.coreCalls).toBe(1);
        expect(baseline.coreCalls).toBe(1);
        expect(candidate.bridgeCalls).toBe(0);
        expect(baseline.bridgeCalls).toBe(0);
        const count =
          shape === "previous-detail"
            ? 3
            : shape === "previous" || shape === "detail"
              ? 2
              : 1;
        expect(candidate.bound).toHaveLength(count);
        expect(baseline.bound).toHaveLength(count);
        expect(
          candidate.bound.every(
            (x) =>
              (x.consumer as { configuration?: { kind: string } }).configuration
                ?.kind === "overview-membership-dependencies",
          ),
        ).toBe(true);
        expect(
          baseline.bound.every(
            (x) =>
              (x.consumer as { configuration?: { kind: string } }).configuration
                ?.kind !== "overview-membership-dependencies",
          ),
        ).toBe(true);
        expect(candidate.statementDetail.map((x) => [x.sql, x.params])).toEqual(
          baseline.statementDetail.map((x) => [x.sql, x.params]),
        );
      }
    } finally {
      db.close();
    }
  },
  30000,
);
it("rejects mutated preparation values, reader domains/shapes and exhausted bindings", async () => {
  const db = createMigratedDatabase();
  for (const sql of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: 200 }),
    `UPDATE visits SET duration_ms='invalid-duration'`,
  ])
    db.exec(sql);
  let captured:
    | Parameters<typeof afe.prepareDeferredOverviewMembershipRecipe>[0]
    | undefined;
  let recipe: Awaited<
    ReturnType<typeof afe.prepareDeferredOverviewMembershipRecipe>
  >;
  const prepare = afe.prepareDeferredOverviewMembershipRecipe;
  const create = overviewReader.createOverviewReader;
  let capturedBuild:
    Parameters<EventMembershipFallback["bindPlan"]>[0] | undefined;
  let capturedTime: Parameters<EventMembershipFallback["bindPlan"]>[1];
  let capturedMembership: EventMembershipFallback | undefined;
  const prepareSpy = vi
    .spyOn(afe, "prepareDeferredOverviewMembershipRecipe")
    .mockImplementation(async (input) => {
      captured = input;
      recipe = await prepare(input);
      return recipe;
    });
  let readerChecks = 0;
  let readerFailure: unknown;
  const readerSpy = vi
    .spyOn(overviewReader, "createOverviewReader")
    .mockImplementation((env, site, diagnostics, membership) => {
      if (membership && !("bindPlan" in membership))
        throw new Error("expected_legacy_overview_membership");
      return create(
        env,
        site,
        diagnostics,
        membership && {
          bindPlan(build, time) {
            try {
              capturedBuild = build;
              capturedTime = time;
              capturedMembership = membership;
              for (const wrongTime of [
                {
                  ...time!,
                  filterRange: createQueryTime(1, 2, "UTC", time!.capturedAtMs)
                    .range,
                },
                {
                  ...time!,
                  readRange: createQueryTime(1, 2, "UTC", time!.capturedAtMs)
                    .range,
                },
                {
                  ...time!,
                  range: createQueryTime(1, 2, "UTC", time!.capturedAtMs).range,
                },
                { ...time!, capturedAtMs: time!.capturedAtMs + 1 },
                { ...time!, reportingTimeZone: "Asia/Shanghai" },
                { ...time!, fullHistory: true },
                { ...time!, filterRangeEmpty: true },
              ])
                expect(() =>
                  membership.bindPlan(build, wrongTime as typeof time),
                ).toThrow("overview_membership_reader_step_mismatch");
              expect(() =>
                membership.bindPlan((context) => {
                  const p = build(context);
                  return {
                    ...p,
                    outputs: p.outputs.map((o) => ({
                      ...o,
                      id: "wrong-output",
                    })),
                  } as typeof p;
                }, time),
              ).toThrow("overview_membership_reader_shape_mismatch");
              expect(() =>
                membership.bindPlan((context) => {
                  const p = build(context);
                  return {
                    ...p,
                    nodes: p.nodes.filter(
                      (n) => n.kind !== "source" || n.entity !== "event",
                    ),
                  } as typeof p;
                }, time),
              ).toThrow();
              expect(() =>
                membership.bindPlan((context) => {
                  const p = build(context),
                    source = p.nodes.find((n) => n.kind === "source")!;
                  const self = source.values.find((v) => v.kind === "self")!;
                  const id = Math.max(...p.slots.map((s) => s.id)) + 1;
                  return {
                    ...p,
                    slots: [
                      ...p.slots,
                      { ...p.slots.find((s) => s.id === self.slot)!, id },
                    ],
                    nodes: [
                      ...p.nodes,
                      {
                        ...source,
                        id: Math.max(...p.nodes.map((n) => n.id)) + 1,
                        grain: {
                          kind: "entity",
                          entity: source.entity,
                          key: id,
                        },
                        output: [id],
                        values: [{ kind: "self", slot: id }],
                      },
                    ],
                  } as typeof p;
                }, time),
              ).toThrow("overview_membership_reader_shape_mismatch");
              readerChecks += 10;
              return membership.bindPlan(build, time);
            } catch (e) {
              readerFailure = e;
              throw e;
            }
          },
        },
      );
    });
  try {
    const result = await execute(
      createSqliteD1Database(db),
      "session",
      "aggregate",
    );
    if (readerFailure) throw readerFailure;
    expect(result.result.ok, JSON.stringify(result.result)).toBe(true);
    expect(readerChecks).toBe(10);
    expect(recipe).toBeDefined();
    expect(captured).toBeDefined();
    // Exported pure constructors/descriptors are not runtime capabilities.
    expect(await prepare({ ...captured! })).toBeUndefined();
    expect(
      await afe.prepareDeferredEventMembershipQualification(
        { ...captured!.qualification },
        recipe!.consumerKey,
        ["overview"],
      ),
    ).toBeUndefined();
    expect(() =>
      capturedMembership!.bindPlan(capturedBuild!, capturedTime),
    ).toThrow("overview_membership_reader_step_mismatch");
    const originalStep = recipe!.enginePlan.preparation;
    for (const change of [
      (s: any) => {
        s.bounds.maxActivities += 1;
      },
      (s: any) => {
        s.queryTime.range.endExclusiveMs -= 1;
      },
      (s: any) => {
        s.filters = parseFilterDsl("", analyticsFilterRegistry);
      },
      (s: any) => {
        s.membership.identity.grain = "visitor";
      },
    ]) {
      const step: any = structuredClone(originalStep);
      change(step);
      Object.freeze(step);
      await expect(
        afe.prepareDeferredEventMembershipQualification(
          captured!.qualification,
          recipe!.consumerKey,
          ["overview"],
          { evaluationStep: step },
        ),
      ).rejects.toThrow("overview_membership_preparation_step_mismatch");
    }
    const scopePlan = captured!.qualification.metadata.plan;
    const originalRequired = scopePlan.requiresRawSource;
    const evaluate = evaluator.evaluateFilterDocument;
    const mutation = vi
      .spyOn(evaluator, "evaluateFilterDocument")
      .mockImplementation((...args) => {
        const value = evaluate(...args);
        (scopePlan as { requiresRawSource: boolean }).requiresRawSource =
          !originalRequired;
        return value;
      });
    try {
      await expect(
        afe.prepareDeferredEventMembershipQualification(
          captured!.qualification,
          recipe!.consumerKey,
          ["overview"],
          { evaluationStep: originalStep },
        ),
      ).rejects.toThrow("overview_membership_preparation_step_mismatch");
    } finally {
      mutation.mockRestore();
      (scopePlan as { requiresRawSource: boolean }).requiresRawSource =
        originalRequired;
    }
  } finally {
    prepareSpy.mockRestore();
    readerSpy.mockRestore();
    db.close();
  }
}, 60000);
