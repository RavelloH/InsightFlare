import { j as jsonResponse } from "@/lib/response";

import type { TrackerPerformancePayload } from "./types";
import { coerceNumber } from "./utils";

export const MAX_CLIENT_EVENT_LAG_MS = 30 * 1000;

export type RealtimeSnapshotRecordKind =
  "pageview" | "custom_event" | "leave" | "visibility" | "identify";

export interface RealtimeSnapshotRecord {
  id: string;
  eventType: string;
  eventKind?: RealtimeSnapshotRecordKind;
  eventAt: number;
  siteId?: string;
  traceId?: string;
  receivedAt?: number | null;
  sequence?: number | null;
  eventId?: string;
  eventName?: string;
  eventDataJson?: string | null;
  visitId: string;
  sessionId: string;
  startedAt?: number | null;
  previousVisitId?: string;
  previousVisitStartedAt?: number | null;
  pathname: string;
  queryString?: string;
  hash: string;
  title: string;
  hostname: string;
  referrerUrl: string;
  referrerHost: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  visitorId: string;
  userId?: string;
  userName?: string;
  isEU?: boolean | number | null;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  continent: string;
  postalCode?: string;
  metroCode?: string;
  timezone: string;
  organization: string;
  uaRaw?: string;
  browser: string;
  browserVersion?: string;
  os: string;
  osVersion: string;
  deviceType: string;
  language: string;
  screenWidth?: number | null;
  screenHeight?: number | null;
  status?: string;
  hiddenAt?: number | null;
  endedAt?: number | null;
  finalizedAt?: number | null;
  durationMs?: number | null;
  durationSource?: string;
  exitReason?: string;
  leaveAt?: number | null;
  performanceVisitId?: string;
  performance?: TrackerPerformancePayload | null;
  visibilityState?: string;
  screenSize?: string;
  latitude: number | null;
  longitude: number | null;
}

export interface RealtimeVisitPayloadInput {
  visitId: string;
  visitorId: string;
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  pathname: string;
  hashFragment: string;
  title: string;
  hostname: string;
  referrerUrl: string;
  referrerHost: string;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  continent: string;
  timezone: string;
  asOrganization: string;
  browser: string;
  os: string;
  osVersion: string;
  deviceType: string;
  language: string;
  screenWidth: number | null;
  screenHeight: number | null;
  latitude: number | null;
  longitude: number | null;
  siteId?: string;
  status?: string;
  queryString?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  isEU?: boolean | number | null;
  postalCode?: string;
  metroCode?: string;
  uaRaw?: string;
  browserVersion?: string;
  userId?: string;
  userName?: string;
  hiddenAt?: number | null;
  endedAt?: number | null;
  finalizedAt?: number | null;
  durationMs?: number | null;
  durationSource?: string;
  exitReason?: string;
  performance?: TrackerPerformancePayload | null;
  perfTtfbMs?: number | null;
  perfFcpMs?: number | null;
  perfLcpMs?: number | null;
  perfCls?: number | null;
  perfInpMs?: number | null;
}

export { jsonResponse };

export function clampTimestamp(input: unknown, fallback: number): number {
  const value = coerceNumber(input, fallback) ?? fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function resolveTrustedClientTimestamp(
  input: unknown,
  receivedAt: number,
  fallback = receivedAt,
): number {
  const value = clampTimestamp(input, fallback);
  if (value > receivedAt) return receivedAt;
  if (receivedAt - value > MAX_CLIENT_EVENT_LAG_MS) return receivedAt;
  return value;
}

export function normalizePerformanceMetric(input: unknown): number | null {
  const value = coerceNumber(input, null);
  if (!Number.isFinite(value) || value == null || value < 0) return null;
  return Math.round(value * 1000) / 1000;
}

export function normalizePerformancePayload(
  input: unknown,
): TrackerPerformancePayload | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const ttfb = normalizePerformanceMetric(source.ttfb);
  const fcp = normalizePerformanceMetric(source.fcp);
  const lcp = normalizePerformanceMetric(source.lcp);
  const cls = normalizePerformanceMetric(source.cls);
  const inp = normalizePerformanceMetric(source.inp);

  if (
    ttfb === null &&
    fcp === null &&
    lcp === null &&
    cls === null &&
    inp === null
  ) {
    return null;
  }

  return {
    ...(ttfb !== null ? { ttfb } : {}),
    ...(fcp !== null ? { fcp } : {}),
    ...(lcp !== null ? { lcp } : {}),
    ...(cls !== null ? { cls } : {}),
    ...(inp !== null ? { inp } : {}),
  };
}

export function toRealtimeScreenSize(
  width: number | null | undefined,
  height: number | null | undefined,
): string {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight)) {
    return "";
  }
  if (safeWidth <= 0 || safeHeight <= 0) {
    return "";
  }
  return `${Math.round(safeWidth)}x${Math.round(safeHeight)}`;
}

export function formatRealtimeOsLabel(os: string, osVersion: string): string {
  const normalizedOs = os.trim();
  const normalizedVersion = osVersion.trim();
  if (normalizedOs && normalizedVersion) {
    return `${normalizedOs} ${normalizedVersion}`;
  }
  return normalizedOs || normalizedVersion;
}

function inferRealtimeEventKind(
  record: RealtimeSnapshotRecord,
): RealtimeSnapshotRecordKind {
  if (record.eventKind) return record.eventKind;
  if (record.eventType === "visit" || record.eventType === "pageview") {
    return "pageview";
  }
  if (record.eventType === "__presence_leave") return "leave";
  return "custom_event";
}

