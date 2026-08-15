import { classifyASN } from "asn-blocklist";
import { isbot } from "isbot";

import { isAnalyticsEngineDisabled } from "./analytics-engine";
import type { InvocationLogger } from "./observability-logger";
import type { Env, TrackerClientPayload } from "./types";
import { clampString, coerceNumber, coerceString, safeHostname } from "./utils";

export type BotConfidence = "high" | "medium" | "low";

export interface BotClassification {
  isBot: boolean;
  confidence: BotConfidence;
  reasons: string[];
}

export interface BotAnalyticsInput {
  request: Request;
  payload: TrackerClientPayload;
  siteId: string;
  origin: string | null;
  traceId: string;
  receivedAt: number;
  classification: BotClassification;
}

export const BOT_ANALYTICS_BLOBS = [
  "siteId",
  "kind",
  "confidence",
  "reasons",
  "ip",
  "userAgent",
  "origin",
  "hostname",
  "pathname",
  "country",
  "region",
  "city",
  "continent",
  "colo",
  "asn",
  "asOrganization",
  "verifiedBotCategory",
  "rayId",
  "traceId",
  "metadataJson",
] as const;

export const BOT_ANALYTICS_DOUBLES = [
  "receivedAt",
  "asn",
  "latitude",
  "longitude",
  "botScore",
  "userAgentLength",
] as const;

const EMPTY_CLASSIFICATION: BotClassification = {
  isBot: false,
  confidence: "low",
  reasons: [],
};

const SCRIPT_UA_FRAGMENTS = [
  "curl",
  "wget",
  "python-requests",
  "python-httpx",
  "aiohttp",
  "httpclient",
  "go-http-client",
  "okhttp",
  "java/",
  "libwww",
  "scrapy",
] as const;

function requestCf(request: Request): Record<string, unknown> {
  return ((request as Request & { cf?: Record<string, unknown> }).cf ??
    {}) as Record<string, unknown>;
}

function requestHeader(
  request: Request,
  name: string,
  maxLength: number,
): string {
  return clampString(request.headers.get(name)?.trim() ?? "", maxLength);
}

function requestIp(request: Request): string {
  const cfIp = requestHeader(request, "cf-connecting-ip", 80);
  if (cfIp) return cfIp;
  const forwarded = requestHeader(request, "x-forwarded-for", 255);
  return forwarded.split(",")[0]?.trim() || "";
}

function requestPathname(request: Request): string {
  try {
    return clampString(new URL(request.url).pathname, 2048);
  } catch {
    return "";
  }
}

