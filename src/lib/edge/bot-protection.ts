import { classifyASN } from "asn-blocklist";
import { isbot } from "isbot";

import type { TrackerClientPayload } from "./types";
import { clampString, coerceNumber, coerceString, safeHostname } from "./utils";

export type BotClassificationCategory = "normal" | "suspected_bot" | "bot";
export interface BotClassification {
  category: BotClassificationCategory;
  reasons: string[];
}

const EMPTY_CLASSIFICATION: BotClassification = {
  category: "normal",
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
    return { category: "bot", reasons };
  }

  return reasons.length > 0
    ? { category: "suspected_bot", reasons }
    : EMPTY_CLASSIFICATION;
}
