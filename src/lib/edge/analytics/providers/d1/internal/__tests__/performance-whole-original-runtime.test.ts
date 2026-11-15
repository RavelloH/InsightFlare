// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  attachScopedFilterMetadata,
  type CanonicalQuery,
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as pageCompletion from "@/lib/edge/analytics/engine/page-whole-original-family";
import * as pagePlan from "@/lib/edge/analytics/engine/performance-sample-statistics-report-plan";
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

type Operation = "performance";
type Cell = {
  key: string;
  operation: Operation;
  fields: Record<string, unknown>;
  page2?: boolean;
};
const cells: readonly Cell[] = [
  {
    key: "Performance summary",
    operation: "performance",
    fields: { mode: "summary" },
  },
  {
    key: "Performance all trends",
    operation: "performance",
    fields: { mode: "timeseries", interval: "day" },
  },
  {
    key: "Performance routes",
    operation: "performance",
    fields: {
      mode: "breakdown",
      dimension: "page.path",
      metric: "lcp",
      limit: 2,
    },
  },
  {
    key: "Performance countries",
    operation: "performance",
    fields: {
      mode: "breakdown",
      dimension: "geo.country",
      metric: "lcp",
      limit: 2,
    },
  },
  {
    key: "Performance dashboard",
    operation: "performance",
    fields: { mode: "dashboard", interval: "day", limit: 2 },
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
const candidateRoute = true;
interface Options {
  timeMode?: "empty" | "fullHistory" | "independent";
  legacy?: boolean;
  dsl?: string;
  mutation?: "root-null" | "root-native";
  coreError?: Error;
}
async function execute(
  cell: Cell,
  scope: "session" | "visitor",
  options: Options = {},
) {
  const db = createMigratedDatabase();
  for (const sql of fixture.seed) db.exec(sql);
  db.exec(
    "UPDATE visits SET title='Title '||pathname,query_string=CASE WHEN visit_id IN ('v0','v1') THEN '?q=1' ELSE '' END,browser_version=CASE WHEN visit_id IN ('v0','v1','v2') THEN '120.0' ELSE '121.0' END, perf_ttfb_ms=0, perf_fcp_ms=10, perf_lcp_ms=100 + rowid, perf_cls=0.1, perf_inp_ms=30, country=CASE WHEN rowid % 2 = 0 THEN 'US' ELSE 'CA' END",
  );
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] },
    events: string[] = [],
    diagnostics = createD1ReadDiagnostics(),
    abort = new AbortController();
  const env = {
    DB: createSqliteD1Database(db, trace),
    MAIN_SECRET: "page-whole-original-native-test",
  } as unknown as Env;
  const q0 = prepareScopedQuery(cell.operation, {
    ...cell.fields,
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time,
    scopePreference: scope,
    filters: parseFilterDsl(options.dsl ?? whole, analyticsFilterRegistry),
  });
  const plannedTime = q0.time;
  const requestTime =
    options.timeMode === "empty"
      ? { ...plannedTime, filterRangeEmpty: true }
      : options.timeMode === "fullHistory"
        ? { ...plannedTime, fullHistory: true }
        : options.timeMode === "independent"
          ? {
              ...plannedTime,
              filterRange: {
                startMs: time.range.startMs + 1,
                endExclusiveMs: time.range.endExclusiveMs,
              },
            }
          : plannedTime;
  const q = options.timeMode
    ? {
        ...q0,
        time: requestTime,
        filters: attachScopedFilterMetadata(q0.filters!, {
          ...scopedFilterMetadata(q0.filters)!,
          time: requestTime,
        }),
      }
    : q0;
  const actualCore = core.evaluateFilterDocument,
    actualRegister = bridge.registerPreparedMembership,
    actualBuilder = pagePlan.buildPerformanceSummariesPlan;
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
    .spyOn(pagePlan, "buildPerformanceSummariesPlan")
    .mockImplementation((...args) => {
      events.push("Performance-builder");
      return actualBuilder(...args);
    });
  try {
    const provider = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
      diagnostics,
    }).resolve(cell.operation)!;
    let result: unknown, error: unknown;
    try {
      result = await provider.execute(q as CanonicalQuery<Operation>, {
        signal: abort.signal,
      });
    } catch (e) {
      error = e;
    }
    const value = {
      result,
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
    return value;
  } finally {
    builder.mockRestore();
    evaluate.mockRestore();
    register.mockRestore();
    legacy?.mockRestore();
    db.close();
  }
}
function hasPositiveSamples(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.entries(value).some(
      ([key, item]) =>
        (key === "samples" && typeof item === "number" && item > 0) ||
        hasPositiveSamples(item),
    )
  );
}
function expectSame(
  actual: Awaited<ReturnType<typeof execute>>,
  old: Awaited<ReturnType<typeof execute>>,
) {
  expect(actual.result).toEqual(old.result);
  expect(actual.sql).toEqual(old.sql);
  expect(actual.diagnostics).toEqual(old.diagnostics);
  expect(actual.coreCalls).toBe(old.coreCalls);
  expect(actual.signalAborted).toBe(old.signalAborted);
  expect(
    actual.events.filter((e) => candidateRoute || e !== "register"),
  ).toEqual(old.events.filter((e) => e !== "register"));
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
      expect(hasPositiveSamples(actual.result)).toBe(true);
      expect(old.bridgeCalls).toBe(1);
      expect(actual.bridgeCalls).toBe(candidateRoute ? 0 : 1);
      expect(actual.coreCalls).toBe(1);
    },
  );
