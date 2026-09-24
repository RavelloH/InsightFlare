import { describe, expect, it } from "vitest";

import {
  browserDefaultTimeZone,
  buildRulePayload,
  conditionLabel,
  cooldownLabel,
  defaultMetricCondition,
  defaultName,
  defaultRecipientUserIds,
  EMPTY_FORM,
  formatRunAt,
  inferFormFromRule,
  isCoolingDown,
  isReportType,
  isScheduleKind,
  memberName,
  nextConditionId,
  nextRunLabel,
  previewSummary,
  recipientLabel,
  recipientTextFromForm,
  REPORT_TYPES,
  ruleSummaryLines,
  ruleSummaryTitle,
  ruleTypeLabel,
  scheduleKindFromReportType,
  scheduleLabel,
  scheduleTextFromForm,
  siteLabel,
  TIME_OPTIONS,
  WEEK_DAY_INDEXES,
} from "@/components/dashboard/admin/team-notifications/model";
import type {
  MemberData,
  NotificationRuleData,
  NotificationRuleEvaluationData,
  SiteData,
} from "@/lib/dashboard-api/client/edge";
import type { AppMessages } from "@/lib/i18n/messages";

const copy = {
  nextRunStates: {
    disabled: "disabled",
    coolingDown: "cooldown",
    dueNow: "due",
  },
  scheduleDaily: "Daily {time}",
  scheduleWeekly: "Weekly {day} {time}",
  scheduleMonthly: "Monthly {day} {time}",
  scheduleQuarterly: "Quarterly {day} {time}",
  scheduleYearly: "Yearly {month}/{day} {time}",
  scheduleInterval: "Every {minutes} minutes",
  scheduleCustom: "Custom",
  weekDays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  ruleTypes: {
    report: "Report",
    milestone: "Milestone",
    threshold: "Threshold",
    change: "Change",
    health: "Health",
  },
  recipientModes: {
    creator: "Creator",
    all_team_members: "Everyone",
    team_admins: "Admins",
    users: "Selected users",
  },
  customRecipientsEmpty: "No recipients",
  cooldownUnits: { minutes: "minutes", hours: "hours", days: "days" },
  siteLabel: "Site",
  defaultNames: {
    report: "{site} report",
    milestone: "{site} milestone",
    threshold: "{site} threshold",
    change: "{site} change",
    health: "{site} health",
  },
  summaryReportSchedule: "{period}: {schedule}",
  reportPeriods: {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    quarterly: "Quarterly",
    yearly: "Yearly",
  },
  summaryWhenConditions: "{combinator} {type}",
  summaryWhenSingleCondition: "{type}",
  matchAny: "any",
  matchAll: "all",
  metrics: { views: "views", visitors: "visitors", sessions: "sessions" },
  windows: {
    last_1h: "last hour",
    last_24h: "last day",
    yesterday: "yesterday",
  },
  summaryConditionChange: "{metric} {operator} {value} {mode} {window}",
  summaryConditionThreshold: "{metric} {operator} {value} {window}",
  changeModeAbsolute: "absolute",
  changeModePercent: "percent",
  conditionReport: "{period} report",
  summaryMilestoneCondition: "{metric} every {step}",
  summaryHealthCondition: "No data for {hours} hours",
} as unknown as AppMessages["teamManagement"]["notifications"];

const terms = {
  emptyConditions: "No conditions",
  and: " AND ",
  or: " OR ",
  not: "NOT ({description})",
} as unknown as AppMessages["conditionDescription"];

const rule = (overrides: Record<string, unknown> = {}): NotificationRuleData =>
  ({
    id: "r1",
    name: "",
    type: "report",
    siteId: "s1",
    enabled: true,
    schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
    condition: { reportType: "daily" },
    recipient: { mode: "creator" },
    nextRunAt: null,
    cooldownUntil: null,
    ...overrides,
  }) as unknown as NotificationRuleData;

const members = [
  { userId: "u1", name: "Ada", username: "ada", email: "ada@example.test" },
  { userId: "u2", name: "", username: "grace", email: "grace@example.test" },
] as MemberData[];

const sites = [
  { id: "s1", name: "Example", domain: "example.test" },
] as SiteData[];

