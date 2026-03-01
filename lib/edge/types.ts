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
  ANALYTICS_ACCOUNT_ID?: string;
  ANALYTICS_SQL_API_TOKEN?: string;
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

export interface IngestEnvelope {
  request: SerializedRequestPayload;
  client: TrackerClientPayload;
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
