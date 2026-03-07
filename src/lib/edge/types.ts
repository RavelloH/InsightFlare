export interface Env {
  DB: D1Database;
  INGEST_DO: DurableObjectNamespace;
  ARCHIVE_BUCKET?: R2Bucket;
  DAILY_SALT_SECRET: string;
  ADMIN_WS_TOKEN?: string;
  DASHBOARD_SESSION_SECRET?: string;
  SESSION_SECRET?: string;
  EDGE_PUBLIC_BASE_URL?: string;
  PARQUET_WASM_URL?: string;
  BOOTSTRAP_ADMIN_USERNAME?: string;
  BOOTSTRAP_ADMIN_PASSWORD?: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  BOOTSTRAP_ADMIN_NAME?: string;
  SESSION_WINDOW_MINUTES?: string;
  SCRIPT_CACHE_TTL_SECONDS?: string;
  SITE_SETTINGS_KV?: KVNamespace;
}

export interface SerializedRequestPayload {
  method: string;
  url: string;
  headers: Record<string, string>;
  cf: Record<string, unknown> | null;
  body: string;
  receivedAt: number;
}

export type TrackerPayloadKind = "visit_start" | "visit_finalize" | "custom_event";

export interface TrackerClientPayload {
  siteId?: string;
  kind?: TrackerPayloadKind;
  visitId?: string;
  eventId?: string;
  timestamp?: number;
  startedAt?: number;
  pathname?: string;
  query?: string;
  hash?: string;
  hostname?: string;
  title?: string;
  language?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
  referrerUrl?: string;
  visitorId?: string;
  durationMs?: number;
  exitReason?: string;
  eventName?: string;
  eventData?: unknown;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
}

export interface IngestEnvelope {
  request: SerializedRequestPayload;
  client: TrackerClientPayload;
}

export interface IngestEnvelopePayload extends IngestEnvelope {
  request: SerializedRequestPayload;
  client: TrackerClientPayload;
}

export interface NormalizedVisitContext {
  siteId: string;
  visitId: string;
  visitorId: string;
  sessionId: string;
  startedAt: number;
  pathname: string;
  queryString: string;
  hashFragment: string;
  hostname: string;
  title: string;
  referrerUrl: string;
  referrerHost: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  utmTerm: string;
  utmContent: string;
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
  asOrganization: string;
  uaRaw: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: string;
  screenWidth: number | null;
  screenHeight: number | null;
  language: string;
}

export interface NormalizedVisitStart extends NormalizedVisitContext {
  kind: "visit_start";
  receivedAt: number;
}

export interface NormalizedVisitFinalize {
  kind: "visit_finalize";
  siteId: string;
  visitId: string;
  visitorId: string;
  sessionId: string;
  startedAt: number;
  finalizedAt: number;
  receivedAt: number;
  durationMs: number | null;
  durationSource: "reported" | "timeout";
  exitReason: string;
  country: string;
  browser: string;
  deviceType: string;
}

export interface NormalizedCustomEvent extends NormalizedVisitContext {
  kind: "custom_event";
  eventId: string;
  receivedAt: number;
  eventAt: number;
  eventName: string;
  eventDataJson: string;
}

export type NormalizedIngestRecord =
  | NormalizedVisitStart
  | NormalizedVisitFinalize
  | NormalizedCustomEvent;
