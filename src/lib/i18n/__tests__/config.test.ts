import { describe, expect, it } from "vitest";

import {
  DEFAULT_LOCALE,
  isValidLocale,
  LOCALE_COOKIE,
  localeToHtmlLang,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "@/lib/i18n/config";

describe("i18n locale config", () => {
  it("exports supported locale constants", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "zh", "ja"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(LOCALE_COOKIE).toBe("if_locale");
  });

  it("validates and resolves locale values", () => {
    expect(isValidLocale("en")).toBe(true);
    expect(isValidLocale("zh")).toBe(true);
    expect(isValidLocale("ja")).toBe(true);
    expect(isValidLocale("fr")).toBe(false);
    expect(isValidLocale(null)).toBe(false);

    expect(resolveLocale("zh")).toBe("zh");
    expect(resolveLocale("ja")).toBe("ja");
    expect(resolveLocale("fr")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });

  it("maps app locales to HTML language tags", () => {
    expect(localeToHtmlLang("en")).toBe("en");
    expect(localeToHtmlLang("zh")).toBe("zh-CN");
    expect(localeToHtmlLang("ja")).toBe("ja");
  });
});
