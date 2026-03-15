import { broadcastRealtimeMessage } from "@/lib/realtime/broadcast-store";
import type { RealtimeSocketLike } from "@/lib/realtime/mock";
import type {
  RealtimeChannelState,
  RealtimeConnectionState,
  RealtimeEvent,
  RealtimeSnapshot,
  RealtimeVisitorPoint,
} from "@/lib/realtime/types";

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2_000;
const CONNECT_WATCHDOG_MS = 4_000;
const ACTIVE_RECOMPUTE_INTERVAL_MS = 15_000;
const MAX_RECENT_EVENTS = 20;
const MAX_RENDERABLE_POINTS = 800;
const PRESENCE_LEAVE_EVENT = "__presence_leave";

const SOCKET_STATE = {
  CONNECTING: 0,
  OPEN: 1,
} as const;

const USE_REALTIME_MOCK =
  process.env.NEXT_PUBLIC_DEMO_MODE === "1" ||
  process.env.NEXT_PUBLIC_REALTIME_MOCK === "1" ||
  (process.env.NEXT_PUBLIC_REALTIME_MOCK !== "0" &&
    process.env.NODE_ENV !== "production");

interface ChannelContext {
  siteId: string;
  refCount: number;
  socket: RealtimeSocketLike | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setInterval> | null;
  connectWatchdog: ReturnType<typeof setTimeout> | null;
  reconnectFailures: number;
  state: RealtimeChannelState;
  visitors: Map<string, VisitorPresence>;
  snapshotBaseline: {
    value: number;
    at: number;
  };
}

interface VisitorPresence {
  seenAt: number;
  latitude: number | null;
  longitude: number | null;
  country: string;
}

const channels = new Map<string, ChannelContext>();

export function isRealtimeMockEnabled(): boolean {
  return USE_REALTIME_MOCK;
}

export function createIdleRealtimeChannelState(
  status: RealtimeConnectionState = "disconnected",
): RealtimeChannelState {
  return {
    status,
    hasConnected: false,
    activeNow: 0,
    snapshotActiveNow: null,
    events: [],
    points: [],
  };
}

export function getRealtimeChannelState(siteId?: string): RealtimeChannelState {
  if (!siteId) return createIdleRealtimeChannelState();
  const channel = channels.get(siteId);
  if (!channel) return createIdleRealtimeChannelState();
  return cloneState(channel.state);
}

export function acquireRealtimeChannel(siteId: string): () => void {
  if (!siteId) {
    return () => {
      // no-op
    };
  }

  const channel = getOrCreateChannel(siteId);
  channel.refCount += 1;
  if (channel.refCount === 1) {
    startChannel(channel);
  } else {
    publishChannelState(channel);
  }

  return () => {
    releaseRealtimeChannel(siteId);
  };
}

function getOrCreateChannel(siteId: string): ChannelContext {
  const existing = channels.get(siteId);
  if (existing) return existing;

  const context: ChannelContext = {
    siteId,
    refCount: 0,
    socket: null,
    reconnectTimer: null,
    cleanupTimer: null,
    connectWatchdog: null,
    reconnectFailures: 0,
    state: createIdleRealtimeChannelState("connecting"),
    visitors: new Map<string, VisitorPresence>(),
    snapshotBaseline: {
      value: 0,
      at: 0,
    },
  };
  channels.set(siteId, context);
  return context;
}

function releaseRealtimeChannel(siteId: string): void {
  const channel = channels.get(siteId);
  if (!channel) return;

  channel.refCount = Math.max(0, channel.refCount - 1);
  if (channel.refCount > 0) return;

  stopChannel(channel);
  channels.delete(siteId);
}

function startChannel(channel: ChannelContext): void {
  channel.reconnectFailures = 0;
  channel.visitors.clear();
  channel.snapshotBaseline = { value: 0, at: 0 };
  channel.state = createIdleRealtimeChannelState("connecting");
  publishChannelState(channel);

  connect(channel);
  channel.cleanupTimer = setInterval(() => {
    recomputeActiveNow(channel);
    publishChannelState(channel);
  }, ACTIVE_RECOMPUTE_INTERVAL_MS);
}

