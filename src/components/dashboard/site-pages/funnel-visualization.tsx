import { AutoTransition } from "@/components/ui/auto-transition";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type {
  FunnelAnalysis,
  FunnelAnalysisStep,
  FunnelDefinition,
} from "@/lib/edge-client";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

export type FunnelDescriptionMessages = Pick<
  AppMessages,
  "conditionDescription" | "filterBuilder"
>;

export type FunnelMetricKey = "sessions" | "visitors";

export function funnelMetricKey(
  scope: FunnelDefinition["progressionScope"],
): FunnelMetricKey {
  return scope === "visitor" ? "visitors" : "sessions";
}

export function funnelMetricValue(
  step: Pick<FunnelAnalysisStep, "sessions" | "visitors" | "progression">,
  metric: FunnelMetricKey,
): number {
  return metric === "sessions" ? step.sessions : step.visitors;
}

export function funnelMetricLabel(
  labels: AppMessages["funnels"],
  metric: FunnelMetricKey,
): string {
  return metric === "sessions" ? labels.sessions : labels.visitors;
}

export function funnelStartingLabel(
  labels: AppMessages["funnels"],
  metric: FunnelMetricKey,
): string {
  return metric === "sessions"
    ? labels.startedSessions
    : labels.startedVisitors;
}

export function funnelConvertedLabel(
  labels: AppMessages["funnels"],
  metric: FunnelMetricKey,
): string {
  return metric === "sessions"
    ? labels.convertedSessions
    : labels.convertedVisitors;
}

export function funnelStepLabel(
  step: FunnelDefinition["steps"][number],
  messages: FunnelDescriptionMessages,
): string {
  const configuredName = step.name?.trim();
  if (configuredName) return configuredName;

  try {
    const document = parseFilterDsl(step.filterDsl, analyticsFilterRegistry);
    const description = describeFilterExpression(
      document.root,
      analyticsFilterRegistry,
      messages,
    );
    return description || step.filterDsl;
  } catch {
    return step.filterDsl;
  }
}

