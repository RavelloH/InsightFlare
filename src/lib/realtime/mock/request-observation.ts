import { DEMO_SITE_PROFILES } from "@/lib/realtime/demo-site-profiles";
import {
  createDemoRng,
  sInt,
  sPick,
  weightedPickLabel,
  windowBucket,
} from "@/lib/realtime/demo-utils";
import { pickDemoGeoContext } from "@/lib/realtime/mock/dimension-pickers";

type WindowMinutes = 60 | 1440 | 10080 | 43200;
type DemoNormalEventKind =
  | "pageview"
  | "leave"
  | "visibility"
  | "custom_event"
  | "identify";

type DemoRequestCategory = "normal" | "suspected_bot" | "bot" | "custom_block";
type DemoRequestDisposition = "included" | "blocked";

interface DemoRequestEvent {
  timestamp: string;
  receivedAt: number;
  eventAt: number;
  edgeLatencyMs: number | null;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string | DemoNormalEventKind;
  category: DemoRequestCategory;
  disposition: DemoRequestDisposition;
  reasons: string[];
  ip: string;
  userAgent: string;
  origin: string;
  hostname: string;
  pathname: string;
  country: string;
  region: string;
  city: string;
  continent: string;
  colo: string;
  asn: number;
  asOrganization: string;
  verifiedBotCategory: string;
  rayId: string;
  traceId: string;
  requestMethod: string;
  httpProtocol: string;
  metadataJson: string;
  latitude: number | null;
  longitude: number | null;
  botScore: number | null;
  userAgentLength: number;
  sampleWeight: number;
}

type DemoBotEvent = DemoRequestEvent;
type DemoNormalEvent = DemoRequestEvent;

interface DemoMapPoint {
  latitude: number;
  longitude: number;
  country: string;
  pointCount: number;
}

interface DemoTrendPoint {
  timestampMs: number;
  count: number;
  baselineCount: number;
  botRatio: number;
  normalCount: number;
  suspectedBotCount: number;
  botCount: number;
  customBlockedCount: number;
  includedCount: number;
  blockedCount: number;
  totalCount: number;
  blockedRatio: number;
  normalRatio: number;
  pageviews: number;
  customEvents: number;
  pageviewCount: number;
  leaveCount: number;
  visibilityCount: number;
  customEventCount: number;
  identifyCount: number;
  weightedRequestCount: number;
  latencyWeightedSumMs: number;
  latencySampleWeight: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p75LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
}

interface DemoRequestObservationData {
  ok: true;
  configured: boolean;
  generatedAt: number;
  sampling: {
    provider: "cloudflare_analytics_engine";
    mode: "automatic";
    observedSampled: boolean;
    aggregatesWeighted: boolean;
    detailsAreSampled: boolean;
    distinctAreApproximate: boolean;
  };
  window: {
    minutes: number;
    from: number;
    to: number;
  };
  summary: {
    total: number;
    normalRequests: number;
    suspectedBotRequests: number;
    botRequests: number;
    customBlockedRequests: number;
    includedRequests: number;
    blockedRequests: number;
    affectedSites: number;
    uniqueAsns: number;
    uniqueCountries: number;
  };
  mapPoints: DemoMapPoint[];
  trend: DemoTrendPoint[];
  reasons: Array<{ reason: string; count: number }>;
  countries: Array<{ country: string; count: number }>;
  asns: Array<{ asn: number; asOrganization: string; count: number }>;
  events: DemoRequestEvent[];
  normalEvents: DemoRequestEvent[];
  blockedEvents: DemoRequestEvent[];
  includedEvents: DemoRequestEvent[];
  overview: {
    totalRequests: number;
    includedRequests: number;
    blockedRequests: number;
    normalRequests: number;
    suspectedBotRequests: number;
    botRequests: number;
    customBlockedRequests: number;
    botRequestRatio: number;
    blockedRequestRatio: number;
    normalRequestRatio: number;
    pageviews: number;
    customEvents: number;
    avgLatencyMs: number | null;
    p50LatencyMs: number | null;
    p75LatencyMs: number | null;
    p95LatencyMs: number | null;
    p99LatencyMs: number | null;
  };
  blocked: {
    summary: DemoRequestObservationData["summary"] & {
      total: number;
      ratio: number;
      pageviews: number;
      customEvents: number;
      avgLatencyMs: number | null;
      p50LatencyMs: number | null;
      p75LatencyMs: number | null;
      p95LatencyMs: number | null;
      p99LatencyMs: number | null;
    };
    mapPoints: DemoMapPoint[];
    events: DemoRequestEvent[];
    hasMore: boolean;
    nextCursor: { timestamp: string; receivedAt: number } | null;
    reasons: Array<{ reason: string; count: number }>;
    countries: Array<{ country: string; count: number }>;
    asns: Array<{ asn: number; asOrganization: string; count: number }>;
    dimensions: { network: Record<string, unknown[]> };
  };
  included: {
    summary: {
      total: number;
      ratio: number;
      normalRequests: number;
      suspectedBotRequests: number;
      botRequests: number;
      customBlockedRequests: number;
      includedRequests: number;
      blockedRequests: number;
      pageviews: number;
      customEvents: number;
      affectedSites: number;
      uniqueAsns: number;
      uniqueCountries: number;
      avgLatencyMs: number | null;
      p50LatencyMs: number | null;
      p75LatencyMs: number | null;
      p95LatencyMs: number | null;
      p99LatencyMs: number | null;
    };
    mapPoints: DemoMapPoint[];
    events: DemoRequestEvent[];
    hasMore: boolean;
    nextCursor: { timestamp: string; receivedAt: number } | null;
    dimensions: { network: Record<string, unknown[]> };
  };
}