function stopChannel(channel: ChannelContext): void {
  if (channel.reconnectTimer) {
    clearTimeout(channel.reconnectTimer);
    channel.reconnectTimer = null;
  }
  if (channel.cleanupTimer) {
    clearInterval(channel.cleanupTimer);
    channel.cleanupTimer = null;
  }
  if (channel.connectWatchdog) {
    clearTimeout(channel.connectWatchdog);
    channel.connectWatchdog = null;
  }
  if (
    channel.socket &&
    (channel.socket.readyState === SOCKET_STATE.OPEN ||
      channel.socket.readyState === SOCKET_STATE.CONNECTING)
  ) {
    channel.socket.close();
  }
  channel.socket = null;
}

function connect(channel: ChannelContext): void {
  if (channel.refCount <= 0) return;

  setChannelStatus(channel, "connecting");

  if (USE_REALTIME_MOCK) {
    import("@/lib/realtime/mock").then(({ createMockRealtimeSocket }) => {
      if (channel.refCount <= 0) return;
      channel.socket = createMockRealtimeSocket({
        siteId: channel.siteId,
        activeWindowMs: ACTIVE_WINDOW_MS,
      });
      attachSocketHandlers(channel);
    });
  } else {
    channel.socket = new WebSocket(toRealtimeWsUrl(channel.siteId));
    attachSocketHandlers(channel);
  }
}

function attachSocketHandlers(channel: ChannelContext): void {
  if (!channel.socket) return;

  let hasOpened = false;

  channel.connectWatchdog = setTimeout(() => {
    if (channel.refCount <= 0) return;
    if (channel.socket && channel.socket.readyState === SOCKET_STATE.CONNECTING) {
      setChannelStatus(channel, "disconnected");
      channel.socket.close();
    }
  }, CONNECT_WATCHDOG_MS);

  channel.socket.onopen = () => {
    if (channel.connectWatchdog) {
      clearTimeout(channel.connectWatchdog);
      channel.connectWatchdog = null;
    }
    hasOpened = true;
    channel.reconnectFailures = 0;
    channel.state.hasConnected = true;
    setChannelStatus(channel, "connected");
  };

  channel.socket.onmessage = (message) => {
    const payload = decodeRealtimeEnvelope(message.data);
    if (!payload) return;

    if (payload.type === "snapshot") {
      applySnapshot(channel, payload.data);
      publishChannelState(channel);
      return;
    }

    if (payload.type === "event") {
      applyEvent(channel, payload.data);
      publishChannelState(channel);
    }
  };

  channel.socket.onerror = () => {
    setChannelStatus(channel, "disconnected");
    channel.socket?.close();
  };

  channel.socket.onclose = () => {
    if (channel.connectWatchdog) {
      clearTimeout(channel.connectWatchdog);
      channel.connectWatchdog = null;
    }
    channel.socket = null;
    if (channel.refCount <= 0) return;

    if (!hasOpened) {
      channel.reconnectFailures += 1;
    } else {
      channel.reconnectFailures = 0;
    }

    if (channel.reconnectFailures >= MAX_RECONNECT_ATTEMPTS) {
      setChannelStatus(channel, "failed");
      return;
    }

    setChannelStatus(channel, "disconnected");
    channel.reconnectTimer = setTimeout(() => {
      channel.reconnectTimer = null;
      connect(channel);
    }, RECONNECT_DELAY_MS);
  };
}

function applySnapshot(channel: ChannelContext, payload: unknown): void {
  const snapshot = normalizeRealtimeSnapshot(payload);
  const now = Date.now();

  channel.state.events = mergeEvents(snapshot.events, [], MAX_RECENT_EVENTS);
  if (snapshot.points.length > 0) {
    channel.visitors.clear();
    for (const point of snapshot.points) {
      upsertSnapshotPresence(channel, point);
    }
  } else {
    for (const event of snapshot.events) {
      upsertVisitorPresence(channel, event);
    }
  }

  channel.state.snapshotActiveNow = snapshot.activeNow;
  if (snapshot.activeNow !== null) {
    channel.snapshotBaseline = {
      value: snapshot.activeNow,
      at: now,
    };
  }
  recomputeActiveNow(channel, now);
}

