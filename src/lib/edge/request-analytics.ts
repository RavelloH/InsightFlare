import { isAnalyticsEngineDisabled } from "./analytics-engine";
import type { InvocationLogger } from "./observability-logger";
import type { Env, TrackerClientPayload } from "./types";
import { clampString, coerceNumber, coerceString } from "./utils";

export interface NormalAnalyticsInput {
  request: Request;
  payload: TrackerClientPayload;
  siteId: string;
  origin: string | null;
  traceId: string;
  receivedAt: number;
}

export const NORMAL_ANALYTICS_BLOBS = [
  "siteId",
  "kind",
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
  "rayId",
  "traceId",
  "requestMethod",
  "metadataJson",
] as const;

export const NORMAL_ANALYTICS_DOUBLES = [
  "receivedAt",
  "eventAt",
  "edgeLatencyMs",
  "asn",
  "latitude",
  "longitude",
  "userAgentLength",
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

function latitude(cf: Record<string, unknown>): number {
  return coerceNumber(cf.latitude, 0) ?? 0;
}

function longitude(cf: Record<string, unknown>): number {
  return coerceNumber(cf.longitude, 0) ?? 0;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function payloadEventAt(
  payload: TrackerClientPayload,
  receivedAt: number,
): number {
  const candidates =
    payload.kind === "pageview"
      ? [payload.startedAt, payload.timestamp]
      : [payload.timestamp, payload.startedAt];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return receivedAt;
}

export function writeNormalAnalyticsEvent(
  env: Env,
  input: NormalAnalyticsInput,
  logger?: Pick<InvocationLogger, "warn" | "error"> &
    Partial<Pick<InvocationLogger, "info">>,
): void {
  if (isAnalyticsEngineDisabled(env)) {
    return;
  }

  const dataset = env.NORMAL_ANALYTICS;
  if (!dataset) {
    logger?.warn("collect.normal_analytics_missing_binding");
    return;
  }

  const request = input.request;
  const cf = requestCf(request);
  const userAgent = requestHeader(request, "user-agent", 1024);
  const asn = coerceNumber(cf.asn, 0) ?? 0;
  const rayId = requestHeader(request, "cf-ray", 120);
  const eventAt = payloadEventAt(input.payload, input.receivedAt);
  const metadata = {
    eventId: clampString(coerceString(input.payload.eventId || ""), 128),
    visitId: clampString(coerceString(input.payload.visitId || ""), 128),
    previousVisitId: clampString(
      coerceString(input.payload.previousVisitId || ""),
      128,
    ),
    hasVisitorId: Boolean(input.payload.visitorId),
    hasUserId: Boolean(input.payload.userId),
    eventName: clampString(coerceString(input.payload.eventName || ""), 120),
    visibilityState: clampString(
      coerceString(input.payload.visibilityState || ""),
      20,
    ),
    secFetchSite: requestHeader(request, "sec-fetch-site", 40),
    secFetchMode: requestHeader(request, "sec-fetch-mode", 40),
    secFetchDest: requestHeader(request, "sec-fetch-dest", 40),
    httpProtocol: clampString(coerceString(cf.httpProtocol || ""), 40),
  };
  // Client event timestamps use the browser clock, which may be ahead of the
  // worker clock. Measure the collector's server-side processing time instead
  // so clock skew cannot turn every latency value into zero.
  const edgeLatencyMs = Math.max(0, Date.now() - input.receivedAt);

  try {
    dataset.writeDataPoint({
      indexes: [input.siteId || "unknown"],
      blobs: [
        input.siteId,
        clampString(coerceString(input.payload.kind || ""), 40),
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
        rayId,
        input.traceId,
        clampString(request.method, 16),
        safeJson(metadata),
      ],
      doubles: [
        input.receivedAt,
        eventAt,
        edgeLatencyMs,
        asn,
        latitude(cf),
        longitude(cf),
        userAgent.length,
      ],
    });
    logger?.info?.("collect.normal_analytics_written");
  } catch (error) {
    void error;
    logger?.error("collect.normal_analytics_write_failed");
  }
}
