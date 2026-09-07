/**
 * Built-in filter presets are intentionally client-side only. They are useful
 * starting points for the filter editor, but are not saved filters and do not
 * participate in the saved-filter API or D1 storage.
 */

import {
  buildCombinedDiscoveryFilterDsl,
  buildDomainDiscoveryFilterDsl,
} from "@/lib/analytics/traffic-channel-rules";
import {
  analyticsFilterRegistry,
  assertFilterAudience,
  type FilterScope,
  parseFilterDsl,
} from "@/lib/filter-contract";

export type SystemFilterPresetCategory =
  | "acquisition"
  | "device"
  | "visitBehavior"
  | "sessionEngagement"
  | "visitorBehavior"
  | "performance"
  | "dataQuality";

export type SystemFilterPresetScope = "preserve" | FilterScope;

/** The 34 presets currently shown in the filter panel. */
export const SYSTEM_FILTER_PRESET_IDS = [
  // Acquisition (7)
  "directTraffic",
  "externalReferrals",
  "organicSearchDiscovery",
  "organicSocialDiscovery",
  "campaignTaggedTraffic",
  "untaggedExternalReferrals",
  "campaignTaggedExternalAcquisition",
  // Device (3)
  "mobileTraffic",
  "desktopTraffic",
  "tabletTraffic",
  // Visit behavior (4)
  "longPageViews",
  "shortPageViews",
  "identifiedActivity",
  "customEventActivity",
  // Session engagement (7)
  "bouncedSessions",
  "nonBouncedSessions",
  "longSessions",
  "shortSessions",
  "deepSessions",
  "eventfulSessions",
  "highEngagementSessions",
  // Visitor behavior (6)
  "returningVisitors",
  "frequentVisitors",
  "deepVisitors",
  "eventfulVisitors",
  "identifiedVisitors",
  "organicSearchVisitors",
  // Performance (6)
  "coreWebVitalsNeedsImprovement",
  "slowLcp",
  "slowInp",
  "highCls",
  "slowTtfb",
  "slowFcp",
  // Data quality (1)
  "geographicAttributionGap",
] as const;

export type SystemFilterPresetId = (typeof SYSTEM_FILTER_PRESET_IDS)[number];

/**
 * These IDs were previously displayed by the panel. Keep their option values
 * readable for old links/bookmarks, but do not count them as current presets.
 */
export const LEGACY_SYSTEM_FILTER_PRESET_IDS = [
  "campaignTaggedDirectEntry",
  "mobileAcquiredTraffic",
  "mobileOrganicDiscovery",
  "desktopDirectAudience",
] as const;

export type LegacySystemFilterPresetId =
  (typeof LEGACY_SYSTEM_FILTER_PRESET_IDS)[number];
export type AnySystemFilterPresetId =
  SystemFilterPresetId | LegacySystemFilterPresetId;

export interface SystemFilterPreset {
  readonly id: AnySystemFilterPresetId;
  readonly category: SystemFilterPresetCategory;
  readonly filterDsl: string;
  /** A dotted path into AppMessages. */
  readonly labelKey: string;
  readonly descriptionKey: string;
  /** preserve keeps the active scope; other values switch to that scope. */
  readonly scope: SystemFilterPresetScope;
}

const TAGGED =
  "(utm.source notEmpty OR utm.medium notEmpty OR utm.campaign notEmpty)";
const UNTAGGED =
  "((utm.source notExists OR utm.source isEmpty) AND (utm.medium notExists OR utm.medium isEmpty) AND (utm.campaign notExists OR utm.campaign isEmpty))";

const preset = <
  TId extends AnySystemFilterPresetId,
  TCategory extends SystemFilterPresetCategory,
>(
  id: TId,
  category: TCategory,
  filterDsl: string,
  scope: SystemFilterPresetScope,
): SystemFilterPreset & { readonly id: TId; readonly category: TCategory } => ({
  id,
  category,
  filterDsl,
  scope,
  labelKey: `filterBuilder.systemPresetItems.${id}.name`,
  descriptionKey: `filterBuilder.systemPresetItems.${id}.description`,
});