const BOT_REASON_WEIGHTS = [
  { label: "ua_isbot", weight: 34 },
  { label: "hosting_asn", weight: 28 },
  { label: "script_ua", weight: 18 },
  { label: "cf_bot_score_low", weight: 16 },
  { label: "missing_browser_provenance", weight: 12 },
  { label: "network_service_asn", weight: 10 },
  { label: "origin_hostname_mismatch", weight: 7 },
  { label: "ua_too_long", weight: 5 },
] as const;

const CUSTOM_BLOCK_REASON_WEIGHTS = [
  { label: "blocked_domains", weight: 18 },
  { label: "blocked_paths", weight: 18 },
  { label: "blocked_query_parameters", weight: 12 },
  { label: "blocked_referrers", weight: 10 },
  { label: "blocked_user_agents", weight: 14 },
  { label: "blocked_ips", weight: 12 },
  { label: "blocked_asns", weight: 9 },
  { label: "blocked_countries", weight: 5 },
  { label: "blocked_regions", weight: 2 },
] as const;

const NORMAL_EVENT_KIND_WEIGHTS = [
  { label: "pageview", weight: 48 },
  { label: "leave", weight: 12 },
  { label: "visibility", weight: 18 },
  { label: "custom_event", weight: 18 },
  { label: "identify", weight: 4 },
] as const;

const NORMAL_EVENT_KINDS = [
  "pageview",
  "leave",
  "visibility",
  "custom_event",
  "identify",
] as const;

const NORMAL_EVENT_COUNT_KEYS: Record<
  DemoNormalEventKind,
  | "pageviewCount"
  | "leaveCount"
  | "visibilityCount"
  | "customEventCount"
  | "identifyCount"
> = {
  pageview: "pageviewCount",
  leave: "leaveCount",
  visibility: "visibilityCount",
  custom_event: "customEventCount",
  identify: "identifyCount",
};

const BOT_ASNS = [
  { asn: 15169, organization: "Google LLC", weight: 16 },
  { asn: 16509, organization: "Amazon.com, Inc.", weight: 22 },
  { asn: 8075, organization: "Microsoft Corporation", weight: 17 },
  { asn: 13335, organization: "Cloudflare, Inc.", weight: 18 },
  { asn: 14618, organization: "Amazon.com, Inc.", weight: 14 },
  { asn: 14061, organization: "DigitalOcean, LLC", weight: 13 },
  { asn: 24940, organization: "Hetzner Online GmbH", weight: 12 },
  { asn: 63949, organization: "Akamai Connected Cloud", weight: 9 },
  { asn: 16276, organization: "OVH SAS", weight: 8 },
] as const;

const NORMAL_ASNS = [
  { asn: 7922, organization: "Comcast Cable Communications, LLC", weight: 16 },
  { asn: 7018, organization: "AT&T Services, Inc.", weight: 15 },
  {
    asn: 56046,
    organization: "China Mobile Communications Group Co., Ltd.",
    weight: 14,
  },
  { asn: 3320, organization: "Deutsche Telekom AG", weight: 10 },
  { asn: 2516, organization: "KDDI Corporation", weight: 10 },
  { asn: 4766, organization: "Korea Telecom", weight: 9 },
  { asn: 3215, organization: "Orange S.A.", weight: 8 },
  { asn: 5089, organization: "Virgin Media Limited", weight: 7 },
  { asn: 1221, organization: "Telstra Pty Ltd", weight: 6 },
] as const;

