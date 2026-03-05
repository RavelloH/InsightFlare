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
}

export interface RealtimeSnapshot {
  activeNow: number | null;
  events: RealtimeEvent[];
}

export interface RealtimeChannelState {
  status: RealtimeConnectionState;
  hasConnected: boolean;
  activeNow: number;
  snapshotActiveNow: number | null;
  events: RealtimeEvent[];
}

export interface RealtimeBroadcastMessage {
  siteId: string;
  state: RealtimeChannelState;
}
