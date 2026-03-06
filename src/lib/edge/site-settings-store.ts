import {
  normalizeSiteScriptSettings,
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

function cacheResponseForSiteSettings(settings: SiteScriptSettings): Response {
  return new Response(JSON.stringify(settings), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${SITE_SETTINGS_CACHE_TTL_SECONDS}, s-maxage=${SITE_SETTINGS_CACHE_TTL_SECONDS}`,
    },
  });
}

async function readSettingsFromCache(siteId: string): Promise<SiteScriptSettings | null> {
  const cache = await openEdgeCache(SITE_SETTINGS_CACHE_NAME);
  if (!cache) return null;
  const hit = await cache.match(cacheRequestForSiteSettings(siteId));
  if (!hit) return null;
  try {
    return normalizeSiteScriptSettings(await hit.json());
  } catch {
    return null;
  }
}

async function writeSettingsToCache(siteId: string, settings: SiteScriptSettings): Promise<void> {
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

  const normalized = normalizeSiteScriptSettings(parsed);
  await writeSettingsToCache(normalizedSiteId, normalized);
  return normalized;
}

export async function upsertSiteScriptSettings(
  env: Env,
  siteId: string,
  input: unknown,
): Promise<SiteScriptSettings> {
  const normalizedSiteId = normalizeSiteSettingsKey(siteId);
  if (!normalizedSiteId) {
    throw new Error("siteId is required");
  }

  const settings = normalizeSiteScriptSettings(input);
  const kv = siteSettingsBinding(env);
  await kv.put(normalizedSiteId, JSON.stringify(settings));
  await writeSettingsToCache(normalizedSiteId, settings);
  return settings;
}

export async function deleteSiteScriptSettings(env: Env, siteId: string): Promise<void> {
  const normalizedSiteId = normalizeSiteSettingsKey(siteId);
  if (!normalizedSiteId) return;
  const kv = siteSettingsBinding(env);
  await kv.delete(normalizedSiteId);
  await deleteSettingsFromCache(normalizedSiteId);
}
