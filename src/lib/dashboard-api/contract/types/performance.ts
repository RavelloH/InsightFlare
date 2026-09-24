export type PerformanceMetricKey = "ttfb" | "fcp" | "lcp" | "cls" | "inp";

export interface VisitPerformanceMetrics {
  ttfb: number | null;
  fcp: number | null;
  lcp: number | null;
  cls: number | null;
  inp: number | null;
}

export interface JourneyPerformanceMetricSummary {
  avg: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
  samples: number;
}

export type JourneyPerformanceSummary = Record<
  PerformanceMetricKey,
  JourneyPerformanceMetricSummary
>;

export interface PerformanceSummary {
  avg: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  samples: number;
}

export interface PerformanceTrendPoint {
  bucket: number;
  timestampMs: number;
  avg: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  samples: number;
}

export interface PerformanceRouteMetricSummary {
  avg: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
  samples: number;
}

export interface PerformanceRouteSummary {
  pathname: string;
  views: number;
  metrics: Record<PerformanceMetricKey, PerformanceRouteMetricSummary>;
}

export interface PerformanceCountrySummary {
  country: string;
  views: number;
  metrics: Record<PerformanceMetricKey, PerformanceRouteMetricSummary>;
}

export interface PerformanceData {
  ok: boolean;
  interval: "minute" | "hour" | "day" | "week" | "month";
  summaries: Record<PerformanceMetricKey, PerformanceSummary>;
  trends: Record<PerformanceMetricKey, PerformanceTrendPoint[]>;
  routes: PerformanceRouteSummary[];
  countries: PerformanceCountrySummary[];
}
