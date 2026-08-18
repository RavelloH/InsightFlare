import { type ReactNode, useMemo } from "react";
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
import {
  JourneyDetailLoadingState,
  JourneyDetailStateSwitch,
} from "@/components/dashboard/journey-detail-state";
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
import {
  OverviewPagesSection,
  type OverviewPagesSectionCardData,
} from "@/components/dashboard/site-pages/overview-client-page";
import type {
  SessionDetailMapTheme,
  SessionLocationPoint,
} from "@/components/dashboard/site-pages/session-detail-map-stage";
import { useTheme } from "@/components/theme-provider";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import {
  fetchSessionDetail,
  type OverviewTabRows,
} from "@/lib/dashboard/client-data";
import { EMPTY_DASHBOARD_FILTER_DOCUMENT } from "@/lib/dashboard/filter-state";
import { intlLocale, numberFormat } from "@/lib/dashboard/format";
import { buildPageDetailHref } from "@/lib/dashboard/page-detail";
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
}: {
  label: string;
  value: string;
  status: SessionPerformanceStatus;
  details: string[];
}) {
  const statusStyle = SESSION_PERFORMANCE_STATUS_STYLE[status];
  const StatusIcon = statusStyle.icon;

  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <p className="min-w-0 truncate text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </p>
        <span
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-full",
            statusStyle.softClassName,
          )}
        >
          <StatusIcon className="size-3.5" />
        </span>
      </div>
      <p className="mt-3 min-w-0 truncate font-mono text-xl font-semibold leading-7 text-foreground">
        {value}
      </p>
      <div className="mt-3 flex min-w-0 flex-col gap-1 text-[11px] leading-[14px] text-muted-foreground">
        {details.map((detail) => (
          <span key={detail} className="min-w-0 truncate">
            {detail}
          </span>
        ))}
      </div>
    </div>
  );
}

function SessionPerformanceMetricCell({
  locale,
  messages,
  labels,
  metric,
  summary,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  metric: PerformanceMetricKey;
  summary: JourneyPerformanceMetricSummary;
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
    />
  );
}

