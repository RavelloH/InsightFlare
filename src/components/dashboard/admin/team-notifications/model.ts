import {
  formatUtcOffset,
  timeZoneOffsetMinutes,
} from "@/lib/analytics/time-zone";
import { shortDateTime } from "@/lib/dashboard/format";
import type { TeamNotificationsInitialData } from "@/lib/dashboard/management-data";
import { browserTimeZone } from "@/lib/dashboard/time-zone";
import {
  type MemberData,
  type NotificationRuleData,
  type NotificationRuleEvaluationData,
  type SiteData,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import {
  describeNotificationFormConditions,
  describeNotificationRuleCondition,
} from "@/lib/notifications/condition-description";
export interface TeamNotificationsClientProps {
  locale: Locale;
  messages: AppMessages;
  teamId: string;
  teamSlug: string;
  currentUserId: string;
  initialData?: TeamNotificationsInitialData | null;
}
export type RuleFormType =
  "report" | "milestone" | "threshold" | "change" | "health";
type RecipientKind = "preset" | "custom";
type RecipientPreset = "creator" | "team_admins" | "all_team_members";
type ScheduleKind =
  "daily" | "weekly" | "monthly" | "quarterly" | "yearly" | "interval";
type ReportType = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";
type ConditionCombinator = "all" | "any";
type ChangeMode = "absolute" | "percent";
type MetricName = "views" | "visitors" | "sessions";
type MetricWindow = "last_1h" | "last_24h" | "yesterday";
type ThresholdOperator = ">" | ">=" | "<" | "<=";
type CooldownUnit = "minutes" | "hours" | "days";
export interface MetricConditionForm {
  id: string;
  metric: MetricName;
  window: MetricWindow;
  operator: ThresholdOperator;
  value: string;
  changeMode: ChangeMode;
}
export interface RuleFormState {
  id: string;
  name: string;
  type: RuleFormType;
  siteId: string;
  enabled: boolean;
  recipientKind: RecipientKind;
  recipientPreset: RecipientPreset;
  recipientUserIds: string[];
  scheduleKind: ScheduleKind;
  reportType: ReportType;
  time: string;
  timezone: string;
  dayOfWeek: string;
  dayOfMonth: string;
  month: string;
  everyMinutes: string;
  combinator: ConditionCombinator;
  conditions: MetricConditionForm[];
  metric: MetricName;
  milestoneStep: string;
  cooldownValue: string;
  cooldownUnit: CooldownUnit;
  hours: string;
}
export function defaultMetricCondition(
  id = "condition-1",
): MetricConditionForm {
  return {
    id,
    metric: "visitors",
    window: "last_1h",
    operator: ">=",
    value: "1000",
    changeMode: "percent",
  };
}
export const EMPTY_FORM: RuleFormState = {
  id: "",
  name: "",
  type: "report",
  siteId: "",
  enabled: true,
  recipientKind: "preset",
  recipientPreset: "creator",
  recipientUserIds: [],
  scheduleKind: "daily",
  reportType: "daily",
  time: "08:00",
  timezone: "UTC",
  dayOfWeek: "1",
  dayOfMonth: "1",
  month: "1",
  everyMinutes: "60",
  combinator: "all",
  conditions: [defaultMetricCondition()],
  metric: "visitors",
  milestoneStep: "1000",
  cooldownValue: "6",
  cooldownUnit: "hours",
  hours: "12",
};
export const TIME_OPTIONS = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 === 0 ? "00" : "30";
  return `${String(hour).padStart(2, "0")}:${minute}`;
});
export const REPORT_TYPES: ReportType[] = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
];
export const WEEK_DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;
export function scheduleKindFromReportType(
  reportType: ReportType,
): ScheduleKind {
  return reportType;
}
function isRuleFormType(value: string): value is RuleFormType {
  return (
    value === "report" ||
    value === "milestone" ||
    value === "threshold" ||
    value === "change" ||
    value === "health"
  );
}
export function isScheduleKind(value: unknown): value is ScheduleKind {
  return (
    value === "daily" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "quarterly" ||
    value === "yearly" ||
    value === "interval"
  );
}
export function isReportType(value: unknown): value is ReportType {
  return (
    value === "daily" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "quarterly" ||
    value === "yearly"
  );
}
function firstCondition(
  condition: Record<string, unknown>,
): Record<string, unknown> {
  const candidates = [condition.conditions, condition.all, condition.any].find(
    Array.isArray,
  );
  const first = Array.isArray(candidates) ? candidates[0] : null;
  return first && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : condition;
}
function conditionRecords(
  condition: Record<string, unknown>,
): Record<string, unknown>[] {
  const candidates = [condition.conditions, condition.all, condition.any].find(
    Array.isArray,
  );
  if (!Array.isArray(candidates)) return [condition];
  return candidates.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
}
function metricConditionFromRecord(
  condition: Record<string, unknown>,
  index: number,
): MetricConditionForm {
  return {
    id: `condition-${index + 1}`,
    metric:
      condition.metric === "views" || condition.metric === "sessions"
        ? condition.metric
        : "visitors",
    window:
      condition.window === "last_24h" || condition.window === "yesterday"
        ? condition.window
        : "last_1h",
    operator:
      condition.operator === ">" ||
      condition.operator === "<" ||
      condition.operator === "<="
        ? condition.operator
        : ">=",
    value: String(condition.value ?? "1000"),
    changeMode: condition.mode === "absolute" ? "absolute" : "percent",
  };
}
export function nextConditionId(conditions: MetricConditionForm[]): string {
  return `condition-${Date.now()}-${conditions.length + 1}`;
}
export function formatRunAt(locale: Locale, value: number | null): string {
  if (!value) return "-";
  return shortDateTime(locale, value * 1000);
}
export function isCoolingDown(
  rule: NotificationRuleData,
  nowSeconds: number,
): boolean {
  return Boolean(rule.cooldownUntil && rule.cooldownUntil > nowSeconds);
}
export function nextRunLabel(
  copy: AppMessages["teamManagement"]["notifications"],
  locale: Locale,
  rule: NotificationRuleData,
  nowSeconds: number,
): string {
  if (!rule.enabled) return copy.nextRunStates.disabled;
  if (isCoolingDown(rule, nowSeconds)) return copy.nextRunStates.coolingDown;
  if (rule.nextRunAt && rule.nextRunAt <= nowSeconds) {
    return copy.nextRunStates.dueNow;
  }
  return formatRunAt(locale, rule.nextRunAt);
}
export function scheduleLabel(
  copy: AppMessages["teamManagement"]["notifications"],
  rule: NotificationRuleData,
): string {
  if (rule.schedule.kind === "daily") {
    return formatI18nTemplate(copy.scheduleDaily, {
      time: String(rule.schedule.time ?? "08:00"),
    });
  }
  if (rule.schedule.kind === "weekly") {
    const dayIndex = Number(rule.schedule.dayOfWeek ?? 1);
    return formatI18nTemplate(copy.scheduleWeekly, {
      day: copy.weekDays[Math.max(0, Math.min(6, dayIndex))] ?? "",
      time: String(rule.schedule.time ?? "08:00"),
    });
  }
  if (rule.schedule.kind === "monthly") {
    return formatI18nTemplate(copy.scheduleMonthly, {
      day: String(rule.schedule.dayOfMonth ?? 1),
      time: String(rule.schedule.time ?? "08:00"),
    });
  }
  if (rule.schedule.kind === "quarterly") {
    return formatI18nTemplate(copy.scheduleQuarterly, {
      day: String(rule.schedule.dayOfMonth ?? 1),
      time: String(rule.schedule.time ?? "08:00"),
    });
  }
  if (rule.schedule.kind === "yearly") {
    return formatI18nTemplate(copy.scheduleYearly, {
      month: String(rule.schedule.month ?? 1),
      day: String(rule.schedule.dayOfMonth ?? 1),
      time: String(rule.schedule.time ?? "08:00"),
    });
  }
  if (rule.schedule.kind === "interval") {
    return formatI18nTemplate(copy.scheduleInterval, {
      minutes: String(rule.schedule.everyMinutes ?? 60),
    });
  }
  return copy.scheduleCustom;
}
export function conditionLabel(
  copy: AppMessages["teamManagement"]["notifications"],
  terms: AppMessages["conditionDescription"],
  rule: NotificationRuleData,
): string {
  return describeNotificationRuleCondition(
    copy,
    terms,
    rule.type,
    rule.condition,
  );
}
export function ruleTypeLabel(
  copy: AppMessages["teamManagement"]["notifications"],
  type: string,
): string {
  if (type in copy.ruleTypes) {
    return copy.ruleTypes[type as keyof typeof copy.ruleTypes];
  }
  return type;
}
export function recipientLabel(
  copy: AppMessages["teamManagement"]["notifications"],
  recipient: Record<string, unknown>,
  memberByUserId: Map<string, MemberData>,
): string {
  const mode = String(recipient.mode ?? "");
  if (mode === "users") {
    const userIds = userIdsFromRecipient(recipient);
    if (userIds.length === 0) return copy.recipientModes.users;
    return userIds
      .map((userId) => memberName(memberByUserId.get(userId)) || userId)
      .filter(Boolean)
      .join(", ");
  }
  if (mode in copy.recipientModes) {
    return copy.recipientModes[mode as keyof typeof copy.recipientModes];
  }
  return copy.recipientModes.team_admins;
}
export function memberName(member: MemberData | undefined): string {
  if (!member) return "";
  return member.name || member.username || member.email || member.userId;
}
function userIdsFromRecipient(recipient: Record<string, unknown>): string[] {
  return Array.isArray(recipient.userIds)
    ? recipient.userIds.filter(
        (userId): userId is string =>
          typeof userId === "string" && userId.length > 0,
      )
    : [];
}
export function defaultRecipientUserIds(
  members: MemberData[],
  currentUserId: string,
): string[] {
  if (members.some((member) => member.userId === currentUserId)) {
    return [currentUserId];
  }
  return members[0]?.userId ? [members[0].userId] : [];
}
export function recipientTextFromForm(
  copy: AppMessages["teamManagement"]["notifications"],
  form: RuleFormState,
  memberByUserId: Map<string, MemberData>,
): string {
  if (form.recipientKind === "preset") {
    return copy.recipientModes[form.recipientPreset];
  }
  const names = form.recipientUserIds
    .map((userId) => memberName(memberByUserId.get(userId)) || userId)
    .filter(Boolean);
  return names.length > 0 ? names.join(", ") : copy.customRecipientsEmpty;
}
export function siteLabel(
  siteById: Map<string, SiteData>,
  siteId: string | null,
) {
  if (!siteId) return "-";
  const site = siteById.get(siteId);
  return site ? `${site.name} (${site.domain})` : siteId;
}
export function previewSummary(
  result: NotificationRuleEvaluationData | null,
): string {
  if (!result) return "";
  if (result.status === "triggered") return result.message.summary;
  if (result.status === "checked") return result.summary;
  return result.reason;
}
function cooldownPartsFromMinutes(minutes: unknown): {
  value: string;
  unit: CooldownUnit;
} {
  const totalMinutes = Math.max(0, Math.trunc(Number(minutes ?? 360)));
  if (totalMinutes > 0 && totalMinutes % 1440 === 0) {
    return { value: String(totalMinutes / 1440), unit: "days" };
  }
  if (totalMinutes > 0 && totalMinutes % 60 === 0) {
    return { value: String(totalMinutes / 60), unit: "hours" };
  }
  return { value: String(totalMinutes), unit: "minutes" };
}
function cooldownMinutesFromForm(form: RuleFormState): number {
  const value = Math.max(0, Math.trunc(Number(form.cooldownValue || 0)));
  if (form.cooldownUnit === "days") return value * 1440;
  if (form.cooldownUnit === "hours") return value * 60;
  return value;
}
export function cooldownLabel(
  copy: AppMessages["teamManagement"]["notifications"],
  form: RuleFormState,
): string {
  const value = form.cooldownValue || "0";
  const unit = copy.cooldownUnits[form.cooldownUnit];
  return `${value} ${unit}`;
}
export function inferFormFromRule(rule: NotificationRuleData): RuleFormState {
  const type = isRuleFormType(rule.type) ? rule.type : "report";
  const scheduleKind = isScheduleKind(rule.schedule.kind)
    ? rule.schedule.kind
    : "interval";
  const primaryCondition = firstCondition(rule.condition);
  const conditions = conditionRecords(rule.condition).map(
    metricConditionFromRecord,
  );
  const reportType = isReportType(rule.condition.reportType)
    ? rule.condition.reportType
    : scheduleKind !== "interval" && isReportType(scheduleKind)
      ? scheduleKind
      : "daily";
  const cooldown = cooldownPartsFromMinutes(rule.condition.cooldownMinutes);
  const recipientMode = String(rule.recipient.mode ?? "");
  const recipientUserIds =
    recipientMode === "users" ? userIdsFromRecipient(rule.recipient) : [];
  return {
    ...EMPTY_FORM,
    id: rule.id,
    name: rule.name,
    type,
    siteId: rule.siteId ?? "",
    enabled: rule.enabled,
    recipientKind: recipientMode === "users" ? "custom" : "preset",
    recipientPreset:
      recipientMode === "creator" || recipientMode === "all_team_members"
        ? recipientMode
        : "team_admins",
    recipientUserIds,
    scheduleKind,
    reportType,
    time: String(rule.schedule.time ?? "08:00"),
    timezone: String(rule.schedule.timezone ?? "UTC"),
    dayOfWeek: String(rule.schedule.dayOfWeek ?? "1"),
    dayOfMonth: String(rule.schedule.dayOfMonth ?? "1"),
    month: String(rule.schedule.month ?? "1"),
    everyMinutes: String(rule.schedule.everyMinutes ?? 60),
    combinator: Array.isArray(rule.condition.any) ? "any" : "all",
    conditions: conditions.length > 0 ? conditions : [defaultMetricCondition()],
    metric:
      primaryCondition.metric === "views" ||
      primaryCondition.metric === "sessions"
        ? primaryCondition.metric
        : "visitors",
    milestoneStep: String(
      rule.condition.step ??
        rule.condition.every ??
        rule.condition.value ??
        "1000",
    ),
    cooldownValue: cooldown.value,
    cooldownUnit: cooldown.unit,
    hours: String(rule.condition.hours ?? "12"),
  };
}
export function defaultName(
  copy: AppMessages["teamManagement"]["notifications"],
  type: RuleFormType,
  site?: SiteData,
) {
  const siteName = site?.name || copy.siteLabel;
  return formatI18nTemplate(copy.defaultNames[type], { site: siteName });
}
export function browserDefaultTimeZone(): string {
  return browserTimeZone() || "UTC";
}
function timeZoneOffsetLabel(timeZone: string, timestampMs: number): string {
  return formatUtcOffset(timeZoneOffsetMinutes(timeZone || "UTC", timestampMs));
}
export function scheduleTextFromForm(
  copy: AppMessages["teamManagement"]["notifications"],
  form: RuleFormState,
  timestampMs: number,
): string {
  const timeZoneLabel = ` (${timeZoneOffsetLabel(form.timezone, timestampMs)})`;
  if (form.scheduleKind === "daily") {
    return `${formatI18nTemplate(copy.scheduleDaily, { time: form.time })}${timeZoneLabel}`;
  }
  if (form.scheduleKind === "weekly") {
    const dayIndex = Math.trunc(Number(form.dayOfWeek || 1));
    return `${formatI18nTemplate(copy.scheduleWeekly, {
      day: copy.weekDays[dayIndex] ?? copy.weekDays[1] ?? "",
      time: form.time,
    })}${timeZoneLabel}`;
  }
  if (form.scheduleKind === "monthly") {
    return `${formatI18nTemplate(copy.scheduleMonthly, {
      day: form.dayOfMonth || "1",
      time: form.time,
    })}${timeZoneLabel}`;
  }
  if (form.scheduleKind === "quarterly") {
    return `${formatI18nTemplate(copy.scheduleQuarterly, {
      day: form.dayOfMonth || "1",
      time: form.time,
    })}${timeZoneLabel}`;
  }
  if (form.scheduleKind === "yearly") {
    return `${formatI18nTemplate(copy.scheduleYearly, {
      month: form.month || "1",
      day: form.dayOfMonth || "1",
      time: form.time,
    })}${timeZoneLabel}`;
  }
  return formatI18nTemplate(copy.scheduleInterval, {
    minutes: form.everyMinutes || "60",
  });
}
export function buildRulePayload(
  copy: AppMessages["teamManagement"]["notifications"],
  form: RuleFormState,
  sites: SiteData[],
) {
  const site = sites.find((item) => item.id === form.siteId);
  const name = form.name.trim() || defaultName(copy, form.type, site);
  const schedule =
    form.scheduleKind === "interval"
      ? {
          kind: "interval",
          everyMinutes: Math.trunc(Number(form.everyMinutes || 60)),
        }
      : {
          kind: form.scheduleKind,
          time: form.time || "08:00",
          timezone: form.timezone,
          ...(form.scheduleKind === "weekly"
            ? { dayOfWeek: Math.trunc(Number(form.dayOfWeek || 1)) }
            : {}),
          ...(form.scheduleKind === "monthly" ||
          form.scheduleKind === "quarterly"
            ? { dayOfMonth: Math.trunc(Number(form.dayOfMonth || 1)) }
            : {}),
          ...(form.scheduleKind === "yearly"
            ? {
                month: Math.trunc(Number(form.month || 1)),
                dayOfMonth: Math.trunc(Number(form.dayOfMonth || 1)),
              }
            : {}),
        };
  const metricConditions = form.conditions.map((condition) => ({
    metric: condition.metric,
    window: condition.window,
    operator: condition.operator,
    value: Number(condition.value || 0),
  }));
  const condition =
    form.type === "report"
      ? { reportType: form.reportType }
      : form.type === "milestone"
        ? {
            metric: form.metric,
            step: Number(form.milestoneStep || 0),
          }
        : form.type === "threshold"
          ? {
              [form.combinator]: metricConditions,
              cooldownMinutes: cooldownMinutesFromForm(form),
            }
          : form.type === "change"
            ? {
                [form.combinator]: form.conditions.map((condition) => ({
                  metric: condition.metric,
                  window: condition.window,
                  operator: condition.operator,
                  value: Number(condition.value || 0),
                  mode: condition.changeMode,
                  compareTo: "previous_period",
                })),
                cooldownMinutes: cooldownMinutesFromForm(form),
              }
            : {
                check: "no_data",
                hours: Number(form.hours || 0),
                cooldownMinutes: cooldownMinutesFromForm(form),
              };
  return {
    name,
    siteId: form.siteId || null,
    type: form.type,
    enabled: form.enabled,
    schedule,
    condition,
    recipient:
      form.recipientKind === "custom"
        ? { mode: "users", userIds: form.recipientUserIds }
        : { mode: form.recipientPreset },
  };
}
export function ruleSummaryLines(
  copy: AppMessages["teamManagement"]["notifications"],
  terms: AppMessages["conditionDescription"],
  form: RuleFormState,
): string[] {
  return [
    describeNotificationFormConditions(copy, terms, {
      type: form.type,
      combinator: form.combinator,
      conditions: form.conditions.map((condition) => ({
        metric: condition.metric,
        window: condition.window,
        operator: condition.operator,
        value: condition.value || "0",
        changeMode: condition.changeMode,
      })),
      reportType: form.reportType,
      metric: form.metric,
      milestoneStep: form.milestoneStep,
      hours: form.hours,
    }),
  ];
}
export function ruleSummaryTitle(
  copy: AppMessages["teamManagement"]["notifications"],
  form: RuleFormState,
  timestampMs: number,
): string {
  if (form.type === "report") {
    return formatI18nTemplate(copy.summaryReportSchedule, {
      period: copy.reportPeriods[form.reportType],
      schedule: scheduleTextFromForm(copy, form, timestampMs),
    });
  }
  if (form.type === "threshold" || form.type === "change") {
    return formatI18nTemplate(copy.summaryWhenConditions, {
      combinator: form.combinator === "any" ? copy.matchAny : copy.matchAll,
      type: copy.ruleTypes[form.type],
    });
  }
  return formatI18nTemplate(copy.summaryWhenSingleCondition, {
    type: copy.ruleTypes[form.type],
  });
}
