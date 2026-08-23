import type { FilterDocument, QueryWindow } from "@/lib/edge/query/core";
import { queryOverviewAggregate } from "@/lib/edge/query/overview";
import {
  queryPagesAggregate,
  queryReferrerAggregate,
} from "@/lib/edge/query/pages";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/query-contract";
import { SITE_PK_FROM_SITE_ID_SQL } from "@/lib/edge/site-identity-sql";
import type { Env } from "@/lib/edge/types";

import {
  getOrCreateCachedPromise,
  notificationCacheKey,
  type NotificationInvocationCache,
  type NotificationMetricCacheKey,
  type NotificationReportCacheKey,
  type NotificationSiteInfo,
} from "./notification-cache";

export type NotificationMetric = "views" | "visitors" | "sessions";
export type NotificationMetricWindow = "last_1h" | "last_24h" | "yesterday";
export type NotificationReportType =
  | "daily"
  | "weekly"
  | "monthly"
  | "quarterly"
  | "yearly";

export interface NotificationReportRange {
  from: number;
  to: number;
  label: string;
}

export interface ReportData {
  siteName: string;
  siteDomain: string;
  reportType: NotificationReportType;
  range: NotificationReportRange;
  metrics: {
    views: number;
    visitors: number;
    sessions: number;
  };
  topPages: Array<{
    path: string;
    views: number;
  }>;
  topReferrers: Array<{
    referrer: string;
    visits: number;
  }>;
}

export type DailyReportData = ReportData;

export interface MetricValueResult {
  metric: NotificationMetric;
  window: NotificationMetricWindow;
  value: number;
  range: {
    from: number;
    to: number;
  };
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
  return localAsUtc - timezoneOffsetMs(firstGuess, input.timeZone);
}

function cleanTimezone(value: unknown): string {
  const timeZone =
    typeof value === "string" && value.trim() ? value.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return "UTC";
  }
}

