import { describe, expect, it } from "vitest";

import {
  describeNotificationFormConditions,
  describeNotificationRuleCondition,
} from "@/lib/notifications/condition-description";

const copy = {
  metrics: { views: "Views", visitors: "Visitors", sessions: "Sessions" },
  windows: {
    last_1h: "last hour",
    last_24h: "last 24 hours",
    yesterday: "yesterday",
  },
  summaryConditionThreshold: "{window} {metric} {operator} {value}",
  summaryConditionChange: "{window} {metric} {mode} change {operator} {value}",
  conditionReport: "{period} report",
  summaryMilestoneCondition: "{metric} reaches every {step}",
  summaryHealthCondition: "No data for {hours} hours",
  reportPeriods: {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    yearly: "Yearly",
  },
  changeModeAbsolute: "absolute",
  changeModePercent: "percent",
} as never;

const terms = {
  and: "and",
  or: "or",
  not: "not ({description})",
  emptyConditions: "No conditions",
} as never;

describe("notification condition descriptions", () => {
  it("describes all and any metric condition trees", () => {
    expect(
      describeNotificationFormConditions(copy, terms, {
        type: "change",
        combinator: "all",
        conditions: [
          {
            metric: "visitors",
            window: "last_24h",
            operator: ">=",
            value: 1000,
          },
          {
            metric: "views",
            window: "last_1h",
            operator: ">",
            value: 20,
            changeMode: "percent",
          },
        ],
        reportType: "daily",
        metric: "visitors",
        milestoneStep: "0",
        hours: "0",
      }),
    ).toBe(
      "last 24 hours Visitors percent change >= 1000 and last hour Views percent change > 20",
    );

    expect(
      describeNotificationRuleCondition(copy, terms, "threshold", {
        any: [
          { metric: "visitors", window: "last_1h", operator: "<", value: 100 },
          {
            metric: "sessions",
            window: "yesterday",
            operator: "<",
            value: 500,
          },
        ],
      }),
    ).toBe("last hour Visitors < 100 or yesterday Sessions < 500");
  });

  it("describes non-metric notification conditions", () => {
    expect(
      describeNotificationRuleCondition(copy, terms, "milestone", {
        metric: "views",
        step: 1000,
      }),
    ).toBe("Views reaches every 1000");
    expect(
      describeNotificationRuleCondition(copy, terms, "health", { hours: 12 }),
    ).toBe("No data for 12 hours");
  });
});
