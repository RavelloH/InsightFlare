import { fnv1a, mulberry32 } from "@/lib/demo/generators/utils";
import {
  aggregateDimensionRowsFromVisits,
  applyDemoFilters,
  buildDemoFactDataset,
} from "@/lib/demo/realtime/fact-builder";
import {
  parseDemoFilters,
  parseDemoInterval,
  parseDemoLimit,
  parseDemoNumber,
} from "@/lib/demo/realtime/filters";
import {
  buildDemoTimeBuckets,
  findDemoTimeBucketIndex,
  parseDemoTimeZone,
} from "@/lib/demo/realtime/shared";
import type { DemoVisitFact } from "@/lib/demo/realtime/types";
type DemoPerformanceMetricKey = "ttfb" | "fcp" | "lcp" | "cls" | "inp";
const DEMO_PERFORMANCE_METRICS: DemoPerformanceMetricKey[] = [
  "ttfb",
  "fcp",
  "lcp",
  "cls",
  "inp",
];
function roundDemoPerformanceValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}
function demoPerformanceMetricValue(
  siteId: string,
  visit: DemoVisitFact,
  metric: DemoPerformanceMetricKey,
): number {
  const rng = mulberry32(fnv1a(`${siteId}:${visit.visitId}:${metric}`));
  const mobileFactor =
    visit.deviceType === "Mobile"
      ? 1.18
      : visit.deviceType === "Tablet"
        ? 1.09
        : 1;
  const articleFactor =
    visit.pathname.includes("/blog") ||
    visit.pathname.includes("/news") ||
    visit.pathname.includes("/posts")
      ? 1.08
      : 1;
  const browserFactor = visit.browser.includes("Safari")
    ? 1.04
    : visit.browser.includes("Firefox")
      ? 1.02
      : 1;

  if (metric === "cls") {
    const value =
      (0.025 + rng() * 0.12) * Math.min(1.35, mobileFactor * articleFactor);
    return roundDemoPerformanceValue(Math.min(0.35, value));
  }

  const base = {
    ttfb: 155,
    fcp: 920,
    lcp: 1560,
    inp: 145,
  } satisfies Record<Exclude<DemoPerformanceMetricKey, "cls">, number>;
  const durationFactor = 1 + Math.min(visit.durationMs, 180_000) / 600_000;
  const variability = 0.78 + rng() * 0.68;
  return roundDemoPerformanceValue(
    base[metric] *
      mobileFactor *
      articleFactor *
      browserFactor *
      durationFactor *
      variability,
  );
}
type DemoPerformanceHealthBand = "great" | "needs" | "poor";
const DEMO_PERFORMANCE_BAND_VALUES: Record<
  DemoPerformanceMetricKey,
  Record<DemoPerformanceHealthBand, number>
> = {
  ttfb: { great: 380, needs: 1050, poor: 2250 },
  fcp: { great: 920, needs: 2200, poor: 3650 },
  lcp: { great: 1650, needs: 3000, poor: 5200 },
  cls: { great: 0.045, needs: 0.14, poor: 0.34 },
  inp: { great: 95, needs: 280, poor: 650 },
};
function demoPerformanceBandForIndex(index: number): DemoPerformanceHealthBand {
  const bucket = Math.abs(index) % 3;
  if (bucket === 0) return "great";
  if (bucket === 1) return "needs";
  return "poor";
}
function demoPerformanceBandValue(
  siteId: string,
  visit: DemoVisitFact,
  metric: DemoPerformanceMetricKey,
  index: number,
): number {
  const band = demoPerformanceBandForIndex(index);
  const target = DEMO_PERFORMANCE_BAND_VALUES[metric][band];
  const rng = mulberry32(
    fnv1a(`${siteId}:${visit.visitId}:${metric}:${band}:${index}`),
  );
  const jitter = 0.86 + rng() * 0.28;
  return roundDemoPerformanceValue(target * jitter);
}
function demoPercentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const rank = Math.max(0, Math.ceil(values.length * ratio) - 1);
  return roundDemoPerformanceValue(
    values[Math.min(rank, values.length - 1)] ?? 0,
  );
}
export function summarizeDemoJourneyPerformance(
  siteId: string,
  visits: DemoVisitFact[],
): Record<
  DemoPerformanceMetricKey,
  {
    avg: number | null;
    p75: number | null;
    min: number | null;
    max: number | null;
    samples: number;
  }
