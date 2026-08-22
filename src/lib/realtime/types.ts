export type RealtimeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

export type RealtimeEventKind =
  | "pageview"
  | "custom_event"
  | "leave"
  | "visibility"
  | "identify";

export interface RealtimeEvent {
  id: string;
  eventType: string;
  eventKind?: RealtimeEventKind;
  eventAt: number;
  siteId?: string;
  traceId?: string;
  receivedAt?: number | null;
  sequence?: number | null;
  eventId?: string;
  eventName?: string;
  eventData?: unknown;
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
  isEU?: boolean;
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
  browserVersion?: string;
  os?: string;
  browser: string;
  osVersion: string;
  deviceType: string;
  language: string;
  screenSize: string;
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
  performance?: unknown;
  visibilityState?: string;
  latitude: number | null;
  longitude: number | null;
}

export interface RealtimeVisit {
  visitId: string;
  visitorId: string;
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  pathname: string;
  hash: string;
  title: string;
  hostname: string;
  referrerUrl: string;
  referrerHost: string;
  queryString?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  userId?: string;
  userName?: string;
  isEU?: boolean;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  continent: string;
  timezone: string;
  organization: string;
  uaRaw?: string;
  browserVersion?: string;
  os?: string;
  browser: string;
  osVersion: string;
  deviceType: string;
  language: string;
  screenSize: string;
  siteId?: string;
  postalCode?: string;
  metroCode?: string;
  screenWidth?: number | null;
  screenHeight?: number | null;
  status?: string;
  hiddenAt?: number | null;
  endedAt?: number | null;
  finalizedAt?: number | null;
  durationMs?: number | null;
  durationSource?: string;
  exitReason?: string;
  performance?: unknown;
  latitude: number | null;
  longitude: number | null;
}

export interface RealtimeSnapshot {
  activeNow: number | null;
  events: RealtimeEvent[];
  points: RealtimeVisitorPoint[];
  visits: RealtimeVisit[];
}

export interface RealtimeVisitorPoint {
  visitorId: string;
  eventAt: number;
  latitude: number;
  longitude: number;
  country: string;
}

export interface RealtimeChannelState {
  status: RealtimeConnectionState;
  hasConnected: boolean;
  activeNow: number;
  visitorsLast30m: number;
  viewsLast30m: number;
  snapshotActiveNow: number | null;
  events: RealtimeEvent[];
  points: RealtimeVisitorPoint[];
  visits: RealtimeVisit[];
}

export interface RealtimeBroadcastMessage {
  siteId: string;
  state: RealtimeChannelState;
}
