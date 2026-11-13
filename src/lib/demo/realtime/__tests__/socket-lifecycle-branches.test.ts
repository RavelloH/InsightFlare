import { afterEach, describe, expect, it, vi } from "vitest";

import { createMockRealtimeSocket } from "@/lib/demo/realtime/socket";
import type { DemoFactDataset, DemoVisitFact } from "@/lib/demo/realtime/types";
import type { RealtimeEvent, RealtimeVisit } from "@/lib/realtime/types";

const { buildDemoFactDatasetMock } = vi.hoisted(() => ({
  buildDemoFactDatasetMock: vi.fn(),
}));

vi.mock("@/lib/demo/realtime/fact-builder", () => ({
  buildDemoFactDataset: buildDemoFactDatasetMock,
}));

const SITE_ID = "demo-site-001";
const BASE_TIME = Date.UTC(2026, 0, 5, 12);
const READY_STATE_CLOSED = 3;

interface Snapshot {
  type: "snapshot";
  data: {
    activeNow: number;
    events: RealtimeEvent[];
    visits: RealtimeVisit[];
  };
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  static failConstruct = false;

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  constructor() {
    if (FakeWorker.failConstruct) throw new Error("worker unavailable");
    FakeWorker.instances.push(this);
  }
}

interface Internals {
  readyState: number;
  futureVisits: Array<DemoVisitFact | undefined>;
  handshakeReady: boolean;
  datasetReady: boolean;
  scheduleNextEmit: () => void;
  emitNextVisit: () => void;
  tryCompleteHandshake: () => void;
  emitSnapshot: () => void;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeWorker.instances.length = 0;
  FakeWorker.failConstruct = false;
  buildDemoFactDatasetMock.mockReset();
});

function setup(options: { worker?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  vi.spyOn(Math, "random")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0.5)
    .mockReturnValue(1);
  if (options.worker) {
    vi.stubGlobal("window", {});
    vi.stubGlobal("Worker", FakeWorker);
  }
}

function open(siteVisits: DemoVisitFact[] = []) {
  buildDemoFactDatasetMock.mockReturnValue(makeDataset(siteVisits));
  const socket = createMockRealtimeSocket({ siteId: SITE_ID });
  const onmessage = vi.fn();
  const onerror = vi.fn();
  socket.onmessage = onmessage;
  socket.onerror = onerror;
  return {
    socket,
    onmessage,
    onerror,
    internals: socket as unknown as Internals,
  };
}

function messages(onmessage: ReturnType<typeof vi.fn>) {
  return onmessage.mock.calls.map(([event]) =>
    JSON.parse((event as MessageEvent).data as string),
  ) as Array<{ type: string; data: unknown }>;
}

