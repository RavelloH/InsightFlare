import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  compareThreshold,
  evaluateNotificationRule,
} from "@/lib/notifications/edge/evaluator";
import type { NotificationRule } from "@/lib/notifications/edge/rule-store";

const loadDailyReportData = vi.hoisted(() => vi.fn());
const loadReportData = vi.hoisted(() => vi.fn());
const loadMetricValue = vi.hoisted(() => vi.fn());
const loadPreviousMetricValue = vi.hoisted(() => vi.fn());
const loadCumulativeMetricValue = vi.hoisted(() => vi.fn());
const loadSiteLastSeenAt = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notifications/edge/report-data", () => ({
  loadDailyReportData,
  loadReportData,
  loadMetricValue,
  loadPreviousMetricValue,
  loadCumulativeMetricValue,
  loadSiteLastSeenAt,
}));

function rule(input: Partial<NotificationRule> = {}): NotificationRule {
  return {
    id: "rule-1",
    teamId: "team-1",
    siteId: "site-1",
    name: "Rule",
    description: "",
    type: "threshold",
    enabled: true,
    schedule: { kind: "interval", everyMinutes: 60 },
    condition: {},
    recipient: { mode: "team_admins" },
    state: {},
    lastCheckedAt: null,
    lastTriggeredAt: null,
    nextRunAt: null,
    cooldownUntil: null,
    createdByUserId: "user-1",
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

function envWithSite() {
  return {
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn(() =>
            Promise.resolve({ name: "Example", domain: "example.com" }),
          ),
        })),
      })),
    },
  };
}

