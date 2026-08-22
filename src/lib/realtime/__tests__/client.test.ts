import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ClientModule from "@/lib/realtime/client";
import type { RealtimeChannelState } from "@/lib/realtime/types";

type MessageHandler = (event: { data: unknown }) => void;
type EmptyHandler = () => void;

const { broadcastRealtimeMessageMock, createMockRealtimeSocketMock, sockets } =
  vi.hoisted(() => ({
    broadcastRealtimeMessageMock: vi.fn(),
    createMockRealtimeSocketMock: vi.fn(),
    sockets: [] as FakeSocket[],
  }));

vi.mock("@/lib/realtime/broadcast-store", () => ({
  broadcastRealtimeMessage: broadcastRealtimeMessageMock,
}));

vi.mock("@/lib/realtime/mock/socket", () => ({
  createMockRealtimeSocket: createMockRealtimeSocketMock,
}));

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  onopen: EmptyHandler | null = null;
  onmessage: MessageHandler | null = null;
  onerror: EmptyHandler | null = null;
  onclose: EmptyHandler | null = null;
  readonly close = vi.fn(() => {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  });

  constructor(readonly url = "mock://socket") {
    sockets.push(this);
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  error(): void {
    this.onerror?.();
  }

  closeFromServer(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
}

function latestBroadcastState(): RealtimeChannelState {
  const call = broadcastRealtimeMessageMock.mock.calls.at(-1);
  if (!call) throw new Error("No realtime broadcast was recorded");
  return call[0].state as RealtimeChannelState;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

async function importClientWithEnv(
  env: Record<string, string | undefined> = {},
): Promise<typeof ClientModule> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return import("@/lib/realtime/client");
}

function realtimeMessage(type: "event" | "snapshot", data?: unknown): string {
  return JSON.stringify({ type, data });
}

function releaseAll(releases: Array<() => void>): void {
  while (releases.length > 0) {
    releases.pop()?.();
  }
}

describe("realtime client", () => {
  let releases: Array<() => void>;

  beforeEach(() => {
    releases = [];
    sockets.length = 0;
    broadcastRealtimeMessageMock.mockReset();
    broadcastRealtimeMessageMock.mockResolvedValue(undefined);
    createMockRealtimeSocketMock.mockReset();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));
  });

  afterEach(() => {
    releaseAll(releases);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports mock mode from the demo environment", async () => {
    await expect(
      importClientWithEnv().then((client) => client.isRealtimeMockEnabled()),
    ).resolves.toBe(false);

    await expect(
      importClientWithEnv({
        VITE_DEMO_MODE: "1",
        NODE_ENV: "production",
      }).then((client) => client.isRealtimeMockEnabled()),
    ).resolves.toBe(true);

    await expect(
      importClientWithEnv({ NODE_ENV: "production" }).then((client) =>
        client.isRealtimeMockEnabled(),
      ),
    ).resolves.toBe(false);
  });

  it("provides stable snapshots and notifies channel subscribers", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);

    const listener = vi.fn();
    const noopUnsubscribe = client.subscribeRealtimeChannel(
      undefined,
      listener,
    );
    noopUnsubscribe();

    const idleSnapshot = client.getRealtimeChannelSnapshot();
    expect(client.getRealtimeChannelSnapshot()).toBe(idleSnapshot);

    const unsubscribe = client.subscribeRealtimeChannel(
      "site-subscriber",
      listener,
    );
    expect(client.getRealtimeChannelSnapshot("site-subscriber")).toBe(
      client.getRealtimeChannelSnapshot("site-subscriber"),
    );

    releases.push(client.acquireRealtimeChannel("site-subscriber"));
    expect(listener).toHaveBeenCalled();

    unsubscribe();
  });

  it("returns cloned idle state for empty and missing site ids", async () => {
    const client = await importClientWithEnv();

    expect(client.createIdleRealtimeChannelState()).toEqual({
      status: "disconnected",
      hasConnected: false,
      activeNow: 0,
      visitorsLast30m: 0,
      viewsLast30m: 0,
      snapshotActiveNow: null,
      events: [],
      points: [],
      visits: [],
    });
    expect(client.createIdleRealtimeChannelState("failed").status).toBe(
      "failed",
    );

    const noSiteState = client.getRealtimeChannelState();
    noSiteState.events.push({
      id: "mutated",
      eventType: "visit",
      eventAt: Date.now(),
      visitId: "",
      sessionId: "",
      pathname: "/",
      hash: "",
      title: "",
      hostname: "",
      referrerUrl: "",
      referrerHost: "",
      visitorId: "visitor",
      country: "",
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
      latitude: null,
      longitude: null,
    });

    expect(client.getRealtimeChannelState()).toEqual(
      client.createIdleRealtimeChannelState(),
    );
    expect(client.getRealtimeChannelState("missing")).toEqual(
      client.createIdleRealtimeChannelState(),
    );
  });

  it("does nothing for empty site ids", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);

    const release = client.acquireRealtimeChannel("");

    expect(release).toEqual(expect.any(Function));
    expect(sockets).toHaveLength(0);
    expect(broadcastRealtimeMessageMock).not.toHaveBeenCalled();
    expect(() => release()).not.toThrow();
  });

  it("builds a same-origin websocket URL", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    window.history.pushState(null, "", "http://localhost:3000/dashboard");

    releases.push(client.acquireRealtimeChannel("site url"));

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe(
      "ws://localhost:3000/api/private/realtime/ws?siteId=site+url",
    );
    expect(latestBroadcastState().status).toBe("connecting");
  });

  it("builds a websocket URL from window.location when no edge URL is configured", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    window.history.pushState(null, "", "http://localhost:3000/dashboard");

    releases.push(client.acquireRealtimeChannel("site-local"));

    expect(sockets[0]?.url).toBe(
      "ws://localhost:3000/api/private/realtime/ws?siteId=site-local",
    );
  });

  it("surfaces real websocket constructor failures when websocket is unavailable", async () => {
    const client = await importClientWithEnv();
    const WebSocketMock = vi.fn(() => {
      throw new Error("WebSocket unsupported");
    });
    vi.stubGlobal("WebSocket", WebSocketMock);

    expect(() => client.acquireRealtimeChannel("site-no-websocket")).toThrow(
      "WebSocket unsupported",
    );
    expect(WebSocketMock).toHaveBeenCalledTimes(1);
    expect(client.getRealtimeChannelState("site-no-websocket").status).toBe(
      "connecting",
    );
  });

  it("opens one socket for multiple acquires and removes the channel only after the final release", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);

    const releaseA = client.acquireRealtimeChannel("site-ref");
    releases.push(releaseA);
    const socket = sockets[0]!;
    socket.open();
    broadcastRealtimeMessageMock.mockClear();

    const releaseB = client.acquireRealtimeChannel("site-ref");
    releases.push(releaseB);

    expect(sockets).toHaveLength(1);
    expect(latestBroadcastState().status).toBe("connected");

    releaseB();
    releases.pop();
    expect(socket.close).not.toHaveBeenCalled();
    expect(client.getRealtimeChannelState("site-ref").status).toBe("connected");

    releaseA();
    releases.pop();
    vi.advanceTimersByTime(30_000);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(client.getRealtimeChannelState("site-ref").status).toBe(
      "disconnected",
    );
    expect(() => releaseA()).not.toThrow();
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up released channels without closing sockets that are already closing", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    const release = client.acquireRealtimeChannel("site-closing-release");
    releases.push(release);
    const socket = sockets[0]!;

    socket.readyState = FakeSocket.CLOSING;
    release();
    releases.pop();
    vi.advanceTimersByTime(30_000);

    expect(socket.close).not.toHaveBeenCalled();
    expect(client.getRealtimeChannelState("site-closing-release").status).toBe(
      "disconnected",
    );
  });

  it("keeps returned states and broadcasts cloned from internal state", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-clone"));
    const socket = sockets[0]!;
    socket.open();
    const eventNow = Date.now();
    socket.message(
      realtimeMessage("event", {
        id: "clone-event",
        eventType: "visit",
        eventAt: eventNow,
        visitorId: "visitor-clone",
        visitId: "visit-clone",
        latitude: 10,
        longitude: 20,
      }),
    );
    vi.advanceTimersByTime(80);

    const state = client.getRealtimeChannelState("site-clone");
    const broadcastState = latestBroadcastState();
    state.events.length = 0;
    broadcastState.events.length = 0;

    expect(client.getRealtimeChannelState("site-clone").events).toHaveLength(1);
    expect(latestBroadcastState().events).toHaveLength(0);
  });

  it("applies event envelopes, normalizes snake_case fields, merges visits, and ignores malformed messages", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-events"));
    const socket = sockets[0]!;
    socket.open();

    socket.message("not-json");
    socket.message(JSON.stringify({ type: "ignored", data: {} }));
    expect(client.getRealtimeChannelState("site-events").events).toHaveLength(
      0,
    );

    const eventNow = Date.now();
    socket.message(
      realtimeMessage("event", {
        id: "evt-old",
        event_type: "visit",
        event_at: eventNow - 1_000,
        visit_id: "visit-1",
        session_id: "session-1",
        pathname: "/first",
        visitor_id: "visitor-1",
        country: "US",
        latitude: "40.7",
        longitude: "-74",
      }),
    );
    socket.message(
      realtimeMessage("event", {
        id: "evt-new",
        eventType: "pageview",
        eventAt: eventNow,
        visitId: "visit-1",
        sessionId: "session-1",
        pathname: "/second",
        hash_fragment: "#details",
        title: "Second",
        hostname: "example.test",
        referrer_url: "https://ref.example",
        referrer_host: "ref.example",
        visitorId: "visitor-1",
        region: "New York",
        region_code: "NY",
        city: "New York",
        continent: "NA",
        timezone: "America/New_York",
        as_organization: "Example ISP",
        browser: "Chrome",
        os_version: "macOS 15",
        device_type: "desktop",
        language: "en-US",
        screen_size: "1440x900",
        latitude: 41,
        longitude: -73,
      }),
    );
    vi.advanceTimersByTime(80);

    const state = client.getRealtimeChannelState("site-events");
    expect(state.status).toBe("connected");
    expect(state.hasConnected).toBe(true);
    expect(state.events.map((event) => event.id)).toEqual([
      "evt-new",
      "evt-old",
    ]);
    expect(state.activeNow).toBe(1);
    expect(state.visitorsLast30m).toBe(1);
    expect(state.viewsLast30m).toBe(2);
    expect(state.points).toEqual([
      {
        visitorId: "visitor-1",
        eventAt: eventNow,
        latitude: 41,
        longitude: -73,
        country: "",
      },
    ]);
    expect(state.visits).toMatchObject([
      {
        visitId: "visit-1",
        visitorId: "visitor-1",
        sessionId: "session-1",
        startedAt: eventNow - 1_000,
        lastActivityAt: eventNow,
        pathname: "/second",
        hash: "#details",
        title: "Second",
        hostname: "example.test",
        referrerUrl: "https://ref.example",
        referrerHost: "ref.example",
        country: "US",
        region: "New York",
        regionCode: "NY",
        city: "New York",
        continent: "NA",
        timezone: "America/New_York",
        organization: "Example ISP",
        browser: "Chrome",
        osVersion: "macOS 15",
        deviceType: "desktop",
        language: "en-US",
        screenSize: "1440x900",
        latitude: 41,
        longitude: -73,
      },
    ]);
  });

  it("normalizes default event fields from non-string envelopes and prunes zero-time activity on recompute", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-default-event"));
    const socket = sockets[0]!;
    socket.open();

    socket.message({
      toString: () => realtimeMessage("event", {}),
    });
    const eventNow = Date.now();
    vi.advanceTimersByTime(80);

    expect(client.getRealtimeChannelState("site-default-event")).toMatchObject({
      activeNow: 0,
      visitorsLast30m: 0,
      viewsLast30m: 0,
      events: [
        {
          id: `${eventNow}-`,
          eventType: "",
          eventAt: eventNow,
          visitorId: "",
          pathname: "/",
        },
      ],
    });

    socket.message(
      realtimeMessage("event", {
        id: "zero-time",
        eventType: "visit",
        eventAt: 0,
        visitorId: "zero-visitor",
      }),
    );

    expect(
      client
        .getRealtimeChannelState("site-default-event")
        .events.map((event) => event.id),
    ).not.toContain("zero-time");
  });

  it("dedupes events, sorts presence leaves behind same-time activity, and removes expired records", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-dedupe"));
    const socket = sockets[0]!;
    socket.open();
    const now = Date.now();

    socket.message(
      realtimeMessage("snapshot", {
        activeNow: 4.8,
        events: [
          {
            id: "old",
            eventType: "visit",
            eventAt: now - 30 * 60 * 1000 - 1,
            visitorId: "old-visitor",
          },
          {
            id: "same-time-visit",
            eventType: "visit",
            eventAt: now,
            visitorId: "active",
            latitude: 1,
            longitude: 2,
          },
          {
            id: "same-time-leave",
            eventType: "__presence_leave",
            eventAt: now,
            visitorId: "active",
            latitude: 1,
            longitude: 2,
          },
          {
            id: "dupe",
            eventType: "visit",
            eventAt: now - 100,
            visitorId: "dupe-old",
          },
          {
            id: "dupe",
            eventType: "pageview",
            eventAt: now - 50,
            visitorId: "dupe-new",
          },
        ],
      }),
    );

    const state = client.getRealtimeChannelState("site-dedupe");
    expect(state.snapshotActiveNow).toBe(4);
    expect(state.events.map((event) => event.id)).toEqual([
      "same-time-visit",
      "same-time-leave",
      "dupe",
    ]);
    expect(state.activeNow).toBe(2);
    expect(state.viewsLast30m).toBe(2);
    expect(state.visitorsLast30m).toBe(2);
  });

  it("ignores empty event ids, keeps newer duplicates, and treats latest presence leaves as inactive", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-presence"));
    const socket = sockets[0]!;
    socket.open();
    const now = Date.now();

    socket.message(
      realtimeMessage("snapshot", {
        events: [
          {
            id: "",
            eventType: "visit",
            eventAt: now,
            visitorId: "empty-id",
          },
          {
            id: "no-visitor",
            eventType: "visit",
            eventAt: now - 25,
          },
          {
            id: "dupe-stays",
            eventType: "pageview",
            eventAt: now - 50,
            visitorId: "dupe-visitor",
            latitude: 10,
            longitude: 20,
          },
          {
            id: "departed-leave",
            eventType: "__presence_leave",
            eventAt: now - 100,
            visitorId: "departed",
            latitude: 30,
            longitude: 40,
          },
          {
            id: "departed-visit",
            eventType: "visit",
            eventAt: now - 200,
            visitorId: "departed",
            latitude: 30,
            longitude: 40,
          },
          {
            id: "dupe-stays",
            eventType: "visit",
            eventAt: now - 500,
            visitorId: "dupe-old",
          },
        ],
      }),
    );

    const state = client.getRealtimeChannelState("site-presence");
    expect(state.events.map((event) => event.id)).toEqual([
      "no-visitor",
      "dupe-stays",
      "departed-leave",
      "departed-visit",
    ]);
    expect(state.activeNow).toBe(1);
    expect(state.visitorsLast30m).toBe(2);
    expect(state.viewsLast30m).toBe(3);
    expect(state.points).toEqual([
      {
        visitorId: "dupe-visitor",
        eventAt: now - 50,
        latitude: 10,
        longitude: 20,
        country: "",
      },
    ]);
  });

  it("derives events from snapshot visits when event arrays are absent", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-visits"));
    const socket = sockets[0]!;
    socket.open();
    const now = Date.now();

    socket.message(
      realtimeMessage("snapshot", {
        visits: [
          {
            visitId: "visit-b",
            visitorId: "visitor-b",
            sessionId: "session-b",
            startedAt: now - 20_000,
            lastActivityAt: now - 500,
            pathname: "/visit-b",
            country: "US",
            latitude: 41,
            longitude: -74,
          },
          {
            visit_id: "visit-a",
            visitor_id: "visitor-a",
            session_id: "session-a",
            started_at: now - 10_000,
            last_activity_at: now - 1_000,
            pathname: "/visit-a",
            country: "CA",
            latitude: "45",
            longitude: "-75",
          },
          {
            visitId: "missing-visitor",
          },
        ],
      }),
    );

    const state = client.getRealtimeChannelState("site-visits");
    expect(state.events).toHaveLength(2);
    expect(state.events[0]).toMatchObject({
      id: `snapshot:visit-b:${now - 500}`,
      eventType: "visit",
      eventAt: now - 500,
      visitId: "visit-b",
      visitorId: "visitor-b",
      country: "US",
      latitude: 41,
      longitude: -74,
    });
    expect(state.events[1]).toMatchObject({
      id: `snapshot:visit-a:${now - 1_000}`,
      eventType: "visit",
      eventAt: now - 1_000,
      visitId: "visit-a",
      visitorId: "visitor-a",
      country: "CA",
      latitude: 45,
      longitude: -75,
    });
    expect(state.visits).toMatchObject([
      {
        visitId: "visit-b",
        startedAt: now - 500,
        lastActivityAt: now - 500,
        pathname: "/visit-b",
      },
      {
        visitId: "visit-a",
        startedAt: now - 1_000,
        lastActivityAt: now - 1_000,
        pathname: "/visit-a",
      },
    ]);
    expect(state.points).toEqual([
      {
        visitorId: "visitor-b",
        eventAt: now - 500,
        latitude: 41,
        longitude: -74,
        country: "US",
      },
      {
        visitorId: "visitor-a",
        eventAt: now - 1_000,
        latitude: 45,
        longitude: -75,
        country: "CA",
      },
    ]);
  });

  it("falls back for invalid snapshot point and visit timestamps and default visit fields", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-snapshot-fallbacks"));
    const socket = sockets[0]!;
    socket.open();

    socket.message(
      realtimeMessage("snapshot", {
        points: [
          {
            visitorId: "point-invalid-time",
            eventAt: "not-a-number",
            latitude: 12,
            longitude: 34,
            country: "NL",
          },
        ],
      }),
    );

    expect(client.getRealtimeChannelState("site-snapshot-fallbacks")).toEqual(
      expect.objectContaining({
        events: [
          expect.objectContaining({
            id: `snapshot-point:point-invalid-time:${Date.now()}`,
            eventAt: Date.now(),
            visitorId: "point-invalid-time",
          }),
        ],
        points: [
          {
            visitorId: "point-invalid-time",
            eventAt: Date.now(),
            latitude: 12,
            longitude: 34,
            country: "NL",
          },
        ],
      }),
    );

    socket.message(
      realtimeMessage("snapshot", {
        visits: [
          {
            visitId: "visit-fallback",
            visitorId: "visitor-fallback",
            startedAt: "bad-start",
            lastActivityAt: "bad-last",
            hash: "#from-hash",
            asOrganization: "Fallback ISP",
          },
        ],
      }),
    );

    const state = client.getRealtimeChannelState("site-snapshot-fallbacks");
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      id: `snapshot:visit-fallback:${Date.now()}`,
      eventAt: Date.now(),
      visitId: "visit-fallback",
      visitorId: "visitor-fallback",
      pathname: "/",
      hash: "#from-hash",
      organization: "Fallback ISP",
      latitude: null,
      longitude: null,
    });
    expect(state.visits).toMatchObject([
      {
        visitId: "visit-fallback",
        startedAt: Date.now(),
        lastActivityAt: Date.now(),
        pathname: "/",
        hash: "#from-hash",
        organization: "Fallback ISP",
      },
    ]);
    expect(state.points).toEqual([]);
  });

  it("derives events from snapshot points and rejects invalid point coordinates", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-points"));
    const socket = sockets[0]!;
    socket.open();
    const now = Date.now();

    socket.message(
      realtimeMessage("snapshot", {
        activeNow: -1,
        points: [
          {
            visitor_id: "visitor-point",
            event_at: now - 2_000,
            latitude: "10.5",
            longitude: "20.25",
            country: "GB",
          },
          {
            visitorId: "bad-latitude",
            eventAt: now,
            latitude: 100,
            longitude: 20,
          },
          {
            visitorId: "",
            eventAt: now,
            latitude: 10,
            longitude: 20,
          },
        ],
      }),
    );

    const state = client.getRealtimeChannelState("site-points");
    expect(state.snapshotActiveNow).toBeNull();
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      id: `snapshot-point:visitor-point:${now - 2_000}`,
      eventType: "visit",
      pathname: "/",
      visitorId: "visitor-point",
      latitude: 10.5,
      longitude: 20.25,
    });
    expect(state.activeNow).toBe(1);
    expect(state.points).toEqual([
      {
        visitorId: "visitor-point",
        eventAt: now - 2_000,
        latitude: 10.5,
        longitude: 20.25,
        country: "GB",
      },
    ]);
  });

  it("handles invalid snapshot payloads and publishes unchanged state for invalid event payloads", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-invalid"));
    const socket = sockets[0]!;
    socket.open();

    socket.message(realtimeMessage("snapshot", null));
    expect(client.getRealtimeChannelState("site-invalid")).toMatchObject({
      activeNow: 0,
      visitorsLast30m: 0,
      viewsLast30m: 0,
      snapshotActiveNow: null,
      events: [],
      points: [],
      visits: [],
    });

    broadcastRealtimeMessageMock.mockClear();
    socket.message(realtimeMessage("event", null));
    expect(broadcastRealtimeMessageMock).not.toHaveBeenCalled();
  });

  it("falls back to Date.now for invalid event timestamps and coordinates", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-invalid-event"));
    const socket = sockets[0]!;
    socket.open();

    const eventNow = Date.now();
    socket.message(
      realtimeMessage("event", {
        eventAt: "not-a-date",
        eventType: "custom",
        visitorId: "visitor-invalid",
        latitude: 91,
        longitude: -181,
      }),
    );
    vi.advanceTimersByTime(80);

    const state = client.getRealtimeChannelState("site-invalid-event");
    expect(state.events).toMatchObject([
      {
        id: "NaN-visitor-invalid",
        eventAt: eventNow,
        eventType: "custom",
        visitorId: "visitor-invalid",
        latitude: null,
        longitude: null,
      },
    ]);
    expect(state.activeNow).toBe(1);
    expect(state.points).toEqual([]);
    expect(state.viewsLast30m).toBe(0);
  });

  it("periodically prunes stale activity and publishes the recomputed state", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-recompute"));
    const socket = sockets[0]!;
    socket.open();
    socket.message(
      realtimeMessage("event", {
        id: "soon-stale",
        eventType: "visit",
        eventAt: Date.now(),
        visitorId: "visitor-recompute",
      }),
    );
    vi.advanceTimersByTime(80);
    expect(client.getRealtimeChannelState("site-recompute").activeNow).toBe(1);

    vi.advanceTimersByTime(30 * 60 * 1000 + 5_000);

    const state = client.getRealtimeChannelState("site-recompute");
    expect(state.events).toEqual([]);
    expect(state.activeNow).toBe(0);
    expect(state.visitorsLast30m).toBe(0);
    expect(latestBroadcastState().events).toEqual([]);
  });

  it("closes connecting sockets when the connect watchdog expires and reconnects", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-watchdog"));
    const firstSocket = sockets[0]!;

    vi.advanceTimersByTime(4_000);

    expect(firstSocket.close).toHaveBeenCalledTimes(1);
    expect(client.getRealtimeChannelState("site-watchdog").status).toBe(
      "disconnected",
    );

    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
    expect(client.getRealtimeChannelState("site-watchdog").status).toBe(
      "connecting",
    );
  });

  it("marks a channel failed after repeated pre-open closes", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-failures"));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      sockets.at(-1)?.closeFromServer();
      if (attempt < 4) {
        vi.advanceTimersByTime(2_000);
      }
    }

    expect(client.getRealtimeChannelState("site-failures").status).toBe(
      "failed",
    );
    expect(sockets).toHaveLength(5);
  });

  it("resets reconnect failures after a successful open and reconnects on later closes", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-reconnect"));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      sockets.at(-1)?.closeFromServer();
      vi.advanceTimersByTime(2_000);
    }

    const openedSocket = sockets.at(-1)!;
    openedSocket.open();
    openedSocket.closeFromServer();

    expect(client.getRealtimeChannelState("site-reconnect").status).toBe(
      "disconnected",
    );
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(6);
    expect(client.getRealtimeChannelState("site-reconnect").status).toBe(
      "connecting",
    );
  });

  it("sets disconnected on socket errors and lets close schedule a reconnect", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    releases.push(client.acquireRealtimeChannel("site-error"));
    const socket = sockets[0]!;
    socket.open();

    socket.error();

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(client.getRealtimeChannelState("site-error").status).toBe(
      "disconnected",
    );
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
  });

  it("clears reconnect timers on release before they create another socket", async () => {
    const client = await importClientWithEnv();
    vi.stubGlobal("WebSocket", FakeSocket);
    const release = client.acquireRealtimeChannel("site-release-timer");
    releases.push(release);
    sockets[0]?.closeFromServer();

    release();
    releases.pop();
    vi.advanceTimersByTime(2_000);

    expect(sockets).toHaveLength(1);
    expect(client.getRealtimeChannelState("site-release-timer").status).toBe(
      "disconnected",
    );
  });

  it("uses the mock realtime socket when mock mode is enabled", async () => {
    createMockRealtimeSocketMock.mockImplementation(
      ({ siteId }: { siteId: string }) => new FakeSocket(`mock://${siteId}`),
    );
    const client = await importClientWithEnv({
      VITE_DEMO_MODE: "1",
    });

    releases.push(client.acquireRealtimeChannel("site-mock"));
    expect(createMockRealtimeSocketMock).not.toHaveBeenCalled();

    await flushMicrotasks();

    expect(createMockRealtimeSocketMock).toHaveBeenCalledWith({
      siteId: "site-mock",
      activeWindowMs: 5 * 60 * 1000,
    });
    expect(sockets[0]?.url).toBe("mock://site-mock");
    sockets[0]?.open();
    expect(client.getRealtimeChannelState("site-mock").status).toBe(
      "connected",
    );
  });

  it("abandons async mock socket creation if the channel is released first", async () => {
    createMockRealtimeSocketMock.mockImplementation(
      ({ siteId }: { siteId: string }) => new FakeSocket(`mock://${siteId}`),
    );
    const client = await importClientWithEnv({
      VITE_DEMO_MODE: "1",
    });

    const release = client.acquireRealtimeChannel("site-release-before-mock");
    release();
    await flushMicrotasks();
    vi.advanceTimersByTime(30_000);

    expect(createMockRealtimeSocketMock).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(
      client.getRealtimeChannelState("site-release-before-mock").status,
    ).toBe("disconnected");
  });
});
