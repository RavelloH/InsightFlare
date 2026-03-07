import { broadcastRealtimeMessage } from "@/lib/realtime/broadcast-store";
import { createMockRealtimeSocket, type RealtimeSocketLike } from "@/lib/realtime/mock";
import type {
  RealtimeChannelState,
  RealtimeConnectionState,
  RealtimeEvent,
  RealtimeSnapshot,
} from "@/lib/realtime/types";

const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2_000;
const CONNECT_WATCHDOG_MS = 4_000;
const ACTIVE_RECOMPUTE_INTERVAL_MS = 15_000;
const MAX_RECENT_EVENTS = 20;
const PRESENCE_LEAVE_EVENT = "__presence_leave";

const SOCKET_STATE = {
  CONNECTING: 0,
  OPEN: 1,
} as const;

const USE_REALTIME_MOCK =
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
  visitors: Map<string, number>;
  snapshotBaseline: {
    value: number;
    at: number;
  };
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
    visitors: new Map<string, number>(),
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

  let hasOpened = false;
  setChannelStatus(channel, "connecting");

  if (USE_REALTIME_MOCK) {
    channel.socket = createMockRealtimeSocket({
      siteId: channel.siteId,
      activeWindowMs: ACTIVE_WINDOW_MS,
    });
  } else {
    channel.socket = new WebSocket(toRealtimeWsUrl(channel.siteId));
  }

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
  for (const event of snapshot.events) {
    if (!event.visitorId) continue;
    const previous = channel.visitors.get(event.visitorId) ?? 0;
    if (event.eventAt > previous) {
      channel.visitors.set(event.visitorId, event.eventAt);
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

  if (event.visitorId) {
    channel.visitors.set(event.visitorId, event.eventAt);
  }

  channel.state.events = mergeEvents([event], channel.state.events, MAX_RECENT_EVENTS);
  recomputeActiveNow(channel, event.eventAt || Date.now());
}

function recomputeActiveNow(channel: ChannelContext, now = Date.now()): void {
  const cutoff = now - ACTIVE_WINDOW_MS;
  for (const [visitorId, seenAt] of channel.visitors.entries()) {
    if (seenAt < cutoff) {
      channel.visitors.delete(visitorId);
    }
  }

  const snapshotFresh = now - channel.snapshotBaseline.at <= ACTIVE_WINDOW_MS;
  const baseline = snapshotFresh ? channel.snapshotBaseline.value : 0;
  channel.state.activeNow = Math.max(baseline, channel.visitors.size);
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
  };
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

  return {
    id,
    eventType: String(record.eventType ?? record.event_type ?? ""),
    eventAt: Number.isFinite(eventAt) ? eventAt : Date.now(),
    pathname: String(record.pathname ?? "/"),
    visitorId,
    country: String(record.country ?? ""),
    browser: String(record.browser ?? ""),
  };
}

function normalizeRealtimeSnapshot(payload: unknown): RealtimeSnapshot {
  if (!payload || typeof payload !== "object") {
    return { activeNow: null, events: [] };
  }

  const record = payload as Record<string, unknown>;
  const eventsRaw = Array.isArray(record.events) ? record.events : [];
  const events = eventsRaw
    .map((item) => normalizeRealtimeEvent(item))
    .filter((item): item is RealtimeEvent => item !== null);

  const activeNowRaw = Number(record.activeNow);
  const activeNow = Number.isFinite(activeNowRaw) && activeNowRaw >= 0
    ? Math.floor(activeNowRaw)
    : null;

  return { activeNow, events };
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
