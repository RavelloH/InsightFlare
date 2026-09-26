import { describe, expect, it } from "vitest";

import {
  dateTimeInputValueToLiteral,
  dateTimeLiteralToInputValue,
} from "@/components/dashboard/filters/filter-editor/datetime-input";

describe("filter date-time inputs", () => {
  it("renders valid timestamp literals in the reporting timezone", () => {
    expect(dateTimeLiteralToInputValue("2026-01-01T12:30:00.000Z", "UTC")).toBe(
      "2026-01-01T12:30",
    );
    expect(
      dateTimeLiteralToInputValue("2026-01-01T12:30:00+02:00", "UTC"),
    ).toBe("2026-01-01T10:30");
  });

  it("preserves local inputs and noncanonical or invalid values", () => {
    expect(dateTimeLiteralToInputValue(undefined, "UTC")).toBe("");
    expect(dateTimeLiteralToInputValue("2026-01-01T12:30", "UTC")).toBe(
      "2026-01-01T12:30",
    );
    expect(dateTimeLiteralToInputValue("not-a-date", "UTC")).toBe("not-a-date");
    expect(dateTimeLiteralToInputValue("2026-13-01T12:30:00Z", "UTC")).toBe(
      "2026-13-01T12:30:00Z",
    );
  });

  it("converts a local input to a UTC literal and preserves incomplete input", () => {
    expect(
      dateTimeInputValueToLiteral("2026-01-01T12:30", "America/Los_Angeles"),
    ).toBe("2026-01-01T20:30:00.000Z");
    expect(dateTimeInputValueToLiteral("", "UTC")).toBe("");
    expect(dateTimeInputValueToLiteral("2026-01-01", "UTC")).toBe("2026-01-01");
  });
});
