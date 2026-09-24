import { memo, useMemo, useState } from "react";
import { RiGlobalLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  DonutChart,
  type DonutChartDataPoint,
} from "@/components/dashboard/charts/donut-chart";
import { ContentSwitch } from "@/components/dashboard/common/content-switch";
import { AutoTransition } from "@/components/ui/auto-transition";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { fetchBrowserVersionBreakdown } from "@/lib/dashboard/client/data/index";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import {
  numberFormat,
  percentFormat,
  percentFormatWithOneDecimal,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserVersionBreakdownBrowser,
  BrowserVersionBreakdownData,
  BrowserVersionSlice,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";
const DONUT_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--muted-foreground)",
] as const;
const COMPARISON_DONUT_COLORS = [
  "var(--color-compare-chart-1)",
  "var(--color-compare-chart-2)",
  "var(--color-compare-chart-3)",
  "var(--color-compare-chart-4)",
  "var(--color-compare-chart-5)",
  "var(--muted-foreground)",
] as const;
interface BrowserVersionBreakdownGridProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  comparisonQuery?: DashboardComparisonQuery | null;
  comparisonLabel?: string;
}
interface BrowserVersionSliceDisplay extends BrowserVersionSlice {
  color: string;
  displayLabel: string;
  share: number;
}
interface BrowserVersionBrowserDisplay extends BrowserVersionBreakdownBrowser {
  versions: BrowserVersionSliceDisplay[];
}
interface BrowserVersionDonutPair {
  current: DonutChartDataPoint;
  comparison: DonutChartDataPoint;
}
function emptyBrowserVersionBreakdown(): BrowserVersionBreakdownData {
  return {
    ok: true,
    data: [],
  };
}
function versionDisplayLabel(
  slice: BrowserVersionSlice,
  browserName: string,
  messages: AppMessages,
): string {
  if (slice.isOther) return messages.browsers.otherLabel;
  if (slice.isUnknown) return messages.common.unknown;
  return `${browserName} ${slice.label}`.trim();
}
function buildVersionCardData(
  data: BrowserVersionBreakdownData,
  messages: AppMessages,
): BrowserVersionBrowserDisplay[] {
  return data.data.map((browser) => ({
    ...browser,
    versions: browser.versions.map((slice, index) => ({
      ...slice,
      color: slice.isOther
        ? "var(--muted-foreground)"
        : DONUT_COLORS[index % DONUT_COLORS.length],
      displayLabel: versionDisplayLabel(slice, browser.browser, messages),
      share: browser.visitors > 0 ? slice.visitors / browser.visitors : 0,
    })),
  }));
}
function emptyBrowserDisplay(browser: string): BrowserVersionBrowserDisplay {
  return {
    browser,
    views: 0,
    visitors: 0,
    sessions: 0,
    versions: [],
  };
}
function relativeChange(current: number, comparison: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(comparison)) return null;
  if (comparison === 0) return current === 0 ? 0 : null;
  return (current - comparison) / comparison;
}
function percentageChangeFormat(
  locale: Locale,
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
const BrowserVersionDonutCard = memo(function BrowserVersionDonutCard({
  locale,
  messages,
  browser,
  comparisonBrowser,
  currentLabel,
  comparisonLabel,
}: {
  locale: Locale;
  messages: AppMessages;
  browser: BrowserVersionBrowserDisplay;
  comparisonBrowser?: BrowserVersionBrowserDisplay;
  currentLabel: string;
  comparisonLabel?: string;
}) {
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
                style={{ backgroundColor: "var(--color-compare-chart-1)" }}
              />
              {comparisonLabel}:{" "}
              {numberFormat(locale, comparisonBrowser?.visitors ?? 0)}
            </span>
          </div>
        ) : (
          <CardDescription>
            {numberFormat(locale, browser.visitors)} {messages.common.visitors}
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
              valueLabel={messages.common.visitors}
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
                {messages.common.visitors}
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
                        percentageChangeClass(current.value, comparison.value),
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
                        percentageChangeClass(current.share, comparison.share),
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
});
function emptyBreakdownUnlessAborted(
  error: unknown,
): BrowserVersionBreakdownData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyBrowserVersionBreakdown();
}
export const BrowserVersionBreakdownGrid = memo(
  function BrowserVersionBreakdownGrid({
    locale,
    messages,
    siteId,
    window,
    filters,
    comparisonQuery,
    comparisonLabel,
  }: BrowserVersionBreakdownGridProps) {
    const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
    const comparisonFiltersKey = useMemo(
      () =>
        comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none",
      [comparisonQuery],
    );
    const { data, isFetching, isPending } = useQuery({
      queryKey: [
        "dashboard",
        "browser-version-breakdown",
        siteId,
        window.from,
        window.to,
        window.timeZone,
        filtersKey,
        comparisonQuery?.mode ?? "none",
        comparisonQuery?.window.from ?? "none",
        comparisonQuery?.window.to ?? "none",
        comparisonQuery?.window.timeZone ?? "none",
        comparisonFiltersKey,
      ],
      queryFn: async ({ signal }) => {
        const fetchBreakdown = (
          requestedWindow: TimeWindow,
          requestedFilters: FilterDocument,
        ) =>
          fetchBrowserVersionBreakdown(
            siteId,
            requestedWindow,
            requestedFilters,
            {
              browserLimit: 0,
              versionLimit: 5,
              signal,
            },
          ).catch(emptyBreakdownUnlessAborted);

        const [current, comparison] = await Promise.all([
          fetchBreakdown(window, filters),
          comparisonQuery
            ? fetchBreakdown(comparisonQuery.window, comparisonQuery.filters)
            : Promise.resolve(null),
        ]);
        return { current, comparison };
      },
      enabled: !import.meta.env.SSR,
    });
    const breakdownData = useMemo(
      () => data?.current ?? emptyBrowserVersionBreakdown(),
      [data?.current],
    );
    const comparisonBreakdownData = useMemo(
      () => data?.comparison ?? undefined,
      [data?.comparison],
    );

    const browsers = useMemo(
      () => buildVersionCardData(breakdownData, messages),
      [breakdownData, messages],
    );
    const comparisonBrowsers = useMemo(
      () =>
        comparisonBreakdownData
          ? buildVersionCardData(comparisonBreakdownData, messages)
          : undefined,
      [comparisonBreakdownData, messages],
    );
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
    const showOverlayLoading = isFetching && data !== undefined;

    return (
      <section className="space-y-4">
        <div className="px-1">
          <h2 className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
            <RiGlobalLine className="size-4 shrink-0" />
            {messages.browsers.versionBreakdownTitle}
          </h2>
        </div>

        <ContentSwitch
          loading={isPending}
          hasContent={browserPairs.length > 0}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[240px]"
        >
          <div className="relative">
            <div className="grid gap-4 md:grid-cols-2">
              {browserPairs.map(({ browser, comparisonBrowser }) => (
                <BrowserVersionDonutCard
                  key={browser.browser}
                  locale={locale}
                  messages={messages}
                  browser={browser}
                  comparisonBrowser={comparisonBrowser}
                  currentLabel={messages.dashboardHeader.compareCurrentPeriod}
                  comparisonLabel={comparisonLabel}
                />
              ))}
            </div>

            <AutoTransition
              type="fade"
              duration={0.22}
              className="pointer-events-none absolute top-0 right-0"
            >
              {showOverlayLoading ? (
                <span
                  key="browser-version-overlay-loading"
                  className={cn(
                    "inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm",
                  )}
                >
                  <Spinner className="size-3.5" />
                  {messages.common.loading}
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
