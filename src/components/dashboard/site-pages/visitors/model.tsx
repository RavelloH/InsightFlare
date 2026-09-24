import { memo, type ReactNode } from "react";
import {
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningFill,
  RiPulseLine,
} from "@remixicon/react";

import {
  formatDuration,
  formatPathWithHash,
  formatRelativeTime,
} from "@/components/dashboard/journeys/journey-display";
import { type JourneyGeoLocationInput } from "@/components/dashboard/journeys/journey-geo-location-card";
import { type SessionSortState } from "@/components/dashboard/sessions/sessions-table-card";
import type { VisitorLocationPoint } from "@/components/dashboard/site-pages/visitors/visitor-detail-map-stage";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import type {
  JourneyEvent,
  JourneyPerformanceMetricSummary,
  JourneyPerformanceSummary,
  JourneySession,
  PerformanceMetricKey,
  VisitorDetailData,
} from "@/lib/dashboard-api/client/edge";
import dynamic from "@/lib/dynamic";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";
export interface VisitorDetailClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
  visitorId: string;
  onOpenSession?: (sessionId: string) => void;
}
export type VisitorDetail = NonNullable<VisitorDetailData["data"]>;
export type VisitorRow = VisitorDetail["visitor"];
export type Labels = AppMessages["visitorDetail"];
type VisitorPerformancePanelKey = PerformanceMetricKey | "score";
type VisitorPerformanceStatus = "great" | "needs-improvement" | "poor" | "none";
export function createVisitorDetailPlaceholder(
  visitorId: string,
): VisitorDetail {
  return {
    visitor: {
      visitorId,
      userId: "",
      userName: "",
      firstSeenAt: 0,
      lastSeenAt: 0,
      views: 0,
      sessions: 0,
      events: 0,
      country: "",
      region: "",
      regionCode: "",
      city: "",
      referrerHost: "",
      referrerUrl: "",
      browser: "",
      browserVersion: "",
      os: "",
      osVersion: "",
      deviceType: "",
      screenWidth: null,
      screenHeight: null,
    },
    metrics: {
      totalEvents: 0,
      sessions: 0,
      views: 0,
      avgEventsPerSession: 0,
      bounceRate: 0,
      avgDurationMs: 0,
      p90DurationMs: 0,
      firstSeenAt: 0,
      lastSeenAt: 0,
      daysActive: 0,
      conversionEvents: 0,
      avgTimeBetweenSessionsMs: 0,
    },
    sessions: [],
    events: [],
    visitedPages: [],
    eventDistribution: [],
    activity: [],
    performance: EMPTY_VISITOR_PERFORMANCE,
  };
}
export const VISITOR_DETAIL_OVERVIEW_FILTERS = EMPTY_DASHBOARD_FILTER_DOCUMENT;
export const VISITOR_OVERVIEW_PAGE_CARD_TABS = ["path", "title"] as const;
export const VISITOR_ACTIVITY_DAYS = 365;
export const VISITOR_SESSION_SORT: SessionSortState = {
  key: "startedAt",
  direction: "desc",
};
const VISITOR_PERFORMANCE_METRICS: PerformanceMetricKey[] = [
  "ttfb",
  "fcp",
  "lcp",
  "cls",
  "inp",
];
const VISITOR_PERFORMANCE_THRESHOLDS: Record<
  PerformanceMetricKey,
  { good: number; poor: number }
