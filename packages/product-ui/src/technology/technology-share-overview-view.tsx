import { memo } from "react";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import { Spinner } from "@insightflare/ui/spinner";

import { type ShareBreakdownItem, ShareBreakdownView } from "../sharing";

export type TechnologyShareVariant = "browser" | "device";

export interface TechnologyShareOverviewLabels {
  readonly primaryTitle: string;
  readonly secondaryTitle: string;
  readonly valueLabel: string;
  readonly emptyLabel: string;
  readonly loadingLabel: string;
}

export interface TechnologyShareSection {
  readonly items: ReadonlyArray<ShareBreakdownItem>;
  readonly comparisonItems?: ReadonlyArray<ShareBreakdownItem>;
}

export interface TechnologyShareOverviewViewProps {
  readonly variant: TechnologyShareVariant;
  readonly locale: string;
  readonly labels: TechnologyShareOverviewLabels;
  readonly primary: TechnologyShareSection;
  readonly secondary: TechnologyShareSection;
  readonly comparisonLabel?: string;
  readonly loading: boolean;
  readonly refreshing: boolean;
}

export const TechnologyShareOverviewView = memo(
  function TechnologyShareOverviewView({
    variant,
    locale,
    labels,
    primary,
    secondary,
    comparisonLabel,
    loading,
    refreshing,
  }: TechnologyShareOverviewViewProps) {
    const overlayKey = `${variant}-share-overlay`;

    return (
      <div className="relative">
        <div className="grid gap-4">
          <ShareBreakdownView
            title={labels.primaryTitle}
            items={primary.items}
            comparisonItems={primary.comparisonItems}
            comparisonLabel={comparisonLabel}
            maxItems={6}
            locale={locale}
            valueLabel={labels.valueLabel}
            loading={loading}
            emptyLabel={labels.emptyLabel}
          />
          <ShareBreakdownView
            title={labels.secondaryTitle}
            items={secondary.items}
            comparisonItems={secondary.comparisonItems}
            comparisonLabel={comparisonLabel}
            maxItems={6}
            locale={locale}
            valueLabel={labels.valueLabel}
            loading={loading}
            emptyLabel={labels.emptyLabel}
          />
        </div>

        <AutoTransition
          type="fade"
          duration={0.22}
          className="pointer-events-none absolute top-2 right-2"
        >
          {refreshing ? (
            <span
              key={`${overlayKey}-loading`}
              className="inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
            >
              <Spinner className="size-3.5" />
              {labels.loadingLabel}
            </span>
          ) : (
            <div
              key={`${overlayKey}-idle`}
              className="h-0 w-0 overflow-hidden"
            />
          )}
        </AutoTransition>
      </div>
    );
  },
);
