const LOCALE_ALIASES: Readonly<Record<string, string>> = {
  en: "en-US",
  ja: "ja-JP",
  zh: "zh-CN",
};

const numberFormatters = new Map<string, Intl.NumberFormat>();
const percentFormatters = new Map<string, Intl.NumberFormat>();
const percentOneDecimalFormatters = new Map<string, Intl.NumberFormat>();

export function intlLocale(locale: string): string {
  return LOCALE_ALIASES[locale] ?? locale;
}

function formatter(
  locale: string,
  options: Intl.NumberFormatOptions,
  cache: Map<string, Intl.NumberFormat>,
  cacheKey: string,
): Intl.NumberFormat {
  const key = `${intlLocale(locale)}:${cacheKey}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const created = new Intl.NumberFormat(intlLocale(locale), options);
  cache.set(key, created);
  return created;
}

export function numberFormat(locale: string, value: number): string {
  return formatter(locale, {}, numberFormatters, "number").format(value);
}

export function percentFormat(locale: string, value: number): string {
  return formatter(
    locale,
    { style: "percent", maximumFractionDigits: 1 },
    percentFormatters,
    "percent",
  ).format(value);
}

export function percentFormatWithOneDecimal(
  locale: string,
  value: number,
): string {
  return formatter(
    locale,
    {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    },
    percentOneDecimalFormatters,
    "percent-one-decimal",
  ).format(value);
}

export function durationFormat(locale: string, ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const units =
    locale.startsWith("zh") || locale.startsWith("ja")
      ? {
          second: "秒",
          minute: "分",
          hour: locale.startsWith("ja") ? "時間" : "小时",
          join: "",
        }
      : { second: "s", minute: "m", hour: "h", join: " " };

  if (seconds < 60) return `${seconds}${units.second}`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    if (remainingSeconds === 0) return `${minutes}${units.minute}`;
    return `${minutes}${units.minute}${units.join}${remainingSeconds}${units.second}`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `${hours}${units.hour}`;
  return `${hours}${units.hour}${units.join}${remainingMinutes}${units.minute}`;
}

export function formatI18nTemplate(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{([\w.-]+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}
