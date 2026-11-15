// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  type CanonicalQuery,
  createQueryTime,
  prepareScopedQuery,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as pagePlan from "@/lib/edge/analytics/engine/page-report-plan";
import * as pageCompletion from "@/lib/edge/analytics/engine/page-whole-original-family";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { createD1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

type Operation =
  | "pages"
  | "referrers"
  | "channels"
  | "radar"
  | "share-trend"
  | "cross-dimension";
type Cell = {
  key: string;
  operation: Operation;
  fields: Record<string, unknown>;
  page2?: boolean;
};
const cells: readonly Cell[] = [
  {
    key: "Page list and cursor",
    operation: "pages",
    fields: {
      variant: "list",
      includeDetails: true,
      page: { limit: 2, cursor: null },
    },
    page2: true,
  },
  {
    key: "Page tabs",
    operation: "pages",
    fields: { variant: "tabs", limit: 2 },
  },
  {
    key: "Page list with tabs",
    operation: "pages",
    fields: {
      variant: "list",
      includeTabs: true,
      includeDetails: true,
      page: { limit: 2, cursor: null },
    },
  },
  {
    key: "Referrer summary",
    operation: "referrers",
    fields: { variant: "summary", topN: 2, limit: 2, includeFullUrl: false },
  },
  {
    key: "Referrer list and cursor",
    operation: "referrers",
    fields: {
      variant: "list",
      limit: 2,
      includeFullUrl: false,
      page: { limit: 2, cursor: null },
    },
    page2: true,
  },
  {
    key: "Channel list",
    operation: "channels",
    fields: { mode: "list", limit: 2 },
  },
  { key: "Browser radar", operation: "radar", fields: { variant: "browser" } },
  {
    key: "Browser version",
    operation: "radar",
    fields: { variant: "version", browserLimit: 2, versionLimit: 1 },
  },
  {
    key: "Browser share",
    operation: "share-trend",
    fields: { variant: "browser", interval: "day", limit: 1 },
  },
  {
    key: "Referrer and channel share",
    operation: "share-trend",
    fields: { variant: "referrer-channel", interval: "day", limit: 1 },
  },
  {
    key: "Client cross",
    operation: "cross-dimension",
    fields: {
      primaryDimension: "browser",
      secondaryDimension: "operatingSystem",
      primaryLimit: 2,
      secondaryLimit: 2,
    },
  },
];
const fixture = buildJourneyEventFieldsCostFixture(24);
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const whole =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const count = 'count(event { event.name eq "qualifier" }) gt 0';
interface Options {
  legacy?: boolean;
  dsl?: string;
  mutation?: "root-null" | "root-native";
  coreError?: Error;
  badCursor?: boolean;
}
function nextCursor(result: unknown): unknown {
  if (!result || typeof result !== "object") return;
  const value = Reflect.get(result, "value");
  if (!value || typeof value !== "object") return;
  const pagination = Reflect.get(value, "pagination");
  return pagination && typeof pagination === "object"
    ? Reflect.get(pagination, "nextCursor")
    : undefined;
}
async function execute(
  cell: Cell,
  scope: "session" | "visitor",
  options: Options = {},
) {
  const db = createMigratedDatabase();
  for (const sql of fixture.seed) db.exec(sql);
  db.exec(
    "UPDATE visits SET title='Title '||pathname,query_string=CASE WHEN visit_id IN ('v0','v1') THEN '?q=1' ELSE '' END,browser_version=CASE WHEN visit_id IN ('v0','v1','v2') THEN '120.0' ELSE '121.0' END",
  );
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] },
    events: string[] = [],
    diagnostics = createD1ReadDiagnostics(),
    abort = new AbortController();
  const env = {
    DB: createSqliteD1Database(db, trace),
    MAIN_SECRET: "page-whole-original-native-test",
  } as unknown as Env;
  const q = prepareScopedQuery(cell.operation, {
    ...cell.fields,
    ...(options.badCursor
      ? { page: { limit: 2, cursor: "invalid-cursor" } }
      : {}),
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time,
    scopePreference: scope,
    filters: parseFilterDsl(options.dsl ?? whole, analyticsFilterRegistry),
  });
  const actualCore = core.evaluateFilterDocument,
    actualRegister = bridge.registerPreparedMembership,
    actualBuilder = pagePlan.buildPagesPagePlan;
  const legacy = options.legacy
    ? vi
        .spyOn(pageCompletion, "pageWholeOriginalFamilyFromQuery")
        .mockReturnValue(undefined)
    : undefined;
  const register = vi
    .spyOn(bridge, "registerPreparedMembership")
    .mockImplementation((...args) => {
      events.push("register");
      return actualRegister(...args);
    });
  const evaluate = vi
    .spyOn(core, "evaluateFilterDocument")
    .mockImplementation((...args) => {
      events.push("Core");
      if (options.coreError) {
        abort.abort();
        throw options.coreError;
      }
      const result = actualCore(...args);
      if (options.mutation)
        Object.assign(q.filters, {
          root:
            options.mutation === "root-null"
              ? null
              : parseFilterDsl(
                  'page.path eq "/excluded"',
                  analyticsFilterRegistry,
                ).root,
        });
      queueMicrotask(() => events.push("Core-reaction"));
      return result;
    });
  const builder = vi
    .spyOn(pagePlan, "buildPagesPagePlan")
    .mockImplementation((...args) => {
      events.push("Page-builder");
      return actualBuilder(...args);
    });
  try {
    const registry = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
      diagnostics,
    });
    // This is a forced legacy fallback contract, not a historical-source oracle.
    // Retain the actual providers/middleware and signal while using the base
    // dispatcher so the newer D1 Program cannot replace the declined family.
    const provider = (
      options.legacy
        ? AnalyticsProviderRegistry.prototype.resolve.call(
            registry,
            cell.operation,
          )
        : registry.resolve(cell.operation)
    )!;
    let result: unknown, page2: unknown, error: unknown;
    try {
      result = await provider.execute(q as CanonicalQuery<Operation>, {
        signal: abort.signal,
      });
      if (cell.page2 && !options.coreError && !options.badCursor) {
        const cursor = nextCursor(result);
        expect(typeof cursor).toBe("string");
        page2 = await provider.execute(
          { ...q, page: { limit: 2, cursor } } as CanonicalQuery<Operation>,
          { signal: abort.signal },
        );
      }
    } catch (e) {
      error = e;
    }
    return {
      result,
      page2,
      error,
      events,
      coreCalls: evaluate.mock.calls.length,
      bridgeCalls: register.mock.calls.length,
      signalAborted: abort.signal.aborted,
      diagnostics,
      sql: trace.preparedSql.map((sql, index) => ({
        sql,
        params: trace.bindings[index],
      })),
    };
  } finally {
    builder.mockRestore();
    evaluate.mockRestore();
    register.mockRestore();
    legacy?.mockRestore();
    db.close();
  }
}
function expectSame(
  actual: Awaited<ReturnType<typeof execute>>,
  old: Awaited<ReturnType<typeof execute>>,
) {
  expect(actual.result).toEqual(old.result);
  expect(actual.page2).toEqual(old.page2);
  expect(actual.sql).toEqual(old.sql);
  expect(actual.diagnostics).toEqual(old.diagnostics);
  expect(actual.coreCalls).toBe(old.coreCalls);
  expect(actual.signalAborted).toBe(old.signalAborted);
  expect(actual.events).toEqual(old.events.filter((e) => e !== "register"));
}
for (const scope of ["session", "visitor"] as const)
  it.each(cells)(
    "$key preserves complete DTO, cursor, SQL and params for " + scope,
    async (cell) => {
      const old = await execute(cell, scope, { legacy: true }),
        actual = await execute(cell, scope);
      expect(old.error).toBeUndefined();
      expect(actual.error).toBeUndefined();
      expectSame(actual, old);
      expect(old.bridgeCalls).toBe(cell.page2 ? 2 : 1);
      expect(actual.bridgeCalls).toBe(0);
      expect(actual.coreCalls).toBe(cell.page2 ? 2 : 1);
    },
  );
