import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import type { SystemPerformanceWindowMinutes } from "@/lib/system-performance";

export function formatMetricNumber(locale: Locale, value: number): string {
  return numberFormat(locale, Math.round(value));
}

export function formatMetricRate(locale: Locale, value: number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatPercent(locale: Locale, value: number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatLatency(locale: Locale, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  const normalized = Math.max(0, value);
  if (normalized < 1000) {
    return `${formatMetricNumber(locale, normalized)} ms`;
  }
  return `${new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 2,
  }).format(normalized / 1000)} s`;
}

export function formatAge(locale: Locale, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  const seconds = Math.max(0, Math.round(value / 1000));
  if (seconds < 60) return `${formatMetricNumber(locale, seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${formatMetricNumber(locale, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (remainMinutes === 0) return `${formatMetricNumber(locale, hours)} h`;
  return `${formatMetricNumber(locale, hours)} h ${formatMetricNumber(locale, remainMinutes)} min`;
}

export function formatEventKind(messages: AppMessages, kind: string): string {
  if (kind === "custom_event") return messages.realtime.customEvent;
  return messages.realtime.viewPage;
}

export function windowLabel(
  messages: AppMessages,
  minutes: SystemPerformanceWindowMinutes,
): string {
  if (minutes === 15) return messages.systemPerformance.range15m;
  if (minutes === 60) return messages.systemPerformance.range1h;
  if (minutes === 360) return messages.systemPerformance.range6h;
  return messages.systemPerformance.range24h;
}