export const SYSTEM_FILTER_PRESETS: readonly SystemFilterPreset[] = [
  preset(
    "directTraffic",
    "acquisition",
    'referrer.domain eq "__direct__"',
    "preserve",
  ),
  preset(
    "externalReferrals",
    "acquisition",
    'referrer.domain neq "__direct__"',
    "preserve",
  ),
  preset(
    "organicSearchDiscovery",
    "acquisition",
    buildDomainDiscoveryFilterDsl("organic_search"),
    "preserve",
  ),
  preset(
    "organicSocialDiscovery",
    "acquisition",
    buildDomainDiscoveryFilterDsl("social"),
    "preserve",
  ),
  preset("campaignTaggedTraffic", "acquisition", TAGGED, "preserve"),
  preset(
    "untaggedExternalReferrals",
    "acquisition",
    `referrer.domain neq "__direct__" AND ${UNTAGGED}`,
    "preserve",
  ),
  preset(
    "campaignTaggedExternalAcquisition",
    "acquisition",
    `referrer.domain neq "__direct__" AND ${TAGGED}`,
    "preserve",
  ),

  preset(
    "mobileTraffic",
    "device",
    'client.deviceType eq "mobile"',
    "preserve",
  ),
  preset(
    "desktopTraffic",
    "device",
    'client.deviceType eq "desktop"',
    "preserve",
  ),
  preset(
    "tabletTraffic",
    "device",
    'client.deviceType eq "tablet"',
    "preserve",
  ),

  preset(
    "longPageViews",
    "visitBehavior",
    "page.durationMs gte 30000",
    "event",
  ),
  preset(
    "shortPageViews",
    "visitBehavior",
    "page.durationMs lt 10000",
    "event",
  ),
  preset("identifiedActivity", "visitBehavior", "user.id exists", "event"),
  preset("customEventActivity", "visitBehavior", "event.name exists", "event"),

  preset(
    "bouncedSessions",
    "sessionEngagement",
    "session.bounce eq true",
    "session",
  ),
  preset(
    "nonBouncedSessions",
    "sessionEngagement",
    "session.bounce eq false",
    "session",
  ),
  preset(
    "longSessions",
    "sessionEngagement",
    "session.durationMs gte 300000",
    "session",
  ),
  preset(
    "shortSessions",
    "sessionEngagement",
    "session.durationMs lt 60000",
    "session",
  ),
  preset("deepSessions", "sessionEngagement", "session.views gte 3", "session"),
  preset(
    "eventfulSessions",
    "sessionEngagement",
    "session.events gte 1",
    "session",
  ),
  preset(
    "highEngagementSessions",
    "sessionEngagement",
    "session.views gte 3 AND session.events gte 2",
    "session",
  ),

  preset(
    "returningVisitors",
    "visitorBehavior",
    "visitor.sessions gte 2",
    "visitor",
  ),
  preset(
    "frequentVisitors",
    "visitorBehavior",
    "visitor.sessions gte 5",
    "visitor",
  ),
  preset("deepVisitors", "visitorBehavior", "visitor.views gte 5", "visitor"),
  preset(
    "eventfulVisitors",
    "visitorBehavior",
    "visitor.events gte 2",
    "visitor",
  ),
  preset("identifiedVisitors", "visitorBehavior", "user.id exists", "visitor"),
  preset(
    "organicSearchVisitors",
    "visitorBehavior",
    buildDomainDiscoveryFilterDsl("organic_search"),
    "visitor",
  ),

  preset(
    "coreWebVitalsNeedsImprovement",
    "performance",
    "performance.lcpMs gt 2500 OR performance.inpMs gt 200 OR performance.cls gt 0.1",
    "event",
  ),
  preset("slowLcp", "performance", "performance.lcpMs gt 2500", "event"),
  preset("slowInp", "performance", "performance.inpMs gt 200", "event"),
  preset("highCls", "performance", "performance.cls gt 0.1", "event"),
  preset("slowTtfb", "performance", "performance.ttfbMs gt 800", "event"),
  preset("slowFcp", "performance", "performance.fcpMs gt 1800", "event"),

  preset(
    "geographicAttributionGap",
    "dataQuality",
    'geo.country notExists AND referrer.domain neq "__direct__"',
    "preserve",
  ),
];

const LEGACY_SYSTEM_FILTER_PRESETS: readonly SystemFilterPreset[] = [
  preset(
    "campaignTaggedDirectEntry",
    "acquisition",
    `referrer.domain eq "__direct__" AND ${TAGGED}`,
    "preserve",
  ),
  preset(
    "mobileAcquiredTraffic",
    "acquisition",
    `client.deviceType eq "mobile" AND referrer.domain neq "__direct__" AND ${TAGGED}`,
    "preserve",
  ),
  preset(
    "mobileOrganicDiscovery",
    "acquisition",
    `client.deviceType eq "mobile" AND ${buildCombinedDiscoveryFilterDsl(["organic_search", "social"])}`,
    "preserve",
  ),
  preset(
    "desktopDirectAudience",
    "acquisition",
    `client.deviceType eq "desktop" AND referrer.domain eq "__direct__" AND ${UNTAGGED}`,
    "preserve",
  ),
];

const SYSTEM_FILTER_PRESET_BY_ID = new Map<
  AnySystemFilterPresetId,
  SystemFilterPreset
>(
  [...SYSTEM_FILTER_PRESETS, ...LEGACY_SYSTEM_FILTER_PRESETS].map((item) => [
    item.id,
    item,
  ]),
);

export const SYSTEM_FILTER_PRESET_OPTION_PREFIX = "system:";

export function systemFilterPresetOptionValue(
  id: AnySystemFilterPresetId,
): string {
  return `${SYSTEM_FILTER_PRESET_OPTION_PREFIX}${id}`;
}

export function systemFilterPresetFromOptionValue(
  value: string,
): SystemFilterPreset | undefined {
  if (!value.startsWith(SYSTEM_FILTER_PRESET_OPTION_PREFIX)) return undefined;
  return SYSTEM_FILTER_PRESET_BY_ID.get(
    value.slice(
      SYSTEM_FILTER_PRESET_OPTION_PREFIX.length,
    ) as AnySystemFilterPresetId,
  );
}

/**
 * Derive preset availability from the canonical registry audience gate. This
 * intentionally avoids a second private-preset allowlist that could drift.
 */
export function systemFilterPresetAvailableForAudience(
  item: SystemFilterPreset,
  audience: "private-dashboard" | "public-share",
): boolean {
  try {
    const document = parseFilterDsl(item.filterDsl, analyticsFilterRegistry);
    assertFilterAudience(document, analyticsFilterRegistry, audience);
    return true;
  } catch {
    return false;
  }
}