function SessionPerformancePanel({
  locale,
  messages,
  labels,
  performance,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  performance: JourneyPerformanceSummary;
}) {
  const score = sessionPerformanceScore(performance);
  const samples = sessionPerformanceSamples(performance);
  const scoreStatus = sessionScoreStatus(score);
  const statusStyle = SESSION_PERFORMANCE_STATUS_STYLE[scoreStatus];
  const StatusIcon = statusStyle.icon;
  const hasSamples = hasSessionPerformanceSamples(performance);
  if (!hasSamples) return null;

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
            <StatusIcon className="size-3.5" />
            <span>{sessionPerformanceStatusLabel(messages, scoreStatus)}</span>
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
          />
          {SESSION_PERFORMANCE_METRICS.map((metric) => (
            <SessionPerformanceMetricCell
              key={metric}
              locale={locale}
              messages={messages}
              labels={labels}
              metric={metric}
              summary={performance[metric]}
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
  className,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  prominent?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 bg-card p-4", className)}>
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <div
        className={cn(
          "mt-2 min-w-0 text-foreground [overflow-wrap:anywhere]",
          mono && "font-mono",
          prominent
            ? "text-xl font-semibold leading-tight"
            : "text-xs leading-relaxed",
        )}
      >
        {value}
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

function SessionMapHero({
  labels,
  session,
  locationPoints,
  backHref,
  visitorHref,
  onBack,
  onOpenVisitor,
}: {
  labels: Labels;
  session: JourneySession;
  locationPoints: SessionDetail["locationPoints"] | undefined;
  backHref: string;
  visitorHref: string;
  onBack?: () => void;
  onOpenVisitor?: (visitorId: string) => void;
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
      {modalReady ? (
        <SessionDetailMapStage theme={effectiveTheme} points={points} />
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
          {labels.sessionId}: {session.sessionId}
        </div>
      </div>

      {visitorId ? (
        onOpenVisitor ? (
          <button
            type="button"
            className="absolute bottom-4 left-4 z-10 flex min-w-0 max-w-[calc(100%-2rem)] items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70 sm:bottom-5 sm:left-5"
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
            href={visitorHref}
            data-skip-page-transition=""
            className="absolute bottom-4 left-4 z-10 flex min-w-0 max-w-[calc(100%-2rem)] items-center gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/70 sm:bottom-5 sm:left-5"
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
        <div className="absolute bottom-4 left-4 z-10 flex min-w-0 max-w-[calc(100%-2rem)] items-center gap-3 sm:bottom-5 sm:left-5">
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
    </div>
  );
}

function MetaPanel({
  locale,
  messages,
  labels,
  detail,
  pagesPath,
  timeZone,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: SessionDetail;
  pagesPath: string;
  timeZone: string;
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
            value={formatDuration(locale, session.durationMs)}
          />
          <SummaryGridItem
            label={labels.screenViews}
            prominent
            mono
            value={numberFormat(locale, session.views)}
          />
          <SummaryGridItem
            label={labels.events}
            prominent
            mono
            value={numberFormat(locale, session.events)}
          />
          <SummaryGridItem
            label={labels.uniquePages}
            prominent
            mono
            value={numberFormat(locale, detail.visitedPages.length)}
          />
          <SummaryGridItem
            label={labels.entryPath}
            className="col-span-2"
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
            value={
              <SummaryPathLink
                pathname={session.exitPath}
                pagesPath={pagesPath}
              />
            }
          />
          <SummaryGridItem
            label={labels.referrerName}
            value={
              <ReferrerMeta
                referrerHost={session.referrerHost}
                referrerUrl={session.referrerUrl}
                directLabel={messages.overview.direct}
              />
            }
          />
          <SummaryGridItem
            label={labels.referrerUrl}
            mono
            value={session.referrerUrl || messages.overview.direct}
          />
          <SummaryGridItem
            label={labels.location}
            className="col-span-2"
            value={
              <SessionGeoBreadcrumb
                locale={locale}
                messages={messages}
                session={session}
              />
            }
          />
          <SummaryGridItem
            label={labels.browser}
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
            value={formatScreen(session.screenWidth, session.screenHeight)}
          />
          <SummaryGridItem
            label={labels.firstEvent}
            mono
            value={
              firstEvent
                ? formatShortDateTime(locale, firstEvent.occurredAt, timeZone)
                : "--"
            }
          />
          <SummaryGridItem
            label={labels.lastEvent}
            mono
            value={
              lastEvent
                ? formatShortDateTime(locale, lastEvent.occurredAt, timeZone)
                : "--"
            }
          />
          <SummaryGridItem
            label={labels.bounce}
            value={session.bounce ? labels.yes : labels.no}
          />
          <SummaryGridItem
            label={labels.status}
            value={session.active ? labels.active : labels.inactive}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function SessionEventCard({
  locale,
  messages,
  labels,
  event,
  deltaMs,
  timeZone,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  event: JourneyEvent;
  deltaMs: number | null;
  timeZone: string;
}) {
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
  );
}

function VisitDetailsTab({
  locale,
  messages,
  labels,
  events,
  timeZone,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  events: JourneyEvent[];
  timeZone: string;
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
        {chronologicalEvents.length === 0 ? (
          <EmptyState>{labels.emptyEvents}</EmptyState>
        ) : (
          <div className="space-y-1.5">
            {chronologicalEvents.map((event, index) => (
              <SessionEventCard
                key={event.id}
                locale={locale}
                messages={messages}
                labels={labels}
                event={event}
                timeZone={timeZone}
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
      </CardContent>
    </Card>
  );
}

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

function SessionDetailBottomCards({
  locale,
  messages,
  labels,
  detail,
  siteId,
  siteBasePath,
  siteDomain,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: SessionDetail;
  siteId: string;
  siteBasePath: string;
  siteDomain: string;
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
          filters={SESSION_DETAIL_OVERVIEW_FILTERS}
          cardDataOverride={pageCardData}
          visibleCards={["page"]}
          pageCardTabs={SESSION_OVERVIEW_PAGE_CARD_TABS}
          pageCardShowVisitors={false}
        />
      </div>

      <div className="min-w-0 h-full">
        <AsyncDimensionBreakdownCard
          locale={locale}
          messages={messages}
          tabs={eventTabs}
          loadRows={loadEventRows}
          requestKey={`session-detail-events:${detail.session.sessionId}:${locale}`}
          className="h-full"
          showVisitors={false}
          emptyLabel={labels.emptyCustomEvents}
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
  onOpenVisitor,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: Labels;
  detail: SessionDetail;
  siteId: string;
  pathname: string;
  timeZone: string;
  onOpenVisitor?: (visitorId: string) => void;
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

  return (
    <div className="pb-6">
      <SessionMapHero
        labels={labels}
        session={session}
        locationPoints={detail.locationPoints}
        backHref={sessionsPath}
        visitorHref={visitorHref}
        onBack={modalClose ?? undefined}
        onOpenVisitor={onOpenVisitor}
      />

      <div className="mx-auto mt-6 w-full max-w-[1400px] space-y-6 px-4 md:px-6">
        <MetaPanel
          locale={locale}
          messages={messages}
          labels={labels}
          detail={detail}
          pagesPath={pagesPath}
          timeZone={timeZone}
        />

        <section>
          <VisitDetailsTab
            locale={locale}
            messages={messages}
            labels={labels}
            events={detail.events}
            timeZone={timeZone}
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
        />

        <JourneyGeoLocationCard
          locale={locale}
          messages={messages}
          title={labels.geoLocationTitle}
          locations={geoLocations}
        />

        <SessionPerformancePanel
          locale={locale}
          messages={messages}
          labels={labels}
          performance={detail.performance}
        />
      </div>
    </div>
  );
}

export function SessionDetailClientPage({
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
  const detail = detailQuery.data?.data ?? null;
  const loading = detailQuery.isPending;
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

  if (loading) {
    return (
      <JourneyDetailStateSwitch stateKey="session-loading">
        <JourneyDetailLoadingState
          kind="session"
          loadingLabel={messages.common.loading}
        />
      </JourneyDetailStateSwitch>
    );
  }

  if (error) {
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

  if (!detail) {
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
    <JourneyDetailStateSwitch stateKey={`session-content-${requestKey}`}>
      <DetailContent
        locale={locale}
        messages={messages}
        labels={labels}
        detail={detail}
        siteId={siteId}
        pathname={pathname}
        timeZone={timeZone}
        onOpenVisitor={onOpenVisitor}
      />
    </JourneyDetailStateSwitch>
  );
}
