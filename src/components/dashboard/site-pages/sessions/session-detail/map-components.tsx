import { memo, useMemo } from "react";
import { RiArrowLeftLine, RiPulseLine } from "@remixicon/react";

import {
  VisitorAvatar,
  visitorDisplayName,
} from "@/components/dashboard/journeys/journey-display";
import { type JourneyGeoLocationInput } from "@/components/dashboard/journeys/journey-geo-location-card";
import { useDetailDrawerReady } from "@/components/dashboard/site-pages/common/detail-drawer";
import type {
  SessionDetailMapTheme,
  SessionLocationPoint,
} from "@/components/dashboard/site-pages/sessions/session-detail-map-stage";
import { useTheme } from "@/components/theme-provider";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  JourneyPerformanceMetricSummary,
  JourneyPerformanceSummary,
  JourneySession,
  PerformanceMetricKey,
} from "@/lib/dashboard-api/client/edge";
import dynamic from "@/lib/dynamic";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import Link from "@/lib/router";
import { cn } from "@/lib/utils";

import {
  formatSessionMetricValue,
  hasSessionPerformanceSamples,
  type Labels,
  SESSION_PERFORMANCE_METRICS,
  SESSION_PERFORMANCE_STATUS_STYLE,
  type SessionDetail,
  sessionMetricDetailRows,
  sessionMetricStatus,
  sessionPerformancePanelValue,
  sessionPerformanceSamples,
  sessionPerformanceScore,
  type SessionPerformanceStatus,
  sessionPerformanceStatusLabel,
  sessionScoreDetailRows,
  sessionScoreStatus,
} from "./model";
export const SessionDetailMapStage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/sessions/session-detail-map-stage").then(
      (module) => module.SessionDetailMapStage,
    ),
  {
    ssr: false,
    loading: () => <DetailMapPlaceholder />,
  },
);
export function hasValidCoordinate(
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
export function sessionLocationPoint(
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
export function sessionLocationPoints(
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
export function sessionGeoLocationInputs(
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
export function SessionPerformanceCell({
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
export function SessionPerformanceMetricCell({
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
export const SessionPerformancePanel = memo(function SessionPerformancePanel({
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
export const SessionMapHero = memo(function SessionMapHero({
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
  const displayName = visitorDisplayName(
    session.userName,
    session.userId,
    labels.anonymous,
  );
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
                  {displayName}
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
                  {displayName}
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
