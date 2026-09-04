// ---------------------------------------------------------------------------
//  Dimension pickers — RNG-driven selection over dimension pools
//
//  Pure functions that, given an RNG and the relevant pool/context, return
//  one dimension value (browser / OS / language / timezone / country / geo …).
//  Used by the fact builder, realtime socket, and various overview handlers.
// ---------------------------------------------------------------------------

import type { DemoSiteProfile } from "@/lib/realtime/demo-site-profiles";
import {
  fnv1a,
  sInt,
  sShuffle,
  weightedPickLabel,
} from "@/lib/realtime/demo-utils";
import {
  ALL_CITIES,
  ALL_CONTINENTS,
  ALL_LANGUAGES,
  ALL_ORGS,
  ALL_REGIONS,
  ALL_TIMEZONES,
  BROWSER_MARKET_WEIGHTS,
  COUNTRY_COORDINATE_ANCHORS,
  COUNTRY_GEO_CLUSTERS,
  DEMO_COUNTRY_TO_CONTINENT,
  DEMO_COUNTRY_TO_LANGUAGES,
  DEMO_COUNTRY_TO_TIMEZONES,
  DEMO_DESKTOP_OS,
  DEMO_DESKTOP_SCREENS,
  DEMO_GEO_SEGMENT_SEPARATOR,
  DEMO_MOBILE_OS,
  DEMO_MOBILE_SCREENS,
  DEMO_TABLET_SCREENS,
  type GeoCluster,
  GLOBAL_COUNTRY_LONG_TAIL,
  GLOBAL_REFERRER_LONG_TAIL,
} from "@/lib/realtime/mock/dimension-pools";

export function pickFromList<T>(
  rng: () => number,
  values: readonly T[],
  fallback: T,
): T {
  if (!values.length) return fallback;
  return values[Math.floor(rng() * values.length)] ?? fallback;
}

export function normalizeLongitude(longitude: number): number {
  if (!Number.isFinite(longitude)) return 0;
  let value = longitude;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

export function weightedPickIndex(
  rng: () => number,
  weights: number[],
): number {
  if (weights.length === 0) return 0;
  const safeWeights = weights.map((weight) => Math.max(0, Number(weight) || 0));
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) return 0;
  let hit = rng() * totalWeight;
  for (let index = 0; index < safeWeights.length; index += 1) {
    hit -= safeWeights[index] ?? 0;
    if (hit <= 0) return index;
  }
  return safeWeights.length - 1;
}

export function randomGaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  const v = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pickCountryGeoCluster(
  rng: () => number,
  countryCode: string,
): GeoCluster {
  const clusters = COUNTRY_GEO_CLUSTERS[countryCode];
  if (!clusters || clusters.length === 0) {
    const anchor = COUNTRY_COORDINATE_ANCHORS[countryCode] ?? {
      latitude: 20,
      longitude: 0,
    };
    return {
      latitude: anchor.latitude,
      longitude: anchor.longitude,
      weight: 1,
      spreadKm: 170,
    };
  }
  const index = weightedPickIndex(
    rng,
    clusters.map((cluster) => cluster.weight),
  );
  return clusters[index] ?? clusters[0];
}

export function sampleGeoPointByCountry(
  rng: () => number,
  countryCode: string,
): { latitude: number; longitude: number } {
  const cluster = pickCountryGeoCluster(rng, countryCode);
  const outskirtsBoost = rng() < 0.08 ? 1.8 + rng() * 1.8 : 1;
  const spreadKm = cluster.spreadKm * outskirtsBoost;
  const latSigma = spreadKm / 111;
  const cosLat = Math.max(0.22, Math.cos((cluster.latitude * Math.PI) / 180));
  const lonSigma = spreadKm / (111 * cosLat);
  const latitude = Math.max(
    -85,
    Math.min(85, cluster.latitude + randomGaussian(rng) * latSigma),
  );
  const longitude = normalizeLongitude(
    cluster.longitude + randomGaussian(rng) * lonSigma,
  );
  return {
    latitude: Number(latitude.toFixed(5)),
    longitude: Number(longitude.toFixed(5)),
  };
}

