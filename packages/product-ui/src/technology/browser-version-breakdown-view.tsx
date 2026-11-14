import { memo, useMemo, useState } from "react";
import { AsyncContent as ContentSwitch } from "@insightflare/ui/async-content";
import { AutoTransition } from "@insightflare/ui/auto-transition";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@insightflare/ui/card";
import { Spinner } from "@insightflare/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@insightflare/ui/tooltip";
import { RiGlobalLine } from "@remixicon/react";

import { DonutChart, type DonutChartDataPoint } from "../charts";
import { percentFormatWithOneDecimal } from "../charts/chart-format";
import { numberFormat, percentFormat } from "../number-format";
import { cn } from "../utils/cn";

const DONUT_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--muted-foreground)",
] as const;
const COMPARISON_DONUT_COLORS = [
  "var(--color-chart-secondary-1)",
  "var(--color-chart-secondary-2)",
  "var(--color-chart-secondary-3)",
  "var(--color-chart-secondary-4)",
  "var(--color-chart-secondary-5)",
  "var(--muted-foreground)",
] as const;

export interface BrowserVersionSliceDisplay {
  readonly key: string;
  readonly displayLabel: string;
  readonly visitors: number;
  readonly share: number;
}

export interface BrowserVersionBrowserDisplay {
  readonly browser: string;
  readonly visitors: number;
  readonly versions: ReadonlyArray<BrowserVersionSliceDisplay>;
}

export interface BrowserVersionBreakdownLabels {
  readonly title: string;
  readonly loadingLabel: string;
  readonly emptyLabel: string;
  readonly visitorsLabel: string;
  readonly currentPeriodLabel: string;
}

export interface BrowserVersionDonutCardViewProps {
  readonly locale: string;
  readonly visitorsLabel: string;
  readonly browser: BrowserVersionBrowserDisplay;
  readonly comparisonBrowser?: BrowserVersionBrowserDisplay;
  readonly currentLabel: string;
  readonly comparisonLabel?: string;
}

export interface BrowserVersionBreakdownViewProps {
  readonly locale: string;
  readonly labels: BrowserVersionBreakdownLabels;
  readonly browsers: ReadonlyArray<BrowserVersionBrowserDisplay>;
  readonly comparisonBrowsers?: ReadonlyArray<BrowserVersionBrowserDisplay>;
  readonly comparisonLabel?: string;
  readonly loading: boolean;
  readonly refreshing: boolean;
}

interface BrowserVersionDonutPair {
  current: DonutChartDataPoint;
  comparison: DonutChartDataPoint;
}

function emptyBrowserDisplay(browser: string): BrowserVersionBrowserDisplay {
  return { browser, visitors: 0, versions: [] };
}

function relativeChange(current: number, comparison: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(comparison)) return null;
  if (comparison === 0) return current === 0 ? 0 : null;
  return (current - comparison) / comparison;
}

function percentageChangeFormat(
  locale: string,
  current: number,
  comparison: number,
): string {
  const change = relativeChange(current, comparison);
  if (change === null) return "—";
  return `${change >= 0 ? "+" : ""}${percentFormatWithOneDecimal(locale, change)}`;
}

function percentageChangeClass(current: number, comparison: number): string {
  const change = relativeChange(current, comparison);
  if (change === null) return "text-muted-foreground";
  return change >= 0 ? "text-emerald-600" : "text-rose-600";
}

