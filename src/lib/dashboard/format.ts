import type { Locale } from "@/lib/i18n/config";

const INTL_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
};

const DURATION_UNITS: Record<
  Locale,
  {
    second: string;
    minute: string;
    hour: string;
    join: string;
  }
> = {
  en: {
    second: "s",
    minute: "m",
    hour: "h",
    join: " ",
  },
  zh: {
    second: "秒",
    minute: "分",
    hour: "小时",
    join: "",
  },
};

export function intlLocale(locale: Locale): string {
  return INTL_LOCALE[locale];
}

export function numberFormat(locale: Locale, value: number): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}

export function percentFormat(locale: Locale, value: number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

export function shortDateTime(locale: Locale, value: number): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function shortDate(locale: Locale, value: number): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

export function durationFormat(locale: Locale, ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const unit = DURATION_UNITS[locale];

  if (seconds < 60) {
    return `${seconds}${unit.second}`;
  }

  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  if (minutes < 60) {
    if (remain === 0) return `${minutes}${unit.minute}`;
    return `${minutes}${unit.minute}${unit.join}${remain}${unit.second}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (remainMinutes === 0) return `${hours}${unit.hour}`;
  return `${hours}${unit.hour}${unit.join}${remainMinutes}${unit.minute}`;
}
