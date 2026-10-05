import { intlLocale } from "./chart-format";
import type { ChartLocale, DashboardInterval } from "./types";

export type ChartAxisDateFormat = "compact" | "regular" | "time";

export function createChartAxisDateFormatter(
  locale: ChartLocale,
  interval: DashboardInterval,
  timeZone: string,
  format: ChartAxisDateFormat = "compact",
): Intl.DateTimeFormat {
  const resolvedLocale = intlLocale(locale);
  if (format === "time") {
    return new Intl.DateTimeFormat(resolvedLocale, {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  if (format === "regular") {
    if (interval === "minute" || interval === "hour") {
      return new Intl.DateTimeFormat(resolvedLocale, {
        timeZone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    if (interval === "month") {
      return new Intl.DateTimeFormat(resolvedLocale, {
        timeZone,
        year: "numeric",
        month: "short",
      });
    }
    return new Intl.DateTimeFormat(resolvedLocale, {
      timeZone,
      month: "short",
      day: "numeric",
    });
  }

  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(resolvedLocale, {
      timeZone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "day") {
    return new Intl.DateTimeFormat(resolvedLocale, {
      timeZone,
      month: "numeric",
      day: "numeric",
    });
  }
  return new Intl.DateTimeFormat(resolvedLocale, {
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
  return new Intl.DateTimeFormat(intlLocale(locale), dateOptions);
}
