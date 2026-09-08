import { AutoTransition } from "@/components/ui/auto-transition";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { GoalSummary } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

function Metric({
  label,
  metric,
  locale,
  loading,
}: {
  readonly label: string;
  readonly metric?: GoalSummary["sessions"];
  readonly locale: Locale;
  readonly loading: boolean;
}) {
  return (
    <div className="min-w-0 space-y-1 border-l pl-3 first:border-l-0 first:pl-0">
      <p className="truncate text-[11px] uppercase text-muted-foreground">
        {label}
      </p>
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
    </div>
  );
}

function VisitorConversionBar({
  metric,
  locale,
  labels,
  loading,
}: {
  readonly metric?: GoalSummary["visitors"];
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly loading: boolean;
}) {
  const rate = Number.isFinite(metric?.conversionRate)
    ? Math.min(1, Math.max(0, metric?.conversionRate ?? 0))
    : 0;

  return (
    <div className="mt-5 border-t pt-4">
      <AutoTransition
        initial={false}
        transitionKey={loading ? "loading" : String(rate)}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="h-6 w-full overflow-hidden bg-muted ring-1 ring-border/50"
      >
        {loading ? (
          <Skeleton key="loading" className="h-full w-full rounded-none" />
        ) : (
          <div
            key="ready"
            className="h-full bg-primary transition-[width] motion-reduce:transition-none"
            role="progressbar"
            aria-label={`${labels.visitors} ${labels.conversion}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={rate * 100}
            aria-valuetext={percentFormat(locale, rate)}
            style={{ width: `${(rate * 100).toFixed(2)}%` }}
          />
        )}
      </AutoTransition>
    </div>
  );
}

export function GoalVisualization({
  summary,
  locale,
  labels,
  loading = false,
}: {
  readonly summary?: GoalSummary;
  readonly locale: Locale;
  readonly labels: AppMessages["goals"];
  readonly loading?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="grid min-w-0 grid-cols-2 gap-4">
        <Metric
          label={labels.visitors}
          metric={summary?.visitors}
          locale={locale}
          loading={loading}
        />
        <Metric
          label={labels.sessions}
          metric={summary?.sessions}
          locale={locale}
          loading={loading}
        />
      </div>
      <VisitorConversionBar
        metric={summary?.visitors}
        locale={locale}
        labels={labels}
        loading={loading}
      />
    </div>
  );
}
