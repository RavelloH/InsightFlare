import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiArrowLeftLine,
  RiCalendarEventLine,
  RiCheckboxCircleFill,
  RiCloseCircleFill,
  RiErrorWarningFill,
  RiLogoutBoxRLine,
  RiPulseLine,
  RiTimeLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  AsyncDimensionBreakdownCard,
  type AsyncDimensionBreakdownRow,
} from "@/components/dashboard/async-dimension-breakdown-card";
import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { JourneyDetailStateSwitch } from "@/components/dashboard/journey-detail-state";
import {
  BrowserMeta,
  DeviceMeta,
  formatDuration,
  formatPathWithHash,
  formatRelativeTime,
  formatScreen,
  formatShortDateTime,
  OsMeta,
  ReferrerMeta,
  VisitorAvatar,
} from "@/components/dashboard/journey-display";
import {
  JourneyGeoLocationCard,
  type JourneyGeoLocationInput,
} from "@/components/dashboard/journey-geo-location-card";
import { LazyGeoCityBreadcrumbLabel } from "@/components/dashboard/lazy-geo-location-label";
import {
  type SessionSortKey,
  type SessionSortState,
  SessionsTableCard,
} from "@/components/dashboard/sessions-table-card";
import {
  useDetailDrawerClose,
  useDetailDrawerReady,
} from "@/components/dashboard/site-pages/detail-drawer";
import {
  OverviewPagesSection,
  type OverviewPagesSectionCardData,
} from "@/components/dashboard/site-pages/overview-client-page";
import type {
  VisitorDetailMapTheme,
  VisitorLocationPoint,
} from "@/components/dashboard/site-pages/visitor-detail-map-stage";
import { useTheme } from "@/components/theme-provider";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchVisitorDetail,
  type OverviewTabRows,
} from "@/lib/dashboard/client-data";
import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import { zonedParts } from "@/lib/dashboard/time-zone";
import dynamic from "@/lib/dynamic";
import type {
  JourneyEvent,
  JourneyPerformanceMetricSummary,
  JourneyPerformanceSummary,
  JourneySession,
  PerformanceMetricKey,
  VisitorActivityDay,
  VisitorDetailData,
} from "@/lib/edge-client";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import Link from "@/lib/router";
import { cn } from "@/lib/utils";

interface VisitorDetailClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
  visitorId: string;
  onOpenSession?: (sessionId: string) => void;
}

type VisitorDetail = NonNullable<VisitorDetailData["data"]>;
type VisitorRow = VisitorDetail["visitor"];
type Labels = AppMessages["visitorDetail"];
type VisitorPerformancePanelKey = PerformanceMetricKey | "score";
type VisitorPerformanceStatus = "great" | "needs-improvement" | "poor" | "none";