export function weightedPickCountry(
  rng: () => number,
  countries: Array<{ code: string; weight: number }>,
): string {
  const totalWeight = countries.reduce(
    (sum, item) => sum + Math.max(0, item.weight),
    0,
  );
  if (totalWeight <= 0 || countries.length === 0) return "US";
  let hit = rng() * totalWeight;
  for (const item of countries) {
    const weight = Math.max(0, item.weight);
    hit -= weight;
    if (hit <= 0) return item.code;
  }
  return countries[countries.length - 1]?.code || "US";
}

export function buildCountryPool(
  rng: () => number,
  baseCountries: Array<{ code: string; weight: number }>,
  targetCount: number,
): Array<{ code: string; weight: number }> {
  const normalizedTarget = Math.max(4, targetCount);
  const pool = new Map<string, number>();
  for (const country of baseCountries) {
    const code = String(country.code || "")
      .trim()
      .toUpperCase();
    const weight = Math.max(0, Number(country.weight) || 0);
    if (!code || weight <= 0) continue;
    pool.set(code, (pool.get(code) ?? 0) + weight);
  }
  if (pool.size === 0) pool.set("US", 1);

  const baseWeightSum = Array.from(pool.values()).reduce(
    (sum, value) => sum + value,
    0,
  );
  const longTailScale = Math.max(0.08, baseWeightSum * 0.22);

  for (const candidate of sShuffle(rng, [...GLOBAL_COUNTRY_LONG_TAIL])) {
    if (pool.size >= normalizedTarget) break;
    if (pool.has(candidate.code)) continue;
    const weight = candidate.weight * longTailScale * (0.7 + rng() * 0.7);
    pool.set(candidate.code, weight);
  }

  return Array.from(pool.entries())
    .map(([code, weight]) => ({ code, weight }))
    .sort((left, right) => right.weight - left.weight);
}

export function buildReferrerPool(
  rng: () => number,
  baseReferrers: Array<{ name: string; weight: number }>,
  targetCount: number,
): Array<{ label: string; weight: number }> {
  const normalizedTarget = Math.max(6, targetCount);
  const pool = new Map<string, number>();
  for (const referrer of baseReferrers) {
    const label = String(referrer.name || "").trim();
    const weight = Math.max(0, Number(referrer.weight) || 0);
    if (!label || weight <= 0) continue;
    pool.set(label, (pool.get(label) ?? 0) + weight);
  }
  if (!pool.has("(direct)")) pool.set("(direct)", 0.2);

  const baseWeightSum = Array.from(pool.values()).reduce(
    (sum, value) => sum + value,
    0,
  );
  const longTailScale = Math.max(0.04, baseWeightSum * 0.16);

  for (const candidate of sShuffle(rng, [...GLOBAL_REFERRER_LONG_TAIL])) {
    if (pool.size >= normalizedTarget) break;
    if (pool.has(candidate.name)) continue;
    const weight = candidate.weight * longTailScale * (0.65 + rng() * 0.9);
    pool.set(candidate.name, weight);
  }

  // Keep large demo collections useful for exercising cursor pagination even
  // when a site profile only contains a small curated referrer list. These
  // deterministic partner domains model the long tail without bloating the
  // static fixture catalog used by the other mock generators.
  let generatedIndex = 1;
  while (pool.size < normalizedTarget) {
    const label = `partner-${generatedIndex.toString().padStart(3, "0")}.example`;
    generatedIndex += 1;
    if (pool.has(label)) continue;
    pool.set(
      label,
      Math.max(0.002, longTailScale * 0.12 * (0.75 + rng() * 0.5)),
    );
  }

  return Array.from(pool.entries())
    .map(([label, weight]) => ({ label, weight }))
    .sort((left, right) => right.weight - left.weight);
}

