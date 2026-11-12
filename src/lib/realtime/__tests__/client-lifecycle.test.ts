import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ClientModule from "@/lib/realtime/client";

const { broadcastRealtimeMessageMock, createMockRealtimeSocketMock, sockets } =
  vi.hoisted(() => ({
    broadcastRealtimeMessageMock: vi.fn(),
    createMockRealtimeSocketMock: vi.fn(),
    sockets: [] as HeartbeatSocket[],
  }));

vi.mock("@/lib/realtime/broadcast-store", () => ({
  broadcastRealtimeMessage: broadcastRealtimeMessageMock,
}));

vi.mock("@/lib/demo/realtime/socket", () => ({
  createMockRealtimeSocket: createMockRealtimeSocketMock,
}));

class HeartbeatSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = HeartbeatSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly send = vi.fn();
  readonly close = vi.fn(() => {
    if (this.readyState === HeartbeatSocket.CLOSED) return;
    this.readyState = HeartbeatSocket.CLOSED;
    this.onclose?.();
  });

  constructor() {
    sockets.push(this);
  }

  open(): void {
    this.readyState = HeartbeatSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }
}

async function importClient(
  env: Record<string, string | undefined> = {},
): Promise<typeof ClientModule> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import("@/lib/realtime/client");
}

function envelope(type: "event" | "snapshot", data: unknown): string {
  return JSON.stringify({ type, data });
}

