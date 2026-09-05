import { type ReactNode, useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiCheckboxCircleLine,
  RiCloseLine,
  RiDeleteBinLine,
  RiEditLine,
  RiEyeLine,
  RiMailSendLine,
  RiNotification3Line,
  RiPauseCircleLine,
  RiPlayCircleLine,
  RiSave3Line,
} from "@remixicon/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { JsonTreePanel } from "@/components/dashboard/json-tree";
import { PageHeading } from "@/components/dashboard/page-heading";
import { TableActionButton } from "@/components/dashboard/table-action-button";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@/components/ui/responsive-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requestAdminService } from "@/lib/admin-service-client";
import { intlLocale, shortDateTime } from "@/lib/dashboard/format";
import type { TeamNotificationsInitialData } from "@/lib/dashboard/management-data";
import {
  browserTimeZone,
  buildTimeZoneOptions,
  formatUtcOffset,
  supportedTimeZones,
  timeZoneOffsetMinutes,
} from "@/lib/dashboard/time-zone";
import {
  type MemberData,
  type NotificationRuleData,
  type NotificationRuleEvaluationData,
  type NotificationRuleRunData,
  type SiteData,
} from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import {
  describeNotificationFormConditions,
  describeNotificationRuleCondition,
} from "@/lib/notifications/condition-description";
import type { PublicNotificationEmailConfig } from "@/lib/notifications/email-config";
import Link from "@/lib/router";
import { cn } from "@/lib/utils";

interface TeamNotificationsClientProps {
  locale: Locale;
  messages: AppMessages;
  teamId: string;
  teamSlug: string;
  currentUserId: string;
  initialData?: TeamNotificationsInitialData | null;
}

type RuleFormType = "report" | "milestone" | "threshold" | "change" | "health";
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

interface MetricConditionForm {
  id: string;
  metric: MetricName;
  window: MetricWindow;
  operator: ThresholdOperator;
  value: string;
  changeMode: ChangeMode;
}

interface RuleFormState {
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

function defaultMetricCondition(id = "condition-1"): MetricConditionForm {
  return {
    id,
    metric: "visitors",
    window: "last_1h",
    operator: ">=",
    value: "1000",
    changeMode: "percent",
  };
}

const EMPTY_FORM: RuleFormState = {
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

const TIME_OPTIONS = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 === 0 ? "00" : "30";
  return `${String(hour).padStart(2, "0")}:${minute}`;
});

const REPORT_TYPES: ReportType[] = [
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "yearly",
];
const WEEK_DAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;

