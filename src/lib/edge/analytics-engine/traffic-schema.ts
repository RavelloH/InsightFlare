import {
  ANALYTICS_ENGINE_INDEXES,
  ANALYTICS_ENGINE_SCHEMA_VERSION,
} from "./schema";

export const TRAFFIC_ANALYTICS_SCHEMA_VERSION = ANALYTICS_ENGINE_SCHEMA_VERSION;
export const TRAFFIC_ANALYTICS_INDEXES = ANALYTICS_ENGINE_INDEXES;

export const TRAFFIC_ANALYTICS_BLOBS = [
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
  "timezone",
  "asOrganization",
  "extraJson",
] as const;

export const TRAFFIC_ANALYTICS_DOUBLES = [
  "factType",
  "factAt",
  "receivedAt",
  "startedAt",
  "endedAt",
  "durationMs",
  "sessionPageIndex",
  "sessionViewCount",
  "latitude",
  "longitude",
  "screenWidth",
  "screenHeight",
  "ttfbMs",
  "fcpMs",
  "lcpMs",
  "cls",
  "inpMs",
  "dimensionCode",
  "flags",
  "schemaVersion",
] as const;

export const TRAFFIC_ANALYTICS_BLOB_COUNT =
  TRAFFIC_ANALYTICS_BLOBS.length as 20;
export const TRAFFIC_ANALYTICS_DOUBLE_COUNT =
  TRAFFIC_ANALYTICS_DOUBLES.length as 20;
export const TRAFFIC_ANALYTICS_BLOB_SLOT_COUNT = TRAFFIC_ANALYTICS_BLOB_COUNT;
export const TRAFFIC_ANALYTICS_DOUBLE_SLOT_COUNT =
  TRAFFIC_ANALYTICS_DOUBLE_COUNT;

export const TRAFFIC_ANALYTICS_BLOB_SLOTS = {
  visitId: 1,
  visitorId: 2,
  sessionId: 3,
  pathname: 4,
  title: 5,
  hostname: 6,
  referrerHost: 7,
  utmSource: 8,
  utmMedium: 9,
  utmCampaign: 10,
  browser: 11,
  browserVersion: 12,
  os: 13,
  osVersion: 14,
  language: 15,
  region: 16,
  city: 17,
  timezone: 18,
  asOrganization: 19,
  extraJson: 20,
} as const;

export const TRAFFIC_ANALYTICS_DOUBLE_SLOTS = {
  factType: 1,
  factAt: 2,
  receivedAt: 3,
  startedAt: 4,
  endedAt: 5,
  durationMs: 6,
  sessionPageIndex: 7,
  sessionViewCount: 8,
  latitude: 9,
  longitude: 10,
  screenWidth: 11,
  screenHeight: 12,
  ttfbMs: 13,
  fcpMs: 14,
  lcpMs: 15,
  cls: 16,
  inpMs: 17,
  dimensionCode: 18,
  flags: 19,
  schemaVersion: 20,
} as const;

export const TRAFFIC_FACT_TYPES = {
  pageview: 1,
  visit_finalized: 2,
  session_ended: 3,
} as const;
export const TRAFFIC_FACT_TYPE = TRAFFIC_FACT_TYPES;
export const TRAFFIC_FACT_TYPE_PAGEVIEW = TRAFFIC_FACT_TYPES.pageview;
export const TRAFFIC_FACT_TYPE_VISIT_FINALIZED =
  TRAFFIC_FACT_TYPES.visit_finalized;
export const TRAFFIC_FACT_TYPE_SESSION_ENDED = TRAFFIC_FACT_TYPES.session_ended;
export type TrafficFactKind = keyof typeof TRAFFIC_FACT_TYPES;
export type TrafficFactType = (typeof TRAFFIC_FACT_TYPES)[TrafficFactKind];
