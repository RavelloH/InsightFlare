// @vitest-environment node
// Real canonical builders, middleware, Core and SQLite reads.
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import {
  createSqliteD1Database,
  type SqliteD1Trace,
} from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type { FilterDocument } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as overview from "@/lib/edge/analytics/engine/event-type-overview-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import * as prep from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import * as shared from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";

const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const dsl =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function fixture(scope: "session" | "visitor") {
  const db = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed) db.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(db, trace),
    MAIN_SECRET: "portable-event-detail",
  } as unknown as Env;
  const request = {
    ...prepareScopedQuery("event-type-detail", {
      context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
      time,
      filters: parseFilterDsl(dsl, analyticsFilterRegistry),
      scopePreference: scope,
    }),
    eventName: "qualifier",
    interval: "day" as const,
  };
  const registry = createD1SiteProviderRegistry({ env, siteId: SEED_SITE_ID });
  return { db, trace, env, request, registry };
}

async function capture(
  scope: "session" | "visitor",
  legacy: boolean,
  fault?: "first-overview" | "trend-report",
) {
  const f = fixture(scope);
  const actualSelect = shared.selectWholeOriginalConsumer;
  const select = vi.spyOn(shared, "selectWholeOriginalConsumer");
  if (legacy)
    select.mockImplementation((...args) =>
      args[0].operation === "event-type-detail"
        ? undefined
        : actualSelect(...args),
    );
  const register = vi.spyOn(bridge, "registerPreparedMembership");
  const evaluate = vi.spyOn(core, "evaluateFilterDocument");
  const create = vi.spyOn(prep, "createPageVisitQualificationPreparation");
  const bind = vi.spyOn(prep, "bindPageVisitQualificationPreparation");
  const actualBuilder = overview.buildEventTypeOverviewPlan;
  const originalOne = reports.queryAnalyticsReportOutputRowsFromD1;
  const originalSet = reports.queryAnalyticsReportOutputSetRowsFromD1;
  const marker = new Error("original-parallel-child-error");
  const started: Promise<unknown>[] = [];
  const starts: string[] = [];
  const fixedF = copy(scopedFilterMetadata(f.request.filters!)!.time);
  const builder = vi
    .spyOn(overview, "buildEventTypeOverviewPlan")
    .mockImplementation((...args) => {
      if (fault === "first-overview") {
        const metadata = scopedFilterMetadata(args[0].filters)!;
        Object.assign(metadata, {
          time: {
            ...metadata.time!,
            range: {
              ...metadata.time!.range,
              startMs: metadata.time!.range.startMs + 1,
              endExclusiveMs: metadata.time!.range.endExclusiveMs - 1,
            },
          },
        });
        throw marker;
      }
      return actualBuilder(...args);
    });
  const one = vi
    .spyOn(reports, "queryAnalyticsReportOutputRowsFromD1")
    .mockImplementation((...args) => {
      const stage = args[2] === "event-type-trend-points" ? "trend" : "context";
      starts.push(stage);
      const promise =
        fault === "trend-report" && stage === "trend"
          ? Promise.reject(marker)
          : originalOne(...args);
      started.push(promise);
      return promise;
    });
  const set = vi
    .spyOn(reports, "queryAnalyticsReportOutputSetRowsFromD1")
    .mockImplementation((...args) => {
      starts.push("overview");
      const promise = originalSet(...args);
      started.push(promise);
      return promise;
    });
  try {
    let value: unknown, error: unknown;
    try {
      value = await f.registry.resolve("event-type-detail")!.execute(f.request);
    } catch (caught) {
      error = caught;
    }
    await Promise.allSettled(started);
    if (fault) expect(error).toBe(marker);
    else {
      expect(error).toBeUndefined();
      expect(value).toBeDefined();
    }
    expect(starts).toEqual(
      fault === "first-overview"
        ? ["trend", "context"]
        : ["overview", "trend", "context"],
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(legacy ? 1 : 0);
    if (!legacy) {
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0]).toMatchObject({
        queryTime: fixedF,
        maxBindings: 3,
        maxSourcesPerRole: 2,
      });
      expect(bind.mock.calls).toHaveLength(fault === "first-overview" ? 2 : 3);
      expect(
        bind.mock.calls.every(
          ([arg]) => arg.preparation === create.mock.results[0]!.value,
        ),
      ).toBe(true);
      for (const [arg] of bind.mock.calls)
        expect(arg.queryTime).toEqual(fixedF);
    }
    return {
      value,
      errorIdentityPreserved: fault ? error === marker : error === undefined,
      starts,
      sql: f.trace.preparedSql.map((sql, index) => ({
        sql,
        params: f.trace.bindings[index],
      })),
    };
  } finally {
    select.mockRestore();
    register.mockRestore();
    evaluate.mockRestore();
    create.mockRestore();
    bind.mockRestore();
    builder.mockRestore();
    one.mockRestore();
    set.mockRestore();
    f.db.close();
  }
}

