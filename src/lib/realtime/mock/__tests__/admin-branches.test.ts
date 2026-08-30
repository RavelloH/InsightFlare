import { afterEach, describe, expect, it, vi } from "vitest";

import type { DemoSiteProfile } from "@/lib/realtime/demo-site-profiles";
import type * as DemoUtilsModule from "@/lib/realtime/demo-utils";
import type * as AdminModule from "@/lib/realtime/mock/admin";
import type {
  DoDiagnosticPayload,
  DoDiagnosticSiteEntry,
} from "@/lib/system-performance";

const TEAM = {
  id: "team-admin-branches",
  name: "Admin Branches",
  slug: "admin-branches",
  ownerUserId: "demo-user-001",
} as const;

const BASE_TIME = Date.UTC(2026, 0, 5, 12, 0, 30);

function makeSiteProfile(id: string): DemoSiteProfile {
  return {
    id,
    teamId: TEAM.id,
    name: `Site ${id}`,
    domain: `${id}.example.test`,
    iconPath: "/icons/test.svg",
    dailyPvRange: [100, 100],
    bounceRateRange: [0.4, 0.4],
    avgDurationMsRange: [60_000, 60_000],
    topCountries: [{ code: "US", weight: 1 }],
    topReferrers: [{ name: "Direct", weight: 1 }],
    paths: ["/"],
    titles: ["Home"],
    deviceWeights: { Desktop: 1, Mobile: 0, Tablet: 0 },
    weekendFactor: 1,
    eventNames: ["signup"],
    hourProfile: {
      riseHour: 0,
      activeWidth: 24,
      baseLevel: 1,
    },
  };
}

