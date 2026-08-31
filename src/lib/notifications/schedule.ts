import {
  DEFAULT_RETENTION_CONFIG,
  retentionDaysForNotification,
} from "@/lib/retention";
import type { ScheduledTaskRetentionConfig } from "@/lib/scheduled-tasks";

import { safeParseRecord } from "./json";

export type NotificationScheduleConfig =
  | { kind: "daily"; time: string; timezone: string }
  | {
      kind: "weekly";
      time: string;
      timezone: string;
      dayOfWeek: number;
    }
  | {
      kind: "monthly";
      time: string;
      timezone: string;
      dayOfMonth: number;
    }
  | {
      kind: "quarterly";
      time: string;
      timezone: string;
      dayOfMonth: number;
    }
  | {
      kind: "yearly";
      time: string;
      timezone: string;
      month: number;
      dayOfMonth: number;
    }
  | { kind: "interval"; everyMinutes: number };

const DEFAULT_TIMEZONE = "UTC";
const MIN_INTERVAL_MINUTES = 30;
const MAX_INTERVAL_MINUTES = 60 * 24 * 30;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const TIME_RE = /^([01]\d|2[0-3]):(00|30)$/;

function cleanTimezone(value: unknown): string {
  const candidate =
    typeof value === "string" && value.trim() ? value.trim() : DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(
      new Date(),
    );
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function normalizeNotificationSchedule(
  input: unknown,
): NotificationScheduleConfig {
  const raw = safeParseRecord(input);
  const time =
    typeof raw.time === "string" && TIME_RE.test(raw.time) ? raw.time : "08:00";
  const timezone = cleanTimezone(raw.timezone);
  if (raw.kind === "daily") {
    return { kind: "daily", time, timezone };
  }
  if (raw.kind === "weekly") {
    const dayOfWeek = Math.trunc(Number(raw.dayOfWeek ?? 1));
    return {
      kind: "weekly",
      time,
      timezone,
      dayOfWeek: Math.max(
        0,
        Math.min(6, Number.isFinite(dayOfWeek) ? dayOfWeek : 1),
      ),
    };
  }
  if (raw.kind === "monthly") {
    return {
      kind: "monthly",
      time,
      timezone,
      dayOfMonth: normalizeDayOfMonth(raw.dayOfMonth),
    };
  }
  if (raw.kind === "quarterly") {
    return {
      kind: "quarterly",
      time,
      timezone,
      dayOfMonth: normalizeDayOfMonth(raw.dayOfMonth),
    };
  }
  if (raw.kind === "yearly") {
    const month = Math.trunc(Number(raw.month ?? 1));
    return {
      kind: "yearly",
      time,
      timezone,
      month: Math.max(1, Math.min(12, Number.isFinite(month) ? month : 1)),
      dayOfMonth: normalizeDayOfMonth(raw.dayOfMonth),
    };
  }
  if (raw.kind === "interval") {
    const everyMinutes = Math.trunc(Number(raw.everyMinutes ?? 60));
    return {
      kind: "interval",
      everyMinutes: Math.max(
        MIN_INTERVAL_MINUTES,
        Math.min(
          MAX_INTERVAL_MINUTES,
          Number.isFinite(everyMinutes) ? everyMinutes : 60,
        ),
      ),
    };
  }
  return { kind: "interval", everyMinutes: 60 };
}

function normalizeDayOfMonth(value: unknown): number {
  const day = Math.trunc(Number(value ?? 1));
  return Math.max(1, Math.min(31, Number.isFinite(day) ? day : 1));
}

function partsInTimezone(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = new Map(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.get("hour") ?? 0);
  return {
    year: Number(parts.get("year") ?? 1970),
    month: Number(parts.get("month") ?? 1),
    day: Number(parts.get("day") ?? 1),
    hour: hour === 24 ? 0 : hour,
    minute: Number(parts.get("minute") ?? 0),
    second: Number(parts.get("second") ?? 0),
  };
}

function timezoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = partsInTimezone(new Date(utcMs), timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - utcMs;
}

function zonedTimeToUtcMs(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
  timeZone: string;
}): number {
  const localAsUtc = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    input.second ?? 0,
  );
  const firstGuess = localAsUtc - timezoneOffsetMs(localAsUtc, input.timeZone);
  const corrected = localAsUtc - timezoneOffsetMs(firstGuess, input.timeZone);
  return corrected;
}

