import {
  memo,
  type ReactNode,
  useCallback,
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
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import {
  AsyncDimensionBreakdownCard,
  type AsyncDimensionBreakdownLoader,
  type AsyncDimensionBreakdownRow,
} from "@/components/dashboard/async-dimension-breakdown-card";
import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { JourneyDetailStateSwitch } from "@/components/dashboard/journey-detail-state";
import {
  BrowserMeta,
  DeviceMeta,
  formatDuration,
  formatPath,
  formatPathWithHash,
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
  useDetailDrawerClose,
  useDetailDrawerReady,
} from "@/components/dashboard/site-pages/detail-drawer";
import { EventDetailDrawer } from "@/components/dashboard/site-pages/event-detail-drawer";
import { NESTED_DETAIL_DRAWER_Z_INDEX } from "@/components/dashboard/site-pages/floating-layer";
import {
  OverviewPagesSection,
  type OverviewPagesSectionCardData,
} from "@/components/dashboard/site-pages/overview-client-page";
import type {
  SessionDetailMapTheme,
  SessionLocationPoint,
} from "@/components/dashboard/site-pages/session-detail-map-stage";
import { useInfiniteTableSentinel } from "@/components/dashboard/use-infinite-table-sentinel";
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
  fetchEventRecordDetail,
  fetchJourneyEventDetail,
  fetchSessionDetail,
  fetchSessionEvents,
  type OverviewTabRows,
} from "@/lib/dashboard/client-data";
import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import { buildPageDetailHref } from "@/lib/dashboard/page-detail";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import dynamic from "@/lib/dynamic";
import type {
  JourneyEvent,
  JourneyPerformanceMetricSummary,
  JourneyPerformanceSummary,
  JourneySession,
  PerformanceMetricKey,
  SessionDetailData,
} from "@/lib/edge-client";
import {
  resolveCountryFlagCode,
  resolveCountryLabel,
} from "@/lib/i18n/code-labels";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import Link from "@/lib/router";
import { cn } from "@/lib/utils";

interface SessionDetailClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
  sessionId: string;
  onOpenVisitor?: (visitorId: string) => void;
}

type SessionDetail = NonNullable<SessionDetailData["data"]>;
type Labels = AppMessages["sessionDetail"];
type SessionPerformancePanelKey = PerformanceMetricKey | "score";
type SessionPerformanceStatus = "great" | "needs-improvement" | "poor" | "none";

const EMPTY_SESSION_PERFORMANCE_METRIC: JourneyPerformanceMetricSummary = {
  avg: null,
  p75: null,
  min: null,
  max: null,
  samples: 0,
};

const EMPTY_SESSION_PERFORMANCE: JourneyPerformanceSummary = {
  ttfb: EMPTY_SESSION_PERFORMANCE_METRIC,
  fcp: EMPTY_SESSION_PERFORMANCE_METRIC,
  lcp: EMPTY_SESSION_PERFORMANCE_METRIC,
  cls: EMPTY_SESSION_PERFORMANCE_METRIC,
  inp: EMPTY_SESSION_PERFORMANCE_METRIC,
};

