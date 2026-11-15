import { createHash } from "node:crypto";

import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteQueryRuntime } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  type QueryTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as classifier from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import * as wholeFamily from "@/lib/edge/analytics/engine/page-whole-original-family";
import * as recipe from "@/lib/edge/analytics/engine/referrers-page-membership-dependency-plan";
import { observeCostDatabase } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/referrers-cost-harness";
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
import * as reader from "@/lib/edge/analytics/providers/d1/internal/referrers";
import * as wholeReader from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

const shapes = [
  { name: "default" },
  { name: "full URL", includeFullUrl: true },
  { name: "search", search: "com" },
  { name: "visitors ascending", sort: "visitors", direction: "asc" },
];
const dsl = (source: string) => parseFilterDsl(source, analyticsFilterRegistry);
function input(
  scope: "session" | "visitor" = "session",
  shape = shapes[0]!,
  cursor?: string,
) {
  const { name: _name, ...configuration } = shape;
  return {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: createQueryTime(
      SEED_BASE_MS + 3 * SEED_DAY_MS,
      SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
      "UTC",
      SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
    ),
    scopePreference: scope,
    filters: dsl(
      "count(page { page.durationMs gt 5 }) gte 1 and time gte @range.start+1d",
    ),
    ...configuration,
    page: { limit: 2, ...(cursor ? { cursor } : {}) },
  };
}
type Request = ReturnType<typeof input>;
function fixture(visits = 200) {
  const database = createMigratedDatabase();
  for (const sql of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits }),
  ])
    database.exec(sql);
  return database;
}
async function execute(
  database: ReturnType<typeof fixture>,
  query: Request,
  route: "current" | "old" | "core" = "current",
) {
  const cost = observeCostDatabase(createSqliteD1Database(database)),
    diagnostics = createD1ReadDiagnostics(),
    errors: string[] = [];
  const core = vi.spyOn(evaluator, "evaluateFilterDocument"),
    register = vi.spyOn(prepared, "registerPreparedMembership"),
    resolve = vi.spyOn(prepared, "resolvePreparedMembership"),
    bind = vi.spyOn(binding, "bindPageVisitQualificationPreparation");
  const currentRecipe =
    route === "current"
      ? vi.spyOn(recipe, "planReferrersPageMembershipDependencies")
      : undefined;
  const wholeBind = vi.spyOn(wholeReader, "bindWholeOriginalReader");
  const old =
    route === "old"
      ? vi
          .spyOn(recipe, "planReferrersPageMembershipDependencies")
          .mockReturnValue(undefined)
      : undefined;
  // The legacy and Core oracles intentionally bypass both newer relation routes.
  // Current whole-filter admission is exercised by its dedicated runtime suite.
  const legacyWhole =
    route !== "current"
      ? vi
          .spyOn(wholeFamily, "pageWholeOriginalFamilyFromQuery")
          .mockReturnValue(undefined)
      : undefined;
  const force =
    route === "core"
      ? vi.spyOn(classifier, "classifyAdvancedCountFilter").mockReturnValue({
          kind: "unsupported",
          code: "independent-core-oracle",
          path: "root",
          reason: "Whole original Core oracle",
        })
      : undefined;
  try {
    const result = await createD1SiteQueryRuntime({
      env: {
        DB: cost.database,
        MAIN_SECRET: "referrers-page-membership-test",
      } as Env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).execute("referrers", query as never, {
      onProviderError(error) {
        errors.push(String(error));
      },
    });
    return {
      result,
      errors,
      diagnostics,
      coreCalls: core.mock.calls.length,
      coreDomains: core.mock.calls.map(([, , options]) => options),
      registerCalls: register.mock.calls.length,
      recipeAdmissions:
        currentRecipe?.mock.results.filter(
          (result) => result.type === "return" && result.value !== undefined,
        ).length ?? 0,
      wholeBindCalls: wholeBind.mock.calls.length,
      resolveCalls: resolve.mock.calls.length,
      bindCalls: bind.mock.calls.length,
      sql: cost.observations.map((statement) => [
        statement.sql,
        statement.params,
      ]),
      fingerprint: createHash("sha256")
        .update(JSON.stringify(query))
        .digest("hex"),
    };
  } finally {
    wholeBind.mockRestore();
    currentRecipe?.mockRestore();
    legacyWhole?.mockRestore();
    force?.mockRestore();
    old?.mockRestore();
    core.mockRestore();
    register.mockRestore();
    resolve.mockRestore();
    bind.mockRestore();
  }
}
async function prepare(database: ReturnType<typeof fixture>) {
  const query = prepareScopedQuery("referrers", input() as never);
  const output = await afe.d1AdvancedFilterMiddleware(
    { DB: createSqliteD1Database(database) } as Env,
    undefined,
    SEED_SITE_ID,
  )("referrers", query, async (value) => value);
  return output as typeof query;
}
const configuration = () => ({
  limit: 2,
  includeFullUrl: false,
  search: undefined,
  cursor: null,
  audience: "private-dashboard" as const,
  sortBy: "views" as const,
  sortDirection: "desc" as const,
});

it.each(
  shapes.flatMap((shape) =>
    (["session", "visitor"] as const).map((scope) => ({ shape, scope })),
  ),
)(
  "keeps $shape.name $scope full DTO, original SQL/parameters and actual second cursor",
  async ({ shape, scope }) => {
    const database = fixture();
    try {
      let cursor: string | undefined;
      for (const page of [1, 2]) {
        const query = input(scope, shape, cursor),
          current = await execute(database, query),
          old = await execute(database, query, "old"),
          core = await execute(database, query, "core");
        expect(current.result).toEqual(old.result);
        expect(current.result).toEqual(core.result);
        expect(current.result.ok).toBe(true);
        expect(current.sql).toEqual(old.sql);
        expect(current.sql).toHaveLength(4);
        expect(current.fingerprint).toBe(old.fingerprint);
        expect(current.registerCalls).toBe(0);
        expect(current.resolveCalls).toBe(0);
        expect(current.bindCalls).toBe(1);
        expect(current.coreCalls).toBe(0);
        expect(old.registerCalls).toBe(1);
        expect(old.resolveCalls).toBe(1);
        expect(old.bindCalls).toBe(0);
        const data = current.result.ok
          ? (current.result.data as {
              pagination: { nextCursor: string | null };
            })
          : undefined;
        cursor = data?.pagination.nextCursor ?? undefined;
        if (page === 1) expect(cursor).toBeTruthy();
      }
    } finally {
      database.close();
    }
  },
);
it.each(["session", "visitor"] as const)(
  "retains %s whole-Core numeric fallback and original domains without a legacy registration",
  async (scope) => {
    const database = fixture();
    database.exec("UPDATE visits SET duration_ms='invalid-duration'");
    try {
      const query = input(scope),
        current = await execute(database, query),
        old = await execute(database, query, "old"),
        core = await execute(database, query, "core");
      expect(current.result).toEqual(old.result);
      expect(current.result).toEqual(core.result);
      expect(current.result.ok).toBe(true);
      expect(current.sql).toEqual(old.sql);
      expect(current.coreCalls).toBe(1);
      expect(current.coreDomains).toEqual(old.coreDomains);
      expect(current.coreDomains).toEqual(core.coreDomains);
      expect(current.registerCalls).toBe(0);
      expect(current.resolveCalls).toBe(0);
      expect(current.bindCalls).toBe(1);
      expect(
        current.diagnostics.advancedFilterExecutionHistory?.at(-1),
      ).toMatchObject({ strategy: "bounded-core" });
    } finally {
      database.close();
    }
  },
);
it.each([
  {
    name: "empty filter range",
    override: {
      filters: dsl(
        "count(page) gt 0 and time gte @range.end+1ms and time lt @range.end",
      ),
    },
  },
  {
    name: "full history",
    override: {
      filters: dsl(
        "count(page) gt 0 and time gte @range.start+1d and sequence([page,event]) exists",
      ),
    },
  },
  {
    name: "unsupported whole tree",
    override: {
      filters: dsl(
        "count(page) gt 0 and time gte @range.start+1d and sequence([window(page,@range.start,[0ms,99ms]),window(event,@range.start,[0ms,99ms])]) exists",
      ),
    },
  },
  {
    name: "API",
    override: { context: siteQueryContext(SEED_SITE_ID, "api-v1") },
  },
  {
    name: "public",
    override: { context: siteQueryContext(SEED_SITE_ID, "public-share") },
  },
  { name: "event scope", override: { scopePreference: "event" } },
  { name: "definition context", override: { goalId: "missing-goal" } },
])(
  "preserves $name old route without granting Page recipe admission",
  async ({ name, override }) => {
    const database = fixture();
    try {
      const query = { ...input(), ...override } as Request,
        current = await execute(database, query),
        old = await execute(database, query, "old"),
        core = await execute(database, query, "core");
      expect(current.result).toEqual(old.result);
      expect(current.result).toEqual(core.result);
      expect(current.sql).toEqual(old.sql);
      expect(current.recipeAdmissions).toBe(0);
      expect(old.wholeBindCalls).toBe(0);
      // Existing private S/V whole-original fallback is independent of the
      // rejected Count recipe; public/API/event-scope cases remain unadmitted.
      const wholeFallback = [
        "empty filter range",
        "full history",
        "unsupported whole tree",
        "definition context",
      ].includes(name);
      expect(current.wholeBindCalls).toBe(wholeFallback ? 1 : 0);
      // Only an empty filter window still prepares the old Page visit
      // preparation; every other whole fallback runs in the actual Program and
      // neither prepares it nor registers an old membership (the old route does).
      expect(current.bindCalls).toBe(name === "empty filter range" ? 1 : 0);
      if (wholeFallback) {
        expect(old.registerCalls).toBe(1);
        expect(current.registerCalls).toBe(0);
      }
    } finally {
      database.close();
    }
  },
);
it("preserves the existing payload SQL failure without claiming Core parity or new admission", async () => {
  const database = fixture();
  try {
    const query = {
        ...input(),
        filters: dsl(
          'count(event { event.payload("/value") eq "paid" }) gte 1 and time gte @range.start+1d',
        ),
      },
      current = await execute(database, query),
      old = await execute(database, query, "old"),
      core = await execute(database, query, "core");
    // The legacy Count SQL plan currently rejects this payload property. This reader slice preserves that boundary.
    expect(current.result).toEqual(old.result);
    expect(current.sql).toEqual(old.sql);
    expect(current.result).toMatchObject({
      ok: false,
      error: { kind: "internal" },
    });
    expect(current.errors).toContain(
      "Error: advanced_count_plan_missing_payload_property",
    );
    expect(core.result.ok).toBe(true);
    expect(current.bindCalls).toBe(0);
  } finally {
    database.close();
  }
});
it("rejects clones, replay, cross-reader configuration and hidden metadata/domain mutations", async () => {
  const database = fixture();
  try {
    const output = await prepare(database);
    expect(afe.hasIndependentReferrersPageMembershipDependency(output)).toBe(
      true,
    );
    expect(
      afe.hasIndependentReferrersPageMembershipDependency({ ...output }),
    ).toBe(false);
    for (const wrong of [
      { ...configuration(), limit: 3 },
      { ...configuration(), audience: "api-v1" as const },
      { ...configuration(), sortDirection: "asc" as const },
      {
        ...configuration(),
        cursor: { primary: 1, secondary: 2, referrer: "x", extra: 1 },
      },
    ])
      expect(() =>
        afe.claimIndependentReferrersPageMembershipDependency(output, wrong),
      ).toThrow("referrers_page_membership_reader_mismatch");
    const config = configuration(),
      claimed = afe.claimIndependentReferrersPageMembershipDependency(
        output,
        config,
      )!;
    expect(claimed).toBeDefined();
    expect(() =>
      afe.claimIndependentReferrersPageMembershipDependency(output, config),
    ).toThrow("referrers_page_membership_replayed");
    config.limit = 3;
    expect(() => claimed.assertFresh()).toThrow(
      "referrers_page_membership_reader_mismatch",
    );
    const mutations = [
      (query: typeof output) => {
        const metadata = scopedFilterMetadata(query.filters)!;
        (metadata.plan as { requiresRawSource: boolean }).requiresRawSource =
          !metadata.plan.requiresRawSource;
      },
      (query: typeof output) => {
        (query as unknown as { scopePreference: string }).scopePreference =
          "visitor";
      },
      (query: typeof output) => {
        (query as unknown as { variant: string }).variant = "summary";
      },
      (query: typeof output) => {
        (scopedFilterMetadata(query.filters)!.siteIds as string[])[0] =
          "foreign";
      },
      ...(["range", "readRange", "filterRange"] as const).map(
        (key) => (query: typeof output) => {
          (
            (query as unknown as { time: QueryTime }).time[key]! as {
              startMs: number;
            }
          ).startMs += 1;
        },
      ),
    ];
    for (const mutate of mutations) {
      const query = await prepare(database);
      mutate(query);
      expect(() =>
        afe.hasIndependentReferrersPageMembershipDependency(query),
      ).toThrow("referrers_page_membership_request_changed");
    }
  } finally {
    database.close();
  }
});
it("rejects hidden metadata mutation during the whole qualification await", async () => {
  const database = fixture();
  database.exec("UPDATE visits SET duration_ms='invalid-duration'");
  const query = prepareScopedQuery("referrers", input() as never),
    evaluate = evaluator.evaluateFilterDocument;
  const spy = vi
    .spyOn(evaluator, "evaluateFilterDocument")
    .mockImplementation((...args) => {
      const result = evaluate(...args),
        metadata = scopedFilterMetadata(query.filters)!;
      (metadata.plan as { requiresRawSource: boolean }).requiresRawSource =
        !metadata.plan.requiresRawSource;
      return result;
    });
  try {
    await expect(
      afe.d1AdvancedFilterMiddleware(
        { DB: createSqliteD1Database(database) } as Env,
        undefined,
        SEED_SITE_ID,
      )("referrers", query, async (value) => value),
    ).rejects.toThrow("referrers_page_membership_request_changed");
  } finally {
    spy.mockRestore();
    database.close();
  }
});
it.each(["decode", "report"] as const)(
  "rejects hidden metadata mutation after the %s await",
  async (stage) => {
    const database = fixture();
    let query: unknown;
    const has = afe.hasIndependentReferrersPageMembershipDependency;
    const capture = vi
      .spyOn(afe, "hasIndependentReferrersPageMembershipDependency")
      .mockImplementation((value) => {
        query = value;
        return has(value);
      });
    const mutate = () => {
      const metadata = scopedFilterMetadata(
        (query as { filters: ReturnType<typeof dsl> }).filters,
      )!;
      (metadata.plan as { requiresRawSource: boolean }).requiresRawSource =
        !metadata.plan.requiresRawSource;
    };
    const decode = reader.decodeReferrersCursor,
      report = reader.queryReferrersPageFromD1;
    const spy =
      stage === "decode"
        ? vi
            .spyOn(reader, "decodeReferrersCursor")
            .mockImplementation(async (...args) => {
              const result = await decode(...args);
              mutate();
              return result;
            })
        : vi
            .spyOn(reader, "queryReferrersPageFromD1")
            .mockImplementation(async (...args) => {
              const result = await report(...args);
              mutate();
              return result;
            });
    try {
      const result = await execute(database, input());
      expect(result.result).toMatchObject({ ok: false });
      expect(result.registerCalls).toBe(0);
      expect(result.bindCalls).toBe(stage === "report" ? 1 : 0);
    } finally {
      spy.mockRestore();
      capture.mockRestore();
      database.close();
    }
  },
);
it("preserves the 20k activity cap before a bad cursor and numeric fallback", async () => {
  const database = fixture(16000);
  database.exec(
    "UPDATE visits SET duration_ms='invalid-duration' WHERE visit_id='v8000'",
  );
  const query = {
    ...input(),
    time: createQueryTime(
      SEED_BASE_MS,
      SEED_BASE_MS + SEED_DAY_MS * SEED_DAYS,
      "UTC",
      SEED_BASE_MS + SEED_DAY_MS * (SEED_DAYS + 1),
    ),
    page: { limit: 2, cursor: "bad-cursor" },
  };
  try {
    const current = await execute(database, query),
      old = await execute(database, query, "old"),
      core = await execute(database, query, "core");
    expect(current.result).toEqual(old.result);
    expect(current.result).toEqual(core.result);
    expect(current.result).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-input",
        issues: [{ path: "filters", code: "filter_activity_limit_exceeded" }],
      },
    });
    expect(current.registerCalls).toBe(0);
    expect(current.bindCalls).toBe(0);
  } finally {
    database.close();
  }
}, 60000);