export function FunnelVisualization({
  locale,
  labels,
  descriptionMessages,
  funnel,
  analysis,
  compact = false,
  loading = false,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["funnels"];
  readonly descriptionMessages: FunnelDescriptionMessages;
  readonly funnel: FunnelDefinition;
  readonly analysis?: FunnelAnalysis;
  readonly compact?: boolean;
  readonly loading?: boolean;
}) {
  const metric = funnelMetricKey(
    analysis?.progressionScope ?? funnel.progressionScope,
  );
  const secondaryMetric: FunnelMetricKey =
    metric === "sessions" ? "visitors" : "sessions";
  const convertedLabel = funnelConvertedLabel(labels, metric);
  const summary = analysis?.summary;
  const convertedProgressions = summary?.convertedProgressions ?? 0;
  const totalProgressions = summary?.totalProgressions ?? 0;
  const largestDropOffRate = analysis
    ? analysis.steps.reduce(
        (largest, step, index) =>
          index === 0
            ? largest
            : Math.max(largest, step.progression.dropOffRate),
        0,
      )
    : 0;

  return (
    <div className={compact ? "min-w-0 space-y-4" : "min-w-0 space-y-5"}>
      {compact ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-baseline gap-x-2">
            <AutoTransition
              initial={false}
              transitionKey={
                loading ? "loading" : summary?.overallConversionRate
              }
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="inline-flex h-7 items-center"
            >
              {loading || !summary ? (
                <Skeleton key="loading" className="h-7 w-16" />
              ) : (
                <span
                  key="ready"
                  className="font-mono text-xl font-semibold leading-7 text-foreground"
                >
                  {percentFormat(locale, summary.overallConversionRate)}
                </span>
              )}
            </AutoTransition>
            <span>{labels.overallConversion}</span>
          </span>
          <span className="inline-flex items-baseline gap-x-2">
            <AutoTransition
              initial={false}
              transitionKey={
                loading
                  ? "loading"
                  : `${convertedProgressions}/${totalProgressions}`
              }
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="inline-flex h-7 items-center"
            >
              {loading || !summary ? (
                <Skeleton key="loading" className="h-7 w-24" />
              ) : (
                <span
                  key="ready"
                  className="font-mono text-lg font-semibold leading-7 text-muted-foreground"
                >
                  {numberFormat(locale, convertedProgressions)}/
                  {numberFormat(locale, totalProgressions)}
                </span>
              )}
            </AutoTransition>
            <span>{convertedLabel}</span>
          </span>
        </div>
      ) : null}
      {funnel.steps.map((step, index) => {
        const result = analysis?.steps[index];
        const rate = result?.progression.conversionRate ?? 0;
        const barRate = Math.max(0, Math.min(1, rate));
        const dropOffRate = Math.max(
          0,
          Math.min(1, result?.progression.dropOffRate ?? 0),
        );
        const dropOffLabel =
          index === 0 ? "—" : `-${percentFormat(locale, dropOffRate)}`;
        const isLargestDropOff =
          index > 0 && dropOffRate > 0 && dropOffRate === largestDropOffRate;
        const primaryCount = result?.progression.count ?? 0;
        const secondaryCount = result
          ? funnelMetricValue(result, secondaryMetric)
          : 0;
        return (
          <div key={step.id} className="min-w-0 space-y-2">
            <div
              className={
                compact
                  ? "grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-2 text-sm"
                  : "flex min-w-0 items-start gap-2 text-sm"
              }
            >
              <span
                className={
                  compact
                    ? "flex h-full items-center justify-center pt-0.5 font-mono text-2xl font-semibold leading-none tracking-tight text-muted-foreground tabular-nums"
                    : "shrink-0 font-mono text-muted-foreground"
                }
              >
                {numberFormat(locale, index + 1)}
              </span>
              <div className={compact ? "min-w-0 space-y-2" : "min-w-0 flex-1"}>
                <div className="flex min-w-0 items-start gap-2">
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span
                      className={
                        compact
                          ? "min-w-0 flex-1 truncate font-medium"
                          : "min-w-0 flex-1 break-words font-medium"
                      }
                    >
                      {funnelStepLabel(step, descriptionMessages)}
                    </span>
                    {compact && isLargestDropOff ? (
                      <Badge variant="secondary">
                        {labels.largestDropOffStep}
                      </Badge>
                    ) : null}
                  </div>
                  <AutoTransition
                    initial={false}
                    transitionKey={loading ? "loading" : rate}
                    duration={0.18}
                    type="fade"
                    presenceMode="wait"
                    className="h-5 shrink-0"
                  >
                    {loading ? (
                      <Skeleton key="loading" className="h-5 w-16" />
                    ) : (
                      <span
                        key="ready"
                        className={`shrink-0 pt-0.5 font-mono text-xs text-muted-foreground ${isLargestDropOff ? "font-bold" : "font-medium"}`}
                      >
                        {dropOffLabel}
                      </span>
                    )}
                  </AutoTransition>
                </div>
                <div className="relative h-4 overflow-hidden bg-muted">
                  <AutoTransition
                    initial={false}
                    transitionKey={loading ? "loading" : rate}
                    duration={0.18}
                    type="fade"
                    presenceMode="wait"
                    className="absolute inset-0"
                  >
                    {loading ? (
                      <Skeleton key="loading" className="h-full w-full" />
                    ) : (
                      <div key="ready" className="relative h-full w-full">
                        <div
                          className="absolute inset-y-0 left-0 bg-primary transition-[width] motion-reduce:transition-none"
                          style={{
                            width:
                              barRate <= 0
                                ? "0%"
                                : `${Math.max(2, barRate * 100)}%`,
                          }}
                        />
                        <span
                          className="absolute inset-y-0 flex items-center whitespace-nowrap pl-1 font-mono text-[11px] font-medium leading-none text-muted-foreground"
                          style={{
                            left: `${barRate * 100}%`,
                            transform: "translateX(0.375rem)",
                          }}
                        >
                          {percentFormat(locale, barRate)}
                        </span>
                      </div>
                    )}
                  </AutoTransition>
                </div>
                {!compact && result ? (
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {funnelMetricLabel(labels, metric)}:{" "}
                      {numberFormat(locale, primaryCount)}
                    </span>
                    <span>
                      {funnelMetricLabel(labels, secondaryMetric)}:{" "}
                      {numberFormat(locale, secondaryCount)}
                    </span>
                    <span>
                      {labels.dropOff}:{" "}
                      {numberFormat(locale, result.progression.dropOffCount)}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
