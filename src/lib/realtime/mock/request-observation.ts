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

interface DemoBotEvent {
  timestamp: string;
  receivedAt: number;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: string;
  category: "medium_threat" | "high_threat" | "custom_block";
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
  metadataJson: string;
  latitude: number | null;
  longitude: number | null;
  botScore: number | null;
  userAgentLength: number;
}

interface DemoNormalEvent {
  timestamp: string;
  receivedAt: number;
  eventAt: number;
  edgeLatencyMs: number;
  siteId: string;
  siteName: string;
  siteDomain: string;
  kind: DemoNormalEventKind;
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
  rayId: string;
  traceId: string;
  requestMethod: string;
  metadataJson: string;
  latitude: number | null;
  longitude: number | null;
  userAgentLength: number;
}

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
  abnormalCount: number;
  normalCount: number;
  totalCount: number;
  abnormalRatio: number;
  normalRatio: number;
  mediumThreatCount: number;
  highThreatCount: number;
  customBlockedCount: number;
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
  window: {
    minutes: number;
    from: number;
    to: number;
  };
  summary: {
    total: number;
    baselineRequests: number;
    botRequestRatio: number;
    highThreat: number;
    mediumThreat: number;
    customBlocked: number;
    affectedSites: number;
    uniqueAsns: number;
    uniqueCountries: number;
  };
  mapPoints: DemoMapPoint[];
  trend: DemoTrendPoint[];
  reasons: Array<{ reason: string; count: number }>;
  asns: Array<{ asn: number; asOrganization: string; count: number }>;
  events: DemoBotEvent[];
  normalEvents: DemoNormalEvent[];
  overview: {
    totalRequests: number;
    normalRequests: number;
    abnormalRequests: number;
    abnormalRequestRatio: number;
    normalRequestRatio: number;
    pageviews: number;
    customEvents: number;
    avgLatencyMs: number | null;
    p50LatencyMs: number | null;
    p75LatencyMs: number | null;
    p95LatencyMs: number | null;
    p99LatencyMs: number | null;
  };
  abnormal: {
    summary: DemoRequestObservationData["summary"] & {
      total: number;
      ratio: number;
    };
    mapPoints: DemoMapPoint[];
    events: DemoBotEvent[];
    reasons: Array<{ reason: string; count: number }>;
    asns: Array<{ asn: number; asOrganization: string; count: number }>;
  };
  normal: {
    summary: {
      total: number;
      ratio: number;
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
    events: DemoNormalEvent[];
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

const DEMO_ABNORMAL_COUNTRY_WEIGHTS = [
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

function aggregateEvents(
  events: DemoBotEvent[],
  minutes: number,
  generatedAt = Date.now(),
) {
  const from = generatedAt - minutes * 60 * 1000;
  const bucketMs = bucketSizeMs(minutes);
  const coordinatePrecision = mapCoordinatePrecision(minutes);
  const trend = new Map<number, Omit<DemoTrendPoint, "timestampMs">>();
  const reasons = new Map<string, number>();
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
    trend.set(Math.floor(bucket / bucketMs) * bucketMs, {
      count: 0,
      baselineCount: 0,
      botRatio: 0,
      abnormalCount: 0,
      normalCount: 0,
      totalCount: 0,
      abnormalRatio: 0,
      normalRatio: 0,
      mediumThreatCount: 0,
      highThreatCount: 0,
      customBlockedCount: 0,
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
    });
  }

  for (const event of events) {
    const bucket = Math.floor(event.receivedAt / bucketMs) * bucketMs;
    const point = trend.get(bucket) ?? {
      count: 0,
      baselineCount: 0,
      botRatio: 0,
      abnormalCount: 0,
      normalCount: 0,
      totalCount: 0,
      abnormalRatio: 0,
      normalRatio: 0,
      mediumThreatCount: 0,
      highThreatCount: 0,
      customBlockedCount: 0,
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
    };
    point.count += 1;
    point.weightedRequestCount += 1;
    point.abnormalCount += 1;
    if (event.category === "medium_threat") point.mediumThreatCount += 1;
    if (event.category === "high_threat") point.highThreatCount += 1;
    if (event.category === "custom_block") point.customBlockedCount += 1;
    trend.set(bucket, point);

    for (const reason of event.reasons) {
      reasons.set(reason, (reasons.get(reason) || 0) + 1);
    }

    const asn = asns.get(event.asn);
    if (asn) {
      asn.count += 1;
    } else {
      asns.set(event.asn, {
        asn: event.asn,
        asOrganization: event.asOrganization,
        count: 1,
      });
    }

    if (event.latitude !== null && event.longitude !== null) {
      const lat =
        Math.round(event.latitude * coordinatePrecision) / coordinatePrecision;
      const lon =
        Math.round(event.longitude * coordinatePrecision) / coordinatePrecision;
      const key = `${event.country}:${lat}:${lon}`;
      const current = mapPoints.get(key);
      if (current) {
        current.pointCount += 1;
      } else {
        mapPoints.set(key, {
          latitude: lat,
          longitude: lon,
          country: event.country,
          pointCount: 1,
        });
      }
    }
  }

  const sortCounts = <T extends { count: number }>(items: T[]) =>
    items.sort((left, right) => right.count - left.count).slice(0, 10);

  return {
    trend: [...trend.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([timestampMs, point]) => ({ timestampMs, ...point })),
    reasons: sortCounts(
      [...reasons.entries()].map(([reason, count]) => ({ reason, count })),
    ),
    asns: sortCounts([...asns.values()]),
    mapPoints: [...mapPoints.values()],
  };
}

function aggregateNormalEvents(
  events: DemoNormalEvent[],
  minutes: number,
  generatedAt = Date.now(),
) {
  const from = generatedAt - minutes * 60 * 1000;
  const bucketMs = bucketSizeMs(minutes);
  const coordinatePrecision = mapCoordinatePrecision(minutes);
  const trend = new Map<
    number,
    {
      count: number;
      pageviews: number;
      customEvents: number;
      pageviewCount: number;
      leaveCount: number;
      visibilityCount: number;
      customEventCount: number;
      identifyCount: number;
      latencyValues: number[];
    }
  >();
  const mapPoints = new Map<string, DemoMapPoint>();

  for (let bucket = from; bucket <= generatedAt; bucket += bucketMs) {
    trend.set(Math.floor(bucket / bucketMs) * bucketMs, {
      count: 0,
      pageviews: 0,
      customEvents: 0,
      pageviewCount: 0,
      leaveCount: 0,
      visibilityCount: 0,
      customEventCount: 0,
      identifyCount: 0,
      latencyValues: [],
    });
  }

  for (const event of events) {
    const bucket = Math.floor(event.receivedAt / bucketMs) * bucketMs;
    const point = trend.get(bucket) ?? {
      count: 0,
      pageviews: 0,
      customEvents: 0,
      pageviewCount: 0,
      leaveCount: 0,
      visibilityCount: 0,
      customEventCount: 0,
      identifyCount: 0,
      latencyValues: [],
    };
    point.count += 1;
    point[NORMAL_EVENT_COUNT_KEYS[event.kind]] += 1;
    point.pageviews += event.kind === "pageview" ? 1 : 0;
    point.customEvents += event.kind === "custom_event" ? 1 : 0;
    if (Number.isFinite(event.edgeLatencyMs) && event.edgeLatencyMs >= 0) {
      point.latencyValues.push(event.edgeLatencyMs);
    }
    trend.set(bucket, point);

    if (event.latitude !== null && event.longitude !== null) {
      const lat =
        Math.round(event.latitude * coordinatePrecision) / coordinatePrecision;
      const lon =
        Math.round(event.longitude * coordinatePrecision) / coordinatePrecision;
      const key = `${event.country}:${lat}:${lon}`;
      const current = mapPoints.get(key);
      if (current) {
        current.pointCount += 1;
      } else {
        mapPoints.set(key, {
          latitude: lat,
          longitude: lon,
          country: event.country,
          pointCount: 1,
        });
      }
    }
  }

  return {
    trend: [...trend.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([timestampMs, point]) => {
        const sortedLatency = [...point.latencyValues].sort(
          (left, right) => left - right,
        );
        const avgLatencyMs =
          sortedLatency.length > 0
            ? sortedLatency.reduce((sum, value) => sum + value, 0) /
              sortedLatency.length
            : null;
        const p50LatencyMs = percentile(sortedLatency, 0.5);
        const p75LatencyMs = percentile(sortedLatency, 0.75);
        const p95LatencyMs = percentile(sortedLatency, 0.95);
        const p99LatencyMs = percentile(sortedLatency, 0.99);
        return {
          timestampMs,
          count: point.count,
          pageviews: point.pageviews,
          customEvents: point.customEvents,
          pageviewCount: point.pageviewCount,
          leaveCount: point.leaveCount,
          visibilityCount: point.visibilityCount,
          customEventCount: point.customEventCount,
          identifyCount: point.identifyCount,
          weightedRequestCount: point.count,
          latencyWeightedSumMs: sortedLatency.reduce(
            (sum, value) => sum + value,
            0,
          ),
          latencySampleWeight: sortedLatency.length,
          avgLatencyMs,
          p50LatencyMs,
          p75LatencyMs,
          p95LatencyMs,
          p99LatencyMs,
        };
      }),
    mapPoints: [...mapPoints.values()],
  };
}

function percentile(
  sortedValues: number[],
  percentileValue: number,
): number | null {
  if (sortedValues.length === 0) return null;
  return sortedValues[
    Math.min(
      sortedValues.length - 1,
      Math.ceil(sortedValues.length * percentileValue) - 1,
    )
  ];
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
      DEMO_ABNORMAL_COUNTRY_WEIGHTS,
      "US",
    );
    const geo = pickDemoGeoContext(rng, country);
    const asn = weightedPickAsn(rng);
    const reasons = pickReasons(rng);
    const receivedAt =
      generatedAt - Math.floor(Math.pow(rng(), 1.35) * minutes * 60 * 1000);
    const pathname = sPick(rng, site.paths) || "/";
    const userAgent = sPick(rng, BOT_USER_AGENTS);
    const category = reasons.includes("custom_block")
      ? "custom_block"
      : reasons.includes("ua_isbot") ||
          reasons.includes("script_ua") ||
          reasons.includes("cf_bot_score_low")
        ? "high_threat"
        : "medium_threat";
    const rayId = `${sInt(rng, 100000, 999999).toString(16)}${index.toString(16)}demo`;
    const traceId = `demo-bot-${index.toString(36).padStart(4, "0")}`;

    events.push({
      timestamp: new Date(receivedAt).toISOString(),
      receivedAt,
      siteId: site.id,
      siteName: site.name,
      siteDomain: site.domain,
      kind: "collect",
      category,
      reasons,
      ip: randomIpv4(rng),
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
      botScore:
        category === "high_threat" ? sInt(rng, 1, 28) : sInt(rng, 30, 54),
      userAgentLength: userAgent.length,
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
  const baselineRequests = Math.max(
    events.length,
    Math.round((events.length / botRequestRatio) * (1 - botRequestRatio)),
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

    normalEvents.push({
      timestamp: new Date(receivedAt).toISOString(),
      receivedAt,
      eventAt,
      edgeLatencyMs,
      siteId: site.id,
      siteName: site.name,
      siteDomain: site.domain,
      kind,
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
    });
  }

  events.sort(
    (left, right) =>
      right.receivedAt - left.receivedAt ||
      left.traceId.localeCompare(right.traceId),
  );
  normalEvents.sort(
    (left, right) =>
      right.receivedAt - left.receivedAt ||
      left.traceId.localeCompare(right.traceId),
  );

  const aggregates = aggregateEvents(events, minutes, generatedAt);
  const normalAggregates = aggregateNormalEvents(
    normalEvents,
    minutes,
    generatedAt,
  );
  const affectedSites = new Set(events.map((event) => event.siteId));
  const uniqueAsns = new Set(events.map((event) => event.asn));
  const uniqueCountries = new Set(events.map((event) => event.country));
  const normalAffectedSites = new Set(
    normalEvents.map((event) => event.siteId),
  );
  const normalUniqueAsns = new Set(normalEvents.map((event) => event.asn));
  const normalUniqueCountries = new Set(
    normalEvents.map((event) => event.country),
  );
  const normalTrendByBucket = new Map(
    normalAggregates.trend.map((point) => [point.timestampMs, point]),
  );
  const trend = aggregates.trend.map((point) => {
    const normalPoint = normalTrendByBucket.get(point.timestampMs) ?? {
      count: 0,
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
    };
    const normalCount = normalPoint.count;
    const abnormalCount = point.count;
    const totalCount = normalCount + abnormalCount;
    return {
      ...point,
      baselineCount: normalCount,
      normalCount,
      abnormalCount,
      totalCount,
      botRatio: totalCount > 0 ? abnormalCount / totalCount : 0,
      abnormalRatio: totalCount > 0 ? abnormalCount / totalCount : 0,
      normalRatio: totalCount > 0 ? normalCount / totalCount : 0,
      pageviews: normalPoint.pageviews,
      customEvents: normalPoint.customEvents,
      pageviewCount: normalPoint.pageviewCount,
      leaveCount: normalPoint.leaveCount,
      visibilityCount: normalPoint.visibilityCount,
      customEventCount: normalPoint.customEventCount,
      identifyCount: normalPoint.identifyCount,
      weightedRequestCount: totalCount,
      latencyWeightedSumMs: normalPoint.latencyWeightedSumMs,
      latencySampleWeight: normalPoint.latencySampleWeight,
      avgLatencyMs: normalPoint.avgLatencyMs,
      p50LatencyMs: normalPoint.p50LatencyMs ?? normalPoint.avgLatencyMs,
      p75LatencyMs: normalPoint.p75LatencyMs ?? normalPoint.p95LatencyMs,
      p95LatencyMs: normalPoint.p95LatencyMs,
      p99LatencyMs: normalPoint.p99LatencyMs ?? normalPoint.p95LatencyMs,
    };
  });
  const pageviews = normalEvents.filter(
    (event) => event.kind === "pageview",
  ).length;
  const customEvents = normalEvents.filter(
    (event) => event.kind === "custom_event",
  ).length;
  const latencyValues = normalEvents
    .map((event) => event.edgeLatencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  const avgLatencyMs =
    latencyValues.length > 0
      ? latencyValues.reduce((sum, value) => sum + value, 0) /
        latencyValues.length
      : null;
  const p50LatencyMs = percentile(latencyValues, 0.5);
  const p75LatencyMs = percentile(latencyValues, 0.75);
  const p95LatencyMs = percentile(latencyValues, 0.95);
  const p99LatencyMs = percentile(latencyValues, 0.99);
  const totalRequests = baselineRequests + events.length;
  const abnormalRequestRatio =
    totalRequests > 0 ? events.length / totalRequests : 0;
  const normalRequestRatio =
    totalRequests > 0 ? baselineRequests / totalRequests : 0;
  const summary = {
    total: events.length,
    baselineRequests,
    botRequestRatio: abnormalRequestRatio,
    highThreat: events.filter((event) => event.category === "high_threat")
      .length,
    mediumThreat: events.filter((event) => event.category === "medium_threat")
      .length,
    customBlocked: events.filter((event) => event.category === "custom_block")
      .length,
    affectedSites: affectedSites.size,
    uniqueAsns: uniqueAsns.size,
    uniqueCountries: uniqueCountries.size,
  };
  const normalSummary = {
    total: baselineRequests,
    ratio: normalRequestRatio,
    pageviews,
    customEvents,
    affectedSites: normalAffectedSites.size,
    uniqueAsns: normalUniqueAsns.size,
    uniqueCountries: normalUniqueCountries.size,
    avgLatencyMs,
    p50LatencyMs,
    p75LatencyMs,
    p95LatencyMs,
    p99LatencyMs,
  };

  return {
    ok: true,
    configured: true,
    generatedAt,
    window: {
      minutes,
      from,
      to: generatedAt,
    },
    summary,
    events,
    normalEvents,
    trend,
    reasons: aggregates.reasons,
    asns: aggregates.asns,
    mapPoints: aggregates.mapPoints,
    overview: {
      totalRequests,
      normalRequests: baselineRequests,
      abnormalRequests: events.length,
      abnormalRequestRatio,
      normalRequestRatio,
      pageviews,
      customEvents,
      avgLatencyMs,
      p50LatencyMs,
      p75LatencyMs,
      p95LatencyMs,
      p99LatencyMs,
    },
    abnormal: {
      summary: {
        ...summary,
        total: events.length,
        ratio: abnormalRequestRatio,
      },
      mapPoints: aggregates.mapPoints,
      events,
      reasons: aggregates.reasons,
      asns: aggregates.asns,
    },
    normal: {
      summary: normalSummary,
      mapPoints: normalAggregates.mapPoints,
      events: normalEvents.slice(0, 500),
    },
  };
}
