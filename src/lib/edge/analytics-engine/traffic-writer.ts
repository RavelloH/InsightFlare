import { isAnalyticsEngineDisabled } from "@/lib/edge/analytics-engine";
import type { AnalyticsSessionState } from "@/lib/edge/analytics-session-state";
import type { BufferedVisitRow } from "@/lib/edge/ingest-types";
import type { InvocationLogger } from "@/lib/edge/observability-logger";
import type { Env, NormalizedPageview } from "@/lib/edge/types";

import { type DimensionFamily, encodeDimensionCode } from "./schema";
import {
  TRAFFIC_ANALYTICS_SCHEMA_VERSION,
  TRAFFIC_FACT_TYPES,
} from "./traffic-schema";
import {
  clampString,
  finiteNumber,
  safeStringify,
  stringValue,
} from "./writer-utils";

export type TrafficAnalyticsEnvironment = Env & {
  TRAFFIC_ANALYTICS?: AnalyticsEngineDataset;
};

export type TrafficAnalyticsLogger = Pick<InvocationLogger, "warn" | "error"> &
  Partial<Pick<InvocationLogger, "info">>;

export interface TrafficPageviewInput {
  record: NormalizedPageview;
  sessionPageIndex: number;
  sessionViewCount?: number;
}

export interface TrafficVisitFinalizedInput {
  visit: TrafficVisitSnapshot;
  receivedAt: number;
  /** The transition timestamp. Usually the row's finalizedAt/endedAt. */
  endedAt?: number | null;
  durationMs?: number | null;
  durationSource?: string;
  exitReason?: string;
}

export interface TrafficVisitSnapshot {
  siteId: string;
  visitId: string;
  visitorId: string;
  sessionId: string;
  startedAt: number;
  pathname: string;
  queryString: string;
  hashFragment: string;
  title: string;
  hostname: string;
  referrerUrl: string;
  referrerHost: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  region: string;
  city: string;
  continent: string;
  country: string;
  regionCode: string;
  postalCode: string;
  metroCode: string;
  timezone: string;
  asOrganization: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  language: string;
  latitude: number | null;
  longitude: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  perfTtfbMs?: number | null;
  perfFcpMs?: number | null;
  perfLcpMs?: number | null;
  perfCls?: number | null;
  perfInpMs?: number | null;
}

export interface TrafficSessionEndedInput extends AnalyticsSessionState {
  siteId: string;
  receivedAt: number;
  endedAt: number;
  /** Optional last visit snapshot; it provides dimensions after cleanup. */
  lastVisit?: Pick<
    BufferedVisitRow,
    | "title"
    | "hostname"
    | "referrerHost"
    | "utmSource"
    | "utmMedium"
    | "utmCampaign"
    | "browser"
    | "browserVersion"
    | "os"
    | "osVersion"
    | "language"
    | "region"
    | "city"
    | "timezone"
    | "asOrganization"
    | "latitude"
    | "longitude"
    | "screenWidth"
    | "screenHeight"
  >;
}

export const TRAFFIC_FLAG_DURATION_PRESENT = 1 << 0;
export const TRAFFIC_FLAG_SESSION_PAGE_INDEX_PRESENT = 1 << 1;
export const TRAFFIC_FLAG_SESSION_VIEW_COUNT_PRESENT = 1 << 2;
export const TRAFFIC_FLAG_COORDINATE_PRESENT = 1 << 3;
export const TRAFFIC_FLAG_SCREEN_DIMENSIONS_PRESENT = 1 << 4;
export const TRAFFIC_FLAG_TTFB_PRESENT = 1 << 5;
export const TRAFFIC_FLAG_FCP_PRESENT = 1 << 6;
export const TRAFFIC_FLAG_LCP_PRESENT = 1 << 7;
export const TRAFFIC_FLAG_CLS_PRESENT = 1 << 8;
export const TRAFFIC_FLAG_INP_PRESENT = 1 << 9;

export function hasTrafficFlag(flags: number, flag: number): boolean {
  return Number.isFinite(flags) && (Math.trunc(flags) & flag) === flag;
}

