import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as classifier from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import { comparisonPageReaderContract } from "@/lib/edge/analytics/engine/comparison-page-reader-contract";
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
  tab = "source.domain",
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
    tab,
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

const RECIPE_TABS = [
  "source.domain",
  "source.link",
  "source.channel",
  "client.browser",
  "client.osVersion",
  "client.deviceType",
  "client.language",
  "client.screenSize",
  "utm.source",
  "utm.medium",
  "utm.campaign",
  "utm.term",
  "utm.content",
  "geo.country",
  "geo.region",
  "geo.city",
  "geo.continent",
];
const QUALIFIED_TABS = [
  "page.path",
  "page.query",
  "page.title",
  "page.hostname",
  "geo.timezone",
  "geo.organization",
];
let native: ReturnType<typeof createMigratedDatabase>;
beforeAll(() => {
  native = createMigratedDatabase();
  for (const sql of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: 200 }),
  ])
    native.exec(sql);
  native.exec(
    "UPDATE visits SET query_string='?q='||(rowid%3),title='title-'||(rowid%3),utm_source='source-'||(rowid%3),utm_medium='email',utm_campaign='campaign-'||(rowid%3),utm_term='term-'||(rowid%3),utm_content='content-'||(rowid%3),region='region-'||(rowid%3),region_code='R'||(rowid%3),city='city-'||(rowid%3),continent=CASE rowid%3 WHEN 0 THEN 'AS' WHEN 1 THEN 'EU' ELSE 'NA' END,timezone='UTC',as_organization='org-'||(rowid%3),os_version='version-'||(rowid%3),device_type=CASE rowid%3 WHEN 0 THEN 'desktop' WHEN 1 THEN 'mobile' ELSE 'tablet' END,screen_width=1000+(rowid%3)*100,screen_height=700+(rowid%3)*50,language=CASE rowid%3 WHEN 0 THEN 'en' WHEN 1 THEN 'zh' ELSE 'fr' END",
  );
});
afterAll(() => native.close());
it.each(RECIPE_TABS)(
  "binds independent Count/time Page comparison dependencies for %s",
  async (tab) => {
    expect(comparisonPageReaderContract(tab)?.route).toBe("membership-recipe");
    for (const scope of ["session", "visitor"] as const)
      for (const variant of ["count", "time"]) {
        const input = query(scope, undefined, variant, tab);
        const actual = await execute(createSqliteD1Database(native), input),
          oracle = await execute(createSqliteD1Database(native), input, true);
        expect(actual.result).toEqual(oracle.result);
        expect(actual.result.ok).toBe(true);
        expect(actual.coreCalls).toBe(0);
        expect(actual.bridgeCalls).toBe(0);
        expect(actual.bindCalls).toBe(2);
        expect(oracle.coreCalls).toBeGreaterThan(0);
        expect(actual.statements).toBe(variant === "time" ? 7 : 5);
        expect(actual.boundPlans.map((x) => x.plan.outputs[0]?.id)).toEqual([
          "comparison-current-membership-rollup",
          "comparison-reference-membership-rollup",
        ]);
        expect(
          actual.boundPlans.map(
            (x) => x.plan.nodes.filter((n) => n.kind === "source").length,
          ),
        ).toEqual([1, 1]);
        expect(actual.boundPlans[0]?.time.range).not.toEqual(
          actual.boundPlans[1]?.time.range,
        );
        expect(actual.boundPlans.map((x) => x.readerTime?.range)).toEqual([
          input.current.time.range,
          input.reference.time.range,
        ]);
      }
  },
);
it.each(QUALIFIED_TABS)(
  "preserves the existing qualified comparison route for %s",
  async (tab) => {
    expect(comparisonPageReaderContract(tab)?.route).toBe("existing-qualified");
    for (const scope of ["session", "visitor"] as const)
      for (const variant of ["count", "time"]) {
        const input = query(scope, undefined, variant, tab),
          actual = await execute(createSqliteD1Database(native), input),
          oracle = await execute(createSqliteD1Database(native), input, true);
        expect(actual.result).toEqual(oracle.result);
        expect(actual.result.ok).toBe(true);
        expect(actual.bindCalls).toBe(0);
        expect(actual.bridgeCalls).toBe(variant === "time" ? 2 : 0);
        expect(actual.statements).toBe(variant === "time" ? 7 : 3);
      }
  },
);
it("preserves whole-Core numeric runtime fallback for a new Page reader", async () => {
  native.exec("UPDATE visits SET duration_ms=x'6162' WHERE visit_id='v150'");
  try {
    const input = query("visitor", undefined, "time", "client.language");
    input.current.filters = parseFilterDsl(
      "count(page { page.durationMs gt 5 }) gte 1 and time gte @range.start+1d",
      analyticsFilterRegistry,
    );
    input.comparison.current = input.current;
    const actual = await execute(createSqliteD1Database(native), input),
      oracle = await execute(createSqliteD1Database(native), input, true);
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
    native.exec(
      "UPDATE visits SET duration_ms=1000+((150*977)%90000) WHERE visit_id='v150'",
    );
  }
});
