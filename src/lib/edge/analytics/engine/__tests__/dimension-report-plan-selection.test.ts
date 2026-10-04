import { describe, expect, it } from "vitest";

import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import {
  buildDimensionPagePlan,
  buildDimensionTopPlan,
  PAGE_DIMENSION_SELECTIONS,
  validatePageDimensionSelection,
} from "@/lib/edge/analytics/engine/dimension-report-plan";

const QUERY_TIME = createQueryTime(0, 100, "UTC", 100);

describe("page dimension selection boundaries", () => {
  it("rejects nonobjects, unknown ids, extra fields, and tampered values", () => {
    for (const value of [null, [], "pagePath"]) {
      expect(() => validatePageDimensionSelection(value)).toThrow(
        "unsupported-page-dimension-selection",
      );
    }
    for (const value of [
      { id: "not-registered", kind: "stored" },
      { ...PAGE_DIMENSION_SELECTIONS.pagePath, extra: true },
      { ...PAGE_DIMENSION_SELECTIONS.pagePath, attribute: "page.report.title" },
    ]) {
      expect(() => validatePageDimensionSelection(value)).toThrow(
        "unsupported-page-dimension-selection",
      );
    }
  });

  it("rejects unsupported derived dimensions before a report plan is built", () => {
    const invalidSelection = {
      id: "futureDimension",
      kind: "derived",
      dimension: "futureDimension",
    } as never;
    const shared = {
      siteId: "dimension-selection-site",
      queryTime: QUERY_TIME,
      filters: EMPTY_FILTER_DOCUMENT,
      limit: 10,
      selection: invalidSelection,
      sortBy: "views" as const,
      sortDirection: "desc" as const,
    };

    expect(() => buildDimensionTopPlan(shared)).toThrow(
      "unsupported-page-dimension:futureDimension",
    );
    expect(() => buildDimensionPagePlan({ ...shared, cursor: null })).toThrow(
      "unsupported-page-dimension:futureDimension",
    );
  });
});
