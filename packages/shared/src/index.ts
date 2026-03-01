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

export interface SerializedRequestPayload {
  method: string;
  url: string;
  headers: Record<string, string>;
  cf: Record<string, unknown> | null;
  body: string;
  receivedAt: number;
}

export interface IngestEnvelope {
  request: SerializedRequestPayload;
  client: TrackerClientPayload;
}
