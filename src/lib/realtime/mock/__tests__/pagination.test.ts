import { describe, expect, it } from "vitest";

import {
  decodeDemoCursor,
  DemoInvalidCursorError,
  demoPage,
  encodeDemoCursor,
} from "@/lib/realtime/mock/pagination";

const binding = { operation: "pages", siteId: "demo-site-001" };
const validateIndex = (value: unknown): value is { index: number } =>
  Boolean(
    value &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    Number.isSafeInteger((value as { index?: unknown }).index) &&
    (value as { index: number }).index >= 0,
  );

describe("demo pagination cursor helpers", () => {
  it("paginates with signed cursors and validates exact keys", () => {
    const first = demoPage(["a", "b", "c"], { limit: 2 }, binding, 2);
    expect(first.items).toEqual(["a", "b"]);
    expect(first.pagination).toMatchObject({
      returned: 2,
      hasMore: true,
      nextCursor: expect.any(String),
    });

    const second = demoPage(
      ["a", "b", "c"],
      { limit: 2, cursor: first.pagination.nextCursor ?? "" },
      binding,
      2,
    );
    expect(second).toEqual({
      items: ["c"],
      pagination: { limit: 2, returned: 1, hasMore: false, nextCursor: null },
    });
  });

  it("fails closed for malformed, mismatched, stale, and oversized cursors", () => {
    expect(decodeDemoCursor(null, binding, validateIndex)).toBeNull();

    const cursor = encodeDemoCursor(binding, { index: 1 });
    expect(() =>
      decodeDemoCursor(cursor, { ...binding, siteId: "other" }, validateIndex),
    ).toThrow(DemoInvalidCursorError);
    expect(() =>
      decodeDemoCursor(`${cursor}x`, binding, validateIndex),
    ).toThrow(DemoInvalidCursorError);
    expect(() =>
      decodeDemoCursor("not-a-cursor", binding, validateIndex),
    ).toThrow(DemoInvalidCursorError);
    expect(() =>
      decodeDemoCursor("%%%.invalid", binding, validateIndex),
    ).toThrow(DemoInvalidCursorError);
    expect(() =>
      decodeDemoCursor("x".repeat(12_289), binding, validateIndex),
    ).toThrow(DemoInvalidCursorError);

    const invalidKey = encodeDemoCursor(binding, { index: 1, stale: true });
    expect(() => decodeDemoCursor(invalidKey, binding, validateIndex)).toThrow(
      DemoInvalidCursorError,
    );

    const oversized = encodeDemoCursor(binding, {
      index: 1,
      payload: "x".repeat(8_200),
    });
    expect(() =>
      decodeDemoCursor(
        oversized,
        binding,
        (_value): _value is { index: number } => true,
      ),
    ).toThrow(DemoInvalidCursorError);
  });
});
