import { DEMO_SITE_PROFILES } from "@/lib/demo/data/site-profiles";
import {
  createDemoRng,
  sInt,
  sPick,
  windowBucket,
} from "@/lib/demo/generators/utils";
import { pickDemoGeoContext } from "@/lib/demo/realtime/dimension-pickers";
type WindowMinutes = 60 | 1440 | 10080 | 43200;
interface PreparedWeightedLabels {
  entries: Array<{ label: string; weight: number }>;
  totalWeight: number;
}
function prepareWeightedLabels(
  entries: readonly { label: string; weight: number }[],
): PreparedWeightedLabels {
  const normalized: PreparedWeightedLabels["entries"] = [];
  let totalWeight = 0;
  for (const item of entries) {
    const label = String(item.label || "").trim();
    const weight = Math.max(0, Number(item.weight) || 0);
    if (!label || weight <= 0) continue;
    normalized.push({ label, weight });
    totalWeight += weight;
  }
  return { entries: normalized, totalWeight };
}
function pickPreparedWeightedLabel(
  rng: () => number,
  prepared: PreparedWeightedLabels,
  fallback: string,
): string {
  if (prepared.entries.length === 0 || prepared.totalWeight <= 0)
    return fallback;
  let hit = rng() * prepared.totalWeight;
  for (const item of prepared.entries) {
    hit -= item.weight;
    if (hit <= 0) return item.label;
  }
  return prepared.entries[prepared.entries.length - 1]?.label || fallback;
}
type DemoNormalEventKind =
  "pageview" | "leave" | "visibility" | "custom_event" | "identify";
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
const BOT_REASON_PICKER = prepareWeightedLabels(BOT_REASON_WEIGHTS);
const CUSTOM_BLOCK_REASON_PICKER = prepareWeightedLabels(
  CUSTOM_BLOCK_REASON_WEIGHTS,
);
const NORMAL_EVENT_KIND_PICKER = prepareWeightedLabels(
  NORMAL_EVENT_KIND_WEIGHTS,
);
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
const BOT_ASN_TOTAL_WEIGHT = BOT_ASNS.reduce(
  (sum, item) => sum + item.weight,
  0,
);
const NORMAL_ASN_TOTAL_WEIGHT = NORMAL_ASNS.reduce(
  (sum, item) => sum + item.weight,
  0,
);
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
  const total = BOT_ASN_TOTAL_WEIGHT;
  let hit = rng() * total;
  for (const item of BOT_ASNS) {
    hit -= item.weight;
    if (hit <= 0) return item;
  }
  return BOT_ASNS[0];
}
function weightedPickNormalAsn(rng: () => number) {
  const total = NORMAL_ASN_TOTAL_WEIGHT;
  let hit = rng() * total;
  for (const item of NORMAL_ASNS) {
    hit -= item.weight;
    if (hit <= 0) return item;
  }
  return NORMAL_ASNS[0];
}
const TRAFFIC_COUNTRY_PICKER_CACHE = new WeakMap<
  object,
  Map<object, PreparedWeightedLabels>