const DEMO_BLOCKED_COUNTRY_WEIGHTS = [
  { label: "US", weight: 18 },
  { label: "DE", weight: 14 },
  { label: "NL", weight: 12 },
  { label: "SG", weight: 10 },
  { label: "RU", weight: 9 },
  { label: "IN", weight: 8 },
  { label: "BR", weight: 7 },
  { label: "VN", weight: 6 },
  { label: "GB", weight: 6 },
  { label: "FR", weight: 6 },
  { label: "JP", weight: 5 },
  { label: "KR", weight: 5 },
  { label: "CN", weight: 5 },
  { label: "CA", weight: 5 },
  { label: "AU", weight: 5 },
  { label: "ID", weight: 5 },
  { label: "TH", weight: 4 },
  { label: "PH", weight: 4 },
  { label: "MY", weight: 4 },
  { label: "AE", weight: 4 },
  { label: "TR", weight: 4 },
  { label: "ES", weight: 4 },
  { label: "IT", weight: 4 },
  { label: "PL", weight: 4 },
  { label: "SE", weight: 3 },
  { label: "MX", weight: 4 },
  { label: "CO", weight: 3 },
  { label: "AR", weight: 3 },
  { label: "CL", weight: 3 },
  { label: "ZA", weight: 4 },
  { label: "NG", weight: 4 },
  { label: "KE", weight: 3 },
  { label: "EG", weight: 3 },
  { label: "NZ", weight: 3 },
] as const;

const DEMO_NORMAL_COUNTRY_WEIGHTS = [
  { label: "CN", weight: 20 },
  { label: "US", weight: 15 },
  { label: "JP", weight: 12 },
  { label: "KR", weight: 10 },
  { label: "GB", weight: 9 },
  { label: "FR", weight: 8 },
  { label: "AU", weight: 7 },
  { label: "CA", weight: 7 },
  { label: "DE", weight: 7 },
  { label: "IN", weight: 7 },
  { label: "BR", weight: 6 },
  { label: "SG", weight: 6 },
  { label: "NL", weight: 5 },
  { label: "IT", weight: 5 },
  { label: "ES", weight: 5 },
  { label: "SE", weight: 4 },
  { label: "PL", weight: 4 },
  { label: "RU", weight: 4 },
  { label: "TR", weight: 4 },
  { label: "ID", weight: 5 },
  { label: "PH", weight: 4 },
  { label: "VN", weight: 4 },
  { label: "TH", weight: 4 },
  { label: "MY", weight: 4 },
  { label: "TW", weight: 4 },
  { label: "HK", weight: 4 },
  { label: "MX", weight: 5 },
  { label: "CO", weight: 4 },
  { label: "AR", weight: 4 },
  { label: "CL", weight: 3 },
  { label: "ZA", weight: 4 },
  { label: "NG", weight: 4 },
  { label: "KE", weight: 3 },
  { label: "EG", weight: 3 },
  { label: "AE", weight: 3 },
  { label: "NZ", weight: 3 },
] as const;

const BOT_USER_AGENTS = [
  "Googlebot/2.1 (+http://www.google.com/bot.html)",
  "bingbot/2.0 (+http://www.bing.com/bingbot.htm)",
  "AhrefsBot/7.0 (+http://ahrefs.com/robot/)",
  "SemrushBot/7~bl (+http://www.semrush.com/bot.html)",
  "python-requests/2.32.3",
  "curl/8.7.1",
  "Go-http-client/2.0",
  "Mozilla/5.0 zgrab/0.x",
] as const;

const COLOS = [
  "SJC",
  "LAX",
  "DFW",
  "IAD",
  "FRA",
  "AMS",
  "SIN",
  "NRT",
  "HKG",
] as const;

