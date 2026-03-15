export type RealtimeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

export interface RealtimeEvent {
  id: string;
  eventType: string;
  eventAt: number;
  visitId: string;
  sessionId: string;
  pathname: string;
  title: string;
  hostname: string;
  referrerUrl: string;
  referrerHost: string;
  visitorId: string;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  continent: string;
  timezone: string;
  organization: string;
  browser: string;
  osVersion: string;
  deviceType: string;
  language: string;
  screenSize: string;
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
  title: string;
  hostname: string;
  referrerUrl: string;
  referrerHost: string;
  country: string;
  region: string;
  regionCode: string;
  city: string;
  continent: string;
  timezone: string;
  organization: string;
  browser: string;
  osVersion: string;
  deviceType: string;
  language: string;
  screenSize: string;
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
