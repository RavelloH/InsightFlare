// @vitest-environment node
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as countSupport from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import * as wholeFamily from "@/lib/edge/analytics/engine/page-whole-original-family";
import { buildReferrerSummaryPlan } from "@/lib/edge/analytics/engine/referrer-report-plan";
import * as timeRecipe from "@/lib/edge/analytics/engine/referrers-time-membership-plan";
import {
  COST_FILTER,
  COST_TIME,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import {
  d1AdvancedFilterMiddleware,
  referrersTimeMembershipDependencyFromQuery,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as binding from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as prepared from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as wholeExecutor from "@/lib/edge/analytics/providers/d1/internal/whole-filter-membership-executor";
import * as wholeReader from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import { bindWholeFilterReader } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

type Scope = "session" | "visitor";
type Dependency = NonNullable<
  ReturnType<typeof referrersTimeMembershipDependencyFromQuery>
>;
const FILTER = `${COST_FILTER} and time gte @range.start+1d`;
function fixture(visits = 200) {
  const database = createMigratedDatabase();
  for (const sql of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits }),
  ])
    database.exec(sql);
  return database;
}
function query(scope: Scope, dsl = FILTER, topN = 10) {
  return {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: COST_TIME,
    scopePreference: scope,
    filters: parseFilterDsl(dsl, analyticsFilterRegistry),
    variant: "summary",
    topN,
  };
}
async function execute(
  database: DatabaseSync,
  scope: Scope,
  dsl = FILTER,
  coreOracle = false,
  legacyOracle = false,
) {
  const whole = legacyOracle
    ? vi
        .spyOn(wholeFamily, "pageWholeOriginalFamilyFromQuery")
        .mockReturnValue(undefined)
    : undefined;
  const recipe = legacyOracle
    ? vi
        .spyOn(timeRecipe, "planReferrersTimeMembershipDependency")
        .mockReturnValue(undefined)
    : vi.spyOn(timeRecipe, "planReferrersTimeMembershipDependency");
  const wholeBind = vi.spyOn(wholeReader, "bindWholeOriginalReader");
  const bridge = vi.spyOn(prepared, "registerPreparedMembership");
  const core = vi.spyOn(evaluator, "evaluateFilterDocument");
  const binder = vi.spyOn(binding, "bindPageVisitQualificationPreparation");
  const classifier = coreOracle
    ? vi.spyOn(countSupport, "classifyAdvancedCountFilter").mockReturnValue({
        kind: "unsupported",
        code: "complete_core_oracle",
        path: "root",
        reason: "Independent complete original filter oracle.",
      })
    : undefined;
  try {
    const diagnostics = createD1ReadDiagnostics();
    const runtime = createD1SiteQueryRuntime({
      env: {
        DB: createSqliteD1Database(database),
        MAIN_SECRET: "time-membership-test",
      } as Env,
      siteId: SEED_SITE_ID,
      diagnostics,
    });
    const result = await runtime.execute(
      "referrers",
      query(scope, dsl) as never,
      {
        onProviderError(error) {
          throw error;
        },
      },
    );
    return {
      result,
      diagnostics,
      bridgeCalls: bridge.mock.calls.length,
      wholeBindCalls: wholeBind.mock.calls.length,
      recipeAdmissions: recipe.mock.results.filter(
        (result) => result.type === "return" && result.value !== undefined,
      ).length,
      coreCalls: core.mock.calls.length,
      bindings: [...binder.mock.calls],
    };
  } finally {
    classifier?.mockRestore();
    whole?.mockRestore();
    recipe.mockRestore();
    wholeBind.mockRestore();
    bridge.mockRestore();
    core.mockRestore();
    binder.mockRestore();
  }
}
async function prepare(database: DatabaseSync, topN = 10) {
  const input = prepareScopedQuery(
    "referrers",
    query("session", FILTER, topN) as never,
  );
  const forwarded = await d1AdvancedFilterMiddleware(
    { DB: createSqliteD1Database(database) } as Env,
    createD1ReadDiagnostics(),
    SEED_SITE_ID,
  )("referrers", input, async (value) => value);
  if (!forwarded || typeof forwarded !== "object")
    throw new Error("missing_forwarded_request");
  return {
    forwarded,
    dependency: referrersTimeMembershipDependencyFromQuery(forwarded)!,
  };
}
function bind(
  dependency: Dependency,
  consumerKey = dependency.consumerKey,
  preparation = dependency.preparation,
) {
  const plan = binding.snapshotPageVisitQualificationPlan(
    buildReferrerSummaryPlan({
      siteId: SEED_SITE_ID,
      filters: dependency.filters,
      queryTime: dependency.description.outputs[0]!.queryTime,
      scopePlan: dependency.scopePlan,
      topN: dependency.description.consumer.configuration.topN,
      qualificationDependencyRefs: [
        dependency.description.outputs[0]!.sources[0]!.dependencyRef,
      ],
    }),
  );
  return binding.bindPageVisitQualificationPreparation({
    preparation,
    siteId: SEED_SITE_ID,
    filters: dependency.filters,
    queryTime: dependency.queryTime,
    scopePlan: dependency.scopePlan,
    consumerKey,
    plan,
  });
}

