import {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningFill,
  RiPulseLine,
} from "@remixicon/react";

import {
  formatDuration,
  formatPathWithHash,
} from "@/components/dashboard/journeys/journey-display";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type {
  JourneyEvent,
  JourneyPerformanceMetricSummary,
  JourneyPerformanceSummary,
  PerformanceMetricKey,
  SessionDetailData,
} from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
export type SessionDetail = NonNullable<SessionDetailData["data"]>;
export type Labels = AppMessages["sessionDetail"];
export type SessionPerformancePanelKey = PerformanceMetricKey | "score";
export type SessionPerformanceStatus =
  "great" | "needs-improvement" | "poor" | "none";
export const EMPTY_SESSION_PERFORMANCE_METRIC: JourneyPerformanceMetricSummary =
  {
    avg: null,
    p75: null,
    min: null,
    max: null,
    samples: 0,
  };
export const EMPTY_SESSION_PERFORMANCE: JourneyPerformanceSummary = {
  ttfb: EMPTY_SESSION_PERFORMANCE_METRIC,
  fcp: EMPTY_SESSION_PERFORMANCE_METRIC,
  lcp: EMPTY_SESSION_PERFORMANCE_METRIC,
  cls: EMPTY_SESSION_PERFORMANCE_METRIC,
  inp: EMPTY_SESSION_PERFORMANCE_METRIC,
};
export function createSessionDetailPlaceholder(
  sessionId: string,
): SessionDetail {
  return {
    session: {
      sessionId,
      visitorId: "",
      userId: "",
      userName: "",
      startedAt: 0,
      endedAt: 0,
      durationMs: 0,
      active: false,
      views: 0,
      events: 0,
      bounce: false,
      entryPath: "",
      exitPath: "",
      referrerHost: "",
      referrerUrl: "",
      country: "",
      region: "",
      regionCode: "",
      city: "",
      latitude: null,
      longitude: null,
      browser: "",
      browserVersion: "",
      os: "",
      osVersion: "",
      deviceType: "",
      screenWidth: null,
      screenHeight: null,
    },
    locationPoints: [],
    events: [],
    visitedPages: [],
    eventDistribution: [],
    performance: EMPTY_SESSION_PERFORMANCE,
  };
}
export const SESSION_PERFORMANCE_METRICS: PerformanceMetricKey[] = [
  "ttfb",
  "fcp",
  "lcp",
  "cls",
  "inp",
];
export const SESSION_PERFORMANCE_THRESHOLDS: Record<
  PerformanceMetricKey,
  { good: number; poor: number }
> = {
  ttfb: { good: 800, poor: 1800 },
  fcp: { good: 1800, poor: 3000 },
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
};
export const SESSION_PERFORMANCE_STATUS_STYLE = {
  great: {
    labelClassName: "text-chart-4",
    softClassName: "bg-chart-4/10 text-chart-4",
    icon: RiCheckboxCircleFill,
  },
  "needs-improvement": {
    labelClassName: "text-[oklch(0.75_0.16_80)]",
    softClassName: "bg-[oklch(0.75_0.16_80_/_0.12)] text-[oklch(0.75_0.16_80)]",
    icon: RiErrorWarningFill,
  },
  poor: {
    labelClassName: "text-destructive",
    softClassName: "bg-destructive/10 text-destructive",
    icon: RiCloseCircleFill,
  },
  none: {
    labelClassName: "text-muted-foreground",
    softClassName: "bg-muted text-muted-foreground",
    icon: RiPulseLine,
  },
} satisfies Record<
  SessionPerformanceStatus,
  {
    labelClassName: string;
    softClassName: string;
    icon: typeof RiCheckboxCircleFill;
  }
>;
export function eventKindLabel(labels: Labels, event: JourneyEvent): string {
  if (event.kind === "session_start") return labels.sessionStarted;
  if (event.kind === "pageview") return labels.pageview;
  if (event.kind === "leave") return labels.exitPage;
  return labels.customEvent;
}
export function eventTitle(labels: Labels, event: JourneyEvent): string {
  if (event.kind === "session_start") return labels.sessionStarted;
  if (event.kind === "pageview" || event.kind === "leave")
    return formatPathWithHash(event.pathname, event.hash);
  return event.eventType.trim() || labels.customEvent;
}
export function eventDisplayTitle(labels: Labels, event: JourneyEvent): string {
  const kind = eventKindLabel(labels, event);
  const title = eventTitle(labels, event);
  if (!title || title === kind) return kind;
  return `${kind}${labels.eventTitleSeparator}${title}`;
}
export function eventChronologyRank(event: JourneyEvent): number {
  if (event.kind === "session_start") return 0;
  if (event.kind === "pageview") return 1;
  if (event.kind === "custom") return 2;
  return 3;
}
export function formatDetailedDateTime(
  locale: Locale,
  timestamp: number,
  timeZone: string,
): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "--";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}
export function pageviewSubtitle(
  locale: Locale,
  event: JourneyEvent,
  unknownLabel: string,
): string {
  const title = event.title.trim() || event.hostname.trim() || unknownLabel;
  if (!Number.isFinite(event.durationMs) || event.durationMs <= 0) {
    return title;
  }
  return `${title} · ${formatDuration(locale, event.durationMs)}`;
}
export function sessionPerformanceStatusLabel(
  messages: AppMessages,
  status: SessionPerformanceStatus,
): string {
  if (status === "great") return messages.performance.great;
  if (status === "needs-improvement")
    return messages.performance.needsImprovement;
  if (status === "poor") return messages.performance.poor;
  return messages.common.noData;
}
export function sessionScoreStatus(
  score: number | null | undefined,
): SessionPerformanceStatus {
  if (score == null || !Number.isFinite(score)) return "none";
  if (score >= 90) return "great";
  if (score >= 50) return "needs-improvement";
  return "poor";
}
export function sessionMetricStatus(
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): SessionPerformanceStatus {
  if (value == null || !Number.isFinite(value)) return "none";
  const thresholds = SESSION_PERFORMANCE_THRESHOLDS[metric];
  if (value <= thresholds.good) return "great";
  if (value <= thresholds.poor) return "needs-improvement";
  return "poor";
}
export function sessionMetricScore(
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const thresholds = SESSION_PERFORMANCE_THRESHOLDS[metric];
  if (value <= thresholds.good) {
    const ratio = thresholds.good > 0 ? value / thresholds.good : 0;
    return Math.max(90, Math.min(100, 100 - ratio * 10));
  }
  if (value <= thresholds.poor) {
    const ratio =
      (value - thresholds.good) / (thresholds.poor - thresholds.good);
    return Math.max(50, Math.min(90, 90 - ratio * 40));
  }

  const poorWindow = Math.max(
    thresholds.poor - thresholds.good,
    thresholds.poor,
    1,
  );
  const ratio = (value - thresholds.poor) / poorWindow;
  return Math.max(0, Math.min(50, 50 - ratio * 50));
}
export function averageSessionPerformanceScore(
  values: Array<number | null | undefined>,
): number | null {
  const scores = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}
