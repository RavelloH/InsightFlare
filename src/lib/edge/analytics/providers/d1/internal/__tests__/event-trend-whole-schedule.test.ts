// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import type { FilterDocument } from "@/lib/edge/analytics/contract";
import {
  createQueryTime,
  prepareScopedQuery,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as plans from "@/lib/edge/analytics/engine/event-trend-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { queryAnalyticsReportOutputRowsFromD1 } from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import * as preparation from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import {
  advanceWholeOriginalEventTrend,
  bindWholeOriginalReader,
} from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
const time = createQueryTime(
  SEED_BASE_MS,
  SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
  "UTC",
  SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
);
const dsl =
  'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"';
for (const scope of ["session", "visitor"] as const)
  it(`${scope} finite dependent trend keeps one preparation and real rows control next stage`, async () => {
    const db = createMigratedDatabase();
    for (const sql of buildJourneyEventFieldsCostFixture(24).seed) db.exec(sql);
    const env = {
      DB: createSqliteD1Database(db),
      MAIN_SECRET: "w47-portable-schedule",
    } as unknown as Env;
    const registry = createD1SiteProviderRegistry({
      env,
      siteId: SEED_SITE_ID,
    });
    const marker = new Error("capture-completed-owner");
    let owner: { filters: FilterDocument } | undefined;
    registry.useMiddleware(async (_operation, input) => {
      owner = input as typeof owner;
      throw marker;
    });
    const create = vi.spyOn(
        preparation,
        "createPageVisitQualificationPreparation",
      ),
      bind = vi.spyOn(preparation, "bindPageVisitQualificationPreparation");
    try {
      await expect(
        registry.resolve("event-trend")!.execute(
          prepareScopedQuery("event-trend", {
            context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
            time,
            filters: parseFilterDsl(dsl, analyticsFilterRegistry),
            scopePreference: scope,
            interval: "day",
            limit: 1,
          }),
        ),
      ).rejects.toBe(marker);
      const filters = owner!.filters,
        meta = scopedFilterMetadata(filters)!;
      const input = {
        owner: owner!,
        siteId: SEED_SITE_ID,
        filters,
        queryTime: meta.time,
        scopePlan: meta.plan,
        readerQueryTime: meta.time,
      };
      const configuration = { interval: "day" as const, limit: 1 };
      expect(() =>
        bindWholeOriginalReader({
          ...input,
          consumer: {
            kind: "event-trend",
            configuration,
            stage: { kind: "points", seriesNames: [] },
          },
        }),
      ).toThrow("event_trend_whole_reader_stage_mismatch");
      expect(create).not.toHaveBeenCalled();
      const canonicalMarker = new Error("original-series-builder-error");
      const build = vi
        .spyOn(plans, "buildEventTrendSeriesPlan")
        .mockImplementationOnce(() => {
          throw canonicalMarker;
        });
      expect(() =>
        bindWholeOriginalReader({
          ...input,
          consumer: {
            kind: "event-trend",
            configuration,
            stage: { kind: "series" },
          },
        }),
      ).toThrow(canonicalMarker);
      build.mockRestore();
      expect(create).not.toHaveBeenCalled();
      expect(
        bindWholeOriginalReader({
          ...input,
          owner: { ...owner },
          consumer: {
            kind: "event-trend",
            configuration,
            stage: { kind: "series" },
          },
        }),
      ).toBeUndefined();
      const series = bindWholeOriginalReader({
        ...input,
        consumer: {
          kind: "event-trend",
          configuration,
          stage: { kind: "series" },
        },
      })!;
      const seriesRows = await queryAnalyticsReportOutputRowsFromD1(
        env,
        series.plan,
        plans.EVENT_TREND_OUTPUTS.series,
        undefined,
        undefined,
        series.executionInputs,
      );
      const names = seriesRows.map((row) => row.eventName as string);
      expect(names).toHaveLength(1);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0]![0].maxBindings).toBe(3);
      expect(create.mock.calls[0]![0].maxSourcesPerRole).toBe(1);
      expect(() =>
        bindWholeOriginalReader({
          ...input,
          consumer: {
            kind: "event-trend",
            configuration,
            stage: { kind: "series" },
          },
        }),
      ).toThrow("event_trend_whole_reader_stage_mismatch");
      expect(() =>
        bindWholeOriginalReader({
          ...input,
          consumer: {
            kind: "event-trend",
            configuration,
            stage: { kind: "points", seriesNames: names },
          },
        }),
      ).toThrow("event_trend_whole_reader_stage_mismatch");
      advanceWholeOriginalEventTrend(owner!, {
        kind: "series",
        rows: seriesRows.map((row) => ({ eventName: row.eventName as string })),
      });
      expect(() =>
        bindWholeOriginalReader({
          ...input,
          consumer: {
            kind: "event-trend",
            configuration: { ...configuration, limit: 2 },
            stage: { kind: "points", seriesNames: names },
          },
        }),
      ).toThrow("qualification_execution_plan_snapshot_mismatch");
      expect(create).toHaveBeenCalledTimes(1);
      expect(() =>
        bindWholeOriginalReader({
          ...input,
          consumer: {
            kind: "event-trend",
            configuration,
            stage: { kind: "points", seriesNames: ["forged-name"] },
          },
        }),
      ).toThrow("event_trend_whole_reader_stage_mismatch");
      expect(() =>
        bindWholeOriginalReader({
          ...input,
          consumer: {
            kind: "event-trend",
            configuration,
            stage: { kind: "other", seriesNames: names },
          },
        }),
      ).toThrow("event_trend_whole_reader_stage_mismatch");
      // Original whole result remains authoritative even if the later reader filter is now native/empty.
      Object.assign(filters, { root: null });
      const points = bindWholeOriginalReader({
        ...input,
        consumer: {
          kind: "event-trend",
          configuration,
          stage: { kind: "points", seriesNames: names },
        },
      })!;
      const pointRows = await queryAnalyticsReportOutputRowsFromD1(
        env,
        points.plan,
        plans.EVENT_TREND_OUTPUTS.points,
        undefined,
        undefined,
        points.executionInputs,
      );
      expect(
        pointRows.some((row) => row.seriesName === "__share_trend_other__"),
      ).toBe(true);
      advanceWholeOriginalEventTrend(owner!, {
        kind: "points",
        rows: pointRows.map((row) => ({
          seriesKey: String(row.seriesName ?? ""),
        })),
      });
      const other = bindWholeOriginalReader({
        ...input,
        consumer: {
          kind: "event-trend",
          configuration,
          stage: { kind: "other", seriesNames: names },
        },
      })!;
      await queryAnalyticsReportOutputRowsFromD1(
        env,
        other.plan,
        plans.EVENT_TREND_OUTPUTS.other,
        undefined,
        undefined,
        other.executionInputs,
      );
      expect(create).toHaveBeenCalledTimes(1);
      expect(bind).toHaveBeenCalledTimes(4);
      expect(
        bind.mock.calls.every(
          ([args]) => args.preparation === bind.mock.calls[0]![0].preparation,
        ),
      ).toBe(true);
      expect(bind.mock.calls[2]![0].filters).toBe(
        bind.mock.calls[0]![0].filters,
      );
      expect(bind.mock.calls[2]![0].readerFilters?.root).toBeNull();
      expect(() =>
        bindWholeOriginalReader({
          ...input,
          consumer: {
            kind: "event-trend",
            configuration,
            stage: { kind: "other", seriesNames: names },
          },
        }),
      ).toThrow("event_trend_whole_reader_stage_mismatch");
      expect(() =>
        advanceWholeOriginalEventTrend(owner!, { kind: "series", rows: [] }),
      ).toThrow("event_trend_whole_reader_stage_mismatch");
    } finally {
      create.mockRestore();
      bind.mockRestore();
      db.close();
    }
  });
