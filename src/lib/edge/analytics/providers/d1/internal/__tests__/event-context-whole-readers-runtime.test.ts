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
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as contextPlan from "@/lib/edge/analytics/engine/event-context-report-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as report from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import {
  type EventContextCardKey,
  queryEventAnalyticsContextCardsFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/events-context";
import * as prep from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import * as bridge from "@/lib/edge/analytics/providers/d1/internal/prepared-membership-relations";
import { bindWholeOriginalReader } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import type { FilterDocument } from "@/lib/filter-contract";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import * as core from "@/lib/filter-contract/filter-evaluator";
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const window = {
  startMs: time.range.startMs,
  endExclusiveMs: time.range.endExclusiveMs,
  nowMs: time.capturedAtMs,
  timeZone: "UTC",
};
const dsl =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
function fixture() {
  const database = createMigratedDatabase();
  for (const sql of buildJourneyEventFieldsCostFixture(24).seed)
    database.exec(sql);
  const trace: SqliteD1Trace = { preparedSql: [], bindings: [] };
  const env = {
    DB: createSqliteD1Database(database, trace),
    MAIN_SECRET: "w44-context-slots",
  } as unknown as Env;
  return { database, trace, env };
}

for (const scope of ["session", "visitor"] as const) {
  for (const selection of ["default", "owner-only", "entry-exit"] as const)
    it(`${scope} ${selection}: derives Source budget and consumes one existing preparation`, async () => {
      const f = fixture();
      const create = vi.spyOn(prep, "createPageVisitQualificationPreparation");
      const actualBuilder = contextPlan.buildEventContextReportPlan;
      const build = vi.spyOn(contextPlan, "buildEventContextReportPlan");
      const read = vi.spyOn(report, "queryAnalyticsReportOutputRowsFromD1");
      const stop = new Error("capture-completed-owner-before-reader");
      let owner: { filters: FilterDocument } | undefined;
      try {
        const registry = createD1SiteProviderRegistry({
          env: f.env,
          siteId: SEED_SITE_ID,
        });
        registry.useMiddleware(async (_operation, input) => {
          owner = input as { filters: FilterDocument };
          throw stop;
        });
        await expect(
          registry.resolve("event-context")!.execute(
            prepareScopedQuery("event-context", {
              context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
              time,
              filters: parseFilterDsl(dsl, analyticsFilterRegistry),
              scopePreference: scope,
              limit: 1,
              eventName: "qualifier",
            }),
          ),
        ).rejects.toBe(stop);
        const filters = owner!.filters,
          metadata = scopedFilterMetadata(filters)!;
        const input = {
          owner: owner!,
          siteId: SEED_SITE_ID,
          filters,
          queryTime: metadata.time!,
          readerQueryTime: time,
          scopePlan: metadata.plan,
          consumer: {
            kind: "event-context" as const,
            configuration: {
              limit: 1,
              eventName: "qualifier",
              ...(selection === "owner-only"
                ? { selectedKeys: ["path"] as const }
                : {}),
            },
          },
        };
        expect(
          bindWholeOriginalReader({ ...input, owner: { ...owner! } }),
        ).toBeUndefined();
        expect(() =>
          bindWholeOriginalReader({
            ...input,
            consumer: { kind: "event-summary" },
          }),
        ).toThrow("whole_filter_reader_consumer_mismatch");
        const copied = attachScopedFilterMetadata({ ...filters }, metadata);
        expect(() =>
          bindWholeOriginalReader({ ...input, filters: copied }),
        ).toThrow("qualification_execution_plan_snapshot_mismatch");
        expect(() =>
          bindWholeOriginalReader({
            ...input,
            queryTime: { ...metadata.time! },
          }),
        ).toThrow("qualification_execution_plan_snapshot_mismatch");
        expect(() =>
          bindWholeOriginalReader({
            ...input,
            scopePlan: { ...metadata.plan },
          }),
        ).toThrow(
          "invalid_semantic_scoped_source_selection:prepared_plan_identity_mismatch",
        );
        expect(() =>
          bindWholeOriginalReader({ ...input, siteId: "wrong-site" }),
        ).toThrow();
        expect(create).not.toHaveBeenCalled();
        build.mockImplementationOnce((options) =>
          actualBuilder({
            ...options,
            pageVisitDependencyRefs: ["event-filter-event-membership-v1"],
          }),
        );
        expect(() =>
          bindWholeOriginalReader({
            ...input,
            consumer: { kind: "event-context", configuration: { limit: 1 } },
          }),
        ).toThrow(
          "invalid_semantic_scoped_source_selection:qualification_dependency_semantics_mismatch",
        );
        expect(create).not.toHaveBeenCalled();
        build.mockClear();
        const sqlBeforeEmpty = f.trace.preparedSql.length;
        await queryEventAnalyticsContextCardsFromD1(
          f.env,
          SEED_SITE_ID,
          window,
          filters,
          1,
          "qualifier",
          [],
          { wholeOriginalOwner: owner },
        );
        await queryEventAnalyticsContextCardsFromD1(
          f.env,
          SEED_SITE_ID,
          window,
          filters,
          1,
          "qualifier",
          ["unknown" as EventContextCardKey],
          { wholeOriginalOwner: owner },
        );
        expect(build).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(f.trace.preparedSql).toHaveLength(sqlBeforeEmpty);
        const marker = new Error("original-canonical-builder-first");
        build.mockImplementationOnce(() => {
          throw marker;
        });
        await expect(
          queryEventAnalyticsContextCardsFromD1(
            f.env,
            SEED_SITE_ID,
            window,
            filters,
            1,
            "qualifier",
            undefined,
            { wholeOriginalOwner: owner },
          ),
        ).rejects.toBe(marker);
        expect(create).not.toHaveBeenCalled();
        const selected =
          selection === "owner-only"
            ? (["path"] as const)
            : selection === "entry-exit"
              ? (["entry", "exit"] as const)
              : undefined;
        read.mockClear();
        await queryEventAnalyticsContextCardsFromD1(
          f.env,
          SEED_SITE_ID,
          window,
          filters,
          1,
          "qualifier",
          selected,
          { wholeOriginalOwner: owner },
        );
        expect(create).toHaveBeenCalledTimes(1);
        expect(create.mock.calls[0]![0]).toMatchObject({
          maxBindings: 1,
          maxSourcesPerRole: selection === "owner-only" ? 1 : 2,
          qualificationSemantics: "whole-original",
        });
        expect(read.mock.calls[0]).toHaveLength(6);
        const sources = read.mock.calls[0]![1].nodes.filter(
          (n) => n.kind === "source",
        );
        expect(sources.map((s) => s.entity)).toEqual(
          selection === "owner-only" ? ["event"] : ["event", "page"],
        );
        for (const source of sources)
          expect(source.selection).toMatchObject({
            profile: "prepared-whole-filter-reader-window-v1",
            qualificationDependencyRefs: ["event-filter-entity-membership-v1"],
          });
        const sqlAfterValid = f.trace.preparedSql.length;
        await expect(
          queryEventAnalyticsContextCardsFromD1(
            f.env,
            SEED_SITE_ID,
            window,
            filters,
            1,
            "qualifier",
            selected,
            { wholeOriginalOwner: owner },
          ),
        ).rejects.toThrow("qualification_execution_preparation_replayed");
        expect(create).toHaveBeenCalledTimes(1);
        expect(f.trace.preparedSql).toHaveLength(sqlAfterValid);
      } finally {
        create.mockRestore();
        build.mockRestore();
        read.mockRestore();
        f.database.close();
      }
    });

  it(`${scope}: keeps successful null/native Core mutation and original Core rejection`, async () => {
    const f = fixture(),
      register = vi.spyOn(bridge, "registerPreparedMembership"),
      actual = core.evaluateFilterDocument;
    let currentFilters: FilterDocument;
    const execute = () => {
      const request = prepareScopedQuery("event-context", {
        context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
        time,
        filters: parseFilterDsl(dsl, analyticsFilterRegistry),
        scopePreference: scope,
        limit: 1,
        eventName: "qualifier",
      });
      currentFilters = request.filters;
      return createD1SiteProviderRegistry({ env: f.env, siteId: SEED_SITE_ID })
        .resolve("event-context")!
        .execute(request);
    };
    try {
      const control = await execute();
      for (const mutation of ["null", "native"] as const) {
        const evaluate = vi
          .spyOn(core, "evaluateFilterDocument")
          .mockImplementation((...args) => {
            const value = actual(...args);
            Object.assign(currentFilters, {
              root:
                mutation === "null"
                  ? null
                  : parseFilterDsl(
                      'page.path eq "/excluded"',
                      analyticsFilterRegistry,
                    ).root,
            });
            return value;
          });
        try {
          expect(await execute()).toEqual(control);
          expect(evaluate).toHaveBeenCalledTimes(1);
        } finally {
          evaluate.mockRestore();
        }
      }
      expect(register).not.toHaveBeenCalled();
      const marker = new Error("original-Core-error"),
        abort = new AbortController();
      const request = prepareScopedQuery("event-context", {
        context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
        time,
        filters: parseFilterDsl(dsl, analyticsFilterRegistry),
        scopePreference: scope,
        limit: 1,
      });
      const read = vi.spyOn(report, "queryAnalyticsReportOutputRowsFromD1");
      const evaluate = vi
        .spyOn(core, "evaluateFilterDocument")
        .mockImplementation(() => {
          Object.assign(scopedFilterMetadata(request.filters)!.plan, {
            scope: scope === "session" ? "visitor" : "session",
          });
          abort.abort();
          throw marker;
        });
      try {
        await expect(
          createD1SiteProviderRegistry({ env: f.env, siteId: SEED_SITE_ID })
            .resolve("event-context")!
            .execute(request, { signal: abort.signal }),
        ).rejects.toBe(marker);
        expect(read).not.toHaveBeenCalled();
      } finally {
        evaluate.mockRestore();
        read.mockRestore();
      }
    } finally {
      register.mockRestore();
      f.database.close();
    }
  });
}
it("keeps ordinary five-argument report calls and normalizes selected card keys", async () => {
  const f = fixture(),
    read = vi.spyOn(report, "queryAnalyticsReportOutputRowsFromD1"),
    build = vi.spyOn(contextPlan, "buildEventContextReportPlan");
  try {
    const filters = parseFilterDsl("", analyticsFilterRegistry);
    await queryEventAnalyticsContextCardsFromD1(
      f.env,
      SEED_SITE_ID,
      window,
      filters,
      1,
      "qualifier",
      ["entry", "path", "entry", "unknown" as EventContextCardKey],
    );
    expect(read.mock.calls[0]).toHaveLength(5);
    expect(build.mock.calls[0]![0].selectedKeys).toEqual(["path", "entry"]);
    read.mockClear();
    build.mockClear();
    await queryEventAnalyticsContextCardsFromD1(
      f.env,
      SEED_SITE_ID,
      window,
      filters,
      1,
      "qualifier",
      [],
    );
    expect(read).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  } finally {
    read.mockRestore();
    build.mockRestore();
    f.database.close();
  }
});