export const BrowserVersionDonutCardView = memo(
  function BrowserVersionDonutCardView({
    locale,
    visitorsLabel,
    browser,
    comparisonBrowser,
    currentLabel,
    comparisonLabel,
  }: BrowserVersionDonutCardViewProps) {
    const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
    const hasComparison = comparisonBrowser !== undefined;
    const donutPairs = useMemo(() => {
      const currentByKey = new Map(
        browser.versions.map((version) => [version.key, version]),
      );
      const comparisonByKey = new Map(
        (comparisonBrowser?.versions ?? []).map((version) => [
          version.key,
          version,
        ]),
      );
      const keys = [
        ...browser.versions.map((version) => version.key),
        ...(comparisonBrowser?.versions ?? [])
          .map((version) => version.key)
          .filter((key) => !currentByKey.has(key)),
      ];

      return keys.map<BrowserVersionDonutPair>((key, index) => {
        const current = currentByKey.get(key);
        const comparison = comparisonByKey.get(key);
        const label = current?.displayLabel ?? comparison?.displayLabel ?? key;

        return {
          current: {
            key,
            label,
            value: current?.visitors ?? 0,
            share: current?.share ?? 0,
            color: DONUT_COLORS[index % DONUT_COLORS.length],
          },
          comparison: {
            key,
            label,
            value: comparison?.visitors ?? 0,
            share: comparison?.share ?? 0,
            color:
              COMPARISON_DONUT_COLORS[index % COMPARISON_DONUT_COLORS.length],
          },
        };
      });
    }, [browser.versions, comparisonBrowser?.versions]);
    const chartData = useMemo(
      () => donutPairs.map((pair) => pair.current),
      [donutPairs],
    );
    const comparisonChartData = hasComparison
      ? donutPairs.map((pair) => pair.comparison)
      : undefined;

    return (
      <Card size="sm" className="overflow-visible">
        <CardHeader>
          <Tooltip>
            <TooltipTrigger asChild>
              <CardTitle className="truncate">{browser.browser}</CardTitle>
            </TooltipTrigger>
            <TooltipContent>{browser.browser}</TooltipContent>
          </Tooltip>
          {hasComparison ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-none"
                  style={{ backgroundColor: "var(--color-chart-1)" }}
                />
                {currentLabel}: {numberFormat(locale, browser.visitors)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-none"
                  style={{ backgroundColor: "var(--color-chart-secondary-1)" }}
                />
                {comparisonLabel}:{" "}
                {numberFormat(locale, comparisonBrowser?.visitors ?? 0)}
              </span>
            </div>
          ) : (
            <CardDescription>
              {numberFormat(locale, browser.visitors)} {visitorsLabel}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-[156px_minmax(0,1fr)] sm:items-center">
            <div className="relative mx-auto flex size-[156px] items-center justify-center">
              <DonutChart
                data={chartData}
                comparisonData={comparisonChartData}
                currentLabel={currentLabel}
                comparisonLabel={comparisonLabel}
                highlightedKey={highlightedKey}
                locale={locale}
                valueLabel={visitorsLabel}
                innerRadius={44}
                outerRadius={66}
                className="size-[156px]"
                onHighlightChange={setHighlightedKey}
              />

              <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center">
                <span className="text-base font-medium tabular-nums text-foreground">
                  {numberFormat(locale, browser.visitors)}
                </span>
                <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                  {visitorsLabel}
                </span>
              </div>
            </div>

            <div
              className={cn(
                "grid items-center gap-x-3 gap-y-2",
                hasComparison
                  ? "grid-cols-[minmax(0,1fr)_repeat(4,max-content)]"
                  : "grid-cols-[minmax(0,1fr)_repeat(2,max-content)]",
              )}
            >
              {donutPairs.map(({ current, comparison }) => {
                const isDimmed =
                  highlightedKey !== null && highlightedKey !== current.key;

                return (
                  <div key={current.key} className="contents">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className={cn(
                            "inline-flex min-w-0 items-center gap-2 overflow-hidden text-left transition-opacity motion-reduce:transition-none",
                            isDimmed && "opacity-40",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          )}
                          onPointerEnter={() => setHighlightedKey(current.key)}
                          onPointerLeave={() => setHighlightedKey(null)}
                          onFocus={() => setHighlightedKey(current.key)}
                          onBlur={() => setHighlightedKey(null)}
                        >
                          <span className="inline-flex shrink-0 items-center gap-0.5">
                            <span
                              className="h-2.5 w-2.5 rounded-none"
                              style={{ backgroundColor: current.color }}
                            />
                            {hasComparison ? (
                              <span
                                className="h-2.5 w-2.5 rounded-none"
                                style={{ backgroundColor: comparison.color }}
                              />
                            ) : null}
                          </span>
                          <span className="truncate text-muted-foreground">
                            {current.label}
                          </span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{current.label}</TooltipContent>
                    </Tooltip>
                    <span
                      className={cn(
                        "justify-self-end font-mono text-foreground tabular-nums transition-opacity motion-reduce:transition-none",
                        isDimmed && "opacity-40",
                      )}
                    >
                      {numberFormat(locale, current.value)}
                    </span>
                    {hasComparison ? (
                      <span
                        className={cn(
                          "justify-self-end font-mono tabular-nums transition-opacity motion-reduce:transition-none",
                          percentageChangeClass(
                            current.value,
                            comparison.value,
                          ),
                          isDimmed && "opacity-40",
                        )}
                      >
                        {percentageChangeFormat(
                          locale,
                          current.value,
                          comparison.value,
                        )}
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        "justify-self-end text-right font-mono text-[11px] tabular-nums transition-opacity motion-reduce:transition-none",
                        isDimmed && "opacity-40",
                      )}
                    >
                      <span className="text-muted-foreground">
                        {percentFormat(locale, current.share)}
                      </span>
                    </span>
                    {hasComparison ? (
                      <span
                        className={cn(
                          "justify-self-end text-right font-mono text-[11px] tabular-nums transition-opacity motion-reduce:transition-none",
                          percentageChangeClass(
                            current.share,
                            comparison.share,
                          ),
                          isDimmed && "opacity-40",
                        )}
                      >
                        {percentageChangeFormat(
                          locale,
                          current.share,
                          comparison.share,
                        )}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  },
);

export const BrowserVersionBreakdownView = memo(
  function BrowserVersionBreakdownView({
    locale,
    labels,
    browsers,
    comparisonBrowsers,
    comparisonLabel,
    loading,
    refreshing,
  }: BrowserVersionBreakdownViewProps) {
    const browserPairs = useMemo(() => {
      const currentByBrowser = new Map(
        browsers.map((browser) => [browser.browser, browser]),
      );
      const comparisonByBrowser = new Map(
        (comparisonBrowsers ?? []).map((browser) => [browser.browser, browser]),
      );
      const browserNames = [
        ...browsers.map((browser) => browser.browser),
        ...(comparisonBrowsers ?? [])
          .map((browser) => browser.browser)
          .filter((browser) => !currentByBrowser.has(browser)),
      ];

      return browserNames.map((browserName) => ({
        browser:
          currentByBrowser.get(browserName) ?? emptyBrowserDisplay(browserName),
        comparisonBrowser: comparisonByBrowser.get(browserName),
      }));
    }, [browsers, comparisonBrowsers]);

    return (
      <section className="space-y-4">
        <div className="px-1">
          <h2 className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
            <RiGlobalLine className="size-4 shrink-0" />
            {labels.title}
          </h2>
        </div>

        <ContentSwitch
          loading={loading}
          hasContent={browserPairs.length > 0}
          loadingLabel={labels.loadingLabel}
          emptyContent={<p>{labels.emptyLabel}</p>}
          minHeightClassName="min-h-[240px]"
        >
          <div className="relative">
            <div className="grid gap-4 md:grid-cols-2">
              {browserPairs.map(({ browser, comparisonBrowser }) => (
                <BrowserVersionDonutCardView
                  key={browser.browser}
                  locale={locale}
                  visitorsLabel={labels.visitorsLabel}
                  browser={browser}
                  comparisonBrowser={comparisonBrowser}
                  currentLabel={labels.currentPeriodLabel}
                  comparisonLabel={comparisonLabel}
                />
              ))}
            </div>

            <AutoTransition
              type="fade"
              duration={0.22}
              className="pointer-events-none absolute top-0 right-0"
            >
              {refreshing ? (
                <span
                  key="browser-version-overlay-loading"
                  className={cn(
                    "inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm",
                  )}
                >
                  <Spinner className="size-3.5" />
                  {labels.loadingLabel}
                </span>
              ) : (
                <div
                  key="browser-version-overlay-idle"
                  className="h-0 w-0 overflow-hidden"
                />
              )}
            </AutoTransition>
          </div>
        </ContentSwitch>
      </section>
    );
  },
);
