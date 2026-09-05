import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type RemixiconComponentType,
  RiAlarmWarningLine,
  RiBarChartBoxLine,
  RiCpuLine,
  RiDatabase2Line,
  RiRefreshLine,
  RiSpeedUpLine,
  RiTimeLine,
} from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  LatencyPercentileChart,
  type LatencyPercentileChartPoint,
} from "@/components/dashboard/charts/latency-percentile-chart";
import { useDashboardQueryControls } from "@/components/dashboard/dashboard-query-provider";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { PageHeading } from "@/components/dashboard/page-heading";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { requestAdminService } from "@/lib/admin-service-client";
import {
  intlLocale,
  numberFormat,
  shortDateTime,
} from "@/lib/dashboard/format";
import type { SystemPerformanceInitialData } from "@/lib/dashboard/management-data";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import type {
  DoDiagnosticAggregate,
  DoDiagnosticSiteEntry,
  SystemPerformanceData,
  SystemPerformanceWindowMinutes,
} from "@/lib/system-performance";
import { cn } from "@/lib/utils";

interface SystemPerformanceClientProps {
  locale: Locale;
  messages: AppMessages;
  initialData?: SystemPerformanceInitialData | null;
}

const WINDOW_OPTIONS: readonly SystemPerformanceWindowMinutes[] = [
  15, 60, 360, 1440,
] as const;
async function fetchSystemPerformance(
  minutes: SystemPerformanceWindowMinutes,
  signal?: AbortSignal,
): Promise<SystemPerformanceData> {
  return requestAdminService<SystemPerformanceData>("system-performance", {
    params: { minutes },
    signal,
  });
}

async function fetchDoDiagnostic(
  signal?: AbortSignal,
): Promise<DoDiagnosticAggregate> {
  return requestAdminService<DoDiagnosticAggregate>("do-diagnostic", {
    signal,
  });
}

function formatMetricNumber(locale: Locale, value: number): string {
  return numberFormat(locale, Math.round(value));
}

function formatMetricRate(locale: Locale, value: number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 1,
  }).format(value);
}

function formatPercent(locale: Locale, value: number): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatLatency(locale: Locale, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  const normalized = Math.max(0, value);
  if (normalized < 1000) {
    return `${formatMetricNumber(locale, normalized)} ms`;
  }
  return `${new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 2,
  }).format(normalized / 1000)} s`;
}

