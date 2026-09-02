import { isAnalyticsEngineDisabled } from "@/lib/edge/analytics-engine";
import { expandCustomEventDataJson } from "@/lib/edge/custom-event-json";
import type { InvocationLogger } from "@/lib/edge/observability-logger";
import type { Env, NormalizedCustomEvent } from "@/lib/edge/types";

import { EVENT_ANALYTICS_SCHEMA_VERSION } from "./event-schema";
import { encodeDimensionCode } from "./schema";
import { clampString, finiteNumber, stringValue } from "./writer-utils";

export type EventAnalyticsEnvironment = Env & {
  EVENT_ANALYTICS?: AnalyticsEngineDataset;
};

export type EventAnalyticsLogger = Pick<InvocationLogger, "warn" | "error"> &
  Partial<Pick<InvocationLogger, "info">>;

export const EVENT_FLAG_EVENT_AT_PRESENT = 1 << 0;
export const EVENT_FLAG_SEQUENCE_PRESENT = 1 << 1;
export const EVENT_FLAG_COORDINATE_PRESENT = 1 << 2;
export const EVENT_FLAG_SCREEN_DIMENSIONS_PRESENT = 1 << 3;

export function hasEventFlag(flags: number, flag: number): boolean {
  return Number.isFinite(flags) && (Math.trunc(flags) & flag) === flag;
}

function numberOrZero(value: number | null | undefined): number {
  return finiteNumber(value) ?? 0;
}

function stringOrEmpty(value: unknown, maxLength: number): string {
  return stringValue(value, maxLength);
}

function payloadJson(record: NormalizedCustomEvent): {
  json: string;
  nodeCount: number;
  valueCount: number;
} {
  let eventData: unknown = {};
  let nodeCount = 0;
  let valueCount = 0;
  try {
    const parsed = JSON.parse(record.eventDataJson) as unknown;
    eventData = parsed;
    const expanded = expandCustomEventDataJson(record.eventDataJson);
    if (expanded.ok) {
      nodeCount = expanded.data.nodes.length;
      valueCount = expanded.data.values.length;
    }
  } catch {
    // Normalization already validates this JSON. Keep the writer defensive so
    // a malformed test or a future caller can never break ingest.
  }
  let json = "{}";
  try {
    // eventDataJson was validated by normalization and is intentionally not
    // passed through the metadata serializer: the event projection must keep
    // the complete custom-event payload.
    json = JSON.stringify({
      eventData,
      queryString: record.queryString,
      hashFragment: record.hashFragment,
      referrerUrl: record.referrerUrl,
      utmTerm: record.utmTerm,
      utmContent: record.utmContent,
      timezone: record.timezone,
      asOrganization: record.asOrganization,
      browserEngine: "",
      regionCode: record.regionCode,
    });
  } catch {
    json = JSON.stringify({ eventData: {} });
  }
  return {
    json,
    nodeCount,
    valueCount,
  };
}

export function writeEventAnalyticsPoint(
  env: EventAnalyticsEnvironment,
  record: NormalizedCustomEvent,
  logger?: EventAnalyticsLogger,
): void {
  if (isAnalyticsEngineDisabled(env)) return;
  const dataset = env.EVENT_ANALYTICS;
  if (!dataset) {
    logger?.warn("ingest.event_analytics_missing_binding");
    return;
  }

  const payload = payloadJson(record);
  let flags = EVENT_FLAG_EVENT_AT_PRESENT;
  if (Number.isFinite(record.sequence)) flags |= EVENT_FLAG_SEQUENCE_PRESENT;
  if (record.latitude !== null && record.longitude !== null) {
    flags |= EVENT_FLAG_COORDINATE_PRESENT;
  }
  if (record.screenWidth !== null && record.screenHeight !== null) {
    flags |= EVENT_FLAG_SCREEN_DIMENSIONS_PRESENT;
  }

  try {
    dataset.writeDataPoint({
      indexes: [clampString(record.siteId, 255) || "unknown"],
      blobs: [
        stringOrEmpty(record.eventName, 120),
        stringOrEmpty(record.eventId, 128),
        stringOrEmpty(record.visitId, 128),
        stringOrEmpty(record.visitorId, 128),
        stringOrEmpty(record.sessionId, 128),
        stringOrEmpty(record.pathname, 2_048),
        stringOrEmpty(record.title, 512),
        stringOrEmpty(record.hostname, 255),
        stringOrEmpty(record.referrerHost, 255),
        stringOrEmpty(record.utmSource, 512),
        stringOrEmpty(record.utmMedium, 512),
        stringOrEmpty(record.utmCampaign, 512),
        stringOrEmpty(record.browser, 80),
        stringOrEmpty(record.browserVersion, 80),
        stringOrEmpty(record.os, 80),
        stringOrEmpty(record.osVersion, 80),
        stringOrEmpty(record.language, 80),
        stringOrEmpty(record.region, 128),
        stringOrEmpty(record.city, 128),
        payload.json,
      ],
      doubles: [
        numberOrZero(record.eventAt),
        numberOrZero(record.receivedAt),
        numberOrZero(record.startedAt),
        numberOrZero(record.sequence),
        record.latitude ?? 0,
        record.longitude ?? 0,
        record.screenWidth ?? 0,
        record.screenHeight ?? 0,
        encodeDimensionCode("country", record.country) ||
          encodeDimensionCode("continent", record.continent) ||
          encodeDimensionCode("deviceType", record.deviceType),
        flags,
        payload.nodeCount,
        payload.valueCount,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        EVENT_ANALYTICS_SCHEMA_VERSION,
      ],
    });
    logger?.info?.("ingest.event_analytics_written");
  } catch {
    logger?.error("ingest.event_analytics_write_failed");
  }
}
