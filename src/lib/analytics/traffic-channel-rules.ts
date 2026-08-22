/**
 * Shared acquisition rules used by dashboard presets and channel aggregation.
 * Keep the domain lists and the discovery-tag policy here so both consumers
 * evolve together.
 */

export const TRAFFIC_CHANNEL_IDS = [
  "direct",
  "organic_search",
  "social",
  "paid_search",
  "paid_social",
  "display",
  "email",
  "affiliate",
  "referral",
  "campaign",
  "other",
] as const;

export type TrafficChannelId = (typeof TRAFFIC_CHANNEL_IDS)[number];
export type DiscoveryChannelId = "organic_search" | "social";

export const TRAFFIC_CHANNEL_RULES: Readonly<
  Record<
    DiscoveryChannelId,
    {
      readonly referrerDomains: readonly string[];
      readonly requiresUntaggedCampaign: true;
    }
  >
> = {
  organic_search: {
    referrerDomains: [
      // Google uses country-specific registrable domains rather than one suffix.
      "google.com",
      "google.com.hk",
      "google.co.uk",
      "google.co.jp",
      "google.de",
      "google.fr",
      "google.ca",
      "google.com.au",
      "google.co.in",
      "google.com.br",
      "google.es",
      "google.it",
      "google.nl",
      "google.pl",
      "google.com.mx",
      "google.com.tr",
      "google.com.sg",
      "google.co.kr",
      "google.co.id",
      "google.com.tw",
      "bing.com",
      "duckduckgo.com",
      "search.yahoo.com",
      "search.yahoo.co.jp",
      "baidu.com",
      "yandex.ru",
      "yandex.com",
      "ecosia.org",
      "naver.com",
      "sogou.com",
      "so.com",
    ],
    requiresUntaggedCampaign: true,
  },
  social: {
    referrerDomains: [
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
    ],
    requiresUntaggedCampaign: true,
  },
};

const CAMPAIGN_UTM_FIELDS = ["source", "medium", "campaign"] as const;

function buildDomainFilterDsl(channel: DiscoveryChannelId): string {
  const rule = TRAFFIC_CHANNEL_RULES[channel];
  return `(${rule.referrerDomains
    .map(
      (domain) =>
        `(referrer.domain eq ${JSON.stringify(domain)} OR referrer.domain endsWith ${JSON.stringify(`.${domain}`)})`,
    )
    .join(" OR ")})`;
}

function buildUntaggedCampaignFilterDsl(): string {
  return `(${CAMPAIGN_UTM_FIELDS.map(
    (field) => `(utm.${field} notExists OR utm.${field} isEmpty)`,
  ).join(" AND ")})`;
}

export function buildDomainDiscoveryFilterDsl(
  channel: DiscoveryChannelId,
): string {
  const rule = TRAFFIC_CHANNEL_RULES[channel];
  const domainExpression = buildDomainFilterDsl(channel);
  return rule.requiresUntaggedCampaign
    ? `${domainExpression} AND ${buildUntaggedCampaignFilterDsl()}`
    : domainExpression;
}

export function buildCombinedDiscoveryFilterDsl(
  channels: readonly DiscoveryChannelId[],
): string {
  if (channels.length === 0) return "false";
  const domainExpression = channels.map(buildDomainFilterDsl).join(" OR ");
  const requiresUntaggedCampaign = channels.some(
    (channel) => TRAFFIC_CHANNEL_RULES[channel].requiresUntaggedCampaign,
  );
  return requiresUntaggedCampaign
    ? `(${domainExpression}) AND ${buildUntaggedCampaignFilterDsl()}`
    : `(${domainExpression})`;
}

export function buildDomainDiscoverySqlPredicate(
  channel: DiscoveryChannelId,
  column = "referrer_host",
): string {
  const rule = TRAFFIC_CHANNEL_RULES[channel];
  const normalizedColumn = `LOWER(TRIM(COALESCE(${column}, '')))`;
  const domainExpression = `(${rule.referrerDomains
    .map(
      (domain) =>
        `(${normalizedColumn}=LOWER('${domain}') OR ${normalizedColumn} LIKE LOWER('%.${domain}'))`,
    )
    .join(" OR ")})`;

  if (!rule.requiresUntaggedCampaign) return domainExpression;
  return `${domainExpression} AND ${buildUntaggedCampaignSqlPredicate()}`;
}

export function buildUntaggedCampaignSqlPredicate(): string {
  return `TRIM(COALESCE(utm_source, '')) = ''
    AND TRIM(COALESCE(utm_medium, '')) = ''
    AND TRIM(COALESCE(utm_campaign, '')) = ''`;
}

export function buildTaggedCampaignSqlPredicate(): string {
  return `TRIM(COALESCE(utm_source, '')) != ''
    OR TRIM(COALESCE(utm_medium, '')) != ''
    OR TRIM(COALESCE(utm_campaign, '')) != ''`;
}

export const UTM_CHANNEL_MEDIUMS = {
  paid_search: ["cpc", "ppc", "paidsearch", "paid-search"],
  paid_social: ["paid_social", "paid-social", "social_ads", "social-ads"],
  display: ["display", "banner", "programmatic"],
  email: ["email", "newsletter"],
  affiliate: ["affiliate", "partner"],
  other: ["other", "unknown", "unclassified"],
} as const satisfies Readonly<
  Record<
    Exclude<
      TrafficChannelId,
      DiscoveryChannelId | "direct" | "referral" | "campaign"
    >,
    readonly string[]
  >
>;

export type UtmMediumChannel = keyof typeof UTM_CHANNEL_MEDIUMS;

export function buildUtmMediumSqlPredicate(
  channel: UtmMediumChannel,
  column = "utm_medium",
): string {
  const normalizedColumn = `LOWER(TRIM(COALESCE(${column}, '')))`;
  return `(${UTM_CHANNEL_MEDIUMS[channel]
    .map((medium) => `${normalizedColumn}=LOWER('${medium}')`)
    .join(" OR ")})`;
}

export interface TrafficChannelAttributionInput {
  readonly referrerHost?: string | null;
  readonly utmSource?: string | null;
  readonly utmMedium?: string | null;
  readonly utmCampaign?: string | null;
}

function normalizeAttributionValue(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function matchesReferrerDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Classify an individual visit using the same precedence as the SQL channel
 * aggregate. This is used by demo data, where aggregation happens in memory.
 */
export function classifyTrafficChannel(
  input: TrafficChannelAttributionInput,
): TrafficChannelId {
  const referrerHost = normalizeAttributionValue(input.referrerHost);
  const utmSource = normalizeAttributionValue(input.utmSource);
  const utmMedium = normalizeAttributionValue(input.utmMedium);
  const utmCampaign = normalizeAttributionValue(input.utmCampaign);
  const isUntagged = !utmSource && !utmMedium && !utmCampaign;

  if (isUntagged) {
    for (const channel of ["organic_search", "social"] as const) {
      if (
        TRAFFIC_CHANNEL_RULES[channel].referrerDomains.some((domain) =>
          matchesReferrerDomain(referrerHost, domain),
        )
      ) {
        return channel;
      }
    }
  }

  const mediumChannel = (
    Object.entries(UTM_CHANNEL_MEDIUMS) as Array<
      [UtmMediumChannel, readonly string[]]
    >
  ).find(([, mediums]) => mediums.includes(utmMedium));
  if (mediumChannel) return mediumChannel[0];
  if (!isUntagged) return "campaign";
  if (referrerHost) return "referral";
  return "direct";
}
