import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockRealtimeSocket } from "@/lib/realtime/mock/socket";
import type { DemoFactDataset, DemoVisitFact } from "@/lib/realtime/mock/types";
import type { RealtimeEvent, RealtimeVisit } from "@/lib/realtime/types";

const { buildDemoFactDatasetMock } = vi.hoisted(() => ({
  buildDemoFactDatasetMock: vi.fn(),
}));

vi.mock("@/lib/realtime/mock/fact-builder", () => ({
  buildDemoFactDataset: buildDemoFactDatasetMock,
}));

const SITE_ID = "demo-site-001";
const BASE_TIME = Date.UTC(2026, 0, 5, 12);

type SnapshotMessage = {
  type: "snapshot";
  data: {
    activeNow: number;
    events: RealtimeEvent[];
    visits: RealtimeVisit[];
  };
};

type EventMessage = {
  type: "event";
  data: RealtimeEvent;
};

type SocketMessage = SnapshotMessage | EventMessage;

class FakeWorker {
  static instances: FakeWorker[] = [];

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  constructor() {
    FakeWorker.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWorker.instances.length = 0;
  buildDemoFactDatasetMock.mockReset();
});

describe("mock/socket", () => {
  it("loads the initial dataset through a worker before opening", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(1);
    vi.stubGlobal("window", {});
    vi.stubGlobal("Worker", FakeWorker);
    buildDemoFactDatasetMock.mockReturnValue(makeDataset([]));

    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onmessage = vi.fn();
    socket.onmessage = onmessage;

    const worker = FakeWorker.instances[0];
    expect(worker).toBeDefined();
    expect(worker?.postMessage).toHaveBeenCalledWith({
      type: "build",
      siteId: SITE_ID,
      from: expect.any(Number),
      to: expect.any(Number),
    });

    await vi.advanceTimersByTimeAsync(120);
    expect(onmessage).not.toHaveBeenCalled();

    worker?.onmessage?.({
      data: {
        type: "ready",
        dataset: makeDataset([]),
      },
    } as MessageEvent);

    expect(worker?.terminate).toHaveBeenCalledTimes(1);
    expect(messagesFrom(onmessage)).toEqual([
      expect.objectContaining({ type: "snapshot" }),
    ]);

    socket.close();
  });

  it("slides an empty future queue and stops when no new visits are available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(1);
    buildDemoFactDatasetMock.mockReturnValue(makeDataset([]));

    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onmessage = vi.fn();
    socket.onmessage = onmessage;

    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(buildDemoFactDatasetMock).toHaveBeenCalledTimes(2);
    expect(messagesFrom(onmessage)).toEqual([
      expect.objectContaining({ type: "snapshot" }),
    ]);

    socket.close();
  });

  it("prunes visitors that age out before the opening snapshot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(1);
    buildDemoFactDatasetMock.mockReturnValue(
      makeDataset([
        makeVisit({
          visitId: "soon-stale",
          visitorId: "visitor-stale",
          startedAt: BASE_TIME - 50,
        }),
      ]),
    );

    const socket = createMockRealtimeSocket({
      siteId: SITE_ID,
      activeWindowMs: 100,
    });
    const onmessage = vi.fn();
    socket.onmessage = onmessage;

    await vi.advanceTimersByTimeAsync(120);

    const snapshot = messagesFrom(onmessage).find(
      (message): message is SnapshotMessage => message.type === "snapshot",
    );
    expect(snapshot?.data.activeNow).toBe(0);
    expect(snapshot?.data.visits).toEqual([]);
    expect(snapshot?.data.events).toHaveLength(1);

    socket.close();
  });

  it("serializes profile host fallback without derived point fields", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(1);
    buildDemoFactDatasetMock.mockReturnValue(
      makeDataset([
        makeVisit({
          visitId: "invalid-coordinates",
          visitorId: "visitor-invalid",
          startedAt: BASE_TIME - 60,
          hostname: "",
          latitude: Number.NaN,
          longitude: Number.POSITIVE_INFINITY,
        }),
      ]),
    );

    const socket = createMockRealtimeSocket({
      siteId: SITE_ID,
      activeWindowMs: 10_000,
    });
    const onmessage = vi.fn();
    socket.onmessage = onmessage;

    await vi.advanceTimersByTimeAsync(120);

    const snapshot = messagesFrom(onmessage).find(
      (message): message is SnapshotMessage => message.type === "snapshot",
    );
    expect(snapshot?.data.activeNow).toBe(1);
    expect(snapshot?.data).not.toHaveProperty("points");
    expect(snapshot?.data.events[0]).toEqual(
      expect.objectContaining({
        hostname: expect.any(String),
        latitude: null,
        longitude: null,
      }),
    );
    expect(snapshot?.data.events[0]?.hostname).not.toBe("");
    expect(snapshot?.data.visits[0]).toEqual(
      expect.objectContaining({
        hostname: expect.any(String),
        latitude: null,
        longitude: null,
      }),
    );

    socket.close();
  });

  it("emits a fresh snapshot after every twelfth realtime event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(1);
    buildDemoFactDatasetMock.mockReturnValue(
      makeDataset(
        Array.from({ length: 12 }, (_, index) =>
          makeVisit({
            visitId: `future-${index}`,
            sessionId: `session-${index}`,
            visitorId: index < 2 ? "visitor-repeat" : `visitor-${index}`,
            startedAt: BASE_TIME + 10 + index,
            latitude: 35 + index,
            longitude: -120 - index,
          }),
        ),
      ),
    );

    const socket = createMockRealtimeSocket({
      siteId: SITE_ID,
      activeWindowMs: 10_000,
    });
    const onmessage = vi.fn();
    socket.onmessage = onmessage;

    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(3_000);

    const messages = messagesFrom(onmessage);
    expect(messages.filter((message) => message.type === "event")).toHaveLength(
      12,
    );
    const snapshots = messages.filter(
      (message): message is SnapshotMessage => message.type === "snapshot",
    );
    expect(snapshots).toHaveLength(2);

    const repeatVisit = snapshots[1].data.visits.find(
      (visit) => visit.visitorId === "visitor-repeat",
    );
    expect(repeatVisit?.startedAt).toBeLessThan(
      repeatVisit?.lastActivityAt ?? 0,
    );
    expect(snapshots[1].data).not.toHaveProperty("points");

    socket.close();
  });

  it("clears pending emit and disconnect timers when closed after opening", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(1);
    buildDemoFactDatasetMock.mockReturnValue(
      makeDataset([
        makeVisit({
          visitId: "future-close",
          startedAt: BASE_TIME + 10_000,
        }),
      ]),
    );

    const socket = createMockRealtimeSocket({
      siteId: SITE_ID,
      activeWindowMs: 10_000,
    });
    const onmessage = vi.fn();
    const onclose = vi.fn();
    socket.onmessage = onmessage;
    socket.onclose = onclose;

    await vi.advanceTimersByTimeAsync(120);
    expect(messagesFrom(onmessage)).toEqual([
      expect.objectContaining({ type: "snapshot" }),
    ]);

    socket.close(1001, "going away");
    await vi.advanceTimersByTimeAsync(40_000);

    expect(messagesFrom(onmessage)).toHaveLength(1);
    expect(onclose).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 1001,
        reason: "going away",
        wasClean: false,
      }),
    );
  });

  it("clears the handshake timer when closed before opening", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(1);
    buildDemoFactDatasetMock.mockReturnValue(makeDataset([]));

    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onopen = vi.fn();
    const onmessage = vi.fn();
    const onclose = vi.fn();
    socket.onopen = onopen;
    socket.onmessage = onmessage;
    socket.onclose = onclose;

    socket.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onopen).not.toHaveBeenCalled();
    expect(onmessage).not.toHaveBeenCalled();
    expect(onclose).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 1000,
        reason: "mock closed",
        wasClean: true,
      }),
    );
  });

  it("emits an error when the handshake fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.1)
      .mockReturnValue(1);
    buildDemoFactDatasetMock.mockReturnValue(makeDataset([]));

    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onopen = vi.fn();
    const onmessage = vi.fn();
    const onerror = vi.fn();
    socket.onopen = onopen;
    socket.onmessage = onmessage;
    socket.onerror = onerror;

    await vi.advanceTimersByTimeAsync(120);

    expect(onopen).not.toHaveBeenCalled();
    expect(onmessage).not.toHaveBeenCalled();
    expect(onerror).toHaveBeenCalledWith(expect.any(Event));

    socket.close();
  });

  it("emits an error when the scheduled disconnect fires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    buildDemoFactDatasetMock.mockReturnValue(makeDataset([]));

    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onerror = vi.fn();
    socket.onerror = onerror;

    await vi.advanceTimersByTimeAsync(120);
    await vi.advanceTimersByTimeAsync(18_000);

    expect(onerror).toHaveBeenCalledWith(expect.any(Event));

    socket.close();
  });

  it("reschedules safely when the emit loop finds an empty future queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValue(1);
    buildDemoFactDatasetMock.mockReturnValue(makeDataset([]));

    const socket = createMockRealtimeSocket({ siteId: SITE_ID });
    const onmessage = vi.fn();
    socket.onmessage = onmessage;

    await vi.advanceTimersByTimeAsync(120);

    const internals = socket as unknown as {
      emitNextVisit: () => void;
      futureVisits: DemoVisitFact[];
    };
    internals.futureVisits = [];
    expect(() => internals.emitNextVisit()).not.toThrow();
    expect(messagesFrom(onmessage)).toEqual([
      expect.objectContaining({ type: "snapshot" }),
    ]);

    socket.close();
  });
});

