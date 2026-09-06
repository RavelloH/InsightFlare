import { afterEach, describe, expect, it, vi } from "vitest";

import { createPerformanceTracker } from "../performance";

const originalPerformanceObserver = globalThis.PerformanceObserver;

interface ObserverHarness {
  callbacks: Map<string, (entries: any[]) => void>;
  disconnect: ReturnType<typeof vi.fn>;
  observe: ReturnType<typeof vi.fn>;
}

function installObserverHarness(
  supportedEntryTypes: string[] = [
    "paint",
    "largest-contentful-paint",
    "layout-shift",
    "event",
  ],
  shouldThrow = false,
): ObserverHarness {
  const callbacks = new Map<string, (entries: any[]) => void>();
  const observe = vi.fn((options: PerformanceObserverInit) => {
    callbacks.set(String(options.type), (entries) => {
      const callback = observerCallbackByType.get(String(options.type));
      callback?.({ getEntries: () => entries });
    });
  });
  const disconnect = vi.fn();
  const observerCallbackByType = new Map<
    string,
    (list: { getEntries: () => any[] }) => void
  >();

  class TestPerformanceObserver {
    static supportedEntryTypes = supportedEntryTypes;

    constructor(callback: (list: { getEntries: () => any[] }) => void) {
      if (shouldThrow) throw new Error("unsupported");
      observerCallbackByType.set(String(callbacks.size), callback);
    }

    observe(options: PerformanceObserverInit) {
      const callback = [...observerCallbackByType.values()][
        observerCallbackByType.size - 1
      ];
      if (callback) {
        observerCallbackByType.set(String(options.type), callback);
      }
      observe(options);
    }

    disconnect() {
      disconnect();
    }
  }

  (globalThis as any).PerformanceObserver = TestPerformanceObserver;
  return { callbacks, disconnect, observe };
}

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).PerformanceObserver = originalPerformanceObserver;
});

describe("createPerformanceTracker", () => {
  it("returns no payload and does not collect when disabled", () => {
    const tracker = createPerformanceTracker({
      enabled: false,
      sampleRate: 100,
    });

    tracker.start("disabled-visit");
    tracker.stop();

    expect(tracker.hasVisit()).toBe(false);
    expect(tracker.buildPayload()).toBeNull();
  });

  it("records sampled metrics, ignores invalid entries, and cleans up observers", () => {
    const harness = installObserverHarness();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { responseStart: 123.4567 },
    ] as unknown as PerformanceEntryList);

    const tracker = createPerformanceTracker({
      enabled: true,
      sampleRate: 100,
    });
    tracker.start("sampled-visit");
    tracker.start("ignored-second-start");

    harness.callbacks.get("paint")?.([
      { name: "first-paint", startTime: 10 },
      { name: "first-contentful-paint", startTime: Number.NaN },
      { name: "first-contentful-paint", startTime: 45.6789 },
    ]);
    harness.callbacks.get("largest-contentful-paint")?.([]);
    harness.callbacks.get("largest-contentful-paint")?.([
      { startTime: 80 },
      { startTime: 90.1234 },
    ]);
    harness.callbacks.get("layout-shift")?.([
      null,
      { hadRecentInput: true, value: 1 },
      { hadRecentInput: false, value: Number.NaN },
      { hadRecentInput: false, value: 0.1234 },
      { hadRecentInput: false, value: 0.1111 },
    ]);
    harness.callbacks.get("event")?.([
      { duration: -1 },
      { duration: Number.NaN },
      { interactionId: 42, duration: 40 },
      { interactionId: 42, duration: 95.4321 },
      { duration: 70 },
    ]);

    expect(tracker.hasVisit()).toBe(true);
    expect(tracker.buildPayload()).toEqual({
      performanceVisitId: "sampled-visit",
      performance: {
        ttfb: 123.457,
        fcp: 45.679,
        lcp: 90.123,
        cls: 0.234,
        inp: 95.432,
      },
    });

    tracker.stop();
    expect(harness.observe).toHaveBeenCalledTimes(4);
    expect(harness.disconnect).toHaveBeenCalledTimes(4);
    tracker.stop();
    expect(harness.disconnect).toHaveBeenCalledTimes(4);
  });

  it("handles unsupported observers and navigation failures", () => {
    const harness = installObserverHarness(["paint"], true);
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(performance, "getEntriesByType").mockImplementation(() => {
      throw new Error("navigation unavailable");
    });

    const tracker = createPerformanceTracker({
      enabled: true,
      sampleRate: 100,
    });
    tracker.start("unsupported-visit");

    expect(harness.observe).not.toHaveBeenCalled();
    expect(tracker.buildPayload()).toEqual({
      performanceVisitId: "unsupported-visit",
      performance: { ttfb: 0, fcp: 0, lcp: 0, cls: 0, inp: 0 },
    });
  });

  it("handles unavailable observers, unsampled visits, and cleanup failures", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    (globalThis as any).PerformanceObserver = undefined;

    const tracker = createPerformanceTracker({ enabled: true, sampleRate: 50 });
    tracker.start("unsampled-visit");

    expect(tracker.hasVisit()).toBe(true);
    expect(tracker.buildPayload()).toBeNull();

    const harness = installObserverHarness();
    harness.disconnect.mockImplementation(() => {
      throw new Error("disconnect failed");
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const sampledTracker = createPerformanceTracker({
      enabled: true,
      sampleRate: 100,
    });
    sampledTracker.start("cleanup-failure-visit");
    expect(() => sampledTracker.stop()).not.toThrow();
  });
});
