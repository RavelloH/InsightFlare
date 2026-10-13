import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n/config";

const NUMBER_LOCALES = {
  en: "en-US",
  zh: "zh-CN",
  "zh-tw": "zh-TW",
  ja: "ja-JP",
} satisfies Record<Locale, string>;

function normalizedLocale(locale: Locale | undefined): Locale {
  return locale ?? DEFAULT_LOCALE;
}

function normalizedTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return "UTC";
  }
}

export function formatNotificationNumber(
  value: unknown,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Math.trunc(number).toLocaleString(NUMBER_LOCALES[locale]);
}

export function formatNotificationDateTime(
  seconds: unknown,
  locale: Locale = DEFAULT_LOCALE,
  timeZone?: string | null,
): string {
  const timestamp = Number(seconds);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const date = new Date(Math.trunc(timestamp) * 1000);
  const formatter = new Intl.DateTimeFormat(
    NUMBER_LOCALES[normalizedLocale(locale)],
    {
      timeZone: normalizedTimeZone(timeZone),
      year: "numeric",
      month:
        locale === "zh" || locale === "zh-tw" || locale === "ja"
          ? "numeric"
          : "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    },
  );
  return formatter
    .format(date)
    .replace(
      ",",
      locale === "zh" || locale === "zh-tw" || locale === "ja" ? "" : ",",
    );
}
