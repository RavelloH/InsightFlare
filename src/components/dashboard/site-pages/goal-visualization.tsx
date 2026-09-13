import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { GoalSummary } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function changeRateClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-600" : "text-rose-600";
}

function conversionRateChange(
  current?: GoalSummary["sessions"],
  comparison?: GoalSummary["sessions"],
): number | null {
  const currentRate = Number(current?.conversionRate);
  const comparisonRate = Number(comparison?.conversionRate);
  if (
    !Number.isFinite(currentRate) ||
    !Number.isFinite(comparisonRate) ||
    comparisonRate === 0
  ) {
    return null;
  }
  return ((currentRate - comparisonRate) / comparisonRate) * 100;
}

function ChangeRateInline({ value }: { readonly value: number | null }) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value)}`}
    >
      <Icon className="size-3.5" />
      {formatChangeRate(value)}
    </span>
  );
}

function Metric({
  label,
  metric,
  comparisonMetric,
  locale,
  loading,
  comparisonLoading,
}: {
  readonly label: string;
  readonly metric?: GoalSummary["sessions"];
  readonly comparisonMetric?: GoalSummary["sessions"];
  readonly locale: Locale;
  readonly loading: boolean;
  readonly comparisonLoading: boolean;
}) {
  const comparisonChange = conversionRateChange(metric, comparisonMetric);
  const comparisonContent = comparisonLoading ? (
    <Skeleton className="h-4 w-28 max-w-full" />
  ) : comparisonMetric && comparisonChange !== null ? (
    <ChangeRateInline value={comparisonChange} />
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
            transitionKey={
              loading
                ? "loading"
                : `${metric?.conversionRate ?? 0}:${metric?.converted ?? 0}:${metric?.total ?? 0}`
            }
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
                  {percentFormat(locale, metric?.conversionRate ?? 0)}
                </span>
                <span aria-hidden="true" className="text-muted-foreground">
                  ·
                </span>
                <span className="font-mono text-lg font-semibold text-muted-foreground">
                  {numberFormat(locale, metric?.converted ?? 0)}
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    / {numberFormat(locale, metric?.total ?? 0)}
                  </span>
                </span>
              </div>
            )}
          </AutoTransition>
          {comparisonContent ? (
            <AutoTransition
              initial={false}
              transitionKey={
                comparisonLoading
                  ? "comparison-loading"
                  : `${comparisonMetric?.conversionRate ?? 0}:${comparisonMetric?.converted ?? 0}:${comparisonMetric?.total ?? 0}`
              }
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
  metric,
  comparisonMetric,
  locale,
  labels,
  loading,
  comparisonLoading,
}: {
  readonly metric?: GoalSummary["visitors"];
  readonly comparisonMetric?: GoalSummary["visitors"];
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly loading: boolean;
  readonly comparisonLoading: boolean;
}) {
  const rate = Number.isFinite(metric?.conversionRate)
    ? Math.min(1, Math.max(0, metric?.conversionRate ?? 0))
    : 0;
  const comparisonRate = Number.isFinite(comparisonMetric?.conversionRate)
    ? Math.min(1, Math.max(0, comparisonMetric?.conversionRate ?? 0))
    : 0;
  const showComparison = comparisonLoading || Boolean(comparisonMetric);

  return (
    <div className="mt-5 min-w-0">
      <AutoResizer className="min-w-0" duration={0.2}>
        <div className="border-t pt-4">
          <div className="space-y-1.5">
            <div className="h-6 w-full">
              <AutoTransition
                initial={false}
                transitionKey={loading ? "loading" : String(rate)}
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
                    aria-label={`${labels.visitors} ${labels.conversion}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={rate * 100}
                    aria-valuetext={percentFormat(locale, rate)}
                  >
                    <div
                      className="h-full bg-primary transition-[width] motion-reduce:transition-none"
                      style={{ width: `${(rate * 100).toFixed(2)}%` }}
                    />
                  </div>
                )}
              </AutoTransition>
            </div>
            {showComparison ? (
              <div className="h-1 w-full">
                <AutoTransition
                  initial={false}
                  transitionKey={
                    comparisonLoading
                      ? "comparison-loading"
                      : String(comparisonRate)
                  }
                  duration={0.18}
                  type="fade"
                  presenceMode="wait"
                  className="h-full w-full overflow-hidden bg-muted ring-1 ring-border/50"
                >
                  {comparisonLoading ? (
                    <Skeleton
                      key="comparison-loading"
                      className="h-full w-full rounded-none"
                    />
                  ) : (
                    <div
                      key="comparison-ready"
                      className="h-full"
                      role="progressbar"
                      aria-label={`${labels.visitors} ${labels.conversion} comparison`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={comparisonRate * 100}
                      aria-valuetext={percentFormat(locale, comparisonRate)}
                    >
                      <div
                        className="h-full bg-amber-500/80 transition-[width] motion-reduce:transition-none dark:bg-amber-300/80"
                        style={{
                          width: `${(comparisonRate * 100).toFixed(2)}%`,
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
  summary,
  comparisonSummary,
  locale,
  labels,
  loading = false,
  comparisonLoading = false,
}: {
  readonly summary?: GoalSummary;
  readonly comparisonSummary?: GoalSummary;
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly loading?: boolean;
  readonly comparisonLoading?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="grid min-w-0 grid-cols-2 gap-4">
        <Metric
          label={labels.visitors}
          metric={summary?.visitors}
          comparisonMetric={comparisonSummary?.visitors}
          locale={locale}
          loading={loading}
          comparisonLoading={comparisonLoading}
        />
        <Metric
          label={labels.sessions}
          metric={summary?.sessions}
          comparisonMetric={comparisonSummary?.sessions}
          locale={locale}
          loading={loading}
          comparisonLoading={comparisonLoading}
        />
      </div>
      <VisitorConversionBar
        metric={summary?.visitors}
        comparisonMetric={comparisonSummary?.visitors}
        locale={locale}
        labels={labels}
        loading={loading}
        comparisonLoading={comparisonLoading}
      />
    </div>
  );
}
