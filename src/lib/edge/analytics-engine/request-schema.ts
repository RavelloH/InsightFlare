import type { TrackerClientPayload } from "@/lib/edge/types";

import {
  ANALYTICS_ENGINE_INDEXES,
  ANALYTICS_ENGINE_SCHEMA_VERSION,
} from "./schema";

export const REQUEST_ANALYTICS_SCHEMA_VERSION = ANALYTICS_ENGINE_SCHEMA_VERSION;
export const REQUEST_ANALYTICS_INDEXES = ANALYTICS_ENGINE_INDEXES;

export const REQUEST_ANALYTICS_BLOBS = [
  "kind",
  "category",
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
  "asOrganization",
  "verifiedBotCategory",
  "rayId",
  "traceId",
  "requestMethod",
  "httpProtocol",
  "metadataJson",
] as const;

export const REQUEST_ANALYTICS_DOUBLES = [
  "receivedAt",
  "eventAt",
  "edgeLatencyMs",
  "asn",
  "latitude",
  "longitude",
  "botScore",
  "userAgentLength",
  "clientTcpRtt",
  "clientQuicRtt",
  "tlsClientHelloLength",
  "reserved",
  "reserved",
  "reserved",
  "reserved",
  "reserved",
  "reserved",
  "reserved",
  "flags",
  "schemaVersion",
] as const;

export const REQUEST_ANALYTICS_BLOB_COUNT =
  REQUEST_ANALYTICS_BLOBS.length as 20;
export const REQUEST_ANALYTICS_DOUBLE_COUNT =
  REQUEST_ANALYTICS_DOUBLES.length as 20;
export const REQUEST_ANALYTICS_BLOB_SLOT_COUNT = REQUEST_ANALYTICS_BLOB_COUNT;
export const REQUEST_ANALYTICS_DOUBLE_SLOT_COUNT =
  REQUEST_ANALYTICS_DOUBLE_COUNT;

export const REQUEST_ANALYTICS_BLOB_SLOTS = {
  kind: 1,
  category: 2,
  reasons: 3,
  ip: 4,
  userAgent: 5,
  origin: 6,
  hostname: 7,
  pathname: 8,
  country: 9,
  region: 10,
  city: 11,
  continent: 12,
  colo: 13,
  asOrganization: 14,
  verifiedBotCategory: 15,
  rayId: 16,
  traceId: 17,
  requestMethod: 18,
  httpProtocol: 19,
  metadataJson: 20,
} as const;

export const REQUEST_ANALYTICS_DOUBLE_SLOTS = {
  receivedAt: 1,
  eventAt: 2,
  edgeLatencyMs: 3,
  asn: 4,
  latitude: 5,
  longitude: 6,
  botScore: 7,
  userAgentLength: 8,
  clientTcpRtt: 9,
  clientQuicRtt: 10,
  tlsClientHelloLength: 11,
  flags: 19,
  schemaVersion: 20,
} as const;

export type RequestAnalyticsCategory =
  | "normal"
  | "medium_threat"
  | "high_threat"
  | "custom_block";

export const REQUEST_ANALYTICS_CATEGORIES = [
  "normal",
  "medium_threat",
  "high_threat",
  "custom_block",
] as const satisfies readonly RequestAnalyticsCategory[];

export const REQUEST_FLAG_EVENT_AT_PRESENT = 1 << 0;
export const REQUEST_FLAG_EDGE_LATENCY_PRESENT = 1 << 1;
export const REQUEST_FLAG_COORDINATE_PRESENT = 1 << 2;
export const REQUEST_FLAG_BOT_SCORE_PRESENT = 1 << 3;
export const REQUEST_FLAG_TCP_RTT_PRESENT = 1 << 4;
export const REQUEST_FLAG_QUIC_RTT_PRESENT = 1 << 5;
export const REQUEST_FLAG_TLS_CLIENT_HELLO_LENGTH_PRESENT = 1 << 6;

export const REQUEST_ANALYTICS_FLAGS = {
  eventAtPresent: REQUEST_FLAG_EVENT_AT_PRESENT,
  edgeLatencyPresent: REQUEST_FLAG_EDGE_LATENCY_PRESENT,
  coordinatePresent: REQUEST_FLAG_COORDINATE_PRESENT,
  botScorePresent: REQUEST_FLAG_BOT_SCORE_PRESENT,
  tcpRttPresent: REQUEST_FLAG_TCP_RTT_PRESENT,
  quicRttPresent: REQUEST_FLAG_QUIC_RTT_PRESENT,
  tlsClientHelloLengthPresent: REQUEST_FLAG_TLS_CLIENT_HELLO_LENGTH_PRESENT,
} as const;

export const REQUEST_FLAGS = REQUEST_ANALYTICS_FLAGS;
export type RequestAnalyticsFlag =
  (typeof REQUEST_ANALYTICS_FLAGS)[keyof typeof REQUEST_ANALYTICS_FLAGS];
export type RequestFlag = RequestAnalyticsFlag;

export function hasRequestFlag(
  flags: number,
  flag: RequestAnalyticsFlag,
): boolean {
  return Number.isFinite(flags) && (Math.trunc(flags) & flag) === flag;
}

export function setRequestFlag(
  flags: number,
  flag: RequestAnalyticsFlag,
  enabled = true,
): number {
  const current = Number.isFinite(flags) ? Math.trunc(flags) : 0;
  return enabled ? current | flag : current & ~flag;
}

export const hasRequestAnalyticsFlag = hasRequestFlag;
export const setRequestAnalyticsFlag = setRequestFlag;

export interface RequestAnalyticsInput {
  request: Request;
  payload: TrackerClientPayload;
  siteId: string;
  origin: string | null;
  traceId: string;
  receivedAt: number;
  category: RequestAnalyticsCategory;
  reasons: readonly string[];
}