> {
  return Object.fromEntries(
    DEMO_PERFORMANCE_METRICS.map((metric) => {
      const values = visits
        .map((visit) => demoPerformanceMetricValue(siteId, visit, metric))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .sort((left, right) => left - right);
      const avg =
        values.length > 0
          ? roundDemoPerformanceValue(
              values.reduce((sum, value) => sum + value, 0) / values.length,
            )
          : null;
      return [
        metric,
        {
          avg,
          p75: demoPercentile(values, 0.75),
          min:
            values.length > 0
              ? roundDemoPerformanceValue(values[0] ?? 0)
              : null,
          max:
            values.length > 0
              ? roundDemoPerformanceValue(values[values.length - 1] ?? 0)
              : null,
          samples: values.length,
        },
      ];
    }),
  ) as Record<
    DemoPerformanceMetricKey,
    {
      avg: number | null;
      p75: number | null;
      min: number | null;
      max: number | null;
      samples: number;
    }
  >;
}
export function generateDemoPerformance(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const interval = parseDemoInterval(params.interval);
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const timeZone = parseDemoTimeZone(params);
  const buckets = buildDemoTimeBuckets(from, to, interval, timeZone);
  const metrics = ["ttfb", "fcp", "lcp", "cls", "inp"] as const;
  const summaryValues = {
    ttfb: [] as number[],
    fcp: [] as number[],
    lcp: [] as number[],
    cls: [] as number[],
    inp: [] as number[],
  };
  const bucketValues = {
    ttfb: new Map<number, number[]>(),
    fcp: new Map<number, number[]>(),
    lcp: new Map<number, number[]>(),
    cls: new Map<number, number[]>(),
    inp: new Map<number, number[]>(),
  };

  for (const visit of filtered.visits) {
    const bucket = findDemoTimeBucketIndex(buckets, visit.startedAt);
    if (bucket === null) continue;
    for (const metric of metrics) {
      const value = demoPerformanceMetricValue(siteId, visit, metric);
      summaryValues[metric].push(value);
      const bucketSeries = bucketValues[metric].get(bucket) ?? [];
      bucketSeries.push(value);
      bucketValues[metric].set(bucket, bucketSeries);
    }
  }

  const summaries = Object.fromEntries(
    metrics.map((metric) => {
      const values = [...summaryValues[metric]].sort(
        (left, right) => left - right,
      );
      const avg =
        values.length > 0
          ? roundDemoPerformanceValue(
              values.reduce((sum, value) => sum + value, 0) / values.length,
            )
          : null;
      const samples = Math.max(
        0,
        Math.round(values.length * dataset.viewWeight),
      );
      return [
        metric,
        {
          avg,
          p50: demoPercentile(values, 0.5),
          p75: demoPercentile(values, 0.75),
          p95: demoPercentile(values, 0.95),
          samples,
        },
      ];
    }),
  );

  const trends = Object.fromEntries(
    metrics.map((metric) => {
      const rows: Array<{
        bucket: number;
        timestampMs: number;
        avg: number | null;
        p50: number | null;
        p75: number | null;
        p95: number | null;
        samples: number;
      }> = [];

      for (const timeBucket of buckets) {
        const bucket = timeBucket.index;
        const values = [...(bucketValues[metric].get(bucket) ?? [])].sort(
          (left, right) => left - right,
        );
        const avg =
          values.length > 0
            ? roundDemoPerformanceValue(
                values.reduce((sum, value) => sum + value, 0) / values.length,
              )
            : null;
        rows.push({
          bucket,
          timestampMs: timeBucket.timestampMs,
          avg,
          p50: demoPercentile(values, 0.5),
          p75: demoPercentile(values, 0.75),
          p95: demoPercentile(values, 0.95),
          samples: Math.max(0, Math.round(values.length * dataset.viewWeight)),
        });
      }

      return [metric, rows];
    }),
  );

  const routeLimit = parseDemoLimit(params.limit, 18, 1, 50);
  const routeRows = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    Math.max(routeLimit, 1),
    (visit) => visit.pathname,
  );
  const routes = routeRows.map((row, routeIndex) => {
    const visitsForPath = filtered.visits.filter(
      (visit) => visit.pathname === row.label,
    );
    const routeMetrics = Object.fromEntries(
      metrics.map((metric) => {
        const values = visitsForPath
          .map((visit) =>
            demoPerformanceBandValue(siteId, visit, metric, routeIndex),
          )
          .sort((left, right) => left - right);
        const avg =
          values.length > 0
            ? roundDemoPerformanceValue(
                values.reduce((sum, value) => sum + value, 0) / values.length,
              )
            : null;
        return [
          metric,
          {
            avg,
            p50: demoPercentile(values, 0.5),
            p75: demoPercentile(values, 0.75),
            p95: demoPercentile(values, 0.95),
            samples: Math.max(
              0,
              Math.round(values.length * dataset.viewWeight),
            ),
          },
        ];
      }),
    );

    return {
      pathname: row.label,
      views: row.views,
      metrics: routeMetrics,
    };
  });

  const countryRows = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    48,
    (visit) => visit.country,
  );
  const countries = countryRows.map((row, countryIndex) => {
    const visitsForCountry = filtered.visits.filter(
      (visit) => visit.country === row.label,
    );
    const countryMetrics = Object.fromEntries(
      metrics.map((metric) => {
        const values = visitsForCountry
          .map((visit) =>
            demoPerformanceBandValue(siteId, visit, metric, countryIndex),
          )
          .sort((left, right) => left - right);
        const avg =
          values.length > 0
            ? roundDemoPerformanceValue(
                values.reduce((sum, value) => sum + value, 0) / values.length,
              )
            : null;
        return [
          metric,
          {
            avg,
            p50: demoPercentile(values, 0.5),
            p75: demoPercentile(values, 0.75),
            p95: demoPercentile(values, 0.95),
            samples: Math.max(
              0,
              Math.round(values.length * dataset.viewWeight),
            ),
          },
        ];
      }),
    );

    return {
      country: row.label,
      views: row.views,
      metrics: countryMetrics,
    };
  });

  return {
    ok: true,
    interval,
    summaries,
    trends,
    routes,
    countries,
  };
}
