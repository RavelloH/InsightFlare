// @vitest-environment node
import { expect, it, vi } from "vitest";

import { createMigratedDatabase } from "@/../scripts/schema/database";
import { createSqliteD1Database } from "@/lib/db/__tests__/sqlite-d1";
import {
  attachScopedFilterMetadata,
  createQueryTime,
  prepareScopedQuery,
  queryWindowToTime,
  scopedFilterMetadata,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import * as canonical from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import * as binding from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import { bindWholeOriginalReader } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
const fixture = buildJourneyEventFieldsCostFixture(24);
const configuration = {
  browserLimit: 2,
  operatingSystemLimit: 2,
  deviceTypeLimit: 2,
};
async function prepare() {
  const database = createMigratedDatabase();
  for (const sql of fixture.seed) database.exec(sql);
  const time = createQueryTime(
    SEED_BASE_MS,
    SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
    "UTC",
    SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
  );
  const q = prepareScopedQuery("cross-dimension", {
    variant: "browser",
    browserLimit: 2,
    osLimit: 2,
    deviceTypeLimit: 2,
    context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
    time,
    scopePreference: "session",
    filters: parseFilterDsl(
      'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"',
      analyticsFilterRegistry,
    ),
  });
  const owner = (await d1AdvancedFilterMiddleware(
    { DB: createSqliteD1Database(database) } as Env,
    undefined,
    SEED_SITE_ID,
  )("cross-dimension", q, async (value) => value)) as typeof q;
  const metadata = scopedFilterMetadata(owner.filters)!;
  return {
    database,
    owner,
    filters: owner.filters!,
    metadata,
    input(stage: "operatingSystem" | "deviceType") {
      return {
        owner,
        siteId: SEED_SITE_ID,
        filters: owner.filters!,
        queryTime: metadata.time!,
        scopePlan: metadata.plan,
        readerQueryTime: queryWindowToTime({
          startMs: time.range.startMs,
          endExclusiveMs: time.range.endExclusiveMs,
          nowMs: time.capturedAtMs,
          timeZone: time.reportingTimeZone,
        }),
        consumer: {
          kind: "page" as const,
          family: "cross-dimension" as const,
          reader: {
            kind: "technology-browser-cross-stage" as const,
            stage,
            configuration,
          },
        },
      };
    },
  };
}
for (const probe of [
  "device-first",
  "duplicate-os",
  "replay-device",
  "clone-owner",
  "wrong-filter",
  "wrong-metadata",
  "wrong-site",
  "wrong-scope",
  "wrong-role",
  "changed-config",
  "first-build-fails",
  "failed-first-changed-config",
  "one-preparation",
] as const) {
  it(probe, async () => {
    const p = await prepare();
    const os = p.input("operatingSystem"),
      device = p.input("deviceType");
    try {
      switch (probe) {
        case "device-first":
          expect(() => bindWholeOriginalReader(device)).toThrow(
            "whole_filter_reader_consumer_mismatch",
          );
          expect(bindWholeOriginalReader(os)).toBeDefined();
          expect(bindWholeOriginalReader(device)).toBeDefined();
          break;
        case "duplicate-os":
          expect(bindWholeOriginalReader(os)).toBeDefined();
          expect(() => bindWholeOriginalReader(os)).toThrow(
            "whole_filter_reader_consumer_mismatch",
          );
          expect(bindWholeOriginalReader(device)).toBeDefined();
          break;
        case "replay-device":
          bindWholeOriginalReader(os);
          bindWholeOriginalReader(device);
          expect(() => bindWholeOriginalReader(device)).toThrow(
            "whole_filter_reader_consumer_mismatch",
          );
          break;
        case "clone-owner":
          expect(
            bindWholeOriginalReader({ ...os, owner: { ...p.owner } }),
          ).toBeUndefined();
          expect(bindWholeOriginalReader(os)).toBeDefined();
          break;
        case "wrong-filter":
          expect(() =>
            bindWholeOriginalReader({ ...os, filters: { ...p.filters } }),
          ).toThrow();
          break;
        case "wrong-metadata": {
          const filters = attachScopedFilterMetadata(
            { ...p.filters },
            { ...p.metadata },
          );
          expect(() => bindWholeOriginalReader({ ...os, filters })).toThrow();
          break;
        }
        case "wrong-site":
          expect(() =>
            bindWholeOriginalReader({ ...os, siteId: "foreign-site" }),
          ).toThrow();
          break;
        case "wrong-scope":
          expect(() =>
            bindWholeOriginalReader({
              ...os,
              scopePlan: { ...os.scopePlan, scope: "visitor" },
            }),
          ).toThrow();
          break;
        case "wrong-role":
          expect(() =>
            bindWholeOriginalReader({
              ...os,
              scopePlan: { ...os.scopePlan, mode: "observation" },
            }),
          ).toThrow();
          break;
        case "changed-config":
          bindWholeOriginalReader(os);
          expect(() =>
            bindWholeOriginalReader({
              ...device,
              consumer: {
                ...device.consumer,
                reader: {
                  ...device.consumer.reader,
                  configuration: { ...configuration, browserLimit: 3 },
                },
              },
            }),
          ).toThrow();
          expect(bindWholeOriginalReader(device)).toBeDefined();
          break;
        case "first-build-fails": {
          const marker = new Error("first builder");
          const b = vi
            .spyOn(canonical, "buildTechnologyCrossBreakdownPlan")
            .mockImplementationOnce(() => {
              throw marker;
            });
          try {
            expect(() => bindWholeOriginalReader(os)).toThrow(marker);
            expect(bindWholeOriginalReader(device)).toBeDefined();
            expect(() => bindWholeOriginalReader(os)).toThrow(
              "whole_filter_reader_consumer_mismatch",
            );
          } finally {
            b.mockRestore();
          }
          break;
        }
        case "failed-first-changed-config": {
          const marker = new Error("first builder");
          const b = vi
            .spyOn(canonical, "buildTechnologyCrossBreakdownPlan")
            .mockImplementationOnce(() => {
              throw marker;
            });
          try {
            expect(() => bindWholeOriginalReader(os)).toThrow(marker);
            expect(() =>
              bindWholeOriginalReader({
                ...device,
                consumer: {
                  ...device.consumer,
                  reader: {
                    ...device.consumer.reader,
                    configuration: { ...configuration, browserLimit: 3 },
                  },
                },
              }),
            ).toThrow("whole_filter_reader_consumer_mismatch");
            expect(bindWholeOriginalReader(device)).toBeDefined();
          } finally {
            b.mockRestore();
          }
          break;
        }
        case "one-preparation": {
          const prep = vi.spyOn(
            binding,
            "createPageVisitQualificationPreparation",
          );
          try {
            bindWholeOriginalReader(os);
            bindWholeOriginalReader(device);
            expect(prep).toHaveBeenCalledTimes(1);
            expect(prep.mock.calls[0]![0]).toMatchObject({
              maxBindings: 2,
              maxSourcesPerRole: 1,
            });
            expect(() => bindWholeOriginalReader(device)).toThrow();
            expect(prep).toHaveBeenCalledTimes(1);
          } finally {
            prep.mockRestore();
          }
          break;
        }
      }
    } finally {
      p.database.close();
    }
  });
}
