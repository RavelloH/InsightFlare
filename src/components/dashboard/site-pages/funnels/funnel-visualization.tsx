import {
  FunnelChangeRateInline,
  funnelComparisonChange,
  type FunnelComparisonState,
  type FunnelStepMetrics,
  FunnelVisualization as FunnelProductView,
  type FunnelVisualizationLabels,
  type FunnelVisualizationProps as FunnelProductViewProps,
  type FunnelVisualizationReadyStep,
  type FunnelVisualizationStepDefinition,
  type FunnelVisualizationSummary,
} from "@insightflare/product-ui/funnel";

import { describeFilterExpression } from "@/lib/dashboard/filter-description";
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

export { FunnelChangeRateInline, funnelComparisonChange };

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

export interface FunnelVisualizationAdapterProps {
  readonly locale: Locale;
  readonly labels: AppMessages["funnels"];
  readonly descriptionMessages: FunnelDescriptionMessages;
  readonly funnel: FunnelDefinition;
  readonly analysis?: FunnelAnalysis;
  readonly comparisonAnalysis?: FunnelAnalysis;
  readonly loading?: boolean;
  readonly comparisonLoading?: boolean;
}

function summaryProps(
  analysis: FunnelAnalysis | undefined,
): FunnelVisualizationSummary | undefined {
  const summary = analysis?.summary;
  if (!summary) return undefined;
  return {
    overallConversionRate: summary.overallConversionRate,
    convertedProgressions: summary.convertedProgressions,
    totalProgressions: summary.totalProgressions,
  };
}

function stepMetrics(
  step: FunnelAnalysisStep | undefined,
): FunnelStepMetrics | undefined {
  if (!step) return undefined;
  return {
    conversionRate: step.progression.conversionRate,
    dropOffRate: step.progression.dropOffRate,
  };
}

function readySteps(
  funnel: FunnelDefinition,
  analysis: FunnelAnalysis | undefined,
  descriptionMessages: FunnelDescriptionMessages,
): FunnelVisualizationReadyStep[] {
  return funnel.steps.map((step) => ({
    id: step.id,
    label: funnelStepLabel(step, descriptionMessages),
    metrics: stepMetrics(
      analysis?.steps.find((result) => result.stepId === step.id),
    ),
  }));
}

export function FunnelVisualization({
  locale,
  labels,
  descriptionMessages,
  funnel,
  analysis,
  comparisonAnalysis,
  loading = false,
  comparisonLoading = false,
}: FunnelVisualizationAdapterProps) {
  const metric = funnelMetricKey(
    analysis?.progressionScope ?? funnel.progressionScope,
  );
  const viewLabels: FunnelVisualizationLabels = {
    overallConversion: labels.overallConversion,
    converted: funnelConvertedLabel(labels, metric),
  };
  const definitions: FunnelVisualizationStepDefinition[] = funnel.steps.map(
    (step) => ({
      id: step.id,
      label: funnelStepLabel(step, descriptionMessages),
    }),
  );
  const currentSteps = readySteps(funnel, analysis, descriptionMessages);
  const comparison: FunnelComparisonState | undefined = comparisonLoading
    ? { state: "loading" }
    : comparisonAnalysis
      ? {
          state: "ready",
          steps: readySteps(funnel, comparisonAnalysis, descriptionMessages),
          summary: summaryProps(comparisonAnalysis),
        }
      : undefined;

  const viewProps: FunnelProductViewProps = loading
    ? {
        state: "loading",
        locale,
        labels: viewLabels,
        steps: definitions,
        comparison,
      }
    : {
        state: "ready",
        locale,
        labels: viewLabels,
        steps: currentSteps,
        summary: summaryProps(analysis),
        comparison,
      };

  return <FunnelProductView {...viewProps} />;
}