function valueOrZero(value: number | null | undefined): number {
  return finiteNumber(value) ?? 0;
}

function optionalString(value: unknown, maxLength: number): string {
  return stringValue(value, maxLength);
}

function dimensionCodeFor(
  country: string,
  continent: string,
  deviceType: string,
): number {
  const candidates: Array<[DimensionFamily, string]> = [
    ["country", country],
    ["continent", continent],
    ["deviceType", deviceType],
  ];
  for (const [dimension, value] of candidates) {
    const code = encodeDimensionCode(dimension, value);
    if (code > 0) return code;
  }
  return 0;
}

function pointExtraJson(
  context: Pick<
    BufferedVisitRow,
    | "queryString"
    | "hashFragment"
    | "referrerUrl"
    | "utmTerm"
    | "utmContent"
    | "browser"
    | "regionCode"
    | "postalCode"
    | "metroCode"
    | "durationSource"
    | "exitReason"
  >,
): string {
  return safeStringify({
    queryString: optionalString(context.queryString, 4_096),
    hashFragment: optionalString(context.hashFragment, 2_048),
    referrerUrl: optionalString(context.referrerUrl, 2_048),
    utmTerm: optionalString(context.utmTerm, 512),
    utmContent: optionalString(context.utmContent, 512),
    browserEngine: "",
    regionCode: optionalString(context.regionCode, 128),
    postalCode: optionalString(context.postalCode, 32),
    metroCode: optionalString(context.metroCode, 32),
    durationSource: optionalString(context.durationSource, 40),
    exitReason: optionalString(context.exitReason, 80),
  });
}

function writeTrafficPoint(
  env: TrafficAnalyticsEnvironment,
  point: { indexes: [string]; blobs: string[]; doubles: number[] },
  logger?: TrafficAnalyticsLogger,
): void {
  if (isAnalyticsEngineDisabled(env)) return;
  const dataset = env.TRAFFIC_ANALYTICS;
  if (!dataset) {
    logger?.warn("ingest.traffic_analytics_missing_binding");
    return;
  }
  try {
    dataset.writeDataPoint(point);
    logger?.info?.("ingest.traffic_analytics_written");
  } catch {
    logger?.error("ingest.traffic_analytics_write_failed");
  }
}

export function writeTrafficPageviewFact(
  env: TrafficAnalyticsEnvironment,
  input: TrafficPageviewInput,
  logger?: TrafficAnalyticsLogger,
): void {
  const record = input.record;
  const sessionPageIndex = Math.max(0, Math.trunc(input.sessionPageIndex));
  const sessionViewCount = Math.max(
    0,
    Math.trunc(input.sessionViewCount ?? sessionPageIndex),
  );
  let flags = TRAFFIC_FLAG_SESSION_PAGE_INDEX_PRESENT;
  if (sessionViewCount > 0) flags |= TRAFFIC_FLAG_SESSION_VIEW_COUNT_PRESENT;
  if (record.latitude !== null && record.longitude !== null) {
    flags |= TRAFFIC_FLAG_COORDINATE_PRESENT;
  }
  if (record.screenWidth !== null && record.screenHeight !== null) {
    flags |= TRAFFIC_FLAG_SCREEN_DIMENSIONS_PRESENT;
  }

  const extraJson = safeStringify({
    queryString: record.queryString,
    hashFragment: record.hashFragment,
    referrerUrl: record.referrerUrl,
    utmTerm: record.utmTerm,
    utmContent: record.utmContent,
    browserEngine: "",
    regionCode: record.regionCode,
    postalCode: record.postalCode,
    metroCode: record.metroCode,
    durationSource: "",
    exitReason: "",
  });

  writeTrafficPoint(
    env,
    {
      indexes: [clampString(record.siteId, 255) || "unknown"],
      blobs: [
        optionalString(record.visitId, 128),
        optionalString(record.visitorId, 128),
        optionalString(record.sessionId, 128),
        optionalString(record.pathname, 2_048),
        optionalString(record.title, 512),
        optionalString(record.hostname, 255),
        optionalString(record.referrerHost, 255),
        optionalString(record.utmSource, 512),
        optionalString(record.utmMedium, 512),
        optionalString(record.utmCampaign, 512),
        optionalString(record.browser, 80),
        optionalString(record.browserVersion, 80),
        optionalString(record.os, 80),
        optionalString(record.osVersion, 80),
        optionalString(record.language, 80),
        optionalString(record.region, 128),
        optionalString(record.city, 128),
        optionalString(record.timezone, 80),
        optionalString(record.asOrganization, 255),
        extraJson,
      ],
      doubles: [
        TRAFFIC_FACT_TYPES.pageview,
        valueOrZero(record.startedAt),
        valueOrZero(record.receivedAt),
        valueOrZero(record.startedAt),
        0,
        0,
        sessionPageIndex,
        sessionViewCount,
        record.latitude ?? 0,
        record.longitude ?? 0,
        record.screenWidth ?? 0,
        record.screenHeight ?? 0,
        0,
        0,
        0,
        0,
        0,
        dimensionCodeFor(record.country, record.continent, record.deviceType),
        flags,
        TRAFFIC_ANALYTICS_SCHEMA_VERSION,
      ],
    },
    logger,
  );
}

