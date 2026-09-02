import { describe, expect, it } from "vitest";

import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { dashboardFilterDocumentFromPresentation } from "@/lib/dashboard/filter-state";
import { attachFilterScopePreference } from "@/lib/filter-contract";

describe("filterQueryKey", () => {
  it("includes the canonical filter fingerprint and defaults scope to auto", () => {
    const filters = dashboardFilterDocumentFromPresentation({ path: "/docs" });
    const key = filterQueryKey(filters);

    expect(key).toContain("filter-v1:");
    expect(key).toContain(":scope=auto");
  });

  it("distinguishes scope metadata that JSON serialization omits", () => {
    const filters = dashboardFilterDocumentFromPresentation({ path: "/docs" });
    const visitor = attachFilterScopePreference(filters, "visitor");
    const session = attachFilterScopePreference(filters, "session");

    expect(filterQueryKey(visitor)).not.toBe(filterQueryKey(session));
    expect(filterQueryKey(visitor)).toContain(":scope=visitor");
    expect(filterQueryKey(session)).toContain(":scope=session");
  });

  it("is stable for equivalent filter documents", () => {
    const first = dashboardFilterDocumentFromPresentation({
      path: "/docs",
      browser: "Chrome",
    });
    const second = dashboardFilterDocumentFromPresentation({
      browser: "Chrome",
      path: "/docs",
    });

    expect(filterQueryKey(first)).toBe(filterQueryKey(second));
  });
});