function bucketSizeMs(minutes: number): number {
  if (minutes <= 1440) return 60 * 60 * 1000;
  if (minutes <= 10080) return 6 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function mapCoordinatePrecision(minutes: number): number {
  if (minutes <= 60) return 100;
  if (minutes <= 1440) return 50;
  if (minutes <= 10080) return 25;
  return 10;
}

function weightedPickAsn(rng: () => number) {
  const total = BOT_ASNS.reduce((sum, item) => sum + item.weight, 0);
  let hit = rng() * total;
  for (const item of BOT_ASNS) {
    hit -= item.weight;
    if (hit <= 0) return item;
  }
  return BOT_ASNS[0];
}

function weightedPickNormalAsn(rng: () => number) {
  const total = NORMAL_ASNS.reduce((sum, item) => sum + item.weight, 0);
  let hit = rng() * total;
  for (const item of NORMAL_ASNS) {
    hit -= item.weight;
    if (hit <= 0) return item;
  }
  return NORMAL_ASNS[0];
}

function pickDemoTrafficCountry(
  rng: () => number,
  profileCountries: Array<{ code: string; weight: number }>,
  trafficWeights: readonly { label: string; weight: number }[],
  fallback: string,
): string {
  const profileWeightByCountry = new Map(
    profileCountries.map((item) => [
      item.code.trim().toUpperCase(),
      Math.max(0, item.weight),
    ]),
  );
  const adjustedWeights = trafficWeights.map((item) => {
    const profileWeight = profileWeightByCountry.get(item.label) ?? 0;
    return {
      label: item.label,
      weight: item.weight * (0.75 + profileWeight / 100),
    };
  });
  return weightedPickLabel(rng, adjustedWeights, fallback);
}

function pickReasons(rng: () => number): string[] {
  if (rng() < 0.16) {
    const reasons = new Set([
      "custom_block",
      weightedPickLabel(rng, [...CUSTOM_BLOCK_REASON_WEIGHTS], "blocked_paths"),
    ]);
    if (rng() < 0.18) {
      reasons.add(
        weightedPickLabel(
          rng,
          [...CUSTOM_BLOCK_REASON_WEIGHTS],
          "blocked_domains",
        ),
      );
    }
    return [...reasons];
  }

  const first = weightedPickLabel(rng, [...BOT_REASON_WEIGHTS], "ua_isbot");
  const reasons = new Set([first]);
  if (rng() < 0.42) {
    reasons.add(weightedPickLabel(rng, [...BOT_REASON_WEIGHTS], "hosting_asn"));
  }
  if (rng() < 0.14) {
    reasons.add(
      weightedPickLabel(
        rng,
        [...BOT_REASON_WEIGHTS],
        "missing_browser_provenance",
      ),
    );
  }
  return [...reasons];
}

function randomIpv4(rng: () => number): string {
  return [
    sInt(rng, 13, 223),
    sInt(rng, 0, 255),
    sInt(rng, 0, 255),
    sInt(rng, 1, 254),
  ].join(".");
}

function emptyTrendPoint() {
  return {
    count: 0,
    baselineCount: 0,
    botRatio: 0,
    normalCount: 0,
    suspectedBotCount: 0,
    botCount: 0,
    customBlockedCount: 0,
    includedCount: 0,
    blockedCount: 0,
    totalCount: 0,
    blockedRatio: 0,
    normalRatio: 0,
    pageviews: 0,
    customEvents: 0,
    pageviewCount: 0,
    leaveCount: 0,
    visibilityCount: 0,
    customEventCount: 0,
    identifyCount: 0,
    weightedRequestCount: 0,
    latencyWeightedSumMs: 0,
    latencySampleWeight: 0,
    avgLatencyMs: null,
    p50LatencyMs: null,
    p75LatencyMs: null,
    p95LatencyMs: null,
    p99LatencyMs: null,
    latencySamples: [] as Array<{ value: number; weight: number }>,
  };
}

function weightedPercentile(
  samples: Array<{ value: number; weight: number }>,
  percentileValue: number,
): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left.value - right.value);
  const totalWeight = sorted.reduce((sum, sample) => sum + sample.weight, 0);
  if (totalWeight <= 0) return null;
  const target = Math.max(1, Math.ceil(totalWeight * percentileValue));
  let weight = 0;
  for (const sample of sorted) {
    weight += sample.weight;
    if (weight >= target) return sample.value;
  }
  return sorted[sorted.length - 1].value;
}

