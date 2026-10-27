import type { Locale } from "@/lib/i18n/config";

// Language selectors deliberately use autonyms, independent of the UI locale.
// These four labels are identifiers, not translated interface copy.
const NATIVE_LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: "English",
  zh: "简体中文",
  "zh-tw": "繁體中文",
  ja: "日本語",
};

export function nativeLocaleName(locale: Locale): string {
  return NATIVE_LOCALE_NAMES[locale];
}