function scheduleKindFromReportType(reportType: ReportType): ScheduleKind {
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

function isScheduleKind(value: unknown): value is ScheduleKind {
  return (
    value === "daily" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "quarterly" ||
    value === "yearly" ||
    value === "interval"
  );
}

function isReportType(value: unknown): value is ReportType {
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

function nextConditionId(conditions: MetricConditionForm[]): string {
  return `condition-${Date.now()}-${conditions.length + 1}`;
}

function formatRunAt(locale: Locale, value: number | null): string {
  if (!value) return "-";
  return shortDateTime(locale, value * 1000);
}

function isCoolingDown(
  rule: NotificationRuleData,
  nowSeconds: number,
): boolean {
  return Boolean(rule.cooldownUntil && rule.cooldownUntil > nowSeconds);
}

function nextRunLabel(
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

function scheduleLabel(
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

function conditionLabel(
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

function ruleTypeLabel(
  copy: AppMessages["teamManagement"]["notifications"],
  type: string,
): string {
  if (type in copy.ruleTypes) {
    return copy.ruleTypes[type as keyof typeof copy.ruleTypes];
  }
  return type;
}

function recipientLabel(
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

function memberName(member: MemberData | undefined): string {
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

function defaultRecipientUserIds(
  members: MemberData[],
  currentUserId: string,
): string[] {
  if (members.some((member) => member.userId === currentUserId)) {
    return [currentUserId];
  }
  return members[0]?.userId ? [members[0].userId] : [];
}

function recipientTextFromForm(
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

function siteLabel(siteById: Map<string, SiteData>, siteId: string | null) {
  if (!siteId) return "-";
  const site = siteById.get(siteId);
  return site ? `${site.name} (${site.domain})` : siteId;
}

function previewSummary(result: NotificationRuleEvaluationData | null): string {
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

function cooldownLabel(
  copy: AppMessages["teamManagement"]["notifications"],
  form: RuleFormState,
): string {
  const value = form.cooldownValue || "0";
  const unit = copy.cooldownUnits[form.cooldownUnit];
  return `${value} ${unit}`;
}

function inferFormFromRule(rule: NotificationRuleData): RuleFormState {
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

function defaultName(
  copy: AppMessages["teamManagement"]["notifications"],
  type: RuleFormType,
  site?: SiteData,
) {
  const siteName = site?.name || copy.siteLabel;
  return formatI18nTemplate(copy.defaultNames[type], { site: siteName });
}

function browserDefaultTimeZone(): string {
  return browserTimeZone() || "UTC";
}

function timeZoneOffsetLabel(timeZone: string, timestampMs: number): string {
  return formatUtcOffset(timeZoneOffsetMinutes(timeZone || "UTC", timestampMs));
}

function scheduleTextFromForm(
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

function buildRulePayload(
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

function ruleSummaryLines(
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

function ruleSummaryTitle(
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

function RuleFormSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <hr className="border-border" />
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function RuleFormFields({
  copy,
  terms,
  locale,
  form,
  sites,
  members,
  currentUserId,
  onChange,
}: {
  copy: AppMessages["teamManagement"]["notifications"];
  terms: AppMessages["conditionDescription"];
  locale: Locale;
  form: RuleFormState;
  sites: SiteData[];
  members: MemberData[];
  currentUserId: string;
  onChange: (patch: Partial<RuleFormState>) => void;
}) {
  const timeZones = useMemo(() => supportedTimeZones(), []);
  const timeZoneOptionTimestamp = useMemo(() => Date.now(), []);
  const [localTimeZone, setLocalTimeZone] = useState("UTC");
  useEffect(() => {
    setLocalTimeZone(browserDefaultTimeZone());
  }, []);
  const timeZoneOptions = useMemo(
    () =>
      buildTimeZoneOptions({
        locale: intlLocale(locale),
        supported: timeZones,
        selected: form.timezone,
        active: form.timezone,
        browser: localTimeZone,
        timestampMs: timeZoneOptionTimestamp,
      }),
    [form.timezone, locale, localTimeZone, timeZoneOptionTimestamp, timeZones],
  );
  const selectedSite = useMemo(
    () => sites.find((site) => site.id === form.siteId),
    [form.siteId, sites],
  );
  const memberByUserId = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );
  const namePlaceholder = defaultName(copy, form.type, selectedSite);

  function updateCondition(id: string, patch: Partial<MetricConditionForm>) {
    onChange({
      conditions: form.conditions.map((condition) =>
        condition.id === id ? { ...condition, ...patch } : condition,
      ),
    });
  }

  function addCondition() {
    onChange({
      conditions: [
        ...form.conditions,
        defaultMetricCondition(nextConditionId(form.conditions)),
      ],
    });
  }

  function removeCondition(id: string) {
    if (form.conditions.length <= 1) return;
    onChange({
      conditions: form.conditions.filter((condition) => condition.id !== id),
    });
  }

  function toggleRecipientUser(userId: string, checked: boolean) {
    onChange({
      recipientUserIds: checked
        ? Array.from(new Set([...form.recipientUserIds, userId]))
        : form.recipientUserIds.filter(
            (selectedUserId) => selectedUserId !== userId,
          ),
    });
  }

  const summaryLines = ruleSummaryLines(copy, terms, form);

  return (
    <div className="space-y-5">
      <Field>
        <FieldLabel>{copy.ruleTypeLabel}</FieldLabel>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {(
            [
              "report",
              "milestone",
              "threshold",
              "change",
              "health",
            ] as RuleFormType[]
          ).map((type) => (
            <button
              key={type}
              type="button"
              className={cn(
                "min-h-16 border px-3 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
                form.type === type
                  ? "border-primary bg-primary/8 text-foreground"
                  : "border-border bg-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
              onClick={() =>
                onChange({
                  type,
                  scheduleKind:
                    type === "report"
                      ? scheduleKindFromReportType(form.reportType)
                      : "interval",
                })
              }
            >
              <span className="block font-medium text-foreground">
                {copy.ruleTypes[type]}
              </span>
              <span className="mt-1 block leading-4">
                {copy.ruleTypeDescriptions[type]}
              </span>
            </button>
          ))}
        </div>
      </Field>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-5">
          <RuleFormSection title={copy.ruleInfoSection}>
            <div className="grid gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel>{copy.siteLabel}</FieldLabel>
                <Select
                  value={form.siteId}
                  onValueChange={(siteId) => onChange({ siteId })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={copy.chooseSite} />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>{copy.nameLabel}</FieldLabel>
                <Input
                  value={form.name}
                  placeholder={namePlaceholder}
                  maxLength={160}
                  onChange={(event) => onChange({ name: event.target.value })}
                />
              </Field>
            </div>
          </RuleFormSection>

          <RuleFormSection title={copy.conditionSection}>
            <AutoResizer initial duration={0.2}>
              <AutoTransition
                transitionKey={form.type}
                duration={0.18}
                type="fade"
                initial={false}
                presenceMode="wait"
              >
                {form.type === "report" ? (
                  <div key="report" className="grid gap-4 md:grid-cols-3">
                    <Field>
                      <FieldLabel>{copy.reportPeriodLabel}</FieldLabel>
                      <Select
                        value={form.reportType}
                        onValueChange={(value) => {
                          if (isReportType(value)) {
                            onChange({
                              reportType: value,
                              scheduleKind: scheduleKindFromReportType(value),
                            });
                          }
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {REPORT_TYPES.map((type) => (
                            <SelectItem key={type} value={type}>
                              {copy.reportPeriods[type]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                ) : form.type === "milestone" ? (
                  <div key="milestone" className="grid gap-4 md:grid-cols-3">
                    <Field>
                      <FieldLabel>{copy.metricLabel}</FieldLabel>
                      <Select
                        value={form.metric}
                        onValueChange={(value) => {
                          if (
                            value === "views" ||
                            value === "visitors" ||
                            value === "sessions"
                          ) {
                            onChange({ metric: value });
                          }
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="views">
                            {copy.metrics.views}
                          </SelectItem>
                          <SelectItem value="visitors">
                            {copy.metrics.visitors}
                          </SelectItem>
                          <SelectItem value="sessions">
                            {copy.metrics.sessions}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>{copy.milestoneEveryLabel}</FieldLabel>
                      <Input
                        type="number"
                        min={1}
                        value={form.milestoneStep}
                        onChange={(event) =>
                          onChange({ milestoneStep: event.target.value })
                        }
                      />
                    </Field>
                  </div>
                ) : form.type === "threshold" || form.type === "change" ? (
                  <div key={form.type} className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-3">
                      <Field>
                        <FieldLabel>{copy.matchLabel}</FieldLabel>
                        <Select
                          value={form.combinator}
                          onValueChange={(value) => {
                            if (value === "all" || value === "any") {
                              onChange({ combinator: value });
                            }
                          }}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">{copy.matchAll}</SelectItem>
                            <SelectItem value="any">{copy.matchAny}</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>

                    <AutoResizer initial duration={0.2}>
                      <div className="space-y-3">
                        {form.conditions.map((condition, index) => (
                          <div
                            key={condition.id}
                            className="grid gap-3 border-l border-border pl-3 md:grid-cols-2 xl:grid-cols-[1.1fr_1.2fr_0.8fr_1fr_auto]"
                          >
                            <div className="text-xs font-medium text-muted-foreground md:col-span-2 xl:col-span-5">
                              {formatI18nTemplate(copy.conditionItemTitle, {
                                index: String(index + 1),
                              })}
                            </div>
                            <Field>
                              <FieldLabel>{copy.metricLabel}</FieldLabel>
                              <Select
                                value={condition.metric}
                                onValueChange={(value) => {
                                  if (
                                    value === "views" ||
                                    value === "visitors" ||
                                    value === "sessions"
                                  ) {
                                    updateCondition(condition.id, {
                                      metric: value,
                                    });
                                  }
                                }}
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="views">
                                    {copy.metrics.views}
                                  </SelectItem>
                                  <SelectItem value="visitors">
                                    {copy.metrics.visitors}
                                  </SelectItem>
                                  <SelectItem value="sessions">
                                    {copy.metrics.sessions}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                            <Field>
                              <FieldLabel>{copy.windowLabel}</FieldLabel>
                              <Select
                                value={condition.window}
                                onValueChange={(value) => {
                                  if (
                                    value === "last_1h" ||
                                    value === "last_24h" ||
                                    value === "yesterday"
                                  ) {
                                    updateCondition(condition.id, {
                                      window: value,
                                    });
                                  }
                                }}
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="last_1h">
                                    {copy.windows.last_1h}
                                  </SelectItem>
                                  <SelectItem value="last_24h">
                                    {copy.windows.last_24h}
                                  </SelectItem>
                                  <SelectItem value="yesterday">
                                    {copy.windows.yesterday}
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                            <Field>
                              <FieldLabel>{copy.operatorLabel}</FieldLabel>
                              <Select
                                value={condition.operator}
                                onValueChange={(value) => {
                                  if (
                                    value === ">" ||
                                    value === ">=" ||
                                    value === "<" ||
                                    value === "<="
                                  ) {
                                    updateCondition(condition.id, {
                                      operator: value,
                                    });
                                  }
                                }}
                              >
                                <SelectTrigger className="w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value=">">&gt;</SelectItem>
                                  <SelectItem value=">=">&gt;=</SelectItem>
                                  <SelectItem value="<">&lt;</SelectItem>
                                  <SelectItem value="<=">&lt;=</SelectItem>
                                </SelectContent>
                              </Select>
                            </Field>
                            <Field>
                              <FieldLabel>
                                {form.type === "change"
                                  ? copy.changeValueLabel
                                  : copy.valueLabel}
                              </FieldLabel>
                              <Input
                                type="number"
                                value={condition.value}
                                onChange={(event) =>
                                  updateCondition(condition.id, {
                                    value: event.target.value,
                                  })
                                }
                              />
                            </Field>
                            <div className="flex items-end">
                              <Button
                                type="button"
                                variant="outline"
                                className="w-full px-2 xl:w-20"
                                disabled={form.conditions.length <= 1}
                                onClick={() => removeCondition(condition.id)}
                                aria-label={copy.removeCondition}
                              >
                                <RiDeleteBinLine className="size-4" />
                                <span className="xl:sr-only">
                                  {copy.removeCondition}
                                </span>
                              </Button>
                            </div>
                            {form.type === "change" ? (
                              <Field className="md:col-span-2 xl:col-span-2">
                                <FieldLabel>{copy.changeModeLabel}</FieldLabel>
                                <Select
                                  value={condition.changeMode}
                                  onValueChange={(value) => {
                                    if (
                                      value === "absolute" ||
                                      value === "percent"
                                    ) {
                                      updateCondition(condition.id, {
                                        changeMode: value,
                                      });
                                    }
                                  }}
                                >
                                  <SelectTrigger className="w-full">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="percent">
                                      {copy.changeModePercent}
                                    </SelectItem>
                                    <SelectItem value="absolute">
                                      {copy.changeModeAbsolute}
                                    </SelectItem>
                                  </SelectContent>
                                </Select>
                              </Field>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </AutoResizer>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={addCondition}
                    >
                      <RiAddLine />
                      <span>{copy.addCondition}</span>
                    </Button>
                  </div>
                ) : (
                  <div key="health" className="grid gap-4 md:grid-cols-3">
                    <Field>
                      <FieldLabel>{copy.noDataHoursLabel}</FieldLabel>
                      <Input
                        type="number"
                        min={1}
                        value={form.hours}
                        onChange={(event) =>
                          onChange({ hours: event.target.value })
                        }
                      />
                    </Field>
                  </div>
                )}
              </AutoTransition>
            </AutoResizer>
          </RuleFormSection>

          <RuleFormSection
            title={
              form.type === "report"
                ? copy.sendScheduleSection
                : copy.checkSection
            }
          >
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-[11rem_minmax(0,1fr)]">
                <Field>
                  <FieldLabel>{copy.scheduleLabel}</FieldLabel>
                  <Select
                    value={form.scheduleKind}
                    onValueChange={(value) => {
                      if (isScheduleKind(value)) {
                        onChange({
                          scheduleKind: value,
                          ...(form.type === "report" && isReportType(value)
                            ? { reportType: value }
                            : {}),
                        });
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">
                        {copy.scheduleKinds.daily}
                      </SelectItem>
                      <SelectItem value="weekly">
                        {copy.scheduleKinds.weekly}
                      </SelectItem>
                      <SelectItem value="monthly">
                        {copy.scheduleKinds.monthly}
                      </SelectItem>
                      <SelectItem value="quarterly">
                        {copy.scheduleKinds.quarterly}
                      </SelectItem>
                      <SelectItem value="yearly">
                        {copy.scheduleKinds.yearly}
                      </SelectItem>
                      <SelectItem value="interval">
                        {copy.scheduleKinds.interval}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>

                <AutoResizer initial duration={0.2}>
                  <AutoTransition
                    transitionKey={form.scheduleKind}
                    duration={0.18}
                    type="fade"
                    initial={false}
                    presenceMode="wait"
                  >
                    {form.scheduleKind !== "interval" ? (
                      <div
                        key="calendar-primary"
                        className="grid gap-4 md:grid-cols-[11rem_minmax(0,1fr)]"
                      >
                        <Field>
                          <FieldLabel>{copy.timeLabel}</FieldLabel>
                          <Select
                            value={form.time}
                            onValueChange={(time) => onChange({ time })}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-80">
                              {TIME_OPTIONS.map((time) => (
                                <SelectItem key={time} value={time}>
                                  {time}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                        <Field className="min-w-0">
                          <FieldLabel>{copy.timezoneLabel}</FieldLabel>
                          <Select
                            value={form.timezone}
                            onValueChange={(timezone) => onChange({ timezone })}
                          >
                            <SelectTrigger className="w-full min-w-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-80">
                              {timeZoneOptions.map((timeZone) => (
                                <SelectItem
                                  key={timeZone.value}
                                  value={timeZone.value}
                                >
                                  {timeZone.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                    ) : (
                      <div
                        key="interval-primary"
                        className="grid gap-4 md:grid-cols-[minmax(0,11rem)]"
                      >
                        <Field>
                          <FieldLabel>{copy.intervalLabel}</FieldLabel>
                          <Select
                            value={form.everyMinutes}
                            onValueChange={(everyMinutes) =>
                              onChange({ everyMinutes })
                            }
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="30">
                                {copy.intervalOptions.every30Minutes}
                              </SelectItem>
                              <SelectItem value="60">
                                {copy.intervalOptions.everyHour}
                              </SelectItem>
                              <SelectItem value="360">
                                {copy.intervalOptions.every6Hours}
                              </SelectItem>
                              <SelectItem value="720">
                                {copy.intervalOptions.every12Hours}
                              </SelectItem>
                              <SelectItem value="1440">
                                {copy.intervalOptions.everyDay}
                              </SelectItem>
                              <SelectItem value="10080">
                                {copy.intervalOptions.every7Days}
                              </SelectItem>
                              <SelectItem value="43200">
                                {copy.intervalOptions.every30Days}
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                    )}
                  </AutoTransition>
                </AutoResizer>
              </div>

              <AutoResizer initial duration={0.2}>
                <AutoTransition
                  transitionKey={form.scheduleKind}
                  duration={0.18}
                  type="fade"
                  initial={false}
                  presenceMode="wait"
                >
                  {form.scheduleKind !== "interval" ? (
                    form.scheduleKind === "weekly" ? (
                      <div
                        key="weekly"
                        className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
                      >
                        <Field>
                          <FieldLabel>{copy.dayLabel}</FieldLabel>
                          <Select
                            value={form.dayOfWeek}
                            onValueChange={(dayOfWeek) =>
                              onChange({ dayOfWeek })
                            }
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {WEEK_DAY_INDEXES.map((index) => (
                                <SelectItem key={index} value={String(index)}>
                                  {copy.weekDays[index]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </Field>
                      </div>
                    ) : form.scheduleKind === "monthly" ||
                      form.scheduleKind === "quarterly" ? (
                      <div
                        key="month-day"
                        className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
                      >
                        <Field>
                          <FieldLabel>{copy.dayOfMonthLabel}</FieldLabel>
                          <Input
                            type="number"
                            min={1}
                            max={31}
                            value={form.dayOfMonth}
                            onChange={(event) =>
                              onChange({
                                dayOfMonth: event.target.value,
                              })
                            }
                          />
                        </Field>
                      </div>
                    ) : form.scheduleKind === "yearly" ? (
                      <div
                        key="yearly"
                        className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
                      >
                        <Field>
                          <FieldLabel>{copy.monthLabel}</FieldLabel>
                          <Input
                            type="number"
                            min={1}
                            max={12}
                            value={form.month}
                            onChange={(event) =>
                              onChange({ month: event.target.value })
                            }
                          />
                        </Field>
                        <Field>
                          <FieldLabel>{copy.dayOfMonthLabel}</FieldLabel>
                          <Input
                            type="number"
                            min={1}
                            max={31}
                            value={form.dayOfMonth}
                            onChange={(event) =>
                              onChange({
                                dayOfMonth: event.target.value,
                              })
                            }
                          />
                        </Field>
                      </div>
                    ) : (
                      <div key="empty-schedule-details" className="h-0" />
                    )
                  ) : (
                    <div key="interval-details" className="h-0" />
                  )}
                </AutoTransition>
              </AutoResizer>
            </div>
          </RuleFormSection>

          <RuleFormSection title={copy.deliverySection}>
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <Field>
                  <FieldLabel>{copy.recipientKindLabel}</FieldLabel>
                  <Select
                    value={form.recipientKind}
                    onValueChange={(value) => {
                      if (value === "preset" || value === "custom") {
                        onChange({
                          recipientKind: value,
                          recipientUserIds:
                            value === "custom" &&
                            form.recipientUserIds.length === 0
                              ? defaultRecipientUserIds(members, currentUserId)
                              : form.recipientUserIds,
                        });
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="preset">
                        {copy.recipientKinds.preset}
                      </SelectItem>
                      <SelectItem value="custom">
                        {copy.recipientKinds.custom}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {form.recipientKind === "preset" ? (
                  <Field>
                    <FieldLabel>{copy.recipientPresetLabel}</FieldLabel>
                    <Select
                      value={form.recipientPreset}
                      onValueChange={(value) => {
                        if (
                          value === "creator" ||
                          value === "team_admins" ||
                          value === "all_team_members"
                        ) {
                          onChange({ recipientPreset: value });
                        }
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="creator">
                          {copy.recipientModes.creator}
                        </SelectItem>
                        <SelectItem value="team_admins">
                          {copy.recipientModes.team_admins}
                        </SelectItem>
                        <SelectItem value="all_team_members">
                          {copy.recipientModes.all_team_members}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                ) : null}
              </div>

              <AutoResizer initial duration={0.2}>
                <AutoTransition
                  className="pb-1"
                  transitionKey={form.recipientKind}
                  duration={0.18}
                  type="fade"
                  initial={false}
                  presenceMode="wait"
                >
                  {form.recipientKind === "custom" ? (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {members.length > 0 ? (
                        members.map((member) => (
                          <label
                            key={member.userId}
                            className="flex min-w-0 items-start gap-3 border px-3 py-2 text-sm"
                          >
                            <Checkbox
                              checked={form.recipientUserIds.includes(
                                member.userId,
                              )}
                              onCheckedChange={(checked) =>
                                toggleRecipientUser(member.userId, !!checked)
                              }
                            />
                            <span className="min-w-0">
                              <span className="block truncate font-medium">
                                {memberName(member)}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {member.email}
                              </span>
                            </span>
                          </label>
                        ))
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          {copy.noTeamMembers}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="h-1" />
                  )}
                </AutoTransition>
              </AutoResizer>
            </div>

            <div className="space-y-2">
              <Field>
                <FieldLabel>{copy.cooldownLabel}</FieldLabel>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <Input
                    type="number"
                    min={0}
                    value={form.cooldownValue}
                    onChange={(event) =>
                      onChange({ cooldownValue: event.target.value })
                    }
                  />
                  <Select
                    value={form.cooldownUnit}
                    onValueChange={(value) => {
                      if (
                        value === "minutes" ||
                        value === "hours" ||
                        value === "days"
                      ) {
                        onChange({ cooldownUnit: value });
                      }
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="minutes">
                        {copy.cooldownUnits.minutes}
                      </SelectItem>
                      <SelectItem value="hours">
                        {copy.cooldownUnits.hours}
                      </SelectItem>
                      <SelectItem value="days">
                        {copy.cooldownUnits.days}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </Field>
              <p className="text-xs leading-5 text-muted-foreground">
                {copy.cooldownDescription}
              </p>
            </div>
          </RuleFormSection>
        </div>

        <aside className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          <div className="space-y-4 border bg-muted/20 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium">{copy.summarySection}</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {copy.liveSummaryDescription}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Checkbox
                  checked={form.enabled}
                  onCheckedChange={(checked) =>
                    onChange({ enabled: !!checked })
                  }
                  aria-label={copy.enabledLabel}
                />
                <span className="text-xs text-muted-foreground">
                  {copy.enabledHint}
                </span>
              </div>
            </div>

            <AutoResizer initial duration={0.2}>
              <AutoTransition
                transitionKey={[
                  form.type,
                  form.siteId,
                  form.recipientKind,
                  form.recipientPreset,
                  form.recipientUserIds.join(","),
                  form.scheduleKind,
                  form.reportType,
                  form.combinator,
                  summaryLines.join("|"),
                ].join(":")}
                duration={0.18}
                type="fade"
                initial={false}
                presenceMode="wait"
              >
                <div className="space-y-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">
                      {copy.nameLabel}
                    </p>
                    <p className="mt-1 break-words font-medium">
                      {form.name.trim() || namePlaceholder}
                    </p>
                  </div>
                  <div className="grid gap-3 text-xs">
                    <div>
                      <p className="text-muted-foreground">{copy.siteLabel}</p>
                      <p className="mt-1 text-foreground">
                        {selectedSite
                          ? `${selectedSite.name} (${selectedSite.domain})`
                          : copy.chooseSite}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">
                        {copy.scheduleSection}
                      </p>
                      <p className="mt-1 text-foreground">
                        {scheduleTextFromForm(
                          copy,
                          form,
                          timeZoneOptionTimestamp,
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">
                        {copy.recipientLabel}
                      </p>
                      <p className="mt-1 text-foreground">
                        {recipientTextFromForm(copy, form, memberByUserId)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">
                        {copy.cooldownLabel}
                      </p>
                      <p className="mt-1 text-foreground">
                        {cooldownLabel(copy, form)}
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p
                      className={
                        form.type === "report"
                          ? "text-xs text-muted-foreground"
                          : undefined
                      }
                    >
                      {ruleSummaryTitle(copy, form, timeZoneOptionTimestamp)}
                    </p>
                    {summaryLines.length > 0 ? (
                      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                        {summaryLines.map((line, index) => (
                          <li key={`${line}-${index}`}>{line}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              </AutoTransition>
            </AutoResizer>
          </div>
        </aside>
      </div>
    </div>
  );
}

export function TeamNotificationsClient({
  locale,
  messages,
  teamId,
  teamSlug,
  currentUserId,
  initialData = null,
}: TeamNotificationsClientProps) {
  const copy = messages.teamManagement.notifications;
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [previewingId, setPreviewingId] = useState("");
  const [runningId, setRunningId] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [testDialogOpen, setTestDialogOpen] = useState(false);
  const [previewDialogOpen, setPreviewDialogOpen] = useState(false);
  const [previewRule, setPreviewRule] = useState<NotificationRuleData | null>(
    null,
  );
  const [previewResult, setPreviewResult] =
    useState<NotificationRuleEvaluationData | null>(null);
  const [form, setForm] = useState<RuleFormState>(EMPTY_FORM);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const rulesQueryKey = [
    "dashboard",
    "team-notification-rules",
    teamId,
  ] as const;
  const rulesQuery = useQuery({
    queryKey: rulesQueryKey,
    queryFn: async ({ signal }) => {
      const [rules, sites, members, emailConfig] = await Promise.all([
        requestAdminService<NotificationRuleData[]>("notification-rules", {
          params: { teamId },
          signal,
        }),
        requestAdminService<SiteData[]>("sites", {
          params: { teamId },
          signal,
        }),
        requestAdminService<MemberData[]>("members", {
          params: { teamId },
          signal,
        }),
        requestAdminService<PublicNotificationEmailConfig>(
          "notification-email",
          { signal },
        ).catch(() => null),
      ]);
      return {
        rules,
        sites,
        members,
        emailConfigured:
          emailConfig?.enabled &&
          emailConfig.provider === "resend" &&
          Boolean(emailConfig.fromEmail) &&
          emailConfig.resend.configured,
      };
    },
    initialData: initialData
      ? {
          rules: initialData.rules,
          sites: initialData.sites,
          members: initialData.members,
          emailConfigured: initialData.emailConfigured,
        }
      : undefined,
    initialDataUpdatedAt: initialData?.fetchedAt,
    enabled: typeof window !== "undefined",
  });
  const rules = rulesQuery.data?.rules ?? [];
  const sites = rulesQuery.data?.sites ?? [];
  const members = rulesQuery.data?.members ?? [];
  const emailConfigured = rulesQuery.data?.emailConfigured ?? false;
  const loading = rulesQuery.isPending;

  const siteById = useMemo(
    () => new Map(sites.map((site) => [site.id, site])),
    [sites],
  );
  const memberByUserId = useMemo(
    () => new Map(members.map((member) => [member.userId, member])),
    [members],
  );
  const enabledCount = useMemo(
    () => rules.filter((rule) => rule.enabled).length,
    [rules],
  );
  const canCreateRule = sites.length > 0;

  useEffect(() => {
    if (rulesQuery.isError) toast.error(copy.loadRulesFailed);
  }, [copy.loadRulesFailed, rulesQuery.errorUpdatedAt, rulesQuery.isError]);

  function openCreate(type: RuleFormType = "report") {
    if (!canCreateRule) return;
    const firstSite = sites[0];
    setForm({
      ...EMPTY_FORM,
      type,
      siteId: firstSite?.id ?? "",
      name: "",
      scheduleKind: type === "report" ? "daily" : "interval",
      timezone: browserDefaultTimeZone(),
      recipientUserIds: defaultRecipientUserIds(members, currentUserId),
    });
    setDialogOpen(true);
  }

  function openEdit(rule: NotificationRuleData) {
    setForm(inferFormFromRule(rule));
    setDialogOpen(true);
  }

  async function saveRule() {
    if (saving) return;
    if (!form.siteId) {
      toast.error(copy.pleaseChooseSite);
      return;
    }
    if (form.recipientKind === "custom" && form.recipientUserIds.length === 0) {
      toast.error(copy.pleaseChooseRecipients);
      return;
    }
    setSaving(true);
    try {
      const payload = buildRulePayload(copy, form, sites);
      await requestAdminService<NotificationRuleData>("notification-rules", {
        method: form.id ? "PATCH" : "POST",
        body: form.id
          ? { ruleId: form.id, teamId, ...payload }
          : { teamId, ...payload },
      });
      await queryClient.invalidateQueries({ queryKey: rulesQueryKey });
      setDialogOpen(false);
      toast.success(form.id ? copy.ruleUpdated : copy.ruleCreated);
    } catch {
      toast.error(form.id ? copy.updateRuleFailed : copy.createRuleFailed);
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(rule: NotificationRuleData) {
    try {
      await requestAdminService<NotificationRuleData>("notification-rules", {
        method: "PATCH",
        body: {
          ruleId: rule.id,
          enabled: !rule.enabled,
        },
      });
      await queryClient.invalidateQueries({ queryKey: rulesQueryKey });
    } catch {
      toast.error(copy.updateRuleFailed);
    }
  }

  async function removeRule(rule: NotificationRuleData) {
    if (
      !window.confirm(
        formatI18nTemplate(copy.deleteConfirm, { name: rule.name }),
      )
    )
      return;
    try {
      await requestAdminService<{ id: string; removed: boolean }>(
        "notification-rules",
        {
          method: "DELETE",
          params: { id: rule.id },
        },
      );
      await queryClient.invalidateQueries({ queryKey: rulesQueryKey });
      toast.success(copy.ruleDeleted);
    } catch {
      toast.error(copy.deleteRuleFailed);
    }
  }

  async function handleSendTest() {
    if (testing) return;
    setTesting(true);
    try {
      await requestAdminService("notification-test", {
        method: "POST",
        body: { teamId, userId: currentUserId },
      });
      toast.success(copy.testNotificationSent);
      setTestDialogOpen(false);
    } catch {
      toast.error(copy.sendTestNotificationFailed);
    } finally {
      setTesting(false);
    }
  }

  async function handlePreview(rule: NotificationRuleData) {
    if (previewingId) return;
    setPreviewRule(rule);
    setPreviewResult(null);
    setPreviewDialogOpen(true);
    setPreviewingId(rule.id);
    try {
      const result = await requestAdminService<NotificationRuleEvaluationData>(
        "notification-rules/preview",
        {
          method: "POST",
          body: { ruleId: rule.id },
        },
      );
      setPreviewResult(result);
    } catch {
      toast.error(copy.previewFailed);
    } finally {
      setPreviewingId("");
    }
  }

  async function handleRunNow(rule: NotificationRuleData) {
    if (runningId) return;
    setRunningId(rule.id);
    try {
      const result = await requestAdminService<NotificationRuleRunData>(
        "notification-rules/run",
        {
          method: "POST",
          body: { ruleId: rule.id },
        },
      );
      toast.success(
        formatI18nTemplate(copy.runResultToast, {
          messages: result.messageCount,
          sent: Number(result.summary.emailSent ?? 0),
          failed: Number(result.summary.emailFailed ?? 0),
        }),
      );
      await queryClient.invalidateQueries({ queryKey: rulesQueryKey });
    } catch {
      toast.error(copy.runFailed);
    } finally {
      setRunningId("");
    }
  }

  return (
    <div className="space-y-4">
      <PageHeading
        title={copy.title}
        subtitle={copy.subtitle}
        actions={
          <>
            <Button type="button" variant="outline" asChild>
              <Link
                href={`/${locale}/app/${teamSlug}/notifications/email-preview`}
              >
                <RiMailSendLine />
                <span>{copy.emailPreview}</span>
              </Link>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTestDialogOpen(true)}
            >
              <RiMailSendLine />
              <span>{copy.sendTestNotification}</span>
            </Button>
            <Button
              type="button"
              onClick={() => openCreate()}
              disabled={!canCreateRule}
            >
              <RiAddLine />
              <span>{copy.createRule}</span>
            </Button>
          </>
        }
      />

      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiNotification3Line className="size-4" />
              {copy.rulesTitle}
            </CardTitle>
            <CardDescription>
              {formatI18nTemplate(copy.enabledCount, {
                count: enabledCount,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AutoResizer initial>
              <AutoTransition
                transitionKey={
                  loading ? "loading" : rules.length === 0 ? "empty" : "data"
                }
                initial={false}
                duration={0.18}
                type="fade"
                presenceMode="wait"
              >
                {loading ? (
                  <div
                    key="loading"
                    className="flex h-40 items-center justify-center text-sm text-muted-foreground"
                  >
                    <Spinner className="mr-2 size-4" />
                    {copy.loadingRules}
                  </div>
                ) : rules.length === 0 ? (
                  <div
                    key="empty"
                    className="flex flex-col items-center gap-3 py-12 text-center text-sm text-muted-foreground"
                  >
                    <RiNotification3Line className="size-8 text-muted-foreground/70" />
                    <p>{copy.empty}</p>
                  </div>
                ) : (
                  <Table key="data">
                    <TableHeader>
                      <TableRow>
                        <TableHead>{copy.columns.name}</TableHead>
                        <TableHead>{copy.columns.type}</TableHead>
                        <TableHead>{copy.columns.site}</TableHead>
                        <TableHead>{copy.columns.recipient}</TableHead>
                        <TableHead>{copy.columns.schedule}</TableHead>
                        <TableHead>{copy.lastChecked}</TableHead>
                        <TableHead>{copy.columns.nextRun}</TableHead>
                        <TableHead>{copy.columns.status}</TableHead>
                        <TableHead>{copy.actions}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rules.map((rule) => (
                        <TableRow key={rule.id}>
                          <TableCell className="font-medium">
                            {rule.name}
                          </TableCell>
                          <TableCell>
                            {ruleTypeLabel(copy, rule.type)}
                          </TableCell>
                          <TableCell>
                            {siteLabel(siteById, rule.siteId)}
                          </TableCell>
                          <TableCell>
                            {recipientLabel(
                              copy,
                              rule.recipient,
                              memberByUserId,
                            )}
                          </TableCell>
                          <TableCell>{scheduleLabel(copy, rule)}</TableCell>
                          <TableCell>
                            {formatRunAt(locale, rule.lastCheckedAt)}
                          </TableCell>
                          <TableCell>
                            {isCoolingDown(rule, nowSeconds) ? (
                              <span className="text-xs font-medium text-foreground/70">
                                {formatI18nTemplate(copy.coolingDownUntil, {
                                  time: formatRunAt(locale, rule.cooldownUntil),
                                })}
                              </span>
                            ) : (
                              <span>
                                {nextRunLabel(copy, locale, rule, nowSeconds)}
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={rule.enabled ? "default" : "secondary"}
                            >
                              {rule.enabled
                                ? copy.status.enabled
                                : copy.status.disabled}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="flex flex-wrap gap-2">
                              <TableActionButton
                                label={`${copy.preview}: ${rule.name}`}
                                disabled={previewingId === rule.id}
                                onClick={() => void handlePreview(rule)}
                                transitionKey={
                                  previewingId === rule.id
                                    ? "previewing"
                                    : "preview"
                                }
                              >
                                {previewingId === rule.id ? (
                                  <Spinner className="size-3" />
                                ) : (
                                  <RiEyeLine className="size-4" />
                                )}
                              </TableActionButton>
                              <TableActionButton
                                label={`${copy.runNow}: ${rule.name}`}
                                disabled={runningId === rule.id}
                                onClick={() => void handleRunNow(rule)}
                                transitionKey={
                                  runningId === rule.id ? "running" : "run"
                                }
                              >
                                {runningId === rule.id ? (
                                  <Spinner className="size-3" />
                                ) : (
                                  <RiPlayCircleLine className="size-4" />
                                )}
                              </TableActionButton>
                              <TableActionButton
                                label={`${copy.edit}: ${rule.name}`}
                                onClick={() => openEdit(rule)}
                              >
                                <RiEditLine className="size-4" />
                              </TableActionButton>
                              <TableActionButton
                                label={`${
                                  rule.enabled ? copy.disable : copy.enable
                                }: ${rule.name}`}
                                onClick={() => void toggleRule(rule)}
                                transitionKey={
                                  rule.enabled ? "enabled" : "disabled"
                                }
                              >
                                {rule.enabled ? (
                                  <RiPauseCircleLine className="size-4" />
                                ) : (
                                  <RiPlayCircleLine className="size-4" />
                                )}
                              </TableActionButton>
                              <TableActionButton
                                label={`${copy.delete}: ${rule.name}`}
                                tone="destructive"
                                onClick={() => void removeRule(rule)}
                              >
                                <RiDeleteBinLine className="size-4" />
                              </TableActionButton>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </AutoTransition>
            </AutoResizer>
          </CardContent>
        </Card>
      </div>

      <Dialog open={testDialogOpen} onOpenChange={setTestDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle icon={RiMailSendLine}>
              {copy.deliveryTestTitle}
            </DialogTitle>
            <DialogDescription>
              {copy.deliveryTestDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm text-muted-foreground">
            <div className="flex items-center gap-2 text-foreground">
              <RiCheckboxCircleLine className="size-4 text-emerald-600" />
              {copy.inAppTestHint}
            </div>
            <div
              className={`flex items-center gap-2${emailConfigured ? " text-foreground" : ""}`}
            >
              <RiMailSendLine
                className={`size-4${emailConfigured ? " text-emerald-600" : ""}`}
              />
              {emailConfigured
                ? copy.emailTestConfiguredHint
                : copy.emailTestUnconfiguredHint}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setTestDialogOpen(false)}
              disabled={testing}
            >
              <RiCloseLine className="size-4" />
              <span>{messages.teamSelect.cancel}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleSendTest}
              disabled={testing}
            >
              {testing ? <Spinner className="size-4" /> : <RiMailSendLine />}
              <span>{copy.sendTestNotification}</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ResponsiveDialog
        open={previewDialogOpen}
        onOpenChange={setPreviewDialogOpen}
      >
        <ResponsiveDialogContent desktopClassName="max-h-[min(860px,calc(100vh-2rem))] max-w-5xl">
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle icon={RiEyeLine}>
              {copy.previewDialogTitle}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {copy.previewDialogDescription}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-5">
            {previewRule ? (
              <div className="grid gap-3 border bg-muted/20 p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.name}
                  </p>
                  <p className="mt-1 font-medium">{previewRule.name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.type}
                  </p>
                  <p className="mt-1">
                    {ruleTypeLabel(copy, previewRule.type)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.site}
                  </p>
                  <p className="mt-1">
                    {siteLabel(siteById, previewRule.siteId)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.schedule}
                  </p>
                  <p className="mt-1">{scheduleLabel(copy, previewRule)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.condition}
                  </p>
                  <p className="mt-1">
                    {conditionLabel(
                      copy,
                      messages.conditionDescription,
                      previewRule,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.columns.recipient}
                  </p>
                  <p className="mt-1">
                    {recipientLabel(
                      copy,
                      previewRule.recipient,
                      memberByUserId,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.previewFields.createdAt}
                  </p>
                  <p className="mt-1">
                    {formatRunAt(locale, previewRule.createdAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.previewFields.updatedAt}
                  </p>
                  <p className="mt-1">
                    {formatRunAt(locale, previewRule.updatedAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {copy.previewFields.status}
                  </p>
                  <Badge
                    className="mt-1"
                    variant={previewRule.enabled ? "default" : "secondary"}
                  >
                    {previewRule.enabled
                      ? copy.status.enabled
                      : copy.status.disabled}
                  </Badge>
                </div>
              </div>
            ) : null}

            <AutoResizer initial duration={0.2}>
              <AutoTransition
                transitionKey={
                  previewingId
                    ? "loading"
                    : previewResult
                      ? previewResult.status
                      : "empty"
                }
                duration={0.18}
                type="fade"
                initial={false}
                presenceMode="wait"
              >
                {previewingId ? (
                  <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
                    <Spinner className="mr-2 size-4" />
                    {copy.previewFields.loadingContent}
                  </div>
                ) : previewResult ? (
                  <div className="space-y-5 text-sm">
                    <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          {copy.previewFields.status}
                        </p>
                        <Badge variant="outline">{previewResult.status}</Badge>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">
                          {copy.previewFields.summary}
                        </p>
                        <p className="break-words">
                          {previewSummary(previewResult)}
                        </p>
                      </div>
                    </div>

                    {previewResult.status === "triggered" ? (
                      <div className="space-y-5">
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">
                            {copy.previewFields.title}
                          </p>
                          <p className="font-medium">
                            {previewResult.message.title}
                          </p>
                        </div>
                        <div className="space-y-2">
                          <p className="text-xs text-muted-foreground">
                            {copy.previewFields.htmlPreview}
                          </p>
                          {previewResult.message.bodyHtml ? (
                            <iframe
                              title={copy.previewFields.htmlPreview}
                              sandbox=""
                              srcDoc={previewResult.message.bodyHtml}
                              className="h-[520px] w-full border bg-white"
                            />
                          ) : (
                            <div className="flex h-32 items-center justify-center border bg-muted/20 text-xs text-muted-foreground">
                              {copy.previewFields.noHtmlPreview}
                            </div>
                          )}
                        </div>
                        <div className="space-y-1">
                          <p className="text-xs text-muted-foreground">
                            {copy.previewFields.bodyText}
                          </p>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap bg-muted p-3 text-xs leading-5">
                            {previewResult.message.bodyText}
                          </pre>
                        </div>
                      </div>
                    ) : null}

                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">
                        {copy.previewFields.data}
                      </p>
                      <JsonTreePanel
                        value={previewResult}
                        labels={{
                          expandField: messages.events.expandField,
                          collapseField: messages.events.collapseField,
                          copyJson: messages.events.copyJson,
                          copiedJson: messages.events.copiedJson,
                          copyJsonFailed: messages.events.copyJsonFailed,
                          copyValue: messages.events.copyValue,
                          copiedValue: messages.events.copiedValue,
                          copyValueFailed: messages.events.copyValueFailed,
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="h-1" />
                )}
              </AutoTransition>
            </AutoResizer>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPreviewDialogOpen(false)}
            >
              <RiCloseLine className="size-4" />
              <span>{messages.teamSelect.cancel}</span>
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <ResponsiveDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <ResponsiveDialogContent
          className="flex flex-col overflow-hidden p-0"
          desktopClassName="max-h-[min(860px,calc(100vh-1rem))] max-w-6xl"
          drawerClassName="h-[80dvh] max-h-[80dvh]"
        >
          <div className="shrink-0 border-b p-4 sm:p-6">
            <ResponsiveDialogHeader>
              <ResponsiveDialogTitle icon={RiNotification3Line}>
                {form.id ? copy.editRule : copy.createRule}
              </ResponsiveDialogTitle>
              <ResponsiveDialogDescription>
                {copy.dialogDescription}
              </ResponsiveDialogDescription>
            </ResponsiveDialogHeader>
          </div>
          <ResponsiveDialogBody className="flex-1 p-4 sm:p-6">
            <RuleFormFields
              copy={copy}
              terms={messages.conditionDescription}
              locale={locale}
              form={form}
              sites={sites}
              members={members}
              currentUserId={currentUserId}
              onChange={(patch) =>
                setForm((current) => ({
                  ...current,
                  ...patch,
                }))
              }
            />
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter className="border-t p-4 sm:p-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={saving}
            >
              <RiCloseLine className="size-4" />
              <span>{messages.teamSelect.cancel}</span>
            </Button>
            <Button
              type="button"
              onClick={() => void saveRule()}
              disabled={saving}
            >
              {saving ? <Spinner className="size-4" /> : <RiSave3Line />}
              <span>{form.id ? copy.saveRule : copy.createRule}</span>
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </div>
  );
}