for (const scope of ["session", "visitor"] as const) {
  it(`${scope}: parallel detail preserves the actual legacy DTO and ordered SQL`, async () => {
    const legacy = await capture(scope, true);
    const current = await capture(scope, false);
    expect(current).toEqual(legacy);
  }, 30_000);

  it(`${scope}: original builder failure and report rejection preserve siblings and fixed F`, async () => {
    for (const fault of ["first-overview", "trend-report"] as const) {
      const legacy = await capture(scope, true, fault);
      const current = await capture(scope, false, fault);
      expect(current).toEqual(legacy);
    }
  }, 30_000);

  it(`${scope}: real owner has one cached preparation, failed builders do not claim, and replay stays closed`, async () => {
    const f = fixture(scope);
    const stop = new Error("real-whole-owner-before-composition");
    let owner: { filters: FilterDocument } | undefined;
    f.registry.useMiddleware((_operation, input) => {
      owner = input as typeof owner;
      throw stop;
    });
    const create = vi.spyOn(prep, "createPageVisitQualificationPreparation");
    const actualBuilder = overview.buildEventTypeOverviewPlan;
    const builder = vi.spyOn(overview, "buildEventTypeOverviewPlan");
    const marker = new Error("original-canonical-builder-error");
    const nextOwner = async () => {
      owner = undefined;
      await expect(
        f.registry.resolve("event-type-detail")!.execute(f.request),
      ).rejects.toBe(stop);
      expect(owner).toBeDefined();
      return owner!;
    };
    try {
      const first = await nextOwner();
      const input = (
        actualOwner: typeof first,
        child: "overview" | "trend" | "context",
      ) => {
        const metadata = scopedFilterMetadata(actualOwner.filters)!;
        return {
          membership: {
            kind: "whole-original-event-type-detail" as const,
            owner: actualOwner,
            configuration: {
              eventName: "qualifier",
              interval: "day" as const,
              includeContext: true,
              includeBreakdowns: true,
            },
          },
          child,
          siteId: SEED_SITE_ID,
          filters: actualOwner.filters,
          queryTime: metadata.time!,
          readerQueryTime: child === "context" ? time : metadata.time!,
          scopePlan: metadata.plan,
        };
      };
      builder.mockImplementationOnce(() => {
        throw marker;
      });
      expect(() =>
        shared.bindWholeOriginalEventDetailReader(input(first, "overview")),
      ).toThrow(marker);
      expect(create).not.toHaveBeenCalled();
      builder.mockImplementation(actualBuilder);
      const normal = input(first, "overview");
      expect(
        shared.bindWholeOriginalEventDetailReader({
          ...normal,
          membership: { ...normal.membership, owner: { ...first } },
        }),
      ).toBeUndefined();
      expect(() =>
        shared.bindWholeOriginalEventDetailReader({
          ...normal,
          filters: { ...first.filters },
        }),
      ).toThrow();
      expect(create).not.toHaveBeenCalled();
      for (const child of ["trend", "context", "overview"] as const)
        expect(
          shared.bindWholeOriginalEventDetailReader(input(first, child)),
        ).toBeDefined();
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0]).toMatchObject({
        maxBindings: 3,
        maxSourcesPerRole: 2,
      });
      expect(() =>
        shared.bindWholeOriginalEventDetailReader(input(first, "overview")),
      ).toThrow("event_type_detail_whole_reader_reused");
      const second = await nextOwner();
      expect(second).not.toBe(first);
      expect(
        shared.bindWholeOriginalEventDetailReader(input(second, "overview")),
      ).toBeDefined();
      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.results[0]!.value).not.toBe(
        create.mock.results[1]!.value,
      );
    } finally {
      create.mockRestore();
      builder.mockRestore();
      f.db.close();
    }
  }, 30_000);
}
