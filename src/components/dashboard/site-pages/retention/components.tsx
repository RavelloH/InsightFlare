import { memo } from "react";
import {
  type RemixiconComponentType,
  RiArrowDownLine,
  RiArrowUpLine,
  RiCalendarLine,
  RiGroupLine,
  RiPercentLine,
  RiRepeat2Line,
} from "@remixicon/react";

import {
  AnalyticsDetailsTooltipTarget,
  AnalyticsTimeTooltipProvider,
} from "@/components/dashboard/analytics-time-tooltip";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { OverlayScrollbar } from "@/components/ui/overlay-scrollbar";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

import {
  formatRetentionChange,
  periodLabel,
  retentionAverageAt,
  retentionCellAt,
  retentionCellStyle,
  type RetentionCellView,
  retentionChangeClass,
  type RetentionCohortView,
  retentionComparisonChange,
  type RetentionComparisonViewModel,
  type RetentionCopy,
  type RetentionLoadingShape,
  type RetentionViewModel,
} from "./model";
const RETENTION_TABLE_COLUMNS =
  "[--retention-cohort-width:6rem] [--retention-size-width:4rem] [--retention-period-width:4.5rem]";
const RETENTION_COHORT_COLUMN =
  "w-[var(--retention-cohort-width)] min-w-[var(--retention-cohort-width)] max-w-[var(--retention-cohort-width)]";
const RETENTION_SIZE_COLUMN =
  "w-[var(--retention-size-width)] min-w-[var(--retention-size-width)] max-w-[var(--retention-size-width)]";
const RETENTION_PERIOD_COLUMN =
  "w-[var(--retention-period-width)] min-w-[var(--retention-period-width)] max-w-[var(--retention-period-width)]";
