import { broadcastRealtimeMessage } from "@/lib/realtime/broadcast-store";
import type { RealtimeSocketLike } from "@/lib/realtime/mock";
import type {
  RealtimeChannelState,
  RealtimeConnectionState,
  RealtimeEvent,
  RealtimeSnapshot,
  RealtimeVisit,
  RealtimeVisitorPoint,
} from "@/lib/realtime/types";

const RECORD_WINDOW_MS = 30 * 60 * 1000;
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 2_000;
const CONNECT_WATCHDOG_MS = 4_000;
const RECORD_RECOMPUTE_INTERVAL_MS = 5_000;
const MAX_RENDERABLE_POINTS = 800;
const PRESENCE_LEAVE_EVENT = "__presence_leave";
const VIEW_EVENT_TYPES = new Set(["visit", "pageview"]);

const SOCKET_STATE = {
  CONNECTING: 0,
  OPEN: 1,
} as const;

const USE_REALTIME_MOCK =
  process.env.NEXT_PUBLIC_DEMO_MODE === "1"
  || process.env.NEXT_PUBLIC_REALTIME_MOCK === "1"
  || (
    process.env.NEXT_PUBLIC_REALTIME_MOCK !== "0"
    && process.env.NODE_ENV !== "production"
  );

interface ChannelContext {
  siteId: string;
  refCount: number;
  socket: RealtimeSocketLike | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  cleanupTimer: ReturnType<typeof setInterval> | null;
  connectWatchdog: ReturnType<typeof setTimeout> | null;
  reconnectFailures: number;
  state: RealtimeChannelState;
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
    visitorsLast30m: 0,
    viewsLast30m: 0,
    snapshotActiveNow: null,
    events: [],
    points: [],
    visits: [],
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
  channel.state = createIdleRealtimeChannelState("connecting");
  publishChannelState(channel);

  connect(channel);
  channel.cleanupTimer = setInterval(() => {
    recomputeDerivedState(channel);
    publishChannelState(channel);
  }, RECORD_RECOMPUTE_INTERVAL_MS);
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
    channel.socket
    && (
      channel.socket.readyState === SOCKET_STATE.OPEN
      || channel.socket.readyState === SOCKET_STATE.CONNECTING
    )
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
  const snapshotEvents = resolveSnapshotEvents(snapshot);

  channel.state.events = sortAndPruneEvents(snapshotEvents, now);
  channel.state.snapshotActiveNow = snapshot.activeNow;
  recomputeDerivedState(channel, now);
}

function applyEvent(channel: ChannelContext, payload: unknown): void {
  const event = normalizeRealtimeEvent(payload);
  if (!event) return;

  channel.state.events = mergeEvents([event], channel.state.events, event.eventAt);
  recomputeDerivedState(channel, event.eventAt || Date.now());
}

function recomputeDerivedState(channel: ChannelContext, now = Date.now()): void {
  const events = sortAndPruneEvents(channel.state.events, now);
  const derived = buildDerivedState(events, now);

  channel.state.events = events;
  channel.state.activeNow = derived.activeNow;
  channel.state.visitorsLast30m = derived.visitorsLast30m;
  channel.state.viewsLast30m = derived.viewsLast30m;
  channel.state.points = derived.points;
  channel.state.visits = derived.visits;
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
    visitorsLast30m: state.visitorsLast30m,
    viewsLast30m: state.viewsLast30m,
    snapshotActiveNow: state.snapshotActiveNow,
    events: [...state.events],
    points: [...state.points],
    visits: [...state.visits],
  };
}

function resolveSnapshotEvents(snapshot: RealtimeSnapshot): RealtimeEvent[] {
  if (snapshot.events.length > 0) {
    return snapshot.events;
  }

  if (snapshot.visits.length > 0) {
    return snapshot.visits.map((visit) => ({
      id: `snapshot:${visit.visitId}:${visit.lastActivityAt}`,
      eventType: "visit",
      eventAt: visit.lastActivityAt,
      visitId: visit.visitId,
      sessionId: visit.sessionId,
      pathname: visit.pathname,
      title: visit.title,
      hostname: visit.hostname,
      referrerUrl: visit.referrerUrl,
      referrerHost: visit.referrerHost,
      visitorId: visit.visitorId,
      country: visit.country,
      region: visit.region,
      regionCode: visit.regionCode,
      city: visit.city,
      continent: visit.continent,
      timezone: visit.timezone,
      organization: visit.organization,
      browser: visit.browser,
      osVersion: visit.osVersion,
      deviceType: visit.deviceType,
      language: visit.language,
      screenSize: visit.screenSize,
      latitude: visit.latitude,
      longitude: visit.longitude,
    }));
  }

  return snapshot.points.map((point) => ({
    id: `snapshot-point:${point.visitorId}:${point.eventAt}`,
    eventType: "visit",
    eventAt: point.eventAt,
    visitId: "",
    sessionId: "",
    pathname: "/",
    title: "",
    hostname: "",
    referrerUrl: "",
    referrerHost: "",
    visitorId: point.visitorId,
    country: point.country,
    region: "",
    regionCode: "",
    city: "",
    continent: "",
    timezone: "",
    organization: "",
    browser: "",
    osVersion: "",
    deviceType: "",
    language: "",
    screenSize: "",
    latitude: point.latitude,
    longitude: point.longitude,
  }));
}

