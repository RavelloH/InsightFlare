// ---------------------------------------------------------------------------
//  Visitor universe — cross-day-stable fingerprints
//
//  Each site has a *fixed* visitor universe sized roughly to its weekly traffic.
//  A visitor's fingerprint (country, geo, device, browser, OS, language, screen)
//  is derived from `fnv1a("fp:siteId:visitorId")` and therefore stable across
//  days, windows, and endpoints — the demo dashboard's visitors table can show
//  a "first seen 3 weeks ago" entry and it really will have the same country
//  and browser every time it's looked up.
//
//  `sampleActiveVisitors(siteId, from, to, count)` returns which visitor IDs
//  are "active" in a given window. This uses the *window* seed (depends on
//  todayKey + from + to), so the set rotates with time, but the visitor IDs
//  themselves are drawn from the stable universe.
// ---------------------------------------------------------------------------

import { findSiteProfile } from "@/lib/demo/data/site-profiles";
import {
  createDemoRng,
  fnv1a,
  mulberry32,
  sShuffle,
  windowBucket,
} from "@/lib/demo/generators/utils";
import {
  pickDemoBrowser,
  pickDemoBrowserVersion,
  pickDemoDeviceType,
  pickDemoGeoContext,
  pickDemoLanguage,
  pickDemoOsVersion,
  pickDemoScreenSize,
  weightedPickCountry,
} from "@/lib/demo/realtime/dimension-pickers";
export interface VisitorFingerprint {
  visitorId: string;
  country: string;
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
  deviceType: string;
  browser: string;
  browserVersion: string;
  osVersion: string;
  language: string;
  screenSize: string;
}
const FINGERPRINT_CACHE = new Map<string, VisitorFingerprint>();
const UNIVERSE_SIZE_CACHE = new Map<string, number>();
const MIN_UNIVERSE = 800;
const MAX_UNIVERSE = 50_000;
const DEFAULT_RETURN_RATE = 0.25;
/**
 * Approximate weekly distinct visitor count for a site, used as the size of
 * the stable visitor universe. Higher daily PV × lower return rate → more
 * distinct visitors.
 */
export function getVisitorUniverseSize(siteId: string): number {
  const cached = UNIVERSE_SIZE_CACHE.get(siteId);
  if (cached !== undefined) return cached;
  const profile = findSiteProfile(siteId);
  const dailyMid = (profile.dailyPvRange[0] + profile.dailyPvRange[1]) / 2;
  const returnRate = clampReturnRate(profile.visitorReturnRate);
  // Each visitor returns on ~returnRate of days; over a 14-day rolling
  // window, expected distinct visitors ≈ dailyMid × 14 × (1 - returnRate^14).
  // We approximate with a simpler closed form and clamp to a sane range.
  const raw = Math.round((dailyMid * 14) / Math.max(0.4, 1 + returnRate * 3));
  const size = Math.min(MAX_UNIVERSE, Math.max(MIN_UNIVERSE, raw));
  UNIVERSE_SIZE_CACHE.set(siteId, size);
  return size;
}
export function getVisitorReturnRate(siteId: string): number {
  return clampReturnRate(findSiteProfile(siteId).visitorReturnRate);
}
function clampReturnRate(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RETURN_RATE;
  }
  return Math.max(0.02, Math.min(0.85, value));
}
/**
 * Build a stable visitor ID from a sequential index in the site's universe.
 * The ID is deterministic — `index → id` is 1:1 within a site.
 */
export function visitorIdFromIndex(siteId: string, index: number): string {
  const safeIndex = Math.max(0, Math.floor(index));
  const suffix = safeIndex.toString(36).padStart(6, "0");
  return `v-${siteId.slice(-3)}-${suffix}`;
}
/**
 * Inverse of `visitorIdFromIndex` — extract the universe index from an ID.
 * Returns NaN if the ID does not match the expected format.
 */
export function visitorIndexFromId(id: string): number {
  const match = /-([0-9a-z]+)$/.exec(id);
  if (!match) return Number.NaN;
  return Number.parseInt(match[1] ?? "", 36);
}
/**
 * Derive a visitor's stable fingerprint. Properties are computed once and
 * cached, then reused across every query in this process.
 */
export function getVisitorFingerprint(
  siteId: string,
  visitorId: string,
): VisitorFingerprint {
  const cacheKey = `${siteId}:${visitorId}`;
  const cached = FINGERPRINT_CACHE.get(cacheKey);
  if (cached) return cached;

  const profile = findSiteProfile(siteId);
  const rng = mulberry32(fnv1a(`fp:${siteId}:${visitorId}`));

  const country = weightedPickCountry(rng, profile.topCountries);
  const geo = pickDemoGeoContext(rng, country);
  const deviceType = pickDemoDeviceType(rng, profile);
  const browser = pickDemoBrowser(rng, deviceType);
  const browserVersion = pickDemoBrowserVersion(rng, browser);
  const osVersion = pickDemoOsVersion(rng, deviceType);
  const language = pickDemoLanguage(rng, country);
  const screenSize = pickDemoScreenSize(rng, deviceType);

  const fingerprint: VisitorFingerprint = {
    visitorId,
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
    deviceType,
    browser,
    browserVersion,
    osVersion,
    language,
    screenSize,
  };
  FINGERPRINT_CACHE.set(cacheKey, fingerprint);
  return fingerprint;
}
/**
 * Pick `count` visitor IDs for the given window. Composition is governed by
 * `visitorReturnRate`:
 *  - returningShare of the result is drawn from the universe "head" (recent
 *    returning users) — IDs in the low-index range, with high churn between
 *    days but the same head population across the rolling window.
 *  - the remainder is drawn from the universe "tail" (fresh, less-active IDs)
 *    using a window-specific seed so each window sees a slightly different
 *    sample of new visitors.
 */
export function sampleActiveVisitors(
  siteId: string,
  from: number,
  to: number,
  count: number,
): string[] {
  const target = Math.max(1, Math.floor(count));
  const universeSize = getVisitorUniverseSize(siteId);
  if (target >= universeSize) {
    return Array.from({ length: universeSize }, (_, i) =>
      visitorIdFromIndex(siteId, i),
    );
  }

  const returnRate = getVisitorReturnRate(siteId);
  const returningTarget = Math.min(target, Math.round(target * returnRate));
  const freshTarget = target - returningTarget;

  // Head population — same indices across the whole rolling window, scaled
  // so that ~returnRate × universeSize IDs are "active returners" at any
  // given time.
  const headSize = Math.max(
    returningTarget,
    Math.round(universeSize * Math.min(0.85, returnRate + 0.15)),
  );
  const headIndices = Array.from({ length: headSize }, (_, i) => i);

  // Tail population — the rest of the universe.
  const tailIndices = Array.from(
    { length: Math.max(0, universeSize - headSize) },
    (_, i) => headSize + i,
  );

  const windowRng = createDemoRng(siteId, `visitors:${windowBucket(from, to)}`);
  const pickedHead = sShuffle(windowRng, headIndices).slice(0, returningTarget);
  const pickedTail = sShuffle(windowRng, tailIndices).slice(0, freshTarget);

  const ids = pickedHead
    .concat(pickedTail)
    .map((idx) => visitorIdFromIndex(siteId, idx));
  return sShuffle(windowRng, ids);
}
