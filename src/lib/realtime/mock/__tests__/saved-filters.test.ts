import { describe, expect, it } from "vitest";

import { parseFilterPanelExpression } from "@/lib/dashboard/filter-panel-expression";
import { analyticsFilterRegistry } from "@/lib/filter-contract";
import { DEMO_SITE_PROFILES } from "@/lib/realtime/demo-site-profiles";
import { handleDemoSavedFilters } from "@/lib/realtime/mock/saved-filters";
import type { ErrorEnvelope } from "@/lib/response-envelope";
import type { SavedFilter } from "@/lib/saved-filters";

const LIST_PATH = "/api/private/saved-filters";

function list(siteId: string): SavedFilter[] {
  const result = handleDemoSavedFilters({
    path: LIST_PATH,
    method: "GET",
    siteId,
  });
  if (result && typeof result === "object" && "filters" in result) {
    return (result as { filters: SavedFilter[] }).filters;
  }
  throw new Error("expected saved-filter list");
}

function errorOf(value: unknown): ErrorEnvelope {
  if (value && typeof value === "object" && "ok" in value) {
    const envelope = value as ErrorEnvelope;
    if (envelope.ok === false) return envelope;
  }
  throw new Error("expected error envelope");
}

describe("mock/saved-filters", () => {
  it("seeds three meaningful, parseable filters for every demo site", () => {
    expect(DEMO_SITE_PROFILES).toHaveLength(12);
    for (const site of DEMO_SITE_PROFILES) {
      const filters = list(site.id);
      expect(filters).toHaveLength(3);
      expect(filters.filter((filter) => filter.isOwner)).toHaveLength(2);
      expect(filters.filter((filter) => !filter.isOwner)).toHaveLength(1);
      for (const filter of filters) {
        expect(filter.siteId).toBe(site.id);
        expect(filter.name).toMatch(/[A-Za-z]/);
        expect(filter.description).toMatch(/[A-Za-z]/);
        expect(filter.scopePreference).toBe("auto");
        expect(filter.filterDsl).toMatch(/\b(?:AND|OR|NOT)\b/);
        expect(
          parseFilterPanelExpression(filter.filterDsl, analyticsFilterRegistry)
            .root,
        ).not.toBeNull();
      }
    }
  });

  it("persists create, update, and delete operations in memory", () => {
    const siteId = "demo-site-001";
    const created = handleDemoSavedFilters({
      path: LIST_PATH,
      method: "POST",
      siteId,
      body: {
        name: "Custom review segment",
        description: "A temporary saved filter for demo CRUD review.",
        visibility: "private",
        scopePreference: "session",
        filterDsl:
          'page.path eq "/pricing" AND geo.country eq "US" AND client.deviceType eq "desktop"',
      },
    }) as { filter: SavedFilter };
    expect(created.filter.isOwner).toBe(true);
    expect(created.filter.scopePreference).toBe("session");
    expect(list(siteId).some((filter) => filter.id === created.filter.id)).toBe(
      true,
    );

    const updated = handleDemoSavedFilters({
      path: `${LIST_PATH}/${created.filter.id}`,
      method: "PUT",
      siteId,
      body: {
        name: "Updated review segment",
        description: "Updated through the in-memory mock route.",
        visibility: "team",
        scopePreference: "visitor",
        filterDsl:
          'page.path eq "/contact" AND referrer.domain eq "linkedin.com" AND geo.country in ["US", "GB"]',
      },
    }) as { filter: SavedFilter };
    expect(updated.filter.name).toBe("Updated review segment");
    expect(updated.filter.visibility).toBe("team");
    expect(updated.filter.scopePreference).toBe("visitor");
    expect(updated.filter.updatedAt).toBeGreaterThanOrEqual(
      created.filter.updatedAt,
    );

    const deleted = handleDemoSavedFilters({
      path: `${LIST_PATH}/${created.filter.id}`,
      method: "DELETE",
      siteId,
    }) as { deletedId: string };
    expect(deleted.deletedId).toBe(created.filter.id);
    expect(list(siteId).some((filter) => filter.id === created.filter.id)).toBe(
      false,
    );
  });

  it("keeps the team preset read-only and rejects invalid or duplicate filters", () => {
    const siteId = "demo-site-002";
    const teamFilter = list(siteId).find((filter) => !filter.isOwner)!;
    const forbidden = handleDemoSavedFilters({
      path: `${LIST_PATH}/${teamFilter.id}`,
      method: "DELETE",
      siteId,
    });
    expect(errorOf(forbidden).error.code).toBe("not_found");

    const invalid = handleDemoSavedFilters({
      path: LIST_PATH,
      method: "POST",
      siteId,
      body: {
        name: "Invalid",
        description: "",
        visibility: "private",
        filterDsl: "page.path eq",
      },
    });
    expect(errorOf(invalid).error.code).toBe("filterdsl_is_invalid");

    const invalidScope = handleDemoSavedFilters({
      path: LIST_PATH,
      method: "POST",
      siteId,
      body: {
        name: "Invalid scope",
        description: "",
        visibility: "private",
        scopePreference: "invalid",
        filterDsl: 'page.path eq "/pricing"',
      },
    });
    expect(errorOf(invalidScope).error.code).toBe("scopepreference_is_invalid");

    const ownFilter = list(siteId).find((filter) => filter.isOwner)!;
    const duplicate = handleDemoSavedFilters({
      path: LIST_PATH,
      method: "POST",
      siteId,
      body: {
        name: "Duplicate",
        description: "",
        visibility: "private",
        scopePreference: ownFilter.scopePreference,
        filterDsl: ownFilter.filterDsl,
      },
    });
    expect(errorOf(duplicate).error.code).toBe(
      "an_identical_saved_filter_already_exists",
    );
  });
});
