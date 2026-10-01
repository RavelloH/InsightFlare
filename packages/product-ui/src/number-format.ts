const LOCALE_ALIASES: Readonly<Record<string, string>> = {
  en: "en-US",
  ja: "ja-JP",
  zh: "zh-CN",
};

const numberFormatters = new Map<string, Intl.NumberFormat>();
const percentFormatters = new Map<string, Intl.NumberFormat>();
const signedPercentFormatters = new Map<string, Intl.NumberFormat>();

function getFormatter(
  locale: string,
  options: Intl.NumberFormatOptions,
  cache: Map<string, Intl.NumberFormat>,
  kind: string,
): Intl.NumberFormat {
  const resolvedLocale = LOCALE_ALIASES[locale] ?? locale;
  const key = `${resolvedLocale}:${kind}`;
  const existing = cache.get(key);
  if (existing) return existing;

  const formatter = new Intl.NumberFormat(resolvedLocale, options);
  cache.set(key, formatter);
  return formatter;
}

export function numberFormat(locale: string, value: number): string {
  return getFormatter(locale, {}, numberFormatters, "number").format(value);
}

export function percentFormat(locale: string, value: number): string {
  return getFormatter(
    locale,
    { style: "percent", maximumFractionDigits: 1 },
    percentFormatters,
    "percent",
  ).format(value);
}

export function signedPercentFormat(locale: string, value: number): string {
  return getFormatter(
    locale,
    {
      style: "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
      signDisplay: "always",
    },
    signedPercentFormatters,
    "signed-percent",
  ).format(value / 100);
}