>();
function pickDemoTrafficCountry(
  rng: () => number,
  profileCountries: Array<{ code: string; weight: number }>,
  trafficWeights: readonly { label: string; weight: number }[],
  fallback: string,
): string {
  let pickers = TRAFFIC_COUNTRY_PICKER_CACHE.get(profileCountries);
  if (!pickers) {
    pickers = new Map();
    TRAFFIC_COUNTRY_PICKER_CACHE.set(profileCountries, pickers);
  }
  let prepared = pickers.get(trafficWeights);
  if (!prepared) {
    const profileWeightByCountry = new Map(
      profileCountries.map((item) => [
        item.code.trim().toUpperCase(),
        Math.max(0, item.weight),
      ]),
    );
    prepared = prepareWeightedLabels(
      trafficWeights.map((item) => ({
        label: item.label,
        weight:
          item.weight *
          (0.75 + (profileWeightByCountry.get(item.label) ?? 0) / 100),
      })),
    );
    pickers.set(trafficWeights, prepared);
  }
  return pickPreparedWeightedLabel(rng, prepared, fallback);
}
function pickReasons(rng: () => number): string[] {
  if (rng() < 0.16) {
    const reasons = new Set([
      "custom_block",
      pickPreparedWeightedLabel(
        rng,
        CUSTOM_BLOCK_REASON_PICKER,
        "blocked_paths",
      ),
    ]);
    if (rng() < 0.18) {
      reasons.add(
        pickPreparedWeightedLabel(
          rng,
          CUSTOM_BLOCK_REASON_PICKER,
          "blocked_domains",
        ),
      );
    }
    return [...reasons];
  }

  const first = pickPreparedWeightedLabel(rng, BOT_REASON_PICKER, "ua_isbot");
  const reasons = new Set([first]);
  if (rng() < 0.42) {
    reasons.add(
      pickPreparedWeightedLabel(rng, BOT_REASON_PICKER, "hosting_asn"),
    );
  }
  if (rng() < 0.14) {
    reasons.add(
      pickPreparedWeightedLabel(
        rng,
        BOT_REASON_PICKER,
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
function weightedPercentiles(
  samples: Array<{ value: number; weight: number }>,
): [number | null, number | null, number | null, number | null] {
  if (samples.length === 0) return [null, null, null, null];
  const sorted = [...samples].sort((left, right) => left.value - right.value);
  let totalWeight = 0;
  for (const sample of sorted) totalWeight += sample.weight;
  if (totalWeight <= 0) return [null, null, null, null];
  const targets = [0.5, 0.75, 0.95, 0.99].map((p) =>
    Math.max(1, Math.ceil(totalWeight * p)),
  );
  const values: [number | null, number | null, number | null, number | null] = [
    null,
    null,
    null,
    null,
  ];
  let accumulatedWeight = 0;
  let targetIndex = 0;
  for (const sample of sorted) {
    accumulatedWeight += sample.weight;
    while (
      targetIndex < targets.length &&
      accumulatedWeight >= (targets[targetIndex] ?? Number.POSITIVE_INFINITY)
    ) {
      values[targetIndex] = sample.value;
      targetIndex += 1;
    }
    if (targetIndex === targets.length) break;
  }
  const fallback = sorted[sorted.length - 1]?.value ?? null;
  while (targetIndex < values.length) {
    values[targetIndex] = fallback;
    targetIndex += 1;
  }
  return values;
}
function aggregateEvents(
  events: DemoRequestEvent[],
  minutes: number,
  generatedAt = Date.now(),
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
  const includedMapPoints = new Map(mapPoints);

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
    if (event.latitude !== null && event.longitude !== null) {
      const lat =
        Math.round(event.latitude * coordinatePrecision) / coordinatePrecision;
      const lon =
        Math.round(event.longitude * coordinatePrecision) / coordinatePrecision;
      const key = `${event.country}:${lat}:${lon}`;
      const targetMap =
        event.disposition === "blocked" ? mapPoints : includedMapPoints;
      const current = targetMap.get(key);
      if (current) {
        current.pointCount += weight;
      } else {
        targetMap.set(key, {
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
        const [p50LatencyMs, p75LatencyMs, p95LatencyMs, p99LatencyMs] =
          weightedPercentiles(point.latencySamples);
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
          p50LatencyMs,
          p75LatencyMs,
          p95LatencyMs,
          p99LatencyMs,
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
    includedMapPoints: [...includedMapPoints.values()],
  };
}
export function generateDemoRequestObservationData(
  minutes: WindowMinutes,
  generatedAt = Date.now(),
  options: { includeMetadataJson?: boolean } = {},
): DemoRequestObservationData {
  const includeMetadataJson = options.includeMetadataJson !== false;
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
    const ip = category === "bot" ? randomIpv4(rng) : "";
    const colo = sPick(rng, COLOS);
    const verifiedBotCategory = userAgent.toLowerCase().includes("bot")
      ? sPick(rng, ["Search Engine Crawler", "Monitoring", "SEO"])
      : "";
    const clientTcpRtt = sInt(rng, 12, 96);

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
      ip,
      userAgent,
      origin: `https://${site.domain}`,
      hostname: site.domain,
      pathname,
      country,
      region: geo.regionName || geo.region,
      city: geo.cityName || geo.city,
      continent: geo.continent,
      colo,
      asn: asn.asn,
      asOrganization: asn.organization,
      verifiedBotCategory,
      rayId,
      traceId,
      requestMethod: "POST",
      httpProtocol: "h2",
      metadataJson: includeMetadataJson
        ? JSON.stringify({
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
            clientTcpRtt,
            eventId: `demo-event-${index.toString(36).padStart(5, "0")}`,
            previousVisitId:
              index % 4 === 0
                ? `demo-previous-visit-${(index % 12).toString(36).padStart(3, "0")}`
                : "",
          })
        : "",
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
        : pickPreparedWeightedLabel(rng, NORMAL_EVENT_KIND_PICKER, "pageview")
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
      metadataJson: includeMetadataJson
        ? JSON.stringify({
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
          })
        : "",
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
  // Reuse the existing normal-event array; allEvents already contains the same stable order.
  normalEvents.length = 0;
  for (const event of allEvents) {
    if (event.category === "normal") normalEvents.push(event);
  }
  const blockedEvents = allEvents.filter(
    (event) => event.disposition === "blocked",
  );
  const includedEvents = allEvents.filter(
    (event) => event.disposition === "included",
  );
  const aggregates = aggregateEvents(allEvents, minutes, generatedAt);

  let observedSampled = false;
  const summarizeEvents = (
    source: DemoRequestEvent[],
    includeLatency = false,
    detectSampled = false,
  ) => {
    let total = 0;
    let normalRequests = 0;
    let suspectedBotRequests = 0;
    let botRequests = 0;
    let customBlockedRequests = 0;
    let includedRequests = 0;
    let blockedRequests = 0;
    let pageviews = 0;
    let customEvents = 0;
    let latencySampleWeight = 0;
    let latencyWeightedSumMs = 0;
    const sites = new Set<string>();
    const uniqueAsns = new Set<number>();
    const uniqueCountries = new Set<string>();
    const latencySamples: Array<{ value: number; weight: number }> = [];

    for (const event of source) {
      const weight = event.sampleWeight;
      total += weight;
      if (detectSampled && weight > 1) observedSampled = true;
      if (event.category === "normal") normalRequests += weight;
      else if (event.category === "suspected_bot")
        suspectedBotRequests += weight;
      else if (event.category === "bot") botRequests += weight;
      else if (event.category === "custom_block")
        customBlockedRequests += weight;
      if (event.disposition === "included") includedRequests += weight;
      else blockedRequests += weight;
      if (event.kind === "pageview") pageviews += weight;
      if (event.kind === "custom_event") customEvents += weight;
      sites.add(event.siteId);
      uniqueAsns.add(event.asn);
      uniqueCountries.add(event.country);
      if (
        includeLatency &&
        Number.isFinite(event.edgeLatencyMs) &&
        event.edgeLatencyMs !== null &&
        event.edgeLatencyMs >= 0
      ) {
        latencySamples.push({ value: event.edgeLatencyMs, weight });
        latencySampleWeight += weight;
        latencyWeightedSumMs += event.edgeLatencyMs * weight;
      }
    }

    const [p50LatencyMs, p75LatencyMs, p95LatencyMs, p99LatencyMs] =
      includeLatency
        ? weightedPercentiles(latencySamples)
        : [null, null, null, null];
    return {
      total,
      normalRequests,
      suspectedBotRequests,
      botRequests,
      customBlockedRequests,
      includedRequests,
      blockedRequests,
      affectedSites: sites.size,
      uniqueAsns: uniqueAsns.size,
      uniqueCountries: uniqueCountries.size,
      ratio: 0,
      pageviews,
      customEvents,
      avgLatencyMs:
        latencySampleWeight > 0
          ? latencyWeightedSumMs / latencySampleWeight
          : null,
      p50LatencyMs,
      p75LatencyMs,
      p95LatencyMs,
      p99LatencyMs,
    };
  };
  const summaryStats = summarizeEvents(allEvents, false, true);
  const blockedSummary = summarizeEvents(blockedEvents);
  const includedSummary = summarizeEvents(includedEvents, true);
  const totalRequests = summaryStats.total;
  const includedRequests = includedSummary.total;
  const blockedRequests = blockedSummary.total;
  const summary = {
    total: summaryStats.total,
    normalRequests: summaryStats.normalRequests,
    suspectedBotRequests: summaryStats.suspectedBotRequests,
    botRequests: summaryStats.botRequests,
    customBlockedRequests: summaryStats.customBlockedRequests,
    includedRequests,
    blockedRequests,
    affectedSites: summaryStats.affectedSites,
    uniqueAsns: summaryStats.uniqueAsns,
    uniqueCountries: summaryStats.uniqueCountries,
  };
  blockedSummary.ratio =
    totalRequests > 0 ? blockedRequests / totalRequests : 0;
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
      observedSampled,
      aggregatesWeighted: true,
      detailsAreSampled: true,
      distinctAreApproximate: true,
    },
    summary,
    events: blockedEvents,
    normalEvents,
    blockedEvents,
    includedEvents,
    trend: aggregates.trend,
    reasons: aggregates.reasons,
    countries: aggregates.countries,
    asns: aggregates.asns,
    mapPoints: aggregates.mapPoints,
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
      mapPoints: aggregates.mapPoints,
      events: blockedEvents,
      hasMore: false,
      nextCursor: null,
      reasons: aggregates.reasons,
      countries: aggregates.countries,
      asns: aggregates.asns,
      dimensions: { network: {} },
    },
    included: {
      summary: includedSummary,
      mapPoints: aggregates.includedMapPoints,
      events: includedEvents,
      hasMore: false,
      nextCursor: null,
      dimensions: { network: {} },
    },
  };
}
