export type RealtimeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

export interface RealtimeEvent {
  id: string;
  eventType: string;
  eventAt: number;
  pathname: string;
  visitorId: string;
  country: string;
  browser: string;
  latitude: number | null;
  longitude: number | null;
}

export interface RealtimeSnapshot {
  activeNow: number | null;
  events: RealtimeEvent[];
  points: RealtimeVisitorPoint[];
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
  snapshotActiveNow: number | null;
  events: RealtimeEvent[];
  points: RealtimeVisitorPoint[];
}

export interface RealtimeBroadcastMessage {
  siteId: string;
  state: RealtimeChannelState;
}
