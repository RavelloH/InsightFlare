import { useMemo } from "react";
import { RiAlarmWarningLine, RiCpuLine, RiRefreshLine } from "@remixicon/react";

import { DataTableSwitch } from "@/components/dashboard/common/data-table-switch";
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
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { shortDateTime } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import type {
  DoDiagnosticAggregate,
  DoDiagnosticSiteEntry,
} from "@/lib/system-performance";
import { cn } from "@/lib/utils";

import { formatAge, formatMetricNumber } from "./formatters";
export function DoDiagnosticPanel({
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