describe("Referrers independent-time request-owned membership", () => {
  it("binds two canonical outputs once and rejects changed consumer or copied preparation", async () => {
    const database = fixture();
    try {
      const { dependency } = await prepare(database);
      const consumer = {
        kind: "referrers-summary" as const,
        configuration: { topN: 10 },
      };
      expect(
        new Set(
          dependency.description.outputs.map((output) => output.readerKey),
        ).size,
      ).toBe(1);
      expect(
        dependency.description.outputs.map((output) => output.outputId),
      ).toEqual(["referrer-summary", "referrer-top-sources"]);
      expect(() =>
        bindWholeFilterReader({
          dependency,
          siteId: SEED_SITE_ID,
          consumer: { ...consumer, configuration: { topN: 11 } },
        }),
      ).toThrow("qualification_execution_plan_snapshot_mismatch");
      expect(() =>
        bindWholeFilterReader({
          dependency: {
            ...dependency,
            preparation: { ...dependency.preparation },
          },
          siteId: SEED_SITE_ID,
          consumer,
        }),
      ).toThrow("qualification_execution_preparation_untrusted");
      const bound = bindWholeFilterReader({
        dependency,
        siteId: SEED_SITE_ID,
        consumer,
      });
      expect(Object.isFrozen(bound.plan)).toBe(true);
      expect(
        bound.plan.nodes.filter((node) => node.kind === "source"),
      ).toHaveLength(1);
      expect(bound.plan.outputs).toHaveLength(2);
      expect(() =>
        bindWholeFilterReader({ dependency, siteId: SEED_SITE_ID, consumer }),
      ).toThrow("qualification_execution_preparation_replayed");
    } finally {
      database.close();
    }
  });
  it("does not trust a copied catalog value and matching fabricated consumer key", async () => {
    const database = fixture();
    try {
      const { dependency } = await prepare(database);
      const consumer = {
        kind: "referrers-summary" as const,
        configuration: { topN: 11 },
      };
      const description = { ...dependency.description, consumer };
      const changed = {
        ...dependency,
        description,
        consumerKey: { operation: "referrers-summary", topN: 11, description },
      };
      expect(() =>
        bindWholeFilterReader({
          dependency: changed,
          siteId: SEED_SITE_ID,
          consumer,
        }),
      ).toThrow("qualification_execution_plan_snapshot_mismatch");
      expect(
        bindWholeFilterReader({
          dependency,
          siteId: SEED_SITE_ID,
          consumer: dependency.description.consumer,
        }),
      ).toBeDefined();
    } finally {
      database.close();
    }
  });
  it("does not trust a copied reader time even with a matching fabricated key", async () => {
    const database = fixture();
    try {
      const { dependency } = await prepare(database);
      const description = {
        ...dependency.description,
        outputs: dependency.description.outputs.map((output) => ({
          ...output,
          queryTime: {
            ...output.queryTime,
            range: {
              ...output.queryTime.range,
              startMs: (output.queryTime.range.startMs +
                1) as typeof output.queryTime.range.startMs,
            },
          },
        })),
      };
      const changed = {
        ...dependency,
        description,
        consumerKey: { operation: "referrers-summary", topN: 10, description },
      };
      expect(() =>
        bindWholeFilterReader({
          dependency: changed,
          siteId: SEED_SITE_ID,
          consumer: dependency.description.consumer,
        }),
      ).toThrow(
        "invalid_semantic_scoped_source_selection:prepared_time_mismatch",
      );
      expect(
        bindWholeFilterReader({
          dependency,
          siteId: SEED_SITE_ID,
          consumer: dependency.description.consumer,
        }),
      ).toBeDefined();
    } finally {
      database.close();
    }
  });

  it.each(["session", "visitor"] as const)(
    "%s executes the declared preparation and binds a frozen entity-dependent report",
    async (scope) => {
      const database = fixture();
      try {
        const actual = await execute(database, scope);
        expect(actual.result).toEqual(
          (await execute(database, scope, FILTER, true)).result,
        );
        expect(actual.bridgeCalls).toBe(0);
        expect(actual.coreCalls).toBe(0);
        expect(actual.bindings).toHaveLength(1);
        const input = actual.bindings[0]![0];
        expect(Object.isFrozen(input.plan)).toBe(true);
        expect(
          input.plan.nodes
            .filter((node) => node.kind === "source")
            .every(
              (node) =>
                node.selection?.qualificationDependencyRefs?.[0] ===
                  "event-filter-entity-membership-v1" &&
                node.selection?.preparedMembership === undefined,
            ),
        ).toBe(true);
        expect(actual.diagnostics.advancedFilterExecution).toMatchObject({
          strategy: "sql-membership",
          membership: {
            identity: { grain: scope },
            expressionDomain: "filter",
          },
        });
      } finally {
        database.close();
      }
    },
  );
  it.each(["'invalid-duration'", "x'6162'"])(
    "runtime numeric storage %s delegates the complete original filter to Core",
    async (storage) => {
      const database = fixture();
      try {
        database.exec(
          `UPDATE visits SET duration_ms=${storage} WHERE visit_id='v100'`,
        );
        const dsl =
          "count(page { page.durationMs gt 5 }) gte 1 and time gte @range.start+1d";
        const actual = await execute(database, "session", dsl);
        expect(actual.result).toEqual(
          (await execute(database, "session", dsl, true)).result,
        );
        expect(actual.coreCalls).toBe(1);
        expect(actual.bridgeCalls).toBe(0);
        expect(actual.bindings).toHaveLength(1);
        expect(actual.diagnostics.advancedCountSqlFallbackReason).toMatchObject(
          { kind: "numeric-data-domain", fieldIds: ["page.durationMs"] },
        );
        expect(actual.diagnostics.advancedFilterExecution).toMatchObject({
          strategy: "bounded-core",
          reason: "sql-runtime-numeric-data-domain",
        });
      } finally {
        database.close();
      }
    },
  );
  it.each(["session", "visitor"] as const)(
    "%s keeps an AND bare-field witness in its independent expression domain",
    async (scope) => {
      const database = fixture(3);
      try {
        const start = COST_TIME.range.startMs,
          end = COST_TIME.range.endExclusiveMs,
          witness = end + 1000;
        database.exec(
          "DELETE FROM custom_events; DELETE FROM visits WHERE visit_id NOT IN ('v0','v1')",
        );
        database
          .prepare(
            "UPDATE visits SET visitor_id='independent-visitor',session_id='independent-session',started_at=?,last_activity_at=?,pathname='/candidate' WHERE visit_id='v0'",
          )
          .run(start + 1000, start + 1000);
        database
          .prepare(
            "UPDATE visits SET visitor_id='independent-visitor',session_id='independent-session',started_at=?,last_activity_at=?,pathname='/witness' WHERE visit_id='v1'",
          )
          .run(witness, witness);
        const dsl =
          'time gte @range.end and page.path eq "/witness" and count(page) gt 0';
        const actual = await execute(database, scope, dsl);
        expect(actual.result).toEqual(
          (await execute(database, scope, dsl, true)).result,
        );
        expect(actual.result).toMatchObject({
          ok: true,
          data: { totalViews: 1 },
        });
        expect(actual.bridgeCalls).toBe(0);
        expect(actual.coreCalls).toBe(0);
        // Moving the field onto candidate report rows would silently change 1 to 0.
        expect(
          database
            .prepare(
              "SELECT COUNT(*) AS n FROM visits WHERE started_at>=? AND started_at<? AND pathname='/witness'",
            )
            .get(start, end),
        ).toMatchObject({ n: 0 });
      } finally {
        database.close();
      }
    },
  );
  it("rejects changed hidden scoped metadata and cloned requests before using the dependency", async () => {
    const database = fixture();
    const execution = vi.spyOn(wholeExecutor, "evaluateWholeFilterMembership");
    try {
      const { forwarded, dependency } = await prepare(database);
      expect(dependency).toBeDefined();
      expect(
        referrersTimeMembershipDependencyFromQuery({ ...forwarded }),
      ).toBeUndefined();
      expect(
        scopedFilterMetadata(execution.mock.calls.at(-1)![0].filters),
      ).toBeUndefined();
      expect(execution.mock.calls.at(-1)![0].plan).toBe(dependency.scopePlan);
      expect(scopedFilterMetadata(dependency.filters)).toMatchObject({
        plan: dependency.scopePlan,
        time: dependency.queryTime,
      });
      const metadata = scopedFilterMetadata(dependency.filters)!;
      Object.defineProperty(metadata.plan, "scope", { value: "visitor" });
      expect(() =>
        referrersTimeMembershipDependencyFromQuery(forwarded),
      ).toThrow("referrers_time_membership_request_changed");
    } finally {
      execution.mockRestore();
      database.close();
    }
  });
  it("rejects another consumer, cloned preparation and replay while preserving one valid frozen owner bind", async () => {
    const database = fixture();
    try {
      const first = (await prepare(database, 10)).dependency;
      const other = (await prepare(database, 11)).dependency;
      expect(() => bind(first, other.consumerKey)).toThrow(
        "qualification_execution_plan_snapshot_mismatch",
      );
      expect(() =>
        bind(first, first.consumerKey, { ...first.preparation }),
      ).toThrow("qualification_execution_preparation_untrusted");
      expect(bind(first)).toBeDefined();
      expect(() => bind(first)).toThrow(
        "qualification_execution_preparation_replayed",
      );
    } finally {
      database.close();
    }
  });
  it("preserves the activity cap before invalid numeric runtime storage and report binding", async () => {
    const database = fixture(16000);
    try {
      database.exec(
        "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='v8000'",
      );
      const dsl =
        "time gte @range.start+1d and count(page { page.durationMs gt 5 }) gte 1";
      const actual = await execute(database, "session", dsl);
      expect(actual.result).toEqual(
        (await execute(database, "session", dsl, true)).result,
      );
      expect(actual.result).toMatchObject({
        ok: false,
        error: {
          kind: "invalid-input",
          issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
        },
      });
      expect(actual.bindings).toHaveLength(0);
      expect(actual.bridgeCalls).toBe(0);
    } finally {
      database.close();
    }
  });
  it("keeps an empty filter domain on the existing complete fallback", async () => {
    const database = fixture();
    try {
      const dsl =
        "count(page) gt 0 and time gte @range.end+1ms and time lt @range.end";
      const actual = await execute(database, "session", dsl);
      expect(actual.result).toEqual(
        (await execute(database, "session", dsl, true)).result,
      );
      // Empty domains decline the Count-time recipe. The current registry now
      // binds the complete whole-filter result; the historical reader used a handle.
      const old = await execute(database, "session", dsl, false, true);
      expect(actual.result).toEqual(old.result);
      expect(old.bridgeCalls).toBe(1);
      expect(old.wholeBindCalls).toBe(0);
      expect(actual.recipeAdmissions).toBe(0);
      expect(actual.bridgeCalls).toBe(0);
      expect(actual.wholeBindCalls).toBe(1);
      expect(actual.bindings).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