for (const scope of ["session", "visitor"] as const)
  it.each([cells[0]!, cells[1]!, cells[4]!])(
    "$key keeps existing Count qualification first for " + scope,
    async (cell) => {
      const testCell = { ...cell },
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
    const cell = { ...cells[0]! },
      old = await execute(cell, "session", { legacy: true, mutation }),
      actual = await execute(cell, "session", { mutation });
    expect(old.error).toBeUndefined();
    expect(actual.error).toBeUndefined();
    expectSame(actual, old);
    expect(old.bridgeCalls).toBe(1);
    expect(actual.bridgeCalls).toBe(candidateRoute ? 0 : 1);
  },
);
it("keeps original Core error identity before abort processing", async () => {
  const marker = new Error("original Performance Core error");
  for (const legacy of [true, false]) {
    const result = await execute({ ...cells[0]! }, "session", {
      legacy,
      coreError: marker,
    });
    expect(result.error).toBe(marker);
    expect(result.signalAborted).toBe(true);
    expect(result.bridgeCalls).toBe(0);
    expect(result.sql.length).toBeGreaterThan(0);
    expect(result.events).not.toContain("Performance-builder");
  }
});
it("keeps the genuine Core reaction before the existing canonical Performance builder checkpoint", async () => {
  const result = await execute({ ...cells[0]! }, "session");
  expect(result.error).toBeUndefined();
  expect(result.events.filter((e) => e !== "register")).toEqual([
    "Core",
    "Core-reaction",
    "Performance-builder",
  ]);
  expect(result.bridgeCalls).toBe(candidateRoute ? 0 : 1);
});

it.each(["session", "visitor"] as const)(
  "retains breakdown validation and whole-filter error order for %s",
  async (scope) => {
    const invalid = {
      ...cells[2]!,
      fields: { ...cells[2]!.fields, dimension: "event.name" },
    };
    const old = await execute(invalid, scope, { legacy: true }),
      actual = await execute(invalid, scope);
    expect(old.error).toBeInstanceOf(Error);
    expect((old.error as Error).message).toBe("unsupported-dimension");
    expect((actual.error as Error).message).toBe("unsupported-dimension");
    expectSame(actual, old);
    expect(old.bridgeCalls).toBe(1);
    expect(actual.bridgeCalls).toBe(candidateRoute ? 0 : 1);
    const marker = new Error("Core precedes invalid dimension");
    for (const legacy of [true, false])
      expect(
        (await execute(invalid, scope, { legacy, coreError: marker })).error,
      ).toBe(marker);
  },
);

for (const scope of ["session", "visitor"] as const)
  it.each(["empty", "fullHistory", "independent"] as const)(
    "preserves original reader/preparation time and %s controls for " + scope,
    async (timeMode) => {
      const old = await execute(cells[0]!, scope, { legacy: true, timeMode }),
        actual = await execute(cells[0]!, scope, { timeMode });
      expect(old.error).toBeUndefined();
      expect(actual.error).toBeUndefined();
      expectSame(actual, old);
      expect(actual.bridgeCalls).toBe(candidateRoute ? 0 : old.bridgeCalls);
    },
  );
