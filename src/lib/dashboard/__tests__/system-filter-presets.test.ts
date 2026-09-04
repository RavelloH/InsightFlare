import { describe, expect, it } from "vitest";

import {
  SYSTEM_FILTER_PRESETS,
  systemFilterPresetFromOptionValue,
  systemFilterPresetOptionValue,
} from "@/lib/dashboard/system-filter-presets";
import { queryPolicyForAudience } from "@/lib/edge/analytics/contract/policy";
import {
  analyticsFilterRegistry,
  assertFilterAudience,
  filterConditionCount,
  parseFilterDsl,
} from "@/lib/filter-contract";

describe("system filter presets", () => {
  it("contains unique, public-share-compatible expressions", () => {
    const ids = new Set<string>();

    for (const preset of SYSTEM_FILTER_PRESETS) {
      expect(ids.has(preset.id)).toBe(false);
      ids.add(preset.id);

      const document = parseFilterDsl(
        preset.filterDsl,
        analyticsFilterRegistry,
      );
      expect(() =>
        assertFilterAudience(document, analyticsFilterRegistry, "public-share"),
      ).not.toThrow();
      expect(filterConditionCount(document)).toBeLessThanOrEqual(
        queryPolicyForAudience("public-share").limits.maxFilterClauses!,
      );
    }
  });

  it("uses the direct sentinel only with equality operators", () => {
    for (const preset of SYSTEM_FILTER_PRESETS) {
      expect(preset.filterDsl).not.toContain('in ["__direct__"');
      expect(preset.filterDsl).not.toContain('notIn ["__direct__"');
    }
  });

  it("matches registered discovery domains and their subdomains safely", () => {
    const searchDiscovery = SYSTEM_FILTER_PRESETS.find(
      (preset) => preset.id === "organicSearchDiscovery",
    )!;
    const socialDiscovery = SYSTEM_FILTER_PRESETS.find(
      (preset) => preset.id === "organicSocialDiscovery",
    )!;
    const mobileDiscovery = SYSTEM_FILTER_PRESETS.find(
      (preset) => preset.id === "mobileOrganicDiscovery",
    )!;

    expect(searchDiscovery.filterDsl).toContain(
      'referrer.domain eq "google.com"',
    );
    expect(searchDiscovery.filterDsl).toContain(
      'referrer.domain endsWith ".google.com"',
    );
    expect(searchDiscovery.filterDsl).toContain(
      'referrer.domain endsWith ".google.com.hk"',
    );
    expect(searchDiscovery.filterDsl).toContain(
      'referrer.domain endsWith ".google.co.uk"',
    );
    expect(socialDiscovery.filterDsl).toContain(
      'referrer.domain eq "linkedin.com"',
    );
    expect(socialDiscovery.filterDsl).toContain(
      'referrer.domain endsWith ".linkedin.com"',
    );
    expect(mobileDiscovery.filterDsl).toContain(
      'referrer.domain endsWith ".google.com"',
    );
    expect(mobileDiscovery.filterDsl).toContain(
      'referrer.domain endsWith ".linkedin.com"',
    );
    expect(mobileDiscovery.filterDsl).not.toMatch(/referrer\.domain in \[/);
  });

  it("round-trips selector option values", () => {
    for (const preset of SYSTEM_FILTER_PRESETS) {
      expect(
        systemFilterPresetFromOptionValue(
          systemFilterPresetOptionValue(preset.id),
        ),
      ).toEqual(preset);
    }
    expect(systemFilterPresetFromOptionValue("saved:example")).toBeUndefined();
  });
});