function messagesFrom(onmessage: ReturnType<typeof vi.fn>): SocketMessage[] {
  return onmessage.mock.calls.map(([event]) =>
    JSON.parse((event as MessageEvent).data as string),
  ) as SocketMessage[];
}

function makeDataset(visits: DemoVisitFact[]): DemoFactDataset {
  return {
    from: 0,
    to: 1,
    viewWeight: 1,
    visits,
    sessions: new Map(
      visits.map((visit) => [
        visit.sessionId,
        {
          sessionId: visit.sessionId,
          visitorId: visit.visitorId,
          entryPath: visit.pathname,
          exitPath: visit.pathname,
          weight: 1,
        },
      ]),
    ),
    visitors: new Map(
      visits.map((visit) => [
        visit.visitorId,
        {
          visitorId: visit.visitorId,
          weight: 1,
        },
      ]),
    ),
  };
}

function makeVisit(overrides: Partial<DemoVisitFact> = {}): DemoVisitFact {
  return {
    visitId: "visit-1",
    sessionId: "session-1",
    visitorId: "visitor-1",
    startedAt: BASE_TIME,
    pathname: "/home",
    title: "Home",
    hostname: "app.example.com",
    referrerHost: "",
    referrerUrl: "",
    browser: "Chrome",
    browserVersion: "138",
    osVersion: "Windows 11",
    deviceType: "Desktop",
    language: "en-US",
    screenSize: "1920x1080",
    country: "US",
    regionCode: "CA",
    regionName: "California",
    region: "California",
    cityName: "San Francisco",
    city: "San Francisco",
    continent: "North America",
    timezone: "America/Los_Angeles",
    organization: "Cloudflare Inc.",
    latitude: 37.7749,
    longitude: -122.4194,
    eventType: "pageview",
    durationMs: 0,
    ...overrides,
  };
}
