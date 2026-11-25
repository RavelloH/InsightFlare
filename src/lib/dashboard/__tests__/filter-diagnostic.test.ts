import { describe, expect, it } from "vitest";

import { describeFilterDiagnostic } from "@/lib/dashboard/filter-diagnostic";
import {
  analyticsFilterRegistry,
  FilterDslParseError,
  FilterValidationError,
  parseFilterDsl,
} from "@/lib/filter-contract";
import { getMessages } from "@/lib/i18n/messages";

function diagnostic(source: string, locale: "zh" | "zh-tw" | "en" | "ja") {
  try {
    parseFilterDsl(source, analyticsFilterRegistry);
    throw new Error("expected parse failure");
  } catch (error) {
    expect(error).toBeInstanceOf(FilterDslParseError);
    return describeFilterDiagnostic(error, getMessages(locale));
  }
}
describe("localized filter diagnostics", () => {
  it.each(["zh", "zh-tw", "en", "ja"] as const)(
    "uses localized error codes, not raw messages, in %s",
    (locale) => {
      const source = 'page.path eq "/docs" AND\npage.path typo "/x"';
      const result = diagnostic(source, locale);
      expect(result.message).toBe(
        getMessages(locale).filterBuilder.dslDiagnostics.unknown_operator,
      );
      expect(result.range).toEqual({
        offset: source.indexOf("typo"),
        length: 4,
      });
      expect(result.location).toContain("2");
      expect(result.message).not.toContain("offset");
    },
  );
  it("marks EOF with a zero-length source span", () => {
    const source = '(page.path eq "/docs"';
    expect(diagnostic(source, "zh").range).toEqual({
      offset: source.length,
      length: 0,
    });
  });
  it("marks a semantically invalid comparison value", () => {
    const source = "session.views gte -1";
    const result = diagnostic(source, "zh");
    expect(result.range).not.toBeNull();
    expect(result.message).not.toContain("Filter");
  });
  it("localizes permission and generic errors without leaking arbitrary error messages", () => {
    const copy = getMessages("zh");
    expect(
      describeFilterDiagnostic(
        new FilterValidationError("field_not_allowed", "root", "internal text"),
        copy,
      ).message,
    ).toBe(copy.filterBuilder.dslDiagnostics.field_not_allowed);
    expect(
      describeFilterDiagnostic(new Error("internal text"), copy).message,
    ).toBe(copy.filterBuilder.dslDiagnostics.unknown);
  });
});
