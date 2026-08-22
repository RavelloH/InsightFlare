import {
  type DemoSiteProfile,
  findSiteProfile,
} from "@/lib/realtime/demo-site-profiles";
import {
  createDemoRng,
  expandPathLabels,
  normalizePath,
  sInt,
  sShuffle,
  titleFromPath,
  todayKey,
  windowBucket,
} from "@/lib/realtime/demo-utils";
import {
  buildCountryPool,
  buildReferrerPool,
  pickFromList,
  pickReferrerByCountry,
  weightedPickIndex,
} from "@/lib/realtime/mock/dimension-pickers";
import {
  buildPathTransitionGraph,
  nextPath,
} from "@/lib/realtime/mock/path-markov";
import {
  computeMetrics,
  createTimestampCurveSampler,
  siteRatios,
} from "@/lib/realtime/mock/site-curves";
import type {
  DemoFactDataset,
  DemoSessionFact,
  DemoVisitFact,
  DemoVisitorFact,
} from "@/lib/realtime/mock/types";
import {
  getVisitorFingerprint,
  sampleActiveVisitors,
} from "@/lib/realtime/mock/visitor-pool";

export const DEMO_FACT_DATASET_CACHE = new Map<string, DemoFactDataset>();

const DEMO_DAY_MS = 86_400_000;
const MIN_SAMPLED_VIEWS = 320;
const MAX_SAMPLED_VIEWS = 12_000;
const LONG_WINDOW_START_DAYS = 30;
const LONG_WINDOW_MIN_CAP = 4_000;
const LONG_WINDOW_CAP_POWER = 1;

interface DemoUtmAttribution {
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
}

const EMPTY_DEMO_UTM: DemoUtmAttribution = {
  utmSource: "",
  utmMedium: "",
  utmCampaign: "",
};

/**
 * Keep demo traffic varied enough for the channel table to exercise every
 * bucket. The empty slots intentionally preserve the profile's organic,
 * social, referral, and direct referrer mix.
 */
function demoUtmAttributionForSession(
  sessionIndex: number,
): DemoUtmAttribution {
  switch (sessionIndex % 13) {
    case 6:
      return {
        utmSource: "google",
        utmMedium: "cpc",
        utmCampaign: "brand-search",
      };
    case 7:
      return {
        utmSource: "meta",
        utmMedium: "paid-social",
        utmCampaign: "summer-social",
      };
    case 8:
      return {
        utmSource: "ad-network",
        utmMedium: "display",
        utmCampaign: "awareness",
      };
    case 9:
      return {
        utmSource: "newsletter",
        utmMedium: "email",
        utmCampaign: "product-update",
      };
    case 10:
      return {
        utmSource: "partner-network",
        utmMedium: "affiliate",
        utmCampaign: "launch-partners",
      };
    case 11:
      return {
        utmSource: "marketing",
        utmMedium: "campaign",
        utmCampaign: "spring-launch",
      };
    case 12:
      return {
        utmSource: "unknown-source",
        utmMedium: "unknown",
        utmCampaign: "",
      };
    default:
      return EMPTY_DEMO_UTM;
  }
}

function sampledViewsCapForWindow(from: number, to: number): number {
  const windowDays = Math.max(1, (to - from) / DEMO_DAY_MS);
  if (windowDays <= LONG_WINDOW_START_DAYS) return MAX_SAMPLED_VIEWS;

  return Math.max(
    LONG_WINDOW_MIN_CAP,
    Math.min(
      MAX_SAMPLED_VIEWS,
      Math.round(
        MAX_SAMPLED_VIEWS *
          Math.pow(LONG_WINDOW_START_DAYS / windowDays, LONG_WINDOW_CAP_POWER),
      ),
    ),
  );
}

