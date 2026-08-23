import type {
  RealtimeEvent as RealtimeEntityEvent,
  RealtimeEventKind as RealtimeEntityEventKind,
  RealtimeSnapshotData as RealtimeEntitySnapshotData,
  RealtimeVisit as RealtimeEntityVisit,
} from "@/schemas/realtime";

export type RealtimeConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

export type RealtimeEventKind = RealtimeEntityEventKind;
export type RealtimeEvent = RealtimeEntityEvent;
export type RealtimeVisit = RealtimeEntityVisit;

export type RealtimeSnapshot = Omit<
  RealtimeEntitySnapshotData,
  "activeNow"
> & {
  activeNow: number | null;
  points: RealtimeVisitorPoint[];
};

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