describe("mock realtime socket lifecycle branches", () => {
  it("names Linux distributions and skips records older than the window", async () => {
    setup();
    const { socket, onmessage } = open([
      makeVisit({
        visitId: "linux",
        visitorId: "visitor-linux",
        osVersion: "Ubuntu Linux 24.04",
        startedAt: BASE_TIME - 1_000,
      }),
      makeVisit({
        visitId: "old",
        visitorId: "visitor-old",
        startedAt: BASE_TIME - 31 * 60 * 1000,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(120);

    const snapshot = messages(onmessage).find(
      (message) => message.type === "snapshot",
    ) as Snapshot;
    expect(snapshot.data.events).toHaveLength(1);
    expect(snapshot.data.visits).toHaveLength(1);
    expect(snapshot.data.visits[0]?.visitorId).toBe("visitor-linux");
    expect(JSON.stringify(snapshot.data.visits[0])).toContain('"os":"Linux"');

    socket.close();
  });

  describe("worker loading", () => {
    it("falls back to the main thread when the worker reports an error message", async () => {
      setup({ worker: true });
      const { socket, onmessage } = open([
        makeVisit({ startedAt: BASE_TIME - 1_000 }),
      ]);
      const worker = FakeWorker.instances[0]!;

      worker.onmessage?.({ data: { type: "error" } } as MessageEvent);

      expect(buildDemoFactDatasetMock).toHaveBeenCalledTimes(1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(messages(onmessage)).toEqual([]);
      await vi.advanceTimersByTimeAsync(120);
      expect(messages(onmessage)[0]?.type).toBe("snapshot");

      socket.close();
    });

    it("falls back to the main thread when the worker errors", async () => {
      setup({ worker: true });
      const { socket, onmessage } = open([
        makeVisit({ startedAt: BASE_TIME - 1_000 }),
      ]);
      await vi.advanceTimersByTimeAsync(120);
      const worker = FakeWorker.instances[0]!;
      expect(messages(onmessage)).toEqual([]);

      worker.onerror?.();

      expect(worker.terminate).toHaveBeenCalledTimes(1);
      const snapshot = messages(onmessage)[0] as unknown as Snapshot;
      expect(snapshot.type).toBe("snapshot");
      expect(snapshot.data.events).toHaveLength(1);

      socket.close();
    });

    it("ignores worker results that arrive after close", () => {
      setup({ worker: true });
      const first = open();
      const worker = FakeWorker.instances[0]!;
      first.socket.close();
      // close() terminates the pending worker.
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      buildDemoFactDatasetMock.mockClear();
      worker.onmessage?.({
        data: { type: "ready", dataset: makeDataset([]) },
      } as MessageEvent);
      worker.onerror?.();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(buildDemoFactDatasetMock).not.toHaveBeenCalled();
      expect(first.onmessage).not.toHaveBeenCalled();
    });

    it("loads on the main thread when the worker cannot be constructed", async () => {
      setup({ worker: true });
      FakeWorker.failConstruct = true;
      const { socket, onmessage } = open([
        makeVisit({ startedAt: BASE_TIME - 1_000 }),
      ]);
      expect(buildDemoFactDatasetMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(120);

      const snapshot = messages(onmessage)[0] as unknown as Snapshot;
      expect(snapshot.type).toBe("snapshot");
      expect(snapshot.data.events).toHaveLength(1);

      socket.close();
    });
  });

  describe("guards on non-open sockets", () => {
    it("does nothing when the handshake timer fires after the state changed", async () => {
      setup();
      const { socket, onmessage, internals } = open();
      internals.readyState = READY_STATE_CLOSED;

      await vi.advanceTimersByTimeAsync(780);

      expect(messages(onmessage)).toEqual([]);
      socket.close();
    });

    it("does not complete the handshake unless still connecting", () => {
      setup();
      const { socket, onmessage, internals } = open();
      internals.handshakeReady = true;
      internals.datasetReady = true;
      internals.readyState = READY_STATE_CLOSED;

      internals.tryCompleteHandshake();

      expect(onmessage).not.toHaveBeenCalled();
      socket.close();
    });

    it("does not schedule, emit or snapshot while connecting", () => {
      setup();
      const { socket, onmessage, internals } = open([
        makeVisit({ startedAt: BASE_TIME + 5_000 }),
      ]);
      expect(internals.readyState).toBe(0);

      internals.scheduleNextEmit();
      internals.emitNextVisit();
      internals.emitSnapshot();

      expect(onmessage).not.toHaveBeenCalled();
      expect(internals.futureVisits).toHaveLength(1);
      socket.close();
    });

    it("does not stack emit timers or schedule an undefined visit", async () => {
      setup();
      const { socket, onmessage, internals } = open([
        makeVisit({ startedAt: BASE_TIME + 10_000 }),
      ]);
      await vi.advanceTimersByTimeAsync(120);
      const before = vi.getTimerCount();

      // A timer is already pending from the handshake completion.
      internals.scheduleNextEmit();
      expect(vi.getTimerCount()).toBe(before);

      // Drain the pending emit, then give the queue a hole.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        messages(onmessage).filter((m) => m.type === "event"),
      ).toHaveLength(1);
      internals.futureVisits = [undefined];
      const timers = vi.getTimerCount();
      internals.scheduleNextEmit();
      expect(vi.getTimerCount()).toBe(timers);

      socket.close();
    });

    it("ignores the scheduled disconnect if the socket is no longer open", async () => {
      setup();
      const { socket, onerror, internals } = open();
      await vi.advanceTimersByTimeAsync(120);
      expect(internals.readyState).toBe(1);
      internals.readyState = READY_STATE_CLOSED;

      await vi.advanceTimersByTimeAsync(32_001);

      expect(onerror).not.toHaveBeenCalled();
      socket.close();
    });
  });
});

function makeDataset(visits: DemoVisitFact[]): DemoFactDataset {
  return {
    from: 0,
    to: 1,
    viewWeight: 1,
    visits,
    sessions: new Map(),
    visitors: new Map(),
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
  } as DemoVisitFact;
}
