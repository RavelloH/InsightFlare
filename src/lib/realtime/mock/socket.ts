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
    this.visitorsByVisitorId.clear();
    this.recentEvents = [];

    const recordCutoff = now - RECENT_RECORD_WINDOW_MS;
    const activeCutoff = now - this.activeWindowMs;
    for (const visit of past) {
      if (visit.startedAt < recordCutoff) continue;
      const event = this.demoVisitToEvent(visit);
      this.recentEvents.push(event);
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
    return {
      id: this.nextEventId(),
      eventType: visit.eventType,
      eventKind: isPageview ? "pageview" : "custom_event",
      eventAt: overrideEventAt ?? visit.startedAt,
      siteId: this.siteId,
      eventName: isPageview ? "" : visit.eventType,
      eventData: null,
      visitId: visit.visitId,
      sessionId: visit.sessionId,
      startedAt: visit.startedAt,
      pathname: visit.pathname,
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
      os: "",
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
      browserVersion: visit.browserVersion,
      os: "",
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