function parseRealtimeJsonValue(input: unknown): unknown {
  if (input === null || input === undefined || input === "") return null;
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function toRealtimePerformance(
  input: RealtimeVisitPayloadInput,
): TrackerPerformancePayload | null {
  const values = {
    ttfb: input.perfTtfbMs,
    fcp: input.perfFcpMs,
    lcp: input.perfLcpMs,
    cls: input.perfCls,
    inp: input.perfInpMs,
  };
  const hasValue = Object.values(values).some(
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  if (!hasValue) return null;
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => typeof value === "number" && Number.isFinite(value),
    ),
  ) as TrackerPerformancePayload;
}

export function toRealtimePayload(
  record: RealtimeSnapshotRecord,
): Record<string, unknown> {
  const eventKind = inferRealtimeEventKind(record);
  return {
    id: record.id,
    eventType: record.eventType,
    eventKind,
    eventAt: record.eventAt,
    siteId: record.siteId ?? "",
    traceId: record.traceId ?? "",
    receivedAt: record.receivedAt ?? null,
    sequence: record.sequence ?? null,
    eventId: record.eventId ?? (eventKind === "custom_event" ? record.id : ""),
    eventName:
      record.eventName ??
      (eventKind === "custom_event" ? record.eventType : ""),
    eventData: parseRealtimeJsonValue(record.eventDataJson) ?? {},
    visitId: record.visitId,
    sessionId: record.sessionId,
    startedAt: record.startedAt ?? null,
    previousVisitId: record.previousVisitId ?? "",
    previousVisitStartedAt: record.previousVisitStartedAt ?? null,
    pathname: record.pathname,
    queryString: record.queryString ?? "",
    hash: record.hash,
    title: record.title,
    hostname: record.hostname,
    referrerUrl: record.referrerUrl,
    referrerHost: record.referrerHost,
    utmSource: record.utmSource ?? "",
    utmMedium: record.utmMedium ?? "",
    utmCampaign: record.utmCampaign ?? "",
    utmTerm: record.utmTerm ?? "",
    utmContent: record.utmContent ?? "",
    visitorId: record.visitorId,
    userId: record.userId ?? "",
    userName: record.userName ?? "",
    isEU:
      record.isEU === undefined || record.isEU === null
        ? null
        : Boolean(record.isEU),
    country: record.country,
    region: record.region,
    regionCode: record.regionCode,
    city: record.city,
    continent: record.continent,
    postalCode: record.postalCode ?? "",
    metroCode: record.metroCode ?? "",
    timezone: record.timezone,
    organization: record.organization,
    uaRaw: record.uaRaw ?? "",
    browser: record.browser,
    browserVersion: record.browserVersion ?? "",
    os: record.os,
    osVersion: record.osVersion,
    deviceType: record.deviceType,
    screenWidth: record.screenWidth ?? null,
    screenHeight: record.screenHeight ?? null,
    language: record.language,
    screenSize:
      record.screenSize ??
      toRealtimeScreenSize(record.screenWidth, record.screenHeight),
    status: record.status ?? "",
    hiddenAt: record.hiddenAt ?? null,
    endedAt: record.endedAt ?? null,
    finalizedAt: record.finalizedAt ?? null,
    durationMs: record.durationMs ?? null,
    durationSource: record.durationSource ?? "",
    exitReason: record.exitReason ?? "",
    leaveAt: record.leaveAt ?? null,
    performanceVisitId: record.performanceVisitId ?? "",
    performance: parseRealtimeJsonValue(record.performance),
    visibilityState: record.visibilityState ?? "",
    latitude: record.latitude,
    longitude: record.longitude,
  };
}

export function toRealtimeVisitPayload(
  visit: RealtimeVisitPayloadInput,
): Record<string, unknown> {
  return {
    visitId: visit.visitId,
    visitorId: visit.visitorId,
    sessionId: visit.sessionId,
    startedAt: visit.startedAt,
    lastActivityAt: visit.lastActivityAt,
    pathname: visit.pathname,
    hash: visit.hashFragment,
    title: visit.title,
    hostname: visit.hostname,
    referrerUrl: visit.referrerUrl,
    referrerHost: visit.referrerHost,
    country: visit.country,
    region: visit.region,
    regionCode: visit.regionCode,
    city: visit.city,
    continent: visit.continent,
    timezone: visit.timezone,
    organization: visit.asOrganization,
    browser: visit.browser,
    browserVersion: visit.browserVersion ?? "",
    os: visit.os,
    osVersion: visit.osVersion,
    deviceType: visit.deviceType,
    language: visit.language,
    siteId: visit.siteId ?? "",
    status: visit.status ?? "",
    queryString: visit.queryString ?? "",
    utmSource: visit.utmSource ?? "",
    utmMedium: visit.utmMedium ?? "",
    utmCampaign: visit.utmCampaign ?? "",
    utmTerm: visit.utmTerm ?? "",
    utmContent: visit.utmContent ?? "",
    isEU:
      visit.isEU === undefined || visit.isEU === null
        ? null
        : Boolean(visit.isEU),
    postalCode: visit.postalCode ?? "",
    metroCode: visit.metroCode ?? "",
    uaRaw: visit.uaRaw ?? "",
    userId: visit.userId ?? "",
    userName: visit.userName ?? "",
    screenWidth: visit.screenWidth,
    screenHeight: visit.screenHeight,
    screenSize: toRealtimeScreenSize(visit.screenWidth, visit.screenHeight),
    hiddenAt: visit.hiddenAt ?? null,
    endedAt: visit.endedAt ?? null,
    finalizedAt: visit.finalizedAt ?? null,
    durationMs: visit.durationMs ?? null,
    durationSource: visit.durationSource ?? "",
    exitReason: visit.exitReason ?? "",
    performance: visit.performance ?? toRealtimePerformance(visit),
    latitude: visit.latitude,
    longitude: visit.longitude,
  };
}
