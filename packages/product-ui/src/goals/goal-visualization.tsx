import { AutoResizer } from "@insightflare/ui/auto-resizer";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Skeleton } from "@insightflare/ui/skeleton";
import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";

export interface GoalMetricComparisonDisplay {
  readonly direction: "up" | "down";
  readonly text: string;
}

export interface GoalMetricDisplay {
  readonly label: string;
  readonly conversionRate: string;
  readonly convertedCount: string;
  readonly totalCount: string;
  readonly loading: boolean;
  readonly transitionKey: string;
  readonly comparison: {
    readonly loading: boolean;
    readonly transitionKey: string;
    readonly change: GoalMetricComparisonDisplay | null;
  } | null;
}

export interface GoalConversionProgressDisplay {
  readonly label: string;
  readonly value: number;
  readonly valueText: string;
  readonly loading: boolean;
  readonly transitionKey: string;
  readonly comparison: {
    readonly label: string;
    readonly value: number;
    readonly valueText: string;
    readonly loading: boolean;
    readonly transitionKey: string;
  } | null;
}

/** Props-only rendering contract for the goal summary visualization. */
export interface GoalVisualizationProps {
  readonly visitors: GoalMetricDisplay;
  readonly sessions: GoalMetricDisplay;
  readonly visitorConversion: GoalConversionProgressDisplay;
}

function ChangeRateInline({
  change,
}: {
  readonly change: GoalMetricComparisonDisplay;
}) {
  const Icon = change.direction === "up" ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${change.direction === "up" ? "text-emerald-600" : "text-rose-600"}`}
    >
      <Icon className="size-3.5" />
      {change.text}
    </span>
  );
}

function Metric({
  label,
  conversionRate,
  convertedCount,
  totalCount,
  loading,
  transitionKey,
  comparison,
}: GoalMetricDisplay) {
  const comparisonContent = comparison?.loading ? (
    <Skeleton className="h-4 w-28 max-w-full" />
  ) : comparison?.change ? (
    <ChangeRateInline change={comparison.change} />
  ) : null;

  return (
    <div className="min-w-0 space-y-1 border-l pl-3 first:border-l-0 first:pl-0">
      <p className="truncate text-[11px] uppercase text-muted-foreground">
        {label}
      </p>
      <AutoResizer className="min-w-0" duration={0.2}>
        <div className="min-w-0">
          <AutoTransition
            initial={false}
            transitionKey={transitionKey}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="min-h-7"
          >
            {loading ? (
              <Skeleton key="loading" className="h-7 w-36 max-w-full" />
            ) : (
              <div
                key="ready"
                className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
              >
                <span className="font-mono text-xl font-semibold leading-7 text-foreground">
                  {conversionRate}
                </span>
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span className="font-mono text-lg font-semibold text-muted-foreground">
                  {convertedCount}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    / {totalCount}
                  </span>
                </span>
              </div>
            )}
          </AutoTransition>
          {comparisonContent ? (
            <AutoTransition
              initial={false}
              transitionKey={comparison?.transitionKey}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="mt-1 min-h-4"
            >
              <div key="comparison">{comparisonContent}</div>
            </AutoTransition>
          ) : null}
        </div>
      </AutoResizer>
    </div>
  );
}

function VisitorConversionBar({
  label,
  value,
  valueText,
  loading,
  transitionKey,
  comparison,
}: GoalConversionProgressDisplay) {
  return (
    <div className="mt-5 min-w-0">
      <AutoResizer className="min-w-0" duration={0.2}>
        <div className="border-t pt-4">
          <div className="space-y-1.5">
            <div className="h-6 w-full">
              <AutoTransition
                initial={false}
                transitionKey={transitionKey}
                duration={0.18}
                type="fade"
                presenceMode="wait"
                className="h-full w-full overflow-hidden bg-muted ring-1 ring-border/50"
              >
                {loading ? (
                  <Skeleton
                    key="loading"
                    className="h-full w-full rounded-none"
                  />
                ) : (
                  <div
                    key="ready"
                    className="h-full"
                    role="progressbar"
                    aria-label={label}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={value}
                    aria-valuetext={valueText}
                  >
                    <div
                      className="h-full bg-primary transition-[width] motion-reduce:transition-none"
                      style={{ width: `${value.toFixed(2)}%` }}
                    />
                  </div>
                )}
              </AutoTransition>
            </div>
            {comparison ? (
              <div className="h-1 w-full">
                <AutoTransition
                  initial={false}
                  transitionKey={comparison.transitionKey}
                  duration={0.18}
                  type="fade"
                  presenceMode="wait"
                  className="h-full overflow-hidden bg-muted ring-1 ring-border/50"
                >
                  {comparison.loading ? (
                    <Skeleton
                      key="comparison-loading"
                      className="h-full w-full rounded-none"
                    />
                  ) : (
                    <div
                      key="comparison-ready"
                      className="h-full"
                      role="progressbar"
                      aria-label={comparison.label}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={comparison.value}
                      aria-valuetext={comparison.valueText}
                    >
                      <div
                        className="h-full bg-amber-500/80 transition-[width] motion-reduce:transition-none dark:bg-amber-300/80"
                        style={{
                          width: `${comparison.value.toFixed(2)}%`,
                        }}
                      />
                    </div>
                  )}
                </AutoTransition>
              </div>
            ) : null}
          </div>
        </div>
      </AutoResizer>
    </div>
  );
}

export function GoalVisualization({
  visitors,
  sessions,
  visitorConversion,
}: GoalVisualizationProps) {
  return (
    <div className="min-w-0">
      <div className="grid min-w-0 grid-cols-2 gap-4">
        <Metric {...visitors} />
        <Metric {...sessions} />
      </div>
      <VisitorConversionBar {...visitorConversion} />
    </div>
  );
}
