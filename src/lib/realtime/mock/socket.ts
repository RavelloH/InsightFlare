import { findSiteProfile } from "@/lib/realtime/demo-site-profiles";
import { buildDemoFactDataset } from "@/lib/realtime/mock/fact-builder";
import type { DemoVisitFact } from "@/lib/realtime/mock/types";
import type {
  RealtimeEvent,
  RealtimeVisit,
  RealtimeVisitorPoint,
} from "@/lib/realtime/types";
// ---------------------------------------------------------------------------
//  Realtime mock socket
// ---------------------------------------------------------------------------

type RealtimeSocketMessage =
  | {
      type: "snapshot";
      data: {
        activeNow: number;
        events: RealtimeEvent[];
        points: RealtimeVisitorPoint[];
        visits: RealtimeVisit[];
      };
    }
  | {
      type: "event";
      data: RealtimeEvent;
    };

export type RealtimeSocketLike = Pick<
  WebSocket,
  "readyState" | "onopen" | "onmessage" | "onerror" | "onclose" | "close"
>;

interface MockRealtimeSocketOptions {
  siteId: string;
  activeWindowMs?: number;
}

const READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

const RECENT_RECORD_WINDOW_MS = 30 * 60 * 1000;
const DEMO_EU_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

function demoOperatingSystemName(osVersion: string): string {
  const normalized = osVersion.trim().toLowerCase();
  if (normalized.includes("ios")) return "iOS";
  if (normalized.includes("android")) return "Android";
  if (normalized.includes("harmony")) return "HarmonyOS";
  if (normalized.includes("mac")) return "macOS";
  if (normalized.includes("windows")) return "Windows";
  if (normalized.includes("linux")) return "Linux";
  return osVersion.trim().split(/\s+/)[0] || "Linux";
}

function demoUserName(visitorId: string): string {
  const suffix = visitorId.trim().slice(-6).toUpperCase() || "000000";
  return `Demo visitor ${suffix}`;
}

function demoPostalCode(country: string, visitorId: string): string {
  const checksum = Array.from(visitorId).reduce(
    (sum, character) => sum + character.charCodeAt(0),
    0,
  );
  const suffix = String(checksum % 10_000).padStart(4, "0");
  return country === "US"
    ? String(10_000 + (checksum % 89_999))
    : `${country}-${suffix}`;
}

function demoUserAgent(
  browser: string,
  browserVersion: string,
  os: string,
  deviceType: string,
): string {
  return `Mozilla/5.0 (${os}; ${deviceType}) AppleWebKit/537.36 (KHTML, like Gecko) ${browser}/${browserVersion}`;
}

function demoQueryString(visit: DemoVisitFact): string {
  const values = [
    visit.utmSource ? `utm_source=${encodeURIComponent(visit.utmSource)}` : "",
    visit.utmMedium ? `utm_medium=${encodeURIComponent(visit.utmMedium)}` : "",
    visit.utmCampaign
      ? `utm_campaign=${encodeURIComponent(visit.utmCampaign)}`
      : "",
  ].filter(Boolean);
  return values.length > 0 ? values.join("&") : "ref=direct";
}

function demoRealtimeMetadata(
  visit: DemoVisitFact,
  eventAt: number,
  status: "active" | "completed",
) {
  const os = demoOperatingSystemName(visit.osVersion);
  const endedAt = status === "completed" ? eventAt + visit.durationMs : null;
  const performance = {
    ttfb: Math.max(45, Math.round(80 + visit.durationMs * 0.02)),
    fcp: Math.max(120, Math.round(260 + visit.durationMs * 0.03)),
    lcp: Math.max(280, Math.round(620 + visit.durationMs * 0.05)),
    cls: Number((0.02 + (visit.durationMs % 17) / 1000).toFixed(3)),
    inp: Math.max(35, Math.round(110 + visit.durationMs * 0.01)),
  };

  return {
    queryString: demoQueryString(visit),
    utmSource: visit.utmSource ?? "",
    utmMedium: visit.utmMedium ?? "",
    utmCampaign: visit.utmCampaign ?? "",
    utmTerm: visit.utmSource ? `${visit.eventType}-intent` : "",
    utmContent: visit.utmSource ? "demo-cta" : "",
    userId: `demo-user-${visit.visitorId}`,
    userName: demoUserName(visit.visitorId),
    isEU: DEMO_EU_COUNTRIES.has(visit.country.trim().toUpperCase()),
    postalCode: demoPostalCode(visit.country, visit.visitorId),
    metroCode: `${visit.country}-${visit.regionCode || "global"}`,
    uaRaw: demoUserAgent(
      visit.browser,
      visit.browserVersion,
      os,
      visit.deviceType,
    ),
    os,
    status,
    endedAt,
    finalizedAt: endedAt === null ? null : endedAt + 80,
    durationMs: visit.durationMs,
    durationSource: "mock",
    exitReason: status === "completed" ? "navigation" : "pending",
    leaveAt: endedAt,
    performanceVisitId: `${visit.visitId}-perf`,
    performance,
    visibilityState: "visible",
  };
}