> = {
  ttfb: { good: 800, poor: 1800 },
  fcp: { good: 1800, poor: 3000 },
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
};
const VISITOR_PERFORMANCE_STATUS_STYLE = {
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
  VisitorPerformanceStatus,
  {
    labelClassName: string;
    softClassName: string;
    icon: typeof RiCheckboxCircleFill;
  }
>;
const EMPTY_VISITOR_PERFORMANCE_METRIC_SUMMARY: JourneyPerformanceMetricSummary =
  {
    avg: null,
    p75: null,
    min: null,
    max: null,
    samples: 0,
  };
const EMPTY_VISITOR_PERFORMANCE: JourneyPerformanceSummary = {
  ttfb: EMPTY_VISITOR_PERFORMANCE_METRIC_SUMMARY,
  fcp: EMPTY_VISITOR_PERFORMANCE_METRIC_SUMMARY,
  lcp: EMPTY_VISITOR_PERFORMANCE_METRIC_SUMMARY,
  cls: EMPTY_VISITOR_PERFORMANCE_METRIC_SUMMARY,
  inp: EMPTY_VISITOR_PERFORMANCE_METRIC_SUMMARY,
};
const EMPTY_VISIT_PERFORMANCE: JourneyEvent["performance"] = {
  ttfb: null,
  fcp: null,
  lcp: null,
  cls: null,
  inp: null,
};
export const VisitorDetailMapStage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/visitors/visitor-detail-map-stage").then(
      (module) => module.VisitorDetailMapStage,
    ),
  {
    ssr: false,
    loading: () => <DetailMapPlaceholder />,
  },
);
export function DetailMapPlaceholder() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-muted/40">
      <div className="absolute inset-0 bg-[linear-gradient(90deg,var(--muted)_1px,transparent_1px),linear-gradient(0deg,var(--muted)_1px,transparent_1px)] bg-[size:64px_64px] opacity-40" />
      <div className="absolute inset-0 bg-gradient-to-b from-background/10 via-transparent to-background/80" />
      <div className="absolute inset-x-0 top-1/2 h-px bg-border/40" />
      <div className="absolute left-1/2 inset-y-0 w-px bg-border/30" />
    </div>
  );
}
export interface VisitorActivityDayItem {
  date: Date;
  key: string;
  count: number;
  title: string;
}
export type VisitorActivityCalendarCell =
  { type: "empty"; key: string } | VisitorActivityCalendarDayCell;