function RetentionChangeRate({ value }: { value: number | null }) {
  if (value === null) return null;
  const ChangeIcon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-end gap-0.5 font-mono text-xs leading-none tabular-nums",
        retentionChangeClass(value),
      )}
    >
      <ChangeIcon className="size-3.5" />
      {formatRetentionChange(value)}
    </span>
  );
}
const RetentionMetricCell = memo(function RetentionMetricCell({
  icon: Icon,
  label,
  value,
  detail,
  comparisonChange,
  comparisonLabel,
  comparisonValue,
  loading = false,
}: {
  icon: RemixiconComponentType;
  label: string;
  value: string;
  detail: string;
  comparisonChange?: number | null;
  comparisonLabel?: string;
  comparisonValue?: string | null;
  loading?: boolean;
}) {
  const contentKey = loading ? "loading" : `${value}:${comparisonChange ?? ""}`;
  const detailKey = loading
    ? "loading"
    : comparisonChange === undefined
      ? detail
      : `comparison:${comparisonChange ?? "unavailable"}:${comparisonLabel ?? ""}:${comparisonValue ?? "unavailable"}`;

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
      <AutoResizer initial animateHeight={false} className="mt-3 h-7">
        <AutoTransition
          className="h-7"
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
            <div
              key={contentKey}
              className="flex h-7 min-w-0 items-end gap-1.5 leading-none"
            >
              <span className="min-w-0 truncate font-mono text-xl leading-none font-semibold text-foreground">
                {value}
              </span>
              {comparisonChange !== undefined ? (
                <RetentionChangeRate value={comparisonChange} />
              ) : null}
            </div>
          )}
        </AutoTransition>
      </AutoResizer>
      <AutoTransition
        initial={false}
        transitionKey={detailKey}
        className="mt-3 h-[14px]"
        duration={0.2}
        type="fade"
        presenceMode="wait"
      >
        {loading ? (
          <Skeleton
            key="loading"
            className="h-full w-[min(12rem,72%)] rounded-none"
          />
        ) : comparisonChange === undefined ? (
          <p
            key={detail}
            className="h-[14px] min-w-0 truncate text-[11px] leading-[14px] text-muted-foreground"
          >
            {detail}
          </p>
        ) : (
          <div
            key={detailKey}
            className="h-[14px] min-w-0 truncate font-mono text-[11px] leading-[14px] text-muted-foreground"
          >
            {comparisonLabel}: {comparisonValue ?? "--"}
          </div>
        )}
      </AutoTransition>
    </div>
  );
});
export const RetentionSummaryGrid = memo(function RetentionSummaryGrid({
  locale,
  labels,
  viewModel,
  comparisonViewModel,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  labels: RetentionCopy;
  viewModel: RetentionViewModel;
  comparisonViewModel?: RetentionViewModel | null;
  comparisonLabel: string;
  loading?: boolean;
}) {
  const { summary } = viewModel;
  const comparisonSummary = comparisonViewModel?.summary;

  return (
    <Card className="py-0">
      <CardContent className="p-0">
        <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
          <RetentionMetricCell
            icon={RiCalendarLine}
            label={labels.cohortsMetric}
            loading={loading}
            value={numberFormat(locale, summary.cohortCount)}
            detail={`${numberFormat(locale, viewModel.columns.length)} ${labels.periodsAnalyzed}`}
            comparisonLabel={comparisonLabel}
            comparisonValue={
              comparisonSummary
                ? numberFormat(locale, comparisonSummary.cohortCount)
                : undefined
            }
            comparisonChange={
              comparisonSummary
                ? retentionComparisonChange(
                    summary.cohortCount,
                    comparisonSummary.cohortCount,
                  )
                : undefined
            }
          />
          <RetentionMetricCell
            icon={RiGroupLine}
            label={labels.visitorsMetric}
            loading={loading}
            value={numberFormat(locale, summary.totalVisitors)}
            detail={labels.cohortDetail}
            comparisonLabel={comparisonLabel}
            comparisonValue={
              comparisonSummary
                ? numberFormat(locale, comparisonSummary.totalVisitors)
                : undefined
            }
            comparisonChange={
              comparisonSummary
                ? retentionComparisonChange(
                    summary.totalVisitors,
                    comparisonSummary.totalVisitors,
                  )
                : undefined
            }
          />
          <RetentionMetricCell
            icon={RiPercentLine}
            label={labels.periodOneMetric}
            loading={loading}
            value={
              summary.periodOneRate === null
                ? "--"
                : percentFormat(locale, summary.periodOneRate)
            }
            detail={
              summary.periodOneBase > 0
                ? `${numberFormat(locale, summary.periodOneBase)} ${labels.eligibleVisitors}`
                : labels.noEligibleCohorts
            }
            comparisonLabel={comparisonLabel}
            comparisonValue={
              comparisonSummary
                ? comparisonSummary.periodOneRate === null
                  ? null
                  : percentFormat(locale, comparisonSummary.periodOneRate)
                : undefined
            }
            comparisonChange={
              comparisonSummary
                ? retentionComparisonChange(
                    summary.periodOneRate,
                    comparisonSummary.periodOneRate,
                  )
                : undefined
            }
          />
          <RetentionMetricCell
            icon={RiRepeat2Line}
            label={labels.averageReturnMetric}
            loading={loading}
            value={
              summary.averageReturnRate === null
                ? "--"
                : percentFormat(locale, summary.averageReturnRate)
            }
            detail={
              summary.strongestCohort
                ? `${labels.strongestCohortMetric}: ${summary.strongestCohort.label} ${percentFormat(
                    locale,
                    summary.strongestCohort.rate,
                  )}`
                : labels.noEligibleCohorts
            }
            comparisonLabel={comparisonLabel}
            comparisonValue={
              comparisonSummary
                ? comparisonSummary.averageReturnRate === null
                  ? null
                  : percentFormat(locale, comparisonSummary.averageReturnRate)
                : undefined
            }
            comparisonChange={
              comparisonSummary
                ? retentionComparisonChange(
                    summary.averageReturnRate,
                    comparisonSummary.averageReturnRate,
                  )
                : undefined
            }
          />
        </div>
      </CardContent>
    </Card>
  );
});
export const RetentionStateCard = memo(function RetentionStateCard({
  title,
  subtitle,
  icon: Icon,
}: {
  title: string;
  subtitle: string;
  icon: RemixiconComponentType;
}) {
  return (
    <Card>
      <CardContent className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
        <span className="inline-flex size-10 items-center justify-center border bg-muted/50 text-muted-foreground">
          <Icon className="size-5" />
        </span>
        <div className="space-y-1">
          <p className="font-medium">{title}</p>
          <p className="max-w-md text-muted-foreground">{subtitle}</p>
        </div>
      </CardContent>
    </Card>
  );
});
const RetentionLoading = memo(function RetentionLoading({
  shape,
}: {
  shape: RetentionLoadingShape;
}) {
  const rows = Array.from({ length: shape.rows }, (_, index) => index);
  const columns = Array.from({ length: shape.columns }, (_, index) => index);

  return (
    <OverlayScrollbar className="pb-1" aria-hidden="true">
      <table
        className={cn(
          RETENTION_TABLE_COLUMNS,
          "w-max min-w-full table-fixed border-separate border-spacing-0 text-left text-xs",
        )}
      >
        <colgroup>
          <col className={RETENTION_COHORT_COLUMN} />
          <col className={RETENTION_SIZE_COLUMN} />
          {columns.map((index) => (
            <col key={index} className={RETENTION_PERIOD_COLUMN} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th
              className={cn(
                RETENTION_COHORT_COLUMN,
                "sticky left-0 z-40 border-b bg-card py-2 pr-2 pl-3",
              )}
            >
              <Skeleton className="h-3 w-16" />
            </th>
            <th
              className={cn(
                RETENTION_SIZE_COLUMN,
                "sticky left-[var(--retention-cohort-width)] z-40 border-r border-b bg-card px-2 py-2",
              )}
            >
              <Skeleton className="ml-auto h-3 w-8" />
            </th>
            {columns.map((index) => (
              <th
                key={index}
                className={cn(RETENTION_PERIOD_COLUMN, "border-b px-1 py-2")}
              >
                <Skeleton className="mx-auto h-3 w-10" />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((rowIndex) => (
            <tr key={rowIndex}>
              <th
                className={cn(
                  RETENTION_COHORT_COLUMN,
                  "sticky left-0 z-30 border-b bg-card py-2 pr-2 pl-3",
                )}
              >
                <Skeleton className="h-4 w-14" />
              </th>
              <td
                className={cn(
                  RETENTION_SIZE_COLUMN,
                  "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2",
                )}
              >
                <Skeleton className="ml-auto h-4 w-9" />
              </td>
              {columns.map((cellIndex) => (
                <td
                  key={`${rowIndex}-${cellIndex}`}
                  className={cn(
                    RETENTION_PERIOD_COLUMN,
                    "border-r border-b p-1 align-middle",
                  )}
                >
                  <Skeleton className="h-8 w-full" />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th
              className={cn(
                RETENTION_COHORT_COLUMN,
                "sticky left-0 z-30 border-t bg-card py-2 pr-2 pl-3",
              )}
            >
              <Skeleton className="h-4 w-16" />
            </th>
            <td
              className={cn(
                RETENTION_SIZE_COLUMN,
                "sticky left-[var(--retention-cohort-width)] z-30 border-r border-t bg-card px-2 py-2",
              )}
            >
              <Skeleton className="ml-auto h-4 w-9" />
            </td>
            {columns.map((index) => (
              <td
                key={index}
                className={cn(
                  RETENTION_PERIOD_COLUMN,
                  "border-t border-r p-1 align-middle",
                )}
              >
                <Skeleton className="h-8 w-full" />
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </OverlayScrollbar>
  );
});
const RetentionCell = memo(function RetentionCell({
  locale,
  labels,
  messages,
  cohort,
  cell,
}: {
  locale: Locale;
  labels: RetentionCopy;
  messages: AppMessages;
  cohort: RetentionCohortView;
  cell: RetentionCellView;
}) {
  const tooltipItems = cell.available
    ? [
        { label: messages.retention.cohortDate, value: cohort.label },
        { label: labels.sizeDetail, value: numberFormat(locale, cohort.size) },
        {
          label: labels.visitorsDetail,
          value: numberFormat(locale, cell.visitors),
        },
        {
          label: labels.rateDetail,
          value: percentFormat(locale, cell.rate),
        },
      ]
    : [{ label: labels.unavailableCell, value: "" }];
  const tooltip = cell.available
    ? tooltipItems.map((item) => `${item.label}: ${item.value}`).join("\n")
    : labels.unavailableCell;

  return (
    <td
      className={cn(
        RETENTION_PERIOD_COLUMN,
        "border-b border-r p-1 align-middle",
      )}
    >
      <AnalyticsDetailsTooltipTarget
        className="block"
        locale={locale}
        request={{
          key: `retention-cell:${cohort.bucket}:${cell.index}:${cell.available}`,
          items: tooltipItems,
        }}
      >
        {cell.available ? (
          <button
            type="button"
            className="flex h-8 w-full items-center justify-center font-mono text-[11px] tabular-nums outline-none ring-0 transition-transform hover:scale-[1.035] focus-visible:ring-2 focus-visible:ring-ring/70"
            style={retentionCellStyle(cell.rate, cell.available)}
            aria-label={tooltip}
          >
            {percentFormat(locale, cell.rate)}
          </button>
        ) : (
          <div
            className="h-8 w-full border border-dashed border-border/70 bg-muted/20"
            aria-label={tooltip}
          />
        )}
      </AnalyticsDetailsTooltipTarget>
    </td>
  );
});
const RetentionComparisonCell = memo(function RetentionComparisonCell({
  locale,
  labels,
  messages,
  current,
  comparison,
  currentCell,
  comparisonCell,
  currentTooltipDetail,
  comparisonTooltipDetail,
  comparisonLabel,
  tooltipKey,
}: {
  locale: Locale;
  labels: RetentionCopy;
  messages: AppMessages;
  current: RetentionCohortView | null;
  comparison: RetentionCohortView | null;
  currentCell: RetentionCellView;
  comparisonCell: RetentionCellView;
  currentTooltipDetail?: string;
  comparisonTooltipDetail?: string;
  comparisonLabel: string;
  tooltipKey: string;
}) {
  const currentLabel = messages.dashboardHeader.compareCurrentPeriod;
  const currentTooltipValue = currentCell.available
    ? (currentTooltipDetail ??
      `${messages.retention.cohortDate}: ${current?.label ?? "--"} · ${labels.sizeDetail}: ${numberFormat(locale, current?.size ?? 0)} · ${labels.visitorsDetail}: ${numberFormat(locale, currentCell.visitors)} · ${labels.rateDetail}: ${percentFormat(locale, currentCell.rate)}`)
    : labels.unavailableCell;
  const comparisonTooltipValue = comparisonCell.available
    ? (comparisonTooltipDetail ??
      `${messages.retention.cohortDate}: ${comparison?.label ?? "--"} · ${labels.sizeDetail}: ${numberFormat(locale, comparison?.size ?? 0)} · ${labels.visitorsDetail}: ${numberFormat(locale, comparisonCell.visitors)} · ${labels.rateDetail}: ${percentFormat(locale, comparisonCell.rate)}`)
    : labels.unavailableCell;
  const tooltipItems = [
    { label: currentLabel, value: currentTooltipValue },
    {
      label: comparisonLabel,
      value: comparisonTooltipValue,
    },
  ];
  const tooltip = tooltipItems
    .map((item) => `${item.label}: ${item.value}`)
    .join("\n");

  const renderBand = (
    cell: RetentionCellView,
    colorVariable: string,
    key: string,
  ) =>
    cell.available ? (
      <button
        key={key}
        type="button"
        className="flex h-full min-h-0 w-full flex-1 items-center justify-center font-mono text-[10px] tabular-nums outline-none ring-0 focus-visible:ring-2 focus-visible:ring-ring/70"
        style={retentionCellStyle(cell.rate, true, colorVariable)}
        aria-label={`${key === "current" ? currentLabel : comparisonLabel}: ${percentFormat(locale, cell.rate)}`}
      >
        {percentFormat(locale, cell.rate)}
      </button>
    ) : (
      <div
        key={key}
        className="h-full min-h-0 w-full flex-1 border border-dashed border-border/70 bg-muted/20"
        aria-label={labels.unavailableCell}
      />
    );

  return (
    <td
      className={cn(
        RETENTION_PERIOD_COLUMN,
        "relative border-b border-r p-0 align-middle",
      )}
    >
      <div className="absolute inset-1">
        <AnalyticsDetailsTooltipTarget
          className="block h-full"
          locale={locale}
          request={{
            key: tooltipKey,
            items: tooltipItems,
          }}
        >
          <div
            className="flex h-full flex-col gap-px transition-transform hover:scale-[1.035]"
            aria-label={tooltip}
          >
            {renderBand(currentCell, "var(--color-chart-4)", "current")}
            {renderBand(
              comparisonCell,
              "var(--color-compare-chart-4)",
              "comparison",
            )}
          </div>
        </AnalyticsDetailsTooltipTarget>
      </div>
    </td>
  );
});
export const RetentionMatrix = memo(function RetentionMatrix({
  locale,
  messages,
  labels,
  viewModel,
  comparisonViewModel,
  comparisonLabel,
  loading = false,
  loadingShape,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: RetentionCopy;
  viewModel: RetentionViewModel;
  comparisonViewModel?: RetentionComparisonViewModel | null;
  comparisonLabel?: string;
  loading?: boolean;
  loadingShape: RetentionLoadingShape;
}) {
  const columns = comparisonViewModel?.columns ?? viewModel.columns;
  const hasComparison = Boolean(comparisonViewModel);
  const resolvedComparisonLabel = comparisonLabel ?? "Comparison";
  const renderPairValue = (
    currentValue: number | null,
    comparisonValue: number | null,
  ) => (
    <div className="grid h-8 grid-rows-2 items-center text-right font-mono tabular-nums">
      <span className="truncate">
        {currentValue === null ? "--" : numberFormat(locale, currentValue)}
      </span>
      <span className="truncate text-muted-foreground">
        {comparisonValue === null
          ? "--"
          : numberFormat(locale, comparisonValue)}
      </span>
    </div>
  );

  return (
    <Card>
      <CardHeader className="gap-3 md:grid-cols-[1fr_auto]">
        <div className="space-y-1">
          <CardTitle className="inline-flex items-center gap-2">
            <RiRepeat2Line className="size-4" />
            {labels.matrixTitle}
          </CardTitle>
          <CardDescription>{labels.matrixSubtitle}</CardDescription>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11px] text-muted-foreground md:justify-self-end">
          {hasComparison ? (
            <>
              <span className="inline-flex items-center gap-1">
                <span className="size-2 bg-chart-4" aria-hidden="true" />
                {messages.dashboardHeader.compareCurrentPeriod}
              </span>
              <span className="inline-flex items-center gap-1">
                <span
                  className="size-2 bg-compare-chart-4"
                  aria-hidden="true"
                />
                {resolvedComparisonLabel}
              </span>
            </>
          ) : null}
          <span>{labels.legendLow}</span>
          <span
            aria-hidden="true"
            className="relative h-2 w-28 overflow-hidden border bg-muted"
          >
            <span
              className="absolute inset-y-0 right-0 w-[76%]"
              style={{
                background:
                  "linear-gradient(90deg, var(--color-muted) 0%, color-mix(in oklab, var(--color-chart-4) 16%, var(--color-muted)) 22%, color-mix(in oklab, var(--color-chart-4) 28%, var(--color-muted)) 46%, color-mix(in oklab, var(--color-chart-4) 42%, var(--color-muted)) 72%, color-mix(in oklab, var(--color-chart-4) 54%, var(--color-muted)) 100%)",
              }}
            />
          </span>
          <span>{labels.legendHigh}</span>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        <AutoTransition
          transitionKey={loading ? "loading" : "ready"}
          initial={false}
          duration={0.18}
          type="fade"
          presenceMode="wait"
        >
          {loading ? (
            <RetentionLoading shape={loadingShape} />
          ) : (
            <AnalyticsTimeTooltipProvider messages={messages}>
              <OverlayScrollbar className="pb-1">
                <table
                  className={cn(
                    RETENTION_TABLE_COLUMNS,
                    "w-max min-w-full table-fixed border-separate border-spacing-0 text-left text-xs",
                  )}
                >
                  <colgroup>
                    <col className={RETENTION_COHORT_COLUMN} />
                    <col className={RETENTION_SIZE_COLUMN} />
                    {columns.map((index) => (
                      <col key={index} className={RETENTION_PERIOD_COLUMN} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr>
                      <th
                        className={cn(
                          RETENTION_COHORT_COLUMN,
                          "sticky left-0 z-40 truncate border-b bg-card py-2 pr-2 pl-3 font-medium text-muted-foreground",
                        )}
                      >
                        {messages.retention.cohortDate}
                      </th>
                      <th
                        className={cn(
                          RETENTION_SIZE_COLUMN,
                          "sticky left-[var(--retention-cohort-width)] z-40 border-r border-b bg-card px-2 py-2 text-right font-medium whitespace-nowrap text-muted-foreground",
                        )}
                      >
                        {messages.retention.cohortSize}
                      </th>
                      {columns.map((index) => (
                        <th
                          key={index}
                          className={cn(
                            RETENTION_PERIOD_COLUMN,
                            "border-b px-1 py-2 text-center font-medium text-muted-foreground",
                          )}
                        >
                          <span className="inline-block w-16 truncate">
                            {periodLabel(messages, labels, index)}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {hasComparison && comparisonViewModel ? (
                      <>
                        <tr>
                          <th
                            className={cn(
                              RETENTION_COHORT_COLUMN,
                              "sticky left-0 z-30 truncate border-b bg-card py-2 pr-2 pl-3 font-medium text-muted-foreground",
                            )}
                          >
                            {labels.overallRetention}
                          </th>
                          <td
                            className={cn(
                              RETENTION_SIZE_COLUMN,
                              "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2 text-right font-mono whitespace-nowrap text-muted-foreground",
                            )}
                          >
                            {renderPairValue(
                              viewModel.summary.totalVisitors,
                              comparisonViewModel.comparison.summary
                                .totalVisitors,
                            )}
                          </td>
                          {columns.map((index) => {
                            const currentAverage = retentionAverageAt(
                              viewModel,
                              index,
                            );
                            const comparisonAverage = retentionAverageAt(
                              comparisonViewModel.comparison,
                              index,
                            );
                            return (
                              <RetentionComparisonCell
                                key={index}
                                locale={locale}
                                labels={labels}
                                messages={messages}
                                current={null}
                                comparison={null}
                                currentCell={{
                                  index,
                                  visitors: currentAverage.visitors,
                                  rate: currentAverage.rate ?? 0,
                                  available: currentAverage.rate !== null,
                                }}
                                comparisonCell={{
                                  index,
                                  visitors: comparisonAverage.visitors,
                                  rate: comparisonAverage.rate ?? 0,
                                  available: comparisonAverage.rate !== null,
                                }}
                                currentTooltipDetail={
                                  currentAverage.rate === null
                                    ? labels.unavailableCell
                                    : `${periodLabel(messages, labels, index)} · ${numberFormat(locale, currentAverage.visitors)} · ${percentFormat(locale, currentAverage.rate)}`
                                }
                                comparisonTooltipDetail={
                                  comparisonAverage.rate === null
                                    ? labels.unavailableCell
                                    : `${periodLabel(messages, labels, index)} · ${numberFormat(locale, comparisonAverage.visitors)} · ${percentFormat(locale, comparisonAverage.rate)}`
                                }
                                comparisonLabel={resolvedComparisonLabel}
                                tooltipKey={`retention-overall:${index}:${currentAverage.rate ?? "unavailable"}:${comparisonAverage.rate ?? "unavailable"}`}
                              />
                            );
                          })}
                        </tr>
                        {comparisonViewModel.rows.map((row) => (
                          <tr key={row.key} className="group">
                            <th
                              className={cn(
                                RETENTION_COHORT_COLUMN,
                                "sticky left-0 z-30 border-b bg-card py-2 pr-2 pl-3 font-mono font-medium group-hover:bg-muted",
                              )}
                            >
                              <div className="grid h-8 grid-rows-2 items-center overflow-hidden leading-4">
                                <span className="truncate">
                                  {row.current?.label ?? "--"}
                                </span>
                                <span className="truncate text-muted-foreground">
                                  {row.comparison?.label ?? "--"}
                                </span>
                              </div>
                            </th>
                            <td
                              className={cn(
                                RETENTION_SIZE_COLUMN,
                                "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap text-muted-foreground group-hover:bg-muted",
                              )}
                            >
                              {renderPairValue(
                                row.current?.size ?? null,
                                row.comparison?.size ?? null,
                              )}
                            </td>
                            {columns.map((index) => (
                              <RetentionComparisonCell
                                key={`${row.key}-${index}`}
                                locale={locale}
                                labels={labels}
                                messages={messages}
                                current={row.current}
                                comparison={row.comparison}
                                currentCell={retentionCellAt(
                                  row.current,
                                  index,
                                )}
                                comparisonCell={retentionCellAt(
                                  row.comparison,
                                  index,
                                )}
                                comparisonLabel={resolvedComparisonLabel}
                                tooltipKey={`retention-cell:${row.key}:${index}`}
                              />
                            ))}
                          </tr>
                        ))}
                      </>
                    ) : (
                      <>
                        <tr>
                          <th
                            className={cn(
                              RETENTION_COHORT_COLUMN,
                              "sticky left-0 z-30 truncate border-b bg-card py-2 pr-2 pl-3 font-medium text-muted-foreground",
                            )}
                          >
                            {labels.overallRetention}
                          </th>
                          <td
                            className={cn(
                              RETENTION_SIZE_COLUMN,
                              "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2 text-right font-mono whitespace-nowrap text-muted-foreground",
                            )}
                          >
                            {numberFormat(
                              locale,
                              viewModel.summary.totalVisitors,
                            )}
                          </td>
                          {viewModel.periodAverages.map((average) => {
                            const tooltipItems =
                              average.rate === null
                                ? [
                                    {
                                      label: periodLabel(
                                        messages,
                                        labels,
                                        average.index,
                                      ),
                                      value: labels.unavailableCell,
                                    },
                                  ]
                                : [
                                    {
                                      label: labels.overallRetention,
                                      value: periodLabel(
                                        messages,
                                        labels,
                                        average.index,
                                      ),
                                    },
                                    {
                                      label: labels.visitorsDetail,
                                      value: numberFormat(
                                        locale,
                                        average.visitors,
                                      ),
                                    },
                                    {
                                      label: labels.rateDetail,
                                      value: percentFormat(
                                        locale,
                                        average.rate,
                                      ),
                                    },
                                  ];
                            const tooltip = tooltipItems
                              .map((item) => `${item.label}: ${item.value}`)
                              .join("\n");
                            return (
                              <td
                                key={average.index}
                                className={cn(
                                  RETENTION_PERIOD_COLUMN,
                                  "border-b border-r p-1 align-middle",
                                )}
                              >
                                <AnalyticsDetailsTooltipTarget
                                  className="block"
                                  locale={locale}
                                  request={{
                                    key: `retention-overall:${average.index}:${average.rate ?? "unavailable"}`,
                                    items: tooltipItems,
                                  }}
                                >
                                  <button
                                    type="button"
                                    className={cn(
                                      "flex h-8 w-full items-center justify-center font-mono text-[11px] tabular-nums outline-none ring-0 transition-transform hover:scale-[1.035] focus-visible:ring-2 focus-visible:ring-ring/70",
                                      average.rate === null &&
                                        "text-muted-foreground",
                                    )}
                                    style={retentionCellStyle(
                                      average.rate ?? 0,
                                      average.rate !== null,
                                    )}
                                    aria-label={tooltip}
                                  >
                                    {average.rate === null
                                      ? "--"
                                      : percentFormat(locale, average.rate)}
                                  </button>
                                </AnalyticsDetailsTooltipTarget>
                              </td>
                            );
                          })}
                        </tr>
                        {viewModel.cohorts.map((cohort) => (
                          <tr key={cohort.bucket} className="group">
                            <th
                              className={cn(
                                RETENTION_COHORT_COLUMN,
                                "sticky left-0 z-30 truncate border-b bg-card py-2 pr-2 pl-3 font-mono font-medium group-hover:bg-muted",
                              )}
                            >
                              {cohort.label}
                            </th>
                            <td
                              className={cn(
                                RETENTION_SIZE_COLUMN,
                                "sticky left-[var(--retention-cohort-width)] z-30 border-r border-b bg-card px-2 py-2 text-right font-mono tabular-nums whitespace-nowrap text-muted-foreground group-hover:bg-muted",
                              )}
                            >
                              {numberFormat(locale, cohort.size)}
                            </td>
                            {cohort.cells.map((cell) => (
                              <RetentionCell
                                key={`${cohort.bucket}-${cell.index}`}
                                locale={locale}
                                labels={labels}
                                messages={messages}
                                cohort={cohort}
                                cell={cell}
                              />
                            ))}
                          </tr>
                        ))}
                      </>
                    )}
                  </tbody>
                </table>
              </OverlayScrollbar>
            </AnalyticsTimeTooltipProvider>
          )}
        </AutoTransition>
      </CardContent>
    </Card>
  );
});
