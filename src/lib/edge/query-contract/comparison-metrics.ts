import {
  COMPARISON_METRIC_KEYS,
  type ComparisonMetricDelta,
  type ComparisonMetricKey,
  type ComparisonMetricProjection,
  type ComparisonMetricValue,
  type ComparisonRawMetrics,
} from "./types";

export type ComparisonMetricKind = "raw" | "derived";

export interface ComparisonMetricDefinition {
  readonly key: ComparisonMetricKey;
  readonly kind: ComparisonMetricKind;
  readonly dependencies: readonly ComparisonMetricKey[];
  readonly project: (raw: ComparisonRawMetrics) => ComparisonMetricValue;
}

const raw = (
  key: Extract<ComparisonMetricKey, keyof ComparisonRawMetrics>,
): ComparisonMetricDefinition => ({
  key,
  kind: "raw",
  dependencies: [],
  project: (metrics) => metrics[key],
});

const derived = (
  key: Exclude<ComparisonMetricKey, keyof ComparisonRawMetrics>,
  dependencies: readonly ComparisonMetricKey[],
  project: ComparisonMetricDefinition["project"],
): ComparisonMetricDefinition => ({
  key,
  kind: "derived",
  dependencies,
  project,
});

export const comparisonMetricRegistry: Readonly<
  Record<ComparisonMetricKey, ComparisonMetricDefinition>
> = {
  views: raw("views"),
  sessions: raw("sessions"),
  visitors: raw("visitors"),
  bounces: raw("bounces"),
  totalDurationMs: raw("totalDurationMs"),
  durationViews: raw("durationViews"),
  avgDurationMs: derived(
    "avgDurationMs",
    ["totalDurationMs", "sessions"],
    (metrics) =>
      metrics.sessions === 0
        ? null
        : Math.round(metrics.totalDurationMs / metrics.sessions),
  ),
  bounceRate: derived("bounceRate", ["bounces", "sessions"], (metrics) =>
    metrics.sessions === 0 ? null : metrics.bounces / metrics.sessions,
  ),
  viewsPerSession: derived(
    "viewsPerSession",
    ["views", "sessions"],
    (metrics) =>
      metrics.sessions === 0 ? null : metrics.views / metrics.sessions,
  ),
  events: raw("events"),
};

export function projectComparisonMetrics(
  rawMetrics: ComparisonRawMetrics,
  metrics: readonly ComparisonMetricKey[] = COMPARISON_METRIC_KEYS,
): ComparisonMetricProjection {
  const projected: Partial<Record<ComparisonMetricKey, ComparisonMetricValue>> =
    {};
  for (const key of metrics) {
    projected[key] = comparisonMetricRegistry[key].project(rawMetrics);
  }
  return projected;
}

export function relativeComparisonDelta(
  current: ComparisonMetricValue,
  reference: ComparisonMetricValue,
): ComparisonMetricValue {
  if (current === null || reference === null) return null;
  if (reference === 0) return current === 0 ? 0 : null;
  return (current - reference) / reference;
}

export function comparisonMetricDelta(
  current: ComparisonMetricValue,
  reference: ComparisonMetricValue,
): ComparisonMetricDelta {
  return {
    absolute:
      current === null || reference === null ? null : current - reference,
    relative: relativeComparisonDelta(current, reference),
  };
}

export function compareMetricProjections(
  current: ComparisonMetricProjection,
  reference: ComparisonMetricProjection,
  metrics: readonly ComparisonMetricKey[],
) {
  const change: Partial<Record<ComparisonMetricKey, ComparisonMetricDelta>> =
    {};
  for (const key of metrics) {
    change[key] = comparisonMetricDelta(
      current[key] ?? null,
      reference[key] ?? null,
    );
  }
  return change;
}