function createVisitorDetailPlaceholder(visitorId: string): VisitorDetail {
  return {
    visitor: {
      visitorId,
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

const VISITOR_DETAIL_OVERVIEW_FILTERS = EMPTY_DASHBOARD_FILTER_DOCUMENT;
const VISITOR_OVERVIEW_PAGE_CARD_TABS = ["path", "title"] as const;
const VISITOR_ACTIVITY_DAYS = 365;
const VISITOR_SESSION_SORT: SessionSortState = {
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

const VisitorDetailMapStage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/visitor-detail-map-stage").then(
      (module) => module.VisitorDetailMapStage,
    ),
  {
    ssr: false,
    loading: () => <DetailMapPlaceholder />,
  },
);

interface VisitorActivityDayItem {
  date: Date;
  key: string;
  count: number;
  title: string;
}

type VisitorActivityCalendarCell =
  | { type: "empty"; key: string }
  | VisitorActivityCalendarDayCell;

interface VisitorActivityCalendarDayCell extends VisitorActivityDayItem {
  type: "day";
}

interface VisitorActivityCalendarSection {
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

function visitorLocationPoints(
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

function visitorGeoLocationInputs(
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

function formatSeenDateTime(
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

function EmptyState({ children }: { children: ReactNode }) {
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

function VisitorPerformancePanel({
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
}

function SummaryGridItem({
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
      <AutoResizer className="mt-2 min-w-0" duration={0.2}>
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
      </AutoResizer>
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

function eventDisplayTitle(labels: Labels, event: JourneyEvent): string {
  const prefix = eventKindLabel(labels, event);
  const title = eventTitle(labels, event);
  if (!title || title === prefix) return prefix;
  return `${prefix}${labels.eventTitleSeparator}${title}`;
}

function eventChronologyRank(event: JourneyEvent): number {
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

function eventSubtitle(
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

function visitorDisplayEvents(detail: VisitorDetail): JourneyEvent[] {
  const leaveEvents = detail.sessions
    .map((session) => visitorSessionLeaveEvent(session, detail.events))
    .filter((event): event is JourneyEvent => event !== null);

  return [...detail.events, ...leaveEvents];
}

function EventIcon({ event }: { event: JourneyEvent }) {
  const isCustom = event.kind === "custom";
  const isSessionStart = event.kind === "session_start";
  const isLeave = event.kind === "leave";
  return (
    <span
      className={cn(
        "inline-flex size-[34px] shrink-0 self-center items-center justify-center rounded-none",
        isSessionStart && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        event.kind === "pageview" &&
          "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        isLeave && "bg-rose-500/15 text-rose-600 dark:text-rose-400",
        isCustom && "bg-sky-500/15 text-sky-600 dark:text-sky-400",
      )}
    >
      {isSessionStart ? (
        <RiTimeLine className="size-4" />
      ) : isLeave ? (
        <RiLogoutBoxRLine className="size-4" />
      ) : isCustom ? (
        <RiPulseLine className="size-4" />
      ) : (
        <RiCalendarEventLine className="size-4" />
      )}
    </span>
  );
}

function VisitorGeoBreadcrumb({
  locale,
  messages,
  visitor,
}: {
  locale: Locale;
  messages: AppMessages;
  visitor: VisitorRow;
}) {
  const country = resolveCountryLabel(
    visitor.country ?? "",
    locale,
    messages.common.unknown,
  );
  const flagCode = resolveCountryFlagCode(country.code, locale);
  const regionLabel =
    (visitor.region ?? "").trim() ||
    (visitor.regionCode ?? "").trim() ||
    messages.common.unknown;
  const cityLabel = (visitor.city ?? "").trim() || messages.common.unknown;
  const hasRegion = Boolean(
    (visitor.region ?? "").trim() || (visitor.regionCode ?? "").trim(),
  );
  const hasCity = Boolean((visitor.city ?? "").trim());

  return (
    <LazyGeoCityBreadcrumbLabel
      locale={locale}
      countryLabel={country.label}
      countryIconName={flagCode ? `flagpack:${flagCode.toLowerCase()}` : null}
      regionLabel={regionLabel}
      cityLabel={cityLabel}
      countryCode={country.code ?? visitor.country ?? ""}
      stateCode={visitor.regionCode || visitor.region || ""}
      cityNameDefault={visitor.city ?? ""}
      hideRegion={!hasRegion}
      hideCity={!hasCity}
    />
  );
}

function DetailMapPlaceholder() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-muted/40">
      <div className="absolute inset-0 bg-[linear-gradient(90deg,var(--muted)_1px,transparent_1px),linear-gradient(0deg,var(--muted)_1px,transparent_1px)] bg-[size:64px_64px] opacity-40" />
      <div className="absolute inset-0 bg-gradient-to-b from-background/10 via-transparent to-background/80" />
      <div className="absolute inset-x-0 top-1/2 h-px bg-border/40" />
      <div className="absolute left-1/2 inset-y-0 w-px bg-border/30" />
    </div>
  );
}

function VisitorMapHero({
  locale,
  labels,
  visitor,
  metrics,
  sessions,
  backHref,
  onBack,
  loading = false,
}: {
  locale: Locale;
  labels: Labels;
  visitor: VisitorRow;
  metrics: VisitorDetail["metrics"];
  sessions: JourneySession[];
  backHref: string;
  onBack?: () => void;
  loading?: boolean;
}) {
  const modalReady = useDetailDrawerReady();
  const { resolvedTheme } = useTheme();
  const effectiveTheme: VisitorDetailMapTheme =
    resolvedTheme === "dark" ? "dark" : "light";
  const points = useMemo(
    () => (modalReady ? visitorLocationPoints(sessions) : []),
    [modalReady, sessions],
  );

  return (
    <div className="relative h-[17rem] overflow-hidden sm:h-[19rem]">
      {modalReady && !loading ? (
        <VisitorDetailMapStage theme={effectiveTheme} points={points} />
      ) : (
        <DetailMapPlaceholder />
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-36 bg-gradient-to-t from-background via-background/70 to-transparent" />

      <div className="absolute inset-x-4 top-4 z-10 flex items-center justify-between gap-4 sm:inset-x-5 sm:top-5">
        {onBack ? (
          <Clickable
            className="inline-flex items-center gap-1 text-xs text-foreground/80 hover:text-foreground"
            enableHoverScale={false}
            tapScale={0.98}
            aria-label={labels.back}
            title={labels.back}
            onClick={onBack}
          >
            <RiArrowLeftLine className="size-3.5" />
            {labels.back}
          </Clickable>
        ) : (
          <Link
            href={backHref}
            className="inline-flex items-center gap-1 text-xs text-foreground/80 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/60"
            aria-label={labels.back}
            title={labels.back}
          >
            <RiArrowLeftLine className="size-3.5" />
            {labels.back}
          </Link>
        )}
        <div className="min-w-0 truncate text-right font-mono text-[11px] text-foreground/70">
          {labels.visitorId}: {visitor.visitorId}
        </div>
      </div>

      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : "ready"}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="absolute bottom-4 left-4 z-10 min-w-0 max-w-[calc(100%-2rem)] sm:bottom-5 sm:left-5"
      >
        {loading ? (
          <div key="loading" className="flex min-w-0 items-center gap-3">
            <Skeleton className="size-12 shrink-0 rounded-full bg-muted/80" />
            <div className="min-w-0 space-y-2">
              <Skeleton className="h-8 w-36 max-w-[64vw] bg-muted/80" />
              <Skeleton className="h-3 w-56 max-w-[72vw] bg-muted/80" />
            </div>
          </div>
        ) : (
          <div key="ready" className="flex min-w-0 items-center gap-3">
            <VisitorAvatar seed={visitor.visitorId} className="size-12" />
            <div className="min-w-0">
              <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground">
                {labels.anonymous}
              </h1>
              <p className="mt-1 truncate font-mono text-[11px] text-foreground/70">
                {labels.lastSeen}:{" "}
                {formatRelativeTime(locale, metrics.lastSeenAt, Date.now())}
              </p>
            </div>
          </div>
        )}
      </AutoTransition>
    </div>
  );
}

function VisitorMetaPanel({
  locale,
  messages,
  labels,
  detail,
  timeZone,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: VisitorDetail;
  timeZone: string;
  loading?: boolean;
}) {
  const { visitor, metrics } = detail;
  const totalDurationMs = detail.sessions.reduce(
    (sum, session) => sum + Math.max(0, Number(session.durationMs || 0)),
    0,
  );
  const avgPagesPerSession =
    metrics.sessions > 0 ? metrics.views / metrics.sessions : 0;

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="grid grid-cols-2 gap-px overflow-hidden bg-border/70 text-xs text-muted-foreground xl:grid-cols-4">
          <SummaryGridItem
            label={labels.totalDuration}
            prominent
            mono
            loading={loading}
            value={durationFormat(locale, totalDurationMs)}
          />
          <SummaryGridItem
            label={labels.views}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, metrics.views)}
          />
          <SummaryGridItem
            label={labels.events}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, metrics.totalEvents)}
          />
          <SummaryGridItem
            label={labels.uniquePages}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, detail.visitedPages.length)}
          />
          <SummaryGridItem
            label={labels.avgPagesPerSession}
            prominent
            mono
            loading={loading}
            value={avgPagesPerSession.toFixed(1)}
          />
          <SummaryGridItem
            label={labels.avgEventsPerSession}
            prominent
            mono
            loading={loading}
            value={metrics.avgEventsPerSession.toFixed(1)}
          />
          <SummaryGridItem
            label={messages.common.bounceRate}
            prominent
            mono
            loading={loading}
            value={percentFormat(locale, metrics.bounceRate)}
          />
          <SummaryGridItem
            label={labels.avgStay}
            prominent
            mono
            loading={loading}
            value={durationFormat(locale, metrics.avgDurationMs)}
          />
          <SummaryGridItem
            label={labels.referrerName}
            loading={loading}
            value={
              <ReferrerMeta
                referrerHost={visitor.referrerHost || ""}
                referrerUrl={visitor.referrerUrl}
                directLabel={messages.overview.direct}
              />
            }
          />
          <SummaryGridItem
            label={labels.referrerUrl}
            mono
            loading={loading}
            value={visitor.referrerUrl || messages.overview.direct}
          />
          <SummaryGridItem
            label={labels.location}
            className="col-span-2"
            loading={loading}
            value={
              <VisitorGeoBreadcrumb
                locale={locale}
                messages={messages}
                visitor={visitor}
              />
            }
          />
          <SummaryGridItem
            label={labels.browser}
            loading={loading}
            value={
              <BrowserMeta
                browser={visitor.browser || ""}
                version={visitor.browserVersion}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.os}
            loading={loading}
            value={
              <OsMeta
                os={visitor.os || ""}
                version={visitor.osVersion}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.device}
            loading={loading}
            value={
              <DeviceMeta
                deviceType={visitor.deviceType || ""}
                deviceLabels={messages.common.deviceLabels}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.screen}
            mono
            loading={loading}
            value={formatScreen(visitor.screenWidth, visitor.screenHeight)}
          />
          <SummaryGridItem
            label={labels.firstSeen}
            prominent
            mono
            loading={loading}
            value={formatSeenDateTime(
              locale,
              messages,
              metrics.firstSeenAt,
              timeZone,
            )}
          />
          <SummaryGridItem
            label={labels.lastSeen}
            prominent
            mono
            loading={loading}
            value={formatSeenDateTime(
              locale,
              messages,
              metrics.lastSeenAt,
              timeZone,
            )}
          />
          <SummaryGridItem
            label={labels.daysActive}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, metrics.daysActive)}
          />
          <SummaryGridItem
            label={labels.avgTimeBetweenSessions}
            prominent
            mono
            loading={loading}
            value={durationFormat(locale, metrics.avgTimeBetweenSessionsMs)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function activityDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ActivityGrid({
  activity,
  locale,
  timeZone,
  loading = false,
}: {
  activity: VisitorActivityDay[];
  locale: Locale;
  timeZone: string;
  loading?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const { desktopSection, mobileSections, weekdayLabels, mobileWeekCount } =
    useMemo(() => {
      const monthFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
        month: "short",
      });
      const dateFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
        month: "short",
        day: "numeric",
      });
      const weekdayFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
        weekday: "narrow",
      });
      const buildSection = (
        days: VisitorActivityDayItem[],
      ): VisitorActivityCalendarSection => {
        if (days.length === 0) {
          return {
            cells: [],
            monthLabels: [],
            weekCount: 0,
          };
        }

        const leadingEmptyDays = days[0]?.date.getDay() ?? 0;
        const cells: VisitorActivityCalendarCell[] = [
          ...Array.from({ length: leadingEmptyDays }, (_, index) => ({
            type: "empty" as const,
            key: `empty-${days[0]?.key ?? "section"}-${index}`,
          })),
          ...days.map((day) => ({ type: "day" as const, ...day })),
        ];
        const weekCount = Math.ceil(cells.length / 7);
        const seenMonthKeys = new Set<string>();
        const monthLabels = Array.from(
          { length: weekCount },
          (_, weekIndex) => {
            const weekCells = cells.slice(weekIndex * 7, weekIndex * 7 + 7);
            const firstMonthDay = weekCells.find((cell) => {
              if (cell.type !== "day") return false;
              const monthKey = `${cell.date.getFullYear()}-${cell.date.getMonth()}`;
              if (seenMonthKeys.has(monthKey)) return false;
              return weekIndex === 0 || cell.date.getDate() <= 7;
            });
            if (firstMonthDay?.type === "day") {
              seenMonthKeys.add(
                `${firstMonthDay.date.getFullYear()}-${firstMonthDay.date.getMonth()}`,
              );
            }
            return firstMonthDay?.type === "day"
              ? monthFormatter.format(firstMonthDay.date)
              : "";
          },
        );

        return {
          cells,
          monthLabels,
          weekCount,
        };
      };
      const byDate = new globalThis.Map(
        activity.map((item) => [item.date, item.count]),
      );
      const endParts = zonedParts(Date.now(), timeZone);
      const end = new Date(endParts.year, endParts.month - 1, endParts.day);
      const start = new Date(end);
      start.setDate(start.getDate() - (VISITOR_ACTIVITY_DAYS - 1));
      const dayItems: VisitorActivityDayItem[] = [];

      for (
        let cursor = new Date(start);
        cursor <= end;
        cursor.setDate(cursor.getDate() + 1)
      ) {
        const date = activityDateKey(cursor);
        const count = byDate.get(date) ?? 0;
        dayItems.push({
          date: new Date(cursor),
          key: date,
          count,
          title: `${dateFormatter.format(cursor)}: ${numberFormat(
            locale,
            count,
          )}`,
        });
      }

      const splitIndex = Math.ceil(dayItems.length / 2);
      const nextMobileSections = [
        buildSection(dayItems.slice(0, splitIndex)),
        buildSection(dayItems.slice(splitIndex)),
      ];
      const weekdayNames = Array.from({ length: 7 }, (_, index) => {
        const date = new Date(2024, 0, 7 + index);
        return weekdayFormatter.format(date);
      });

      return {
        desktopSection: buildSection(dayItems),
        mobileSections: nextMobileSections,
        weekdayLabels: weekdayNames,
        mobileWeekCount: Math.max(
          1,
          ...nextMobileSections.map((section) => section.weekCount),
        ),
      };
    }, [activity, locale, timeZone]);
  const max = Math.max(
    1,
    ...desktopSection.cells.map((cell) =>
      cell.type === "day" ? cell.count : 0,
    ),
  );
  const cellSizePx = useMemo(() => {
    if (containerWidth <= 0) return 8;
    const weekdayLabelWidth = 20;
    const labelGap = 8;
    const columnGap = 4;
    const available =
      containerWidth -
      weekdayLabelWidth -
      labelGap -
      Math.max(0, desktopSection.weekCount - 1) * columnGap;
    return Math.max(
      7,
      Math.min(16, available / Math.max(1, desktopSection.weekCount)),
    );
  }, [containerWidth, desktopSection.weekCount]);
  const mobileCellSizePx = useMemo(() => {
    if (containerWidth <= 0) return 10;
    const weekdayLabelWidth = 20;
    const labelGap = 8;
    const columnGap = 3;
    const available =
      containerWidth -
      weekdayLabelWidth -
      labelGap -
      Math.max(0, mobileWeekCount - 1) * columnGap;
    return Math.max(7, Math.min(14, available / Math.max(1, mobileWeekCount)));
  }, [containerWidth, mobileWeekCount]);
  const activityStyle = {
    scrollbarGutter: "stable",
    "--activity-cell-size": `${cellSizePx}px`,
    "--activity-mobile-cell-size": `${mobileCellSizePx}px`,
  } as CSSProperties;

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    const updateWidth = () => setContainerWidth(node.clientWidth);
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const renderActivityCells = (
    section: VisitorActivityCalendarSection,
    cellClassName: string,
  ) =>
    section.cells.map((cell) => {
      if (cell.type === "empty") {
        return <span key={cell.key} className={cellClassName} />;
      }
      const intensity = cell.count / max;
      return loading ? (
        <Skeleton
          key={cell.key}
          className={cn(cellClassName, "rounded-[2px] ring-1 ring-border/70")}
        />
      ) : (
        <span
          key={cell.key}
          title={cell.title}
          className={cn(
            cellClassName,
            "rounded-[2px] ring-1 ring-border/70",
            cell.count === 0 && "bg-muted",
          )}
          style={
            cell.count > 0
              ? {
                  backgroundColor: `rgba(16, 185, 129, ${
                    0.28 + intensity * 0.72
                  })`,
                }
              : undefined
          }
        />
      );
    });
  const renderActivityMonthLabels = (
    section: VisitorActivityCalendarSection,
    gridAutoColumnClassName: string,
  ) => (
    <div
      className={cn(
        "ml-7 grid grid-flow-col grid-rows-1 gap-1",
        gridAutoColumnClassName,
      )}
    >
      {section.monthLabels.map((label, index) => (
        <span
          key={`${label}-${index}`}
          className="h-4 text-[10px] leading-4 text-muted-foreground"
        >
          {label}
        </span>
      ))}
    </div>
  );

  return (
    <div
      ref={containerRef}
      className="w-full max-w-full overflow-x-auto pb-1"
      style={activityStyle}
    >
      <div className="mx-auto hidden w-max min-w-max sm:block">
        {renderActivityMonthLabels(
          desktopSection,
          "[grid-auto-columns:var(--activity-cell-size)]",
        )}
        <div className="flex gap-2">
          <div className="grid grid-rows-7 gap-1">
            {weekdayLabels.map((label, index) => (
              <span
                key={`${label}-${index}`}
                className="flex h-[var(--activity-cell-size)] w-5 items-center justify-end text-[10px] leading-none text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
          <div className="grid grid-flow-col grid-rows-7 gap-1 [grid-auto-columns:var(--activity-cell-size)]">
            {renderActivityCells(
              desktopSection,
              "size-[var(--activity-cell-size)]",
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4 sm:hidden">
        {mobileSections.map((section, sectionIndex) => (
          <div
            key={`activity-mobile-${sectionIndex}`}
            className="mx-auto w-max max-w-full"
          >
            {renderActivityMonthLabels(
              section,
              "[grid-auto-columns:var(--activity-mobile-cell-size)]",
            )}
            <div className="flex gap-2">
              <div className="grid grid-rows-7 gap-[3px]">
                {weekdayLabels.map((label, index) => (
                  <span
                    key={`${label}-${sectionIndex}-${index}`}
                    className="flex h-[var(--activity-mobile-cell-size)] w-5 items-center justify-end text-[10px] leading-none text-muted-foreground"
                  >
                    {index % 2 === 1 ? label : ""}
                  </span>
                ))}
              </div>
              <div className="grid grid-flow-col grid-rows-7 gap-[3px] [grid-auto-columns:var(--activity-mobile-cell-size)]">
                {renderActivityCells(
                  section,
                  "size-[var(--activity-mobile-cell-size)]",
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function VisitorEventCard({
  locale,
  messages,
  labels,
  event,
  deltaMs,
  siteBasePath,
  timeZone,
  onOpenSession,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  event: JourneyEvent;
  deltaMs: number | null;
  siteBasePath: string;
  timeZone: string;
  onOpenSession?: (sessionId: string) => void;
}) {
  const sessionId = event.sessionId.trim();
  const sessionHref = `${siteBasePath}/sessions?detail=${encodeURIComponent(
    sessionId,
  )}`;

  return (
    <Card size="sm" className="py-0">
      <CardContent className="p-0">
        <div className="flex items-center gap-2 px-1.5 py-1">
          <EventIcon event={event} />
          <div className="flex min-w-0 flex-1 items-stretch justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="min-w-0 truncate text-sm font-medium leading-5 text-foreground">
                {eventDisplayTitle(labels, event)}
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-[14px] text-muted-foreground">
                <span className="min-w-0 truncate leading-[14px]">
                  {eventSubtitle(
                    locale,
                    event,
                    messages.common.unknown,
                    timeZone,
                  )}
                </span>
              </div>
            </div>
            <div className="flex h-[34px] min-w-0 w-[42%] shrink-0 flex-col items-end justify-between text-right sm:w-auto sm:max-w-[24rem]">
              <p className="font-mono text-[11px] leading-[14px] text-foreground">
                {formatShortDateTime(locale, event.occurredAt, timeZone)}
              </p>
              <div className="max-w-full truncate font-mono text-[10px] leading-[13px] text-muted-foreground">
                {deltaMs !== null && deltaMs > 0 ? (
                  <span>
                    {labels.sincePrevious}: {formatDuration(locale, deltaMs)}
                  </span>
                ) : sessionId ? (
                  onOpenSession ? (
                    <button
                      type="button"
                      className="bg-transparent p-0 text-left hover:text-foreground hover:underline"
                      onClick={() => onOpenSession(sessionId)}
                    >
                      {labels.sessionId}: {event.sessionId}
                    </button>
                  ) : (
                    <Link
                      href={sessionHref}
                      data-skip-page-transition=""
                      className="hover:text-foreground hover:underline"
                    >
                      {labels.sessionId}: {event.sessionId}
                    </Link>
                  )
                ) : (
                  <span aria-hidden="true">--</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function VisitorEventSkeletonCard() {
  return (
    <Card size="sm" className="py-0">
      <CardContent className="p-0">
        <div className="flex items-center gap-2 px-1.5 py-1">
          <Skeleton className="size-[34px] shrink-0" />
          <div className="flex min-w-0 flex-1 items-stretch justify-between gap-3">
            <div className="min-w-0 flex-1">
              <Skeleton className="h-5 w-[min(26rem,80%)]" />
              <Skeleton className="h-[14px] w-[min(18rem,68%)]" />
            </div>
            <div className="flex h-[34px] min-w-0 w-[42%] shrink-0 flex-col items-end justify-between text-right sm:w-auto sm:max-w-[24rem]">
              <Skeleton className="ml-auto h-[14px] w-24" />
              <Skeleton className="ml-auto h-[13px] w-20" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function VisitDetailsCard({
  locale,
  messages,
  labels,
  events,
  siteBasePath,
  timeZone,
  onOpenSession,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  events: JourneyEvent[];
  siteBasePath: string;
  timeZone: string;
  onOpenSession?: (sessionId: string) => void;
  loading?: boolean;
}) {
  const chronologicalEvents = useMemo(
    () =>
      [...events].sort((left, right) => {
        return (
          left.occurredAt - right.occurredAt ||
          eventChronologyRank(left) - eventChronologyRank(right) ||
          left.id.localeCompare(right.id)
        );
      }),
    [events],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          <RiCalendarEventLine className="size-4" />
          {labels.visitDetailsTitle}
        </CardTitle>
        <CardDescription>{labels.visitDetailsSubtitle}</CardDescription>
      </CardHeader>
      <CardContent className="px-4">
        <AutoResizer duration={0.24}>
          <AutoTransition
            initial={false}
            transitionKey={
              loading
                ? "loading"
                : chronologicalEvents.length > 0
                  ? chronologicalEvents.map((event) => event.id).join(":")
                  : "empty"
            }
            duration={0.18}
            type="fade"
            presenceMode="wait"
          >
            {loading ? (
              <div key="loading" className="space-y-1.5" aria-busy="true">
                {Array.from({ length: 5 }, (_, index) => (
                  <VisitorEventSkeletonCard key={`event-skeleton-${index}`} />
                ))}
              </div>
            ) : chronologicalEvents.length === 0 ? (
              <EmptyState key="empty">{labels.emptyEvents}</EmptyState>
            ) : (
              <div
                key={chronologicalEvents.map((event) => event.id).join(":")}
                className="space-y-1.5"
              >
                {chronologicalEvents.map((event, index) => (
                  <VisitorEventCard
                    key={event.id}
                    locale={locale}
                    messages={messages}
                    labels={labels}
                    event={event}
                    siteBasePath={siteBasePath}
                    timeZone={timeZone}
                    onOpenSession={onOpenSession}
                    deltaMs={
                      index > 0
                        ? event.occurredAt -
                          chronologicalEvents[index - 1].occurredAt
                        : null
                    }
                  />
                ))}
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardContent>
    </Card>
  );
}

function sortVisitorSessions(
  rows: JourneySession[],
  sort: SessionSortState,
): JourneySession[] {
  const direction = sort.direction === "asc" ? 1 : -1;

  return [...rows].sort((left, right) => {
    const primary =
      sort.key === "durationMs"
        ? left.durationMs - right.durationMs
        : sort.key === "views"
          ? left.views - right.views
          : left.startedAt - right.startedAt;

    if (primary !== 0) return primary * direction;
    return (
      right.startedAt - left.startedAt ||
      left.sessionId.localeCompare(right.sessionId)
    );
  });
}

function ActivityAndSessionsSection({
  locale,
  labels,
  messages,
  detail,
  siteBasePath,
  timeZone,
  onOpenSession,
  loading = false,
}: {
  locale: Locale;
  labels: Labels;
  messages: AppMessages;
  detail: VisitorDetail;
  siteBasePath: string;
  timeZone: string;
  onOpenSession?: (sessionId: string) => void;
  loading?: boolean;
}) {
  const [sessionSort, setSessionSort] =
    useState<SessionSortState>(VISITOR_SESSION_SORT);
  const sortedSessions = useMemo(
    () => sortVisitorSessions(detail.sessions, sessionSort),
    [detail.sessions, sessionSort],
  );
  const toggleSessionSort = (key: SessionSortKey) => {
    setSessionSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : {
            key,
            direction: "desc",
          },
    );
  };
  const openSessionDetail = (sessionId: string) => {
    if (onOpenSession) {
      onOpenSession(sessionId);
      return;
    }

    window.location.assign(
      `${siteBasePath}/sessions?detail=${encodeURIComponent(sessionId)}`,
    );
  };

  return (
    <section className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiPulseLine className="size-4" />
            {labels.activity}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityGrid
            activity={detail.activity}
            locale={locale}
            timeZone={timeZone}
            loading={loading}
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-base font-semibold tracking-tight">
          {labels.sessionRecords}
        </h2>
        <SessionsTableCard
          locale={locale}
          messages={messages}
          labels={{
            title: "",
            subtitle: "",
            search: "",
            started: labels.started,
            sessionId: labels.sessionId,
            visitor: labels.visitor,
            anonymous: labels.anonymous,
            entryPage: labels.entryPath,
            exitPage: labels.exitPath,
            duration: labels.duration,
            referrer: labels.referrer,
            location: labels.location,
            os: labels.os,
            browser: labels.browser,
            device: labels.device,
            pageViews: labels.pageViews,
            customEvents: labels.customEvents,
            screenSize: messages.sessions.screenSize,
            exitTime: messages.sessions.exitTime,
            loadError: labels.loadError,
            empty: labels.emptySessions,
          }}
          rows={sortedSessions}
          onOpenSession={openSessionDetail}
          sort={sessionSort}
          onSort={toggleSessionSort}
          hasMore={false}
          loadingRows={loading}
          skeletonRows={5}
        />
      </section>
    </section>
  );
}

interface VisitorOverviewRowInput {
  label: string;
  views?: number;
  sessionId?: string;
}

function aggregateOverviewRows(
  rows: VisitorOverviewRowInput[],
  fallbackLabel: string,
): OverviewTabRows {
  const rowByLabel = new globalThis.Map<
    string,
    { label: string; views: number; sessionIds: Set<string> }
  >();

  for (const row of rows) {
    const label = row.label.trim() || fallbackLabel;
    if (!label) continue;
    const views = Math.max(1, Math.floor(Number(row.views ?? 1)));
    const existing = rowByLabel.get(label);

    if (existing) {
      existing.views += views;
      if (row.sessionId) existing.sessionIds.add(row.sessionId);
      continue;
    }

    rowByLabel.set(label, {
      label,
      views,
      sessionIds: row.sessionId ? new Set([row.sessionId]) : new Set(),
    });
  }

  return Array.from(rowByLabel.values())
    .map((row) => ({
      label: row.label,
      views: row.views,
      sessions: Math.max(1, row.sessionIds.size),
      visitors: 1,
    }))
    .sort(
      (left, right) =>
        right.views - left.views || left.label.localeCompare(right.label),
    );
}

function buildVisitorOverviewPageCardData(
  detail: VisitorDetail,
  unknownLabel: string,
): OverviewPagesSectionCardData {
  const pageviewEvents = detail.events.filter(
    (event) => event.kind === "pageview",
  );
  const pathRows =
    detail.visitedPages.length > 0
      ? aggregateOverviewRows(
          detail.visitedPages.map((page) => ({
            label: page.pathname || "/",
            views: page.views,
          })),
          "/",
        )
      : aggregateOverviewRows(
          pageviewEvents.map((event) => ({
            label: event.pathname || "/",
            sessionId: event.sessionId,
          })),
          "/",
        );

  return {
    page: {
      path: pathRows,
      query: [],
      title: aggregateOverviewRows(
        pageviewEvents.map((event) => ({
          label: event.title,
          sessionId: event.sessionId,
        })),
        unknownLabel,
      ),
      hostname: aggregateOverviewRows(
        pageviewEvents.map((event) => ({
          label: event.hostname,
          sessionId: event.sessionId,
        })),
        unknownLabel,
      ),
      entry: aggregateOverviewRows(
        detail.sessions.map((session) => ({
          label: session.entryPath || "/",
          sessionId: session.sessionId,
        })),
        "/",
      ),
      exit: aggregateOverviewRows(
        detail.sessions.map((session) => ({
          label: session.exitPath || "/",
          sessionId: session.sessionId,
        })),
        "/",
      ),
    },
    source: {
      domain: [],
      link: [],
    },
    client: {
      browser: [],
      osVersion: [],
      deviceType: [],
      language: [],
      screenSize: [],
    },
    geo: {
      country: [],
      region: [],
      city: [],
      continent: [],
      timezone: [],
      organization: [],
    },
  };
}

function resolveVisitorSiteDomain(detail: VisitorDetail): string {
  for (const event of detail.events) {
    const hostname = event.hostname.trim();
    if (hostname) return hostname;
  }
  return "";
}

function buildVisitorEventBreakdownRows(
  events: JourneyEvent[],
  labels: Labels,
): AsyncDimensionBreakdownRow[] {
  const rowByLabel = new globalThis.Map<string, AsyncDimensionBreakdownRow>();

  for (const event of events) {
    if (event.kind !== "custom") continue;
    const label = event.eventType.trim() || labels.customEvent;
    const existing = rowByLabel.get(label);

    if (existing) {
      existing.views += 1;
      continue;
    }

    rowByLabel.set(label, {
      key: label,
      label,
      views: 1,
      visitors: 1,
      mono: true,
    });
  }

  return Array.from(rowByLabel.values()).sort(
    (left, right) =>
      right.views - left.views || left.label.localeCompare(right.label),
  );
}

function VisitorDetailBottomCards({
  locale,
  messages,
  labels,
  detail,
  siteId,
  siteBasePath,
  siteDomain,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: VisitorDetail;
  siteId: string;
  siteBasePath: string;
  siteDomain: string;
  loading?: boolean;
}) {
  const pageCardData = useMemo(
    () => buildVisitorOverviewPageCardData(detail, messages.common.unknown),
    [detail, messages.common.unknown],
  );
  const eventRows = useMemo(
    () => buildVisitorEventBreakdownRows(detail.events, labels),
    [detail.events, labels],
  );
  const eventTabs = useMemo(
    () =>
      [
        {
          value: "event",
          label: labels.customEvents,
          columnLabel: labels.customEvents,
          primaryMetricLabel: labels.customEvents,
        },
      ] as const,
    [labels.customEvents],
  );
  const loadEventRows = useMemo(() => async () => eventRows, [eventRows]);

  return (
    <section className="grid items-stretch gap-6 xl:grid-cols-2">
      <div className="min-w-0 h-full [&>section]:h-full [&>section]:!grid-cols-1 [&>section>div]:h-full">
        <OverviewPagesSection
          locale={locale}
          messages={messages}
          siteId={siteId}
          siteDomain={siteDomain}
          pathname={siteBasePath}
          filters={VISITOR_DETAIL_OVERVIEW_FILTERS}
          cardDataOverride={pageCardData}
          visibleCards={["page"]}
          pageCardTabs={VISITOR_OVERVIEW_PAGE_CARD_TABS}
          pageCardShowVisitors={false}
          loading={loading}
        />
      </div>

      <div className="min-w-0 h-full">
        <AsyncDimensionBreakdownCard
          locale={locale}
          messages={messages}
          tabs={eventTabs}
          loadRows={loadEventRows}
          requestKey={`visitor-detail-events:${detail.visitor.visitorId}:${locale}`}
          className="h-full"
          showVisitors={false}
          emptyLabel={labels.emptyCustomEvents}
          loadingByTab={{ event: loading }}
        />
      </div>
    </section>
  );
}

function DetailContent({
  locale,
  messages,
  labels,
  detail,
  siteId,
  pathname,
  timeZone,
  onOpenSession,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: VisitorDetail;
  siteId: string;
  pathname: string;
  timeZone: string;
  onOpenSession?: (sessionId: string) => void;
  loading?: boolean;
}) {
  const modalClose = useDetailDrawerClose();
  const visitorListPath = pathname.replace(/\/detail$/, "");
  const siteBasePath = visitorListPath.replace(/\/visitors$/, "");
  const visitorSiteDomain = useMemo(
    () => resolveVisitorSiteDomain(detail),
    [detail],
  );
  const displayEvents = useMemo(() => visitorDisplayEvents(detail), [detail]);
  const geoLocations = useMemo(
    () => visitorGeoLocationInputs(detail),
    [detail],
  );

  return (
    <div className="pb-6">
      <VisitorMapHero
        locale={locale}
        labels={labels}
        visitor={detail.visitor}
        metrics={detail.metrics}
        sessions={detail.sessions}
        backHref={visitorListPath}
        onBack={modalClose ?? undefined}
        loading={loading}
      />

      <div className="mx-auto mt-6 w-full max-w-[1400px] space-y-6 px-4 md:px-6">
        <VisitorMetaPanel
          locale={locale}
          messages={messages}
          labels={labels}
          detail={detail}
          timeZone={timeZone}
          loading={loading}
        />

        <ActivityAndSessionsSection
          locale={locale}
          labels={labels}
          messages={messages}
          detail={detail}
          siteBasePath={siteBasePath}
          timeZone={timeZone}
          onOpenSession={onOpenSession}
          loading={loading}
        />

        <VisitDetailsCard
          locale={locale}
          messages={messages}
          labels={labels}
          events={displayEvents}
          siteBasePath={siteBasePath}
          timeZone={timeZone}
          onOpenSession={onOpenSession}
          loading={loading}
        />

        <VisitorDetailBottomCards
          locale={locale}
          messages={messages}
          labels={labels}
          detail={detail}
          siteId={siteId}
          siteBasePath={siteBasePath}
          siteDomain={visitorSiteDomain}
          loading={loading}
        />

        <JourneyGeoLocationCard
          locale={locale}
          messages={messages}
          title={labels.geoLocationTitle}
          locations={geoLocations}
          loading={loading}
        />

        <VisitorPerformancePanel
          locale={locale}
          messages={messages}
          labels={labels}
          performance={detail.performance}
          loading={loading}
        />
      </div>
    </div>
  );
}

export function VisitorDetailClientPage({
  locale,
  messages,
  siteId,
  pathname,
  visitorId,
  onOpenSession,
}: VisitorDetailClientPageProps) {
  const labels = messages.visitorDetail;
  const { timeZone, window } = useDashboardQueryControls();
  const requestKey = useMemo(
    () => [siteId, visitorId, timeZone, window.from, window.to].join(":"),
    [siteId, timeZone, visitorId, window.from, window.to],
  );

  const detailQuery = useQuery({
    queryKey: ["dashboard", "visitor-detail", requestKey],
    queryFn: ({ signal }) =>
      fetchVisitorDetail(siteId, visitorId, timeZone, window, { signal }),
    enabled: typeof window !== "undefined" && Boolean(visitorId),
  });
  const detail = detailQuery.data?.data ?? null;
  const loading = detailQuery.isPending && !detail;
  const error = detailQuery.isError;

  if (!visitorId) {
    return (
      <JourneyDetailStateSwitch stateKey="visitor-missing">
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            {labels.missing}
          </CardContent>
        </Card>
      </JourneyDetailStateSwitch>
    );
  }

  if (error && !detail) {
    return (
      <JourneyDetailStateSwitch stateKey="visitor-error">
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            {labels.loadError}
          </CardContent>
        </Card>
      </JourneyDetailStateSwitch>
    );
  }

  if (!detail && !loading) {
    return (
      <JourneyDetailStateSwitch stateKey="visitor-not-found">
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            {labels.notFound}
          </CardContent>
        </Card>
      </JourneyDetailStateSwitch>
    );
  }

  return (
    <DetailContent
      locale={locale}
      messages={messages}
      labels={labels}
      detail={detail ?? createVisitorDetailPlaceholder(visitorId)}
      siteId={siteId}
      pathname={pathname}
      timeZone={timeZone}
      onOpenSession={onOpenSession}
      loading={loading}
    />
  );
}
