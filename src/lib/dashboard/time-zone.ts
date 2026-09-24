import { normalizeTimeZone } from "@/lib/analytics/time-zone";

export const REPORTING_TIME_ZONE_COOKIE = "insightflare-reporting-time-zone";

const REPORTING_TIME_ZONE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Returns the browser's preferred time zone when Intl can provide one. */
export function browserTimeZone(): string {
  try {
    return normalizeTimeZone(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    );
  } catch {
    return "";
  }
}

/** Persists the effective reporting time zone without causing a navigation. */
export function writeReportingTimeZoneCookie(timeZone: string): void {
  if (typeof document === "undefined") return;
  const resolved = normalizeTimeZone(timeZone);
  if (!resolved) return;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${REPORTING_TIME_ZONE_COOKIE}=${encodeURIComponent(resolved)}; Path=/; Max-Age=${REPORTING_TIME_ZONE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}