function aggregateEvents(
  events: DemoRequestEvent[],
  minutes: number,
  generatedAt = Date.now(),
  includeIncludedMapPoints = false,
) {
  const from = generatedAt - minutes * 60 * 1000;
  const bucketMs = bucketSizeMs(minutes);
  const coordinatePrecision = mapCoordinatePrecision(minutes);
  const trend = new Map<number, ReturnType<typeof emptyTrendPoint>>();
  const reasons = new Map<string, number>();
  const countries = new Map<string, number>();
  const asns = new Map<
    number,
    { asn: number; asOrganization: string; count: number }
  >();
  const mapPoints = new Map<
    string,
    {
      latitude: number;
      longitude: number;
      country: string;
      pointCount: number;
    }
  >();

  for (let bucket = from; bucket <= generatedAt; bucket += bucketMs) {
    trend.set(Math.floor(bucket / bucketMs) * bucketMs, emptyTrendPoint());
  }

  for (const event of events) {
    const bucket = Math.floor(event.receivedAt / bucketMs) * bucketMs;
    const point = trend.get(bucket) ?? emptyTrendPoint();
    const weight = Math.max(1, Math.trunc(event.sampleWeight));
    point.count += weight;
    point.weightedRequestCount += weight;
    point.totalCount += weight;
    if (event.category === "normal") {
      point.normalCount += weight;
      point.baselineCount += weight;
    }
    if (event.category === "suspected_bot") point.suspectedBotCount += weight;
    if (event.category === "bot") point.botCount += weight;
    if (event.category === "custom_block") point.customBlockedCount += weight;
    if (event.disposition === "included") point.includedCount += weight;
    else point.blockedCount += weight;
    const eventKind = event.kind as DemoNormalEventKind;
    const countKey = NORMAL_EVENT_COUNT_KEYS[eventKind];
    if (countKey) point[countKey] += weight;
    if (event.kind === "pageview") point.pageviews += weight;
    if (event.kind === "custom_event") point.customEvents += weight;
    if (
      Number.isFinite(event.edgeLatencyMs) &&
      event.edgeLatencyMs !== null &&
      event.edgeLatencyMs >= 0
    ) {
      point.latencyWeightedSumMs += event.edgeLatencyMs * weight;
      point.latencySampleWeight += weight;
      point.latencySamples.push({ value: event.edgeLatencyMs, weight });
    }
    trend.set(bucket, point);

    if (event.disposition === "blocked") {
      for (const reason of event.reasons) {
        reasons.set(reason, (reasons.get(reason) || 0) + weight);
      }
      countries.set(
        event.country,
        (countries.get(event.country) || 0) + weight,
      );

      const asn = asns.get(event.asn);
      if (asn) {
        asn.count += weight;
      } else {
        asns.set(event.asn, {
          asn: event.asn,
          asOrganization: event.asOrganization,
          count: weight,
        });
      }
    }
    if (
      event.latitude !== null &&
      event.longitude !== null &&
      (event.disposition === "blocked" || includeIncludedMapPoints)
    ) {
      const lat =
        Math.round(event.latitude * coordinatePrecision) / coordinatePrecision;
      const lon =
        Math.round(event.longitude * coordinatePrecision) / coordinatePrecision;
      const key = `${event.country}:${lat}:${lon}`;
      const current = mapPoints.get(key);
      if (current) {
        current.pointCount += weight;
      } else {
        mapPoints.set(key, {
          latitude: lat,
          longitude: lon,
          country: event.country,
          pointCount: weight,
        });
      }
    }
  }

  const sortCounts = <T extends { count: number }>(items: T[]) =>
    items.sort((left, right) => right.count - left.count).slice(0, 10);

  return {
    trend: [...trend.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([timestampMs, point]) => {
        const avgLatencyMs =
          point.latencySampleWeight > 0
            ? point.latencyWeightedSumMs / point.latencySampleWeight
            : null;
        return {
          timestampMs,
          ...(() => {
            const { latencySamples: _latencySamples, ...serializablePoint } =
              point;
            return serializablePoint;
          })(),
          totalCount: point.includedCount + point.blockedCount,
          botRatio:
            point.includedCount + point.blockedCount > 0
              ? point.botCount / (point.includedCount + point.blockedCount)
              : 0,
          blockedRatio:
            point.includedCount + point.blockedCount > 0
              ? point.blockedCount / (point.includedCount + point.blockedCount)
              : 0,
          normalRatio:
            point.includedCount + point.blockedCount > 0
              ? point.normalCount / (point.includedCount + point.blockedCount)
              : 0,
          avgLatencyMs,
          p50LatencyMs: weightedPercentile(point.latencySamples, 0.5),
          p75LatencyMs: weightedPercentile(point.latencySamples, 0.75),
          p95LatencyMs: weightedPercentile(point.latencySamples, 0.95),
          p99LatencyMs: weightedPercentile(point.latencySamples, 0.99),
        };
      }),
    reasons: sortCounts(
      [...reasons.entries()].map(([reason, count]) => ({ reason, count })),
    ),
    countries: sortCounts(
      [...countries.entries()].map(([country, count]) => ({ country, count })),
    ),
    asns: sortCounts([...asns.values()]),
    mapPoints: [...mapPoints.values()],
  };
}

