import {
  ANALYTICS_ENGINE_INDEXES,
  ANALYTICS_ENGINE_SCHEMA_VERSION,
} from "./schema";

export const EVENT_ANALYTICS_SCHEMA_VERSION = ANALYTICS_ENGINE_SCHEMA_VERSION;
export const EVENT_ANALYTICS_INDEXES = ANALYTICS_ENGINE_INDEXES;

export const EVENT_ANALYTICS_BLOBS = [
  "eventName",
  "eventId",
  "visitId",
  "visitorId",
  "sessionId",
  "pathname",
  "title",
  "hostname",
  "referrerHost",
  "utmSource",
  "utmMedium",
  "utmCampaign",
  "browser",
  "browserVersion",
  "os",
  "osVersion",
  "language",
  "region",
  "city",
  "payloadJson",
] as const;

export const EVENT_ANALYTICS_DOUBLES = [
  "eventAt",
  "receivedAt",
  "visitStartedAt",
  "sequence",
  "latitude",
  "longitude",
  "screenWidth",
  "screenHeight",
  "dimensionCode",
  "flags",
  "nodeCount",
  "valueCount",
  "reserved",
  "reserved",
  "reserved",
  "reserved",
  "reserved",
  "reserved",
  "reserved",
  "schemaVersion",
] as const;

export const EVENT_ANALYTICS_BLOB_COUNT = EVENT_ANALYTICS_BLOBS.length as 20;
export const EVENT_ANALYTICS_DOUBLE_COUNT =
  EVENT_ANALYTICS_DOUBLES.length as 20;
export const EVENT_ANALYTICS_BLOB_SLOT_COUNT = EVENT_ANALYTICS_BLOB_COUNT;
export const EVENT_ANALYTICS_DOUBLE_SLOT_COUNT = EVENT_ANALYTICS_DOUBLE_COUNT;

export const EVENT_ANALYTICS_BLOB_SLOTS = {
  eventName: 1,
  eventId: 2,
  visitId: 3,
  visitorId: 4,
  sessionId: 5,
  pathname: 6,
  title: 7,
  hostname: 8,
  referrerHost: 9,
  utmSource: 10,
  utmMedium: 11,
  utmCampaign: 12,
  browser: 13,
  browserVersion: 14,
  os: 15,
  osVersion: 16,
  language: 17,
  region: 18,
  city: 19,
  payloadJson: 20,
} as const;

export const EVENT_ANALYTICS_DOUBLE_SLOTS = {
  eventAt: 1,
  receivedAt: 2,
  visitStartedAt: 3,
  sequence: 4,
  latitude: 5,
  longitude: 6,
  screenWidth: 7,
  screenHeight: 8,
  dimensionCode: 9,
  flags: 10,
  nodeCount: 11,
  valueCount: 12,
  schemaVersion: 20,
} as const;