export function writeTrafficVisitFinalizedFact(
  env: TrafficAnalyticsEnvironment,
  input: TrafficVisitFinalizedInput,
  logger?: TrafficAnalyticsLogger,
): void {
  const visit = input.visit;
  const endedAt = input.endedAt;
  const durationMs = input.durationMs;
  const durationSource = input.durationSource ?? "";
  const exitReason = input.exitReason ?? "";
  let flags = 0;
  if (durationMs !== null && durationMs !== undefined) {
    flags |= TRAFFIC_FLAG_DURATION_PRESENT;
  }
  if (visit.latitude !== null && visit.longitude !== null) {
    flags |= TRAFFIC_FLAG_COORDINATE_PRESENT;
  }
  if (visit.screenWidth !== null && visit.screenHeight !== null) {
    flags |= TRAFFIC_FLAG_SCREEN_DIMENSIONS_PRESENT;
  }
  const performance = [
    visit.perfTtfbMs,
    visit.perfFcpMs,
    visit.perfLcpMs,
    visit.perfCls,
    visit.perfInpMs,
  ];
  const performanceFlags = [
    TRAFFIC_FLAG_TTFB_PRESENT,
    TRAFFIC_FLAG_FCP_PRESENT,
    TRAFFIC_FLAG_LCP_PRESENT,
    TRAFFIC_FLAG_CLS_PRESENT,
    TRAFFIC_FLAG_INP_PRESENT,
  ];
  for (let i = 0; i < performance.length; i += 1) {
    if (performance[i] !== null && performance[i] !== undefined) {
      flags |= performanceFlags[i]!;
    }
  }

  writeTrafficPoint(
    env,
    {
      indexes: [clampString(visit.siteId, 255) || "unknown"],
      blobs: [
        optionalString(visit.visitId, 128),
        optionalString(visit.visitorId, 128),
        optionalString(visit.sessionId, 128),
        optionalString(visit.pathname, 2_048),
        optionalString(visit.title, 512),
        optionalString(visit.hostname, 255),
        optionalString(visit.referrerHost, 255),
        optionalString(visit.utmSource, 512),
        optionalString(visit.utmMedium, 512),
        optionalString(visit.utmCampaign, 512),
        optionalString(visit.browser, 80),
        optionalString(visit.browserVersion, 80),
        optionalString(visit.os, 80),
        optionalString(visit.osVersion, 80),
        optionalString(visit.language, 80),
        optionalString(visit.region, 128),
        optionalString(visit.city, 128),
        optionalString(visit.timezone, 80),
        optionalString(visit.asOrganization, 255),
        pointExtraJson({
          queryString: visit.queryString,
          hashFragment: visit.hashFragment,
          referrerUrl: visit.referrerUrl,
          utmTerm: visit.utmTerm,
          utmContent: visit.utmContent,
          browser: visit.browser,
          regionCode: visit.regionCode,
          postalCode: visit.postalCode,
          metroCode: visit.metroCode,
          durationSource,
          exitReason,
        }),
      ],
      doubles: [
        TRAFFIC_FACT_TYPES.visit_finalized,
        valueOrZero(endedAt ?? input.receivedAt),
        valueOrZero(input.receivedAt),
        valueOrZero(visit.startedAt),
        valueOrZero(endedAt),
        valueOrZero(durationMs),
        0,
        0,
        visit.latitude ?? 0,
        visit.longitude ?? 0,
        visit.screenWidth ?? 0,
        visit.screenHeight ?? 0,
        valueOrZero(visit.perfTtfbMs),
        valueOrZero(visit.perfFcpMs),
        valueOrZero(visit.perfLcpMs),
        valueOrZero(visit.perfCls),
        valueOrZero(visit.perfInpMs),
        dimensionCodeFor(visit.country, visit.continent, visit.deviceType),
        flags,
        TRAFFIC_ANALYTICS_SCHEMA_VERSION,
      ],
    },
    logger,
  );
}

