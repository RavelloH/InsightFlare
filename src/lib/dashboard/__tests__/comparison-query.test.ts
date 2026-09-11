import { describe, expect, it } from "vitest";

import { resolveDashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { parseFilterDocumentFromSearchParams } from "@/lib/dashboard/query-state";
import { attachFilterScopePreference } from "@/lib/filter-contract";

const currentWindow = {
  preset: "7d" as const,
  from: 1_000_000,
  to: 1_604_800,
  interval: "day" as const,
  timeZone: "UTC",
};

const currentFilters = parseFilterDocumentFromSearchParams(
  new URLSearchParams({ "filter[page.path]": "/docs" }),
);

describe("resolveDashboardComparisonQuery", () => {
  it("returns null when comparison is not active", () => {
    expect(
      resolveDashboardComparisonQuery(
        new URLSearchParams(),
        currentWindow,
        currentFilters,
      ),
    ).toBeNull();
  });

  it("returns null for same-period comparison without a comparison filter", () => {
    expect(
      resolveDashboardComparisonQuery(
        new URLSearchParams("compare=same"),
        currentWindow,
        currentFilters,
      ),
    ).toBeNull();
  });

  it("uses the current window and comparison filter for same-period comparison", () => {
    const result = resolveDashboardComparisonQuery(
      new URLSearchParams(
        "compare=same&compareFilter%5Bpage.path%5D=%2Fpricing",
      ),
      currentWindow,
      attachFilterScopePreference(currentFilters, "session"),
    );

    expect(result).toMatchObject({
      mode: "same",
      window: currentWindow,
      filters: {
        root: {
          kind: "condition",
          value: "/pricing",
        },
      },
    });
  });

  it("defaults a custom comparison filter to auto scope", () => {
    const result = resolveDashboardComparisonQuery(
      new URLSearchParams(
        "compare=previous&compareFilter%5Bpage.path%5D=%2Fpricing",
      ),
      currentWindow,
      parseFilterDocumentFromSearchParams(new URLSearchParams()),
    );

    expect(result?.filters.root).toMatchObject({
      kind: "condition",
      value: "/pricing",
    });
  });

  it("shifts previous-period comparison and follows current filters by default", () => {
    const result = resolveDashboardComparisonQuery(
      new URLSearchParams("compare=previous"),
      currentWindow,
      attachFilterScopePreference(currentFilters, "visitor"),
    );

    expect(result).toMatchObject({
      mode: "previous",
      window: {
        from: 395_199,
        to: 1_000_000 - 1,
      },
      filters: currentFilters,
    });
  });

  it("returns null when no previous window is available", () => {
    expect(
      resolveDashboardComparisonQuery(
        new URLSearchParams("compare=previous"),
        { ...currentWindow, from: 0, to: 100 },
        currentFilters,
      ),
    ).toBeNull();
  });
});