describe("notification evaluator", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns a triggered draft for test rules", async () => {
    const result = await evaluateNotificationRule(
      {} as never,
      rule({ type: "test" }),
      100,
    );

    expect(result.status).toBe("triggered");
    if (result.status === "triggered") {
      expect(result.message.type).toBe("test");
      expect(result.message.requiresAttention).toBe(false);
    }
  });

  it("builds a daily report draft from report data", async () => {
    loadReportData.mockResolvedValue({
      siteName: "Example",
      siteDomain: "example.com",
      reportType: "daily",
      range: { from: 10, to: 20, label: "2026-06-29" },
      metrics: { views: 3820, visitors: 1240, sessions: 1510 },
      topPages: [{ path: "/", views: 1200 }],
      topReferrers: [{ referrer: "Google", visits: 520 }],
    });

    const result = await evaluateNotificationRule(
      {} as never,
      rule({
        type: "report",
        condition: { reportType: "daily" },
        schedule: { kind: "daily", time: "08:00", timezone: "Asia/Shanghai" },
      }),
      100,
    );

    expect(result.status).toBe("triggered");
    if (result.status === "triggered") {
      expect(result.message.type).toBe("report");
      expect(result.message.summary).toContain("1,240 visitors");
      expect(result.message.bodyText).toContain("Top Pages");
    }
  });

  it("builds report drafts for non-daily report types", async () => {
    loadReportData.mockResolvedValue({
      siteName: "Example",
      siteDomain: "example.com",
      reportType: "monthly",
      range: { from: 10, to: 20, label: "2026-05" },
      metrics: { views: 3820, visitors: 1240, sessions: 1510 },
      topPages: [],
      topReferrers: [],
    });

    const result = await evaluateNotificationRule(
      {} as never,
      rule({
        type: "report",
        condition: { reportType: "monthly" },
        schedule: {
          kind: "monthly",
          time: "08:00",
          timezone: "UTC",
          dayOfMonth: 1,
        },
      }),
      100,
    );

    expect(result.status).toBe("triggered");
    if (result.status === "triggered") {
      expect(result.message.data?.reportType).toBe("monthly");
      expect(result.message.title).toContain("monthly traffic report");
    }
  });

  it("triggers threshold rules when the metric matches", async () => {
    loadMetricValue.mockResolvedValue({
      metric: "visitors",
      window: "last_1h",
      value: 1240,
      range: { from: 1, to: 2 },
    });

    const result = await evaluateNotificationRule(
      envWithSite() as never,
      rule({
        condition: {
          metric: "visitors",
          window: "last_1h",
          operator: ">=",
          value: 1000,
          cooldownMinutes: 360,
        },
      }),
      1000,
    );

    expect(result.status).toBe("triggered");
    if (result.status === "triggered") {
      expect(result.message.type).toBe("threshold");
      expect(result.message.severity).toBe("warning");
      expect(result.cooldownUntil).toBe(22600);
      expect(result.state?.threshold).toMatchObject({
        lastTriggerKey: expect.stringContaining("threshold|"),
      });
    }
  });

  it("does not repeat threshold triggers for the same evaluated window", async () => {
    loadMetricValue.mockResolvedValue({
      metric: "visitors",
      window: "last_1h",
      value: 1240,
      range: { from: 1, to: 2 },
    });

    const result = await evaluateNotificationRule(
      envWithSite() as never,
      rule({
        condition: {
          metric: "visitors",
          window: "last_1h",
          operator: ">=",
          value: 1000,
        },
        state: {
          threshold: {
            lastTriggerKey: "threshold|all|visitors:last_1h:>=:1000:1:2",
          },
        },
      }),
      1000,
    );

    expect(result).toMatchObject({
      status: "checked",
      triggered: false,
    });
  });

  it("returns checked when threshold rules do not match", async () => {
    loadMetricValue.mockResolvedValue({
      metric: "views",
      window: "last_24h",
      value: 50,
      range: { from: 1, to: 2 },
    });

    const result = await evaluateNotificationRule(
      envWithSite() as never,
      rule({
        condition: {
          metric: "views",
          window: "last_24h",
          operator: ">",
          value: 100,
        },
      }),
      1000,
    );

    expect(result).toMatchObject({
      status: "checked",
      triggered: false,
    });
  });

  it("skips invalid threshold configuration", async () => {
    const result = await evaluateNotificationRule(
      envWithSite() as never,
      rule({
        condition: {
          metric: "unknown",
          window: "last_1h",
          operator: ">=",
          value: 1000,
        },
      }),
      1000,
    );

    expect(result).toMatchObject({
      status: "skipped",
      reason: "invalid_metric",
    });
  });

  it("skips health rules without a site", async () => {
    const result = await evaluateNotificationRule(
      {} as never,
      rule({
        type: "health",
        siteId: null,
        condition: { check: "no_data", hours: 12 },
      }),
      1000,
    );

    expect(result).toMatchObject({
      status: "skipped",
      reason: "missing_site_id",
    });
  });

  it("triggers health when no history exists", async () => {
    loadSiteLastSeenAt.mockResolvedValue(null);

    const result = await evaluateNotificationRule(
      envWithSite() as never,
      rule({
        type: "health",
        condition: { check: "no_data", hours: 12 },
      }),
      1000,
    );

    expect(result.status).toBe("triggered");
    if (result.status === "triggered") {
      expect(result.message.type).toBe("health");
      expect(result.message.severity).toBe("critical");
    }
  });

  it("does not trigger health when data is recent", async () => {
    loadSiteLastSeenAt.mockResolvedValue(900);

    const result = await evaluateNotificationRule(
      envWithSite() as never,
      rule({
        type: "health",
        condition: { check: "no_data", hours: 1 },
      }),
      1000,
    );

    expect(result).toMatchObject({
      status: "checked",
      triggered: false,
    });
  });

  it("compares supported threshold operators", () => {
    expect(compareThreshold(10, ">", 9)).toBe(true);
    expect(compareThreshold(10, ">=", 10)).toBe(true);
    expect(compareThreshold(10, "<", 11)).toBe(true);
    expect(compareThreshold(10, "<=", 10)).toBe(true);
  });

  it("triggers milestone rules once per crossed bucket", async () => {
    loadCumulativeMetricValue.mockResolvedValue(2500);

    const result = await evaluateNotificationRule(
      envWithSite() as never,
      rule({
        type: "milestone",
        condition: { metric: "visitors", step: 1000 },
        state: { milestone: { visitors: { lastBucket: 1000 } } },
      }),
      1000,
    );

    expect(result.status).toBe("triggered");
    if (result.status === "triggered") {
      expect(result.state?.milestone).toMatchObject({
        visitors: { lastBucket: 2000 },
      });
    }
  });

  it("triggers change rules against the previous period", async () => {
    loadMetricValue.mockResolvedValue({
      metric: "visitors",
      window: "last_24h",
      value: 200,
      range: { from: 2, to: 3 },
    });
    loadPreviousMetricValue.mockResolvedValue({
      metric: "visitors",
      window: "last_24h",
      value: 100,
      range: { from: 1, to: 2 },
    });

    const result = await evaluateNotificationRule(
      envWithSite() as never,
      rule({
        type: "change",
        condition: {
          any: [
            {
              metric: "visitors",
              window: "last_24h",
              mode: "percent",
              operator: ">=",
              value: 50,
            },
          ],
        },
      }),
      1000,
    );

    expect(result.status).toBe("triggered");
    if (result.status === "triggered") {
      expect(result.message.type).toBe("change");
      expect(result.message.data?.change).toBe(100);
      expect(result.state?.change).toMatchObject({
        lastTriggerKey: expect.stringContaining("change|"),
      });
    }
  });

  it("does not repeat change triggers for the same compared windows", async () => {
    loadMetricValue.mockResolvedValue({
      metric: "visitors",
      window: "last_24h",
      value: 200,
      range: { from: 2, to: 3 },
    });
    loadPreviousMetricValue.mockResolvedValue({
      metric: "visitors",
      window: "last_24h",
      value: 100,
      range: { from: 1, to: 2 },
    });

    const result = await evaluateNotificationRule(
      envWithSite() as never,
      rule({
        type: "change",
        condition: {
          any: [
            {
              metric: "visitors",
              window: "last_24h",
              mode: "percent",
              operator: ">=",
              value: 50,
            },
          ],
        },
        state: {
          change: {
            lastTriggerKey:
              "change|any|visitors:last_24h:percent:>=:50:2:3:1:2",
          },
        },
      }),
      1000,
    );

    expect(result).toMatchObject({
      status: "checked",
      triggered: false,
    });
  });
});