interface VisitorActivityCalendarDayCell extends VisitorActivityDayItem {
  type: "day";
}
export interface VisitorActivityCalendarSection {
  cells: VisitorActivityCalendarCell[];
  monthLabels: string[];
  weekCount: number;
}
function hasValidCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return false;
  }
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}
export function visitorLocationPoints(
  sessions: JourneySession[],
): VisitorLocationPoint[] {
  return sessions.flatMap((session) =>
    hasValidCoordinate(session.latitude, session.longitude) &&
    typeof session.latitude === "number" &&
    typeof session.longitude === "number"
      ? [
          {
            latitude: session.latitude,
            longitude: session.longitude,
            timestampMs: session.startedAt,
          },
        ]
      : [],
  );
}
export function visitorGeoLocationInputs(
  detail: VisitorDetail,
): JourneyGeoLocationInput[] {
  return detail.sessions.map((session) => ({
    country: session.country,
    region: session.region,
    regionCode: session.regionCode,
    city: session.city,
    latitude: session.latitude,
    longitude: session.longitude,
  }));
}
function formatDetailedDateTime(
  locale: Locale,
  timestampMs: number,
  timeZone: string,
): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "--";
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestampMs));
}
export function formatSeenDateTime(
  locale: Locale,
  messages: AppMessages,
  timestampMs: number,
  timeZone: string,
  now = Date.now(),
): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "--";
  const absolute = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestampMs));
  const relative = formatRelativeTime(locale, timestampMs, now);
  return formatI18nTemplate(messages.common.timeRelativePair, {
    absolute,
    relative,
  });
}
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
function VisitorPerformanceCell({
  label,
  value,
  status,
  details,
  loading = false,
}: {
  label: string;
  value: string;
  status: VisitorPerformanceStatus;
  details: string[];
  loading?: boolean;
}) {
  const statusStyle = VISITOR_PERFORMANCE_STATUS_STYLE[status];
  const StatusIcon = statusStyle.icon;

  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <p className="min-w-0 truncate text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </p>
        <AutoTransition
          initial={false}
          transitionKey={loading ? "loading" : "ready"}
          duration={0.18}
          type="fade"
          presenceMode="wait"
          className="size-7 shrink-0"
        >
          {loading ? (
            <Skeleton key="loading" className="size-7 rounded-full" />
          ) : (
            <span
              key="ready"
              className={cn(
                "inline-flex size-7 items-center justify-center rounded-full",
                statusStyle.softClassName,
              )}
            >
              <StatusIcon className="size-3.5" />
            </span>
          )}
        </AutoTransition>
      </div>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : "ready"}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="mt-3 min-h-7"
      >
        {loading ? (
          <Skeleton key="loading" className="h-7 w-20" />
        ) : (
          <p
            key="ready"
            className="min-w-0 truncate font-mono text-xl font-semibold leading-7 text-foreground"
          >
            {value}
          </p>
        )}
      </AutoTransition>
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : "ready"}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="mt-3 min-h-8"
      >
        {loading ? (
          <div key="loading" className="flex min-w-0 flex-col gap-1">
            {details.map((detail, index) => (
              <Skeleton
                key={`${detail}-${index}`}
                className={cn("h-[14px]", index === 0 ? "w-36" : "w-24")}
              />
            ))}
          </div>
        ) : (
          <div
            key="ready"
            className="flex min-w-0 flex-col gap-1 text-[11px] leading-[14px] text-muted-foreground"
          >
            {details.map((detail) => (
              <span key={detail} className="min-w-0 truncate">
                {detail}
              </span>
            ))}
          </div>
        )}
      </AutoTransition>
    </div>
  );
}
function VisitorPerformanceMetricCell({
  locale,
  messages,
  labels,
  metric,
  summary,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  metric: PerformanceMetricKey;
  summary: JourneyPerformanceMetricSummary;
  loading?: boolean;
}) {
  const value = summary.p75;
  const status = visitorMetricStatus(metric, value);

  return (
    <VisitorPerformanceCell
      label={messages.performance[metric]}
      value={formatVisitorMetricValue(locale, messages, metric, value)}
      status={status}
      details={visitorMetricDetailRows(
        locale,
        messages,
        labels,
        metric,
        summary,
      )}
      loading={loading}
    />
  );
}
export const VisitorPerformancePanel = memo(function VisitorPerformancePanel({
  locale,
  messages,
  labels,
  performance,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  performance: JourneyPerformanceSummary | null | undefined;
  loading?: boolean;
}) {
  const hasSamples = hasVisitorPerformanceSamples(performance);
  if (!hasSamples && !loading) return null;

  const score = visitorPerformanceScore(performance);
  const samples = visitorPerformanceSamples(performance);
  const scoreStatus = visitorScoreStatus(score);
  const statusStyle = VISITOR_PERFORMANCE_STATUS_STYLE[scoreStatus];
  const StatusIcon = statusStyle.icon;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="inline-flex items-center gap-2">
              <RiPulseLine className="size-4" />
              {labels.performanceTitle}
            </CardTitle>
          </div>
          <div
            className={cn(
              "inline-flex shrink-0 items-center gap-2 self-start rounded-full px-3 py-1 text-xs font-medium",
              statusStyle.softClassName,
            )}
          >
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : "ready"}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="flex h-4 items-center"
            >
              {loading ? (
                <Skeleton key="loading" className="h-4 w-24 rounded-full" />
              ) : (
                <span key="ready" className="inline-flex items-center gap-2">
                  <StatusIcon className="size-3.5" />
                  <span>
                    {visitorPerformanceStatusLabel(messages, scoreStatus)}
                  </span>
                </span>
              )}
            </AutoTransition>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-2 gap-px overflow-hidden bg-border/70 text-xs md:grid-cols-3">
          <VisitorPerformanceCell
            label={messages.performance.score}
            value={visitorPerformancePanelValue(
              locale,
              messages,
              "score",
              score,
            )}
            status={scoreStatus}
            details={visitorScoreDetailRows(locale, messages, labels, samples)}
            loading={loading}
          />
          {VISITOR_PERFORMANCE_METRICS.map((metric) => (
            <VisitorPerformanceMetricCell
              key={metric}
              locale={locale}
              messages={messages}
              labels={labels}
              metric={metric}
              summary={
                performance?.[metric] ??
                EMPTY_VISITOR_PERFORMANCE_METRIC_SUMMARY
              }
              loading={loading}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
});
export function SummaryGridItem({
  label,
  value,
  mono = false,
  prominent = false,
  loading = false,
  className,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  prominent?: boolean;
  loading?: boolean;
  className?: string;
}) {
  const valueClassName = prominent
    ? "h-7 text-xl font-semibold leading-7"
    : "h-5 text-xs leading-5";

  return (
    <div className={cn("min-w-0 bg-card p-4", className)}>
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <div className="mt-2 min-w-0">
        <AutoTransition
          initial={false}
          transitionKey={loading ? "loading" : "ready"}
          duration={0.18}
          type="fade"
          presenceMode="wait"
          className={cn("min-w-0 overflow-hidden", valueClassName)}
        >
          {loading ? (
            <Skeleton
              key="loading"
              className={cn(
                valueClassName,
                prominent ? "w-20" : "w-[min(18rem,88%)]",
              )}
            />
          ) : (
            <div
              key="ready"
              className={cn(
                "min-w-0 overflow-hidden text-foreground [overflow-wrap:anywhere]",
                mono && "font-mono",
                valueClassName,
              )}
            >
              {value}
            </div>
          )}
        </AutoTransition>
      </div>
    </div>
  );
}
function eventKindLabel(labels: Labels, event: JourneyEvent): string {
  if (event.kind === "session_start") return labels.sessionStarted;
  if (event.kind === "pageview") return labels.pageview;
  if (event.kind === "leave") return labels.exitPage;
  return labels.customEvent;
}
function eventTitle(labels: Labels, event: JourneyEvent): string {
  if (event.kind === "session_start") return labels.sessionStarted;
  if (event.kind === "leave") {
    return event.pathname.trim()
      ? formatPathWithHash(event.pathname, event.hash)
      : labels.exitPage;
  }
  if (event.kind === "pageview")
    return formatPathWithHash(event.pathname, event.hash);
  return event.eventType.trim() || labels.customEvent;
}
export function eventDisplayTitle(labels: Labels, event: JourneyEvent): string {
  const prefix = eventKindLabel(labels, event);
  const title = eventTitle(labels, event);
  if (!title || title === prefix) return prefix;
  return `${prefix}${labels.eventTitleSeparator}${title}`;
}
export function eventChronologyRank(event: JourneyEvent): number {
  if (event.kind === "session_start") return 0;
  if (event.kind === "pageview") return 1;
  if (event.kind === "custom") return 2;
  return 3;
}
function pageviewSubtitle(
  locale: Locale,
  event: JourneyEvent,
  unknownLabel: string,
): string {
  const base =
    event.title.trim() ||
    event.hostname.trim() ||
    event.pathname.trim() ||
    unknownLabel;
  if (event.durationMs > 0) {
    return `${base} · ${formatDuration(locale, event.durationMs)}`;
  }
  return base;
}
export function eventSubtitle(
  locale: Locale,
  event: JourneyEvent,
  unknownLabel: string,
  timeZone: string,
): string {
  if (event.kind === "session_start" || event.kind === "leave") {
    return formatDetailedDateTime(locale, event.occurredAt, timeZone);
  }
  if (event.kind === "pageview") {
    return pageviewSubtitle(locale, event, unknownLabel);
  }
  return event.title.trim() || event.hostname.trim() || unknownLabel;
}
function visitorPerformanceStatusLabel(
  messages: AppMessages,
  status: VisitorPerformanceStatus,
): string {
  if (status === "great") return messages.performance.great;
  if (status === "needs-improvement")
    return messages.performance.needsImprovement;
  if (status === "poor") return messages.performance.poor;
  return messages.common.noData;
}
function visitorScoreStatus(
  score: number | null | undefined,
): VisitorPerformanceStatus {
  if (score == null || !Number.isFinite(score)) return "none";
  if (score >= 90) return "great";
  if (score >= 50) return "needs-improvement";
  return "poor";
}
function visitorMetricStatus(
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): VisitorPerformanceStatus {
  if (value == null || !Number.isFinite(value)) return "none";
  const thresholds = VISITOR_PERFORMANCE_THRESHOLDS[metric];
  if (value <= thresholds.good) return "great";
  if (value <= thresholds.poor) return "needs-improvement";
  return "poor";
}
function visitorMetricScore(
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const thresholds = VISITOR_PERFORMANCE_THRESHOLDS[metric];
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
function averageVisitorPerformanceScore(
  values: Array<number | null | undefined>,
): number | null {
  const scores = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}
function visitorPerformanceScore(
  performance: JourneyPerformanceSummary | null | undefined,
): number | null {
  return averageVisitorPerformanceScore(
    VISITOR_PERFORMANCE_METRICS.map((metric) =>
      visitorMetricScore(metric, performance?.[metric]?.p75),
    ),
  );
}
function visitorPerformanceSamples(
  performance: JourneyPerformanceSummary | null | undefined,
): number {
  return Math.max(
    0,
    ...VISITOR_PERFORMANCE_METRICS.map(
      (metric) => performance?.[metric]?.samples ?? 0,
    ),
  );
}
function hasVisitorPerformanceSamples(
  performance: JourneyPerformanceSummary | null | undefined,
): boolean {
  return VISITOR_PERFORMANCE_METRICS.some(
    (metric) => (performance?.[metric]?.samples ?? 0) > 0,
  );
}
function formatVisitorMetricValue(
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
function visitorPerformancePanelValue(
  locale: Locale,
  messages: AppMessages,
  key: VisitorPerformancePanelKey,
  value: number | null | undefined,
): string {
  if (key === "score") {
    return value == null || !Number.isFinite(value)
      ? "--"
      : numberFormat(locale, Math.round(value));
  }
  return formatVisitorMetricValue(locale, messages, key, value);
}
function formatVisitorMetricRange(
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
  return `${formatVisitorMetricValue(
    locale,
    messages,
    metric,
    summary.min,
  )} - ${formatVisitorMetricValue(locale, messages, metric, summary.max)}`;
}
function visitorScoreRange(): string {
  return "0 - 100";
}
function visitorMetricDetailRows(
  locale: Locale,
  messages: AppMessages,
  labels: Labels,
  metric: PerformanceMetricKey,
  summary: JourneyPerformanceMetricSummary,
): string[] {
  return [
    `${labels.range}: ${formatVisitorMetricRange(
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
function visitorScoreDetailRows(
  locale: Locale,
  messages: AppMessages,
  labels: Labels,
  samples: number,
): string[] {
  return [
    `${labels.range}: ${visitorScoreRange()}`,
    `${messages.performance.samplesLabel}: ${numberFormat(locale, samples)}`,
  ];
}
function visitorSessionLeaveEvent(
  session: JourneySession,
  events: JourneyEvent[],
): JourneyEvent | null {
  if (session.active) return null;
  if (!Number.isFinite(session.endedAt) || session.endedAt <= 0) return null;
  if (
    Number.isFinite(session.startedAt) &&
    session.endedAt < session.startedAt
  ) {
    return null;
  }
  if (
    events.some(
      (event) =>
        event.kind === "leave" && event.sessionId === session.sessionId,
    )
  ) {
    return null;
  }

  const latestPageEvent = events.reduce<JourneyEvent | null>(
    (latest, event) =>
      event.kind === "pageview" &&
      event.sessionId === session.sessionId &&
      (!latest || event.occurredAt > latest.occurredAt)
        ? event
        : latest,
    null,
  );
  const sessionStart = events.find(
    (event) =>
      event.kind === "session_start" && event.sessionId === session.sessionId,
  );
  const pathname =
    session.exitPath.trim() ||
    latestPageEvent?.pathname.trim() ||
    session.entryPath.trim();

  if (!pathname) return null;

  const base = latestPageEvent ?? sessionStart;
  return {
    id: `visitor-session-leave:${session.sessionId}`,
    kind: "leave",
    eventType: "leave",
    occurredAt: Math.max(session.endedAt, session.startedAt),
    visitId: latestPageEvent?.visitId ?? "",
    sessionId: session.sessionId,
    visitorId: session.visitorId,
    pathname,
    hash: latestPageEvent?.hash ?? base?.hash ?? "",
    title: latestPageEvent?.title ?? base?.title ?? "",
    hostname: latestPageEvent?.hostname ?? base?.hostname ?? "",
    referrerHost:
      latestPageEvent?.referrerHost ??
      base?.referrerHost ??
      session.referrerHost,
    referrerUrl:
      latestPageEvent?.referrerUrl ?? base?.referrerUrl ?? session.referrerUrl,
    country: latestPageEvent?.country ?? base?.country ?? session.country,
    region: latestPageEvent?.region ?? base?.region ?? session.region,
    city: latestPageEvent?.city ?? base?.city ?? session.city,
    browser: latestPageEvent?.browser ?? base?.browser ?? session.browser,
    browserVersion:
      latestPageEvent?.browserVersion ??
      base?.browserVersion ??
      session.browserVersion,
    os: latestPageEvent?.os ?? base?.os ?? session.os,
    osVersion:
      latestPageEvent?.osVersion ?? base?.osVersion ?? session.osVersion,
    deviceType:
      latestPageEvent?.deviceType ?? base?.deviceType ?? session.deviceType,
    screenWidth:
      latestPageEvent?.screenWidth ?? base?.screenWidth ?? session.screenWidth,
    screenHeight:
      latestPageEvent?.screenHeight ??
      base?.screenHeight ??
      session.screenHeight,
    durationMs: 0,
    performance: EMPTY_VISIT_PERFORMANCE,
  };
}
export function visitorDisplayEvents(detail: VisitorDetail): JourneyEvent[] {
  const leaveEvents = detail.sessions
    .map((session) => visitorSessionLeaveEvent(session, detail.events))
    .filter((event): event is JourneyEvent => event !== null);

  return [...detail.events, ...leaveEvents];
}
export interface VisitorOverviewRowInput {
  label: string;
  views?: number;
  sessionId?: string;
}
