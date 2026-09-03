import { describe, expect, it } from "vitest";

import { resolveSuggestionScope } from "@/lib/dashboard/filter-suggestion-scope";

describe("resolveSuggestionScope", () => {
  it.each([
    ["auto", "event", "event"],
    ["auto", "session", "session"],
    ["auto", "visitor", "visitor"],
    ["event", "session", "event"],
    ["event", "visitor", "event"],
    ["session", "event", "session"],
    ["visitor", "event", "visitor"],
  ] as const)(
    "uses %s preference with page scope %s as %s",
    (scopePreference, pageResolvedScope, expected) => {
      expect(resolveSuggestionScope(scopePreference, pageResolvedScope)).toBe(
        expected,
      );
    },
  );

  it("leaves Auto unresolved when the page has no concrete scope", () => {
    expect(resolveSuggestionScope("auto")).toBeUndefined();
  });
});