export function writeTrafficSessionEndedFact(
  env: TrafficAnalyticsEnvironment,
  input: TrafficSessionEndedInput,
  logger?: TrafficAnalyticsLogger,
): void {
  const lastVisit = input.lastVisit;
  let flags = TRAFFIC_FLAG_SESSION_VIEW_COUNT_PRESENT;
  if (
    lastVisit &&
    lastVisit.latitude !== null &&
    lastVisit.longitude !== null
  ) {
    flags |= TRAFFIC_FLAG_COORDINATE_PRESENT;
  }
  if (
    lastVisit &&
    lastVisit.screenWidth !== null &&
    lastVisit.screenHeight !== null
  ) {
    flags |= TRAFFIC_FLAG_SCREEN_DIMENSIONS_PRESENT;
  }
  const extraJson = safeStringify({
    queryString: "",
    hashFragment: "",
    referrerUrl: "",
    utmTerm: "",
    utmContent: "",
    browserEngine: "",
    regionCode: "",
    postalCode: "",
    metroCode: "",
    durationSource: "session_timeout",
    exitReason: "session_timeout",
    entryPath: input.entryPath,
  });

  writeTrafficPoint(
    env,
    {
      indexes: [clampString(input.siteId, 255) || "unknown"],
      blobs: [
        optionalString(input.lastVisitId, 128),
        optionalString(input.visitorId, 128),
        optionalString(input.sessionId, 128),
        optionalString(input.lastPath, 2_048),
        optionalString(lastVisit?.title, 512),
        optionalString(lastVisit?.hostname, 255),
        optionalString(lastVisit?.referrerHost, 255),
        optionalString(lastVisit?.utmSource, 512),
        optionalString(lastVisit?.utmMedium, 512),
        optionalString(lastVisit?.utmCampaign, 512),
        optionalString(lastVisit?.browser, 80),
        optionalString(lastVisit?.browserVersion, 80),
        optionalString(lastVisit?.os, 80),
        optionalString(lastVisit?.osVersion, 80),
        optionalString(lastVisit?.language, 80),
        optionalString(lastVisit?.region, 128),
        optionalString(lastVisit?.city, 128),
        optionalString(lastVisit?.timezone, 80),
        optionalString(lastVisit?.asOrganization, 255),
        extraJson,
      ],
      doubles: [
        TRAFFIC_FACT_TYPES.session_ended,
        valueOrZero(input.endedAt),
        valueOrZero(input.receivedAt),
        valueOrZero(input.startedAt),
        valueOrZero(input.endedAt),
        Math.max(0, valueOrZero(input.endedAt) - valueOrZero(input.startedAt)),
        input.pageCount,
        input.pageCount,
        lastVisit?.latitude ?? 0,
        lastVisit?.longitude ?? 0,
        lastVisit?.screenWidth ?? 0,
        lastVisit?.screenHeight ?? 0,
        0,
        0,
        0,
        0,
        0,
        0,
        flags,
        TRAFFIC_ANALYTICS_SCHEMA_VERSION,
      ],
    },
    logger,
  );
}
