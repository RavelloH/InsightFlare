import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";

const queryOverviewAggregate = vi.hoisted(() => vi.fn());
const queryPagesAggregate = vi.hoisted(() => vi.fn());
const queryReferrerAggregate = vi.hoisted(() => vi.fn());

vi.mock("@/lib/edge/analytics/providers/d1/internal/overview", () => ({
  queryOverviewAggregate,
}));

vi.mock("@/lib/edge/analytics/providers/d1/internal/pages", () => ({
  queryPagesAggregate,
  queryReferrerAggregate,
}));

import {
  createNotificationInvocationCache,
  getOrCreateCachedPromise,
} from "@/lib/notifications/notification-cache";
import {
  loadCumulativeMetricValue,
  loadDailyReportData,
  loadMetricValue,
  loadPreviousMetricValue,
  loadSiteLastSeenAt,
  notificationReportWindowFor,
  notificationWindowFor,
} from "@/lib/notifications/report-data";

function envWithLastSeen(lastSeenAt: number | null) {
  const bind = vi.fn(() => ({
    first: vi.fn(() => Promise.resolve({ lastSeenAt })),
  }));
  return {
    env: {
      DB: {
        prepare: vi.fn(() => ({ bind })),
      },
    },
    bind,
  };
}

describe("notification report data", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("builds rolling and timezone-aware report windows", () => {
    expect(
      notificationWindowFor({
        window: "last_1h",
        now: 3_600,
        timezone: "Mars/Base",
      }),
    ).toMatchObject({
      startMs: 0,
      endExclusiveMs: 3_600_000,
      nowMs: 3_600_000,
      timeZone: "UTC",
      label: "last 1 hour",
    });
    expect(
      notificationWindowFor({
        window: "last_24h",
        now: 90_000,
        timezone: "Asia/Shanghai",
      }),
    ).toMatchObject({
      startMs: 3_600_000,
      endExclusiveMs: 90_000_000,
      timeZone: "Asia/Shanghai",
      label: "last 24 hours",
    });
    expect(
      notificationWindowFor({
        window: "yesterday",
        now: Date.UTC(2026, 5, 30, 12) / 1000,
        timezone: "UTC",
      }),
    ).toMatchObject({
      label: "2026-06-29",
    });
  });

  it("builds calendar report windows for previous complete periods", () => {
    const now = Date.UTC(2026, 6, 15, 12) / 1000;

    expect(
      notificationReportWindowFor({
        reportType: "weekly",
        now,
        timezone: "UTC",
      }).label,
    ).toBe("2026-07-06 to 2026-07-12");
    expect(
      notificationReportWindowFor({
        reportType: "monthly",
        now,
        timezone: "UTC",
      }).label,
    ).toBe("2026-06");
    expect(
      notificationReportWindowFor({
        reportType: "quarterly",
        now,
        timezone: "UTC",
      }).label,
    ).toBe("2026 Q2");
    expect(
      notificationReportWindowFor({
        reportType: "yearly",
        now,
        timezone: "UTC",
      }).label,
    ).toBe("2025");
  });

  it("loads daily report data from site metadata and aggregate queries", async () => {
    queryOverviewAggregate.mockResolvedValue({
      value: { views: 100, visitors: 40, sessions: 55 },
    });
    queryPagesAggregate.mockResolvedValue([
      { pathname: "/pricing", views: 20 },
      { pathname: "", views: 10 },
    ]);
    queryReferrerAggregate.mockResolvedValue([
      { referrer: "example.com", sessions: 8 },
      { referrer: "", sessions: 4 },
    ]);
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn(() =>
              Promise.resolve({ name: "Demo", domain: "example.test" }),
            ),
          })),
        })),
      },
    };

    const report = await loadDailyReportData(env as never, {
      siteId: "site-1",
      now: Date.UTC(2026, 5, 30, 12) / 1000,
      timezone: "UTC",
    });

    expect(report).toMatchObject({
      siteName: "Demo",
      siteDomain: "example.test",
      range: { label: "2026-06-29" },
      metrics: { views: 100, visitors: 40, sessions: 55 },
      topPages: [
        { path: "/pricing", views: 20 },
        { path: "/", views: 10 },
      ],
      topReferrers: [
        { referrer: "example.com", visits: 8 },
        { referrer: "Direct", visits: 4 },
      ],
    });
    expect(queryPagesAggregate).toHaveBeenCalledWith(
      env,
      "site-1",
      expect.objectContaining({ label: "2026-06-29" }),
      EMPTY_FILTER_DOCUMENT,
      5,
      false,
    );
  });

  it("returns null daily report data when the site is missing", async () => {
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn(() => Promise.resolve(null)),
          })),
        })),
      },
    };

    await expect(
      loadDailyReportData(env as never, { siteId: "missing", now: 1 }),
    ).resolves.toBeNull();
    expect(queryOverviewAggregate).not.toHaveBeenCalled();
  });

  it("loads a selected metric value for a window", async () => {
    queryOverviewAggregate.mockResolvedValue({
      value: { views: 100, visitors: 40, sessions: 55 },
    });

    await expect(
      loadMetricValue({} as never, {
        siteId: "site-1",
        metric: "sessions",
        window: "last_1h",
        now: 3_600,
      }),
    ).resolves.toMatchObject({
      metric: "sessions",
      window: "last_1h",
      value: 55,
      range: { from: 0, to: 3_600 },
    });
  });

  it("reuses overview queries only within the same invocation and window", async () => {
    queryOverviewAggregate.mockResolvedValue({
      value: { views: 100, visitors: 40, sessions: 55 },
    });
    const cache = createNotificationInvocationCache();

    await Promise.all([
      loadMetricValue({} as never, {
        siteId: "site-1",
        metric: "views",
        window: "last_24h",
        now: 86_400,
        cache,
      }),
      loadMetricValue({} as never, {
        siteId: "site-1",
        metric: "visitors",
        window: "last_24h",
        now: 86_400,
        cache,
      }),
      loadMetricValue({} as never, {
        siteId: "site-1",
        metric: "views",
        window: "last_24h",
        now: 86_400,
        cache,
      }),
    ]);

    expect(queryOverviewAggregate).toHaveBeenCalledTimes(1);

    await loadMetricValue({} as never, {
      siteId: "site-2",
      metric: "views",
      window: "last_24h",
      now: 86_400,
      cache,
    });
    await loadMetricValue({} as never, {
      siteId: "site-1",
      metric: "views",
      window: "last_1h",
      now: 86_400,
      cache,
    });

    expect(queryOverviewAggregate).toHaveBeenCalledTimes(3);
  });

  it("caches reports, previous windows, cumulative values, and last-seen data", async () => {
    queryOverviewAggregate.mockResolvedValue({
      value: { views: 100, visitors: 40, sessions: 55 },
    });
    queryPagesAggregate.mockResolvedValue([]);
    queryReferrerAggregate.mockResolvedValue([]);
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(() =>
          Promise.resolve({ name: "Demo", domain: "example.test" }),
        ),
      })),
    }));
    const env = { DB: { prepare } };
    const cache = createNotificationInvocationCache();

    const reportInput = {
      siteId: "site-1",
      now: Date.UTC(2026, 5, 30, 12) / 1000,
      timezone: "UTC",
      cache,
    };
    await Promise.all([
      loadDailyReportData(env as never, reportInput),
      loadDailyReportData(env as never, reportInput),
    ]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(queryPagesAggregate).toHaveBeenCalledTimes(1);
    expect(queryReferrerAggregate).toHaveBeenCalledTimes(1);

    await Promise.all([
      loadPreviousMetricValue({} as never, {
        siteId: "site-1",
        metric: "views",
        window: "last_24h",
        now: 86_400,
        cache,
      }),
      loadPreviousMetricValue({} as never, {
        siteId: "site-1",
        metric: "visitors",
        window: "last_24h",
        now: 86_400,
        cache,
      }),
      loadCumulativeMetricValue({} as never, {
        siteId: "site-1",
        metric: "sessions",
        now: 86_400,
        cache,
      }),
    ]);
    expect(queryOverviewAggregate).toHaveBeenCalledTimes(3);

    const lastSeenEnv = envWithLastSeen(1_800_000_123_000).env;
    const lastSeenCache = createNotificationInvocationCache();
    await Promise.all([
      loadSiteLastSeenAt(lastSeenEnv as never, "site-1", lastSeenCache),
      loadSiteLastSeenAt(lastSeenEnv as never, "site-1", lastSeenCache),
    ]);
    expect(lastSeenEnv.DB.prepare).toHaveBeenCalledTimes(1);
  });

  it("does not retain a rejected cache entry", async () => {
    const cache = new Map<string, Promise<number>>();
    const failure = Promise.reject(new Error("temporary"));
    await expect(
      getOrCreateCachedPromise(cache, "key", () => failure),
    ).rejects.toThrow("temporary");
    await Promise.resolve();
    expect(cache).toHaveLength(0);
  });

  it("queries the current visits table when loading site last seen time", async () => {
    const { env, bind } = envWithLastSeen(1_800_000_123_000);

    await expect(loadSiteLastSeenAt(env as never, "site-1")).resolves.toBe(
      1_800_000_123,
    );
    expect(bind).toHaveBeenCalledWith("site-1");
    expect(env.DB.prepare).toHaveBeenCalledWith(
      expect.stringContaining("FROM visits"),
    );
    expect(env.DB.prepare).not.toHaveBeenCalledWith(
      expect.stringContaining("visits_archive"),
    );
  });

  it("returns the latest visits timestamp in seconds", async () => {
    const { env } = envWithLastSeen(1_800_000_100_000);

    await expect(loadSiteLastSeenAt(env as never, "site-1")).resolves.toBe(
      1_800_000_100,
    );
  });

  it("returns null when the site has no visits", async () => {
    const { env } = envWithLastSeen(null);

    await expect(
      loadSiteLastSeenAt(env as never, "site-1"),
    ).resolves.toBeNull();
  });
});
