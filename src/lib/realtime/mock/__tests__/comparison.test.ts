import { describe, expect, it } from "vitest";

import {
  buildDemoComparisonRows,
  type DemoComparisonRow,
  resolveDemoComparison,
} from "@/lib/realtime/mock/comparison";
import { parseDemoFilters } from "@/lib/realtime/mock/filters";

describe("mock/comparison", () => {
  describe("resolveDemoComparison", () => {
    it("returns null for same-period comparison without compareFilter", () => {
      const result = resolveDemoComparison(
        { compare: "same", from: 1_000, to: 2_000 },
        parseDemoFilters({ "filter[page.path]": "/docs" }),
      );

      expect(result).toBeNull();
    });

    it("converts compareFilter params for same-period comparison", () => {
      const result = resolveDemoComparison(
        {
          compare: "same",
          from: 1_000,
          to: 2_000,
          "compareFilter[page.path]": "/pricing",
          "compareFilter[client.browser]": "Chrome",
        },
        parseDemoFilters({ "filter[page.path]": "/docs" }),
      );

      expect(result).toMatchObject({
        mode: "same",
        from: 1_000,
        to: 2_000,
        filters: {
          path: "/pricing",
          browser: "Chrome",
        },
      });
      expect(result?.filters.path).not.toBe("/docs");
    });

    it("shifts the previous comparison to the preceding time window", () => {
      const currentFilters = parseDemoFilters({
        "filter[geo.country]": "US",
      });

      const result = resolveDemoComparison(
        { compare: "previous", from: 3_000, to: 5_000 },
        currentFilters,
      );

      expect(result).toEqual({
        mode: "previous",
        from: 999,
        to: 2_999,
        filters: currentFilters,
      });
    });

    it("rejects unsupported or empty comparison windows", () => {
      const filters = parseDemoFilters({});

      expect(resolveDemoComparison({ compare: "invalid" }, filters)).toBeNull();
      expect(
        resolveDemoComparison(
          { compare: "same", from: 5_000, to: 5_000 },
          filters,
        ),
      ).toBeNull();
      expect(
        resolveDemoComparison(
          {
            compare: "same",
            from: 5_000,
            to: 4_000,
            "compareFilter[page.path]": "/pricing",
          },
          filters,
        ),
      ).toBeNull();
      expect(
        resolveDemoComparison(
          { compare: "previous", from: 0, to: 10 },
          filters,
        ),
      ).toBeNull();
    });

    it("preserves operation while resolving a filtered previous period", () => {
      const result = resolveDemoComparison(
        {
          compare: "previous",
          from: 3_000,
          to: 5_000,
          operation: "pages",
          "compareFilter[page.path]": "/pricing",
        },
        parseDemoFilters({ "filter[page.path]": "/docs" }),
      );

      expect(result).toMatchObject({
        mode: "previous",
        filters: { path: "/pricing" },
      });
    });
  });

  describe("buildDemoComparisonRows", () => {
    it("merges current and reference rows and computes absolute and relative changes", () => {
      const rows = buildDemoComparisonRows(
        [
          makeRow("shared", { views: 10, sessions: 5, visitors: 4 }),
          makeRow("current-only", { views: 8, sessions: 4, visitors: 3 }),
        ],
        [
          makeRow("shared", { views: 5, sessions: 2, visitors: 2 }),
          makeRow("reference-only", { views: 7, sessions: 3, visitors: 1 }),
        ],
        { sortBy: "current", direction: "desc" },
      );

      expect(rows.map(({ label }) => label)).toEqual([
        "shared",
        "current-only",
        "reference-only",
      ]);
      expect(rows.find(({ label }) => label === "shared")).toMatchObject({
        label: "shared",
        views: 10,
        sessions: 5,
        visitors: 4,
        reference: { views: 5, sessions: 2, visitors: 2 },
        change: {
          views: { absolute: 5, relative: 1 },
          sessions: { absolute: 3, relative: 1.5 },
          visitors: { absolute: 2, relative: 1 },
        },
      });
      expect(rows.find(({ label }) => label === "current-only")).toMatchObject({
        views: 8,
        sessions: 4,
        visitors: 3,
        reference: { views: 0, sessions: 0, visitors: 0 },
        change: {
          views: { absolute: 8, relative: null },
          sessions: { absolute: 4, relative: null },
          visitors: { absolute: 3, relative: null },
        },
      });
      expect(
        rows.find(({ label }) => label === "reference-only"),
      ).toMatchObject({
        views: 0,
        sessions: 0,
        visitors: 0,
        reference: { views: 7, sessions: 3, visitors: 1 },
        change: {
          views: { absolute: -7, relative: -1 },
          sessions: { absolute: -3, relative: -1 },
          visitors: { absolute: -1, relative: -1 },
        },
      });
    });

    it("orders New rows last for ascending change and first for descending change", () => {
      const currentRows = [
        makeRow("stable-high", { views: 20, sessions: 10, visitors: 8 }),
        makeRow("stable-low", { views: 3, sessions: 2, visitors: 2 }),
        makeRow("new-high", { views: 8, sessions: 4, visitors: 3 }),
        makeRow("new-low", { views: 4, sessions: 2, visitors: 1 }),
        makeRow("removed", { views: 0, sessions: 0, visitors: 0 }),
      ];
      const referenceRows = [
        makeRow("stable-high", { views: 10, sessions: 5, visitors: 4 }),
        makeRow("stable-low", { views: 2, sessions: 1, visitors: 1 }),
        makeRow("new-high", { views: 0, sessions: 0, visitors: 0 }),
        makeRow("new-low", { views: 0, sessions: 0, visitors: 0 }),
        makeRow("removed", { views: 5, sessions: 2, visitors: 2 }),
      ];

      const ascending = buildDemoComparisonRows(currentRows, referenceRows, {
        sortBy: "change",
        direction: "asc",
      });
      const descending = buildDemoComparisonRows(currentRows, referenceRows, {
        sortBy: "change",
        direction: "desc",
      });

      expect(ascending.map(({ label }) => label)).toEqual([
        "removed",
        "stable-low",
        "stable-high",
        "new-high",
        "new-low",
      ]);
      expect(descending.map(({ label }) => label)).toEqual([
        "new-low",
        "new-high",
        "stable-high",
        "stable-low",
        "removed",
      ]);
    });

    it("supports visitor and reference sorting", () => {
      const currentRows = [
        makeRow("alpha", { views: 1, sessions: 1, visitors: 9 }),
        makeRow("beta", { views: 9, sessions: 1, visitors: 2 }),
        makeRow("zero", { views: 0, sessions: 0, visitors: 0 }),
      ];
      const referenceRows = [
        makeRow("alpha", { views: 1, sessions: 1, visitors: 3 }),
        makeRow("beta", { views: 9, sessions: 1, visitors: 8 }),
        makeRow("zero", { views: 0, sessions: 0, visitors: 0 }),
      ];

      expect(
        buildDemoComparisonRows(currentRows, referenceRows, {
          metric: "visitors",
          sortBy: "reference",
          direction: "asc",
        }).map(({ label }) => label),
      ).toEqual(["zero", "alpha", "beta"]);
      expect(
        buildDemoComparisonRows(currentRows, referenceRows, {
          metric: "visitors",
          sortBy: "change",
          direction: "desc",
        }).map(({ label }) => label),
      ).toEqual(["alpha", "zero", "beta"]);
      expect(
        buildDemoComparisonRows(currentRows, referenceRows, {
          metric: "sessions",
          sortBy: "current",
          direction: "desc",
        }).map(({ label }) => label),
      ).toEqual(["alpha", "beta", "zero"]);
    });

    it("handles zero deltas and stable label tie breaks", () => {
      const rows = buildDemoComparisonRows(
        [
          makeRow("zulu", { views: 4, sessions: 2, visitors: 1 }),
          makeRow("alpha", { views: 4, sessions: 2, visitors: 1 }),
          makeRow("zero", { views: 0, sessions: 0, visitors: 0 }),
        ],
        [
          makeRow("zulu", { views: 4, sessions: 2, visitors: 1 }),
          makeRow("alpha", { views: 4, sessions: 2, visitors: 1 }),
          makeRow("zero", { views: 0, sessions: 0, visitors: 0 }),
        ],
        { sortBy: "current", direction: "desc" },
      );

      expect(rows.map(({ label }) => label)).toEqual(["alpha", "zulu", "zero"]);
      expect(rows.find(({ label }) => label === "zero")).toMatchObject({
        change: {
          views: { absolute: 0, relative: 0 },
          sessions: { absolute: 0, relative: 0 },
          visitors: { absolute: 0, relative: 0 },
        },
      });

      const emptyLabelRows = buildDemoComparisonRows(
        [makeRow("", { views: 1, sessions: 1, visitors: 1 })],
        [makeRow("", { views: 1, sessions: 1, visitors: 1 })],
        { sortBy: "current", direction: "desc" },
      );
      expect(emptyLabelRows[0]?.label).toBe("");
    });
  });
});

function makeRow(
  label: string,
  metrics: Pick<DemoComparisonRow, "views" | "sessions" | "visitors">,
): DemoComparisonRow {
  return { label, ...metrics };
}