function buildDerivedState(
  events: RealtimeEvent[],
  now: number,
): Pick<
  RealtimeChannelState,
  "activeNow" | "visitorsLast30m" | "viewsLast30m" | "points" | "visits"
> {
  const activeCutoff = now - ACTIVE_WINDOW_MS;
  const latestVisitorEvents = new Map<string, RealtimeEvent>();
  const visitsById = new Map<string, RealtimeVisit>();
  const visitorsLast30m = new Set<string>();
  let viewsLast30m = 0;

  for (const event of events) {
    upsertRecentVisit(visitsById, event);
    if (event.visitorId) {
      visitorsLast30m.add(event.visitorId);
    }
    if (VIEW_EVENT_TYPES.has(event.eventType)) {
      viewsLast30m += 1;
    }

    if (!event.visitorId || event.eventAt < activeCutoff) continue;
    const existing = latestVisitorEvents.get(event.visitorId);
    if (!existing || compareRealtimeEventsDesc(event, existing) < 0) {
      latestVisitorEvents.set(event.visitorId, event);
    }
  }

  const points: RealtimeVisitorPoint[] = [];
  let activeNow = 0;
  for (const event of latestVisitorEvents.values()) {
    if (event.eventType === PRESENCE_LEAVE_EVENT) continue;
    activeNow += 1;

    if (!isValidCoordinate(event.latitude, event.longitude)) {
      continue;
    }

    points.push({
      visitorId: event.visitorId,
      eventAt: event.eventAt,
      latitude: Number(event.latitude),
      longitude: Number(event.longitude),
      country: event.country,
    });
  }

  points.sort((left, right) => right.eventAt - left.eventAt);

  return {
    activeNow,
    visitorsLast30m: visitorsLast30m.size,
    viewsLast30m,
    points: points.slice(0, MAX_RENDERABLE_POINTS),
    visits: Array.from(visitsById.values()).sort(
      (left, right) => right.lastActivityAt - left.lastActivityAt,
    ),
  };
}

function upsertRecentVisit(
  visitsById: Map<string, RealtimeVisit>,
  event: RealtimeEvent,
): void {
  if (!event.visitId) return;

  const previous = visitsById.get(event.visitId);
  if (!previous) {
    visitsById.set(event.visitId, {
      visitId: event.visitId,
      visitorId: event.visitorId,
      sessionId: event.sessionId,
      startedAt: event.eventAt,
      lastActivityAt: event.eventAt,
      pathname: event.pathname,
      title: event.title,
      hostname: event.hostname,
      referrerUrl: event.referrerUrl,
      referrerHost: event.referrerHost,
      country: event.country,
      region: event.region,
      regionCode: event.regionCode,
      city: event.city,
      continent: event.continent,
      timezone: event.timezone,
      organization: event.organization,
      browser: event.browser,
      osVersion: event.osVersion,
      deviceType: event.deviceType,
      language: event.language,
      screenSize: event.screenSize,
      latitude: event.latitude,
      longitude: event.longitude,
    });
    return;
  }

  previous.startedAt = Math.min(previous.startedAt, event.eventAt);
  previous.lastActivityAt = Math.max(previous.lastActivityAt, event.eventAt);
  previous.visitorId ||= event.visitorId;
  previous.sessionId ||= event.sessionId;
  previous.pathname ||= event.pathname;
  previous.title ||= event.title;
  previous.hostname ||= event.hostname;
  previous.referrerUrl ||= event.referrerUrl;
  previous.referrerHost ||= event.referrerHost;
  previous.country ||= event.country;
  previous.region ||= event.region;
  previous.regionCode ||= event.regionCode;
  previous.city ||= event.city;
  previous.continent ||= event.continent;
  previous.timezone ||= event.timezone;
  previous.organization ||= event.organization;
  previous.browser ||= event.browser;
  previous.osVersion ||= event.osVersion;
  previous.deviceType ||= event.deviceType;
  previous.language ||= event.language;
  previous.screenSize ||= event.screenSize;
  previous.latitude ??= event.latitude;
  previous.longitude ??= event.longitude;
}

