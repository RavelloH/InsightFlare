import { beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateNotificationRule } from "@/lib/notifications/edge/evaluator";
import type { NotificationRule } from "@/lib/notifications/edge/rule-store";

const loadReportData = vi.hoisted(() => vi.fn());
const loadMetricValue = vi.hoisted(() => vi.fn());
const loadPreviousMetricValue = vi.hoisted(() => vi.fn());
const loadCumulativeMetricValue = vi.hoisted(() => vi.fn());
const loadSiteInfo = vi.hoisted(() => vi.fn());
const loadSiteLastSeenAt = vi.hoisted(() => vi.fn());

vi.mock("@/lib/notifications/edge/report-data", () => ({
  loadReportData,
  loadMetricValue,
  loadPreviousMetricValue,
  loadCumulativeMetricValue,
  loadSiteInfo,
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

const RANGE = { from: 100, to: 200 };

function evaluate(input: Partial<NotificationRule>, now = 1_000) {
  return evaluateNotificationRule({} as never, rule(input), now);
}

describe("notification evaluator branches", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    loadSiteInfo.mockResolvedValue({ name: "Example", domain: "example.com" });
    loadMetricValue.mockResolvedValue({ value: 50, range: RANGE });
    loadPreviousMetricValue.mockResolvedValue({
      value: 25,
      range: { from: 0, to: 100 },
    });
  });

  it("skips unsupported rule types with a clamped type name", async () => {
    const result = await evaluate({ type: "x".repeat(100) as never });
    expect(result).toEqual({
      status: "skipped",
      reason: `unsupported_rule_type:${"x".repeat(60)}`,
    });
  });

  describe("report rules", () => {
    it("skips without a site id", async () => {
      expect(await evaluate({ type: "report", siteId: null })).toEqual({
        status: "skipped",
        reason: "missing_site_id",
      });
      expect(loadReportData).not.toHaveBeenCalled();
    });

    it("skips when the report data cannot be loaded", async () => {
      loadReportData.mockResolvedValue(null);
      expect(await evaluate({ type: "report" })).toEqual({
        status: "skipped",
        reason: "site_not_found",
      });
    });

    it.each([
      ["weekly", "weekly"],
      ["quarterly", "quarterly"],
      ["yearly", "yearly"],
      ["bogus", "daily"],
    ])("labels %s reports as %s", async (reportType, label) => {
      loadReportData.mockResolvedValue({
        siteName: "Example",
        siteDomain: "",
        reportType,
        range: { from: 1, to: 2, label: "range" },
        metrics: { views: 1, visitors: 2, sessions: 3 },
        topPages: [],
        topReferrers: [],
      });

      const result = await evaluate({
        type: "report",
        condition: { reportType },
      });

      expect(result.status).toBe("triggered");
      if (result.status !== "triggered") return;
      expect(result.message.title).toBe(`Example ${label} traffic report`);
      expect(result.message.bodyText).toContain(`${label} traffic report`);
      expect(result.message.bodyText).toContain("No page data.");
      expect(result.message.bodyText).toContain("No referrer data.");
      // Non-timezone schedules fall back to an undefined timezone.
      expect(loadReportData.mock.calls[0]?.[1].timezone).toBeUndefined();
    });
  });

  describe("threshold rules", () => {
    it("skips without a site id or when the site is missing", async () => {
      expect(await evaluate({ siteId: null })).toMatchObject({
        reason: "missing_site_id",
      });
      loadSiteInfo.mockResolvedValue(null);
      expect(await evaluate({})).toMatchObject({ reason: "site_not_found" });
    });

    it.each([
      [{ metric: "bad", window: "last_1h", operator: ">", value: 1 }, "metric"],
      [{ metric: "views", window: "bad", operator: ">", value: 1 }, "window"],
      [
        { metric: "views", window: "last_1h", operator: "!=", value: 1 },
        "operator",
      ],
      [
        { metric: "views", window: "last_1h", operator: ">", value: "abc" },
        "value",
      ],
    ])("reports which single condition field is invalid (%#)", async (c, f) => {
      expect(await evaluate({ condition: c })).toEqual({
        status: "skipped",
        reason: `invalid_${f}`,
      });
    });

    it("reports invalid_condition when several conditions include a bad one", async () => {
      const result = await evaluate({
        condition: {
          conditions: [
            { metric: "views", window: "last_1h", operator: ">", value: 1 },
            { metric: "nope" },
          ],
        },
      });
      expect(result).toEqual({
        status: "skipped",
        reason: "invalid_condition",
      });
    });

    it("supports `any` arrays and `all` arrays, ignoring non-record entries", async () => {
      loadMetricValue
        .mockResolvedValueOnce({ value: 5, range: RANGE })
        .mockResolvedValueOnce({ value: 500, range: RANGE });
      const anyResult = await evaluate({
        condition: {
          any: [
            { metric: "views", window: "last_1h", operator: ">", value: 100 },
            "junk",
            {
              metric: "visitors",
              window: "last_24h",
              operator: ">=",
              value: 100,
            },
          ],
        },
      });
      expect(anyResult.status).toBe("triggered");
      if (anyResult.status === "triggered") {
        expect(anyResult.message.summary).toMatch(/^ANY threshold matched/);
        expect(anyResult.data?.combinator).toBe("any");
      }

      loadMetricValue.mockResolvedValue({ value: 5, range: RANGE });
      const allResult = await evaluate({
        condition: {
          all: [
            { metric: "views", window: "last_1h", operator: "<", value: 10 },
            null,
          ],
        },
      });
      expect(allResult.status).toBe("triggered");
    });

    it("uses `combinator: any` and an `all` of nothing never triggers", async () => {
      loadMetricValue
        .mockResolvedValueOnce({ value: 1, range: RANGE })
        .mockResolvedValueOnce({ value: 99, range: RANGE });
      const result = await evaluate({
        condition: {
          combinator: "any",
          cooldownMinutes: 5,
          conditions: [
            { metric: "views", window: "yesterday", operator: ">", value: 10 },
            { metric: "views", window: "yesterday", operator: ">", value: 10 },
          ],
        },
      });
      expect(result.status).toBe("triggered");
      if (result.status === "triggered") {
        expect(result.cooldownUntil).toBe(1_000 + 5 * 60);
      }

      const empty = await evaluate({ condition: { all: [] } });
      expect(empty).toMatchObject({ status: "checked", triggered: false });
    });
  });

  describe("change rules", () => {
    const change = {
      metric: "views",
      window: "last_24h",
      mode: "percent",
      operator: ">=",
      value: 50,
    };

    it("skips without a site id or when the site is missing", async () => {
      expect(await evaluate({ type: "change", siteId: null })).toMatchObject({
        reason: "missing_site_id",
      });
      loadSiteInfo.mockResolvedValue(null);
      expect(await evaluate({ type: "change" })).toMatchObject({
        reason: "site_not_found",
      });
    });

    it.each([
      { ...change, metric: "bad" },
      { ...change, window: "bad" },
      { ...change, mode: "bad" },
      { ...change, operator: "??" },
      { ...change, value: "abc" },
    ])("rejects invalid change condition %#", async (condition) => {
      expect(await evaluate({ type: "change", condition })).toEqual({
        status: "skipped",
        reason: "invalid_condition",
      });
    });

    it("computes absolute and percent changes including a zero baseline", async () => {
      loadPreviousMetricValue.mockResolvedValue({
        value: 0,
        range: { from: 0, to: 100 },
      });
      const grown = await evaluate({
        type: "change",
        condition: { ...change, cooldownMinutes: 2 },
      });
      expect(grown.status).toBe("triggered");
      if (grown.status === "triggered") {
        expect(grown.data?.change).toBe(100);
        expect(grown.cooldownUntil).toBe(1_000 + 120);
        expect(grown.message.summary).toContain("changed 100%");
      }

      loadMetricValue.mockResolvedValue({ value: 0, range: RANGE });
      const flat = await evaluate({ type: "change", condition: change });
      expect(flat).toMatchObject({ status: "checked", triggered: false });
      if (flat.status === "checked") {
        expect(flat.data?.change).toBe(0);
        expect(flat.summary).toContain("Change conditions did not match");
      }
    });

    it("evaluates `any` change lists with absolute mode", async () => {
      const result = await evaluate({
        type: "change",
        condition: {
          any: [
            { ...change, mode: "absolute", operator: ">", value: 20 },
            { ...change, mode: "absolute", operator: "<", value: -20 },
          ],
        },
      });
      expect(result.status).toBe("triggered");
      if (result.status === "triggered") {
        expect(result.data?.combinator).toBe("any");
        expect(result.message.summary).toContain("changed 25 (25 to 50)");
      }
    });
  });

  describe("milestone rules", () => {
    const milestone = { metric: "views", step: 100 };

    it("skips on missing site, unknown site, bad metric and bad step", async () => {
      expect(await evaluate({ type: "milestone", siteId: null })).toMatchObject(
        { reason: "missing_site_id" },
      );
      loadSiteInfo.mockResolvedValueOnce(null);
      expect(
        await evaluate({ type: "milestone", condition: milestone }),
      ).toMatchObject({ reason: "site_not_found" });
      expect(
        await evaluate({
          type: "milestone",
          condition: { metric: "bad", step: 10 },
        }),
      ).toMatchObject({ reason: "invalid_metric" });
      expect(
        await evaluate({
          type: "milestone",
          condition: { metric: "views", step: 0 },
        }),
      ).toMatchObject({ reason: "invalid_step" });
    });

    it("falls back to `every`/`value` step keys and tracks buckets in state", async () => {
      loadCumulativeMetricValue.mockResolvedValue(1_234);
      const viaEvery = await evaluate({
        type: "milestone",
        condition: { metric: "visitors", every: 500 },
      });
      expect(viaEvery.status).toBe("triggered");
      if (viaEvery.status === "triggered") {
        expect(viaEvery.data?.bucket).toBe(1_000);
        expect(viaEvery.message.title).toBe(
          "example.com reached 1,000 visitors",
        );
        expect(viaEvery.state).toMatchObject({
          milestone: { visitors: { lastBucket: 1_000, lastValue: 1_234 } },
        });
      }

      const already = await evaluate({
        type: "milestone",
        condition: { metric: "visitors", value: 500 },
        state: { milestone: { visitors: { lastBucket: 1_000 } } },
      });
      expect(already).toMatchObject({ status: "checked", triggered: false });
      if (already.status === "checked") {
        expect(already.summary).toContain("has not crossed the next 500");
      }
    });
  });

  describe("health rules", () => {
    const health = { check: "no_data", hours: 2 };

    it("validates the check type and hours before touching the site", async () => {
      expect(
        await evaluate({ type: "health", condition: { check: "other" } }),
      ).toMatchObject({ reason: "unsupported_health_check" });
      expect(
        await evaluate({
          type: "health",
          condition: { check: "no_data", hours: -1 },
        }),
      ).toMatchObject({ reason: "invalid_hours" });
      expect(loadSiteInfo).not.toHaveBeenCalled();
    });

    it("skips when the site is missing", async () => {
      loadSiteInfo.mockResolvedValue(null);
      expect(
        await evaluate({ type: "health", condition: health }),
      ).toMatchObject({ reason: "site_not_found" });
    });

    it("triggers with last-seen details when data is stale", async () => {
      loadSiteLastSeenAt.mockResolvedValue(1_000);
      const result = await evaluate(
        { type: "health", condition: { ...health, cooldownMinutes: 1 } },
        1_000 + 2 * 3600,
      );
      expect(result.status).toBe("triggered");
      if (result.status === "triggered") {
        expect(result.message.summary).toContain("Please check whether");
        expect(result.message.bodyText).toContain(
          `Last seen: ${new Date(1_000 * 1000).toISOString()}`,
        );
        expect(result.cooldownUntil).toBe(1_000 + 2 * 3600 + 60);
      }
    });
  });
});