export function filterGeoLabelsByCountries(
  labels: readonly string[],
  countries: string[],
): string[] {
  const allowed = new Set(
    countries.map((country) => country.trim().toUpperCase()).filter(Boolean),
  );
  const filtered = labels.filter((label) =>
    allowed.has(String(label).split("::")[0] || ""),
  );
  if (filtered.length >= 6) return filtered;
  return [...labels];
}

export function groupGeoLabelsByCountry(
  labels: readonly string[],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const label of labels) {
    const country =
      String(label)
        .split(DEMO_GEO_SEGMENT_SEPARATOR)[0]
        ?.trim()
        .toUpperCase() || "";
    if (!country) continue;
    const list = grouped.get(country) ?? [];
    list.push(String(label));
    grouped.set(country, list);
  }
  return grouped;
}

export const DEMO_REGIONS_BY_COUNTRY = groupGeoLabelsByCountry(ALL_REGIONS);
export const DEMO_CITIES_BY_COUNTRY = groupGeoLabelsByCountry(ALL_CITIES);

export function isMobileBrowserLabel(label: string): boolean {
  return (
    label.includes("Mobile") ||
    label.includes("Samsung") ||
    label.includes("UC") ||
    label.includes("QQ") ||
    label.includes("Huawei") ||
    label.includes("Mi")
  );
}

export function pickDemoDeviceType(
  rng: () => number,
  profile: DemoSiteProfile,
): string {
  const entries = Object.entries(profile.deviceWeights).map(
    ([label, weight]) => ({ label, weight }),
  );
  const index = weightedPickIndex(
    rng,
    entries.map((entry) => entry.weight),
  );
  return entries[index]?.label ?? "Desktop";
}

export function pickDemoBrowser(rng: () => number, deviceType: string): string {
  const adjusted = BROWSER_MARKET_WEIGHTS.map((entry) => {
    let weight = entry.weight;
    const mobileBrowser = isMobileBrowserLabel(entry.label);
    if (deviceType === "Mobile") {
      weight *= mobileBrowser ? 2.1 : 0.56;
    } else if (deviceType === "Tablet") {
      weight *= mobileBrowser ? 1.35 : 0.82;
    } else {
      weight *= mobileBrowser ? 0.38 : 1.15;
    }
    return {
      label: entry.label,
      weight,
    };
  });
  return weightedPickLabel(rng, adjusted, "Chrome");
}

export function pickDemoBrowserVersion(
  rng: () => number,
  browser: string,
): string {
  const normalized = browser.trim().toLowerCase();
  if (normalized.includes("samsung internet")) {
    return pickFromList(rng, ["27", "26", "25", "24"], "27");
  }
  if (normalized.includes("mobile safari") || normalized === "safari") {
    return pickFromList(rng, ["18", "17", "16", "15"], "17");
  }
  if (normalized.includes("firefox")) {
    return pickFromList(rng, ["137", "136", "135", "134"], "137");
  }
  if (normalized.includes("edge")) {
    return pickFromList(rng, ["138", "137", "136", "135"], "138");
  }
  if (normalized.includes("opera")) {
    return pickFromList(rng, ["117", "116", "115", "114"], "117");
  }
  if (normalized.includes("yandex")) {
    return pickFromList(rng, ["25", "24", "23"], "25");
  }
  if (normalized.includes("uc browser")) {
    return pickFromList(rng, ["16", "15", "14"], "16");
  }
  return pickFromList(rng, ["138", "137", "136", "135"], "138");
}

export function pickDemoOsVersion(
  rng: () => number,
  deviceType: string,
): string {
  if (deviceType === "Mobile")
    return pickFromList(rng, DEMO_MOBILE_OS, "Android 15");
  if (deviceType === "Tablet") {
    return rng() < 0.5
      ? pickFromList(rng, DEMO_MOBILE_OS, "iOS 18")
      : pickFromList(rng, DEMO_DESKTOP_OS, "Windows 11");
  }
  return pickFromList(rng, DEMO_DESKTOP_OS, "Windows 11");
}

