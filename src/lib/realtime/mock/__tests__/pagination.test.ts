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

  it("applies request sorting, searching, and comparison ordering before cursors", () => {
    const rows = [
      { label: "alpha", views: 10, visitors: 2 },
      { label: "beta", views: 30, visitors: 8 },
      { label: "gamma", views: 20, visitors: 5 },
    ];

    const first = demoPage(
      rows,
      { limit: 2, sort: "views", direction: "desc", search: "a" },
      { ...binding, request: "normal" },
      2,
    );
    expect(first.items.map((row) => row.label)).toEqual(["beta", "gamma"]);

    const second = demoPage(
      rows,
      {
        limit: 2,
        sort: "views",
        direction: "desc",
        search: "a",
        cursor: first.pagination.nextCursor ?? "",
      },
      { ...binding, request: "normal" },
      2,
    );
    expect(second.items.map((row) => row.label)).toEqual(["alpha"]);

    const comparisonRows = [
      {
        label: "new",
        views: 20,
        reference: { views: 0 },
        change: { views: { relative: null } },
      },
      {
        label: "growth",
        views: 20,
        reference: { views: 10 },
        change: { views: { relative: 1 } },
      },
      {
        label: "decline",
        views: 1,
        reference: { views: 5 },
        change: { views: { relative: -0.8 } },
      },
    ];
    const changePage = demoPage(
      comparisonRows,
      {
        limit: 3,
        compare: "same",
        metric: "views",
        sortBy: "change",
        direction: "desc",
      },
      { ...binding, request: "comparison" },
      3,
    );
    expect(changePage.items.map((row) => row.label)).toEqual([
      "new",
      "growth",
      "decline",
    ]);

    const customSearch = demoPage(
      rows,
      { limit: 5 },
      { ...binding, request: "custom-search" },
      5,
      5,
      true,
      { search: "GAM", getSearchValues: (row) => [row.label] },
    );
    expect(customSearch.items.map((row) => row.label)).toEqual(["gamma"]);
  });

  it("handles sparse comparison rows and primitive search values", () => {
    const result = demoPage(
      [
        null,
        { label: "missing-reference", views: 2, change: {} },
        { label: "missing-metric", views: 1, reference: {} },
      ],
      {
        limit: 5,
        compare: "same",
        sortBy: "change",
        direction: "asc",
      },
      { ...binding, request: "sparse-comparison" },
      5,
    );

    expect(result.items).toHaveLength(3);
  });
});
