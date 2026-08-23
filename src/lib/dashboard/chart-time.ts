import { intlLocale } from "@/lib/dashboard/format";
import type { DashboardInterval } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";

export type ChartAxisDateFormat = "compact" | "regular" | "time";

export function createChartAxisDateFormatter(
  locale: Locale,
  interval: DashboardInterval,
  timeZone: string,
  format: ChartAxisDateFormat = "compact",
): Intl.DateTimeFormat {
  if (format === "time") {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  if (format === "regular") {
    if (interval === "minute" || interval === "hour") {
      return new Intl.DateTimeFormat(intlLocale(locale), {
        timeZone,
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    if (interval === "month") {
      return new Intl.DateTimeFormat(intlLocale(locale), {
        timeZone,
        year: "numeric",
        month: "short",
      });
    }
    return new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      month: "short",
      day: "numeric",
    });
  }

  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  if (interval === "day") {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      month: "numeric",
      day: "numeric",
    });
  }
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    year: "2-digit",
    month: "short",
    day: interval === "week" ? "numeric" : undefined,
  });
}

export function createChartTooltipDateFormatter(
  locale: Locale,
  interval: DashboardInterval,
  timeZone: string,
): Intl.DateTimeFormat {
  if (interval === "minute" || interval === "hour") {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