function createSessionDetailPlaceholder(sessionId: string): SessionDetail {
  return {
    session: {
      sessionId,
      visitorId: "",
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

const SESSION_PERFORMANCE_METRICS: PerformanceMetricKey[] = [
  "ttfb",
  "fcp",
  "lcp",
  "cls",
  "inp",
];
const SESSION_PERFORMANCE_THRESHOLDS: Record<
  PerformanceMetricKey,
  { good: number; poor: number }
> = {
  ttfb: { good: 800, poor: 1800 },
  fcp: { good: 1800, poor: 3000 },
  lcp: { good: 2500, poor: 4000 },
  cls: { good: 0.1, poor: 0.25 },
  inp: { good: 200, poor: 500 },
};
const SESSION_PERFORMANCE_STATUS_STYLE = {
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

const SessionDetailMapStage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/session-detail-map-stage").then(
      (module) => module.SessionDetailMapStage,
    ),
  {
    ssr: false,
    loading: () => <DetailMapPlaceholder />,
  },
);

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

function sessionLocationPoint(
  session: JourneySession,
): SessionLocationPoint | null {
  const latitude = session.latitude;
  const longitude = session.longitude;
  return hasValidCoordinate(latitude, longitude) &&
    typeof latitude === "number" &&
    typeof longitude === "number"
    ? {
        latitude,
        longitude,
        timestampMs: session.startedAt,
      }
    : null;
}

function sessionLocationPoints(
  rawPoints: SessionDetail["locationPoints"] | undefined,
  session: JourneySession,
): SessionLocationPoint[] {
  const points = (rawPoints ?? []).flatMap((point) =>
    hasValidCoordinate(point.latitude, point.longitude)
      ? [
          {
            latitude: point.latitude,
            longitude: point.longitude,
            timestampMs: point.timestampMs,
          },
        ]
      : [],
  );
  if (points.length > 0) return points;
  const fallback = sessionLocationPoint(session);
  return fallback ? [fallback] : [];
}

function sessionGeoLocationInputs(
  detail: SessionDetail,
): JourneyGeoLocationInput[] {
  const session = detail.session;
  return [
    {
      country: session.country,
      region: session.region,
      regionCode: session.regionCode,
      city: session.city,
      latitude: session.latitude,
      longitude: session.longitude,
    },
    ...(detail.locationPoints ?? []).map((point) => ({
      country: point.country,
      region: point.region,
      regionCode: point.regionCode,
      city: point.city,
      latitude: point.latitude,
      longitude: point.longitude,
    })),
  ];
}

function eventKindLabel(labels: Labels, event: JourneyEvent): string {
  if (event.kind === "session_start") return labels.sessionStarted;
  if (event.kind === "pageview") return labels.pageview;
  if (event.kind === "leave") return labels.exitPage;
  return labels.customEvent;
}

function eventTitle(labels: Labels, event: JourneyEvent): string {
  if (event.kind === "session_start") return labels.sessionStarted;
  if (event.kind === "pageview" || event.kind === "leave")
    return formatPathWithHash(event.pathname, event.hash);
  return event.eventType.trim() || labels.customEvent;
}

function eventDisplayTitle(labels: Labels, event: JourneyEvent): string {
  const kind = eventKindLabel(labels, event);
  const title = eventTitle(labels, event);
  if (!title || title === kind) return kind;
  return `${kind}${labels.eventTitleSeparator}${title}`;
}

function eventChronologyRank(event: JourneyEvent): number {
  if (event.kind === "session_start") return 0;
  if (event.kind === "pageview") return 1;
  if (event.kind === "custom") return 2;
  return 3;
}

function formatDetailedDateTime(
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

function pageviewSubtitle(
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

function sessionPerformanceStatusLabel(
  messages: AppMessages,
  status: SessionPerformanceStatus,
): string {
  if (status === "great") return messages.performance.great;
  if (status === "needs-improvement")
    return messages.performance.needsImprovement;
  if (status === "poor") return messages.performance.poor;
  return messages.common.noData;
}

function sessionScoreStatus(
  score: number | null | undefined,
): SessionPerformanceStatus {
  if (score == null || !Number.isFinite(score)) return "none";
  if (score >= 90) return "great";
  if (score >= 50) return "needs-improvement";
  return "poor";
}

function sessionMetricStatus(
  metric: PerformanceMetricKey,
  value: number | null | undefined,
): SessionPerformanceStatus {
  if (value == null || !Number.isFinite(value)) return "none";
  const thresholds = SESSION_PERFORMANCE_THRESHOLDS[metric];
  if (value <= thresholds.good) return "great";
  if (value <= thresholds.poor) return "needs-improvement";
  return "poor";
}

function sessionMetricScore(
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

function averageSessionPerformanceScore(
  values: Array<number | null | undefined>,
): number | null {
  const scores = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function sessionPerformanceScore(
  performance: JourneyPerformanceSummary,
): number | null {
  return averageSessionPerformanceScore(
    SESSION_PERFORMANCE_METRICS.map((metric) =>
      sessionMetricScore(metric, performance[metric]?.p75),
    ),
  );
}

function sessionPerformanceSamples(
  performance: JourneyPerformanceSummary,
): number {
  return Math.max(
    0,
    ...SESSION_PERFORMANCE_METRICS.map(
      (metric) => performance[metric]?.samples ?? 0,
    ),
  );
}

function hasSessionPerformanceSamples(
  performance: JourneyPerformanceSummary,
): boolean {
  return SESSION_PERFORMANCE_METRICS.some(
    (metric) => (performance[metric]?.samples ?? 0) > 0,
  );
}

function formatSessionMetricValue(
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

function sessionPerformancePanelValue(
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

function formatSessionMetricRange(
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

function sessionScoreRange(): string {
  return "0 - 100";
}

function sessionMetricDetailRows(
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

function sessionScoreDetailRows(
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

function eventSubtitle(
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

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-24 items-center justify-center border border-dashed border-border px-4 py-6 text-center text-[11px] text-muted-foreground">
      {children}
    </div>
  );
}

function SessionPerformanceCell({
  label,
  value,
  status,
  details,
  loading = false,
}: {
  label: string;
  value: string;
  status: SessionPerformanceStatus;
  details: string[];
  loading?: boolean;
}) {
  const statusStyle = SESSION_PERFORMANCE_STATUS_STYLE[status];
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

function SessionPerformanceMetricCell({
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
  const status = sessionMetricStatus(metric, value);

  return (
    <SessionPerformanceCell
      label={messages.performance[metric]}
      value={formatSessionMetricValue(locale, messages, metric, value)}
      status={status}
      details={sessionMetricDetailRows(
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

const SessionPerformancePanel = memo(function SessionPerformancePanel({
  locale,
  messages,
  labels,
  performance,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  performance: JourneyPerformanceSummary;
  loading?: boolean;
}) {
  const score = sessionPerformanceScore(performance);
  const samples = sessionPerformanceSamples(performance);
  const scoreStatus = sessionScoreStatus(score);
  const statusStyle = SESSION_PERFORMANCE_STATUS_STYLE[scoreStatus];
  const StatusIcon = statusStyle.icon;
  const hasSamples = hasSessionPerformanceSamples(performance);
  if (!hasSamples && !loading) return null;

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
                    {sessionPerformanceStatusLabel(messages, scoreStatus)}
                  </span>
                </span>
              )}
            </AutoTransition>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid grid-cols-2 gap-px overflow-hidden bg-border/70 text-xs md:grid-cols-3">
          <SessionPerformanceCell
            label={messages.performance.score}
            value={sessionPerformancePanelValue(
              locale,
              messages,
              "score",
              score,
            )}
            status={scoreStatus}
            details={sessionScoreDetailRows(locale, messages, labels, samples)}
            loading={loading}
          />
          {SESSION_PERFORMANCE_METRICS.map((metric) => (
            <SessionPerformanceMetricCell
              key={metric}
              locale={locale}
              messages={messages}
              labels={labels}
              metric={metric}
              summary={performance[metric]}
              loading={loading}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
});

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

function SummaryPathLink({
  pathname,
  pagesPath,
}: {
  pathname: string;
  pagesPath: string;
}) {
  return (
    <Link
      href={buildPageDetailHref(pagesPath, pathname || "/")}
      className="block min-w-0 truncate font-mono text-xs text-foreground outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring/60"
    >
      {formatPath(pathname)}
    </Link>
  );
}

function SessionGeoBreadcrumb({
  locale,
  messages,
  session,
}: {
  locale: Locale;
  messages: AppMessages;
  session: JourneySession;
}) {
  const country = resolveCountryLabel(
    session.country,
    locale,
    messages.common.unknown,
  );
  const flagCode = resolveCountryFlagCode(country.code, locale);
  const regionLabel =
    session.region.trim() ||
    session.regionCode.trim() ||
    messages.common.unknown;
  const cityLabel = session.city.trim() || messages.common.unknown;
  const hasRegion = Boolean(session.region.trim() || session.regionCode.trim());
  const hasCity = Boolean(session.city.trim());

  return (
    <LazyGeoCityBreadcrumbLabel
      locale={locale}
      countryLabel={country.label}
      countryIconName={flagCode ? `flagpack:${flagCode.toLowerCase()}` : null}
      regionLabel={regionLabel}
      cityLabel={cityLabel}
      countryCode={country.code ?? session.country}
      stateCode={session.regionCode || session.region}
      cityNameDefault={session.city}
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

const SessionMapHero = memo(function SessionMapHero({
  locale,
  labels,
  session,
  locationPoints,
  backHref,
  visitorHref,
  onBack,
  onOpenVisitor,
  loading = false,
}: {
  locale: Locale;
  labels: Labels;
  session: JourneySession;
  locationPoints: SessionDetail["locationPoints"] | undefined;
  backHref: string;
  visitorHref: string;
  onBack?: () => void;
  onOpenVisitor?: (visitorId: string) => void;
  loading?: boolean;
}) {
  const modalReady = useDetailDrawerReady();
  const { resolvedTheme } = useTheme();
  const effectiveTheme: SessionDetailMapTheme =
    resolvedTheme === "dark" ? "dark" : "light";
  const visitorId = session.visitorId.trim();
  const points = useMemo(
    () => (modalReady ? sessionLocationPoints(locationPoints, session) : []),
    [locationPoints, modalReady, session],
  );

  return (
    <div className="relative h-[17rem] overflow-hidden sm:h-[19rem]">
      <AutoTransition
        initial={false}
        transitionKey={modalReady && !loading ? "map" : "placeholder"}
        duration={0.24}
        type="fade"
        presenceMode="wait"
        className="absolute inset-0"
      >
        {modalReady && !loading ? (
          <SessionDetailMapStage
            key="map"
            locale={locale}
            theme={effectiveTheme}
            points={points}
          />
        ) : (
          <DetailMapPlaceholder key="placeholder" />
        )}
      </AutoTransition>

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
          {labels.sessionId}: {session.sessionId}
        </div>
      </div>

      <AutoTransition
        initial={false}
        transitionKey={
          loading ? "loading" : visitorId ? `visitor:${visitorId}` : "empty"
        }
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
        ) : visitorId ? (
          onOpenVisitor ? (
            <button
              key="visitor-button"
              type="button"
              className="flex min-w-0 items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
              onClick={() => onOpenVisitor(visitorId)}
            >
              <VisitorAvatar seed={session.visitorId} className="size-12" />
              <div className="min-w-0">
                <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground">
                  {labels.anonymous}
                </h1>
                <p className="mt-1 truncate font-mono text-[11px] text-foreground/70">
                  {labels.visitorId}: {session.visitorId}
                </p>
              </div>
            </button>
          ) : (
            <Link
              key="visitor-link"
              href={visitorHref}
              data-skip-page-transition=""
              className="flex min-w-0 items-center gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
            >
              <VisitorAvatar seed={session.visitorId} className="size-12" />
              <div className="min-w-0">
                <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground">
                  {labels.anonymous}
                </h1>
                <p className="mt-1 truncate font-mono text-[11px] text-foreground/70">
                  {labels.visitorId}: {session.visitorId}
                </p>
              </div>
            </Link>
          )
        ) : (
          <div key="empty" className="flex min-w-0 items-center gap-3">
            <VisitorAvatar seed={session.visitorId} className="size-12" />
            <div className="min-w-0">
              <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight text-foreground">
                {labels.anonymous}
              </h1>
              <p className="mt-1 truncate font-mono text-[11px] text-foreground/70">
                {labels.visitorId}: --
              </p>
            </div>
          </div>
        )}
      </AutoTransition>
    </div>
  );
});

const MetaPanel = memo(function MetaPanel({
  locale,
  messages,
  labels,
  detail,
  pagesPath,
  timeZone,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: SessionDetail;
  pagesPath: string;
  timeZone: string;
  loading?: boolean;
}) {
  const session = detail.session;
  const firstEvent = detail.events.reduce<JourneyEvent | null>(
    (earliest, event) =>
      !earliest || event.occurredAt < earliest.occurredAt ? event : earliest,
    null,
  );
  const lastEvent = detail.events.reduce<JourneyEvent | null>(
    (latest, event) =>
      !latest || event.occurredAt > latest.occurredAt ? event : latest,
    null,
  );

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="grid grid-cols-2 gap-px overflow-hidden bg-border/70 text-xs text-muted-foreground xl:grid-cols-4">
          <SummaryGridItem
            label={labels.duration}
            prominent
            mono
            loading={loading}
            value={formatDuration(locale, session.durationMs)}
          />
          <SummaryGridItem
            label={labels.screenViews}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, session.views)}
          />
          <SummaryGridItem
            label={labels.events}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, session.events)}
          />
          <SummaryGridItem
            label={labels.uniquePages}
            prominent
            mono
            loading={loading}
            value={numberFormat(locale, detail.visitedPages.length)}
          />
          <SummaryGridItem
            label={labels.entryPath}
            className="col-span-2"
            loading={loading}
            value={
              <SummaryPathLink
                pathname={session.entryPath}
                pagesPath={pagesPath}
              />
            }
          />
          <SummaryGridItem
            label={labels.exitPath}
            className="col-span-2"
            loading={loading}
            value={
              <SummaryPathLink
                pathname={session.exitPath}
                pagesPath={pagesPath}
              />
            }
          />
          <SummaryGridItem
            label={labels.location}
            loading={loading}
            value={
              <SessionGeoBreadcrumb
                locale={locale}
                messages={messages}
                session={session}
              />
            }
          />
          <SummaryGridItem
            label={labels.referrerName}
            loading={loading}
            value={
              <ReferrerMeta
                referrerHost={session.referrerHost}
                referrerUrl={session.referrerUrl}
                directLabel={messages.overview.direct}
              />
            }
          />
          <SummaryGridItem
            className="col-span-2"
            label={labels.referrerUrl}
            mono
            loading={loading}
            value={session.referrerUrl || messages.overview.direct}
          />
          <SummaryGridItem
            label={labels.browser}
            loading={loading}
            value={
              <BrowserMeta
                browser={session.browser}
                version={session.browserVersion}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.os}
            loading={loading}
            value={
              <OsMeta
                os={session.os}
                version={session.osVersion}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.device}
            loading={loading}
            value={
              <DeviceMeta
                deviceType={session.deviceType}
                deviceLabels={messages.common.deviceLabels}
                unknownLabel={messages.common.unknown}
              />
            }
          />
          <SummaryGridItem
            label={labels.screen}
            mono
            loading={loading}
            value={formatScreen(session.screenWidth, session.screenHeight)}
          />
          <SummaryGridItem
            label={labels.firstEvent}
            mono
            loading={loading}
            value={
              firstEvent
                ? formatShortDateTime(locale, firstEvent.occurredAt, timeZone)
                : "--"
            }
          />
          <SummaryGridItem
            label={labels.lastEvent}
            mono
            loading={loading}
            value={
              lastEvent
                ? formatShortDateTime(locale, lastEvent.occurredAt, timeZone)
                : "--"
            }
          />
          <SummaryGridItem
            label={labels.bounce}
            loading={loading}
            value={session.bounce ? labels.yes : labels.no}
          />
          <SummaryGridItem
            label={labels.status}
            loading={loading}
            value={session.active ? labels.active : labels.inactive}
          />
        </div>
      </CardContent>
    </Card>
  );
});

const SessionEventCard = memo(function SessionEventCard({
  locale,
  messages,
  labels,
  event,
  deltaMs,
  timeZone,
  onOpenEvent,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  event: JourneyEvent;
  deltaMs: number | null;
  timeZone: string;
  onOpenEvent: (event: JourneyEvent) => void;
}) {
  return (
    <Clickable
      className="block w-full rounded-none text-left focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() => onOpenEvent(event)}
      enableHoverScale={false}
      tapScale={0.985}
      duration={0.14}
      aria-label={eventDisplayTitle(labels, event)}
      title={eventDisplayTitle(labels, event)}
    >
      <Card size="sm" className="border border-foreground/10 py-0 ring-0">
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
                {deltaMs !== null && deltaMs > 0 ? (
                  <p className="max-w-full break-words font-mono text-[10px] leading-[13px] text-muted-foreground">
                    {labels.sincePrevious}: {formatDuration(locale, deltaMs)}
                  </p>
                ) : (
                  <span className="h-[13px]" aria-hidden="true" />
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </Clickable>
  );
});

function SessionEventSkeletonCard() {
  return (
    <Card size="sm" className="border border-foreground/10 py-0 ring-0">
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

const VisitDetailsTab = memo(function VisitDetailsTab({
  locale,
  messages,
  labels,
  events,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  timeZone,
  onOpenEvent,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  events: JourneyEvent[];
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  timeZone: string;
  onOpenEvent: (event: JourneyEvent) => void;
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
  const eventContentKey = loading ? "loading" : "content";
  const loadMoreInFlightRef = useRef(false);

  useEffect(() => {
    if (!loadingMore || !hasMore) loadMoreInFlightRef.current = false;
  }, [hasMore, loadingMore]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || loadMoreInFlightRef.current || !onLoadMore) {
      return;
    }
    loadMoreInFlightRef.current = true;
    onLoadMore();
  }, [hasMore, loadingMore, onLoadMore]);

  const loadMoreSentinelRef = useInfiniteTableSentinel({
    enabled: Boolean(onLoadMore) && !loading && !loadingMore && hasMore,
    onReachEnd: loadMore,
    rootMargin: "0px",
    triggerDistance: 0,
  });

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
            transitionKey={eventContentKey}
            duration={0.18}
            type="fade"
            presenceMode="wait"
          >
            {loading ? (
              <div key="loading" className="space-y-1.5" aria-busy="true">
                {Array.from({ length: 5 }, (_, index) => (
                  <SessionEventSkeletonCard key={`event-skeleton-${index}`} />
                ))}
              </div>
            ) : chronologicalEvents.length === 0 && !hasMore ? (
              <EmptyState key="empty">{labels.emptyEvents}</EmptyState>
            ) : (
              <div key={eventContentKey} className="space-y-1.5">
                {chronologicalEvents.map((event, index) => (
                  <SessionEventCard
                    key={event.id}
                    locale={locale}
                    messages={messages}
                    labels={labels}
                    event={event}
                    timeZone={timeZone}
                    onOpenEvent={onOpenEvent}
                    deltaMs={
                      index > 0
                        ? event.occurredAt -
                          chronologicalEvents[index - 1].occurredAt
                        : null
                    }
                  />
                ))}
                {hasMore ? (
                  <div
                    ref={loadMoreSentinelRef}
                    aria-hidden="true"
                    className="min-h-[58px]"
                  >
                    <SessionEventSkeletonCard />
                  </div>
                ) : null}
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardContent>
    </Card>
  );
});

const SESSION_DETAIL_OVERVIEW_FILTERS = EMPTY_DASHBOARD_FILTER_DOCUMENT;
const SESSION_OVERVIEW_PAGE_CARD_TABS = ["path", "title"] as const;

interface SessionOverviewRowInput {
  label: string;
  views?: number;
}

function aggregateOverviewRows(
  rows: SessionOverviewRowInput[],
  fallbackLabel: string,
): OverviewTabRows {
  const rowByLabel = new globalThis.Map<string, OverviewTabRows[number]>();

  for (const row of rows) {
    const label = row.label.trim() || fallbackLabel;
    if (!label) continue;
    const views = Math.max(1, Math.floor(Number(row.views ?? 1)));
    const existing = rowByLabel.get(label);

    if (existing) {
      existing.views += views;
      existing.sessions = Math.max(1, existing.sessions);
      existing.visitors = Math.max(1, existing.visitors);
      continue;
    }

    rowByLabel.set(label, {
      label,
      views,
      sessions: 1,
      visitors: 1,
    });
  }

  return Array.from(rowByLabel.values()).sort(
    (left, right) =>
      right.views - left.views || left.label.localeCompare(right.label),
  );
}

function buildSessionOverviewPageCardData(
  detail: SessionDetail,
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
          pageviewEvents.map((event) => ({ label: event.pathname || "/" })),
          "/",
        );

  return {
    page: {
      path: pathRows,
      query: [],
      title: aggregateOverviewRows(
        pageviewEvents.map((event) => ({ label: event.title })),
        unknownLabel,
      ),
      hostname: aggregateOverviewRows(
        pageviewEvents.map((event) => ({ label: event.hostname })),
        unknownLabel,
      ),
      entry: aggregateOverviewRows(
        [{ label: detail.session.entryPath || "/", views: 1 }],
        "/",
      ),
      exit: aggregateOverviewRows(
        [{ label: detail.session.exitPath || "/", views: 1 }],
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

function resolveSessionSiteDomain(detail: SessionDetail): string {
  for (const event of detail.events) {
    const hostname = event.hostname.trim();
    if (hostname) return hostname;
  }
  return "";
}

function buildSessionEventBreakdownRows(
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
      mono: event.kind === "custom",
    });
  }

  return Array.from(rowByLabel.values()).sort(
    (left, right) =>
      right.views - left.views || left.label.localeCompare(right.label),
  );
}

const SessionDetailBottomCards = memo(function SessionDetailBottomCards({
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
  detail: SessionDetail;
  siteId: string;
  siteBasePath: string;
  siteDomain: string;
  loading?: boolean;
}) {
  const pageCardData = useMemo(
    () => buildSessionOverviewPageCardData(detail, messages.common.unknown),
    [detail, messages.common.unknown],
  );
  const eventRows = useMemo(
    () => buildSessionEventBreakdownRows(detail.events, labels),
    [detail.events, labels],
  );
  const eventTabs = useMemo(
    () =>
      [
        {
          value: "event",
          label: labels.events,
          columnLabel: labels.events,
          primaryMetricLabel: labels.events,
        },
      ] as const,
    [labels.events],
  );
  const eventLoader = useMemo<AsyncDimensionBreakdownLoader<"event">>(
    () =>
      async ({ limit }) => ({
        items: eventRows,
        pagination: {
          limit,
          returned: eventRows.length,
          hasMore: false,
          nextCursor: null,
        },
      }),
    [eventRows],
  );

  return (
    <section className="grid items-stretch gap-6 xl:grid-cols-2">
      <div className="min-w-0 h-full [&>section]:h-full [&>section]:!grid-cols-1 [&>section>div]:h-full">
        <OverviewPagesSection
          locale={locale}
          messages={messages}
          siteId={siteId}
          siteDomain={siteDomain}
          pathname={siteBasePath}
          filters={SESSION_DETAIL_OVERVIEW_FILTERS}
          cardDataOverride={pageCardData}
          visibleCards={["page"]}
          pageCardTabs={SESSION_OVERVIEW_PAGE_CARD_TABS}
          pageCardShowVisitors={false}
          loading={loading}
        />
      </div>

      <div className="min-w-0 h-full">
        <AsyncDimensionBreakdownCard
          locale={locale}
          messages={messages}
          tabs={eventTabs}
          loader={eventLoader}
          requestKey={`session-detail-events:${detail.session.sessionId}:${locale}:${JSON.stringify(eventRows)}`}
          className="h-full"
          showVisitors={false}
          emptyLabel={labels.emptyCustomEvents}
        />
      </div>
    </section>
  );
});

function DetailContent({
  locale,
  messages,
  labels,
  detail,
  siteId,
  pathname,
  timeZone,
  timeWindow,
  onOpenVisitor,
  hasMoreEvents = false,
  loadingMoreEvents = false,
  onLoadMoreEvents,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: SessionDetail;
  siteId: string;
  pathname: string;
  timeZone: string;
  timeWindow: TimeWindow;
  onOpenVisitor?: (visitorId: string) => void;
  hasMoreEvents?: boolean;
  loadingMoreEvents?: boolean;
  onLoadMoreEvents?: () => void;
  loading?: boolean;
}) {
  const modalClose = useDetailDrawerClose();
  const session = detail.session;
  const sessionsPath = pathname.replace(/\/detail$/, "");
  const siteBasePath = sessionsPath.replace(/\/sessions$/, "");
  const sessionSiteDomain = useMemo(
    () => resolveSessionSiteDomain(detail),
    [detail],
  );
  const pagesPath = `${siteBasePath}/pages`;
  const visitorHref = `${siteBasePath}/visitors?detail=${encodeURIComponent(
    session.visitorId,
  )}`;
  const geoLocations = useMemo(
    () => sessionGeoLocationInputs(detail),
    [detail],
  );
  const [selectedEvent, setSelectedEvent] = useState<JourneyEvent | null>(null);
  const eventDetailQuery = useQuery({
    queryKey: [
      "dashboard",
      "journey-event-detail",
      siteId,
      selectedEvent?.id ?? "",
      selectedEvent?.kind ?? "",
      selectedEvent?.sessionId ?? "",
      selectedEvent?.visitId ?? "",
      timeWindow.from,
      timeWindow.to,
      timeWindow.timeZone,
    ],
    queryFn: ({ signal }) => {
      if (!selectedEvent) throw new Error("Event selection is required");
      if (selectedEvent.kind === "custom") {
        return fetchEventRecordDetail(siteId, selectedEvent.id, timeWindow, {
          signal,
          preserveErrors: true,
        });
      }
      return fetchJourneyEventDetail(
        siteId,
        selectedEvent.id,
        selectedEvent.kind,
        timeWindow,
        {
          sessionId: selectedEvent.sessionId,
          visitId: selectedEvent.visitId,
          signal,
          preserveErrors: true,
        },
      );
    },
    enabled: typeof window !== "undefined" && Boolean(selectedEvent),
  });
  const eventDetail = eventDetailQuery.data?.data ?? null;
  const eventDetailLoading = eventDetailQuery.isPending && !eventDetail;
  const eventDetailError = eventDetailQuery.isError && !eventDetail;

  return (
    <div className="pb-6">
      <SessionMapHero
        locale={locale}
        labels={labels}
        session={session}
        locationPoints={detail.locationPoints}
        backHref={sessionsPath}
        visitorHref={visitorHref}
        onBack={modalClose ?? undefined}
        onOpenVisitor={onOpenVisitor}
        loading={loading}
      />

      <div className="mx-auto mt-6 w-full max-w-[1400px] space-y-6 px-4 md:px-6">
        <MetaPanel
          locale={locale}
          messages={messages}
          labels={labels}
          detail={detail}
          pagesPath={pagesPath}
          timeZone={timeZone}
          loading={loading}
        />

        <section>
          <VisitDetailsTab
            locale={locale}
            messages={messages}
            labels={labels}
            events={detail.events}
            hasMore={hasMoreEvents}
            loadingMore={loadingMoreEvents}
            onLoadMore={onLoadMoreEvents}
            timeZone={timeZone}
            onOpenEvent={setSelectedEvent}
            loading={loading}
          />
        </section>

        <SessionDetailBottomCards
          locale={locale}
          messages={messages}
          labels={labels}
          detail={detail}
          siteId={siteId}
          siteBasePath={siteBasePath}
          siteDomain={sessionSiteDomain}
          loading={loading}
        />

        <JourneyGeoLocationCard
          locale={locale}
          messages={messages}
          title={labels.geoLocationTitle}
          locations={geoLocations}
          loading={loading}
        />

        <SessionPerformancePanel
          locale={locale}
          messages={messages}
          labels={labels}
          performance={detail.performance}
          loading={loading}
        />

        <EventDetailDrawer
          locale={locale}
          messages={messages}
          labels={messages.events}
          siteId={siteId}
          pathname={pathname}
          siteBasePath={siteBasePath}
          open={Boolean(selectedEvent)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setSelectedEvent(null);
          }}
          detail={eventDetail}
          loading={eventDetailLoading}
          error={eventDetailError}
          eventKind={selectedEvent?.kind ?? "pageview"}
          zIndex={NESTED_DETAIL_DRAWER_Z_INDEX + 100}
        />
      </div>
    </div>
  );
}

export const SessionDetailClientPage = memo(function SessionDetailClientPage({
  locale,
  messages,
  siteId,
  pathname,
  sessionId,
  onOpenVisitor,
}: SessionDetailClientPageProps) {
  const labels = messages.sessionDetail;
  const { timeZone, window } = useDashboardQueryControls();
  const requestKey = useMemo(
    () => [siteId, sessionId, timeZone, window.from, window.to].join(":"),
    [sessionId, siteId, timeZone, window.from, window.to],
  );

  const detailQuery = useQuery({
    queryKey: ["dashboard", "session-detail", requestKey],
    queryFn: ({ signal }) =>
      fetchSessionDetail(siteId, sessionId, timeZone, window, { signal }),
    enabled: typeof window !== "undefined" && Boolean(sessionId),
  });
  const summary = detailQuery.data?.data ?? null;
  const eventsQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "session-detail-events",
      siteId,
      sessionId,
      timeZone,
      window.from,
      window.to,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchSessionEvents(siteId, sessionId, window, {
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.data?.pagination?.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
    enabled: Boolean(summary && sessionId),
  });
  const loadedEvents = eventsQuery.data
    ? eventsQuery.data.pages.flatMap((page) => page.data.items)
    : (summary?.events ?? []);
  const detail = summary ? { ...summary, events: loadedEvents } : null;
  const loading = detailQuery.isPending && !summary;
  const error = detailQuery.isError;

  if (!sessionId) {
    return (
      <JourneyDetailStateSwitch stateKey="session-missing">
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
      <JourneyDetailStateSwitch stateKey="session-error">
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
      <JourneyDetailStateSwitch stateKey="session-not-found">
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
      detail={detail ?? createSessionDetailPlaceholder(sessionId)}
      siteId={siteId}
      pathname={pathname}
      timeZone={timeZone}
      timeWindow={window}
      onOpenVisitor={onOpenVisitor}
      hasMoreEvents={Boolean(eventsQuery.hasNextPage)}
      loadingMoreEvents={eventsQuery.isFetchingNextPage}
      onLoadMoreEvents={() => {
        if (eventsQuery.hasNextPage && !eventsQuery.isFetchingNextPage) {
          void eventsQuery.fetchNextPage();
        }
      }}
      loading={loading}
    />
  );
});

SessionDetailClientPage.displayName = "SessionDetailClientPage";