function payloadPathname(payload: TrackerClientPayload): string {
  const pathname = coerceString(payload.pathname || "");
  if (!pathname) return "";
  if (pathname.includes("://")) {
    try {
      return clampString(new URL(pathname).pathname || "/", 2048);
    } catch {
      return "";
    }
  }
  return clampString(pathname.split(/[?#]/)[0] ?? pathname, 2048);
}

function payloadHostname(payload: TrackerClientPayload): string {
  return clampString(coerceString(payload.hostname || "").toLowerCase(), 255);
}

function hasBrowserProvenance(request: Request): boolean {
  return Boolean(
    request.headers.get("origin") ||
    request.headers.get("referer") ||
    request.headers.get("sec-fetch-site"),
  );
}

function originHostname(origin: string | null): string {
  if (!origin) return "";
  return safeHostname(origin).toLowerCase();
}

function cfBotScore(cf: Record<string, unknown>): number | null {
  const botManagement =
    cf.botManagement && typeof cf.botManagement === "object"
      ? (cf.botManagement as Record<string, unknown>)
      : null;
  return coerceNumber(botManagement?.score, null);
}

function cfVerifiedBotCategory(cf: Record<string, unknown>): string {
  return clampString(coerceString(cf.verifiedBotCategory || ""), 80);
}

export function classifyCollectBotTraffic(input: {
  request: Request;
  payload: TrackerClientPayload;
  origin: string | null;
}): BotClassification {
  const ua = requestHeader(input.request, "user-agent", 1024);
  const uaLower = ua.toLowerCase();
  const cf = requestCf(input.request);
  const asn = coerceNumber(cf.asn, null);
  const reasons: string[] = [];

  if (!ua) reasons.push("missing_ua");
  if (ua.length > 512) reasons.push("ua_too_long");
  if (ua && isbot(ua)) reasons.push("ua_isbot");
  if (
    uaLower &&
    SCRIPT_UA_FRAGMENTS.some((fragment) => uaLower.includes(fragment))
  ) {
    reasons.push("script_ua");
  }

  const score = cfBotScore(cf);
  if (score !== null && score <= 29) reasons.push("cf_bot_score_low");
  if (cfVerifiedBotCategory(cf)) reasons.push("cf_verified_bot_category");

  const asnClass = typeof asn === "number" ? classifyASN(asn) : "unknown";
  const hostedByAsn = asnClass === "hosting";
  const networkServiceAsn = asnClass === "network_service";
  if (hostedByAsn) reasons.push("hosting_asn");
  else if (networkServiceAsn) reasons.push("network_service_asn");
  else if (asnClass === "transit") reasons.push("transit_asn");
  else if (asnClass === "access") reasons.push("access_asn");

  const missingBrowserProvenance = !hasBrowserProvenance(input.request);
  if (missingBrowserProvenance) {
    reasons.push("missing_browser_provenance");
  }

  const originHost = originHostname(input.origin);
  const host = payloadHostname(input.payload);
  if (originHost && host && originHost !== host) {
    reasons.push("origin_hostname_mismatch");
  }

  const highReasons = new Set([
    "ua_too_long",
    "ua_isbot",
    "script_ua",
    "cf_bot_score_low",
    "cf_verified_bot_category",
  ]);
  if (reasons.some((reason) => highReasons.has(reason))) {
    return { isBot: true, confidence: "high", reasons };
  }

  if (hostedByAsn) {
    return { isBot: true, confidence: "medium", reasons };
  }
  if (
    networkServiceAsn &&
    (missingBrowserProvenance || reasons.includes("origin_hostname_mismatch"))
  ) {
    return { isBot: true, confidence: "medium", reasons };
  }

  return reasons.length > 0
    ? { isBot: false, confidence: "low", reasons }
    : EMPTY_CLASSIFICATION;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function latitude(cf: Record<string, unknown>): number {
  return coerceNumber(cf.latitude, 0) ?? 0;
}

function longitude(cf: Record<string, unknown>): number {
  return coerceNumber(cf.longitude, 0) ?? 0;
}

export function writeBotAnalyticsEvent(
  env: Env,
  input: BotAnalyticsInput,
  logger?: Pick<InvocationLogger, "warn" | "error">,
): void {
  if (isAnalyticsEngineDisabled(env)) {
    return;
  }

  const dataset = env.BOT_ANALYTICS;
  if (!dataset) {
    logger?.warn("collect.bot_analytics_missing_binding");
    return;
  }

  const request = input.request;
  const cf = requestCf(request);
  const userAgent = requestHeader(request, "user-agent", 1024);
  const asn = coerceNumber(cf.asn, 0) ?? 0;
  const rayId = requestHeader(request, "cf-ray", 120);
  const metadata = {
    rayId,
    requestUrl: request.url,
    requestPathname: requestPathname(request),
    requestMethod: request.method,
    referer: requestHeader(request, "referer", 2048),
    secFetchSite: requestHeader(request, "sec-fetch-site", 40),
    secFetchMode: requestHeader(request, "sec-fetch-mode", 40),
    secFetchDest: requestHeader(request, "sec-fetch-dest", 40),
    httpProtocol: clampString(coerceString(cf.httpProtocol || ""), 40),
    tlsVersion: clampString(coerceString(cf.tlsVersion || ""), 40),
    tlsCipher: clampString(coerceString(cf.tlsCipher || ""), 120),
    tlsClientExtensionsSha1: clampString(
      coerceString(cf.tlsClientExtensionsSha1 || ""),
      160,
    ),
    tlsClientHelloLength: clampString(
      coerceString(cf.tlsClientHelloLength || ""),
      40,
    ),
    requestPriority: clampString(coerceString(cf.requestPriority || ""), 160),
    clientTcpRtt: coerceNumber(cf.clientTcpRtt, null),
    clientQuicRtt: coerceNumber(cf.clientQuicRtt, null),
    botManagement:
      cf.botManagement && typeof cf.botManagement === "object"
        ? cf.botManagement
        : null,
    eventId: clampString(coerceString(input.payload.eventId || ""), 128),
    previousVisitId: clampString(
      coerceString(input.payload.previousVisitId || ""),
      128,
    ),
  };

  try {
    dataset.writeDataPoint({
      indexes: [input.siteId || "unknown"],
      blobs: [
        input.siteId,
        clampString(coerceString(input.payload.kind || ""), 40),
        input.classification.confidence,
        input.classification.reasons.join(","),
        requestIp(request),
        userAgent,
        input.origin || "",
        payloadHostname(input.payload),
        payloadPathname(input.payload),
        clampString(coerceString(cf.country || ""), 10),
        clampString(coerceString(cf.region || ""), 128),
        clampString(coerceString(cf.city || ""), 128),
        clampString(coerceString(cf.continent || ""), 32),
        clampString(coerceString(cf.colo || ""), 16),
        String(Math.trunc(asn)),
        clampString(coerceString(cf.asOrganization || ""), 255),
        cfVerifiedBotCategory(cf),
        rayId,
        input.traceId,
        safeJson(metadata),
      ],
      doubles: [
        input.receivedAt,
        asn,
        latitude(cf),
        longitude(cf),
        cfBotScore(cf) ?? 0,
        userAgent.length,
      ],
    });
  } catch (error) {
    void error;
    logger?.error("collect.bot_analytics_write_failed");
  }
}
