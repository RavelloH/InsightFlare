import { memo } from "react";
import { RiSpeedUpLine } from "@remixicon/react";

import {
  formatMetricValue,
  formatPanelValue,
  METRIC_THRESHOLDS,
  type MetricCardModel,
  metricDescription,
  metricScore,
  metricStatus,
  panelLabel,
  PerformanceChangeRate,
  performanceChangeRate,
  type PerformancePanelKey,
  type PerformanceStatus,
  railSegments,
  roundedScore,
  scoreStatus,
  STATUS_STYLE,
  statusColor,
  statusLabel,
} from "@/components/dashboard/site-pages/performance/model";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent } from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat } from "@/lib/dashboard/format";
import type { PerformanceSummary } from "@/lib/dashboard-api/client/edge";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

import {
  PerformanceDynamicValue,
  PerformancePanelText,
  PerformanceSpinnerValue,
} from "./shared";
export function PerformanceTrendLoadingState({
  messages,
}: {
  messages: AppMessages;
}) {
  const legend = [
    messages.performance.p50Label,
    messages.performance.p75Label,
    messages.performance.p95Label,
  ];

  return (
    <div className="space-y-4">
      <Skeleton className="h-[360px] w-full rounded-none" />
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {legend.map((label) => (
          <span key={label} className="inline-flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-none bg-muted" />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}
function SegmentedThresholdBar({
  panelKey,
  summary,
  status,
  loading = false,
}: {
  panelKey: PerformancePanelKey;
  summary: PerformanceSummary;
  status: PerformanceStatus;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="relative h-5">
        <Skeleton className="absolute inset-x-0 top-1/2 h-2 w-full -translate-y-1/2 rounded-full" />
      </div>
    );
  }

  const marker = summary.p75 == null ? null : 75;
  const segments = railSegments(panelKey, summary);

  return (
    <div className="relative h-5">
      <div className="absolute inset-x-0 top-1/2 flex h-2 -translate-y-1/2 overflow-hidden rounded-full bg-muted">
        {segments.map((segment) => (
          <div
            key={`${panelKey}-${segment.status}`}
            className="h-full"
            style={{
              width: `${segment.width}%`,
              backgroundColor: statusColor(segment.status),
            }}
          />
        ))}
      </div>
      {marker == null ? null : (
        <span
          className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
          style={{
            left: `${marker}%`,
            backgroundColor: statusColor(status),
          }}
        />
      )}
    </div>
  );
}
export const PerformanceRail = memo(function PerformanceRail({
  activePanel,
  cards,
  onSelect,
  comparisonLabel,
  loading = false,
}: {
  activePanel: PerformancePanelKey;
  cards: MetricCardModel[];
  onSelect: (key: PerformancePanelKey) => void;
  comparisonLabel?: string;
  loading?: boolean;
}) {
  return (
    <div className="space-y-3 self-start lg:sticky lg:top-[7.5rem]">
      {cards.map((card) => {
        const active = card.key === activePanel;
        const statusStyle = STATUS_STYLE[card.status];
        const StatusIcon = statusStyle.icon;
        return (
          <Clickable
            key={card.key}
            className="block w-full text-left"
            enableHoverScale={false}
            tapScale={0.985}
            aria-label={card.label}
            onClick={() => onSelect(card.key)}
          >
            <div
              className={cn(
                "relative overflow-hidden rounded-none bg-card p-4 ring-1 ring-border/70 transition-all duration-200",
                "hover:bg-muted/35",
              )}
            >
              <div
                className={cn(
                  "pointer-events-none absolute inset-y-0 left-0 w-1 bg-primary opacity-0 transition-opacity duration-200",
                  active && "opacity-100",
                )}
              />
              <div className="relative space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-muted-foreground">
                      {card.label}
                    </div>
                    <AutoResizer className="mt-2 w-full" duration={0.2}>
                      <PerformanceDynamicValue
                        loading={loading}
                        skeletonClassName="h-8 w-24"
                      >
                        <div className="flex h-8 min-w-0 items-end gap-1.5 leading-none">
                          <div className="min-w-0 truncate text-2xl leading-none font-semibold tracking-tight">
                            {card.valueLabel}
                          </div>
                          {comparisonLabel ? (
                            <PerformanceChangeRate
                              value={card.changeRate}
                              activePanel={card.key}
                            />
                          ) : null}
                        </div>
                      </PerformanceDynamicValue>
                    </AutoResizer>
                  </div>
                  {loading ? (
                    <Skeleton className="size-9 shrink-0 rounded-full" />
                  ) : (
                    <div
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-full",
                        statusStyle.softClassName,
                      )}
                    >
                      <StatusIcon className="size-4" />
                    </div>
                  )}
                </div>
                <SegmentedThresholdBar
                  panelKey={card.key}
                  summary={card.summary}
                  status={card.status}
                  loading={loading}
                />
              </div>
            </div>
          </Clickable>
        );
      })}
    </div>
  );
});
export const MetricSummaryCard = memo(function MetricSummaryCard({
  locale,
  messages,
  activePanel,
  activeSummary,
  activeValue,
  comparisonLabel,
  comparisonSummary,
  comparisonValue,
  pathCount,
  comparisonPathCount,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  activeSummary: PerformanceSummary;
  activeValue: number | null;
  comparisonLabel?: string;
  comparisonSummary?: PerformanceSummary | null;
  comparisonValue?: number | null;
  pathCount: number;
  comparisonPathCount?: number;
  loading?: boolean;
}) {
  const activeStatus =
    activePanel === "score"
      ? scoreStatus(activeValue)
      : metricStatus(activePanel, activeValue);
  const statusStyle = STATUS_STYLE[activeStatus];
  const StatusIcon = statusStyle.icon;
  const score =
    activePanel === "score"
      ? activeValue
      : metricScore(activePanel, activeValue);
  const scoreValue = roundedScore(score);
  const displayValue = formatPanelValue(
    locale,
    messages,
    activePanel,
    activeValue,
  );
  const displayComparisonValue = formatPanelValue(
    locale,
    messages,
    activePanel,
    comparisonValue,
  );
  const changeRate = performanceChangeRate(activeValue, comparisonValue);
  const description = metricDescription(messages, activePanel);
  const thresholdText =
    activePanel === "score"
      ? messages.performance.scoreThresholdText
      : formatI18nTemplate(messages.performance.metricThresholdText, {
          good: formatMetricValue(
            locale,
            messages,
            activePanel,
            METRIC_THRESHOLDS[activePanel].good,
          ),
          poor: formatMetricValue(
            locale,
            messages,
            activePanel,
            METRIC_THRESHOLDS[activePanel].poor,
          ),
        });
  const reading =
    activeSummary.samples > 0
      ? formatI18nTemplate(messages.performance.currentReading, {
          metric: panelLabel(messages, activePanel),
          value: displayValue,
          score: scoreValue == null ? "--" : numberFormat(locale, scoreValue),
          samples: numberFormat(locale, activeSummary.samples),
          status: statusLabel(messages, activeStatus),
        })
      : messages.common.noData;
  const ringPercent =
    scoreValue == null ? 0 : Math.max(0, Math.min(100, scoreValue));
  const ringColor = statusColor(activeStatus);
  const activeStatusLabel = statusLabel(messages, activeStatus);

  return (
    <Card className="overflow-hidden">
      <CardContent className="space-y-5 p-5">
        <AutoResizer className="w-full" duration={0.24}>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
            <div className="min-w-0">
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-2">
                    <PerformancePanelText
                      transitionKey={activePanel}
                      className="text-sm text-muted-foreground"
                    >
                      {panelLabel(messages, activePanel)}
                    </PerformancePanelText>
                    <PerformanceDynamicValue
                      loading={loading}
                      skeletonClassName="h-9 w-24"
                      transitionKey={displayValue}
                    >
                      <div className="flex h-9 items-end gap-2 leading-none">
                        <div className="text-3xl leading-none font-semibold tracking-tight">
                          {displayValue}
                        </div>
                        {comparisonLabel ? (
                          <PerformanceChangeRate
                            value={changeRate}
                            activePanel={activePanel}
                          />
                        ) : null}
                      </div>
                    </PerformanceDynamicValue>
                    {comparisonLabel ? (
                      <PerformancePanelText
                        transitionKey={`${activePanel}:comparison:${displayComparisonValue}`}
                        className="text-xs text-muted-foreground"
                      >
                        {comparisonLabel}: {displayComparisonValue}
                      </PerformancePanelText>
                    ) : null}
                    <PerformanceDynamicValue
                      loading={loading}
                      skeletonClassName="h-5 w-24"
                      transitionKey={activeStatusLabel}
                    >
                      <div className="flex items-center gap-2">
                        <StatusIcon
                          className={cn("size-5", statusStyle.labelClassName)}
                        />
                        <span
                          className={cn(
                            "font-medium",
                            statusStyle.labelClassName,
                          )}
                        >
                          {activeStatusLabel}
                        </span>
                      </div>
                    </PerformanceDynamicValue>
                  </div>
                  <AutoTransition
                    initial={false}
                    transitionKey={
                      loading
                        ? "loading"
                        : `${activePanel}:${scoreValue ?? "--"}`
                    }
                    duration={0.2}
                    type="fade"
                    presenceMode="wait"
                    className="size-[4.5rem] shrink-0"
                  >
                    {loading ? (
                      <Skeleton
                        key="loading"
                        className="size-[4.5rem] rounded-full"
                      />
                    ) : (
                      <div
                        key="ready"
                        className="relative flex size-[4.5rem] items-center justify-center rounded-full"
                        style={{
                          background: `conic-gradient(${ringColor} ${ringPercent * 3.6}deg, var(--muted) 0deg)`,
                        }}
                      >
                        <div className="absolute inset-[6px] rounded-full bg-card" />
                        <div className="relative z-10 flex items-baseline">
                          <span className="text-xl font-semibold tracking-tight">
                            {scoreValue ?? "--"}
                          </span>
                          {scoreValue == null ? null : (
                            <span className="ml-0.5 text-[0.65rem] font-medium text-muted-foreground">
                              %
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </AutoTransition>
                </div>
                <PerformancePanelText
                  transitionKey={description}
                  className="max-w-xl text-sm leading-6 text-muted-foreground"
                >
                  {description}
                </PerformancePanelText>
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-4">
              <div className="space-y-1">
                <div className="text-sm font-medium">
                  {messages.performance.interpretationTitle}
                </div>
                <AutoResizer className="max-w-xl" duration={0.2}>
                  <AutoTransition
                    initial={false}
                    transitionKey={loading ? "loading" : reading}
                    duration={0.18}
                    type="fade"
                    presenceMode="wait"
                    className="space-y-2"
                  >
                    {loading ? (
                      <div key="loading" className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-7/12" />
                      </div>
                    ) : (
                      <p
                        key="ready"
                        className="text-sm leading-6 text-muted-foreground"
                      >
                        {reading}
                      </p>
                    )}
                  </AutoTransition>
                </AutoResizer>
              </div>
              <div className="rounded-none bg-muted/45 p-4">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                  <RiSpeedUpLine className="size-4 text-muted-foreground" />
                  {messages.performance.datasetTitle}
                </div>
                <PerformancePanelText
                  transitionKey={thresholdText}
                  className="text-sm leading-6 text-muted-foreground"
                >
                  {thresholdText}
                </PerformancePanelText>
              </div>
            </div>
          </div>
        </AutoResizer>

        <div className="grid gap-3 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex min-h-[4.75rem] flex-col justify-between rounded-none bg-muted/45 p-3">
              <div className="text-xs text-muted-foreground">
                {messages.performance.pathsAnalyzedLabel}
              </div>
              <PerformanceSpinnerValue
                loading={loading}
                transitionKey={`${pathCount}:${comparisonPathCount ?? "--"}`}
              >
                <div className="grid gap-0.5 font-mono text-lg font-semibold tabular-nums">
                  <span>{numberFormat(locale, pathCount)}</span>
                  {comparisonLabel ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {comparisonLabel}:{" "}
                      {numberFormat(locale, comparisonPathCount ?? 0)}
                    </span>
                  ) : null}
                </div>
              </PerformanceSpinnerValue>
            </div>
            <div className="flex min-h-[4.75rem] flex-col justify-between rounded-none bg-muted/45 p-3">
              <div className="text-xs text-muted-foreground">
                {messages.performance.samplesLabel}
              </div>
              <PerformanceSpinnerValue
                loading={loading}
                transitionKey={`${activeSummary.samples}:${comparisonSummary?.samples ?? "--"}`}
              >
                <div className="grid gap-0.5 font-mono text-lg font-semibold tabular-nums">
                  <span>{numberFormat(locale, activeSummary.samples)}</span>
                  {comparisonLabel ? (
                    <span className="text-xs font-normal text-muted-foreground">
                      {comparisonLabel}:{" "}
                      {numberFormat(locale, comparisonSummary?.samples ?? 0)}
                    </span>
                  ) : null}
                </div>
              </PerformanceSpinnerValue>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              ["p50", messages.performance.p50Label, activeSummary.p50],
              ["p75", messages.performance.p75Label, activeSummary.p75],
              ["p95", messages.performance.p95Label, activeSummary.p95],
            ].map(([key, label, value]) => (
              <div
                key={key as string}
                className="flex min-h-[4.75rem] flex-col justify-between rounded-none bg-muted/45 p-3"
              >
                <div className="text-xs text-muted-foreground">
                  {label as string}
                </div>
                <PerformanceSpinnerValue
                  loading={loading}
                  transitionKey={`${formatPanelValue(
                    locale,
                    messages,
                    activePanel,
                    value as number | null,
                  )}:${formatPanelValue(
                    locale,
                    messages,
                    activePanel,
                    comparisonSummary?.[key as "p50" | "p75" | "p95"] ?? null,
                  )}`}
                >
                  <div className="grid gap-0.5 font-mono text-lg font-semibold tabular-nums">
                    <span>
                      {formatPanelValue(
                        locale,
                        messages,
                        activePanel,
                        value as number | null,
                      )}
                    </span>
                    {comparisonLabel ? (
                      <span className="text-xs font-normal text-muted-foreground">
                        {comparisonLabel}:{" "}
                        {formatPanelValue(
                          locale,
                          messages,
                          activePanel,
                          comparisonSummary?.[key as "p50" | "p75" | "p95"] ??
                            null,
                        )}
                      </span>
                    ) : null}
                  </div>
                </PerformanceSpinnerValue>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
});
