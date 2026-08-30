export type SystemPerformanceWindowMinutes = 15 | 60 | 360 | 1440;

export interface SystemPerformanceSummary {
  totalEvents: number;
  visits: number;
  customEvents: number;
  activeSites: number;
  eventsPerMinute: number;
  latestCreatedAt: number | null;
  dataFreshnessMs: number | null;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p75LatencyMs: number | null;
  p95LatencyMs: number | null;
  trustedLatencySamples: number;
  delayedEvents: number;
  futureSkewedEvents: number;
  anomalyRate: number;
}

export interface SystemPerformanceOpenVisits {
  total: number;
  stale: number;
  timedOut: number;
  oldestStartedAt: number | null;
  newestActivityAt: number | null;
}

export interface SystemPerformanceTrendPoint {
  bucket: number;
  timestampMs: number;
  visits: number;
  customEvents: number;
  totalEvents: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p75LatencyMs: number | null;
  p95LatencyMs: number | null;
  delayedEvents: number;
  futureSkewedEvents: number;
}

export interface SystemPerformanceTopSite {
  siteId: string;
  siteName: string;
  siteDomain: string;
  totalEvents: number;
  visits: number;
  customEvents: number;
  avgLatencyMs: number | null;
  delayedEvents: number;
  futureSkewedEvents: number;
}

export interface SystemPerformanceSlowEvent {
  kind: "visit" | "custom_event";
  siteId: string;
  siteName: string;
  siteDomain: string;
  eventAt: number;
  serverAt: number;
  latencyMs: number;
}

export interface SystemPerformanceData {
  ok: true;
  generatedAt: number;
  window: {
    from: number;
    to: number;
    minutes: SystemPerformanceWindowMinutes;
    bucketSizeMs: number;
  };
  thresholds: {
    delayedMs: number;
    futureSkewMs: number;
    trustedLatencyMaxMs: number;
    staleOpenVisitMs: number;
    timedOutOpenVisitMs: number;
  };
  summary: SystemPerformanceSummary;
  openVisits: SystemPerformanceOpenVisits;
  trend: SystemPerformanceTrendPoint[];
  topSites: SystemPerformanceTopSite[];
  slowEvents: SystemPerformanceSlowEvent[];
}

export interface DoDiagnosticOpenVisits {
  total: number;
  stale: number;
  timedOut: number;
  hardAged: number;
  futureSkewed: number;
  oldestStartedAt: number | null;
  newestActivityAt: number | null;
  futureMaxActivityAt: number | null;
}

export interface DoDiagnosticDirtyVisits {
  total: number;
  stuck: number;
  maxFlushAttempts: number;
}

export interface DoDiagnosticCustomEvents {
  total: number;
  dirty: number;
  stuck: number;
  maxFlushAttempts: number;
  oldestOccurredAt: number | null;
}

export interface DoDiagnosticPayload {
  ok: true;
  snapshotAt: number;
  thresholds: {
    staleMs: number;
    timeoutMs: number;
    hardAgedMs: number;
    stuckFlushAttempts: number;
  };
  visits: {
    total: number;
    byStatus: Record<string, number>;
    open: DoDiagnosticOpenVisits;
    dirty: DoDiagnosticDirtyVisits;
  };
  customEvents: DoDiagnosticCustomEvents;
  alarm: {
    scheduledAt: number | null;
    nextDueAt: number | null;
    nextDueKind: "flush" | "hidden_fallback" | "visit_timeout" | null;
    nextDueEntity: "visit" | "custom_event" | null;
  };
}

export interface DoDiagnosticSiteEntry {
  siteId: string;
  siteName: string;
  siteDomain: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  diagnostic?: DoDiagnosticPayload;
}

export interface DoDiagnosticAggregate {
  ok: true;
  generatedAt: number;
  totalSites: number;
  reachableSites: number;
  unreachableSites: number;
  thresholds: {
    staleMs: number;
    timeoutMs: number;
    hardAgedMs: number;
    stuckFlushAttempts: number;
  };
  totals: {
    bufferedVisits: number;
    openVisits: number;
    openStale: number;
    openTimedOut: number;
    openHardAged: number;
    openFutureSkewed: number;
    dirtyVisits: number;
    stuckDirtyVisits: number;
    bufferedCustomEvents: number;
    dirtyCustomEvents: number;
    stuckDirtyCustomEvents: number;
    activeAlarms: number;
    maxVisitFlushAttempts: number;
    maxCustomEventFlushAttempts: number;
  };
  oldestOpenStartedAt: number | null;
  futureMaxActivityAt: number | null;
  sites: DoDiagnosticSiteEntry[];
}