function formatAge(locale: Locale, value: number | null): string {
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

function formatEventKind(messages: AppMessages, kind: string): string {
  if (kind === "custom_event") return messages.realtime.customEvent;
  return messages.realtime.viewPage;
}

function windowLabel(
  messages: AppMessages,
  minutes: SystemPerformanceWindowMinutes,
): string {
  if (minutes === 15) return messages.systemPerformance.range15m;
  if (minutes === 60) return messages.systemPerformance.range1h;
  if (minutes === 360) return messages.systemPerformance.range6h;
  return messages.systemPerformance.range24h;
}

function SystemMetricCell({
  icon: Icon,
  label,
  value,
  detail,
  loading = false,
  tone = "default",
}: {
  icon: RemixiconComponentType;
  label: string;
  value: string;
  detail: string;
  loading?: boolean;
  tone?: "default" | "warning" | "good";
}) {
  const contentKey = loading ? "loading" : value;

  return (
    <div className="min-w-0 bg-card p-4">
      <div className="flex min-w-0 items-center gap-2">
        <span className="inline-flex shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-[11px]" />
        </span>
        <p className="min-w-0 truncate text-[11px] uppercase text-muted-foreground">
          {label}
        </p>
      </div>
      <AutoResizer initial className="mt-3">
        <AutoTransition
          transitionKey={contentKey}
          initial={false}
          duration={0.2}
          type="fade"
          presenceMode="wait"
        >
          {loading ? (
            <div key="loading" className="flex h-7 items-center">
              <Spinner className="size-5" />
            </div>
          ) : (
            <p
              key={value}
              className={cn(
                "min-w-0 truncate font-mono text-xl leading-7 font-semibold text-foreground tabular-nums",
                tone === "warning" && "text-destructive",
                tone === "good" && "text-primary",
              )}
            >
              {value}
            </p>
          )}
        </AutoTransition>
      </AutoResizer>
      <p className="mt-3 min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function DoDiagnosticPanel({
  locale,
  messages,
  timeZone,
  data,
  loading,
  requested,
  onRun,
}: {
  locale: Locale;
  messages: AppMessages;
  timeZone: string;
  data: DoDiagnosticAggregate | null;
  loading: boolean;
  requested: boolean;
  onRun: () => void;
}) {
  const t = messages.systemPerformance;
  const totals = data?.totals;
  const thresholds = data?.thresholds;
  const hasAnomalies = totals
    ? totals.openHardAged > 0 ||
      totals.openFutureSkewed > 0 ||
      totals.stuckDirtyVisits > 0 ||
      totals.stuckDirtyCustomEvents > 0
    : false;

  const thresholdHint = useMemo(() => {
    if (!thresholds) return "";
    return formatI18nTemplate(t.doDiagnosticThresholdsHint, {
      stale: formatAge(locale, thresholds.staleMs),
      timeout: formatAge(locale, thresholds.timeoutMs),
      hardAged: formatAge(locale, thresholds.hardAgedMs),
      stuck: thresholds.stuckFlushAttempts,
    });
  }, [locale, thresholds, t.doDiagnosticThresholdsHint]);

  const sites = data?.sites ?? [];
  const visibleSites = sites.filter((entry) => {
    if (!entry.ok || !entry.diagnostic) return true;
    const o = entry.diagnostic.visits.open;
    return (
      entry.diagnostic.visits.total > 0 ||
      entry.diagnostic.customEvents.total > 0 ||
      o.total > 0
    );
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RiCpuLine className="size-4" />
          {t.doDiagnosticTitle}
        </CardTitle>
        <CardDescription>{t.doDiagnosticDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AutoResizer initial duration={0.28} ease={[0.22, 1, 0.36, 1]}>
          <AutoTransition
            initial={false}
            duration={0.2}
            type="fade"
            presenceMode="wait"
            transitionKey={
              !requested ? "idle" : loading && !data ? "loading" : "result"
            }
          >
            {!requested ? (
              <div
                key="idle"
                className="flex min-h-28 flex-col items-center justify-center gap-3 border bg-muted/20 p-4 text-center"
              >
                <Button
                  type="button"
                  variant="outline"
                  className="gap-2"
                  disabled={loading}
                  onClick={onRun}
                >
                  <RiRefreshLine className="size-4" />
                  {t.doDiagnosticRun}
                </Button>
              </div>
            ) : loading && !data ? (
              <div
                key="loading"
                className="flex min-h-28 items-center justify-center gap-2 border bg-muted/20 p-4 text-sm text-muted-foreground"
                aria-busy="true"
              >
                <Spinner className="size-4" />
                {t.doDiagnosticLoading}
              </div>
            ) : (
              <div key="result" className="space-y-4">
                <div className="grid gap-px overflow-hidden border bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
                  <DoDiagnosticCell
                    label={t.doDiagnosticTotalSites}
                    value={
                      data ? formatMetricNumber(locale, data.totalSites) : "--"
                    }
                    detail={
                      data
                        ? `${t.doDiagnosticReachableSites}: ${formatMetricNumber(locale, data.reachableSites)}`
                        : ""
                    }
                  />
                  <DoDiagnosticCell
                    label={t.doDiagnosticActiveAlarms}
                    value={
                      totals
                        ? formatMetricNumber(locale, totals.activeAlarms)
                        : "--"
                    }
                    detail={
                      totals
                        ? `${t.doDiagnosticBufferedVisits}: ${formatMetricNumber(locale, totals.bufferedVisits)}`
                        : ""
                    }
                  />
                  <DoDiagnosticCell
                    label={t.doDiagnosticOpenVisits}
                    value={
                      totals
                        ? formatMetricNumber(locale, totals.openVisits)
                        : "--"
                    }
                    detail={
                      totals
                        ? `${t.doDiagnosticOpenStale}: ${formatMetricNumber(locale, totals.openStale)} / ${t.doDiagnosticOpenTimedOut}: ${formatMetricNumber(locale, totals.openTimedOut)}`
                        : ""
                    }
                    tone={
                      totals && totals.openTimedOut > 0 ? "warning" : "default"
                    }
                  />
                  <DoDiagnosticCell
                    label={t.doDiagnosticStuckDirty}
                    value={
                      totals
                        ? formatMetricNumber(
                            locale,
                            totals.stuckDirtyVisits +
                              totals.stuckDirtyCustomEvents,
                          )
                        : "--"
                    }
                    detail={
                      totals
                        ? `${t.doDiagnosticOpenHardAged}: ${formatMetricNumber(locale, totals.openHardAged)} / ${t.doDiagnosticOpenFutureSkew}: ${formatMetricNumber(locale, totals.openFutureSkewed)}`
                        : ""
                    }
                    tone={hasAnomalies ? "warning" : "good"}
                  />
                </div>

                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <DoDiagnosticKv
                    label={t.doDiagnosticOldestOpen}
                    value={
                      data?.oldestOpenStartedAt
                        ? shortDateTime(
                            locale,
                            data.oldestOpenStartedAt,
                            timeZone,
                          )
                        : "--"
                    }
                  />
                  <DoDiagnosticKv
                    label={t.doDiagnosticFutureMaxActivity}
                    value={
                      data?.futureMaxActivityAt
                        ? shortDateTime(
                            locale,
                            data.futureMaxActivityAt,
                            timeZone,
                          )
                        : "--"
                    }
                    tone={data?.futureMaxActivityAt ? "warning" : "default"}
                  />
                  <DoDiagnosticKv
                    label={t.doDiagnosticMaxFlushAttempts}
                    value={
                      totals
                        ? `${formatMetricNumber(locale, totals.maxVisitFlushAttempts)} / ${formatMetricNumber(locale, totals.maxCustomEventFlushAttempts)}`
                        : "--"
                    }
                    tone={
                      totals &&
                      Math.max(
                        totals.maxVisitFlushAttempts,
                        totals.maxCustomEventFlushAttempts,
                      ) >= (thresholds?.stuckFlushAttempts ?? 5)
                        ? "warning"
                        : "default"
                    }
                  />
                  <DoDiagnosticKv
                    label={t.doDiagnosticBufferedCustomEvents}
                    value={
                      totals
                        ? `${formatMetricNumber(locale, totals.bufferedCustomEvents)} (dirty: ${formatMetricNumber(locale, totals.dirtyCustomEvents)})`
                        : "--"
                    }
                  />
                </div>

                {data && data.unreachableSites > 0 ? (
                  <Badge variant="outline" className="gap-2 text-destructive">
                    <RiAlarmWarningLine className="size-3" />
                    {t.doDiagnosticUnreachable}:{" "}
                    {formatMetricNumber(locale, data.unreachableSites)}
                  </Badge>
                ) : null}

                <div className="border-t pt-4">
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-medium">
                        {t.doDiagnosticSiteList}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        {t.doDiagnosticSiteListDescription}
                      </p>
                    </div>
                    {thresholdHint ? (
                      <p className="hidden text-right text-xs text-muted-foreground md:block">
                        {thresholdHint}
                      </p>
                    ) : null}
                  </div>
                  <DataTableSwitch
                    loading={loading}
                    hasContent={visibleSites.length > 0}
                    loadingLabel={t.doDiagnosticLoading}
                    emptyLabel={
                      data && data.totalSites === 0
                        ? t.doDiagnosticEmpty
                        : t.doDiagnosticHealthy
                    }
                    colSpan={7}
                    header={
                      <TableRow>
                        <TableHead>{messages.common.site}</TableHead>
                        <TableHead className="text-right">
                          {t.doDiagnosticSiteOpen}
                        </TableHead>
                        <TableHead className="text-right">
                          {t.doDiagnosticSiteHardAged}
                        </TableHead>
                        <TableHead className="text-right">
                          {t.doDiagnosticSiteFuture}
                        </TableHead>
                        <TableHead className="text-right">
                          {t.doDiagnosticSiteStuck}
                        </TableHead>
                        <TableHead className="text-right">
                          {t.doDiagnosticSiteAlarm}
                        </TableHead>
                        <TableHead className="text-right">
                          {t.doDiagnosticSiteResponseMs}
                        </TableHead>
                      </TableRow>
                    }
                    rows={visibleSites.map((site) => (
                      <DoDiagnosticSiteRow
                        key={site.siteId}
                        locale={locale}
                        messages={messages}
                        site={site}
                      />
                    ))}
                  />
                </div>

                {thresholdHint ? (
                  <p className="text-xs text-muted-foreground md:hidden">
                    {thresholdHint}
                  </p>
                ) : null}
              </div>
            )}
          </AutoTransition>
        </AutoResizer>
      </CardContent>
    </Card>
  );
}

function DoDiagnosticCell({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "warning" | "good";
}) {
  return (
    <div className="min-w-0 bg-card p-3">
      <p className="min-w-0 truncate text-[11px] uppercase text-muted-foreground">
        {label}
      </p>
      <AutoTransition
        transitionKey={value}
        initial={false}
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        <p
          key={value}
          className={cn(
            "mt-2 min-w-0 truncate font-mono text-xl leading-7 font-semibold tabular-nums",
            tone === "warning" && "text-destructive",
            tone === "good" && "text-primary",
          )}
        >
          {value}
        </p>
      </AutoTransition>
      {detail ? (
        <p className="mt-2 min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground">
          {detail}
        </p>
      ) : null}
    </div>
  );
}

function DoDiagnosticKv({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warning";
}) {
  return (
    <div className="flex items-center justify-between gap-3 border bg-card px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <AutoTransition
        transitionKey={value}
        initial={false}
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        <span
          key={value}
          className={cn(
            "font-mono text-xs tabular-nums",
            tone === "warning" && "text-destructive",
          )}
        >
          {value}
        </span>
      </AutoTransition>
    </div>
  );
}

function DoDiagnosticSiteRow({
  locale,
  messages,
  site,
}: {
  locale: Locale;
  messages: AppMessages;
  site: DoDiagnosticSiteEntry;
}) {
  const t = messages.systemPerformance;
  if (!site.ok || !site.diagnostic) {
    return (
      <TableRow key={site.siteId}>
        <TableCell>
          <div className="min-w-0">
            <div className="font-medium">{site.siteName}</div>
            <div className="text-xs text-muted-foreground">
              {site.siteDomain || site.siteId}
            </div>
          </div>
        </TableCell>
        <TableCell colSpan={5} className="text-xs text-destructive">
          {t.doDiagnosticSiteFailed}
          {site.error ? ` — ${site.error}` : ""}
        </TableCell>
        <TableCell className="text-right font-mono text-xs">
          {formatMetricNumber(locale, site.durationMs)} ms
        </TableCell>
      </TableRow>
    );
  }
  const d = site.diagnostic;
  const o = d.visits.open;
  const stuckTotal = d.visits.dirty.stuck + d.customEvents.stuck;
  const nextDueKindLabel =
    d.alarm.nextDueKind === "flush"
      ? t.doDiagnosticSiteNextDueFlush
      : d.alarm.nextDueKind === "hidden_fallback"
        ? t.doDiagnosticSiteNextDueHidden
        : d.alarm.nextDueKind === "visit_timeout"
          ? t.doDiagnosticSiteNextDueTimeout
          : null;
  const alarmText =
    d.alarm.scheduledAt === null
      ? t.doDiagnosticSiteAlarmNone
      : d.alarm.scheduledAt <= d.snapshotAt
        ? t.doDiagnosticSiteAlarmDue
        : `+${formatAge(locale, d.alarm.scheduledAt - d.snapshotAt)}`;
  const nextDueText =
    d.alarm.nextDueAt === null
      ? `${t.doDiagnosticSiteNextDue}: —`
      : d.alarm.nextDueAt <= d.snapshotAt
        ? `${t.doDiagnosticSiteNextDue}: due`
        : `${t.doDiagnosticSiteNextDue}: +${formatAge(locale, d.alarm.nextDueAt - d.snapshotAt)}`;
  const alarmIsLate =
    d.alarm.scheduledAt !== null &&
    d.alarm.nextDueAt !== null &&
    d.alarm.scheduledAt > d.alarm.nextDueAt;
  return (
    <TableRow key={site.siteId}>
      <TableCell>
        <div className="min-w-0">
          <div className="font-medium">{site.siteName}</div>
          <div className="text-xs text-muted-foreground">
            {site.siteDomain || site.siteId}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {formatMetricNumber(locale, o.total)}
      </TableCell>
      <TableCell
        className={cn(
          "text-right font-mono text-xs",
          o.hardAged > 0 && "text-destructive",
        )}
      >
        {formatMetricNumber(locale, o.hardAged)}
      </TableCell>
      <TableCell
        className={cn(
          "text-right font-mono text-xs",
          o.futureSkewed > 0 && "text-destructive",
        )}
      >
        {formatMetricNumber(locale, o.futureSkewed)}
      </TableCell>
      <TableCell
        className={cn(
          "text-right font-mono text-xs",
          stuckTotal > 0 && "text-destructive",
        )}
      >
        {formatMetricNumber(locale, stuckTotal)}
      </TableCell>
      <TableCell
        className={cn(
          "text-right font-mono text-xs",
          alarmIsLate && "text-destructive",
        )}
      >
        <div>{alarmText}</div>
        <div className="text-[10px] text-muted-foreground">
          {nextDueText}
          {nextDueKindLabel ? ` · ${nextDueKindLabel}` : ""}
        </div>
      </TableCell>
      <TableCell className="text-right font-mono text-xs">
        {formatMetricNumber(locale, site.durationMs)} ms
      </TableCell>
    </TableRow>
  );
}

export function SystemPerformanceClient({
  locale,
  messages,
  initialData = null,
}: SystemPerformanceClientProps) {
  const { timeZone } = useDashboardQueryControls();
  const t = messages.systemPerformance;
  const [minutes, setMinutes] = useState<SystemPerformanceWindowMinutes>(60);
  const [diagnosticRequested, setDiagnosticRequested] = useState(false);
  const performanceQuery = useQuery({
    queryKey: ["dashboard", "system-performance", minutes],
    queryFn: ({ signal }) => fetchSystemPerformance(minutes, signal),
    initialData: initialData?.data,
    initialDataUpdatedAt: initialData?.fetchedAt,
    staleTime: initialData ? 15_000 : 0,
    enabled: typeof window !== "undefined",
  });
  const diagnosticQuery = useQuery({
    queryKey: ["dashboard", "do-diagnostic"],
    queryFn: ({ signal }) => fetchDoDiagnostic(signal),
    enabled: false,
  });
  const data = performanceQuery.data ?? null;
  const doData = diagnosticQuery.data ?? null;
  const loading = performanceQuery.isFetching;
  const doLoading = diagnosticQuery.isFetching;

  useEffect(() => {
    if (!performanceQuery.isError) return;
    const message =
      performanceQuery.error instanceof Error
        ? performanceQuery.error.message
        : t.loadFailed;
    toast.error(message || t.loadFailed);
  }, [
    performanceQuery.error,
    performanceQuery.errorUpdatedAt,
    performanceQuery.isError,
    t.loadFailed,
  ]);

  useEffect(() => {
    if (!diagnosticQuery.isError) return;
    const message =
      diagnosticQuery.error instanceof Error
        ? diagnosticQuery.error.message
        : t.doDiagnosticLoadFailed;
    toast.error(message || t.doDiagnosticLoadFailed);
  }, [
    diagnosticQuery.error,
    diagnosticQuery.errorUpdatedAt,
    diagnosticQuery.isError,
    t.doDiagnosticLoadFailed,
  ]);

  const bucketFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(intlLocale(locale), {
        hour: "2-digit",
        minute: "2-digit",
        timeZone,
      }),
    [locale, timeZone],
  );
  const maxTrendEvents = Math.max(
    1,
    ...(data?.trend.map((point) => point.totalEvents) ?? []),
  );
  const latencyChartData = useMemo<LatencyPercentileChartPoint[]>(
    () =>
      (data?.trend ?? []).map((point) => ({
        timestampMs: point.timestampMs,
        p50: point.p50LatencyMs,
        p75: point.p75LatencyMs,
        p95: point.p95LatencyMs,
      })),
    [data?.trend],
  );
  const latencyChartLabels = useMemo(
    () => ({
      p50: t.p50Label,
      p75: t.p75Label,
      p95: t.p95Label,
    }),
    [t.p50Label, t.p75Label, t.p95Label],
  );
  const formatLatencyValue = useCallback(
    (value: number | null) => formatLatency(locale, value),
    [locale],
  );
  const summary = data?.summary;
  const openVisits = data?.openVisits;
  const anomalyTone =
    summary && summary.anomalyRate > 0.02 ? "warning" : "default";
  const freshnessTone =
    summary?.dataFreshnessMs !== null &&
    summary?.dataFreshnessMs !== undefined &&
    summary.dataFreshnessMs < 2 * 60 * 1000
      ? "good"
      : "warning";

  return (
    <div className="space-y-5">
      <PageHeading
        title={t.title}
        subtitle={t.subtitle}
        actions={
          <>
            <Select
              value={String(minutes)}
              onValueChange={(value) => {
                const next = Number(value);
                if (
                  WINDOW_OPTIONS.includes(
                    next as SystemPerformanceWindowMinutes,
                  )
                ) {
                  setMinutes(next as SystemPerformanceWindowMinutes);
                }
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOW_OPTIONS.map((option) => (
                  <SelectItem key={option} value={String(option)}>
                    {windowLabel(messages, option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="gap-2"
              disabled={loading}
              onClick={() => {
                void performanceQuery.refetch();
              }}
            >
              <span className="inline-flex size-4 shrink-0 items-center justify-center">
                {loading ? (
                  <Spinner className="size-4" />
                ) : (
                  <RiRefreshLine className="size-4" />
                )}
              </span>
              <AutoResizer
                initial
                animateWidth
                animateHeight={false}
                className="inline-flex shrink-0 items-center"
              >
                <AutoTransition
                  className="inline-block"
                  duration={0.2}
                  type="fade"
                  initial={false}
                  presenceMode="wait"
                  customVariants={{
                    initial: { opacity: 0 },
                    animate: { opacity: 1 },
                    exit: { opacity: 0 },
                  }}
                >
                  <span key={loading ? "loading" : "refresh"}>
                    {loading ? messages.common.loading : t.refresh}
                  </span>
                </AutoTransition>
              </AutoResizer>
            </Button>
          </>
        }
      />

      <Card className="py-0">
        <CardContent className="p-0">
          <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
            <SystemMetricCell
              icon={RiDatabase2Line}
              label={t.totalEvents}
              loading={loading}
              value={
                summary ? formatMetricNumber(locale, summary.totalEvents) : "--"
              }
              detail={
                summary
                  ? `${formatMetricRate(locale, summary.eventsPerMinute)} / min`
                  : "--"
              }
            />
            <SystemMetricCell
              icon={RiSpeedUpLine}
              label={t.p95Latency}
              loading={loading}
              value={
                summary ? formatLatency(locale, summary.p95LatencyMs) : "--"
              }
              detail={
                summary
                  ? `${t.p50Latency}: ${formatLatency(locale, summary.p50LatencyMs)} / ${t.p75Latency}: ${formatLatency(locale, summary.p75LatencyMs)}`
                  : "--"
              }
              tone={
                summary?.p95LatencyMs !== null &&
                summary?.p95LatencyMs !== undefined &&
                summary.p95LatencyMs > (data?.thresholds.delayedMs ?? 0)
                  ? "warning"
                  : "default"
              }
            />
            <SystemMetricCell
              icon={RiTimeLine}
              label={t.dataFreshness}
              loading={loading}
              value={
                summary ? formatAge(locale, summary.dataFreshnessMs) : "--"
              }
              detail={
                summary?.latestCreatedAt
                  ? shortDateTime(locale, summary.latestCreatedAt, timeZone)
                  : t.noRecentWrite
              }
              tone={freshnessTone}
            />
            <SystemMetricCell
              icon={RiAlarmWarningLine}
              label={t.clockAnomalies}
              loading={loading}
              value={
                summary ? formatPercent(locale, summary.anomalyRate) : "--"
              }
              detail={
                summary
                  ? `${t.delayed}: ${formatMetricNumber(locale, summary.delayedEvents)} / ${t.future}: ${formatMetricNumber(locale, summary.futureSkewedEvents)}`
                  : "--"
              }
              tone={anomalyTone}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiSpeedUpLine className="size-4" />
            {t.latencyPercentileTrend}
          </CardTitle>
          <CardDescription>
            {t.latencyPercentileTrendDescription}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LatencyPercentileChart
            data={latencyChartData}
            labels={latencyChartLabels}
            locale={locale}
            timeZone={timeZone}
            formatValue={formatLatencyValue}
            loading={loading}
            loadingLabel={messages.common.loading}
            emptyLabel={t.noData}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiCpuLine className="size-4" />
            {t.throughputTrend}
          </CardTitle>
          <CardDescription>{t.throughputTrendDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <AutoResizer initial>
            <AutoTransition
              transitionKey={
                (data?.trend ?? []).length > 0
                  ? "rows"
                  : loading
                    ? "loading"
                    : "empty"
              }
              initial={false}
              duration={0.2}
              type="fade"
            >
              {(data?.trend ?? []).length > 0 ? (
                <div key="rows" className="space-y-2">
                  {data?.trend.map((point) => {
                    const visitWidth = `${(point.visits / maxTrendEvents) * 100}%`;
                    const customWidth = `${(point.customEvents / maxTrendEvents) * 100}%`;
                    const hasAnomaly =
                      point.delayedEvents > 0 || point.futureSkewedEvents > 0;
                    return (
                      <div
                        key={point.bucket}
                        className="grid grid-cols-[74px_minmax(0,1fr)_72px] items-center gap-3 text-xs"
                      >
                        <div className="text-muted-foreground tabular-nums">
                          {bucketFormatter.format(new Date(point.timestampMs))}
                        </div>
                        <div className="flex h-7 min-w-0 items-center overflow-hidden border border-border bg-muted/25">
                          <div
                            className="h-full bg-primary/70"
                            style={{ width: visitWidth }}
                          />
                          <div
                            className="h-full bg-foreground/35"
                            style={{ width: customWidth }}
                          />
                          {hasAnomaly ? (
                            <div className="ml-1 h-3 w-1 bg-destructive" />
                          ) : null}
                        </div>
                        <div className="text-right font-mono tabular-nums">
                          {formatMetricNumber(locale, point.totalEvents)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div
                  key={loading ? "loading" : "empty"}
                  className="flex h-32 items-center justify-center text-sm text-muted-foreground"
                >
                  {loading ? messages.common.loading : t.noData}
                </div>
              )}
            </AutoTransition>
          </AutoResizer>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <Badge variant="outline" className="gap-1">
              <span className="size-2 bg-primary/70" />
              {t.visits}
            </Badge>
            <Badge variant="outline" className="gap-1">
              <span className="size-2 bg-foreground/35" />
              {t.customEvents}
            </Badge>
            <Badge variant="outline" className="gap-1">
              <span className="h-3 w-1 bg-destructive" />
              {t.anomalyBucket}
            </Badge>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiTimeLine className="size-4" />
              {t.openVisitHealth}
            </CardTitle>
            <CardDescription>{t.openVisitHealthDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-px overflow-hidden border bg-border/70">
              <div className="bg-card p-3">
                <div className="text-xs text-muted-foreground">{t.open}</div>
                <AutoTransition
                  transitionKey={openVisits ? "data" : "empty"}
                  initial={false}
                  duration={0.2}
                  type="fade"
                  presenceMode="wait"
                >
                  <div
                    key={openVisits ? "data" : "empty"}
                    className="mt-2 font-mono text-xl font-semibold tabular-nums"
                  >
                    {openVisits
                      ? formatMetricNumber(locale, openVisits.total)
                      : "--"}
                  </div>
                </AutoTransition>
              </div>
              <div className="bg-card p-3">
                <div className="text-xs text-muted-foreground">{t.stale}</div>
                <AutoTransition
                  transitionKey={openVisits ? "data" : "empty"}
                  initial={false}
                  duration={0.2}
                  type="fade"
                  presenceMode="wait"
                >
                  <div
                    key={openVisits ? "data" : "empty"}
                    className="mt-2 font-mono text-xl font-semibold tabular-nums"
                  >
                    {openVisits
                      ? formatMetricNumber(locale, openVisits.stale)
                      : "--"}
                  </div>
                </AutoTransition>
              </div>
              <div className="bg-card p-3">
                <div className="text-xs text-muted-foreground">
                  {t.timedOut}
                </div>
                <AutoTransition
                  transitionKey={openVisits ? "data" : "empty"}
                  initial={false}
                  duration={0.2}
                  type="fade"
                  presenceMode="wait"
                >
                  <div
                    key={openVisits ? "data" : "empty"}
                    className="mt-2 font-mono text-xl font-semibold tabular-nums"
                  >
                    {openVisits
                      ? formatMetricNumber(locale, openVisits.timedOut)
                      : "--"}
                  </div>
                </AutoTransition>
              </div>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t.oldestOpen}</span>
                <span className="font-mono text-xs">
                  {openVisits?.oldestStartedAt
                    ? shortDateTime(
                        locale,
                        openVisits.oldestStartedAt,
                        timeZone,
                      )
                    : "--"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {t.latestActivity}
                </span>
                <span className="font-mono text-xs">
                  {openVisits?.newestActivityAt
                    ? shortDateTime(
                        locale,
                        openVisits.newestActivityAt,
                        timeZone,
                      )
                    : "--"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="inline-flex items-center gap-2">
              <RiSpeedUpLine className="size-4" />
              {t.latencySampleHealth}
            </CardTitle>
            <CardDescription>
              {t.latencySampleHealthDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-px overflow-hidden border bg-border/70">
              <div className="bg-card p-3">
                <div className="text-xs text-muted-foreground">
                  {t.trustedSamples}
                </div>
                <AutoTransition
                  transitionKey={summary ? "data" : "empty"}
                  initial={false}
                  duration={0.2}
                  type="fade"
                  presenceMode="wait"
                >
                  <div
                    key={summary ? "data" : "empty"}
                    className="mt-2 font-mono text-xl font-semibold tabular-nums"
                  >
                    {summary
                      ? formatMetricNumber(
                          locale,
                          summary.trustedLatencySamples,
                        )
                      : "--"}
                  </div>
                </AutoTransition>
              </div>
              <div className="bg-card p-3">
                <div className="text-xs text-muted-foreground">
                  {t.avgLatency}
                </div>
                <AutoTransition
                  transitionKey={summary ? "data" : "empty"}
                  initial={false}
                  duration={0.2}
                  type="fade"
                  presenceMode="wait"
                >
                  <div
                    key={summary ? "data" : "empty"}
                    className="mt-2 font-mono text-xl font-semibold tabular-nums"
                  >
                    {summary
                      ? formatLatency(locale, summary.avgLatencyMs)
                      : "--"}
                  </div>
                </AutoTransition>
              </div>
            </div>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t.delayed}</span>
                <span className="font-mono text-xs">
                  {summary
                    ? formatMetricNumber(locale, summary.delayedEvents)
                    : "--"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t.future}</span>
                <span className="font-mono text-xs">
                  {summary
                    ? formatMetricNumber(locale, summary.futureSkewedEvents)
                    : "--"}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <DoDiagnosticPanel
        locale={locale}
        messages={messages}
        timeZone={timeZone}
        data={doData}
        loading={doLoading}
        requested={diagnosticRequested}
        onRun={() => {
          setDiagnosticRequested(true);
          void diagnosticQuery.refetch();
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiBarChartBoxLine className="size-4" />
            {t.topSitesTitle}
          </CardTitle>
          <CardDescription>{t.topSitesDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={loading}
            hasContent={(data?.topSites.length ?? 0) > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={t.noData}
            colSpan={7}
            header={
              <TableRow>
                <TableHead>{messages.common.site}</TableHead>
                <TableHead className="text-right">{t.events}</TableHead>
                <TableHead className="text-right">{t.visits}</TableHead>
                <TableHead className="text-right">{t.customEvents}</TableHead>
                <TableHead className="text-right">{t.avgLatency}</TableHead>
                <TableHead className="text-right">{t.delayed}</TableHead>
                <TableHead className="text-right">{t.future}</TableHead>
              </TableRow>
            }
            rows={(data?.topSites ?? []).map((site) => (
              <TableRow key={site.siteId}>
                <TableCell>
                  <div className="min-w-0">
                    <div className="font-medium">{site.siteName}</div>
                    <div className="text-xs text-muted-foreground">
                      {site.siteDomain || site.siteId}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatMetricNumber(locale, site.totalEvents)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatMetricNumber(locale, site.visits)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatMetricNumber(locale, site.customEvents)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatLatency(locale, site.avgLatencyMs)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatMetricNumber(locale, site.delayedEvents)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatMetricNumber(locale, site.futureSkewedEvents)}
                </TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiAlarmWarningLine className="size-4" />
            {t.slowestEventsTitle}
          </CardTitle>
          <CardDescription>{t.slowestEventsDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataTableSwitch
            loading={loading}
            hasContent={(data?.slowEvents.length ?? 0) > 0}
            loadingLabel={messages.common.loading}
            emptyLabel={t.noData}
            colSpan={5}
            header={
              <TableRow>
                <TableHead>{messages.common.event}</TableHead>
                <TableHead>{messages.common.site}</TableHead>
                <TableHead>{t.eventTime}</TableHead>
                <TableHead>{t.serverTime}</TableHead>
                <TableHead className="text-right">{t.estimatedDelay}</TableHead>
              </TableRow>
            }
            rows={(data?.slowEvents ?? []).map((event, index) => (
              <TableRow
                key={`${event.kind}-${event.siteId}-${event.eventAt}-${index}`}
              >
                <TableCell>{formatEventKind(messages, event.kind)}</TableCell>
                <TableCell>
                  <div className="min-w-0">
                    <div className="font-medium">{event.siteName}</div>
                    <div className="text-xs text-muted-foreground">
                      {event.siteDomain || event.siteId}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="font-mono">
                  {shortDateTime(locale, event.eventAt, timeZone)}
                </TableCell>
                <TableCell className="font-mono">
                  {shortDateTime(locale, event.serverAt, timeZone)}
                </TableCell>
                <TableCell className="text-right font-mono">
                  {formatLatency(locale, event.latencyMs)}
                </TableCell>
              </TableRow>
            ))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
