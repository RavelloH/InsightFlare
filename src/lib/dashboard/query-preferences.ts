import {
  type CustomTimeRange,
  type DashboardInterval,
  DEFAULT_RANGE_PRESET,
  type RangePreset,
  resolveRangePreset,
  resolveTimeWindow,
  type TimeWindow,
} from "./query-state";
import {
  REPORTING_TIME_ZONE_COOKIE,
  resolveReportingTimeZone,
} from "./time-zone";

export const DASHBOARD_QUERY_PREFERENCES_COOKIE =
  "insightflare-dashboard-query";

const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export interface DashboardQueryPreferences {
  range: RangePreset;
  interval?: DashboardInterval;
  customRange: CustomTimeRange | null;
}

const VALID_INTERVALS = new Set<DashboardInterval>([
  "minute",
  "hour",
  "day",
  "week",
  "month",
]);

function normalizeCustomRange(value: unknown): CustomTimeRange | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CustomTimeRange>;
  if (!Number.isFinite(candidate.from) || !Number.isFinite(candidate.to)) {
    return null;
  }
  if ((candidate.from ?? 0) >= (candidate.to ?? 0)) return null;
  return {
    from: Math.max(0, Math.floor(candidate.from ?? 0)),
    to: Math.max(1, Math.floor(candidate.to ?? 1)),
  };
}

function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function readReportingTimeZoneFromCookie(
  cookieHeader: string | null,
): string {
  return resolveReportingTimeZone(
    cookieValue(cookieHeader, REPORTING_TIME_ZONE_COOKIE),
  );
}

export function readDashboardQueryPreferences(
  cookieHeader: string | null,
): DashboardQueryPreferences {
  const raw = cookieValue(cookieHeader, DASHBOARD_QUERY_PREFERENCES_COOKIE);
  if (!raw) {
    return { range: DEFAULT_RANGE_PRESET, customRange: null };
  }

  try {
    const parsed = JSON.parse(raw) as {
      range?: string;
      interval?: string;
      customRange?: unknown;
    };
    const interval = VALID_INTERVALS.has(parsed.interval as DashboardInterval)
      ? (parsed.interval as DashboardInterval)
      : undefined;
    return {
      range: resolveRangePreset(parsed.range),
      interval,
      customRange: normalizeCustomRange(parsed.customRange),
    };
  } catch {
    return { range: DEFAULT_RANGE_PRESET, customRange: null };
  }
}

export function resolveDashboardInitialWindow(
  cookieHeader: string | null,
  now = Date.now(),
): TimeWindow {
  const preferences = readDashboardQueryPreferences(cookieHeader);
  return resolveTimeWindow(preferences.range, now, {
    interval: preferences.interval,
    customRange: preferences.customRange ?? undefined,
    timeZone: readReportingTimeZoneFromCookie(cookieHeader),
  });
}

/** Persists only range controls. Filters remain represented by the URL. */
export function writeDashboardQueryPreferences(
  preferences: DashboardQueryPreferences,
): void {
  if (typeof document === "undefined") return;
  const payload = JSON.stringify({
    range: preferences.range,
    interval: preferences.interval,
    customRange: preferences.customRange,
  });
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${DASHBOARD_QUERY_PREFERENCES_COOKIE}=${encodeURIComponent(payload)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}