function applyEvent(channel: ChannelContext, payload: unknown): void {
  const event = normalizeRealtimeEvent(payload);
  if (!event) return;

  channel.state.events = mergeEvents([event], channel.state.events, MAX_RECENT_EVENTS);

  if (event.eventType === PRESENCE_LEAVE_EVENT) {
    if (event.visitorId) {
      channel.visitors.delete(event.visitorId);
    }
    if (
      Date.now() - channel.snapshotBaseline.at <= ACTIVE_WINDOW_MS &&
      channel.snapshotBaseline.value > 0
    ) {
      channel.snapshotBaseline.value -= 1;
    }
    recomputeActiveNow(channel, event.eventAt || Date.now());
    return;
  }

  upsertVisitorPresence(channel, event);
  recomputeActiveNow(channel, event.eventAt || Date.now());
}

function recomputeActiveNow(channel: ChannelContext, now = Date.now()): void {
  const cutoff = now - ACTIVE_WINDOW_MS;
  for (const [visitorId, presence] of channel.visitors.entries()) {
    if (presence.seenAt < cutoff) {
      channel.visitors.delete(visitorId);
    }
  }

  const snapshotFresh = now - channel.snapshotBaseline.at <= ACTIVE_WINDOW_MS;
  const baseline = snapshotFresh ? channel.snapshotBaseline.value : 0;
  channel.state.activeNow = Math.max(baseline, channel.visitors.size);
  channel.state.points = buildVisitorPoints(channel.visitors);
}

function setChannelStatus(
  channel: ChannelContext,
  status: RealtimeConnectionState,
): void {
  channel.state.status = status;
  publishChannelState(channel);
}

function publishChannelState(channel: ChannelContext): void {
  void broadcastRealtimeMessage({
    siteId: channel.siteId,
    state: cloneState(channel.state),
  });
}

function cloneState(state: RealtimeChannelState): RealtimeChannelState {
  return {
    status: state.status,
    hasConnected: state.hasConnected,
    activeNow: state.activeNow,
    snapshotActiveNow: state.snapshotActiveNow,
    events: [...state.events],
    points: [...state.points],
  };
}

function upsertVisitorPresence(channel: ChannelContext, event: RealtimeEvent): void {
  if (!event.visitorId || event.eventType === PRESENCE_LEAVE_EVENT) {
    return;
  }

  const previous = channel.visitors.get(event.visitorId);
  if (previous && event.eventAt < previous.seenAt) {
    return;
  }

  const hasCoordinates = isValidCoordinate(event.latitude, event.longitude);
  channel.visitors.set(event.visitorId, {
    seenAt: event.eventAt,
    latitude: hasCoordinates
      ? event.latitude
      : (previous?.latitude ?? null),
    longitude: hasCoordinates
      ? event.longitude
      : (previous?.longitude ?? null),
    country: event.country || previous?.country || "",
  });
}

function upsertSnapshotPresence(
  channel: ChannelContext,
  point: RealtimeVisitorPoint,
): void {
  if (!point.visitorId) return;

  const previous = channel.visitors.get(point.visitorId);
  if (previous && point.eventAt < previous.seenAt) {
    return;
  }

  channel.visitors.set(point.visitorId, {
    seenAt: point.eventAt,
    latitude: point.latitude,
    longitude: point.longitude,
    country: point.country || previous?.country || "",
  });
}

function buildVisitorPoints(
  visitors: Map<string, VisitorPresence>,
): RealtimeVisitorPoint[] {
  const points: RealtimeVisitorPoint[] = [];
  for (const [visitorId, presence] of visitors.entries()) {
    if (!isValidCoordinate(presence.latitude, presence.longitude)) {
      continue;
    }
    const latitude = Number(presence.latitude);
    const longitude = Number(presence.longitude);
    points.push({
      visitorId,
      eventAt: presence.seenAt,
      latitude,
      longitude,
      country: presence.country,
    });
  }

  points.sort((a, b) => b.eventAt - a.eventAt);
  return points.slice(0, MAX_RENDERABLE_POINTS);
}

