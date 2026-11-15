// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import {
  buildDataStatements,
  buildSiteStatements,
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type {
  FilterDocument,
  QueryWindow,
} from "@/lib/edge/analytics/providers/d1/internal/core";
import * as reader from "@/lib/edge/analytics/providers/d1/internal/events-summary";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
import { InvalidCursorError } from "@/lib/pagination";

const originalFilter =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const queryTime = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const window: QueryWindow = {
  startMs: queryTime.range.startMs,
  endExclusiveMs: queryTime.range.endExclusiveMs,
  nowMs: queryTime.capturedAtMs,
  timeZone: "UTC",
};
function fixture() {
  const database = createMigratedDatabase();
  for (const sql of [
    ...buildSiteStatements(),
    ...buildDataStatements({ visits: 24 }),
  ])
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "whole-event-readers-local",
  } as unknown as Env;
  return { database, trace, env };
}
function filters(dsl = originalFilter) {
  return parseFilterDsl(dsl, analyticsFilterRegistry);
}
function requests(scope: "session" | "visitor", dsl = originalFilter) {
  const input = {
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time: queryTime,
    filters: filters(dsl),
    scopePreference: scope,
  };
  return {
    types: prepareScopedQuery("event-types", { ...input, limit: 1 }),
    names: prepareScopedQuery("dimension", {
      ...input,
      mode: "breakdown" as const,
      dimension: "event.name" as const,
      limit: 1,
    }),
  };
}
function sqlSince(trace: SqliteD1Trace, start: number) {
  return trace.preparedSql
    .slice(start)
    .map((sql, index) => ({ sql, params: trace.bindings[start + index] }));
}
afterEach(() => vi.restoreAllMocks());

