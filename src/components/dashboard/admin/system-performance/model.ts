import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type {
  InvocationAggregate,
  InvocationCoveredMetricName,
  InvocationErrorAggregate,
  InvocationHotspot,
  InvocationRouteAggregate,
  InvocationSample,
  InvocationWeightedMetric,
} from "@/lib/edge/admin/observability/invocation-metrics-model";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";

import type { PerformanceKind } from "./performance-url-state";

export type {
  InvocationAggregate,
  InvocationErrorAggregate,
  InvocationHotspot,
  InvocationRouteAggregate,
  InvocationSample,
  InvocationWeightedMetric,
};

export type PerformanceCopy = AppMessages["systemPerformance"];

export type PerformanceStatus =
  | "ready"
  | "no_data"
  | "insufficient_coverage"
  | "reader_not_configured"
  | "writer_not_bound"
  | "disabled"
  | "query_failed";

export interface PerformanceResponse<T> {
  view: string;
  status: PerformanceStatus;
  data: T | null;
  resultLimitsReached?: string[];
}

export interface OverviewData {
  summary: InvocationAggregate | null;
  trend: Array<InvocationAggregate & { bucket: number }>;
}
export interface RoutesData {
  routes: InvocationRouteAggregate[];
}
export interface HotspotsData {
  hotspots: Partial<Record<PerformanceKind, InvocationHotspot[]>>;
}
export interface ErrorsData {
  errors: InvocationErrorAggregate[];
}
export interface SamplesData {
  samples: InvocationSample[];
}

export function hasRows(status: PerformanceStatus | undefined): boolean {
  return status === "ready" || status === "insufficient_coverage";
}

/** Message for statuses that mean "nothing to render", or null when data is usable. */
export function statusMessage(
  copy: PerformanceCopy,
  status: PerformanceStatus | undefined,
  failed: boolean,
): string | null {
  if (failed || status === "query_failed") return copy.status.queryFailed;
  switch (status) {
    case "reader_not_configured":
      return copy.status.readerNotConfigured;
    case "writer_not_bound":
      return copy.status.writerNotBound;
    case "disabled":
      return copy.status.disabled;
    default:
      return null;
  }
}

const compactFormatters = new Map<string, Intl.NumberFormat>();
function compactFormatter(locale: Locale): Intl.NumberFormat {
  const key = intlLocale(locale);
  let formatter = compactFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(key, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    compactFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatCount(locale: Locale, value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  const rounded = Math.round(value);
  return Math.abs(rounded) >= 100_000
    ? compactFormatter(locale).format(rounded)
    : numberFormat(locale, rounded);
}

export function formatMs(locale: Locale, value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "—";
  if (value >= 3_600_000) {
    return `${new Intl.NumberFormat(intlLocale(locale), {
      maximumFractionDigits: 1,
    }).format(value / 3_600_000)} h`;
  }
  if (value >= 60_000) {
    return `${new Intl.NumberFormat(intlLocale(locale), {
      maximumFractionDigits: 1,
    }).format(value / 60_000)} min`;
  }
  if (value >= 1000) {
    return `${new Intl.NumberFormat(intlLocale(locale), {
      maximumFractionDigits: 2,
    }).format(value / 1000)} s`;
  }
  return `${new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value)} ms`;
}

export function formatRate(locale: Locale, value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: value > 0 && value < 0.01 ? 2 : 1,
  }).format(value);
}

/** Weighted metric with lower-bound marker; "unavailable" renders as an em dash. */
export function formatWeighted(
  locale: Locale,
  metric: InvocationWeightedMetric | undefined,
  unit: "count" | "ms",
): string {
  if (!metric || metric.coverage === "unavailable" || metric.value === null)
    return "—";
  const text =
    unit === "ms"
      ? formatMs(locale, metric.value)
      : formatCount(locale, metric.value);
  return metric.lowerBound ? `≥ ${text}` : text;
}

export const COST_METRICS: ReadonlyArray<{
  key: InvocationCoveredMetricName;
  unit: "count" | "ms";
  label: keyof PerformanceCopy["cost"];
}> = [
  { key: "d1RowsRead", unit: "count", label: "d1Rows" },
  { key: "d1SqlEngineMs", unit: "ms", label: "d1Engine" },
  { key: "d1ApiWallMs", unit: "ms", label: "d1Api" },
  { key: "doFetchWallMs", unit: "ms", label: "doFetch" },
  { key: "doSqlRowsRead", unit: "count", label: "doRows" },
];

export function hotspotUnit(kind: PerformanceKind): "count" | "ms" {
  return kind === "scan" ? "count" : "ms";
}

export function formatHotspotValue(
  locale: Locale,
  kind: PerformanceKind,
  value: number | null | undefined,
) {
  return hotspotUnit(kind) === "ms"
    ? formatMs(locale, value)
    : formatCount(locale, value);
}

export function triggerLabel(copy: PerformanceCopy, trigger: string) {
  return copy.triggers[trigger as keyof PerformanceCopy["triggers"]] ?? trigger;
}

export function sourceLabel(copy: PerformanceCopy, source: string) {
  return source === "do"
    ? copy.sources.do
    : source === "worker"
      ? copy.sources.worker
      : source;
}

export function resultLabel(copy: PerformanceCopy, result: string) {
  return copy.results[result as keyof PerformanceCopy["results"]] ?? result;
}

export function categoryLabel(copy: PerformanceCopy, category: string | null) {
  if (!category) return copy.emptyValue;
  return (
    copy.categories[category as keyof PerformanceCopy["categories"]] ?? category
  );
}

export function resultTone(result: string) {
  if (result === "failure") return "text-destructive";
  if (result === "client_error" || result === "canceled")
    return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

/** Strips the build metadata hash for compact display (`0.7.1+abc123` → `0.7.1`). */
export function shortVersion(version: string | null): string {
  if (!version) return "—";
  return version.split("+")[0] || version;
}

export function template(
  text: string,
  params: Record<string, string | number>,
) {
  return formatI18nTemplate(text, params);
}

export function failureCount(errors: readonly InvocationErrorAggregate[]) {
  return errors
    .filter((item) => item.resultClass === "failure")
    .reduce((total, item) => total + item.estimatedInvocations, 0);
}

export function averageMs(row: {
  invocationWallMs: number;
  estimatedInvocations: number;
}): number | null {
  return row.estimatedInvocations > 0
    ? row.invocationWallMs / row.estimatedInvocations
    : null;
}