function mergeEvents(
  next: RealtimeEvent[],
  previous: RealtimeEvent[],
  limit: number,
): RealtimeEvent[] {
  const merged: RealtimeEvent[] = [];
  const ids = new Set<string>();
  const ordered = [...next, ...previous].sort((a, b) => b.eventAt - a.eventAt);

  for (const event of ordered) {
    if (!event.id || ids.has(event.id)) continue;
    ids.add(event.id);
    merged.push(event);
    if (merged.length >= limit) break;
  }

  return merged;
}

function normalizeRealtimeEvent(payload: unknown): RealtimeEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const eventAt = Number(record.eventAt ?? record.event_at ?? Date.now());
  const visitorId = String(record.visitorId ?? record.visitor_id ?? "");
  const id = String(record.id ?? `${eventAt}-${visitorId}`);
  const latitude = normalizeCoordinate(record.latitude, -90, 90);
  const longitude = normalizeCoordinate(record.longitude, -180, 180);

  return {
    id,
    eventType: String(record.eventType ?? record.event_type ?? ""),
    eventAt: Number.isFinite(eventAt) ? eventAt : Date.now(),
    pathname: String(record.pathname ?? "/"),
    visitorId,
    country: String(record.country ?? ""),
    browser: String(record.browser ?? ""),
    latitude,
    longitude,
  };
}

function normalizeCoordinate(
  value: unknown,
  min: number,
  max: number,
): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < min || numeric > max) return null;
  return numeric;
}

function isValidCoordinate(
  latitude: number | null,
  longitude: number | null,
): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  return true;
}

function normalizeRealtimeSnapshot(payload: unknown): RealtimeSnapshot {
  if (!payload || typeof payload !== "object") {
    return { activeNow: null, events: [], points: [] };
  }

  const record = payload as Record<string, unknown>;
  const eventsRaw = Array.isArray(record.events) ? record.events : [];
  const events = eventsRaw
    .map((item) => normalizeRealtimeEvent(item))
    .filter((item): item is RealtimeEvent => item !== null);
  const pointsRaw = Array.isArray(record.points) ? record.points : [];
  const points = pointsRaw
    .map((item) => normalizeRealtimePoint(item))
    .filter((item): item is RealtimeVisitorPoint => item !== null);

  const activeNowRaw = Number(record.activeNow);
  const activeNow = Number.isFinite(activeNowRaw) && activeNowRaw >= 0
    ? Math.floor(activeNowRaw)
    : null;

  return { activeNow, events, points };
}

function normalizeRealtimePoint(payload: unknown): RealtimeVisitorPoint | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const visitorId = String(record.visitorId ?? record.visitor_id ?? "").trim();
  if (!visitorId) return null;

  const eventAt = Number(record.eventAt ?? record.event_at ?? Date.now());
  const latitude = normalizeCoordinate(record.latitude, -90, 90);
  const longitude = normalizeCoordinate(record.longitude, -180, 180);
  if (latitude === null || longitude === null) return null;

  return {
    visitorId,
    eventAt: Number.isFinite(eventAt) ? eventAt : Date.now(),
    latitude,
    longitude,
    country: String(record.country ?? ""),
  };
}

function decodeRealtimeEnvelope(data: unknown): {
  type: "snapshot" | "event";
  data?: unknown;
} | null {
  try {
    const text = typeof data === "string" ? data : String(data);
    const payload = JSON.parse(text) as {
      type?: string;
      data?: unknown;
    };
    if (payload.type === "snapshot" || payload.type === "event") {
      return {
        type: payload.type,
        data: payload.data,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function toRealtimeWsUrl(siteId: string): string {
  const configuredBase = process.env.NEXT_PUBLIC_INSIGHTFLARE_EDGE_URL || "";
  const origin = configuredBase.length > 0 ? configuredBase : window.location.origin;
  const url = new URL("/admin/ws", origin);
  url.searchParams.set("siteId", siteId);

  const wsToken = process.env.NEXT_PUBLIC_ADMIN_WS_TOKEN || "";
  if (wsToken) {
    url.searchParams.set("token", wsToken);
  }

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
