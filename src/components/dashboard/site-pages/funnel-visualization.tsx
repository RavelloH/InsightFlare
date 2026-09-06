import { AutoTransition } from "@/components/ui/auto-transition";
import { Skeleton } from "@/components/ui/skeleton";
import { describeFilterExpression } from "@/lib/dashboard/filter-description";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { FunnelAnalysis, FunnelDefinition } from "@/lib/edge-client";
import { analyticsFilterRegistry, parseFilterDsl } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

export type FunnelDescriptionMessages = Pick<
  AppMessages,
  "conditionDescription" | "filterBuilder"
>;

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
  return (
    <div className={compact ? "min-w-0 space-y-4" : "min-w-0 space-y-5"}>
      {compact && analysis?.steps[0] ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {labels.sessions}:{" "}
            {numberFormat(locale, analysis.steps[0].sessions)}
          </span>
          <span>
            {labels.visitors}:{" "}
            {numberFormat(locale, analysis.steps[0].visitors)}
          </span>
        </div>
      ) : null}
      {funnel.steps.map((step, index) => {
        const result = analysis?.steps[index];
        const rate = result?.progression.conversionRate ?? 0;
        return (
          <div key={step.id} className="min-w-0 space-y-2">
            <div className="flex min-w-0 items-start gap-2 text-sm">
              <span className="shrink-0 font-mono text-muted-foreground">
                {numberFormat(locale, index + 1)}
              </span>
              <span className="min-w-0 flex-1 break-words font-medium">
                {funnelStepLabel(step, descriptionMessages)}
              </span>
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
                    className="shrink-0 pt-0.5 font-mono text-xs text-muted-foreground"
                  >
                    {percentFormat(locale, rate)}
                  </span>
                )}
              </AutoTransition>
            </div>
            <div className="h-3 overflow-hidden bg-muted">
              <AutoTransition
                initial={false}
                transitionKey={loading ? "loading" : rate}
                duration={0.18}
                type="fade"
                presenceMode="wait"
                className="h-full"
              >
                {loading ? (
                  <Skeleton key="loading" className="h-full w-full" />
                ) : (
                  <div
                    key="ready"
                    className="h-full bg-primary transition-[width]"
                    style={{
                      width:
                        rate <= 0
                          ? "0%"
                          : `${Math.max(2, Math.min(100, rate * 100))}%`,
                    }}
                  />
                )}
              </AutoTransition>
            </div>
            {!compact && result ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {labels.sessions}: {numberFormat(locale, result.sessions)}
                </span>
                <span>
                  {labels.visitors}: {numberFormat(locale, result.visitors)}
                </span>
                <span>
                  {labels.dropOff}:{" "}
                  {numberFormat(locale, result.progression.dropOffCount)}
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