export function pickDemoScreenSize(
  rng: () => number,
  deviceType: string,
): string {
  if (deviceType === "Mobile")
    return pickFromList(rng, DEMO_MOBILE_SCREENS, "390x844");
  if (deviceType === "Tablet")
    return pickFromList(rng, DEMO_TABLET_SCREENS, "834x1194");
  return pickFromList(rng, DEMO_DESKTOP_SCREENS, "1920x1080");
}

export function pickDemoLanguage(rng: () => number, country: string): string {
  const candidates = DEMO_COUNTRY_TO_LANGUAGES[country] ?? [];
  return pickFromList(
    rng,
    candidates.length > 0 ? candidates : ALL_LANGUAGES,
    ALL_LANGUAGES[0],
  );
}

export function pickDemoTimezone(rng: () => number, country: string): string {
  const candidates = DEMO_COUNTRY_TO_TIMEZONES[country] ?? [];
  return pickFromList(
    rng,
    candidates.length > 0 ? candidates : ALL_TIMEZONES,
    ALL_TIMEZONES[0],
  );
}

export function pickDemoContinent(rng: () => number, country: string): string {
  return (
    DEMO_COUNTRY_TO_CONTINENT[country] ??
    pickFromList(rng, ALL_CONTINENTS, "North America")
  );
}

export function pickDemoOrganization(
  rng: () => number,
  country: string,
): string {
  const offset = fnv1a(country || "US") % ALL_ORGS.length;
  const index =
    (offset + sInt(rng, 0, Math.min(4, ALL_ORGS.length - 1))) % ALL_ORGS.length;
  return ALL_ORGS[index];
}

export function parseDemoRegionLabel(label: string): {
  country: string;
  regionCode: string;
  regionName: string;
  region: string;
} | null {
  const segments = String(label)
    .split(DEMO_GEO_SEGMENT_SEPARATOR)
    .map((segment) => segment.trim());
  const country = (segments[0] || "").toUpperCase();
  const regionCode = segments[1] || "";
  const regionName = segments.slice(2).join(DEMO_GEO_SEGMENT_SEPARATOR).trim();
  if (!country || (!regionCode && !regionName)) return null;
  const regionToken = regionCode || regionName;
  return {
    country,
    regionCode,
    regionName,
    region: `${country}${DEMO_GEO_SEGMENT_SEPARATOR}${regionToken}${DEMO_GEO_SEGMENT_SEPARATOR}${regionName || regionToken}`,
  };
}

export function parseDemoCityLabel(label: string): {
  country: string;
  regionCode: string;
  regionName: string;
  region: string;
  cityName: string;
  city: string;
} | null {
  const segments = String(label)
    .split(DEMO_GEO_SEGMENT_SEPARATOR)
    .map((segment) => segment.trim());
  const country = (segments[0] || "").toUpperCase();
  const regionCode = segments[1] || "";
  const regionName = segments[2] || "";
  const cityName = segments.slice(3).join(DEMO_GEO_SEGMENT_SEPARATOR).trim();
  if (!country || !cityName || (!regionCode && !regionName)) return null;
  const regionToken = regionCode || regionName;
  const normalizedRegionName = regionName || regionToken;
  const region = `${country}${DEMO_GEO_SEGMENT_SEPARATOR}${regionToken}${DEMO_GEO_SEGMENT_SEPARATOR}${normalizedRegionName}`;
  return {
    country,
    regionCode,
    regionName: normalizedRegionName,
    region,
    cityName,
    city: `${region}${DEMO_GEO_SEGMENT_SEPARATOR}${cityName}`,
  };
}

