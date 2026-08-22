/**
 * Built-in filter presets are intentionally client-side only. They are useful
 * starting points for the filter editor, but are not saved filters and do not
 * participate in the saved-filter API or D1 storage.
 */

import {
  buildCombinedDiscoveryFilterDsl,
  buildDomainDiscoveryFilterDsl,
} from "@/lib/analytics/traffic-channel-rules";

export const SYSTEM_FILTER_PRESET_IDS = [
  "directTraffic",
  "externalReferrals",
  "organicSearchDiscovery",
  "organicSocialDiscovery",
  "campaignTaggedTraffic",
  "mobileTraffic",
  "desktopTraffic",
  "campaignTaggedExternalAcquisition",
  "campaignTaggedDirectEntry",
  "untaggedExternalReferrals",
  "mobileAcquiredTraffic",
  "mobileOrganicDiscovery",
  "desktopDirectAudience",
  "geographicAttributionGap",
  "tabletTraffic",
] as const;

export type SystemFilterPresetId = (typeof SYSTEM_FILTER_PRESET_IDS)[number];

export interface SystemFilterPreset {
  readonly id: SystemFilterPresetId;
  readonly filterDsl: string;
}

const TAGGED =
  "(utm.source notEmpty OR utm.medium notEmpty OR utm.campaign notEmpty)";
const UNTAGGED =
  "((utm.source notExists OR utm.source isEmpty) AND (utm.medium notExists OR utm.medium isEmpty) AND (utm.campaign notExists OR utm.campaign isEmpty))";

export const SYSTEM_FILTER_PRESETS: readonly SystemFilterPreset[] = [
  { id: "directTraffic", filterDsl: 'referrer.domain eq "__direct__"' },
  { id: "externalReferrals", filterDsl: 'referrer.domain neq "__direct__"' },
  {
    id: "organicSearchDiscovery",
    filterDsl: buildDomainDiscoveryFilterDsl("organic_search"),
  },
  {
    id: "organicSocialDiscovery",
    filterDsl: buildDomainDiscoveryFilterDsl("social"),
  },
  {
    id: "campaignTaggedTraffic",
    filterDsl: TAGGED,
  },
  { id: "mobileTraffic", filterDsl: 'client.deviceType eq "mobile"' },
  { id: "desktopTraffic", filterDsl: 'client.deviceType eq "desktop"' },
  {
    id: "campaignTaggedExternalAcquisition",
    filterDsl: `referrer.domain neq "__direct__" AND ${TAGGED}`,
  },
  {
    id: "campaignTaggedDirectEntry",
    filterDsl: `referrer.domain eq "__direct__" AND ${TAGGED}`,
  },
  {
    id: "untaggedExternalReferrals",
    filterDsl: `referrer.domain neq "__direct__" AND ${UNTAGGED}`,
  },
  {
    id: "mobileAcquiredTraffic",
    filterDsl: `client.deviceType eq "mobile" AND referrer.domain neq "__direct__" AND ${TAGGED}`,
  },
  {
    id: "mobileOrganicDiscovery",
    filterDsl: `client.deviceType eq "mobile" AND ${buildCombinedDiscoveryFilterDsl(["organic_search", "social"])}`,
  },
  {
    id: "desktopDirectAudience",
    filterDsl: `client.deviceType eq "desktop" AND referrer.domain eq "__direct__" AND ${UNTAGGED}`,
  },
  {
    id: "geographicAttributionGap",
    filterDsl: 'geo.country notExists AND referrer.domain neq "__direct__"',
  },
  { id: "tabletTraffic", filterDsl: 'client.deviceType eq "tablet"' },
];

const SYSTEM_FILTER_PRESET_BY_ID = new Map(
  SYSTEM_FILTER_PRESETS.map((preset) => [preset.id, preset]),
);

export const SYSTEM_FILTER_PRESET_OPTION_PREFIX = "system:";

export function systemFilterPresetOptionValue(
  id: SystemFilterPresetId,
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
    ) as SystemFilterPresetId,
  );
}
