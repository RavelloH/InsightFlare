import { useEffect, useState } from "react";
import {
  RiArrowRightLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFileList3Line,
} from "@remixicon/react";

import { AnalysisJourneyTable } from "@/components/dashboard/site-pages/journeys/analysis-journey-table";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  intlLocale,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  FunnelAnalysis,
  FunnelAnalysisStep,
  FunnelDefinition,
  FunnelDetailData,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import { type AppMessages, getMessages } from "@/lib/i18n/messages";

import {
  FunnelChangeRateInline,
  funnelComparisonChange,
  funnelConvertedLabel,
  type FunnelDescriptionMessages,
  funnelMetricKey,
  funnelMetricLabel,
  funnelMetricValue,
  funnelStartingLabel,
  funnelStepLabel,
} from "./funnel-visualization";
function updatedLabel(
  locale: Locale,
  labels: AppMessages["funnels"],
  timestampSeconds: number,
): string {
  const date = new Date(timestampSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return labels.updated;
  return `${labels.updated} ${new Intl.DateTimeFormat(intlLocale(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date)}`;
}
function FunnelMetric({
  label,
  value,
  detail,
  comparisonLabel,
  comparisonDetail,
  comparisonChange = null,
  comparisonLoading = false,
  loading = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly comparisonLabel?: string;
  readonly comparisonDetail?: string;
  readonly comparisonChange?: number | null;
  readonly comparisonLoading?: boolean;
  readonly loading?: boolean;
}) {
  const showComparison = Boolean(
    comparisonLabel &&
    (comparisonLoading ||
      (comparisonDetail !== undefined && comparisonDetail !== null)),
  );
  const valueTransitionKey = loading
    ? "loading"
    : `${value}:${showComparison ? (comparisonChange ?? "") : ""}`;

  return (
    <div className="min-w-0 bg-card p-4">
      <p className="truncate text-[11px] uppercase text-muted-foreground">
        {label}
      </p>
      <AutoTransition
        initial={false}
        transitionKey={valueTransitionKey}
        duration={0.18}
        type="fade"
        presenceMode="wait"
        className="mt-3 h-7"
      >
        {loading ? (
          <Skeleton key="loading" className="h-7 w-20" />
        ) : (
          <div
            key="ready"
            className="flex min-w-0 items-end gap-1.5 leading-none"
          >
            <span className="min-w-0 truncate font-mono text-xl font-semibold leading-none">
              {value}
            </span>
            {showComparison ? (
              <FunnelChangeRateInline value={comparisonChange} />
            ) : null}
          </div>
        )}
      </AutoTransition>
      <AutoResizer className="mt-3 min-w-0" duration={0.2}>
        <AutoTransition
          initial={false}
          transitionKey={
            loading
              ? "loading"
              : showComparison
                ? `comparison:${comparisonDetail}:${comparisonChange ?? ""}`
                : `current:${detail}`
          }
          duration={0.18}
          type="fade"
          presenceMode="wait"
          className="min-h-4"
        >
          {loading || (showComparison && comparisonLoading) ? (
            <Skeleton key="loading" className="h-3 w-32" />
          ) : showComparison ? (
            <p
              key="comparison"
              className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <span className="min-w-0 truncate">
                {comparisonLabel}: {comparisonDetail}
              </span>
            </p>
          ) : (
            <p
              key="detail"
              className="truncate text-[11px] text-muted-foreground"
            >
              {detail}
            </p>
          )}
        </AutoTransition>
      </AutoResizer>
    </div>
  );
}
function FunnelStepValue({
  value,
  comparisonChange,
  loading,
  comparisonLoading,
  hasComparison,
}: {
  readonly value: string;
  readonly comparisonChange: number | null;
  readonly loading: boolean;
  readonly comparisonLoading: boolean;
  readonly hasComparison: boolean;
}) {
  const showComparison =
    hasComparison && (comparisonLoading || comparisonChange !== null);

  return (
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
              {value}
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
  );
}
function FunnelStepRow({
  locale,
  labels,
  descriptionMessages,
  funnelStep,
  analysisStep,
  comparisonAnalysisStep,
  index,
  metric,
  loading = false,
  comparisonLoading = false,
  selected = false,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["funnels"];
  readonly descriptionMessages: FunnelDescriptionMessages;
  readonly funnelStep: FunnelDefinition["steps"][number];
  readonly analysisStep?: FunnelAnalysisStep;
  readonly comparisonAnalysisStep?: FunnelAnalysisStep;
  readonly index: number;
  readonly metric: "sessions" | "visitors";
  readonly loading?: boolean;
  readonly comparisonLoading?: boolean;
  readonly selected?: boolean;
}) {
  const stepRate = analysisStep?.progression.stepConversionRate ?? 0;
  const conversionRate = analysisStep?.progression.conversionRate ?? 0;
  const dropOffCount = analysisStep?.progression.dropOffCount ?? 0;
  const secondaryMetric = metric === "sessions" ? "visitors" : "sessions";
  const primaryCount = analysisStep?.progression.count ?? 0;
  const secondaryCount = analysisStep
    ? funnelMetricValue(analysisStep, secondaryMetric)
    : 0;
  const comparisonPrimaryCount = comparisonAnalysisStep
    ? funnelMetricValue(comparisonAnalysisStep, metric)
    : undefined;
  const comparisonSecondaryCount = comparisonAnalysisStep
    ? funnelMetricValue(comparisonAnalysisStep, secondaryMetric)
    : undefined;
  const comparisonStepRate =
    comparisonAnalysisStep?.progression.stepConversionRate;
  const comparisonDropOffCount =
    comparisonAnalysisStep?.progression.dropOffCount;
  const width =
    conversionRate <= 0
      ? "0%"
      : `${Math.max(2, Math.min(100, conversionRate * 100))}%`;
  const comparisonConversionRate =
    comparisonAnalysisStep?.progression.conversionRate ?? 0;
  const comparisonWidth =
    comparisonConversionRate <= 0
      ? "0%"
      : `${Math.max(2, Math.min(100, comparisonConversionRate * 100))}%`;
  const hasComparison = comparisonLoading || Boolean(comparisonAnalysisStep);

  return (
    <div
      className={`block w-full min-w-0 border-b last:border-b-0 ${selected ? "bg-muted/50" : ""}`}
      aria-current={selected ? "step" : undefined}
    >
      <div className="flex min-w-0 gap-3 p-4">
        <div className="flex aspect-square min-h-8 shrink-0 self-stretch items-center justify-center border bg-muted/40 font-mono text-xs text-muted-foreground">
          {numberFormat(locale, index + 1)}
        </div>
        <div className="grid min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_11rem_11rem]">
          <div className="min-w-0 space-y-2">
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : funnelStep.id}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-5 min-w-0"
            >
              {loading ? (
                <Skeleton key="loading" className="h-5 w-[min(22rem,72%)]" />
              ) : (
                <div
                  key="ready"
                  className="flex min-w-0 flex-wrap items-center gap-2"
                >
                  <span className="min-w-0 break-words font-medium">
                    {funnelStepLabel(funnelStep, descriptionMessages)}
                  </span>
                </div>
              )}
            </AutoTransition>
            <AutoResizer className="min-w-0" duration={0.2}>
              <div className={hasComparison ? "space-y-1" : undefined}>
                <AutoTransition
                  initial={false}
                  transitionKey={loading ? "loading" : width}
                  duration={0.18}
                  type="fade"
                  presenceMode="wait"
                  className="h-3 overflow-hidden bg-muted"
                >
                  {loading ? (
                    <Skeleton key="loading" className="h-full w-full" />
                  ) : (
                    <div
                      key="ready"
                      className="h-full bg-primary transition-[width] motion-reduce:transition-none"
                      style={{ width }}
                    />
                  )}
                </AutoTransition>
                {hasComparison ? (
                  <AutoTransition
                    initial={false}
                    transitionKey={
                      comparisonLoading
                        ? "comparison-loading"
                        : comparisonConversionRate
                    }
                    duration={0.18}
                    type="fade"
                    presenceMode="wait"
                    className="h-1 overflow-hidden bg-muted"
                  >
                    {comparisonLoading ? (
                      <Skeleton
                        key="comparison-loading"
                        className="h-full w-full rounded-none"
                      />
                    ) : comparisonAnalysisStep ? (
                      <div
                        key="comparison-ready"
                        className="h-full bg-amber-500/80 transition-[width] motion-reduce:transition-none dark:bg-amber-300/80"
                        style={{ width: comparisonWidth }}
                      />
                    ) : (
                      <div
                        key="comparison-empty"
                        className="h-full w-0"
                        aria-hidden="true"
                      />
                    )}
                  </AutoTransition>
                ) : null}
              </div>
            </AutoResizer>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground">
                {funnelMetricLabel(labels, metric)}
              </p>
              <FunnelStepValue
                value={numberFormat(locale, primaryCount)}
                comparisonChange={funnelComparisonChange(
                  primaryCount,
                  comparisonPrimaryCount,
                )}
                loading={loading}
                comparisonLoading={comparisonLoading}
                hasComparison={hasComparison}
              />
            </div>
            <div>
              <p className="text-muted-foreground">
                {funnelMetricLabel(labels, secondaryMetric)}
              </p>
              <FunnelStepValue
                value={numberFormat(locale, secondaryCount)}
                comparisonChange={funnelComparisonChange(
                  secondaryCount,
                  comparisonSecondaryCount,
                )}
                loading={loading}
                comparisonLoading={comparisonLoading}
                hasComparison={hasComparison}
              />
            </div>
          </div>
          <div className="grid min-w-0 grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-muted-foreground">{labels.stepConversion}</p>
              <FunnelStepValue
                value={percentFormat(locale, stepRate)}
                comparisonChange={funnelComparisonChange(
                  stepRate,
                  comparisonStepRate,
                )}
                loading={loading}
                comparisonLoading={comparisonLoading}
                hasComparison={hasComparison}
              />
            </div>
            <div>
              <p className="text-muted-foreground">{labels.dropOff}</p>
              <FunnelStepValue
                value={numberFormat(locale, dropOffCount)}
                comparisonChange={funnelComparisonChange(
                  dropOffCount,
                  comparisonDropOffCount,
                )}
                loading={loading}
                comparisonLoading={comparisonLoading}
                hasComparison={hasComparison}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
function FunnelDetailContent({
  locale,
  labels,
  descriptionMessages,
  payload,
  comparisonAnalysis,
  comparisonLabel,
  comparisonLoading,
  loading,
  canManage,
  onEdit,
  onDelete,
  siteId,
  pathname,
  window,
  filters,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["funnels"];
  readonly descriptionMessages: FunnelDescriptionMessages;
  readonly payload: FunnelDetailData;
  readonly comparisonAnalysis?: FunnelAnalysis;
  readonly comparisonLabel?: string;
  readonly comparisonLoading: boolean;
  readonly loading: boolean;
  readonly canManage: boolean;
  readonly onEdit: (funnel: FunnelDefinition) => void;
  readonly onDelete: (funnel: FunnelDefinition) => void;
  readonly siteId: string;
  readonly pathname: string;
  readonly window: TimeWindow;
  readonly filters: FilterDocument;
}) {
  const { funnel, analysis } = payload.data;
  const firstStep =
    analysis.steps.find((step) => step.stepId === funnel.steps[0]?.id) ??
    analysis.steps[0];
  const lastStep =
    analysis.steps.find((step) => step.stepId === funnel.steps.at(-1)?.id) ??
    analysis.steps.at(-1);
  const defaultStepId = lastStep?.stepId ?? funnel.steps.at(-1)?.id ?? "";
  const [selectedStepId, setSelectedStepId] = useState(defaultStepId);
  const [recordOutcome, setRecordOutcome] = useState<"converted" | "dropoff">(
    "converted",
  );
  useEffect(() => {
    setSelectedStepId(defaultStepId);
  }, [defaultStepId, funnel.id]);
  useEffect(() => {
    setRecordOutcome("converted");
  }, [funnel.id]);
  const matchedStepIndex = funnel.steps.findIndex(
    (step) => step.id === selectedStepId,
  );
  const selectedStepIndex =
    matchedStepIndex >= 0
      ? matchedStepIndex
      : Math.max(0, funnel.steps.length - 1);
  const selectedFunnelStep = funnel.steps[selectedStepIndex];
  const selectedAnalysisStep = analysis.steps[selectedStepIndex];
  const metric = funnelMetricKey(analysis.progressionScope);
  const secondaryMetric = metric === "sessions" ? "visitors" : "sessions";
  const startingCount = firstStep?.progression.count ?? 0;
  const convertedCount = lastStep?.progression.count ?? 0;
  const overallConversionRate =
    startingCount > 0 ? convertedCount / startingCount : 0;
  const secondaryStartingCount = firstStep
    ? funnelMetricValue(firstStep, secondaryMetric)
    : 0;
  const secondaryConvertedCount = lastStep
    ? funnelMetricValue(lastStep, secondaryMetric)
    : 0;
  const largestDropOffStep =
    analysis.summary.largestDropOffStepIndex === null
      ? undefined
      : analysis.steps[analysis.summary.largestDropOffStepIndex];
  const comparisonSummary = comparisonAnalysis
    ? comparisonAnalysis.summary
    : undefined;
  const comparisonSteps = comparisonAnalysis?.steps ?? [];
  const comparisonFirstStep =
    comparisonSteps.find((step) => step.stepId === funnel.steps[0]?.id) ??
    comparisonSteps[0];
  const comparisonLastStep =
    comparisonSteps.find((step) => step.stepId === funnel.steps.at(-1)?.id) ??
    comparisonSteps.at(-1);
  const comparisonStartingCount = comparisonFirstStep
    ? funnelMetricValue(comparisonFirstStep, metric)
    : 0;
  const comparisonConvertedCount = comparisonLastStep
    ? funnelMetricValue(comparisonLastStep, metric)
    : 0;
  const comparisonLargestDropOffStep =
    comparisonSummary?.largestDropOffStepIndex === null ||
    comparisonSummary?.largestDropOffStepIndex === undefined
      ? undefined
      : comparisonSteps[comparisonSummary.largestDropOffStepIndex];
  const largestDropOffMatches = Boolean(
    largestDropOffStep &&
    comparisonLargestDropOffStep &&
    largestDropOffStep.stepId === comparisonLargestDropOffStep.stepId,
  );

  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <AutoTransition
              initial={false}
              transitionKey={loading ? "loading" : funnel.name}
              duration={0.18}
              type="fade"
              presenceMode="wait"
              className="h-7 min-w-0 flex-1"
            >
              {loading ? (
                <Skeleton key="loading" className="h-7 w-56 max-w-full" />
              ) : (
                <h2 key="ready" className="truncate text-xl font-semibold">
                  {funnel.name}
                </h2>
              )}
            </AutoTransition>
          </div>
          <AutoTransition
            initial={false}
            transitionKey={loading ? "loading" : funnel.updatedAt}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            className="h-5"
          >
            {loading ? (
              <Skeleton key="loading" className="h-4 w-44" />
            ) : (
              <p key="ready" className="text-sm text-muted-foreground">
                {updatedLabel(locale, labels, funnel.updatedAt)}
              </p>
            )}
          </AutoTransition>
        </div>
        {canManage ? (
          <div className="flex items-center justify-end gap-2 self-center">
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => onEdit(funnel)}
            >
              <RiEditLine />
              {labels.edit}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={loading}
              onClick={() => onDelete(funnel)}
            >
              <RiDeleteBinLine />
              {labels.delete}
            </Button>
          </div>
        ) : null}
      </div>

      <Card className="min-w-0 py-0">
        <CardContent className="p-0">
          <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
            <FunnelMetric
              label={labels.overallConversion}
              value={percentFormat(locale, overallConversionRate)}
              detail={`${numberFormat(locale, convertedCount)} / ${numberFormat(locale, startingCount)} ${funnelMetricLabel(labels, metric)}`}
              comparisonLabel={comparisonLabel}
              comparisonDetail={
                comparisonSummary
                  ? percentFormat(
                      locale,
                      comparisonSummary.overallConversionRate,
                    )
                  : undefined
              }
              comparisonChange={funnelComparisonChange(
                overallConversionRate,
                comparisonSummary?.overallConversionRate,
              )}
              comparisonLoading={comparisonLoading}
              loading={loading}
            />
            <FunnelMetric
              label={funnelStartingLabel(labels, metric)}
              value={numberFormat(locale, startingCount)}
              detail={
                firstStep
                  ? `${numberFormat(locale, secondaryStartingCount)} ${funnelMetricLabel(labels, secondaryMetric)}`
                  : "0"
              }
              comparisonLabel={comparisonLabel}
              comparisonDetail={
                comparisonAnalysis
                  ? numberFormat(locale, comparisonStartingCount)
                  : undefined
              }
              comparisonChange={funnelComparisonChange(
                startingCount,
                comparisonStartingCount,
              )}
              comparisonLoading={comparisonLoading}
              loading={loading}
            />
            <FunnelMetric
              label={funnelConvertedLabel(labels, metric)}
              value={numberFormat(locale, convertedCount)}
              detail={
                lastStep
                  ? `${numberFormat(locale, secondaryConvertedCount)} ${funnelMetricLabel(labels, secondaryMetric)}`
                  : labels.noDropOff
              }
              comparisonLabel={comparisonLabel}
              comparisonDetail={
                comparisonAnalysis
                  ? numberFormat(locale, comparisonConvertedCount)
                  : undefined
              }
              comparisonChange={funnelComparisonChange(
                convertedCount,
                comparisonConvertedCount,
              )}
              comparisonLoading={comparisonLoading}
              loading={loading}
            />
            <FunnelMetric
              label={labels.largestDropOff}
              value={
                largestDropOffStep
                  ? numberFormat(
                      locale,
                      largestDropOffStep.progression.dropOffCount,
                    )
                  : labels.noDropOff
              }
              detail={
                largestDropOffStep
                  ? `${funnelStepLabel(funnel.steps[largestDropOffStep.index]!, descriptionMessages)} ${percentFormat(locale, largestDropOffStep.progression.dropOffRate)}`
                  : labels.noDropOff
              }
              comparisonLabel={comparisonLabel}
              comparisonDetail={
                comparisonAnalysis
                  ? comparisonLargestDropOffStep
                    ? `${funnelStepLabel(funnel.steps[comparisonLargestDropOffStep.index]!, descriptionMessages)} ${percentFormat(locale, comparisonLargestDropOffStep.progression.dropOffRate)}`
                    : labels.noDropOff
                  : undefined
              }
              comparisonChange={
                largestDropOffMatches
                  ? funnelComparisonChange(
                      largestDropOffStep?.progression.dropOffCount,
                      comparisonLargestDropOffStep?.progression.dropOffCount,
                    )
                  : null
              }
              comparisonLoading={comparisonLoading}
              loading={loading}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <RiArrowRightLine className="size-4" />
            {labels.step}
          </CardTitle>
          <CardDescription>{labels.listSubtitle}</CardDescription>
        </CardHeader>
        <CardContent className="px-0 py-0">
          {funnel.steps.map((step, index) => (
            <FunnelStepRow
              key={step.id}
              locale={locale}
              labels={labels}
              descriptionMessages={descriptionMessages}
              funnelStep={step}
              analysisStep={
                analysis.steps.find(
                  (analysisStep) => analysisStep.stepId === step.id,
                ) ?? analysis.steps[index]
              }
              comparisonAnalysisStep={comparisonAnalysis?.steps.find(
                (analysisStep) => analysisStep.stepId === step.id,
              )}
              index={index}
              metric={metric}
              loading={loading}
              comparisonLoading={comparisonLoading}
              selected={step.id === selectedStepId}
            />
          ))}
        </CardContent>
      </Card>

      {selectedFunnelStep ? (
        <section className="min-w-0 space-y-3">
          <div>
            <h3 className="inline-flex items-center gap-2 text-sm font-medium">
              <RiFileList3Line className="size-4 shrink-0" />
              {labels.conversionRecords}
            </h3>
          </div>
          <AnalysisJourneyTable
            entity={metric === "visitors" ? "visitor" : "session"}
            siteId={siteId}
            pathname={pathname}
            locale={locale}
            messages={getMessages(locale)}
            window={window}
            filters={filters}
            analysisContext={{
              type: "funnel",
              funnelId: funnel.id,
              stepId: selectedFunnelStep.id,
              outcome: recordOutcome,
            }}
            toolbarLeading={
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="shrink-0 text-xs text-muted-foreground">
                  {labels.step}
                </span>
                <Slider
                  min={0}
                  max={Math.max(0, funnel.steps.length - 1)}
                  step={1}
                  value={[selectedStepIndex]}
                  onValueChange={(value) => {
                    const nextIndex = Math.round(value[0] ?? selectedStepIndex);
                    const nextStep = funnel.steps[nextIndex];
                    if (nextStep) setSelectedStepId(nextStep.id);
                  }}
                  aria-label={labels.step}
                  disabled={loading || funnel.steps.length < 2}
                  className="w-20 sm:w-28"
                />
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {numberFormat(locale, selectedStepIndex + 1)}/
                  {numberFormat(locale, funnel.steps.length)}
                </span>
                <div
                  className="inline-flex shrink-0 items-center gap-1.5"
                  aria-label={labels.conversionRecords}
                >
                  <span
                    className={
                      recordOutcome === "dropoff"
                        ? "text-xs text-foreground"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {labels.dropped}
                  </span>
                  <Switch
                    checked={recordOutcome === "converted"}
                    onCheckedChange={(checked) =>
                      setRecordOutcome(checked ? "converted" : "dropoff")
                    }
                    aria-label={`${labels.converted} / ${labels.dropped}`}
                  />
                  <span
                    className={
                      recordOutcome === "converted"
                        ? "text-xs text-foreground"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {labels.converted}
                  </span>
                </div>
              </div>
            }
            enabled={!loading && Boolean(selectedFunnelStep.id)}
          />
          {selectedAnalysisStep ? (
            <p className="text-xs text-muted-foreground">
              {numberFormat(locale, selectedAnalysisStep.progression.count)}{" "}
              {funnelMetricLabel(labels, metric)}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
function FunnelDetailSkeleton({
  labels,
  funnel,
}: {
  labels: AppMessages["funnels"];
  funnel?: FunnelDefinition;
}) {
  const metric = funnel ? funnelMetricKey(funnel.progressionScope) : "sessions";

  return (
    <div className="min-w-0 space-y-6 p-4 md:p-6">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56 max-w-full" />
        <Skeleton className="h-4 w-44" />
      </div>
      <Card className="min-w-0 py-0">
        <CardContent className="p-0">
          <div className="grid gap-px overflow-hidden bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => (
              <FunnelMetric
                key={index}
                label={
                  index === 0
                    ? labels.overallConversion
                    : index === 1
                      ? funnelStartingLabel(labels, metric)
                      : index === 2
                        ? funnelConvertedLabel(labels, metric)
                        : labels.largestDropOff
                }
                value=""
                detail=""
                loading
              />
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="inline-flex items-center gap-2">
            <Skeleton className="size-4" />
            <Skeleton className="h-5 w-16" />
          </CardTitle>
          <Skeleton className="h-4 w-64 max-w-full" />
        </CardHeader>
        <CardContent className="px-0 py-0">
          <div className="flex min-w-0 gap-3 border-b p-4">
            <Skeleton className="aspect-square min-h-8 shrink-0 self-stretch" />
            <div className="grid min-w-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1fr)_11rem_11rem]">
              <div className="min-w-0 space-y-2">
                <Skeleton className="h-5 w-[min(22rem,72%)]" />
                <Skeleton className="h-3 w-full" />
              </div>
              <div className="grid min-w-0 grid-cols-2 gap-3 text-xs">
                <div className="space-y-1">
                  <span className="text-muted-foreground">
                    {labels.sessions}
                  </span>
                  <Skeleton className="h-4 w-14" />
                </div>
                <div className="space-y-1">
                  <span className="text-muted-foreground">
                    {labels.visitors}
                  </span>
                  <Skeleton className="h-4 w-14" />
                </div>
              </div>
              <div className="grid min-w-0 grid-cols-2 gap-3 text-xs">
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-4 w-14" />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
export function FunnelDetail({
  locale,
  labels,
  descriptionMessages,
  payload,
  comparisonAnalysis,
  comparisonLabel,
  comparisonLoading = false,
  funnel,
  loading,
  error = false,
  canManage,
  onEdit,
  onDelete,
  siteId,
  pathname,
  window,
  filters,
}: {
  readonly locale: Locale;
  readonly labels: AppMessages["funnels"];
  readonly descriptionMessages: FunnelDescriptionMessages;
  readonly payload?: FunnelDetailData;
  readonly comparisonAnalysis?: FunnelAnalysis;
  readonly comparisonLabel?: string;
  readonly comparisonLoading?: boolean;
  readonly funnel?: FunnelDefinition;
  readonly loading: boolean;
  readonly error?: boolean;
  readonly canManage: boolean;
  readonly onEdit: (funnel: FunnelDefinition) => void;
  readonly onDelete: (funnel: FunnelDefinition) => void;
  readonly siteId: string;
  readonly pathname: string;
  readonly window: TimeWindow;
  readonly filters: FilterDocument;
}) {
  if (!payload && error) {
    return (
      <Card className="m-4 min-w-0 md:m-6">
        <CardContent className="flex min-h-56 flex-col items-center justify-center gap-2 text-center">
          <p className="font-medium">{labels.detailLoadError}</p>
          <p className="text-sm text-muted-foreground">{labels.subtitle}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <AutoTransition
      initial={false}
      transitionKey={payload ? "ready" : "loading"}
      duration={0.18}
      type="fade"
      presenceMode="wait"
      className="min-w-0"
    >
      {payload ? (
        <FunnelDetailContent
          locale={locale}
          labels={labels}
          descriptionMessages={descriptionMessages}
          payload={payload}
          comparisonAnalysis={comparisonAnalysis}
          comparisonLabel={comparisonLabel}
          comparisonLoading={comparisonLoading}
          loading={loading}
          canManage={canManage}
          onEdit={onEdit}
          onDelete={onDelete}
          siteId={siteId}
          pathname={pathname}
          window={window}
          filters={filters}
        />
      ) : (
        <FunnelDetailSkeleton labels={labels} funnel={funnel} />
      )}
    </AutoTransition>
  );
}
