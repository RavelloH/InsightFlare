import { Fragment, memo, useMemo } from "react";
import { RiGlobalLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import { DonutChart } from "@/components/dashboard/charts/donut-chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
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
import { fetchBrowserVersionBreakdown } from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserVersionBreakdownBrowser,
  BrowserVersionBreakdownData,
  BrowserVersionSlice,
} from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
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

interface BrowserVersionBreakdownGridProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

interface BrowserVersionSliceDisplay extends BrowserVersionSlice {
  color: string;
  displayLabel: string;
  share: number;
}

interface BrowserVersionBrowserDisplay extends BrowserVersionBreakdownBrowser {
  versions: BrowserVersionSliceDisplay[];
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

const BrowserVersionDonutCard = memo(function BrowserVersionDonutCard({
  locale,
  messages,
  browser,
}: {
  locale: Locale;
  messages: AppMessages;
  browser: BrowserVersionBrowserDisplay;
}) {
  const chartData = useMemo(
    () =>
      browser.versions.map((version) => ({
        key: version.key,
        label: version.displayLabel,
        value: version.visitors,
        share: version.share,
        color: version.color,
      })),
    [browser.versions],
  );

  return (
    <Card size="sm" className="overflow-visible">
      <CardHeader>
        <Tooltip>
          <TooltipTrigger asChild>
            <CardTitle className="truncate">{browser.browser}</CardTitle>
          </TooltipTrigger>
          <TooltipContent>{browser.browser}</TooltipContent>
        </Tooltip>
        <CardDescription>
          {numberFormat(locale, browser.visitors)} {messages.common.visitors}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-[156px_minmax(0,1fr)] sm:items-center">
          <div className="relative mx-auto flex size-[156px] items-center justify-center">
            <DonutChart
              data={chartData}
              locale={locale}
              valueLabel={messages.common.visitors}
              innerRadius={44}
              outerRadius={66}
              className="size-[156px]"
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

          <div className="grid grid-cols-[minmax(0,1fr)_max-content_max-content] items-center gap-x-3 gap-y-2">
            {browser.versions.map((version) => (
              <Fragment key={version.key}>
                <div className="inline-flex min-w-0 items-center gap-2 overflow-hidden">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: version.color }}
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="truncate text-muted-foreground">
                        {version.displayLabel}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>{version.displayLabel}</TooltipContent>
                  </Tooltip>
                </div>
                <span className="text-right font-mono text-foreground tabular-nums">
                  {numberFormat(locale, version.visitors)}
                </span>
                <span className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                  {percentFormat(locale, version.share)}
                </span>
              </Fragment>
            ))}
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
  }: BrowserVersionBreakdownGridProps) {
    const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
    const { data, isFetching, isPending } = useQuery({
      queryKey: [
        "dashboard",
        "browser-version-breakdown",
        siteId,
        window.from,
        window.to,
        window.timeZone,
        filtersKey,
      ],
      queryFn: ({ signal }) =>
        fetchBrowserVersionBreakdown(siteId, window, filters, {
          browserLimit: 0,
          versionLimit: 5,
          signal,
        }).catch(emptyBreakdownUnlessAborted),
      enabled: !import.meta.env.SSR,
    });
    const breakdownData = useMemo(
      () => data ?? emptyBrowserVersionBreakdown(),
      [data],
    );

    const browsers = useMemo(
      () => buildVersionCardData(breakdownData, messages),
      [breakdownData, messages],
    );
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
          hasContent={browsers.length > 0}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[240px]"
        >
          <div className="relative">
            <div className="grid gap-4 md:grid-cols-2">
              {browsers.map((browser) => (
                <BrowserVersionDonutCard
                  key={browser.browser}
                  locale={locale}
                  messages={messages}
                  browser={browser}
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