function sortAndPruneEvents(
  events: RealtimeEvent[],
  now = Date.now(),
): RealtimeEvent[] {
  const cutoff = now - RECORD_WINDOW_MS;
  const deduped = new Map<string, RealtimeEvent>();

  for (const event of events) {
    if (!event.id) continue;
    if (!Number.isFinite(event.eventAt) || event.eventAt < cutoff) continue;

    const existing = deduped.get(event.id);
    if (!existing || compareRealtimeEventsDesc(event, existing) < 0) {
      deduped.set(event.id, event);
    }
  }

  return Array.from(deduped.values()).sort(compareRealtimeEventsDesc);
}

function mergeEvents(
  next: RealtimeEvent[],
  previous: RealtimeEvent[],
  now = Date.now(),
): RealtimeEvent[] {
  return sortAndPruneEvents([...next, ...previous], now);
}

function compareRealtimeEventsDesc(
  left: Pick<RealtimeEvent, "eventAt" | "eventType">,
  right: Pick<RealtimeEvent, "eventAt" | "eventType">,
): number {
  if (right.eventAt !== left.eventAt) {
    return right.eventAt - left.eventAt;
  }
  return realtimeEventPriority(right.eventType) - realtimeEventPriority(left.eventType);
}

function realtimeEventPriority(eventType: string): number {
  return eventType === PRESENCE_LEAVE_EVENT ? 0 : 1;
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
    visitId: String(record.visitId ?? record.visit_id ?? ""),
    sessionId: String(record.sessionId ?? record.session_id ?? ""),
    pathname: String(record.pathname ?? "/"),
    title: String(record.title ?? ""),
    hostname: String(record.hostname ?? ""),
    referrerUrl: String(record.referrerUrl ?? record.referrer_url ?? ""),
    referrerHost: String(record.referrerHost ?? record.referrer_host ?? ""),
    visitorId,
    country: String(record.country ?? ""),
    region: String(record.region ?? ""),
    regionCode: String(record.regionCode ?? record.region_code ?? ""),
    city: String(record.city ?? ""),
    continent: String(record.continent ?? ""),
    timezone: String(record.timezone ?? ""),
    organization: String(
      record.organization ?? record.asOrganization ?? record.as_organization ?? "",
    ),
    browser: String(record.browser ?? ""),
    osVersion: String(record.osVersion ?? record.os_version ?? ""),
    deviceType: String(record.deviceType ?? record.device_type ?? ""),
    language: String(record.language ?? ""),
    screenSize: String(record.screenSize ?? record.screen_size ?? ""),
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
    return { activeNow: null, events: [], points: [], visits: [] };
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
  const visitsRaw = Array.isArray(record.visits) ? record.visits : [];
  const visits = visitsRaw
    .map((item) => normalizeRealtimeVisit(item))
    .filter((item): item is RealtimeVisit => item !== null);

  const activeNowRaw = Number(record.activeNow);
  const activeNow = Number.isFinite(activeNowRaw) && activeNowRaw >= 0
    ? Math.floor(activeNowRaw)
    : null;

  return { activeNow, events, points, visits };
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

function normalizeRealtimeVisit(payload: unknown): RealtimeVisit | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const visitId = String(record.visitId ?? record.visit_id ?? "").trim();
  const visitorId = String(record.visitorId ?? record.visitor_id ?? "").trim();
  if (!visitId || !visitorId) return null;

  const startedAt = Number(record.startedAt ?? record.started_at ?? Date.now());
  const lastActivityAt = Number(
    record.lastActivityAt ?? record.last_activity_at ?? record.eventAt ?? Date.now(),
  );
  const latitude = normalizeCoordinate(record.latitude, -90, 90);
  const longitude = normalizeCoordinate(record.longitude, -180, 180);

  return {
    visitId,
    visitorId,
    sessionId: String(record.sessionId ?? record.session_id ?? ""),
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : Date.now(),
    pathname: String(record.pathname ?? "/"),
    title: String(record.title ?? ""),
    hostname: String(record.hostname ?? ""),
    referrerUrl: String(record.referrerUrl ?? record.referrer_url ?? ""),
    referrerHost: String(record.referrerHost ?? record.referrer_host ?? ""),
    country: String(record.country ?? ""),
    region: String(record.region ?? ""),
    regionCode: String(record.regionCode ?? record.region_code ?? ""),
    city: String(record.city ?? ""),
    continent: String(record.continent ?? ""),
    timezone: String(record.timezone ?? ""),
    organization: String(
      record.organization ?? record.asOrganization ?? record.as_organization ?? "",
    ),
    browser: String(record.browser ?? ""),
    osVersion: String(record.osVersion ?? record.os_version ?? ""),
    deviceType: String(record.deviceType ?? record.device_type ?? ""),
    language: String(record.language ?? ""),
    screenSize: String(record.screenSize ?? record.screen_size ?? ""),
    latitude,
    longitude,
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
