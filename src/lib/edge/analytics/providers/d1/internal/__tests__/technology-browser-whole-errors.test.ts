// @vitest-environment node
const expectedEvents = {
  "builder-first": [
    "execute-returned",
    "builder:1",
    "builder-throw:1",
    "builder:2",
    "report-start:1",
    "report-resolve:1",
    "execute-rejected",
    "settled",
  ],
  "builder-second": [
    "execute-returned",
    "builder:1",
    "report-start:1",
    "builder:2",
    "builder-throw:2",
    "report-resolve:1",
    "execute-rejected",
    "settled",
  ],
  "report-first": [
    "execute-returned",
    "builder:1",
    "report-start:1",
    "builder:2",
    "report-start:2",
    "report-reject:1",
    "report-resolve:2",
    "execute-rejected",
    "settled",
  ],
  "report-second": [
    "execute-returned",
    "builder:1",
    "report-start:1",
    "builder:2",
    "report-start:2",
    "report-reject:2",
    "report-resolve:1",
    "execute-rejected",
    "settled",
  ],
};
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
import * as canonical from "@/lib/edge/analytics/engine/technology-cross-breakdown-report-plan";
import { buildJourneyEventFieldsCostFixture } from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/journey-event-fields-cost-fixture";
import {
  SEED_BASE_MS,
  SEED_DAY_MS,
  SEED_DAYS,
  SEED_SITE_ID,
} from "@/lib/edge/analytics/providers/d1/internal/__tests__/remote-d1/seed";
import * as reports from "@/lib/edge/analytics/providers/d1/internal/analytics-report-query";
import type { Env } from "@/lib/edge/types";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
const fixture = buildJourneyEventFieldsCostFixture(24);
for (const scope of ["session", "visitor"] as const)
  for (const fault of [
    "builder-first",
    "builder-second",
    "report-first",
    "report-second",
  ] as const) {
    it(`${scope}/${fault}`, async () => {
      const database = createMigratedDatabase();
      for (const sql of fixture.seed) database.exec(sql);
      const trace: SqliteD1Trace = { preparedSql: [], bindings: [] },
        events: string[] = [],
        pending: Promise<unknown>[] = [];
      const marker = new Error(`original-${fault}`);
      const originalBuilder = canonical.buildTechnologyCrossBreakdownPlan,
        originalReport = reports.queryAnalyticsReportOutputSetRowsFromD1;
      let builders = 0,
        reportCalls = 0;
      const b = vi
        .spyOn(canonical, "buildTechnologyCrossBreakdownPlan")
        .mockImplementation((...a) => {
          const i = ++builders;
          events.push(`builder:${i}`);
          if (fault === `builder-${i === 1 ? "first" : "second"}`) {
            events.push(`builder-throw:${i}`);
            throw marker;
          }
          return originalBuilder(...a);
        });
      const r = vi
        .spyOn(reports, "queryAnalyticsReportOutputSetRowsFromD1")
        .mockImplementation((...a) => {
          const i = ++reportCalls;
          events.push(`report-start:${i}`);
          const p =
            fault === `report-${i === 1 ? "first" : "second"}`
              ? Promise.reject(marker)
              : originalReport(...a);
          pending.push(p);
          void p.then(
            () => events.push(`report-resolve:${i}`),
            () => events.push(`report-reject:${i}`),
          );
          return p;
        });
      try {
        const q = prepareScopedQuery("cross-dimension", {
          variant: "browser",
          browserLimit: 2,
          osLimit: 2,
          deviceTypeLimit: 2,
          context: siteQueryContext(SEED_SITE_ID, "private-dashboard"),
          time: createQueryTime(
            SEED_BASE_MS,
            SEED_BASE_MS + SEED_DAYS * SEED_DAY_MS,
            "UTC",
            SEED_BASE_MS + (SEED_DAYS + 1) * SEED_DAY_MS,
          ),
          scopePreference: scope,
          filters: parseFilterDsl(
            'sequence([event { event.name eq "qualifier" },event { event.name eq "other" }]) exists OR page.path eq "/"',
            analyticsFilterRegistry,
          ),
        });
        const provider = createD1SiteProviderRegistry({
          env: {
            DB: createSqliteD1Database(database, trace),
            MAIN_SECRET: "w48-fault",
          } as Env,
          siteId: SEED_SITE_ID,
        }).resolve("cross-dimension")!;
        let error: unknown;
        try {
          const task = provider.execute(q as never);
          events.push("execute-returned");
          await task;
        } catch (e) {
          error = e;
          events.push("execute-rejected");
        }
        await Promise.allSettled(pending);
        events.push("settled");
        expect(error).toBe(marker);
        expect(builders).toBe(2);
        expect(events).toEqual(expectedEvents[fault]);
        expect(reportCalls).toBe(fault.startsWith("builder-") ? 1 : 2);
        expect(trace.preparedSql).toHaveLength(3);
      } finally {
        b.mockRestore();
        r.mockRestore();
        database.close();
      }
    });
  }
