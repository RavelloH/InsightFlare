import { describe, expect, it } from "vitest";

import { type Locale, SUPPORTED_LOCALES } from "@/lib/i18n/config";
import { nativeLocaleName } from "@/lib/i18n/native-locale-names";

describe("language selector autonyms", () => {
  it("uses the target language's own spelling, independent of current UI locale", () => {
    const names: Record<Locale, string> = {
      en: "English",
      zh: "简体中文",
      "zh-tw": "繁體中文",
      ja: "日本語",
    };
    expect(
      Object.fromEntries(
        SUPPORTED_LOCALES.map((locale) => [locale, nativeLocaleName(locale)]),
      ),
    ).toEqual(names);
  });
});
