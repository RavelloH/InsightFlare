import { describe, expect, it } from "vitest";

import { visitorDisplayName } from "@/components/dashboard/journey-display";

describe("visitorDisplayName", () => {
  it.each([
    ["Alice", "user-123", "Alice"],
    ["  Alice  ", "user-123", "Alice"],
    ["", "user-123", "user-123"],
    ["   ", "user-123", "user-123"],
    ["", "", "Anonymous"],
    [undefined, "", "Anonymous"],
  ] as const)(
    "uses the latest non-empty identity field (%s, %s)",
    (userName, userId, expected) => {
      expect(visitorDisplayName(userName, userId, "Anonymous")).toBe(expected);
    },
  );
});