for (const scope of ["session", "visitor"] as const) {
  it(`${scope}: retains completed membership when the owner changes after real cursor decoding`, async () => {
    const f = fixture();
    const register = vi.spyOn(bridge, "registerPreparedMembership");
    const evaluate = vi.spyOn(core, "evaluateFilterDocument");
    const decode = reader.decodeEventTypeCursor;
    try {
      const control = await createD1SiteProviderRegistry({
        env: f.env,
        siteId: SEED_SITE_ID,
      })
        .resolve("event-types")!
        .execute(requests(scope).types);
      const controlSql = sqlSince(f.trace, 0);
      const start = f.trace.preparedSql.length;
      let owner: object | undefined;
      const registry = createD1SiteProviderRegistry({
        env: f.env,
        siteId: SEED_SITE_ID,
      });
      registry.useMiddleware(async (_operation, input, next) => {
        owner = input as object;
        return next(input);
      });
      const decodeSpy = vi
        .spyOn(reader, "decodeEventTypeCursor")
        .mockImplementation(async (...args) => {
          const result = await decode(...args);
          // The composition already captured args[3] before its decoder await.
          Object.assign(owner!, {
            filters: JSON.parse(JSON.stringify(args[3])),
          });
          return result;
        });
      const result = await registry
        .resolve("event-types")!
        .execute(requests(scope).types);
      expect(result).toEqual(control);
      expect(sqlSince(f.trace, start)).toEqual(controlSql);
      expect(result.value.items).toEqual([
        {
          label: "other",
          views: scope === "session" ? 3 : 5,
          sessions: scope === "session" ? 3 : 5,
          visitors: scope === "session" ? 3 : 4,
        },
      ]);
      expect(decodeSpy).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(register).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });

  it(`${scope}: preserves null/native successful Core mutations for both closed readers`, async () => {
    const f = fixture();
    const register = vi.spyOn(bridge, "registerPreparedMembership");
    try {
      for (const operation of ["types", "names"] as const)
        for (const mutation of ["null", "native"] as const) {
          const q = requests(scope)[operation];
          const actual = core.evaluateFilterDocument;
          const evaluate = vi
            .spyOn(core, "evaluateFilterDocument")
            .mockImplementation((...args) => {
              const result = actual(...args);
              Object.assign(q.filters, {
                root:
                  mutation === "null"
                    ? null
                    : filters('page.path eq "/excluded"').root,
              });
              return result;
            });
          try {
            const registry = createD1SiteProviderRegistry({
              env: f.env,
              siteId: SEED_SITE_ID,
            });
            if (operation === "types") {
              const result = await registry
                .resolve("event-types")!
                .execute(q as ReturnType<typeof requests>["types"]);
              expect(result.value.items).toEqual([
                {
                  label: "other",
                  views: scope === "session" ? 3 : 5,
                  sessions: scope === "session" ? 3 : 5,
                  visitors: scope === "session" ? 3 : 4,
                },
              ]);
            } else {
              const result = await registry
                .resolve("dimension")!
                .execute(q as ReturnType<typeof requests>["names"]);
              expect(result.value).toEqual({
                items: [
                  {
                    key: "other",
                    label: "other",
                    views: scope === "session" ? 3 : 5,
                    sessions: scope === "session" ? 3 : 5,
                    visitors: scope === "session" ? 3 : 4,
                  },
                ],
              });
            }
            expect(evaluate).toHaveBeenCalledTimes(1);
          } finally {
            evaluate.mockRestore();
          }
        }
      expect(register).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });

  it(`${scope}: preserves Core error identity ahead of abort, mutation and invalid cursor`, async () => {
    const f = fixture(),
      abort = new AbortController(),
      error = new Error("original-core-error");
    const q = { ...requests(scope).types, cursor: "invalid-cursor" };
    const decode = vi.spyOn(reader, "decodeEventTypeCursor");
    const report = vi.spyOn(reports, "queryAnalyticsReportOutputRowsFromD1");
    const register = vi.spyOn(bridge, "registerPreparedMembership");
    const evaluate = vi
      .spyOn(core, "evaluateFilterDocument")
      .mockImplementation(() => {
        Object.assign(scopedFilterMetadata(q.filters)!.plan, {
          scope: scope === "session" ? "visitor" : "session",
        });
        abort.abort();
        throw error;
      });
    try {
      await expect(
        createD1SiteProviderRegistry({ env: f.env, siteId: SEED_SITE_ID })
          .resolve("event-types")!
          .execute(q, { signal: abort.signal }),
      ).rejects.toBe(error);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(decode).not.toHaveBeenCalled();
      expect(report).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });

  it(`${scope}: decodes malformed cursors after one whole evaluation and before reader execution`, async () => {
    const f = fixture();
    const evaluate = vi.spyOn(core, "evaluateFilterDocument");
    const report = vi.spyOn(reports, "queryAnalyticsReportOutputRowsFromD1");
    try {
      await expect(
        createD1SiteProviderRegistry({ env: f.env, siteId: SEED_SITE_ID })
          .resolve("event-types")!
          .execute({ ...requests(scope).types, cursor: "invalid-cursor" }),
      ).rejects.toBeInstanceOf(InvalidCursorError);
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(report).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });
}

it("retains omitted report arguments on ordinary list and page readers", async () => {
  const f = fixture();
  const report = vi.spyOn(reports, "queryAnalyticsReportOutputRowsFromD1");
  try {
    const nativeFilters: FilterDocument = filters("");
    await reader.queryEventTypeAggregate(
      f.env,
      SEED_SITE_ID,
      window,
      nativeFilters,
      2,
    );
    expect(report.mock.calls).toHaveLength(1);
    expect(report.mock.calls[0]).toHaveLength(3);
    report.mockClear();
    await reader.queryEventNameDimensionFromD1(
      f.env,
      SEED_SITE_ID,
      window,
      queryTime,
      nativeFilters,
      {
        mode: "breakdown",
        dimension: "event.name",
        limit: 2,
        audience: "private-dashboard",
      },
    );
    expect(report.mock.calls).toHaveLength(1);
    expect(report.mock.calls[0]).toHaveLength(3);
    report.mockClear();
    await reader.queryEventTypePageFromD1(
      f.env,
      SEED_SITE_ID,
      window,
      nativeFilters,
      2,
    );
    expect(report.mock.calls).toHaveLength(1);
    expect(report.mock.calls[0]).toHaveLength(5);
    expect(report.mock.calls[0]?.slice(3)).toEqual([undefined, undefined]);
  } finally {
    f.database.close();
  }
});