function dateLabel(parts: { year: number; month: number; day: number }) {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function rangeLabel(
  startMs: number,
  endExclusiveMs: number,
  timeZone: string,
): string {
  const from = dateLabel(partsInTimezone(new Date(startMs), timeZone));
  const to = dateLabel(
    partsInTimezone(new Date(Math.max(startMs, endExclusiveMs - 1)), timeZone),
  );
  return from === to ? from : `${from} to ${to}`;
}

export function notificationWindowFor(input: {
  window: NotificationMetricWindow;
  now: number;
  timezone?: string;
}): QueryWindow & { label: string } {
  const nowMs = Math.max(0, Math.trunc(input.now)) * 1000;
  const timeZone = cleanTimezone(input.timezone);
  if (input.window === "last_1h") {
    return {
      startMs: nowMs - 60 * 60 * 1000,
      endExclusiveMs: nowMs,
      nowMs,
      timeZone,
      label: "last 1 hour",
    };
  }
  if (input.window === "last_24h") {
    return {
      startMs: nowMs - 24 * 60 * 60 * 1000,
      endExclusiveMs: nowMs,
      nowMs,
      timeZone,
      label: "last 24 hours",
    };
  }
  const local = partsInTimezone(new Date(nowMs), timeZone);
  const startToday = zonedTimeToUtcMs({
    year: local.year,
    month: local.month,
    day: local.day,
    hour: 0,
    minute: 0,
    timeZone,
  });
  const startYesterday = zonedTimeToUtcMs({
    year: local.year,
    month: local.month,
    day: local.day - 1,
    hour: 0,
    minute: 0,
    timeZone,
  });
  const yesterdayParts = partsInTimezone(new Date(startYesterday), timeZone);
  return {
    startMs: startYesterday,
    endExclusiveMs: startToday,
    nowMs,
    timeZone,
    label: dateLabel(yesterdayParts),
  };
}

export function notificationReportWindowFor(input: {
  reportType: NotificationReportType;
  now: number;
  timezone?: string;
}): QueryWindow & { label: string } {
  const nowMs = Math.max(0, Math.trunc(input.now)) * 1000;
  const timeZone = cleanTimezone(input.timezone);
  const local = partsInTimezone(new Date(nowMs), timeZone);

  if (input.reportType === "daily") {
    return notificationWindowFor({
      window: "yesterday",
      now: input.now,
      timezone: timeZone,
    });
  }

  if (input.reportType === "weekly") {
    const dayIndex = new Date(
      Date.UTC(local.year, local.month - 1, local.day),
    ).getUTCDay();
    const daysSinceMonday = (dayIndex + 6) % 7;
    const startThisWeek = zonedTimeToUtcMs({
      year: local.year,
      month: local.month,
      day: local.day - daysSinceMonday,
      hour: 0,
      minute: 0,
      timeZone,
    });
    const startMs = startThisWeek - 7 * 24 * 60 * 60 * 1000;
    const endExclusiveMs = startThisWeek;
    return {
      startMs,
      endExclusiveMs,
      nowMs,
      timeZone,
      label: rangeLabel(startMs, endExclusiveMs, timeZone),
    };
  }

  if (input.reportType === "monthly") {
    const startThisMonth = zonedTimeToUtcMs({
      year: local.year,
      month: local.month,
      day: 1,
      hour: 0,
      minute: 0,
      timeZone,
    });
    const previousMonth = local.month === 1 ? 12 : local.month - 1;
    const previousYear = local.month === 1 ? local.year - 1 : local.year;
    const startMs = zonedTimeToUtcMs({
      year: previousYear,
      month: previousMonth,
      day: 1,
      hour: 0,
      minute: 0,
      timeZone,
    });
    return {
      startMs,
      endExclusiveMs: startThisMonth,
      nowMs,
      timeZone,
      label: `${previousYear}-${String(previousMonth).padStart(2, "0")}`,
    };
  }

  if (input.reportType === "quarterly") {
    const currentQuarterStartMonth = Math.floor((local.month - 1) / 3) * 3 + 1;
    const startThisQuarter = zonedTimeToUtcMs({
      year: local.year,
      month: currentQuarterStartMonth,
      day: 1,
      hour: 0,
      minute: 0,
      timeZone,
    });
    const previousQuarterStartMonth =
      currentQuarterStartMonth === 1 ? 10 : currentQuarterStartMonth - 3;
    const previousQuarterYear =
      currentQuarterStartMonth === 1 ? local.year - 1 : local.year;
    const startMs = zonedTimeToUtcMs({
      year: previousQuarterYear,
      month: previousQuarterStartMonth,
      day: 1,
      hour: 0,
      minute: 0,
      timeZone,
    });
    const quarter = Math.floor((previousQuarterStartMonth - 1) / 3) + 1;
    return {
      startMs,
      endExclusiveMs: startThisQuarter,
      nowMs,
      timeZone,
      label: `${previousQuarterYear} Q${quarter}`,
    };
  }

  const startThisYear = zonedTimeToUtcMs({
    year: local.year,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    timeZone,
  });
  const previousYear = local.year - 1;
  const startMs = zonedTimeToUtcMs({
    year: previousYear,
    month: 1,
    day: 1,
    hour: 0,
    minute: 0,
    timeZone,
  });
  return {
    startMs,
    endExclusiveMs: startThisYear,
    nowMs,
    timeZone,
    label: String(previousYear),
  };
}

export async function loadSiteInfo(
  env: Env,
  siteId: string,
  cache?: NotificationInvocationCache,
): Promise<NotificationSiteInfo | null> {
  if (!cache) return loadSiteInfoUncached(env, siteId);
  return getOrCreateCachedPromise(cache.sites, siteId, () =>
    loadSiteInfoUncached(env, siteId),
  );
}

async function loadSiteInfoUncached(
  env: Env,
  siteId: string,
): Promise<NotificationSiteInfo | null> {
  const row = await env.DB.prepare(
    "SELECT name, domain FROM sites WHERE id = ? LIMIT 1",
  )
    .bind(siteId)
    .first<NotificationSiteInfo>();
  return row ?? null;
}

export async function loadDailyReportData(
  env: Env,
  input: {
    siteId: string;
    now: number;
    timezone?: string;
    cache?: NotificationInvocationCache;
  },
): Promise<DailyReportData | null> {
  return loadReportData(env, { ...input, reportType: "daily" });
}

export async function loadReportData(
  env: Env,
  input: {
    siteId: string;
    now: number;
    timezone?: string;
    reportType: NotificationReportType;
    cache?: NotificationInvocationCache;
  },
): Promise<ReportData | null> {
  const key = notificationCacheKey([
    input.siteId,
    input.reportType,
    Math.trunc(input.now),
    cleanTimezone(input.timezone),
  ] satisfies NotificationReportCacheKey);
  if (input.cache) {
    return getOrCreateCachedPromise(input.cache.reports, key, () =>
      loadReportDataUncached(env, input),
    );
  }
  return loadReportDataUncached(env, input);
}

async function loadReportDataUncached(
  env: Env,
  input: {
    siteId: string;
    now: number;
    timezone?: string;
    reportType: NotificationReportType;
    cache?: NotificationInvocationCache;
  },
): Promise<ReportData | null> {
  const site = await loadSiteInfo(env, input.siteId, input.cache);
  if (!site) return null;
  const window = notificationReportWindowFor({
    reportType: input.reportType,
    now: input.now,
    timezone: input.timezone,
  });
  const [overview, pages, referrers] = await Promise.all([
    loadOverviewAggregate(
      env,
      input.siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
      input.cache,
    ),
    queryPagesAggregate(
      env,
      input.siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
      5,
      false,
    ),
    queryReferrerAggregate(
      env,
      input.siteId,
      window,
      EMPTY_FILTER_DOCUMENT,
      5,
      false,
    ),
  ]);
  return {
    siteName: site.name,
    siteDomain: site.domain,
    reportType: input.reportType,
    range: {
      from: Math.floor(window.startMs / 1000),
      to: Math.floor(window.endExclusiveMs / 1000),
      label: window.label,
    },
    metrics: {
      views: overview.value.views,
      visitors: overview.value.visitors,
      sessions: overview.value.sessions,
    },
    topPages: pages.map((row) => ({
      path: row.pathname || "/",
      views: row.views,
    })),
    topReferrers: referrers.map((row) => ({
      referrer: row.referrer || "Direct",
      visits: row.sessions,
    })),
  };
}

export async function loadMetricValue(
  env: Env,
  input: {
    siteId: string;
    metric: NotificationMetric;
    window: NotificationMetricWindow;
    now: number;
    timezone?: string;
    cache?: NotificationInvocationCache;
  },
): Promise<MetricValueResult> {
  const window = notificationWindowFor({
    window: input.window,
    now: input.now,
    timezone: input.timezone,
  });
  const key = notificationCacheKey([
    input.siteId,
    input.metric,
    input.window,
    Math.trunc(window.startMs),
    Math.trunc(window.endExclusiveMs),
    window.timeZone,
  ] satisfies NotificationMetricCacheKey);
  if (input.cache) {
    return getOrCreateCachedPromise(input.cache.metrics, key, () =>
      loadMetricValueUncached(env, input, window),
    );
  }
  return loadMetricValueUncached(env, input, window);
}

async function loadMetricValueUncached(
  env: Env,
  input: {
    siteId: string;
    metric: NotificationMetric;
    window: NotificationMetricWindow;
    now: number;
    timezone?: string;
    cache?: NotificationInvocationCache;
  },
  window: QueryWindow,
): Promise<MetricValueResult> {
  const overview = await loadOverviewAggregate(
    env,
    input.siteId,
    window,
    EMPTY_FILTER_DOCUMENT,
    input.cache,
  );
  return {
    metric: input.metric,
    window: input.window,
    value: overview.value[input.metric],
    range: {
      from: Math.floor(window.startMs / 1000),
      to: Math.floor(window.endExclusiveMs / 1000),
    },
  };
}

export async function loadPreviousMetricValue(
  env: Env,
  input: {
    siteId: string;
    metric: NotificationMetric;
    window: NotificationMetricWindow;
    now: number;
    timezone?: string;
    cache?: NotificationInvocationCache;
  },
): Promise<MetricValueResult> {
  const currentWindow = notificationWindowFor({
    window: input.window,
    now: input.now,
    timezone: input.timezone,
  });
  const width = Math.max(
    1,
    currentWindow.endExclusiveMs - currentWindow.startMs,
  );
  const previousWindow = {
    startMs: Math.max(0, currentWindow.startMs - width),
    endExclusiveMs: Math.max(1, currentWindow.startMs),
    nowMs: currentWindow.nowMs,
    timeZone: currentWindow.timeZone,
  };
  const key = notificationCacheKey([
    input.siteId,
    input.metric,
    input.window,
    Math.trunc(previousWindow.startMs),
    Math.trunc(previousWindow.endExclusiveMs),
    previousWindow.timeZone,
  ] satisfies NotificationMetricCacheKey);
  if (input.cache) {
    return getOrCreateCachedPromise(input.cache.previousMetrics, key, () =>
      loadPreviousMetricValueUncached(env, input, previousWindow),
    );
  }
  return loadPreviousMetricValueUncached(env, input, previousWindow);
}

async function loadPreviousMetricValueUncached(
  env: Env,
  input: {
    siteId: string;
    metric: NotificationMetric;
    window: NotificationMetricWindow;
    cache?: NotificationInvocationCache;
  },
  previousWindow: QueryWindow,
): Promise<MetricValueResult> {
  const overview = await loadOverviewAggregate(
    env,
    input.siteId,
    previousWindow,
    EMPTY_FILTER_DOCUMENT,
    input.cache,
  );
  return {
    metric: input.metric,
    window: input.window,
    value: overview.value[input.metric],
    range: {
      from: Math.floor(previousWindow.startMs / 1000),
      to: Math.floor(previousWindow.endExclusiveMs / 1000),
    },
  };
}

export async function loadCumulativeMetricValue(
  env: Env,
  input: {
    siteId: string;
    metric: NotificationMetric;
    now: number;
    timezone?: string;
    cache?: NotificationInvocationCache;
  },
): Promise<number> {
  const nowMs = Math.max(0, Math.trunc(input.now)) * 1000;
  const window = {
    startMs: 0,
    endExclusiveMs: Math.max(1, nowMs),
    nowMs,
    timeZone: cleanTimezone(input.timezone),
  } satisfies QueryWindow;
  const key = notificationCacheKey([
    input.siteId,
    input.metric,
    Math.trunc(nowMs),
    window.timeZone,
  ]);
  if (input.cache) {
    return getOrCreateCachedPromise(input.cache.cumulativeMetrics, key, () =>
      loadCumulativeMetricValueUncached(env, input, window),
    );
  }
  return loadCumulativeMetricValueUncached(env, input, window);
}

async function loadCumulativeMetricValueUncached(
  env: Env,
  input: {
    siteId: string;
    metric: NotificationMetric;
    cache?: NotificationInvocationCache;
  },
  window: QueryWindow,
): Promise<number> {
  const overview = await loadOverviewAggregate(
    env,
    input.siteId,
    window,
    EMPTY_FILTER_DOCUMENT,
    input.cache,
  );
  return overview.value[input.metric];
}

export async function loadSiteLastSeenAt(
  env: Env,
  siteId: string,
  cache?: NotificationInvocationCache,
): Promise<number | null> {
  if (cache) {
    return getOrCreateCachedPromise(cache.lastSeenAt, siteId, () =>
      loadSiteLastSeenAtUncached(env, siteId),
    );
  }
  return loadSiteLastSeenAtUncached(env, siteId);
}

async function loadSiteLastSeenAtUncached(
  env: Env,
  siteId: string,
): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT MAX(last_activity_at) AS lastSeenAt
     FROM visits
     WHERE site_pk = ${SITE_PK_FROM_SITE_ID_SQL}`,
  )
    .bind(siteId)
    .first<{ lastSeenAt: number | null }>();
  const value = Number(row?.lastSeenAt ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value / 1000) : null;
}

async function loadOverviewAggregate(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  cache?: NotificationInvocationCache,
) {
  if (!cache) return queryOverviewAggregate(env, siteId, window, filters);
  const key = notificationCacheKey([
    siteId,
    window.startMs,
    window.endExclusiveMs,
    window.nowMs,
    window.timeZone,
    filters,
  ]);
  return getOrCreateCachedPromise(cache.overviews, key, () =>
    queryOverviewAggregate(env, siteId, window, filters),
  );
}