function timeParts(time: string): { hour: number; minute: number } {
  const match = TIME_RE.exec(time);
  return {
    hour: Number(match?.[1] ?? 8),
    minute: Number(match?.[2] ?? 0),
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeCalendarDay(year: number, month: number, day: number) {
  return Math.min(day, daysInMonth(year, month));
}

function localCandidateToUtcMs(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
  clampDay?: boolean;
}) {
  return zonedTimeToUtcMs({
    ...input,
    day: input.clampDay
      ? normalizeCalendarDay(input.year, input.month, input.day)
      : input.day,
  });
}

function nextDailyRunAtMs(
  schedule: Extract<NotificationScheduleConfig, { kind: "daily" }>,
  fromMs: number,
): number {
  const { hour, minute } = timeParts(schedule.time);
  const localNow = partsInTimezone(new Date(fromMs), schedule.timezone);
  let candidate = localCandidateToUtcMs({
    year: localNow.year,
    month: localNow.month,
    day: localNow.day,
    hour,
    minute,
    timeZone: schedule.timezone,
  });
  if (candidate <= fromMs) {
    candidate = localCandidateToUtcMs({
      year: localNow.year,
      month: localNow.month,
      day: localNow.day + 1,
      hour,
      minute,
      timeZone: schedule.timezone,
    });
  }
  return candidate;
}

function nextWeeklyRunAtMs(
  schedule: Extract<NotificationScheduleConfig, { kind: "weekly" }>,
  fromMs: number,
): number {
  const { hour, minute } = timeParts(schedule.time);
  const localNow = partsInTimezone(new Date(fromMs), schedule.timezone);
  const dayIndex = new Date(
    Date.UTC(localNow.year, localNow.month - 1, localNow.day),
  ).getUTCDay();
  const delta = (schedule.dayOfWeek - dayIndex + 7) % 7;
  let candidate = localCandidateToUtcMs({
    year: localNow.year,
    month: localNow.month,
    day: localNow.day + delta,
    hour,
    minute,
    timeZone: schedule.timezone,
  });
  if (candidate <= fromMs) {
    candidate = localCandidateToUtcMs({
      year: localNow.year,
      month: localNow.month,
      day: localNow.day + delta + 7,
      hour,
      minute,
      timeZone: schedule.timezone,
    });
  }
  return candidate;
}

function nextMonthlyRunAtMs(
  schedule: Extract<
    NotificationScheduleConfig,
    { kind: "monthly" | "quarterly" }
  >,
  fromMs: number,
): number {
  const match = TIME_RE.exec(schedule.time);
  const targetHour = Number(match?.[1] ?? 8);
  const targetMinute = Number(match?.[2] ?? 0);
  const localNow = partsInTimezone(new Date(fromMs), schedule.timezone);
  const step = schedule.kind === "quarterly" ? 3 : 1;
  let candidateMonth =
    schedule.kind === "quarterly"
      ? Math.floor((localNow.month - 1) / 3) * 3 + 1
      : localNow.month;
  let candidate = localCandidateToUtcMs({
    year: localNow.year,
    month: candidateMonth,
    day: schedule.dayOfMonth,
    hour: targetHour,
    minute: targetMinute,
    timeZone: schedule.timezone,
    clampDay: true,
  });
  if (candidate <= fromMs) {
    candidateMonth += step;
    candidate = localCandidateToUtcMs({
      year: localNow.year,
      month: candidateMonth,
      day: schedule.dayOfMonth,
      hour: targetHour,
      minute: targetMinute,
      timeZone: schedule.timezone,
      clampDay: true,
    });
  }
  return candidate;
}

function nextYearlyRunAtMs(
  schedule: Extract<NotificationScheduleConfig, { kind: "yearly" }>,
  fromMs: number,
): number {
  const { hour, minute } = timeParts(schedule.time);
  const localNow = partsInTimezone(new Date(fromMs), schedule.timezone);
  let candidate = localCandidateToUtcMs({
    year: localNow.year,
    month: schedule.month,
    day: schedule.dayOfMonth,
    hour,
    minute,
    timeZone: schedule.timezone,
    clampDay: true,
  });
  if (candidate <= fromMs) {
    candidate = localCandidateToUtcMs({
      year: localNow.year + 1,
      month: schedule.month,
      day: schedule.dayOfMonth,
      hour,
      minute,
      timeZone: schedule.timezone,
      clampDay: true,
    });
  }
  return candidate;
}

function nextIntervalRunAtMs(
  schedule: Extract<NotificationScheduleConfig, { kind: "interval" }>,
  fromMs: number,
): number {
  if (schedule.everyMinutes === 60) {
    return (
      Math.floor(fromMs / (60 * MINUTE_MS)) * 60 * MINUTE_MS + 60 * MINUTE_MS
    );
  }
  const intervalMs = schedule.everyMinutes * MINUTE_MS;
  return Math.ceil((fromMs + 1) / intervalMs) * intervalMs;
}

export function computeNextNotificationRunAt(
  scheduleInput: unknown,
  fromEpochSeconds: number,
): number {
  const schedule = normalizeNotificationSchedule(scheduleInput);
  const fromMs = Math.max(0, Math.trunc(fromEpochSeconds)) * 1000;
  const nextMs =
    schedule.kind === "daily"
      ? nextDailyRunAtMs(schedule, fromMs)
      : schedule.kind === "weekly"
        ? nextWeeklyRunAtMs(schedule, fromMs)
        : schedule.kind === "monthly" || schedule.kind === "quarterly"
          ? nextMonthlyRunAtMs(schedule, fromMs)
          : schedule.kind === "yearly"
            ? nextYearlyRunAtMs(schedule, fromMs)
            : nextIntervalRunAtMs(schedule, fromMs);
  return Math.floor(Math.max(fromMs + MINUTE_MS, nextMs) / 1000);
}

export function notificationRuleExpiresAtSeconds(input: {
  type: string;
  severity: string;
  createdAtSeconds: number;
  retention?: ScheduledTaskRetentionConfig;
}): number {
  const days = retentionDaysForNotification(
    input,
    input.retention ?? DEFAULT_RETENTION_CONFIG,
  );
  return input.createdAtSeconds + Math.floor((days * DAY_MS) / 1000);
}
