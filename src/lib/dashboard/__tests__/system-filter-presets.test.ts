import { describe, expect, it } from "vitest";

import {
  LEGACY_SYSTEM_FILTER_PRESET_IDS,
  SYSTEM_FILTER_PRESET_IDS,
  SYSTEM_FILTER_PRESETS,
  systemFilterPresetAvailableForAudience,
  systemFilterPresetFromOptionValue,
  systemFilterPresetOptionValue,
} from "@/lib/dashboard/system-filter-presets";
import { EXPANDED_SYSTEM_FILTER_PRESETS } from "@/lib/dashboard/system-filter-presets/index";
import { queryPolicyForAudience } from "@/lib/edge/analytics/contract/policy";
import {
  analyticsFilterRegistry,
  analyzeFilterDocument,
  assertFilterAudience,
  filterConditionCount,
  filterDocumentUsesAdvancedExpressions,
  filterFingerprint,
  parseFilterDsl,
  validateFilterConditionDomains,
  validateFilterRelationDomains,
} from "@/lib/filter-contract";
import { getMessages } from "@/lib/i18n/messages";

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

    expect(SYSTEM_FILTER_PRESETS).toHaveLength(110);
    expect(SYSTEM_FILTER_PRESET_IDS).toHaveLength(110);
    expect(SYSTEM_FILTER_PRESET_IDS).toEqual(
      SYSTEM_FILTER_PRESETS.map((item) => item.id),
    );
  });

  it("covers the planned categories and fixed scopes", () => {
    const baseline = SYSTEM_FILTER_PRESETS.slice(0, 34);
    const categoryCounts = baseline.reduce<Record<string, number>>(
      (counts, item) => {
        counts[item.category] = (counts[item.category] ?? 0) + 1;
        return counts;
      },
      {},
    );
    expect(categoryCounts).toEqual({
      acquisition: 7,
      device: 3,
      pageContent: 2,
      eventConversion: 2,
      sessionEngagement: 7,
      visitorBehavior: 6,
      performance: 6,
      dataQuality: 1,
    });
    expect(baseline.filter((item) => item.scope === "session")).toHaveLength(7);
    expect(baseline.filter((item) => item.scope === "visitor")).toHaveLength(6);
    expect(baseline.filter((item) => item.scope === "preserve")).toHaveLength(
      11,
    );
    expect(baseline.filter((item) => item.scope === "event")).toHaveLength(10);
  });

  it("keeps private user/event presets out of public audiences", () => {
    const privatePresetIds = [
      "identifiedActivity",
      "customEventActivity",
      "identifiedVisitors",
      "pageQueryActivity",
      "purchaseCount",
      "purchaseAmount",
      "avgPurchaseAmount",
      "distinctPurchasedSku",
      "morePurchasesThanRefunds",
      "eventNamesSession",
      "eventWithPayload",
      "successfulEvent",
      "largeTransaction",
      "errorEvents",
      "signupNoPurchase",
      "purchaseWithoutRefund",
      "pageAndEventSession",
      "eventHeavySession",
      "highEventRatio",
      "recentEventVisitor",
      "signupToPurchase14d",
      "pricingAdjacentPurchase",
      "signupPurchaseNoCancel",
      "sameProductPurchase",
      "purchaseNoRefundWindow",
      "signupActivationPurchase",
      "cartPurchaseJourney",
      "signupLaterVisit",
      "purchaseFollowup",
      "eventOnlySession",
      "missingPayloadAmount",
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

describe("expanded system presets", () => {
  it("validates scopes, unique semantic definitions, all categories and locale labels", () => {
    const keys = new Set<string>();
    for (const item of SYSTEM_FILTER_PRESETS) {
      const document = parseFilterDsl(item.filterDsl, analyticsFilterRegistry);
      const key =
        item.scope + ":" + filterFingerprint(document, analyticsFilterRegistry);
      expect(keys.has(key), item.id).toBe(false);
      keys.add(key);
      assertFilterAudience(
        document,
        analyticsFilterRegistry,
        "private-dashboard",
      );
      const scopes =
        item.scope === "preserve"
          ? (["event", "session", "visitor"] as const)
          : [item.scope];
      for (const scope of scopes) {
        validateFilterConditionDomains(
          document,
          scope,
          analyticsFilterRegistry,
        );
        validateFilterRelationDomains(
          document,
          scope,
          analyzeFilterDocument(document, analyticsFilterRegistry),
        );
      }
      for (const locale of ["en", "zh", "zh-tw", "ja"] as const) {
        const copy =
          getMessages(locale).filterBuilder.systemPresetItems[item.id];
        expect(Object.keys(copy).sort(), item.id + ":" + locale).toEqual([
          "description",
          "name",
        ]);
        expect(
          Object.values(copy).every(
            (value) => typeof value === "string" && value.length > 0,
          ),
          item.id + ":" + locale,
        ).toBe(true);
      }
    }
    expect(
      new Set(EXPANDED_SYSTEM_FILTER_PRESETS.map((x) => x.category)).size,
    ).toBe(9);
    expect(
      SYSTEM_FILTER_PRESETS.filter((item) =>
        filterDocumentUsesAdvancedExpressions(
          parseFilterDsl(item.filterDsl, analyticsFilterRegistry),
        ),
      ).length,
    ).toBeGreaterThanOrEqual(55);
  });
});