function demoEventData(
  visit: DemoVisitFact,
  eventId: string,
  isPageview: boolean,
): Record<string, unknown> {
  const context = {
    path: visit.pathname,
    title: visit.title,
    source: visit.referrerHost || "(direct)",
  };

  if (isPageview) {
    return {
      page: context,
      navigation: {
        query: demoQueryString(visit),
        hostname: visit.hostname,
      },
    };
  }

  return {
    event: {
      id: eventId,
      name: visit.eventType,
    },
    properties: {
      path: visit.pathname,
      source: visit.referrerHost || "(direct)",
      value: visit.durationMs,
    },
  };
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const FUTURE_PRELOAD_MS = 30 * 60 * 1000;
const MIN_INTER_EVENT_MS = 220;

class MockRealtimeSocket implements RealtimeSocketLike {
  readyState: WebSocket["readyState"] = READY_STATE.CONNECTING;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

  private readonly siteId: string;
  private readonly activeWindowMs: number;
  private windowStart: number;
  private windowEnd: number;
  // Stable visit fact slice; events are derived from this by replaying
  // `startedAt` as `eventAt`. Same site/time → same data, even across reconnects.
  private futureVisits: DemoVisitFact[] = [];
  private lastVisitsByVisitorId = new Map<string, DemoVisitFact>();
  private visitorsByVisitorId = new Map<string, RealtimeVisit>();
  private recentEvents: RealtimeEvent[] = [];
  private sequence = 0;
  private lastEmitAt = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private nextEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({
    siteId,
    activeWindowMs = 5 * 60 * 1000,
  }: MockRealtimeSocketOptions) {
    this.siteId = siteId;
    this.activeWindowMs = activeWindowMs;
    const now = Date.now();
    this.windowStart = now - RECENT_RECORD_WINDOW_MS;
    this.windowEnd = now + FUTURE_PRELOAD_MS;
    this.loadWindowSlice(now);
    this.beginHandshake();
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSING;
    this.clearTimers();
    this.readyState = READY_STATE.CLOSED;
    this.emitClose(
      code ?? 1000,
      reason ?? "mock closed",
      (code ?? 1000) === 1000,
    );
  }

  private beginHandshake(): void {
    const handshakeDelayMs = randomInt(120, 780);
    const shouldFailHandshake = Math.random() < 0.2;
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.readyState !== READY_STATE.CONNECTING) return;
      if (shouldFailHandshake) {
        this.emitError();
        return;
      }

      this.readyState = READY_STATE.OPEN;
      this.emitOpen();
      this.emitSnapshot();
      this.scheduleNextEmit();
      this.scheduleDisconnect();
    }, handshakeDelayMs);
  }

  /**
   * Pull the seeded fact-table slice for [windowStart, windowEnd) and
   * partition it into the already-replayed past (used to seed the initial
   * snapshot) and the future emit queue.
   */
  private loadWindowSlice(now: number): void {
    const dataset = buildDemoFactDataset(
      this.siteId,
      this.windowStart,
      this.windowEnd,
    );
    const past: DemoVisitFact[] = [];
    const future: DemoVisitFact[] = [];
    for (const visit of dataset.visits) {
      if (visit.startedAt <= now) past.push(visit);
      else future.push(visit);
    }
    past.sort((a, b) => a.startedAt - b.startedAt);
    future.sort((a, b) => a.startedAt - b.startedAt);
    this.futureVisits = future;
    this.lastVisitsByVisitorId.clear();
    this.visitorsByVisitorId.clear();
    this.recentEvents = [];

    const recordCutoff = now - RECENT_RECORD_WINDOW_MS;
    const activeCutoff = now - this.activeWindowMs;
    for (const visit of past) {
      if (visit.startedAt < recordCutoff) continue;
      const event = this.demoVisitToEvent(visit);
      this.recentEvents.push(event);
      this.lastVisitsByVisitorId.set(visit.visitorId, visit);
      if (visit.startedAt >= activeCutoff) {
        this.visitorsByVisitorId.set(
          visit.visitorId,
          this.demoVisitToVisit(visit),
        );
      }
    }
  }

  private scheduleNextEmit(): void {
    if (this.readyState !== READY_STATE.OPEN) return;
    if (this.nextEmitTimer) return;

    const now = Date.now();
    if (this.futureVisits.length === 0) {
      // Future queue empty — slide the window forward and try again.
      this.windowStart = now - RECENT_RECORD_WINDOW_MS;
      this.windowEnd = now + FUTURE_PRELOAD_MS;
      this.loadWindowSlice(now);
      if (this.futureVisits.length === 0) return;
    }

    const next = this.futureVisits[0];
    if (!next) return;
    const desiredDelay = Math.max(0, next.startedAt - now);
    // Throttle bursts so the browser console / chart isn't flooded.
    const delay = Math.max(
      desiredDelay,
      MIN_INTER_EVENT_MS - (now - this.lastEmitAt),
    );
    this.nextEmitTimer = setTimeout(
      () => {
        this.nextEmitTimer = null;
        this.emitNextVisit();
      },
      Math.max(0, delay),
    );
  }

  private emitNextVisit(): void {
    if (this.readyState !== READY_STATE.OPEN) return;
    const visit = this.futureVisits.shift();
    if (!visit) {
      this.scheduleNextEmit();
      return;
    }
    const now = Date.now();
    // Stamp the event with "now" rather than the seeded startedAt so the
    // chart timestamps match wall time; the seeded order still drives
    // *which* visit comes next.
    const event = this.demoVisitToEvent(visit, now);
    this.recentEvents.push(event);
    this.lastVisitsByVisitorId.set(visit.visitorId, visit);
    this.visitorsByVisitorId.set(
      visit.visitorId,
      this.demoVisitToVisit(visit, now),
    );
    this.lastEmitAt = now;
    this.prune(now);
    this.emitMessage({ type: "event", data: event });

    if (this.recentEvents.length > 0 && this.recentEvents.length % 12 === 0) {
      this.emitSnapshot();
    }
    this.scheduleNextEmit();
  }

  private scheduleDisconnect(): void {
    const disconnectAfterMs = randomInt(18_000, 32_000);
    this.dropTimer = setTimeout(() => {
      this.dropTimer = null;
      if (this.readyState !== READY_STATE.OPEN) return;
      this.emitError();
    }, disconnectAfterMs);
  }

  private emitOpen(): void {
    this.onopen?.call(this as unknown as WebSocket, new Event("open"));
  }

  private emitMessage(payload: RealtimeSocketMessage): void {
    this.onmessage?.call(
      this as unknown as WebSocket,
      new MessageEvent("message", {
        data: JSON.stringify(payload),
      }),
    );
  }

  private emitError(): void {
    this.onerror?.call(this as unknown as WebSocket, new Event("error"));
  }

  private emitClose(code: number, reason: string, wasClean: boolean): void {
    this.onclose?.call(
      this as unknown as WebSocket,
      new CloseEvent("close", {
        code,
        reason,
        wasClean,
      }),
    );
  }

  private emitSnapshot(): void {
    if (this.readyState !== READY_STATE.OPEN) return;
    const now = Date.now();
    this.prune(now);
    const activeNow = this.visitorsByVisitorId.size;
    const events = [...this.recentEvents].sort(
      (left, right) => right.eventAt - left.eventAt,
    );
    this.emitMessage({
      type: "snapshot",
      data: {
        activeNow,
        events,
        points: this.buildSnapshotPoints(),
        visits: this.buildSnapshotVisits(),
      },
    });
  }

  private prune(now: number): void {
    const activeCutoff = now - this.activeWindowMs;
    const recordCutoff = now - RECENT_RECORD_WINDOW_MS;

    this.recentEvents = this.recentEvents.filter(
      (item) => item.eventAt >= recordCutoff,
    );
    for (const [visitorId, visit] of this.visitorsByVisitorId.entries()) {
      if (visit.lastActivityAt < activeCutoff) {
        this.visitorsByVisitorId.delete(visitorId);
      }
    }
  }

  private nextEventId(): string {
    const suffix = (this.sequence++).toString(36);
    return `${this.siteId}-event-${suffix}`;
  }

  private demoVisitToEvent(
    visit: DemoVisitFact,
    overrideEventAt?: number,
  ): RealtimeEvent {
    const profile = findSiteProfile(this.siteId);
    const [screenWidth, screenHeight] = visit.screenSize
      .split("x")
      .map((value) => Number(value));
    const isPageview = visit.eventType === "pageview";
    const eventAt = overrideEventAt ?? visit.startedAt;
    const status = overrideEventAt === undefined ? "completed" : "active";
    const eventId = this.nextEventId();
    const previous = this.lastVisitsByVisitorId.get(visit.visitorId);
    const metadata = demoRealtimeMetadata(visit, eventAt, status);
    return {
      id: eventId,
      eventType: visit.eventType,
      eventKind: isPageview ? "pageview" : "custom_event",
      eventAt,
      siteId: this.siteId,
      traceId: `${this.siteId}-${visit.sessionId}`,
      receivedAt: eventAt + 120,
      sequence: this.sequence,
      eventId,
      eventName: visit.eventType,
      eventData: demoEventData(visit, eventId, isPageview),
      visitId: visit.visitId,
      sessionId: visit.sessionId,
      startedAt: visit.startedAt,
      previousVisitId:
        previous && previous.sessionId !== visit.sessionId
          ? previous.visitId
          : "",
      previousVisitStartedAt:
        previous && previous.sessionId !== visit.sessionId
          ? previous.startedAt
          : null,
      pathname: visit.pathname,
      ...metadata,
      hash: "",
      title: visit.title,
      hostname: visit.hostname || profile.domain,
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
      browserVersion: visit.browserVersion,
      browser: visit.browser,
      osVersion: visit.osVersion,
      deviceType: visit.deviceType,
      language: visit.language,
      screenSize: visit.screenSize,
      screenWidth: Number.isFinite(screenWidth) ? screenWidth : null,
      screenHeight: Number.isFinite(screenHeight) ? screenHeight : null,
      latitude: Number.isFinite(visit.latitude) ? visit.latitude : null,
      longitude: Number.isFinite(visit.longitude) ? visit.longitude : null,
    };
  }

  private demoVisitToVisit(
    visit: DemoVisitFact,
    overrideActivityAt?: number,
  ): RealtimeVisit {
    const profile = findSiteProfile(this.siteId);
    const previous = this.visitorsByVisitorId.get(visit.visitorId);
    const activityAt = overrideActivityAt ?? visit.startedAt;
    const [screenWidth, screenHeight] = visit.screenSize
      .split("x")
      .map((value) => Number(value));
    const metadata = demoRealtimeMetadata(visit, activityAt, "active");
    return {
      visitId: visit.visitId,
      visitorId: visit.visitorId,
      sessionId: visit.sessionId,
      startedAt: previous?.startedAt ?? activityAt,
      lastActivityAt: activityAt,
      pathname: visit.pathname,
      hash: "",
      title: visit.title,
      hostname: visit.hostname || profile.domain,
      referrerUrl: visit.referrerUrl,
      referrerHost: visit.referrerHost,
      country: visit.country,
      region: visit.region,
      regionCode: visit.regionCode,
      city: visit.city,
      continent: visit.continent,
      timezone: visit.timezone,
      organization: visit.organization,
      siteId: this.siteId,
      ...metadata,
      browserVersion: visit.browserVersion,
      browser: visit.browser,
      osVersion: visit.osVersion,
      deviceType: visit.deviceType,
      language: visit.language,
      screenSize: visit.screenSize,
      screenWidth: Number.isFinite(screenWidth) ? screenWidth : null,
      screenHeight: Number.isFinite(screenHeight) ? screenHeight : null,
      latitude: Number.isFinite(visit.latitude) ? visit.latitude : null,
      longitude: Number.isFinite(visit.longitude) ? visit.longitude : null,
    };
  }

  private buildSnapshotPoints(): RealtimeVisitorPoint[] {
    const points: RealtimeVisitorPoint[] = [];
    for (const visit of Array.from(this.visitorsByVisitorId.values()).sort(
      (a, b) => b.lastActivityAt - a.lastActivityAt,
    )) {
      if (
        visit.latitude == null ||
        visit.longitude == null ||
        !Number.isFinite(visit.latitude) ||
        !Number.isFinite(visit.longitude)
      ) {
        continue;
      }
      points.push({
        visitorId: visit.visitorId,
        eventAt: visit.lastActivityAt,
        latitude: Number(visit.latitude),
        longitude: Number(visit.longitude),
        country: visit.country,
      });
    }
    return points;
  }

  private buildSnapshotVisits(): RealtimeVisit[] {
    return Array.from(this.visitorsByVisitorId.values()).sort(
      (left, right) => right.lastActivityAt - left.lastActivityAt,
    );
  }

  private clearTimers(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.nextEmitTimer) {
      clearTimeout(this.nextEmitTimer);
      this.nextEmitTimer = null;
    }
    if (this.dropTimer) {
      clearTimeout(this.dropTimer);
      this.dropTimer = null;
    }
  }
}

export function createMockRealtimeSocket(
  options: MockRealtimeSocketOptions,
): RealtimeSocketLike {
  return new MockRealtimeSocket(options);
}
