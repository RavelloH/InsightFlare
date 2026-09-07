import { describe, expect, it } from "vitest";

import {
  LEGACY_SYSTEM_FILTER_PRESET_IDS,
  SYSTEM_FILTER_PRESET_IDS,
  SYSTEM_FILTER_PRESETS,
  systemFilterPresetAvailableForAudience,
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
      if (systemFilterPresetAvailableForAudience(preset, "public-share")) {
        expect(() =>
          assertFilterAudience(
            document,
            analyticsFilterRegistry,
            "public-share",
          ),
        ).not.toThrow();
      }
      expect(filterConditionCount(document)).toBeLessThanOrEqual(
        queryPolicyForAudience("public-share").limits.maxFilterClauses!,
      );
    }

    expect(SYSTEM_FILTER_PRESETS).toHaveLength(34);
    expect(SYSTEM_FILTER_PRESET_IDS).toHaveLength(34);
  });

  it("covers the planned categories and fixed scopes", () => {
    const categoryCounts = SYSTEM_FILTER_PRESETS.reduce<Record<string, number>>(
      (counts, item) => {
        counts[item.category] = (counts[item.category] ?? 0) + 1;
        return counts;
      },
      {},
    );
    expect(categoryCounts).toEqual({
      acquisition: 7,
      device: 3,
      visitBehavior: 4,
      sessionEngagement: 7,
      visitorBehavior: 6,
      performance: 6,
      dataQuality: 1,
    });
    expect(
      SYSTEM_FILTER_PRESETS.filter((item) => item.scope === "session"),
    ).toHaveLength(7);
    expect(
      SYSTEM_FILTER_PRESETS.filter((item) => item.scope === "visitor"),
    ).toHaveLength(6);
    expect(
      SYSTEM_FILTER_PRESETS.filter((item) => item.scope === "preserve"),
    ).toHaveLength(11);
    expect(
      SYSTEM_FILTER_PRESETS.filter((item) => item.scope === "event"),
    ).toHaveLength(10);
  });

  it("keeps private user/event presets out of public audiences", () => {
    const privatePresetIds = [
      "identifiedActivity",
      "customEventActivity",
      "identifiedVisitors",
    ];
    for (const preset of SYSTEM_FILTER_PRESETS) {
      expect(
        systemFilterPresetAvailableForAudience(preset, "public-share"),
      ).toBe(!privatePresetIds.includes(preset.id));
    }
  });

  it("uses the direct sentinel only with equality operators", () => {
    for (const preset of SYSTEM_FILTER_PRESETS) {
      expect(preset.filterDsl).not.toContain('in ["__direct__"');
      expect(preset.filterDsl).not.toContain('notIn ["__direct__"');
    }
  });

  it("does not expose the removed scope example presets", () => {
    for (const id of [
      "organicSearchSessions",
      "campaignSessions",
      "mobileSessions",
    ]) {
      expect(SYSTEM_FILTER_PRESET_IDS).not.toContain(id);
      expect(systemFilterPresetFromOptionValue(`system:${id}`)).toBeUndefined();
    }
  });

  it("matches registered discovery domains and their subdomains safely", () => {
    const searchDiscovery = SYSTEM_FILTER_PRESETS.find(
      (preset) => preset.id === "organicSearchDiscovery",
    )!;
    const socialDiscovery = SYSTEM_FILTER_PRESETS.find(
      (preset) => preset.id === "organicSocialDiscovery",
    )!;
    const mobileDiscovery = systemFilterPresetFromOptionValue(
      systemFilterPresetOptionValue("mobileOrganicDiscovery"),
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
    for (const id of LEGACY_SYSTEM_FILTER_PRESET_IDS) {
      expect(
        systemFilterPresetFromOptionValue(systemFilterPresetOptionValue(id)),
      ).toMatchObject({ id });
    }
    expect(systemFilterPresetFromOptionValue("saved:example")).toBeUndefined();
  });
});