describe("team notification rule model", () => {
  it("normalizes basic schedule, recipient, and display helpers", () => {
    expect(defaultMetricCondition()).toMatchObject({
      id: "condition-1",
      metric: "visitors",
    });
    expect(defaultMetricCondition("c2").id).toBe("c2");
    expect(nextConditionId([])).toMatch(/^condition-\d+-1$/);
    expect(TIME_OPTIONS).toHaveLength(48);
    expect(WEEK_DAY_INDEXES).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(REPORT_TYPES).toEqual([
      "daily",
      "weekly",
      "monthly",
      "quarterly",
      "yearly",
    ]);
    expect(scheduleKindFromReportType("weekly")).toBe("weekly");
    expect(isScheduleKind("interval")).toBe(true);
    expect(isScheduleKind("custom")).toBe(false);
    expect(isReportType("yearly")).toBe(true);
    expect(isReportType("interval")).toBe(false);
    expect(formatRunAt("en", null)).toBe("-");
    expect(formatRunAt("en", 1)).not.toBe("-");
    expect(browserDefaultTimeZone()).toBeTruthy();

    expect(isCoolingDown(rule({ cooldownUntil: 101 }), 100)).toBe(true);
    expect(isCoolingDown(rule({ cooldownUntil: 100 }), 100)).toBe(false);
    expect(nextRunLabel(copy, "en", rule({ enabled: false }), 100)).toBe(
      "disabled",
    );
    expect(nextRunLabel(copy, "en", rule({ cooldownUntil: 101 }), 100)).toBe(
      "cooldown",
    );
    expect(nextRunLabel(copy, "en", rule({ nextRunAt: 99 }), 100)).toBe("due");
    expect(nextRunLabel(copy, "en", rule({ nextRunAt: 1000 }), 100)).not.toBe(
      "due",
    );

    expect(
      scheduleLabel(copy, rule({ schedule: { kind: "daily", time: "08:30" } })),
    ).toBe("Daily 08:30");
    expect(
      scheduleLabel(
        copy,
        rule({ schedule: { kind: "weekly", dayOfWeek: 1, time: "09:00" } }),
      ),
    ).toBe("Weekly Mon 09:00");
    expect(
      scheduleLabel(
        copy,
        rule({ schedule: { kind: "monthly", dayOfMonth: 2, time: "10:00" } }),
      ),
    ).toBe("Monthly 2 10:00");
    expect(
      scheduleLabel(
        copy,
        rule({ schedule: { kind: "quarterly", dayOfMonth: 3, time: "11:00" } }),
      ),
    ).toBe("Quarterly 3 11:00");
    expect(
      scheduleLabel(
        copy,
        rule({
          schedule: { kind: "yearly", month: 4, dayOfMonth: 5, time: "12:00" },
        }),
      ),
    ).toBe("Yearly 4/5 12:00");
    expect(
      scheduleLabel(
        copy,
        rule({ schedule: { kind: "interval", everyMinutes: 15 } }),
      ),
    ).toBe("Every 15 minutes");
    expect(scheduleLabel(copy, rule({ schedule: { kind: "other" } }))).toBe(
      "Custom",
    );

    expect(memberName(undefined)).toBe("");
    expect(memberName(members[0])).toBe("Ada");
    expect(memberName(members[1])).toBe("grace");
    expect(
      memberName({
        userId: "u3",
        name: "",
        username: "",
        email: "e@x",
      } as MemberData),
    ).toBe("e@x");
    expect(defaultRecipientUserIds(members, "u2")).toEqual(["u2"]);
    expect(defaultRecipientUserIds(members, "missing")).toEqual(["u1"]);
    expect(defaultRecipientUserIds([], "missing")).toEqual([]);
    expect(
      recipientLabel(
        copy,
        { mode: "users", userIds: ["u1", "missing"] },
        new Map(members.map((item) => [item.userId, item])),
      ),
    ).toBe("Ada, missing");
    expect(
      recipientLabel(copy, { mode: "users", userIds: [] }, new Map()),
    ).toBe("Selected users");
    expect(recipientLabel(copy, { mode: "creator" }, new Map())).toBe(
      "Creator",
    );
    expect(recipientLabel(copy, { mode: "unknown" }, new Map())).toBe("Admins");
    expect(recipientTextFromForm(copy, EMPTY_FORM, new Map())).toBe("Creator");
    expect(
      recipientTextFromForm(
        copy,
        { ...EMPTY_FORM, recipientKind: "custom" },
        new Map(),
      ),
    ).toBe("No recipients");
    expect(
      recipientTextFromForm(
        copy,
        { ...EMPTY_FORM, recipientKind: "custom", recipientUserIds: ["u1"] },
        new Map(members.map((item) => [item.userId, item])),
      ),
    ).toBe("Ada");
    expect(siteLabel(new Map([["s1", sites[0]!]]), "s1")).toBe(
      "Example (example.test)",
    );
    expect(siteLabel(new Map(), "s2")).toBe("s2");
    expect(siteLabel(new Map(), null)).toBe("-");
    expect(previewSummary(null)).toBe("");
    expect(
      previewSummary({
        status: "triggered",
        message: { summary: "hit" },
      } as NotificationRuleEvaluationData),
    ).toBe("hit");
    expect(
      previewSummary({
        status: "checked",
        summary: "checked",
      } as NotificationRuleEvaluationData),
    ).toBe("checked");
    expect(
      previewSummary({
        status: "skipped",
        reason: "quiet",
      } as NotificationRuleEvaluationData),
    ).toBe("quiet");
  });

  it("round-trips rule forms and emits each schedule and condition payload", () => {
    const inferred = inferFormFromRule(
      rule({
        type: "threshold",
        enabled: false,
        schedule: { kind: "weekly", dayOfWeek: 2, time: "12:00" },
        condition: {
          any: [
            {
              metric: "views",
              window: "yesterday",
              operator: "<",
              value: 5,
              mode: "absolute",
            },
          ],
          cooldownMinutes: 2880,
        },
        recipient: { mode: "users", userIds: ["u1"] },
      }),
    );
    expect(inferred).toMatchObject({
      type: "threshold",
      enabled: false,
      scheduleKind: "weekly",
      combinator: "any",
      recipientKind: "custom",
      recipientUserIds: ["u1"],
      cooldownValue: "2",
      cooldownUnit: "days",
      conditions: [
        {
          metric: "views",
          window: "yesterday",
          operator: "<",
          changeMode: "absolute",
        },
      ],
    });
    expect(
      inferFormFromRule(
        rule({ type: "invalid", schedule: { kind: "bad" }, condition: {} }),
      ),
    ).toMatchObject({
      type: "report",
      scheduleKind: "interval",
      reportType: "daily",
    });
    expect(
      inferFormFromRule(rule({ condition: { all: [], cooldownMinutes: 90 } })),
    ).toMatchObject({ cooldownValue: "90", cooldownUnit: "minutes" });

    expect(defaultName(copy, "report", sites[0])).toBe("Example report");
    expect(defaultName(copy, "health")).toBe("Site health");
    expect(
      scheduleTextFromForm(copy, { ...EMPTY_FORM, scheduleKind: "daily" }, 0),
    ).toContain("Daily 08:00");
    expect(
      scheduleTextFromForm(
        copy,
        { ...EMPTY_FORM, scheduleKind: "weekly", dayOfWeek: "6" },
        0,
      ),
    ).toContain("Weekly Sat 08:00");
    expect(
      scheduleTextFromForm(
        copy,
        { ...EMPTY_FORM, scheduleKind: "monthly", dayOfMonth: "10" },
        0,
      ),
    ).toContain("Monthly 10 08:00");
    expect(
      scheduleTextFromForm(
        copy,
        { ...EMPTY_FORM, scheduleKind: "quarterly" },
        0,
      ),
    ).toContain("Quarterly");
    expect(
      scheduleTextFromForm(copy, { ...EMPTY_FORM, scheduleKind: "yearly" }, 0),
    ).toContain("Yearly");
    expect(
      scheduleTextFromForm(
        copy,
        { ...EMPTY_FORM, scheduleKind: "interval", everyMinutes: "15" },
        0,
      ),
    ).toBe("Every 15 minutes");

    const base = { ...EMPTY_FORM, siteId: "s1", name: "  " };
    for (const type of [
      "report",
      "milestone",
      "threshold",
      "change",
      "health",
    ] as const) {
      for (const scheduleKind of [
        "daily",
        "weekly",
        "monthly",
        "quarterly",
        "yearly",
        "interval",
      ] as const) {
        const form = {
          ...base,
          type,
          scheduleKind,
          conditions: [defaultMetricCondition("c1")],
          cooldownValue: "2",
          cooldownUnit: "hours" as const,
        };
        const payload = buildRulePayload(copy, form, sites);
        expect(payload.type).toBe(type);
        expect(payload.name).toBe(`Example ${type}`);
        expect(payload.schedule.kind).toBe(scheduleKind);
        expect(payload.recipient.mode).toBe("creator");
        if (type === "threshold" || type === "change" || type === "health") {
          expect(payload.condition).toHaveProperty("cooldownMinutes", 120);
        }
      }
    }
    const custom = buildRulePayload(
      copy,
      {
        ...base,
        name: "Named",
        recipientKind: "custom",
        recipientUserIds: ["u2"],
      },
      sites,
    );
    expect(custom).toMatchObject({
      name: "Named",
      recipient: { mode: "users", userIds: ["u2"] },
    });
    expect(
      conditionLabel(
        copy,
        terms,
        rule({ condition: { reportType: "weekly" } }),
      ),
    ).toContain("Weekly report");
    const form = { ...EMPTY_FORM, type: "threshold" as const };
    expect(ruleSummaryLines(copy, terms, form)).toHaveLength(1);
    expect(ruleSummaryTitle(copy, form, 0)).toContain("all Threshold");
    expect(ruleSummaryTitle(copy, { ...form, type: "report" }, 0)).toContain(
      "Daily",
    );
    expect(ruleSummaryTitle(copy, { ...form, type: "milestone" }, 0)).toBe(
      "Milestone",
    );
  });
});
