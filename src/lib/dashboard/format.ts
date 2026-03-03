import type { Locale } from "@/lib/i18n/config";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
};

export function numberFormat(locale: Locale, value: number): string {
  return new Intl.NumberFormat(DATE_LOCALE[locale]).format(value);
}

export function percentFormat(locale: Locale, value: number): string {
  return new Intl.NumberFormat(DATE_LOCALE[locale], {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

export function shortDateTime(locale: Locale, value: number): string {
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function shortDate(locale: Locale, value: number): string {
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function durationFormat(locale: Locale, ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));

  if (seconds < 60) {
    return locale === "zh" ? `${seconds}秒` : `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  if (minutes < 60) {
    if (remain === 0) return locale === "zh" ? `${minutes}分` : `${minutes}m`;
    return locale === "zh" ? `${minutes}分${remain}秒` : `${minutes}m ${remain}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (remainMinutes === 0) return locale === "zh" ? `${hours}小时` : `${hours}h`;
  return locale === "zh" ? `${hours}小时${remainMinutes}分` : `${hours}h ${remainMinutes}m`;
}
