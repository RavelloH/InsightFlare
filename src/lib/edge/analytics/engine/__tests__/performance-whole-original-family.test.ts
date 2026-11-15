// @vitest-environment node
import { expect, it, vi } from "vitest";

import {
  pageWholeOriginalFamilyAccepts,
  pageWholeOriginalFamilyFromQuery,
} from "@/lib/edge/analytics/engine/page-whole-original-family";
it.each(["summary", "timeseries", "breakdown", "dashboard"])(
  "recognizes only the explicit own-data Performance %s layout",
  (mode) => {
    expect(pageWholeOriginalFamilyFromQuery("performance", { mode })).toBe(
      "performance",
    );
  },
);
it("does not read layout accessors or coerce unknown mode values", () => {
  const getter = vi.fn(() => "summary"),
    value = { toString: vi.fn(() => "summary") };
  expect(
    pageWholeOriginalFamilyFromQuery(
      "performance",
      Object.defineProperty({}, "mode", { get: getter }),
    ),
  ).toBeUndefined();
  expect(getter).not.toHaveBeenCalled();
  expect(
    pageWholeOriginalFamilyFromQuery("performance", { mode: value }),
  ).toBeUndefined();
  expect(value.toString).not.toHaveBeenCalled();
  expect(pageWholeOriginalFamilyFromQuery("performance", {})).toBeUndefined();
  expect(
    pageWholeOriginalFamilyFromQuery("performance", { mode: "unknown" }),
  ).toBeUndefined();
  expect(
    pageWholeOriginalFamilyFromQuery("other", { mode: "summary" }),
  ).toBeUndefined();
});
it("retains exact finite Page family pairing without adding a plan/source budget", () => {
  expect(
    pageWholeOriginalFamilyAccepts("performance", {
      kind: "performance-summary",
      configuration: {},
    }),
  ).toBe(true);
  expect(
    pageWholeOriginalFamilyAccepts("pages", {
      kind: "performance-summary",
      configuration: {},
    }),
  ).toBe(false);
  expect(
    pageWholeOriginalFamilyAccepts("performance", {
      kind: "referrers-summary",
      configuration: { topN: 2 },
    }),
  ).toBe(false);
});