export function sessionPerformanceScore(
  performance: JourneyPerformanceSummary,
): number | null {
  return averageSessionPerformanceScore(
    SESSION_PERFORMANCE_METRICS.map((metric) =>
      sessionMetricScore(metric, performance[metric]?.p75),
    ),
  );
}
export function sessionPerformanceSamples(
  performance: JourneyPerformanceSummary,
): number {
  return Math.max(
    0,
    ...SESSION_PERFORMANCE_METRICS.map(
      (metric) => performance[metric]?.samples ?? 0,
    ),
  );
}
export function hasSessionPerformanceSamples(
  performance: JourneyPerformanceSummary,
): boolean {
  return SESSION_PERFORMANCE_METRICS.some(
    (metric) => (performance[metric]?.samples ?? 0) > 0,
  );
}
export function formatSessionMetricValue(
  locale: Locale,
  messages: AppMessages,
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): string {
  if (value == null || !Number.isFinite(value)) return "--";
  if (metric === "cls") {
    const formatted = new Intl.NumberFormat(intlLocale(locale), {
      maximumFractionDigits: 3,
    }).format(value);
    return `${formatted} ${messages.performance.clsUnit}`;
  }
  if (metric === "inp") {
    return `${numberFormat(locale, Math.round(value))} ${messages.performance.msUnit}`;
  }
  const seconds = value / 1000;
  const formatted = new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 2,
    minimumFractionDigits: seconds < 10 ? 2 : 1,
  }).format(seconds);
  return `${formatted} ${messages.performance.secondsUnit}`;
}
export function sessionPerformancePanelValue(
  locale: Locale,
  messages: AppMessages,
  key: SessionPerformancePanelKey,
  value: number | null | undefined,
): string {
  if (key === "score") {
    return value == null || !Number.isFinite(value)
      ? "--"
      : numberFormat(locale, Math.round(value));
  }
  return formatSessionMetricValue(locale, messages, key, value);
}
export function formatSessionMetricRange(
  locale: Locale,
  messages: AppMessages,
  metric: PerformanceMetricKey,
  summary: JourneyPerformanceMetricSummary,
): string {
  if (
    summary.min == null ||
    summary.max == null ||
    !Number.isFinite(summary.min) ||
    !Number.isFinite(summary.max)
  ) {
    return "--";
  }
  return `${formatSessionMetricValue(
    locale,
    messages,
    metric,
    summary.min,
  )} - ${formatSessionMetricValue(locale, messages, metric, summary.max)}`;
}
export function sessionScoreRange(): string {
  return "0 - 100";
}
export function sessionMetricDetailRows(
  locale: Locale,
  messages: AppMessages,
  labels: Labels,
  metric: PerformanceMetricKey,
  summary: JourneyPerformanceMetricSummary,
): string[] {
  return [
    `${labels.range}: ${formatSessionMetricRange(
      locale,
      messages,
      metric,
      summary,
    )}`,
    `${messages.performance.samplesLabel}: ${numberFormat(
      locale,
      summary.samples,
    )}`,
  ];
}
export function sessionScoreDetailRows(
  locale: Locale,
  messages: AppMessages,
  labels: Labels,
  samples: number,
): string[] {
  return [
    `${labels.range}: ${sessionScoreRange()}`,
    `${messages.performance.samplesLabel}: ${numberFormat(locale, samples)}`,
  ];
}
export function eventSubtitle(
  locale: Locale,
  event: JourneyEvent,
  unknownLabel: string,
  timeZone: string,
): string {
  if (event.kind === "session_start") {
    return formatDetailedDateTime(locale, event.occurredAt, timeZone);
  }
  if (event.kind === "leave") {
    return formatDetailedDateTime(locale, event.occurredAt, timeZone);
  }
  if (event.kind === "pageview") {
    return pageviewSubtitle(locale, event, unknownLabel);
  }
  return event.title.trim() || event.hostname.trim() || unknownLabel;
}
