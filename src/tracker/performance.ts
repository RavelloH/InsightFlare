type PerformanceMetricName = "ttfb" | "fcp" | "lcp" | "cls" | "inp";

interface PerformancePayload {
  performanceVisitId: string;
  performance: {
    ttfb: number;
    fcp: number;
    lcp: number;
    cls: number;
    inp: number;
  };
}

export function createPerformanceTracker(options: {
  enabled: boolean;
  sampleRate: number;
}) {
  let performanceVisitId = "";
  let performanceSampled = false;
  let performanceCollectionStarted = false;
  let performanceObserverCleanups: Array<() => void> = [];
  const interactionDurations = new Map<number, number>();
  const performanceMetrics: {
    ttfb: number | null;
    fcp: number | null;
    lcp: number | null;
    cls: number;
    inp: number;
  } = {
    ttfb: null,
    fcp: null,
    lcp: null,
    cls: 0,
    inp: 0,
  };

  function roundMetric(value: number): number | null {
    if (!options.enabled) return null;
    if (!Number.isFinite(value) || value < 0) return null;
    return Math.round(value * 1000) / 1000;
  }

  function shouldSamplePerformance(): boolean {
    if (!options.enabled) return false;
    return options.sampleRate > 0 && Math.random() * 100 < options.sampleRate;
  }

  function updatePerformanceMetric(
    metric: PerformanceMetricName,
    value: number,
  ): void {
    if (!options.enabled) return;
    const next = roundMetric(value);
    if (next === null) return;
    performanceMetrics[metric] = next;
  }

  function observePerformanceEntry(
    type: string,
    observerOptions: PerformanceObserverInit,
    onEntries: (entries: PerformanceEntryList) => void,
  ): void {
    if (!options.enabled) return;
    if (typeof PerformanceObserver !== "function") return;
    const supportedTypes = Array.isArray(
      PerformanceObserver.supportedEntryTypes,
    )
      ? PerformanceObserver.supportedEntryTypes
      : [];
    if (supportedTypes.length > 0 && !supportedTypes.includes(type)) return;
    try {
      const observer = new PerformanceObserver((list) => {
        onEntries(list.getEntries());
      });
      observer.observe(observerOptions);
      performanceObserverCleanups.push(() => observer.disconnect());
    } catch {
      // ignore unsupported entry types
    }
  }

  function start(visitId: string): void {
    if (!options.enabled) return;
    if (performanceCollectionStarted) return;
    performanceCollectionStarted = true;
    performanceVisitId = visitId;
    performanceSampled = shouldSamplePerformance();
    if (!performanceSampled) return;

    try {
      const navigationEntry = (performance as any).getEntriesByType(
        "navigation",
      )[0];
      if (navigationEntry) {
        updatePerformanceMetric("ttfb", navigationEntry.responseStart);
      }
    } catch {
      // ignore
    }

    observePerformanceEntry(
      "paint",
      { type: "paint", buffered: true },
      (entries) => {
        for (const entry of entries) {
          if (entry.name === "first-contentful-paint") {
            updatePerformanceMetric("fcp", entry.startTime);
          }
        }
      },
    );

    observePerformanceEntry(
      "largest-contentful-paint",
      { type: "largest-contentful-paint", buffered: true },
      (entries) => {
        const latest = entries[entries.length - 1];
        if (latest) {
          updatePerformanceMetric("lcp", latest.startTime);
        }
      },
    );

    observePerformanceEntry(
      "layout-shift",
      { type: "layout-shift", buffered: true },
      (entries) => {
        for (const entry of entries as any[]) {
          if (entry && !entry.hadRecentInput) {
            performanceMetrics.cls =
              roundMetric(
                (performanceMetrics.cls || 0) + (entry as any).value,
              ) || 0;
          }
        }
      },
    );

    observePerformanceEntry(
      "event",
      { type: "event", buffered: true, durationThreshold: 40 } as any,
      (entries) => {
        for (const entry of entries as any[]) {
          const interactionId = Number(entry.interactionId || 0);
          const duration = Number(entry.duration || 0);
          if (!Number.isFinite(duration) || duration < 0) continue;
          if (interactionId > 0) {
            const previous = interactionDurations.get(interactionId) || 0;
            const next = Math.max(previous, duration);
            interactionDurations.set(interactionId, next);
            updatePerformanceMetric(
              "inp",
              Math.max(performanceMetrics.inp || 0, next),
            );
            continue;
          }
          updatePerformanceMetric(
            "inp",
            Math.max(performanceMetrics.inp || 0, duration),
          );
        }
      },
    );
  }

  function stop(): void {
    if (!options.enabled) return;
    for (const cleanup of performanceObserverCleanups) {
      try {
        cleanup();
      } catch {
        // ignore
      }
    }
    performanceObserverCleanups = [];
    performanceCollectionStarted = false;
    performanceVisitId = "";
    performanceSampled = false;
    performanceMetrics.ttfb = null;
    performanceMetrics.fcp = null;
    performanceMetrics.lcp = null;
    performanceMetrics.cls = 0;
    performanceMetrics.inp = 0;
    interactionDurations.clear();
  }

  function buildPayload(): PerformancePayload | null {
    if (!options.enabled) return null;
    if (!performanceSampled || !performanceVisitId) return null;
    return {
      performanceVisitId,
      performance: {
        ttfb: performanceMetrics.ttfb ?? 0,
        fcp: performanceMetrics.fcp ?? 0,
        lcp: performanceMetrics.lcp ?? 0,
        cls: performanceMetrics.cls ?? 0,
        inp: performanceMetrics.inp ?? 0,
      },
    };
  }

  function hasVisit(): boolean {
    return Boolean(performanceVisitId);
  }

  return {
    buildPayload,
    hasVisit,
    start,
    stop,
  };
}
