import { intlLocale } from "./chart-format";
import type { ChartLocale, DashboardInterval } from "./types";

export type ChartAxisDateFormat = "compact" | "regular" | "time";

// Chart instances and tooltip renders share the same small set of formats.
// Keep retention bounded across locales and reporting time zones in SSR
// isolates as well as long-lived browser sessions.
const MAX_DATE_FORMATTERS = 64;
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function cachedDateFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = JSON.stringify([locale, options]);
  const cached = dateFormatters.get(key);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat(locale, options);
  if (dateFormatters.size >= MAX_DATE_FORMATTERS) {
    const oldest = dateFormatters.keys().next().value;
    if (oldest !== undefined) dateFormatters.delete(oldest);
  }
  dateFormatters.set(key, created);
  return created;
}

export function createChartAxisDateFormatter(
  locale: ChartLocale,
  interval: DashboardInterval,
  timeZone: string,
  format: ChartAxisDateFormat = "compact",
): Intl.DateTimeFormat {
  const resolvedLocale = intlLocale(locale);
  if (format === "time") {
    return cachedDateFormatter(resolvedLocale, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  if (format === "regular") {
    if (interval === "minute" || interval === "hour") {
      return cachedDateFormatter(resolvedLocale, {
        timeZone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    if (interval === "month") {
      return cachedDateFormatter(resolvedLocale, {
        timeZone,
        year: "numeric",
        month: "short",
      });
    }
    return cachedDateFormatter(resolvedLocale, {
      timeZone,
      month: "short",
      day: "numeric",
    });
  }

  if (interval === "minute" || interval === "hour") {
    return cachedDateFormatter(resolvedLocale, {
      timeZone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "day") {
    return cachedDateFormatter(resolvedLocale, {
      timeZone,
      month: "numeric",
      day: "numeric",
    });
  }
  return cachedDateFormatter(resolvedLocale, {
    timeZone,
    year: "2-digit",
    month: "short",
    day: interval === "week" ? "numeric" : undefined,
  });
}

export function createChartTooltipDateFormatter(
  locale: ChartLocale,
  interval: DashboardInterval,
  timeZone: string,
): Intl.DateTimeFormat {
  const dateOptions: Intl.DateTimeFormatOptions = {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  };
  if (interval === "minute" || interval === "hour") {
    dateOptions.hour = "2-digit";
    dateOptions.minute = "2-digit";
  }
  return cachedDateFormatter(intlLocale(locale), dateOptions);
}
