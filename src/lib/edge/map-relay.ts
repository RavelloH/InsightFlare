import {
  getInvocationLogger,
  measureExternalFetch,
} from "@/lib/edge/observability-bindings";
import type { Env } from "@/lib/edge/types";
import { requireSameOrigin } from "@/lib/edge/utils";
import { isValidLocale, type Locale } from "@/lib/i18n/config";

const DEFAULT_MAP_RELAY_BASE_URL = "https://maprelay.ravelloh.com";
const MAP_RESOURCE_PREFIX = "/api/public/resources/map";
const MAP_RELAY_CLIENT = "insightflare-backend-v1";
const MAP_LOCALE_QUERY_PARAM = "locale";
const MAP_RELAY_LOCALE_QUERY_PARAM = "if_locale";
const MAP_RELAY_LOCALE_HEADER = "x-insightflare-locale";
const INSTANCE_SCOPED_RELAY_PATH =
  /^\/v1\/(?:styles\/(?:light|dark)\/style\.json|sources\/carto\.streets\/v1\/tiles\.json)$/;

const ALLOWED_MAP_PATH =
  /^\/v1\/(?:styles\/(?:light|dark)\/style\.json|sources\/carto\.streets\/v1\/tiles\.json|tiles\/carto\.streets\/v1\/\d+\/\d+\/\d+\.mvt|fonts\/[^/]+\/[^/]+\.pbf|sprites\/(?:light|dark)\/sprite(?:@2x)?\.(?:json|png))$/;

const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "cloudflare-cdn-cache-control",
  "content-encoding",
  "content-language",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "vary",
  "x-content-type-options",
] as const;

function resolveMapRelayOrigin(env?: Env): string {
  const configured = env?.MAP_RELAY_BASE_URL?.trim();
  if (!configured) return DEFAULT_MAP_RELAY_BASE_URL;

  try {
    const url = new URL(configured);
    if (url.protocol !== "https:") return DEFAULT_MAP_RELAY_BASE_URL;
    return url.origin;
  } catch {
    return DEFAULT_MAP_RELAY_BASE_URL;
  }
}

function getInsightFlareVersion(): string {
  return import.meta.env?.VITE_APP_VERSION || "unknown";
}

function getInsightFlareCommit(): string {
  return import.meta.env?.VITE_COMMIT_SHA || "unknown";
}

function getRequestHost(request: Request): string {
  return request.headers.get("host") || new URL(request.url).host;
}

function getRequestedLocale(requestUrl: URL): Locale | null {
  const value = requestUrl.searchParams.get(MAP_LOCALE_QUERY_PARAM);
  return isValidLocale(value) ? value : null;
}

function getRelayPath(request: Request): string | null {
  const pathname = new URL(request.url).pathname;
  if (!pathname.startsWith(`${MAP_RESOURCE_PREFIX}/`)) return null;

  const relayPath = pathname.slice(MAP_RESOURCE_PREFIX.length);
  return ALLOWED_MAP_PATH.test(relayPath) ? relayPath : null;
}

function copyRelayResponse(response: Response): Response {
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleMapRelayRequest(
  request: Request,
  env?: Env,
): Promise<Response> {
  const sameOriginError = requireSameOrigin(request);
  if (sameOriginError) return sameOriginError;

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET" },
    });
  }

  const relayPath = getRelayPath(request);
  if (!relayPath) return new Response("Not Found", { status: 404 });

  const requestUrl = new URL(request.url);
  const relayUrl = new URL(relayPath, `${resolveMapRelayOrigin(env)}/`);
  const locale = getRequestedLocale(requestUrl);
  if (INSTANCE_SCOPED_RELAY_PATH.test(relayPath)) {
    relayUrl.searchParams.set("if_origin", requestUrl.origin);
    if (locale) relayUrl.searchParams.set(MAP_RELAY_LOCALE_QUERY_PARAM, locale);
  }
  const relayRequestHeaders = new Headers({
    "x-insightflare-client": MAP_RELAY_CLIENT,
    "x-insightflare-version": getInsightFlareVersion(),
    "x-insightflare-commit": getInsightFlareCommit(),
    "x-insightflare-host": getRequestHost(request),
    "x-insightflare-protocol": requestUrl.protocol.replace(":", ""),
  });
  if (locale) relayRequestHeaders.set(MAP_RELAY_LOCALE_HEADER, locale);
  const logger = env ? getInvocationLogger(env) : undefined;

  try {
    const response = await measureExternalFetch(
      logger,
      "external_fetch.map_relay",
      () =>
        fetch(relayUrl, {
          method: "GET",
          headers: relayRequestHeaders,
        }),
    );
    logger?.info("map_relay.response", {
      path: relayPath,
      status: response.status,
    });
    return copyRelayResponse(response);
  } catch {
    logger?.info("map_relay.response", {
      path: relayPath,
      status: 502,
    });
    return new Response("Map relay unavailable", { status: 502 });
  }
}
