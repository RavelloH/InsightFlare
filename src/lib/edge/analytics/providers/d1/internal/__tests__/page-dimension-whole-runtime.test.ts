// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as completion from "@/lib/edge/analytics/engine/page-whole-original-family";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as membership from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as evaluator from "@/lib/filter-contract/filter-evaluator";

const fixture = buildJourneyEventFieldsCostFixture(24);
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const selectors = [
  "client.browser",
  "page.path",
  "session.entryPath",
  "session.exitPath",
] as const;
const leaves = [
  { kind: "native", dsl: 'page.path neq "/excluded"', oldBridge: 0, core: 0 },
  {
    kind: "whole Core",
    dsl: 'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"',
    oldBridge: 1,
    core: 1,
  },
  {
    kind: "Count",
    dsl: 'count(event { event.name eq "qualifier" }) gt 0',
    oldBridge: 0,
    core: 0,
  },
  {
    kind: "narrow Seq",
    dsl: 'sequence([window(page { page.path neq "/excluded" },@range.start,[0ms,604799999ms]),window(event { event.name eq "qualifier" },@range.start,[0ms,604799999ms])]) exists',
    oldBridge: 1,
    core: 0,
  },
] as const;

function createFixture() {
  const database = createMigratedDatabase();
  for (const sql of fixture.seed) database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "dimension-whole-native-test",
  } as unknown as Env;
  return { database, env, trace };
}

function nextCursor(result: unknown): string {
  const value =
    result && typeof result === "object"
      ? Reflect.get(result, "value")
      : undefined;
  const pagination =
    value && typeof value === "object"
      ? Reflect.get(value, "pagination")
      : undefined;
  const cursor =
    pagination && typeof pagination === "object"
      ? Reflect.get(pagination, "nextCursor")
      : undefined;
  expect(typeof cursor).toBe("string");
  if (typeof cursor !== "string")
    throw new Error("Expected a real dimension cursor");
  return cursor;
}

async function execute(
  context: ReturnType<typeof createFixture>,
  dimension: (typeof selectors)[number],
  scope: "session" | "visitor",
  leaf: (typeof leaves)[number],
  legacy: boolean,
  page2 = false,
) {
  const { env, trace } = context;
  const start = trace.preparedSql.length;
  const diagnostics = createD1ReadDiagnostics();
  const actualSelector = completion.pageWholeOriginalFamilyFromQuery;
  // Declining only the new Page-dimension selector restores the actual legacy
  // producer and reader. Count/qualified/deferred execution remains real.
  const decline = legacy
    ? vi
        .spyOn(completion, "pageWholeOriginalFamilyFromQuery")
        .mockImplementation((operation, query) =>
          operation === "dimension"
            ? undefined
            : actualSelector(operation, query),
        )
    : undefined;
  const register = vi.spyOn(membership, "registerPreparedMembership");
  const core = vi.spyOn(evaluator, "evaluateFilterDocument");
  try {
    const request = prepareScopedQuery("dimension", {
      mode: "breakdown" as const,
      dimension,
      page: { limit: 2, cursor: null },
      context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
      time,
      scopePreference: scope,
      filters: parseFilterDsl(leaf.dsl, analyticsFilterRegistry),
    });
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).resolve("dimension")!;
    const result = await provider.execute(request, {});
    const second = page2
      ? await provider.execute(
          { ...request, page: { limit: 2, cursor: nextCursor(result) } },
          {},
        )
      : undefined;
    return {
      result,
      second,
      diagnostics,
      coreCalls: core.mock.calls.length,
      bridgeCalls: register.mock.calls.length,
      sql: trace.preparedSql
        .slice(start)
        .map((sql, index) => ({ sql, params: trace.bindings[start + index] })),
    };
  } finally {
    core.mockRestore();
    register.mockRestore();
    decline?.mockRestore();
  }
}

for (const scope of ["session", "visitor"] as const) {
  for (const dimension of selectors) {
    it(`${dimension}/${scope}: preserves native, Count, Seq and Core results and SQL`, async () => {
      const context = createFixture();
      try {
        for (const leaf of leaves) {
          const old = await execute(context, dimension, scope, leaf, true);
          const current = await execute(context, dimension, scope, leaf, false);
          expect(current.result, leaf.kind).toEqual(old.result);
          expect(current.sql, leaf.kind).toEqual(old.sql);
          expect(current.diagnostics, leaf.kind).toEqual(old.diagnostics);
          expect(old.coreCalls, leaf.kind).toBe(leaf.core);
          expect(current.coreCalls, leaf.kind).toBe(old.coreCalls);
          expect(old.bridgeCalls, leaf.kind).toBe(leaf.oldBridge);
          expect(current.bridgeCalls, leaf.kind).toBe(0);
        }
      } finally {
        context.database.close();
      }
    });
  }
  it(`page.path/${scope}: preserves a real second-page cursor and decoded key`, async () => {
    const context = createFixture();
    try {
      const whole = leaves[1];
      const old = await execute(context, "page.path", scope, whole, true, true);
      const current = await execute(
        context,
        "page.path",
        scope,
        whole,
        false,
        true,
      );
      expect(current.result).toEqual(old.result);
      expect(current.second).toEqual(old.second);
      expect(current.sql).toEqual(old.sql);
      expect(current.diagnostics).toEqual(old.diagnostics);
      expect(old.bridgeCalls).toBe(2);
      expect(current.bridgeCalls).toBe(0);
      expect(old.coreCalls).toBe(2);
      expect(current.coreCalls).toBe(old.coreCalls);
    } finally {
      context.database.close();
    }
  });
}
