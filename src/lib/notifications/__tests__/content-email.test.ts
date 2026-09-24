import { describe, expect, it } from "vitest";

import {
  buildNotificationContent,
  formatNotificationNumber,
  notificationMetricLabel,
  notificationSiteName,
  notificationWindowLabel,
} from "@/lib/notifications/content";
import { renderNotificationEmailText } from "@/lib/notifications/email-text";
import { resolveNotificationLocale } from "@/lib/notifications/locale";
import type { NotificationMessage } from "@/lib/notifications/message";

function message(input: Partial<NotificationMessage>): NotificationMessage {
  return {
    id: "msg-1",
    teamId: "team-1",
    siteId: "site-1",
    userId: "user-1",
    ruleId: null,
    runId: null,
    batchId: null,
    type: "system",
    severity: "info",
    requiresAttention: false,
    title: "Fallback",
    summary: "Summary",
    bodyText: "Body",
    bodyHtml: "",
    data: {},
    channels: {},
    deliveryStatus: "created",
    deliveryResults: {},
    errorMessage: "",
    readAt: null,
    dismissedAt: null,
    archivedAt: null,
    triggeredAt: null,
    createdAt: 1,
    updatedAt: 1,
    sentAt: null,
    failedAt: null,
    expiresAt: null,
    ...input,
  };
}

describe("notification email content", () => {
  it("formats common labels and locale fallbacks", () => {
    expect(formatNotificationNumber(1234.9)).toBe("1,234");
    expect(formatNotificationNumber("bad")).toBe("0");
    expect(notificationSiteName({ domain: " example.test " })).toBe(
      "example.test",
    );
    expect(notificationSiteName({})).toBe("Site");
    expect(notificationMetricLabel("en", "bad")).toBe("views");
    expect(notificationWindowLabel("zh", "last_24h")).toBe("过去 24 小时");
    expect(resolveNotificationLocale("zh")).toBe("zh");
    expect(resolveNotificationLocale("")).toBe("en");
  });

  it("builds localized content for report, threshold, health, test, and fallback messages", () => {
    expect(
      buildNotificationContent({
        type: "test",
        severity: "info",
        locale: "en",
        data: {},
      }),
    ).toMatchObject({ subject: "InsightFlare notification test" });

    expect(
      buildNotificationContent({
        type: "report",
        severity: "info",
        locale: "en",
        data: {
          siteName: "Demo",
          range: { label: "2026-06-29" },
          metrics: { visitors: 12, views: 34 },
        },
      }),
    ).toMatchObject({
      subject: "Demo daily traffic report",
      summary: "2026-06-29: 12 visitors and 34 views.",
    });

    expect(
      buildNotificationContent({
        type: "threshold",
        severity: "warning",
        locale: "zh",
        data: {
          hostname: "demo.test",
          metric: "sessions",
          window: "yesterday",
          operator: ">",
          value: 20,
          target: 10,
        },
      }).summary,
    ).toContain("会话数");

    expect(
      buildNotificationContent({
        type: "health",
        severity: "critical",
        locale: "en",
        data: { siteDomain: "demo.test", hours: 12, lastSeenAt: null },
      }).summary,
    ).toContain("No historical traffic data");

    expect(
      buildNotificationContent({
        type: "change",
        severity: "info",
        locale: "en",
        data: {
          siteDomain: "demo.test",
          metric: "visitors",
          window: "last_24h",
          change: 52,
          mode: "percent",
        },
      }).summary,
    ).toContain("52%");

    expect(
      buildNotificationContent({
        type: "system",
        severity: "info",
        locale: "en",
        data: {},
        fallbackTitle: "Custom",
        fallbackSummary: "Custom summary",
        fallbackBodyText: "Custom body",
      }),
    ).toEqual({
      subject: "Custom",
      title: "Custom",
      summary: "Custom summary",
      bodyText: "Custom body",
    });
  });

  it("renders report, milestone, threshold, change, health, and fallback email text", () => {
    const reportContent = buildNotificationContent({
      type: "report",
      severity: "info",
      locale: "en",
      data: { siteName: "Demo", metrics: {} },
    });
    const reportText = renderNotificationEmailText({
      content: reportContent,
      locale: "en",
      message: message({
        type: "report",
        data: {
          range: { label: "2026-06-29" },
          metrics: { views: 100, visitors: 40, sessions: 50 },
          topPages: [{ path: "/docs", views: 20 }, null],
          topReferrers: [{ referrer: "", visits: 5 }],
        },
      }),
    });
    expect(reportText).toContain("1. /docs - 20 views");
    expect(reportText).toContain("1. Direct - 5 visits");

    const emptyReportText = renderNotificationEmailText({
      content: reportContent,
      locale: "zh",
      message: message({
        type: "report",
        data: { range: {}, metrics: {}, topPages: [], topReferrers: [] },
      }),
    });
    expect(emptyReportText).toContain("暂无页面数据");
    expect(emptyReportText).toContain("暂无来源数据");

    const thresholdContent = buildNotificationContent({
      type: "threshold",
      severity: "warning",
      locale: "en",
      data: {},
    });
    expect(
      renderNotificationEmailText({
        content: thresholdContent,
        locale: "en",
        message: message({
          type: "threshold",
          data: { metric: "visitors", window: "last_1h", value: 9, target: 10 },
        }),
      }),
    ).toContain("Metric: visitors");

    const milestoneContent = buildNotificationContent({
      type: "milestone",
      severity: "success",
      locale: "zh",
      data: {
        siteDomain: "demo.test",
        metric: "visitors",
        bucket: 50000,
        value: 50240,
      },
    });
    const milestoneText = renderNotificationEmailText({
      content: milestoneContent,
      locale: "zh",
      message: message({
        type: "milestone",
        data: { metric: "visitors", bucket: 50000, value: 50240 },
      }),
    });
    expect(milestoneText).toContain("指标：访客数");
    expect(milestoneText).toContain("里程碑：50,000");
    expect(milestoneText).toContain("当前值：50,240");

    const changeContent = buildNotificationContent({
      type: "change",
      severity: "warning",
      locale: "en",
      data: {
        siteDomain: "demo.test",
        metric: "visitors",
        window: "last_24h",
        previous: 920,
        current: 1860,
        change: 102.1,
        mode: "percent",
      },
    });
    const changeText = renderNotificationEmailText({
      content: changeContent,
      locale: "en",
      message: message({
        type: "change",
        data: {
          metric: "visitors",
          window: "last_24h",
          previous: 920,
          current: 1860,
          change: 102.1,
          mode: "percent",
        },
      }),
    });
    expect(changeText).toContain("Previous value: 920");
    expect(changeText).toContain("Current value: 1,860");
    expect(changeText).toContain("Change: 102%");

    const healthContent = buildNotificationContent({
      type: "health",
      severity: "critical",
      locale: "zh",
      data: { hours: 6, lastSeenAt: 1_800_000_000 },
    });
    expect(
      renderNotificationEmailText({
        content: healthContent,
        locale: "zh",
        message: message({
          type: "health",
          data: { lastSeenAt: 1_800_000_000 },
        }),
      }),
    ).toContain("最后收到数据：2027");

    expect(
      renderNotificationEmailText({
        content: { subject: "S", title: "T", summary: "S", bodyText: "B" },
        locale: "en",
        message: message({ type: "system", data: {} }),
      }),
    ).toBe("T\n\nB");
  });
});