// Per-country boost map for referrers — favored search engines / portals
// keyed by country code. Used by pickReferrerByCountry to bias the site's
// referrer pool so a visit from CN is more likely to come from baidu/qq,
// RU from yandex, etc.
const REFERRER_COUNTRY_BIAS: Record<string, Record<string, number>> = {
  CN: {
    "baidu.com": 6,
    "qq.com": 4,
    "weibo.com": 3.5,
    "zhihu.com": 3,
    "wechat.com": 3,
    "bing.com": 1.6,
  },
  HK: { "baidu.com": 2.4, "yahoo.com": 1.8, "google.com": 1.4 },
  TW: { "yahoo.com": 2.4, "google.com": 1.6 },
  RU: {
    "yandex.com": 5,
    "yandex.ru": 5,
    "mail.ru": 3.5,
    "vk.com": 3,
  },
  KR: {
    "naver.com": 5,
    "daum.net": 3.5,
    "kakao.com": 3,
  },
  JP: {
    "yahoo.co.jp": 4,
    "yahoo.com": 1.8,
    "line.me": 2.8,
  },
  CZ: { "seznam.cz": 3 },
  IR: { "aparat.com": 2.4 },
};

/**
 * Pick one referrer from the site pool, biased by visitor country. The
 * weights of country-specific portals (baidu for CN, yandex for RU, naver
 * for KR, …) are multiplied by a factor before sampling — referrers absent
 * from both the pool and the bias map are unaffected.
 */
export function pickReferrerByCountry(
  rng: () => number,
  pool: Array<{ label: string; weight: number }>,
  country: string,
  fallback = "(direct)",
): string {
  const bias = REFERRER_COUNTRY_BIAS[country?.toUpperCase()] ?? {};
  const adjusted = pool.map((entry) => {
    const factor = bias[entry.label.toLowerCase()] ?? 1;
    return { label: entry.label, weight: entry.weight * factor };
  });
  // For strong-signal countries also splice in their flagship referrer even
  // if the site pool didn't include it (so a CN visit can plausibly come
  // from baidu even on a site that didn't list it in topReferrers).
  for (const [label, factor] of Object.entries(bias)) {
    if (!adjusted.some((entry) => entry.label.toLowerCase() === label)) {
      // Inject with a small base weight scaled by bias factor.
      adjusted.push({ label, weight: 0.04 * factor });
    }
  }
  return weightedPickLabel(rng, adjusted, fallback);
}

export function pickDemoGeoContext(
  rng: () => number,
  country: string,
): {
  regionCode: string;
  regionName: string;
  region: string;
  cityName: string;
  city: string;
  continent: string;
  timezone: string;
  organization: string;
  latitude: number;
  longitude: number;
} {
  const regionCandidates = DEMO_REGIONS_BY_COUNTRY.get(country) ?? [];
  const cityCandidates = DEMO_CITIES_BY_COUNTRY.get(country) ?? [];
  let regionCode = "";
  let regionName = "";
  let region = "";
  let cityName = "";
  let city = "";

  const preferCity =
    cityCandidates.length > 0 &&
    (regionCandidates.length === 0 || rng() < 0.72);
  if (preferCity) {
    const parsedCity = parseDemoCityLabel(
      pickFromList(rng, cityCandidates, cityCandidates[0] || ""),
    );
    if (parsedCity) {
      regionCode = parsedCity.regionCode;
      regionName = parsedCity.regionName;
      region = parsedCity.region;
      cityName = parsedCity.cityName;
      city = parsedCity.city;
    }
  }

  if (!region && regionCandidates.length > 0) {
    const parsedRegion = parseDemoRegionLabel(
      pickFromList(rng, regionCandidates, regionCandidates[0] || ""),
    );
    if (parsedRegion) {
      regionCode = parsedRegion.regionCode;
      regionName = parsedRegion.regionName;
      region = parsedRegion.region;
    }
  }

  const point = sampleGeoPointByCountry(rng, country);
  return {
    regionCode,
    regionName,
    region,
    cityName,
    city,
    continent: pickDemoContinent(rng, country),
    timezone: pickDemoTimezone(rng, country),
    organization: pickDemoOrganization(rng, country),
    latitude: point.latitude,
    longitude: point.longitude,
  };
}
