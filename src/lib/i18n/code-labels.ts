import type { Locale } from "./config";

const COUNTRY_CODE_ALIAS: Record<string, string> = {
  UK: "GB",
};

const COUNTRY_LABEL_OVERRIDES: Partial<Record<Locale, Record<string, string>>> =
  {
    zh: {
      TW: "中国台湾",
    },
  };

export const COUNTRY_PRIMARY_LANGUAGE_CODE: Record<string, string> = {
  CN: "zh",
  HK: "zh-tw",
  MO: "zh-tw",
  TW: "zh-tw",
  US: "en",
  GB: "en",
  AU: "en",
  CA: "en",
  JP: "ja",
  KR: "ko",
  FR: "fr",
  DE: "de",
  ES: "es",
  IT: "it",
  RU: "ru",
  BR: "pt",
  PT: "pt",
  ID: "id",
  TH: "th",
  VN: "vi",
  MY: "ms",
  SG: "en",
  IN: "hi",
};

const LANGUAGE_LABELS: Record<Locale, Record<string, string>> = {
  en: {
    en: "English",
    zh: "Chinese",
    "zh-tw": "Traditional Chinese",
    ja: "Japanese",
    ko: "Korean",
    fr: "French",
    de: "German",
    es: "Spanish",
    pt: "Portuguese",
    ru: "Russian",
    ar: "Arabic",
    it: "Italian",
    nl: "Dutch",
    tr: "Turkish",
    vi: "Vietnamese",
    th: "Thai",
    id: "Indonesian",
    ms: "Malay",
    hi: "Hindi",
  },
  zh: {
    en: "英语",
    zh: "中文",
    "zh-tw": "繁体中文",
    ja: "日语",
    ko: "韩语",
    fr: "法语",
    de: "德语",
    es: "西班牙语",
    pt: "葡萄牙语",
    ru: "俄语",
    ar: "阿拉伯语",
    it: "意大利语",
    nl: "荷兰语",
    tr: "土耳其语",
    vi: "越南语",
    th: "泰语",
    id: "印尼语",
    ms: "马来语",
    hi: "印地语",
  },
  "zh-tw": {
    en: "英語",
    zh: "簡體中文",
    "zh-tw": "繁體中文",
    ja: "日語",
    ko: "韓語",
    fr: "法語",
    de: "德語",
    es: "西班牙語",
    pt: "葡萄牙語",
    ru: "俄語",
    ar: "阿拉伯語",
    it: "義大利語",
    nl: "荷蘭語",
    tr: "土耳其語",
    vi: "越南語",
    th: "泰語",
    id: "印尼語",
    ms: "馬來語",
    hi: "印地語",
  },
  ja: {
    en: "英語",
    zh: "中国語",
    "zh-tw": "繁体字中国語",
    ja: "日本語",
    ko: "韓国語",
    fr: "フランス語",
    de: "ドイツ語",
    es: "スペイン語",
    pt: "ポルトガル語",
    ru: "ロシア語",
    ar: "アラビア語",
    it: "イタリア語",
    nl: "オランダ語",
    tr: "トルコ語",
    vi: "ベトナム語",
    th: "タイ語",
    id: "インドネシア語",
    ms: "マレー語",
    hi: "ヒンディー語",
  },
};

const countryNameFormatters = new Map<Locale, Intl.DisplayNames>();
const languageNameFormatters = new Map<Locale, Intl.DisplayNames>();

function intlTagForLocale(locale: Locale): string {
  if (locale === "zh") return "zh-CN";
  if (locale === "zh-tw") return "zh-TW";
  return locale;
}

function getCountryFormatter(locale: Locale): Intl.DisplayNames | null {
  const cached = countryNameFormatters.get(locale);
  if (cached) return cached;
  try {
    const formatter = new Intl.DisplayNames([intlTagForLocale(locale)], {
      type: "region",
    });
    countryNameFormatters.set(locale, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function getLanguageFormatter(locale: Locale): Intl.DisplayNames | null {
  const cached = languageNameFormatters.get(locale);
  if (cached) return cached;
  try {
    const formatter = new Intl.DisplayNames([intlTagForLocale(locale)], {
      type: "language",
    });
    languageNameFormatters.set(locale, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function normalizeCountryCode(raw: string): string | null {
  const normalized = raw.trim().toUpperCase();
  if (!normalized) return null;
  if (normalized === "ZZ") return null;
  const canonical = COUNTRY_CODE_ALIAS[normalized] ?? normalized;
  return /^[A-Z]{2}$/.test(canonical) ? canonical : null;
}

function normalizeLanguageCode(raw: string): string | null {
  const normalized = raw.trim().replace(/_/g, "-");
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (
    lower === "zh-tw" ||
    lower === "zh-hk" ||
    lower === "zh-mo" ||
    lower.startsWith("zh-hant")
  ) {
    return "zh-tw";
  }
  const primary = lower.split("-")[0] ?? "";
  if (!primary) return null;
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

export function resolveCountryLabel(
  raw: string,
  locale: Locale,
  unknownLabel: string,
): { label: string; code: string | null } {
  const value = raw.trim();
  const code = normalizeCountryCode(value);
  if (!code) {
    return {
      label: value || unknownLabel,
      code: null,
    };
  }

  const fromOverride = COUNTRY_LABEL_OVERRIDES[locale]?.[code];
  if (fromOverride) {
    return { label: fromOverride, code };
  }

  const formatter = getCountryFormatter(locale);
  const fromIntl = formatter?.of(code);
  if (fromIntl) {
    return { label: fromIntl, code };
  }

  return { label: code, code };
}

export function resolveLanguageLabel(
  raw: string,
  locale: Locale,
  unknownLabel: string,
): { label: string; code: string | null } {
  const value = raw.trim();
  const code = normalizeLanguageCode(value);
  if (!code) {
    return {
      label: value || unknownLabel,
      code: null,
    };
  }

  const fromTable = LANGUAGE_LABELS[locale][code];
  if (fromTable) {
    return { label: fromTable, code };
  }

  const formatter = getLanguageFormatter(locale);
  const fromIntl = formatter?.of(code);
  if (fromIntl) {
    return { label: fromIntl, code };
  }

  return { label: code, code };
}

export function resolveContinentLabel(
  raw: string,
  unknownLabel: string,
  labels: Record<string, string>,
): string {
  const value = raw.trim();
  if (!value) return unknownLabel;

  const normalized = value.toUpperCase().replace(/_/g, " ");
  const compacted = normalized.replace(/\s+/g, " ").trim();

  return labels[normalized] ?? labels[compacted] ?? value;
}

export function resolveCountryFlagCode(
  countryCode: string | null,
  locale: Locale,
): string | null {
  if (!countryCode) return null;
  if (locale === "zh" && countryCode === "TW") return "CN";
  if (countryCode === "GB") return "GB-UKM";
  return countryCode;
}
