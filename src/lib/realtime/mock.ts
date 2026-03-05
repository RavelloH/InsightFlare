import type { RealtimeEvent } from "@/lib/realtime/types";

type RealtimeSocketMessage =
  | {
      type: "snapshot";
      data: {
        activeNow: number;
        events: RealtimeEvent[];
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

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

class MockRealtimeSocket implements RealtimeSocketLike {
  readyState: WebSocket["readyState"] = READY_STATE.CONNECTING;
  onopen: WebSocket["onopen"] = null;
  onmessage: WebSocket["onmessage"] = null;
  onerror: WebSocket["onerror"] = null;
  onclose: WebSocket["onclose"] = null;

  private readonly activeWindowMs: number;
  private readonly siteId: string;
  private readonly visitors = new Map<string, number>();
  private recentEvents: RealtimeEvent[] = [];
  private sequence = 0;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private dropTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({ siteId, activeWindowMs = 5 * 60 * 1000 }: MockRealtimeSocketOptions) {
    this.siteId = siteId;
    this.activeWindowMs = activeWindowMs;
    this.seedSnapshot();
    this.beginHandshake();
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === READY_STATE.CLOSED) return;
    this.readyState = READY_STATE.CLOSING;
    this.clearTimers();
    this.readyState = READY_STATE.CLOSED;
    this.emitClose(code ?? 1000, reason ?? "mock closed", (code ?? 1000) === 1000);
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
      this.startEventStream();
      this.scheduleDisconnect();
    }, handshakeDelayMs);
  }

  private startEventStream(): void {
    this.eventTimer = setInterval(() => {
      if (this.readyState !== READY_STATE.OPEN) return;
      const burst = randomInt(1, 3);
      const now = Date.now();
      for (let i = 0; i < burst; i += 1) {
        const event = this.generateEvent(now);
        this.emitMessage({
          type: "event",
          data: event,
        });
      }

      if (Math.random() < 0.08) {
        this.emitSnapshot();
      }
    }, 850);
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
    this.onopen?.call(
      this as unknown as WebSocket,
      new Event("open"),
    );
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
    this.onerror?.call(
      this as unknown as WebSocket,
      new Event("error"),
    );
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

    const activeNow = Math.max(0, this.visitors.size + randomInt(0, 4));
    const events = this.recentEvents.slice(-160);
    this.emitMessage({
      type: "snapshot",
      data: {
        activeNow,
        events,
      },
    });
  }

  private seedSnapshot(): void {
    const now = Date.now();
    const initialEvents = randomInt(26, 72);
    for (let i = 0; i < initialEvents; i += 1) {
      const event = this.buildEvent({
        visitorId: this.nextVisitorId(),
        eventAt: now - randomInt(0, Math.max(1, this.activeWindowMs - 1000)),
      });
      this.trackEvent(event);
    }
    this.prune(now);
  }

  private generateEvent(now: number): RealtimeEvent {
    const useExisting = this.visitors.size > 0 && Math.random() < 0.72;
    let visitorId = this.nextVisitorId();
    if (useExisting) {
      const ids = Array.from(this.visitors.keys());
      visitorId = ids[randomInt(0, ids.length - 1)];
    }

    const event = this.buildEvent({
      visitorId,
      eventAt: now,
    });
    this.trackEvent(event);
    this.prune(now);
    return event;
  }

  private trackEvent(event: RealtimeEvent): void {
    this.visitors.set(event.visitorId, event.eventAt);
    this.recentEvents.push(event);
  }

  private prune(now: number): void {
    const cutoff = now - this.activeWindowMs;

    this.recentEvents = this.recentEvents.filter((item) => item.eventAt >= cutoff);
    for (const [visitorId, eventAt] of this.visitors.entries()) {
      if (eventAt < cutoff) {
        this.visitors.delete(visitorId);
      }
    }
  }

  private nextVisitorId(): string {
    const suffix = this.sequence.toString(36);
    this.sequence += 1;
    return `${this.siteId}-visitor-${suffix}`;
  }

  private nextEventId(): string {
    const suffix = this.sequence.toString(36);
    this.sequence += 1;
    return `${this.siteId}-event-${suffix}`;
  }

  private buildEvent(input: {
    visitorId: string;
    eventAt: number;
  }): RealtimeEvent {
    const eventTypes = ["pageview", "route_change", "click", "purchase"];
    const countries = ["CN", "US", "DE", "SG", "JP", "GB"];
    const browsers = ["Chrome", "Safari", "Edge", "Firefox"];
    const paths = ["/", "/pricing", "/docs", "/blog", "/dashboard"];

    return {
      id: this.nextEventId(),
      eventType: eventTypes[randomInt(0, eventTypes.length - 1)],
      eventAt: input.eventAt,
      pathname: paths[randomInt(0, paths.length - 1)],
      visitorId: input.visitorId,
      country: countries[randomInt(0, countries.length - 1)],
      browser: browsers[randomInt(0, browsers.length - 1)],
    };
  }

  private clearTimers(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.eventTimer) {
      clearInterval(this.eventTimer);
      this.eventTimer = null;
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
