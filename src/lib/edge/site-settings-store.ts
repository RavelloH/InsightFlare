import {
  normalizeSiteTrackingConfig,
  normalizeSiteScriptSettings,
  type SiteTrackingConfig,
  type SiteScriptSettings,
} from "@/lib/site-settings";
import type { Env } from "./types";

const SITE_SETTINGS_CACHE_NAME = "insightflare-site-settings-cache";
const SITE_SETTINGS_CACHE_TTL_SECONDS = 60 * 60;
const SITE_SETTINGS_MAX_ID_LENGTH = 120;

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

function cacheRequestForSiteSettings(siteId: string): Request {
  return new Request(`https://insightflare.internal/__site-settings/${encodeURIComponent(siteId)}`);
}

function cacheResponseForSiteSettings(settings: SiteTrackingConfig): Response {
  return new Response(JSON.stringify(settings), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${SITE_SETTINGS_CACHE_TTL_SECONDS}, s-maxage=${SITE_SETTINGS_CACHE_TTL_SECONDS}`,
    },
  });
}

async function readSettingsFromCache(siteId: string): Promise<SiteTrackingConfig | null> {
  const cache = await openEdgeCache(SITE_SETTINGS_CACHE_NAME);
  if (!cache) return null;
  const hit = await cache.match(cacheRequestForSiteSettings(siteId));
  if (!hit) return null;
  try {
    return normalizeSiteTrackingConfig(await hit.json());
  } catch {
    return null;
  }
}

async function writeSettingsToCache(siteId: string, settings: SiteTrackingConfig): Promise<void> {
  const cache = await openEdgeCache(SITE_SETTINGS_CACHE_NAME);
  if (!cache) return;
  await cache.put(cacheRequestForSiteSettings(siteId), cacheResponseForSiteSettings(settings));
}

async function deleteSettingsFromCache(siteId: string): Promise<void> {
  const cache = await openEdgeCache(SITE_SETTINGS_CACHE_NAME);
  if (!cache) return;
  await cache.delete(cacheRequestForSiteSettings(siteId));
}

function siteSettingsBinding(env: Env): KVNamespace {
  if (!env.SITE_SETTINGS_KV) {
    throw new Error("SITE_SETTINGS_KV binding is missing");
  }
  return env.SITE_SETTINGS_KV;
}

export function normalizeSiteSettingsKey(input: unknown): string {
  const value = String(input ?? "").trim();
  if (!value) return "";
  return value.slice(0, SITE_SETTINGS_MAX_ID_LENGTH);
}

export async function readSiteScriptSettings(
  env: Env,
  siteId: string,
): Promise<SiteScriptSettings | null> {
  const config = await readSiteTrackingConfig(env, siteId);
  if (!config) return null;
  return normalizeSiteScriptSettings(config);
}

export async function readSiteTrackingConfig(
  env: Env,
  siteId: string,
): Promise<SiteTrackingConfig | null> {
  const normalizedSiteId = normalizeSiteSettingsKey(siteId);
  if (!normalizedSiteId) return null;

  const cached = await readSettingsFromCache(normalizedSiteId);
  if (cached) return cached;

  const kv = siteSettingsBinding(env);
  const raw = await kv.get(normalizedSiteId);
  if (raw == null) return null;

  let parsed: unknown = {};
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    parsed = {};
  }

  const normalized = normalizeSiteTrackingConfig({
    ...(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}),
    siteId: normalizedSiteId,
  });
  await writeSettingsToCache(normalizedSiteId, normalized);
  return normalized;
}

export async function upsertSiteTrackingConfig(
  env: Env,
  siteId: string,
  input: {
    siteDomain?: unknown;
    settings?: unknown;
  },
): Promise<SiteTrackingConfig> {
  const normalizedSiteId = normalizeSiteSettingsKey(siteId);
  if (!normalizedSiteId) {
    throw new Error("siteId is required");
  }

  const existing = await readSiteTrackingConfig(env, normalizedSiteId);
  const normalized = normalizeSiteTrackingConfig({
    ...(existing ?? {}),
    ...(input.settings && typeof input.settings === "object"
      ? (input.settings as Record<string, unknown>)
      : {}),
    siteId: normalizedSiteId,
    siteDomain: input.siteDomain ?? existing?.siteDomain ?? "",
  });
  if (!normalized.siteDomain) {
    throw new Error("siteDomain is required");
  }
  const kv = siteSettingsBinding(env);
  await kv.put(normalizedSiteId, JSON.stringify(normalized));
  await writeSettingsToCache(normalizedSiteId, normalized);
  return normalized;
}

export async function upsertSiteScriptSettings(
  env: Env,
  siteId: string,
  input: {
    siteDomain: unknown;
    settings?: unknown;
  },
): Promise<SiteScriptSettings> {
  const normalized = await upsertSiteTrackingConfig(env, siteId, input);
  return normalizeSiteScriptSettings(normalized);
}

export async function deleteSiteScriptSettings(env: Env, siteId: string): Promise<void> {
  const normalizedSiteId = normalizeSiteSettingsKey(siteId);
  if (!normalizedSiteId) return;
  const kv = siteSettingsBinding(env);
  await kv.delete(normalizedSiteId);
  await deleteSettingsFromCache(normalizedSiteId);
}
