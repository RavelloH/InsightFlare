import { type ReactNode, useEffect, useMemo, useState } from "react";
import { RiAddLine, RiDeleteBinLine } from "@remixicon/react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildTimeZoneOptions,
  supportedTimeZones,
} from "@/lib/analytics/time-zone";
import { intlLocale } from "@/lib/dashboard/format";
import {
  type MemberData,
  type SiteData,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

import {
  browserDefaultTimeZone,
  cooldownLabel,
  defaultMetricCondition,
  defaultName,
  defaultRecipientUserIds,
  isReportType,
  isScheduleKind,
  memberName,
  type MetricConditionForm,
  nextConditionId,
  recipientTextFromForm,
  REPORT_TYPES,
  type RuleFormState,
  type RuleFormType,
  ruleSummaryLines,
  ruleSummaryTitle,
  scheduleKindFromReportType,
  scheduleTextFromForm,
  TIME_OPTIONS,
  WEEK_DAY_INDEXES,
} from "./model";
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
export function RuleFormFields({
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