describe("realtime client lifecycle and normalization", () => {
  beforeEach(() => {
    sockets.length = 0;
    broadcastRealtimeMessageMock.mockReset();
    broadcastRealtimeMessageMock.mockResolvedValue(undefined);
    createMockRealtimeSocketMock.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));
    vi.stubGlobal("WebSocket", HeartbeatSocket);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("cancels the idle release timer when a channel is re-acquired within the grace period", async () => {
    const client = await importClient();
    const releaseA = client.acquireRealtimeChannel("site-grace");
    const socket = sockets[0]!;
    socket.open();

    releaseA();
    // A second release of an already idle channel must not arm another timer.
    releaseA();
    vi.advanceTimersByTime(10_000);
    const releaseB = client.acquireRealtimeChannel("site-grace");
    vi.advanceTimersByTime(60_000);

    expect(sockets).toHaveLength(1);
    expect(socket.close).not.toHaveBeenCalled();
    expect(client.getRealtimeChannelState("site-grace").status).toBe(
      "connected",
    );
    releaseB();
    vi.advanceTimersByTime(30_000);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("sends heartbeats while open and survives send failures", async () => {
    const client = await importClient();
    const release = client.acquireRealtimeChannel("site-heartbeat");
    const socket = sockets[0]!;
    socket.open();

    vi.advanceTimersByTime(30_000);
    expect(socket.send).toHaveBeenCalledWith("ping");

    socket.send.mockImplementation(() => {
      throw new Error("stale socket");
    });
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
    expect(socket.send).toHaveBeenCalledTimes(2);

    socket.readyState = HeartbeatSocket.CLOSING;
    vi.advanceTimersByTime(30_000);
    expect(socket.send).toHaveBeenCalledTimes(2);
    release();
  });

  it("stops heartbeats once the socket closes", async () => {
    const client = await importClient();
    const release = client.acquireRealtimeChannel("site-heartbeat-stop");
    const socket = sockets[0]!;
    socket.open();
    socket.close();
    socket.send.mockClear();

    vi.advanceTimersByTime(25_000);
    expect(socket.send).not.toHaveBeenCalled();
    release();
  });

  it("clears pending reconnect and flush timers when the channel is torn down", async () => {
    const client = await importClient();
    const release = client.acquireRealtimeChannel("site-teardown");
    const first = sockets[0]!;
    first.open();
    first.message(
      envelope("event", {
        id: "pending",
        eventType: "pageview",
        eventAt: Date.now(),
        visitorId: "v1",
      }),
    );
    // A server-side close schedules a reconnect timer.
    first.readyState = HeartbeatSocket.CLOSED;
    first.onclose?.();
    release();
    vi.advanceTimersByTime(30_000);

    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(client.getRealtimeChannelState("site-teardown").events).toEqual([]);
  });

  it("drops buffered events when a snapshot replaces them", async () => {
    const client = await importClient();
    const release = client.acquireRealtimeChannel("site-snapshot-flush");
    const socket = sockets[0]!;
    socket.open();
    const now = Date.now();

    socket.message(
      envelope("event", {
        id: "buffered",
        eventType: "pageview",
        eventAt: now,
        visitorId: "v-buffered",
      }),
    );
    socket.message(
      envelope("snapshot", {
        activeNow: 3,
        events: [
          {
            id: "from-snapshot",
            eventType: "pageview",
            eventAt: now - 1000,
            visitorId: "v-snapshot",
          },
        ],
      }),
    );
    vi.advanceTimersByTime(200);

    const state = client.getRealtimeChannelState("site-snapshot-flush");
    expect(state.events.map((event) => event.id)).toEqual(["from-snapshot"]);
    expect(state.snapshotActiveNow).toBe(3);
    release();
  });

  it("ignores a mock socket factory that yields no socket", async () => {
    createMockRealtimeSocketMock.mockReturnValue(null);
    const client = await importClient({ VITE_DEMO_MODE: "1" });
    const release = client.acquireRealtimeChannel("site-null-mock");
    await vi.advanceTimersByTimeAsync(0);

    expect(createMockRealtimeSocketMock).toHaveBeenCalledTimes(1);
    expect(client.getRealtimeChannelState("site-null-mock").status).toBe(
      "connecting",
    );
    release();
  });

  it("uses the latest visibility state per visit to drop hidden visits from active counts", async () => {
    const client = await importClient();
    const release = client.acquireRealtimeChannel("site-visibility");
    const socket = sockets[0]!;
    socket.open();
    const now = Date.now();
    const base = { eventType: "pageview", eventKind: "pageview" };

    socket.message(
      envelope("snapshot", {
        events: [
          {
            ...base,
            id: "a-view",
            eventAt: now - 3000,
            visitId: "visit-a",
            visitorId: "visitor-a",
          },
          {
            id: "a-hidden",
            eventType: "visibility",
            eventAt: now - 1000,
            visitId: "visit-a",
            visitorId: "visitor-a",
            visibilityState: "hidden",
          },
          {
            ...base,
            id: "b-view",
            eventAt: now - 3000,
            visitId: "visit-b",
            visitorId: "visitor-b",
          },
          {
            id: "b-hidden-old",
            eventType: "visibility",
            eventAt: now - 2000,
            visitId: "visit-b",
            visitorId: "visitor-b",
            visibilityState: "hidden",
          },
          {
            id: "b-visible-new",
            eventType: "visibility",
            eventAt: now - 500,
            visitId: "visit-b",
            visitorId: "visitor-b",
            visibilityState: "visible",
          },
        ],
      }),
    );

    const state = client.getRealtimeChannelState("site-visibility");
    expect(state.events).toHaveLength(5);
    expect(state.activeNow).toBe(1);
    expect(state.viewsLast30m).toBe(2);
    expect(state.visitorsLast30m).toBe(2);
    release();
  });

  it("normalizes booleans, screen sizes and event kinds from loosely typed payloads", async () => {
    const client = await importClient();
    const release = client.acquireRealtimeChannel("site-normalize");
    const socket = sockets[0]!;
    socket.open();
    const now = Date.now();

    socket.message(
      envelope("snapshot", {
        events: [
          {
            id: "e1",
            eventType: "pageview",
            eventAt: now,
            visitorId: "v1",
            is_eu: "true",
            screenWidth: 1280.4,
            screenHeight: "720",
          },
          {
            id: "e2",
            eventType: "pageview",
            eventAt: now - 1,
            visitorId: "v2",
            isEU: 0,
            screen_size: " 800x600 ",
          },
          {
            id: "e3",
            eventType: "pageview",
            eventAt: now - 2,
            visitorId: "v3",
            isEU: "maybe",
            screenWidth: 100,
          },
          {
            id: "e4",
            eventType: "pageview",
            eventAt: now - 3,
            visitorId: "v4",
            isEU: "",
            receivedAt: "not-a-number",
          },
          {
            id: "e5",
            eventType: "pageview",
            eventAt: now - 4,
            visitorId: "v5",
            isEU: 1,
          },
          {
            id: "e6",
            eventType: "pageview",
            eventAt: now - 5,
            visitorId: "v6",
            isEU: "false",
          },
          { id: "k1", eventType: "visibility", eventAt: now - 6, visitId: "x" },
          { id: "k2", eventType: "identify", eventAt: now - 7, visitId: "x" },
          { id: "k3", eventType: "purchase", eventAt: now - 8 },
        ],
      }),
    );

    const byId = new Map(
      client
        .getRealtimeChannelState("site-normalize")
        .events.map((event) => [event.id, event]),
    );
    expect(byId.get("e1")).toMatchObject({
      isEU: true,
      screenSize: "1280x720",
    });
    expect(byId.get("e2")).toMatchObject({
      isEU: false,
      screenSize: "800x600",
    });
    expect(byId.get("e3")).toMatchObject({ isEU: undefined, screenSize: "" });
    expect(byId.get("e4")).toMatchObject({
      isEU: undefined,
      receivedAt: null,
    });
    expect(byId.get("e5")?.isEU).toBe(true);
    expect(byId.get("e6")?.isEU).toBe(false);
    expect(byId.get("k1")?.eventKind).toBe("visibility");
    expect(byId.get("k2")?.eventKind).toBe("identify");
    expect(byId.get("k3")?.eventKind).toBe("custom_event");
    release();
  });

  it("skips non-object snapshot points and visits", async () => {
    const client = await importClient();
    const release = client.acquireRealtimeChannel("site-bad-items");
    const socket = sockets[0]!;
    socket.open();

    socket.message(
      envelope("snapshot", {
        activeNow: 2.9,
        points: [null, "x", 5],
        visits: [
          null,
          "x",
          { visitId: "v1", visitorId: "u1", lastActivityAt: Date.now() },
        ],
      }),
    );

    const state = client.getRealtimeChannelState("site-bad-items");
    expect(state.snapshotActiveNow).toBe(2);
    expect(state.visits.map((visit) => visit.visitId)).toEqual(["v1"]);
    expect(state.points).toEqual([]);
    release();
  });
});