function repeatingRng(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

async function withMockedAdmin<T>({
  siteProfiles = [makeSiteProfile("site-a")],
  siteProfilesExport = siteProfiles,
  integrateViews = () => 0,
  rngValues = [0],
  run,
}: {
  siteProfiles?: DemoSiteProfile[];
  siteProfilesExport?: unknown;
  integrateViews?: (siteId: string, from: number, to: number) => number;
  rngValues?: number[];
  run: (admin: typeof AdminModule) => T | Promise<T>;
}): Promise<T> {
  vi.resetModules();
  vi.doMock("@/lib/realtime/demo-site-profiles", () => ({
    DEMO_TEAMS: [TEAM],
    DEMO_SITE_PROFILES: siteProfilesExport,
  }));
  vi.doMock("@/lib/realtime/mock/site-curves", () => ({
    integrateViews,
  }));
  vi.doMock("@/lib/realtime/demo-utils", async () => {
    const actual = await vi.importActual<typeof DemoUtilsModule>(
      "@/lib/realtime/demo-utils",
    );
    return {
      ...actual,
      mulberry32: vi.fn(() => repeatingRng(rngValues)),
    };
  });

  try {
    const admin = await import("@/lib/realtime/mock/admin");
    return await run(admin);
  } finally {
    vi.doUnmock("@/lib/realtime/demo-site-profiles");
    vi.doUnmock("@/lib/realtime/mock/site-curves");
    vi.doUnmock("@/lib/realtime/demo-utils");
    vi.resetModules();
  }
}

function makeDiagnosticPayload(
  overrides: Partial<DoDiagnosticPayload["visits"]["open"]> & {
    openTotal?: number;
  },
): DoDiagnosticPayload {
  const openTotal = overrides.openTotal ?? overrides.total ?? 0;
  return {
    ok: true,
    snapshotAt: BASE_TIME,
    thresholds: {
      staleMs: 1,
      timeoutMs: 2,
      hardAgedMs: 3,
      stuckFlushAttempts: 4,
    },
    visits: {
      total: openTotal,
      byStatus: { open: openTotal },
      open: {
        total: openTotal,
        stale: 0,
        timedOut: 0,
        hardAged: 0,
        futureSkewed: 0,
        oldestStartedAt: null,
        newestActivityAt: null,
        futureMaxActivityAt: null,
        ...overrides,
      },
      dirty: {
        total: 0,
        stuck: 0,
        maxFlushAttempts: 0,
      },
    },
    customEvents: {
      total: 0,
      dirty: 0,
      stuck: 0,
      maxFlushAttempts: 0,
      oldestOccurredAt: null,
    },
    alarm: {
      scheduledAt: null,
      nextDueAt: null,
      nextDueKind: null,
      nextDueEntity: null,
    },
  };
}

function makeDiagnosticSite(
  siteId: string,
  diagnostic: DoDiagnosticPayload,
): DoDiagnosticSiteEntry {
  return {
    siteId,
    siteName: `Site ${siteId}`,
    siteDomain: `${siteId}.example.test`,
    ok: true,
    durationMs: 1,
    diagnostic,
  };
}

describe("mock/admin branch coverage", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("paginates scheduled task runs and resolves selected run details", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    await withMockedAdmin({
      run: (admin) => {
        const firstPage = admin.generateDemoScheduledTasks({
          page: 1,
          pageSize: 3,
        });
        const secondPage = admin.generateDemoScheduledTasks({
          page: 2,
          pageSize: 3,
          runId: firstPage.runs[0]?.id ?? "",
        });

        expect(firstPage.runs).toHaveLength(3);
        expect(firstPage.runsMeta).toEqual({
          page: 1,
          pageSize: 3,
          returned: 3,
          hasMore: true,
          nextPage: 2,
        });
        expect(secondPage.runs.map((run) => run.id)).not.toContain(
          firstPage.runs[0]?.id,
        );
        expect(secondPage.selectedRun?.id).toBe(firstPage.runs[0]?.id);
        expect(secondPage.logs.length).toBeGreaterThan(0);
      },
    });
  });

  it("returns null system performance aggregates when no latency samples exist", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    await withMockedAdmin({
      run: (admin) => {
        const performance = admin.generateDemoSystemPerformance({
          minutes: 15,
        });

        expect(performance.summary.totalEvents).toBe(0);
        expect(performance.summary.latestCreatedAt).toBeNull();
        expect(performance.summary.dataFreshnessMs).toBeNull();
        expect(performance.summary.avgLatencyMs).toBeNull();
        expect(performance.summary.p50LatencyMs).toBeNull();
        expect(performance.summary.p75LatencyMs).toBeNull();
        expect(performance.summary.p95LatencyMs).toBeNull();
        expect(performance.summary.trustedLatencySamples).toBe(0);
        expect(performance.summary.anomalyRate).toBe(0);
        expect(performance.trend).toEqual([]);
        expect(performance.topSites).toEqual([]);
        expect(performance.slowEvents).toEqual([]);
      },
    });
  });

  it("keeps site and trend latency null when all events are future skewed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const integrateViews = vi.fn<
      (siteId: string, from: number, to: number) => number
    >(() => 4);
    const siteId = "site-a";

    await withMockedAdmin({
      integrateViews,
      rngValues: [0.5, 0.015, 0.5],
      siteProfiles: [makeSiteProfile(siteId)],
      run: (admin) => {
        const performance = admin.generateDemoSystemPerformance({
          minutes: 15,
        });
        const siteCalls = integrateViews.mock.calls.filter(
          ([calledSiteId]) => calledSiteId === siteId,
        );
        const clippedLastBucket = siteCalls.find(
          ([, from, to]) =>
            to === BASE_TIME && to - from < performance.window.bucketSizeMs,
        );

        expect(performance.summary.totalEvents).toBeGreaterThan(0);
        expect(performance.summary.trustedLatencySamples).toBe(0);
        expect(performance.summary.avgLatencyMs).toBeNull();
        expect(performance.summary.p50LatencyMs).toBeNull();
        expect(performance.summary.p75LatencyMs).toBeNull();
        expect(performance.summary.p95LatencyMs).toBeNull();
        expect(performance.summary.futureSkewedEvents).toBe(
          performance.summary.totalEvents,
        );
        expect(performance.slowEvents).toEqual([]);
        expect(performance.topSites).toEqual([
          expect.objectContaining({
            siteId,
            avgLatencyMs: null,
            futureSkewedEvents: performance.summary.totalEvents,
          }),
        ]);
        expect(performance.trend.length).toBeGreaterThan(0);
        for (const point of performance.trend) {
          expect(point.avgLatencyMs).toBeNull();
          expect(point.p50LatencyMs).toBeNull();
          expect(point.p75LatencyMs).toBeNull();
          expect(point.p95LatencyMs).toBeNull();
        }
        expect(siteCalls[0]?.[1]).toBeLessThan(performance.window.from);
        expect(clippedLastBucket).toBeDefined();
      },
    });
  });

  it("ignores missing DO diagnostics and compares oldest and future activity bounds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const lowFutureAt = BASE_TIME + 1_000;
    const maxFutureAt = BASE_TIME + 5_000;
    const lowerFutureAt = BASE_TIME + 3_000;
    const oldestStartedAt = BASE_TIME - 9_000;
    const newerStartedAt = BASE_TIME - 4_000;
    const generatedSite = makeSiteProfile("generated");
    const profileSlice = {
      map: (
        callback: (
          site: DemoSiteProfile,
          index: number,
        ) => DoDiagnosticSiteEntry,
      ) => [
        callback(generatedSite, 0),
        {
          siteId: "without-diagnostic",
          siteName: "No diagnostic",
          siteDomain: "without-diagnostic.example.test",
          ok: false,
          durationMs: 0,
        },
        makeDiagnosticSite(
          "low-future",
          makeDiagnosticPayload({
            openTotal: 1,
            futureMaxActivityAt: lowFutureAt,
          }),
        ),
        makeDiagnosticSite(
          "max-future",
          makeDiagnosticPayload({
            openTotal: 1,
            oldestStartedAt: newerStartedAt,
            futureMaxActivityAt: maxFutureAt,
          }),
        ),
        makeDiagnosticSite(
          "older-lower-future",
          makeDiagnosticPayload({
            openTotal: 1,
            oldestStartedAt,
            futureMaxActivityAt: lowerFutureAt,
          }),
        ),
      ],
    };
    const siteProfilesExport = {
      slice: () => profileSlice,
    };

    await withMockedAdmin({
      rngValues: [0],
      siteProfilesExport,
      run: (admin) => {
        const diagnostic = admin.generateDemoDoDiagnostic();

        expect(diagnostic.sites).toHaveLength(5);
        expect(
          diagnostic.sites.some((site) => site.diagnostic === undefined),
        ).toBe(true);
        expect(
          diagnostic.sites[0]?.diagnostic?.visits.open.oldestStartedAt,
        ).toBeNull();
        expect(diagnostic.totals.openVisits).toBe(
          diagnostic.sites.reduce(
            (sum, site) => sum + (site.diagnostic?.visits.open.total ?? 0),
            0,
          ),
        );
        expect(diagnostic.oldestOpenStartedAt).toBe(oldestStartedAt);
        expect(diagnostic.futureMaxActivityAt).toBe(maxFutureAt);
      },
    });
  });
});
