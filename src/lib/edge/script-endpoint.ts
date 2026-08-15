import { SDK_MIN as SDK_FULL } from "@/tracker/sdk.min";
import { SDK_MIN as SDK_NO_PERF } from "@/tracker/sdk.no-perf.min";

import {
  COLLECT_TOKEN_TTL_SECONDS,
  issueCollectToken,
  requestIp,
} from "./collect-token";
import {
  normalizeSiteSettingsKey,
  readSiteTrackingConfig,
} from "./site-settings-store";
import type { Env } from "./types";
import { resolveSessionWindowMinutes } from "./utils";

const SCRIPT_RESPONSE_CACHE_NAME = "insightflare-script-cache";
const SCRIPT_RESPONSE_CACHE_TTL_SECONDS = 10 * 60;
const SCRIPT_CACHE_VERSION = "sdk-prebuilt-v1";
const MAX_SCRIPT_RESPONSE_CACHE_TTL_SECONDS = 24 * 60 * 60;
const TRACKER_RUNTIME_CONFIG_KEY = "__insightflare_tracker_runtime_config__";

function isEUCountry(request: Request): boolean {
  const cf = (request as Request & { cf?: { isEUCountry?: boolean } }).cf;
  return Boolean(cf?.isEUCountry);
}

function responseBadRequest(message: string): Response {
  return new Response(message, { status: 400 });
}

function responseNotFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function responseMethodNotAllowed(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}

function responseInternalServerError(message: string): Response {
  return new Response(message, { status: 500 });
}

function openCacheStorage(): CacheStorage | null {
  if (typeof globalThis !== "object" || !("caches" in globalThis)) {
    return null;
  }
  const maybeCaches = (globalThis as { caches?: CacheStorage }).caches;
  if (!maybeCaches || typeof maybeCaches.open !== "function") {
    return null;
  }
  return maybeCaches;
}

async function openEdgeCache(name: string): Promise<Cache | null> {
  const storage = openCacheStorage();
  if (!storage) return null;
  try {
    return await storage.open(name);
  } catch {
    return null;
  }
}

function determineEuMode(
  trackingStrength: "strong" | "smart" | "weak",
  requestEuMode: boolean,
): boolean {
  if (trackingStrength === "strong") return false;
  if (trackingStrength === "weak") return true;
  return requestEuMode;
}

function applyConfigToSdk(
  template: string,
  config: {
    siteId: string;
    isEUMode: boolean;
    trackQueryParams: boolean;
    trackHash: boolean;
    ignoreDoNotTrack: boolean;
    autoTrackOutboundLinks: boolean;
    performanceSampleRate: number;
    sessionWindowMs: number;
    collectToken: string;
  },
): string {
  const assignment = `globalThis[${JSON.stringify(TRACKER_RUNTIME_CONFIG_KEY)}] = ${JSON.stringify(config)};\n`;
  const strictDirective = '"use strict";';
  return template.startsWith(strictDirective)
    ? `${strictDirective}${assignment}${template.slice(strictDirective.length)}`
    : `${assignment}${template}`;
}

function settingsFingerprint(input: {
  trackingStrength: "strong" | "smart" | "weak";
  trackQueryParams: boolean;
  trackHash: boolean;
  ignoreDoNotTrack: boolean;
  autoTrackOutboundLinks: boolean;
  performanceSampleRate: number;
  siteDomain: string;
  sessionWindowMinutes: number;
  requestIp: string;
}): string {
  return [
    input.trackingStrength,
    input.trackQueryParams ? "1" : "0",
    input.trackHash ? "1" : "0",
    input.ignoreDoNotTrack ? "1" : "0",
    input.autoTrackOutboundLinks ? "1" : "0",
    String(input.performanceSampleRate),
    input.siteDomain,
    String(input.sessionWindowMinutes),
    input.requestIp,
  ].join("|");
}

function scriptCacheKeyRequest(
  siteId: string,
  euMode: boolean,
  fingerprint: string,
): Request {
  const encodedSiteId = encodeURIComponent(siteId);
  const encodedFingerprint = encodeURIComponent(fingerprint);
  return new Request(
    `https://insightflare.internal/__script/${encodedSiteId}?eu=${euMode ? "1" : "0"}&fp=${encodedFingerprint}`,
  );
}

function resolveScriptCacheTtlSeconds(env: Env): number {
  const raw = Number(env.SCRIPT_CACHE_TTL_SECONDS || "");
  if (!Number.isFinite(raw) || raw <= 0) {
    return SCRIPT_RESPONSE_CACHE_TTL_SECONDS;
  }
  return Math.max(
    1,
    Math.min(
      MAX_SCRIPT_RESPONSE_CACHE_TTL_SECONDS,
      COLLECT_TOKEN_TTL_SECONDS,
      Math.floor(raw),
    ),
  );
}

export async function handleTrackerScriptRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "GET") {
    return responseMethodNotAllowed();
  }

  const incomingUrl = new URL(request.url);
  const siteId = normalizeSiteSettingsKey(
    incomingUrl.searchParams.get("siteId"),
  );
  if (!siteId) {
    return responseBadRequest("Missing siteId");
  }

  let settings;
  try {
    settings = await readSiteTrackingConfig(env, siteId);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "site_settings_unavailable";
    return responseInternalServerError(message);
  }
  if (!settings?.siteDomain) {
    return responseNotFound();
  }

  const requestEuMode = isEUCountry(request);
  const euMode = determineEuMode(settings.trackingStrength, requestEuMode);
  const sessionWindowMinutes = resolveSessionWindowMinutes(env);
  const ttlSeconds = resolveScriptCacheTtlSeconds(env);
  const clientIp = requestIp(request);
  const performanceSampleRate = Math.max(
    0,
    Math.min(100, Number(settings.performanceSampleRate || 0)),
  );
  const fingerprint = [
    SCRIPT_CACHE_VERSION,
    settingsFingerprint({
      ...settings,
      autoTrackOutboundLinks: settings.autoTrackOutboundLinks,
      performanceSampleRate,
      sessionWindowMinutes,
      requestIp: clientIp,
    }),
  ].join("|");
  const cacheKey = scriptCacheKeyRequest(siteId, euMode, fingerprint);
  const scriptCache = await openEdgeCache(SCRIPT_RESPONSE_CACHE_NAME);
  if (scriptCache) {
    const cached = await scriptCache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const sessionWindowMs =
    Math.max(1, Math.floor(sessionWindowMinutes)) * 60 * 1000;
  let collectToken = "";
  try {
    collectToken = await issueCollectToken({
      env,
      siteId,
      ip: clientIp,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "collect_token_unavailable";
    return responseInternalServerError(message);
  }

  const sdkTemplate = performanceSampleRate > 0 ? SDK_FULL : SDK_NO_PERF;
  const script = applyConfigToSdk(sdkTemplate, {
    siteId,
    isEUMode: euMode,
    trackQueryParams: settings.trackQueryParams,
    trackHash: settings.trackHash,
    ignoreDoNotTrack: settings.ignoreDoNotTrack,
    autoTrackOutboundLinks: settings.autoTrackOutboundLinks,
    performanceSampleRate,
    sessionWindowMs,
    collectToken,
  });

  const response = new Response(script, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`,
      "access-control-allow-origin": "*",
    },
  });

  if (scriptCache) {
    await scriptCache.put(cacheKey, response.clone());
  }

  return response;
}