export function buildDemoPathTitleMap(
  profile: DemoSiteProfile,
  expandedPaths: string[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (let index = 0; index < profile.paths.length; index += 1) {
    const path = normalizePath(profile.paths[index] || "");
    if (!path) continue;
    const title = String(profile.titles[index] || "").trim();
    map.set(path, title || titleFromPath(path));
  }
  for (const path of expandedPaths) {
    if (!map.has(path)) {
      map.set(path, titleFromPath(path));
    }
  }
  return map;
}

export function emptyDemoFactDataset(
  from: number,
  to: number,
): DemoFactDataset {
  return {
    from,
    to,
    viewWeight: 1,
    visits: [],
    sessions: new Map<string, DemoSessionFact>(),
    visitors: new Map<string, DemoVisitorFact>(),
  };
}

export function buildDemoFactDataset(
  siteId: string,
  from: number,
  to: number,
): DemoFactDataset {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return emptyDemoFactDataset(from, to);
  }

  const day = todayKey();
  const bucket = windowBucket(from, to);
  const cacheKey = `${day}:${siteId}:${bucket}`;
  const cached = DEMO_FACT_DATASET_CACHE.get(cacheKey);
  if (cached) return cached;

  const profile = findSiteProfile(siteId);
  const metrics = computeMetrics(siteId, from, to);
  if (metrics.views <= 0) {
    const empty = emptyDemoFactDataset(from, to);
    DEMO_FACT_DATASET_CACHE.set(cacheKey, empty);
    return empty;
  }

  const rng = createDemoRng(siteId, `facts:${bucket}`);
  const sampledViewsCap = sampledViewsCapForWindow(from, to);
  const sampledViewsTarget = Math.max(
    MIN_SAMPLED_VIEWS,
    Math.min(sampledViewsCap, Math.round(Math.sqrt(metrics.views + 1) * 46)),
  );
  const sampledViews = Math.max(1, Math.min(metrics.views, sampledViewsTarget));
  const sampledSessionsRaw = Math.round(
    (metrics.sessions / Math.max(metrics.views, 1)) * sampledViews,
  );
  const sampledSessions = Math.max(
    1,
    Math.min(sampledViews, sampledSessionsRaw),
  );
  const sampledVisitorsRaw = Math.round(
    (metrics.visitors / Math.max(metrics.sessions, 1)) * sampledSessions,
  );
  const sampledVisitors = Math.max(
    1,
    Math.min(sampledSessions, sampledVisitorsRaw),
  );

  const viewWeight = metrics.views / sampledViews;
  const sessionWeight = metrics.sessions / sampledSessions;
  const visitorWeight = metrics.visitors / sampledVisitors;

  let sampledBounces = Math.max(
    0,
    Math.min(
      sampledSessions,
      Math.round(metrics.bounces / Math.max(sessionWeight, Number.EPSILON)),
    ),
  );
  const availableIncrements = sampledViews - sampledSessions;
  const requiredIncrementsForNonBounce = sampledSessions - sampledBounces;
  if (requiredIncrementsForNonBounce > availableIncrements) {
    sampledBounces = sampledSessions - availableIncrements;
  }

  const sessionViewCounts = new Array(sampledSessions).fill(1);
  const sessionIndexes = sShuffle(
    rng,
    Array.from({ length: sampledSessions }, (_, index) => index),
  );
  const nonBounceIndexes = sessionIndexes.slice(
    0,
    Math.max(0, sampledSessions - sampledBounces),
  );
  for (const sessionIndex of nonBounceIndexes) {
    sessionViewCounts[sessionIndex] += 1;
  }
  let remaining = sampledViews - sampledSessions - nonBounceIndexes.length;
  while (remaining > 0) {
    const pool =
      nonBounceIndexes.length > 0 ? nonBounceIndexes : sessionIndexes;
    const pickIndex =
      pool[Math.floor(Math.pow(rng(), 1.25) * pool.length)] ?? pool[0] ?? 0;
    sessionViewCounts[pickIndex] += 1;
    remaining -= 1;
  }

  // countryPool / referrerPool — referrer 仍按站点池采样,country 改由 visitor
  // fingerprint 决定。countryPool 暂时保留以避免改变 rng 流(后续可清理)。
  buildCountryPool(
    rng,
    profile.topCountries,
    Math.min(36, Math.max(18, profile.topCountries.length + 14)),
  );
  const referrerPool = buildReferrerPool(
    rng,
    profile.topReferrers,
    Math.min(36, Math.max(16, profile.topReferrers.length + 12)),
  );

  const expandedPaths = expandPathLabels(
    rng,
    profile.paths,
    Math.max(28, Math.min(180, profile.paths.length * 6)),
  );
  const pathWeights = expandedPaths.map((_, index) => 1 / (1 + index * 0.85));
  const pathTitleMap = buildDemoPathTitleMap(profile, expandedPaths);
  // C2 方案 — 一阶马尔可夫路径转移图,从 profile.paths 顺序推断,
  // 或由 profile.pathFlow 显式定义。会话内的连续 pageview 服从该图。
  const pathGraph = buildPathTransitionGraph(profile, expandedPaths);
  const eventPool = ["pageview", ...profile.eventNames];
  const fallbackAvgDuration = Math.max(
    4_000,
    Math.round(siteRatios(siteId).avgDurationMs),
  );

  const visitorIds = sampleActiveVisitors(siteId, from, to, sampledVisitors);
  const visitorOrder = sShuffle(rng, [...visitorIds]);
  const visitors = new Map<string, DemoVisitorFact>();
  for (const visitorId of visitorIds) {
    visitors.set(visitorId, { visitorId, weight: visitorWeight });
  }

  const sessions = new Map<string, DemoSessionFact>();
  const visits: DemoVisitFact[] = [];
  const sampleTimestamp = createTimestampCurveSampler(siteId, from, to);

  for (
    let sessionIndex = 0;
    sessionIndex < sampledSessions;
    sessionIndex += 1
  ) {
    const viewCount = Math.max(1, sessionViewCounts[sessionIndex] ?? 1);
    const sessionId = `${siteId}-s-${sessionIndex.toString(36).padStart(5, "0")}`;
    const visitorId =
      visitorOrder[sessionIndex % visitorOrder.length] ??
      visitorOrder[0] ??
      `${siteId}-v-0`;
    // B方案 — 跨日稳定的 visitor 指纹:同一 visitorId 永远是同一份 DNA。
    const fingerprint = getVisitorFingerprint(siteId, visitorId);
    const country = fingerprint.country;
    const geo = {
      regionCode: fingerprint.regionCode,
      regionName: fingerprint.regionName,
      region: fingerprint.region,
      cityName: fingerprint.cityName,
      city: fingerprint.city,
      continent: fingerprint.continent,
      timezone: fingerprint.timezone,
      organization: fingerprint.organization,
      latitude: fingerprint.latitude,
      longitude: fingerprint.longitude,
    };
    const deviceType = fingerprint.deviceType;
    const browser = fingerprint.browser;
    const browserVersion = fingerprint.browserVersion;
    const osVersion = fingerprint.osVersion;
    const language = fingerprint.language;
    const screenSize = fingerprint.screenSize;

    // C3 方案 — referrer 受访客国别弱影响(CN→baidu/qq, RU→yandex 等)。
    const selectedReferrer = pickReferrerByCountry(
      rng,
      referrerPool,
      country,
      "(direct)",
    );
    const isDirect = selectedReferrer === "(direct)";
    const referrerHost = isDirect ? "" : selectedReferrer.toLowerCase();
    const keyword = encodeURIComponent(
      titleFromPath(pickFromList(rng, expandedPaths, "/"))
        .toLowerCase()
        .replace(/\s+/g, "-"),
    );
    const referrerUrl = isDirect
      ? ""
      : `https://${referrerHost}/${pickFromList(rng, ["search", "r", "ref", "posts", "share"], "search")}/${keyword}`;
    const utm = demoUtmAttributionForSession(sessionIndex);

    // C1 方案 — 反 CDF 时间采样,会话起点按昼夜曲线分布。
    let cursor = sampleTimestamp(rng);
    let previousPath = "";
    let entryPath = "/";
    let exitPath = "/";
    const avgSessionDuration =
      metrics.avgDurationMs > 0 ? metrics.avgDurationMs : fallbackAvgDuration;
    const sessionDuration = Math.max(
      1200,
      Math.round(avgSessionDuration * (0.56 + rng() * 1.24)),
    );

    for (let visitIndex = 0; visitIndex < viewCount; visitIndex += 1) {
      let pathname: string;
      if (visitIndex === 0) {
        // 入口仍按 pathWeights 加权挑选,保留多样化的 entry pages。
        const pathIndex = weightedPickIndex(rng, pathWeights);
        pathname = expandedPaths[pathIndex] ?? expandedPaths[0] ?? "/";
      } else {
        // 后续 pageview 按一阶马尔可夫从上一页转移。
        pathname = nextPath(pathGraph, previousPath, rng);
      }
      const title = pathTitleMap.get(pathname) ?? titleFromPath(pathname);
      const increment =
        visitIndex === 0 ? sInt(rng, 0, 12_000) : sInt(rng, 8_000, 160_000);
      cursor = Math.min(to - 1, Math.max(from, cursor + increment));
      previousPath = pathname;
      if (visitIndex === 0) entryPath = pathname;
      exitPath = pathname;

      const eventType =
        visitIndex === 0 || rng() < 0.7
          ? eventPool[0]
          : pickFromList(rng, eventPool.slice(1), eventPool[0]);
      const durationMs = Math.max(
        0,
        Math.round((sessionDuration / viewCount) * (0.74 + rng() * 0.62)),
      );

      visits.push({
        visitId: `${sessionId}-v-${visitIndex.toString(36).padStart(3, "0")}`,
        sessionId,
        visitorId,
        startedAt: cursor,
        pathname,
        title,
        hostname: profile.domain,
        referrerHost,
        referrerUrl,
        utmSource: utm.utmSource,
        utmMedium: utm.utmMedium,
        utmCampaign: utm.utmCampaign,
        browser,
        browserVersion,
        osVersion,
        deviceType,
        language,
        screenSize,
        country,
        regionCode: geo.regionCode,
        regionName: geo.regionName,
        region: geo.region,
        cityName: geo.cityName,
        city: geo.city,
        continent: geo.continent,
        timezone: geo.timezone,
        organization: geo.organization,
        latitude: geo.latitude,
        longitude: geo.longitude,
        eventType,
        durationMs,
      });
    }

    sessions.set(sessionId, {
      sessionId,
      visitorId,
      entryPath,
      exitPath,
      weight: sessionWeight,
    });
  }

  visits.sort(
    (left, right) =>
      left.startedAt - right.startedAt ||
      left.visitId.localeCompare(right.visitId),
  );

  const weightedDuration = visits.reduce(
    (sum, visit) => sum + visit.durationMs * viewWeight,
    0,
  );
  if (metrics.totalDurationMs > 0 && weightedDuration > 0) {
    const scale = metrics.totalDurationMs / weightedDuration;
    for (const visit of visits) {
      visit.durationMs = Math.max(0, Math.round(visit.durationMs * scale));
    }
  }

  const dataset: DemoFactDataset = {
    from,
    to,
    viewWeight,
    visits,
    sessions,
    visitors,
  };
  if (DEMO_FACT_DATASET_CACHE.size > 140) DEMO_FACT_DATASET_CACHE.clear();
  DEMO_FACT_DATASET_CACHE.set(cacheKey, dataset);
  return dataset;
}
