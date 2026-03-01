import type { IngestEnvelope } from "@insightflare/shared";

export interface AnalyticsEngineWriteDataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}

export interface AnalyticsEngineBinding {
  writeDataPoint(data: AnalyticsEngineWriteDataPoint): void;
}

export interface Env {
  DB: D1Database;
  INGEST_DO: DurableObjectNamespace;
  ANALYTICS?: AnalyticsEngineBinding;
  ARCHIVE_BUCKET?: R2Bucket;
  DAILY_SALT_SECRET: string;
  ADMIN_WS_TOKEN?: string;
  ADMIN_API_TOKEN?: string;
  EDGE_PUBLIC_BASE_URL?: string;
  PARQUET_WASM_URL?: string;
  REQUIRE_TEAM_MEMBERSHIP?: string;
  SESSION_WINDOW_MINUTES?: string;
  SCRIPT_CACHE_TTL_SECONDS?: string;
}

export interface SerializedRequestPayload {
  method: string;
  url: string;
  headers: Record<string, string>;
  cf: Record<string, unknown> | null;
  body: string;
  receivedAt: number;
}

export interface TrackerClientPayload {
  eventId?: string;
  eventType?: "pageview" | "route_change" | "hidden" | "unload";
  timestamp?: number;
  pathname?: string;
  query?: string;
  hash?: string;
  hostname?: string;
  title?: string;
  language?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
  referer?: string;
  refererDetail?: string;
  visitorId?: string;
  sessionId?: string;
  durationMs?: number;
  teamId?: string;
  siteId?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
}

export interface IngestEnvelopePayload extends IngestEnvelope {
  request: SerializedRequestPayload;
  client: TrackerClientPayload;
}

export interface NormalizedEvent {
  id: string;
  eventType: string;
  eventAt: number;
  receivedAt: number;
  hourBucket: number;
  teamId: string;
  siteId: string;
  pathname: string;
  queryString: string;
  hashFragment: string;
  hostname: string;
  title: string;
  referer: string;
  refererHost: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
  visitorId: string;
  sessionId: string;
  durationMs: number;
  isEU: boolean;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  continent: string;
  latitude: number | null;
  longitude: number | null;
  postalCode: string;
  metroCode: string;
  timezone: string;
  colo: string;
  asOrganization: string;
  botScore: number | null;
  botVerified: boolean;
  botSecurityJson: string;
  uaRaw: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  screenWidth: number | null;
  screenHeight: number | null;
  language: string;
  ip: string;
  extraJson: string;
}
