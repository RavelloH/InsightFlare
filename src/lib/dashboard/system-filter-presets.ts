/**
 * Built-in filter presets are intentionally client-side only. They are useful
 * starting points for the filter editor, but are not saved filters and do not
 * participate in the saved-filter API or D1 storage.
 */

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

const SEARCH_DOMAINS = [
  "google.com",
  "www.google.com",
  "bing.com",
  "duckduckgo.com",
  "search.yahoo.com",
  "baidu.com",
  "yandex.ru",
  "ecosia.org",
  "naver.com",
  "sogou.com",
  "so.com",
] as const;

const SOCIAL_DOMAINS = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "tiktok.com",
  "youtube.com",
  "pinterest.com",
  "weibo.com",
  "zhihu.com",
] as const;

const asDslList = (values: readonly string[]) =>
  `[${values.map((value) => JSON.stringify(value)).join(",")}]`;

const SEARCH_DOMAINS_DSL = asDslList(SEARCH_DOMAINS);
const SOCIAL_DOMAINS_DSL = asDslList(SOCIAL_DOMAINS);
const TAGGED =
  "(utm.source notEmpty OR utm.medium notEmpty OR utm.campaign notEmpty)";
const UNTAGGED =
  "((utm.source notExists OR utm.source isEmpty) AND (utm.medium notExists OR utm.medium isEmpty) AND (utm.campaign notExists OR utm.campaign isEmpty))";

export const SYSTEM_FILTER_PRESETS: readonly SystemFilterPreset[] = [
  { id: "directTraffic", filterDsl: 'referrer.domain eq "__direct__"' },
  { id: "externalReferrals", filterDsl: 'referrer.domain neq "__direct__"' },
  {
    id: "organicSearchDiscovery",
    filterDsl: `referrer.domain in ${SEARCH_DOMAINS_DSL} AND ${UNTAGGED}`,
  },
  {
    id: "organicSocialDiscovery",
    filterDsl: `referrer.domain in ${SOCIAL_DOMAINS_DSL} AND ${UNTAGGED}`,
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
    filterDsl: `client.deviceType eq "mobile" AND (referrer.domain in ${SEARCH_DOMAINS_DSL} OR referrer.domain in ${SOCIAL_DOMAINS_DSL}) AND ${UNTAGGED}`,
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