export function generateDemoRequestObservationData(
  minutes: WindowMinutes,
  generatedAt = Date.now(),
): DemoRequestObservationData {
  const from = generatedAt - minutes * 60 * 1000;
  const rng = createDemoRng(
    "global",
    `request-observation:${minutes}:${windowBucket(from, generatedAt)}`,
  );
  const eventTargetByWindow: Record<WindowMinutes, number> = {
    60: 280,
    1440: 900,
    10080: 1500,
    43200: 2400,
  };
  const target = eventTargetByWindow[minutes];
  const events: DemoBotEvent[] = [];
  const normalEvents: DemoNormalEvent[] = [];

  for (let index = 0; index < target; index += 1) {
    const site = sPick(rng, DEMO_SITE_PROFILES);
    const country = pickDemoTrafficCountry(
      rng,
      site.topCountries,
      DEMO_BLOCKED_COUNTRY_WEIGHTS,
      "US",
    );
    const geo = pickDemoGeoContext(rng, country);
    const asn = weightedPickAsn(rng);
    const reasons = pickReasons(rng);
    const receivedAt =
      generatedAt - Math.floor(Math.pow(rng(), 1.35) * minutes * 60 * 1000);
    const pathname = sPick(rng, site.paths) || "/";
    const userAgent = sPick(rng, BOT_USER_AGENTS);
    const category: Exclude<DemoRequestCategory, "normal"> =
      index === 0
        ? "suspected_bot"
        : index === 1
          ? "bot"
          : index === 2
            ? "custom_block"
            : reasons.includes("custom_block")
              ? "custom_block"
              : reasons.includes("ua_isbot") ||
                  reasons.includes("script_ua") ||
                  reasons.includes("cf_bot_score_low") ||
                  index % 5 === 0
                ? "bot"
                : "suspected_bot";
    const rayId = `${sInt(rng, 100000, 999999).toString(16)}${index.toString(16)}demo`;
    const traceId = `demo-bot-${index.toString(36).padStart(4, "0")}`;
    const sampleWeight = index % 17 === 0 ? 4 : index % 5 === 0 ? 2 : 1;

    events.push({
      timestamp: new Date(receivedAt).toISOString(),
      receivedAt,
      eventAt: receivedAt,
      edgeLatencyMs: null,
      siteId: site.id,
      siteName: site.name,
      siteDomain: site.domain,
      kind: "collect",
      category,
      disposition:
        category === "bot" || category === "custom_block"
          ? "blocked"
          : "included",
      reasons,
      ip: category === "bot" ? randomIpv4(rng) : "",
      userAgent,
      origin: `https://${site.domain}`,
      hostname: site.domain,
      pathname,
      country,
      region: geo.regionName || geo.region,
      city: geo.cityName || geo.city,
      continent: geo.continent,
      colo: sPick(rng, COLOS),
      asn: asn.asn,
      asOrganization: asn.organization,
      verifiedBotCategory: userAgent.toLowerCase().includes("bot")
        ? sPick(rng, ["Search Engine Crawler", "Monitoring", "SEO"])
        : "",
      rayId,
      traceId,
      requestMethod: "POST",
      httpProtocol: "h2",
      metadataJson: JSON.stringify({
        rayId,
        requestUrl: `https://${site.domain}${pathname}`,
        requestPathname: pathname,
        requestMethod: "POST",
        referer: index % 3 === 0 ? "https://www.google.com/" : "",
        secFetchSite: "same-origin",
        secFetchMode: "cors",
        secFetchDest: "empty",
        httpProtocol: "h2",
        tlsVersion: "TLSv1.3",
        requestPriority: "u=1",
        clientTcpRtt: sInt(rng, 12, 96),
        eventId: `demo-event-${index.toString(36).padStart(5, "0")}`,
        previousVisitId:
          index % 4 === 0
            ? `demo-previous-visit-${(index % 12).toString(36).padStart(3, "0")}`
            : "",
      }),
      latitude: geo.latitude,
      longitude: geo.longitude,
      botScore: category === "bot" ? sInt(rng, 1, 19) : sInt(rng, 20, 54),
      userAgentLength: userAgent.length,
      sampleWeight,
    });
  }

  const ratioByWindow: Record<WindowMinutes, number> = {
    60: 0.18,
    1440: 0.09,
    10080: 0.07,
    43200: 0.06,
  };
  const botRequestRatio =
    ratioByWindow[minutes] + Math.round(rng() * 20) / 1000;
  const botLikeSampleCount = events.reduce(
    (sum, event) => sum + event.sampleWeight,
    0,
  );
  const baselineRequests = Math.max(
    events.length,
    Math.round((botLikeSampleCount / botRequestRatio) * (1 - botRequestRatio)),
  );

  for (let index = 0; index < baselineRequests; index += 1) {
    const site = sPick(rng, DEMO_SITE_PROFILES);
    const country = pickDemoTrafficCountry(
      rng,
      site.topCountries,
      DEMO_NORMAL_COUNTRY_WEIGHTS,
      "CN",
    );
    const geo = pickDemoGeoContext(rng, country);
    const asn = weightedPickNormalAsn(rng);
    const receivedAt =
      generatedAt - Math.floor(Math.pow(rng(), 1.08) * minutes * 60 * 1000);
    const eventAt = receivedAt - sInt(rng, 8, 95);
    const pathname = sPick(rng, site.paths) || "/";
    const kind = (
      index < NORMAL_EVENT_KINDS.length
        ? NORMAL_EVENT_KINDS[index]
        : weightedPickLabel(rng, [...NORMAL_EVENT_KIND_WEIGHTS], "pageview")
    ) as DemoNormalEventKind;
    const isCustomEvent = kind === "custom_event";
    const isVisibility = kind === "visibility";
    const edgeLatencyMs =
      Math.round((18 + rng() * 44 + (isCustomEvent ? 8 : 0)) * 10) / 10;
    const sampleWeight = index % 19 === 0 ? 3 : index % 7 === 0 ? 2 : 1;

    normalEvents.push({
      timestamp: new Date(receivedAt).toISOString(),
      receivedAt,
      eventAt,
      edgeLatencyMs,
      siteId: site.id,
      siteName: site.name,
      siteDomain: site.domain,
      kind,
      category: "normal",
      disposition: "included",
      reasons: [],
      ip: "",
      userAgent: "Mozilla/5.0 (demo browser)",
      verifiedBotCategory: "",
      botScore: null,
      origin: `https://${site.domain}`,
      hostname: site.domain,
      pathname,
      country,
      region: geo.regionName || geo.region,
      city: geo.cityName || geo.city,
      continent: geo.continent,
      colo: sPick(rng, COLOS),
      asn: asn.asn,
      asOrganization: asn.organization,
      rayId: `${sInt(rng, 100000, 999999).toString(16)}${index.toString(16)}ok`,
      traceId: `demo-normal-${index.toString(36).padStart(5, "0")}`,
      requestMethod: "POST",
      httpProtocol: "h2",
      metadataJson: JSON.stringify({
        eventId: `demo-event-${index.toString(36).padStart(5, "0")}`,
        visitId: `demo-visit-${(index % 24).toString(36).padStart(3, "0")}`,
        previousVisitId:
          index % 4 === 0
            ? `demo-previous-visit-${(index % 12).toString(36).padStart(3, "0")}`
            : "",
        hasVisitorId: true,
        hasUserId: index % 3 === 0,
        eventName: isCustomEvent ? `demo_event_${index % 5}` : "",
        visibilityState: isVisibility
          ? index % 2 === 0
            ? "visible"
            : "hidden"
          : "",
        secFetchSite: "same-origin",
        secFetchMode: "cors",
        secFetchDest: "empty",
        httpProtocol: "h2",
      }),
      latitude: geo.latitude,
      longitude: geo.longitude,
      userAgentLength: sInt(rng, 72, 156),
      sampleWeight,
    });
  }

  const allEvents = [...events, ...normalEvents].sort(
    (left, right) =>
      right.receivedAt - left.receivedAt ||
      left.traceId.localeCompare(right.traceId),
  );
  const blockedEvents = allEvents.filter(
    (event) => event.disposition === "blocked",
  );
  const includedEvents = allEvents.filter(
    (event) => event.disposition === "included",
  );
  const aggregates = aggregateEvents(allEvents, minutes, generatedAt);
  const blockedAggregates = aggregateEvents(
    blockedEvents,
    minutes,
    generatedAt,
  );
  const includedAggregates = aggregateEvents(
    includedEvents,
    minutes,
    generatedAt,
    true,
  );

  const weightedCount = (source: DemoRequestEvent[]) =>
    source.reduce((sum, event) => sum + event.sampleWeight, 0);
  const categoryCount = (
    source: DemoRequestEvent[],
    category: DemoRequestCategory,
  ) =>
    source
      .filter((event) => event.category === category)
      .reduce((sum, event) => sum + event.sampleWeight, 0);
  const partitionSummary = (source: DemoRequestEvent[]) => {
    const total = weightedCount(source);
    const latencySamples = source
      .filter(
        (event) =>
          Number.isFinite(event.edgeLatencyMs) &&
          event.edgeLatencyMs !== null &&
          event.edgeLatencyMs >= 0,
      )
      .map((event) => ({
        value: event.edgeLatencyMs as number,
        weight: event.sampleWeight,
      }));
    const latencySampleWeight = latencySamples.reduce(
      (sum, sample) => sum + sample.weight,
      0,
    );
    const latencyWeightedSumMs = latencySamples.reduce(
      (sum, sample) => sum + sample.value * sample.weight,
      0,
    );
    const summary = {
      total,
      normalRequests: categoryCount(source, "normal"),
      suspectedBotRequests: categoryCount(source, "suspected_bot"),
      botRequests: categoryCount(source, "bot"),
      customBlockedRequests: categoryCount(source, "custom_block"),
      includedRequests: weightedCount(
        source.filter((event) => event.disposition === "included"),
      ),
      blockedRequests: weightedCount(
        source.filter((event) => event.disposition === "blocked"),
      ),
      affectedSites: new Set(source.map((event) => event.siteId)).size,
      uniqueAsns: new Set(source.map((event) => event.asn)).size,
      uniqueCountries: new Set(source.map((event) => event.country)).size,
      ratio: 0,
      pageviews: source
        .filter((event) => event.kind === "pageview")
        .reduce((sum, event) => sum + event.sampleWeight, 0),
      customEvents: source
        .filter((event) => event.kind === "custom_event")
        .reduce((sum, event) => sum + event.sampleWeight, 0),
      avgLatencyMs:
        latencySampleWeight > 0
          ? latencyWeightedSumMs / latencySampleWeight
          : null,
      p50LatencyMs: weightedPercentile(latencySamples, 0.5),
      p75LatencyMs: weightedPercentile(latencySamples, 0.75),
      p95LatencyMs: weightedPercentile(latencySamples, 0.95),
      p99LatencyMs: weightedPercentile(latencySamples, 0.99),
    };
    return summary;
  };
  const totalRequests = weightedCount(allEvents);
  const includedRequests = weightedCount(includedEvents);
  const blockedRequests = weightedCount(blockedEvents);
  const summary = {
    total: totalRequests,
    normalRequests: categoryCount(allEvents, "normal"),
    suspectedBotRequests: categoryCount(allEvents, "suspected_bot"),
    botRequests: categoryCount(allEvents, "bot"),
    customBlockedRequests: categoryCount(allEvents, "custom_block"),
    includedRequests,
    blockedRequests,
    affectedSites: new Set(allEvents.map((event) => event.siteId)).size,
    uniqueAsns: new Set(allEvents.map((event) => event.asn)).size,
    uniqueCountries: new Set(allEvents.map((event) => event.country)).size,
  };
  const blockedSummary = partitionSummary(blockedEvents);
  blockedSummary.ratio =
    totalRequests > 0 ? blockedRequests / totalRequests : 0;
  const includedSummary = partitionSummary(includedEvents);
  includedSummary.ratio =
    totalRequests > 0 ? includedRequests / totalRequests : 0;

  return {
    ok: true,
    configured: true,
    generatedAt,
    window: { minutes, from, to: generatedAt },
    sampling: {
      provider: "cloudflare_analytics_engine" as const,
      mode: "automatic" as const,
      observedSampled: allEvents.some((event) => event.sampleWeight > 1),
      aggregatesWeighted: true,
      detailsAreSampled: true,
      distinctAreApproximate: true,
    },
    summary,
    events: blockedEvents,
    normalEvents: normalEvents.sort(
      (left, right) =>
        right.receivedAt - left.receivedAt ||
        left.traceId.localeCompare(right.traceId),
    ),
    blockedEvents,
    includedEvents,
    trend: aggregates.trend,
    reasons: blockedAggregates.reasons,
    countries: blockedAggregates.countries,
    asns: blockedAggregates.asns,
    mapPoints: blockedAggregates.mapPoints,
    overview: {
      totalRequests,
      includedRequests,
      blockedRequests,
      normalRequests: summary.normalRequests,
      suspectedBotRequests: summary.suspectedBotRequests,
      botRequests: summary.botRequests,
      customBlockedRequests: summary.customBlockedRequests,
      botRequestRatio:
        totalRequests > 0 ? summary.botRequests / totalRequests : 0,
      blockedRequestRatio:
        totalRequests > 0 ? blockedRequests / totalRequests : 0,
      normalRequestRatio:
        totalRequests > 0 ? summary.normalRequests / totalRequests : 0,
      pageviews:
        summary.total > 0
          ? aggregates.trend.reduce((sum, point) => sum + point.pageviews, 0)
          : 0,
      customEvents:
        summary.total > 0
          ? aggregates.trend.reduce((sum, point) => sum + point.customEvents, 0)
          : 0,
      avgLatencyMs: includedSummary.avgLatencyMs,
      p50LatencyMs: includedSummary.p50LatencyMs,
      p75LatencyMs: includedSummary.p75LatencyMs,
      p95LatencyMs: includedSummary.p95LatencyMs,
      p99LatencyMs: includedSummary.p99LatencyMs,
    },
    blocked: {
      summary: blockedSummary,
      mapPoints: blockedAggregates.mapPoints,
      events: blockedEvents,
      hasMore: false,
      nextCursor: null,
      reasons: blockedAggregates.reasons,
      countries: blockedAggregates.countries,
      asns: blockedAggregates.asns,
      dimensions: { network: {} },
    },
    included: {
      summary: includedSummary,
      mapPoints: includedAggregates.mapPoints,
      events: includedEvents,
      hasMore: false,
      nextCursor: null,
      dimensions: { network: {} },
    },
  };
}
