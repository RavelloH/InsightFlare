import { useMemo } from "react";
import { RiArrowDownLine, RiArrowUpLine } from "@remixicon/react";

import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Skeleton } from "@/components/ui/skeleton";
import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type {
  FunnelAnalysis,
  FunnelAnalysisStep,
  FunnelDefinition,
} from "@/lib/dashboard-api/client/edge";
import {
  analyticsFilterRegistry,
  parseFilterDsl,
} from "@/lib/filter-contract/index";
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
export function funnelComparisonChange(
  current?: number,
  comparison?: number,
): number | null {
  const currentValue = Number(current);
  const comparisonValue = Number(comparison);
  if (
    !Number.isFinite(currentValue) ||
    !Number.isFinite(comparisonValue) ||
    comparisonValue === 0
  ) {
    return null;
  }
  return ((currentValue - comparisonValue) / comparisonValue) * 100;
}
function formatChangeRate(value: number | null): string | null {
  if (value === null) return null;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}
function changeRateClass(value: number | null): string {
  if (value === null) return "text-muted-foreground";
  return value >= 0 ? "text-emerald-600" : "text-rose-600";
}
export function FunnelChangeRateInline({
  value,
}: {
  readonly value: number | null;
}) {
  if (value === null) return null;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={`inline-flex shrink-0 items-end gap-0.5 font-mono text-xs leading-none ${changeRateClass(value)}`}
    >
      <Icon className="size-3.5" />
      {formatChangeRate(value)}
    </span>
  );
}
function FunnelStepMetric({
  locale,
  label,
  value,
  comparisonChange,
  loading,
  comparisonLoading,
  hasComparison,
}: {
  readonly locale: Locale;
  readonly label: string;
  readonly value: number;
  readonly comparisonChange: number | null;
  readonly loading: boolean;
  readonly comparisonLoading: boolean;
  readonly hasComparison: boolean;
}) {
  const showComparison =
    hasComparison && (comparisonLoading || comparisonChange !== null);

  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <AutoResizer className="mt-1 min-w-0" duration={0.2}>
        <div className="min-w-0">
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : value}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="min-h-4"
          >
            {loading ? (
              <Skeleton key="loading" className="h-4 w-14" />
            ) : (
              <p key="ready" className="font-mono">
                {numberFormat(locale, value)}
              </p>
            )}
          </AutoTransition>
          {showComparison ? (
            <AutoTransition
              initial={false}
              transitionKey={
                comparisonLoading
                  ? "comparison-loading"
                  : String(comparisonChange)
              }
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="mt-1 min-h-4"
            >
              {comparisonLoading ? (
                <Skeleton key="comparison-loading" className="h-4 w-14" />
              ) : (
                <FunnelChangeRateInline
                  key="comparison-ready"
                  value={comparisonChange}
                />
              )}
            </AutoTransition>
          ) : null}
        </div>
      </AutoResizer>
    </div>
  );
}
export function FunnelVisualization({
  locale,
  labels,
  descriptionMessages,
  funnel,
  analysis,
  comparisonAnalysis,
  compact = false,
  loading = false,
  comparisonLoading = false,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["funnels"];
  readonly descriptionMessages: FunnelDescriptionMessages;
  readonly funnel: FunnelDefinition;
  readonly analysis?: FunnelAnalysis;
  readonly comparisonAnalysis?: FunnelAnalysis;
  readonly compact?: boolean;
  readonly loading?: boolean;
  readonly comparisonLoading?: boolean;
}) {
  const metric = funnelMetricKey(
    analysis?.progressionScope ?? funnel.progressionScope,
  );
  const secondaryMetric: FunnelMetricKey =
    metric === "sessions" ? "visitors" : "sessions";
  const convertedLabel = funnelConvertedLabel(labels, metric);
  const summary = analysis?.summary;
  const comparisonSummary = comparisonAnalysis?.summary;
  const comparisonStepsById = useMemo(
    () =>
      new Map(
        (comparisonAnalysis?.steps ?? []).map((step) => [step.stepId, step]),
      ),
    [comparisonAnalysis?.steps],
  );
  const hasComparison = comparisonLoading || Boolean(comparisonAnalysis);
  const overallComparisonChange = funnelComparisonChange(
    summary?.overallConversionRate,
    comparisonSummary?.overallConversionRate,
  );
  const convertedProgressions = summary?.convertedProgressions ?? 0;
  const totalProgressions = summary?.totalProgressions ?? 0;

  return (
    <div className={compact ? "min-w-0 space-y-4" : "min-w-0 space-y-5"}>
      {compact ? (
        <AutoResizer className="min-w-0" duration={0.2}>
          <AutoTransition
            initial={false}
            transitionKey={
              loading || !summary
                ? "loading"
                : `${summary.overallConversionRate}:${convertedProgressions}/${totalProgressions}`
            }
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="min-h-7"
          >
            {loading || !summary ? (
              <Skeleton key="loading" className="h-7 w-52 max-w-full" />
            ) : (
              <div
                key="ready"
                className="flex min-w-0 flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-muted-foreground"
              >
                <span className="inline-flex items-baseline gap-x-2">
                  <span className="font-mono text-xl font-semibold leading-7 text-foreground">
                    {percentFormat(locale, summary.overallConversionRate)}
                  </span>
                  <span>{labels.overallConversion}</span>
                </span>
                <span className="inline-flex items-baseline gap-x-2">
                  <span className="font-mono text-lg font-semibold leading-7 text-muted-foreground">
                    {numberFormat(locale, convertedProgressions)}/
                    {numberFormat(locale, totalProgressions)}
                  </span>
                  <span>{convertedLabel}</span>
                </span>
              </div>
            )}
          </AutoTransition>
          {hasComparison ? (
            <AutoTransition
              initial={false}
              transitionKey={
                comparisonLoading
                  ? "comparison-loading"
                  : String(overallComparisonChange)
              }
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="mt-1 min-h-4"
            >
              {comparisonLoading ? (
                <Skeleton key="comparison-loading" className="h-4 w-20" />
              ) : (
                <FunnelChangeRateInline
                  key="comparison-ready"
                  value={overallComparisonChange}
                />
              )}
            </AutoTransition>
          ) : null}
        </AutoResizer>
      ) : null}
      {funnel.steps.map((step, index) => {
        const result = analysis?.steps.find(
          (analysisStep) => analysisStep.stepId === step.id,
        );
        const comparisonResult = comparisonStepsById.get(step.id);
        const rate = result?.progression.conversionRate ?? 0;
        const barRate = Math.max(0, Math.min(1, rate));
        const comparisonRate =
          comparisonResult?.progression.conversionRate ?? 0;
        const comparisonBarRate = Math.max(0, Math.min(1, comparisonRate));
        const dropOffRate = Math.max(
          0,
          Math.min(1, result?.progression.dropOffRate ?? 0),
        );
        const dropOffLabel =
          index === 0 ? "—" : `-${percentFormat(locale, dropOffRate)}`;
        const primaryCount = result?.progression.count ?? 0;
        const secondaryCount = result
          ? funnelMetricValue(result, secondaryMetric)
          : 0;
        const comparisonPrimaryCount = comparisonResult?.progression.count ?? 0;
        const comparisonSecondaryCount = comparisonResult
          ? funnelMetricValue(comparisonResult, secondaryMetric)
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
                    <AutoTransition
                      initial={false}
                      transitionKey={loading ? "loading" : step.id}
                      duration={0.18}
                      type="fade"
                      presenceMode="wait"
                      className="h-5 min-w-0 flex-1"
                    >
                      {loading ? (
                        <Skeleton
                          key="loading"
                          className="h-5 w-[min(22rem,72%)]"
                        />
                      ) : (
                        <span
                          key="ready"
                          className={
                            compact
                              ? "block min-w-0 truncate font-medium"
                              : "block min-w-0 break-words font-medium"
                          }
                        >
                          {funnelStepLabel(step, descriptionMessages)}
                        </span>
                      )}
                    </AutoTransition>
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
                        className="shrink-0 pt-0.5 font-mono text-xs font-medium text-muted-foreground"
                      >
                        {dropOffLabel}
                      </span>
                    )}
                  </AutoTransition>
                </div>
                <div className={hasComparison ? "space-y-1" : undefined}>
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
                  {hasComparison ? (
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
                      className="relative h-1 overflow-hidden bg-muted"
                    >
                      {comparisonLoading ? (
                        <Skeleton
                          key="comparison-loading"
                          className="h-full w-full rounded-none"
                        />
                      ) : !comparisonResult ? (
                        <div
                          key="comparison-empty"
                          className="h-full w-0"
                          aria-hidden="true"
                        />
                      ) : (
                        <div
                          key="comparison-ready"
                          className="h-full bg-amber-500/80 transition-[width] motion-reduce:transition-none dark:bg-amber-300/80"
                          style={{
                            width:
                              comparisonBarRate <= 0
                                ? "0%"
                                : `${Math.max(2, comparisonBarRate * 100)}%`,
                          }}
                        />
                      )}
                    </AutoTransition>
                  ) : null}
                </div>
                {!compact && result ? (
                  <div className="grid min-w-0 gap-3 text-xs sm:grid-cols-3">
                    <FunnelStepMetric
                      locale={locale}
                      label={funnelMetricLabel(labels, metric)}
                      value={primaryCount}
                      comparisonChange={funnelComparisonChange(
                        primaryCount,
                        comparisonPrimaryCount,
                      )}
                      loading={loading}
                      comparisonLoading={comparisonLoading}
                      hasComparison={hasComparison}
                    />
                    <FunnelStepMetric
                      locale={locale}
                      label={funnelMetricLabel(labels, secondaryMetric)}
                      value={secondaryCount}
                      comparisonChange={funnelComparisonChange(
                        secondaryCount,
                        comparisonSecondaryCount,
                      )}
                      loading={loading}
                      comparisonLoading={comparisonLoading}
                      hasComparison={hasComparison}
                    />
                    <FunnelStepMetric
                      locale={locale}
                      label={labels.dropOff}
                      value={result.progression.dropOffCount}
                      comparisonChange={funnelComparisonChange(
                        result.progression.dropOffCount,
                        comparisonResult?.progression.dropOffCount,
                      )}
                      loading={loading}
                      comparisonLoading={comparisonLoading}
                      hasComparison={hasComparison}
                    />
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