for (const scope of ["session", "visitor"] as const)
  it.each([cells[0]!, cells[3]!, cells[6]!])(
    "$key keeps existing Count qualification first for " + scope,
    async (cell) => {
      const testCell = { ...cell, page2: false },
        old = await execute(testCell, scope, { legacy: true, dsl: count }),
        actual = await execute(testCell, scope, { dsl: count });
      expect(old.error).toBeUndefined();
      expect(actual.error).toBeUndefined();
      expectSame(actual, old);
      expect(actual.bridgeCalls).toBe(0);
      expect(old.bridgeCalls).toBe(0);
      expect(actual.coreCalls).toBe(0);
    },
  );
it.each(["root-null", "root-native"] as const)(
  "keeps the old successful %s mutation and captured reader filters",
  async (mutation) => {
    const cell = { ...cells[0]!, page2: false },
      old = await execute(cell, "session", { legacy: true, mutation }),
      actual = await execute(cell, "session", { mutation });
    expect(old.error).toBeUndefined();
    expect(actual.error).toBeUndefined();
    expectSame(actual, old);
    expect(old.bridgeCalls).toBe(1);
    expect(actual.bridgeCalls).toBe(0);
  },
);
it("keeps original Core error identity before bad cursor and abort processing", async () => {
  const marker = new Error("original Page Core error");
  for (const legacy of [true, false]) {
    const result = await execute({ ...cells[0]!, page2: false }, "session", {
      legacy,
      coreError: marker,
      badCursor: true,
    });
    expect(result.error).toBe(marker);
    expect(result.signalAborted).toBe(true);
    expect(result.bridgeCalls).toBe(0);
    expect(result.sql.length).toBeGreaterThan(0);
    expect(result.events).not.toContain("Page-builder");
  }
});
it("keeps the genuine Core reaction before the existing canonical Page builder checkpoint", async () => {
  const result = await execute({ ...cells[0]!, page2: false }, "session");
  expect(result.error).toBeUndefined();
  expect(result.events).toEqual(["Core", "Core-reaction", "Page-builder"]);
  expect(result.bridgeCalls).toBe(0);
});
