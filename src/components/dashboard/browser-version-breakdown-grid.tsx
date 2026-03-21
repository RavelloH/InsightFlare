"use client";

import { useEffect, useMemo, useState } from "react";
import { Cell, Pie, PieChart } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { Spinner } from "@/components/ui/spinner";
import { fetchBrowserVersionBreakdown } from "@/lib/dashboard/client-data";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type {
  BrowserVersionBreakdownBrowser,
  BrowserVersionBreakdownData,
  BrowserVersionSlice,
} from "@/lib/edge-client";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { AutoTransition } from "@/components/ui/auto-transition";
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
  filters: DashboardFilters;
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
      share: browser.views > 0 ? slice.views / browser.views : 0,
    })),
  }));
}

function BrowserVersionDonutCard({
  locale,
  messages,
  browser,
}: {
  locale: Locale;
  messages: AppMessages;
  browser: BrowserVersionBrowserDisplay;
}) {
  const chartConfig = useMemo(
    () =>
      browser.versions.reduce((config, version) => {
        config[version.key] = {
          label: version.displayLabel,
          color: version.color,
        };
        return config;
      }, {} as ChartConfig),
    [browser.versions],
  );

  return (
    <Card size="sm" className="overflow-visible">
      <CardHeader>
        <CardTitle className="truncate" title={browser.browser}>
          {browser.browser}
        </CardTitle>
        <CardDescription>
          {numberFormat(locale, browser.views)} {messages.common.views}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-[156px_minmax(0,1fr)] sm:items-center">
          <div className="relative mx-auto flex size-[156px] items-center justify-center">
            <ChartContainer
              className="size-[156px] [&_.recharts-tooltip-wrapper]:z-20"
              config={chartConfig}
            >
              <PieChart accessibilityLayer>
                <ChartTooltip
                  cursor={false}
                  content={({ active, payload }) => {
                    const item = payload?.[0]?.payload as
                      | BrowserVersionSliceDisplay
                      | undefined;
                    if (!active || !item) return null;

                    return (
                      <div className="grid min-w-[12rem] gap-1.5 rounded-none border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
                        <div className="font-medium">{item.displayLabel}</div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-muted-foreground">
                            {numberFormat(locale, item.views)} {messages.common.views}
                          </span>
                          <span className="font-mono font-medium tabular-nums text-foreground">
                            {percentFormat(locale, item.share)}
                          </span>
                        </div>
                      </div>
                    );
                  }}
                />
                <Pie
                  data={browser.versions}
                  dataKey="views"
                  nameKey="displayLabel"
                  innerRadius={44}
                  outerRadius={66}
                  paddingAngle={2}
                  stroke="var(--background)"
                  strokeWidth={1}
                  startAngle={90}
                  endAngle={-270}
                >
                  {browser.versions.map((version) => (
                    <Cell key={version.key} fill={version.color} />
                  ))}
                </Pie>
              </PieChart>
            </ChartContainer>

            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center">
              <span className="text-base font-medium tabular-nums text-foreground">
                {numberFormat(locale, browser.views)}
              </span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {messages.common.views}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_max-content_max-content] items-center gap-x-3 gap-y-2">
            {browser.versions.map((version) => (
              <>
                <div key={version.key} className="inline-flex min-w-0 items-center gap-2 overflow-hidden">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: version.color }}
                  />
                  <span
                    className="truncate text-muted-foreground"
                    title={version.displayLabel}
                  >
                    {version.displayLabel}
                  </span>
                </div>
                <span className="text-right font-mono text-foreground tabular-nums">
                  {numberFormat(locale, version.views)}
                </span>
                <span className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                  {percentFormat(locale, version.share)}
                </span>
              </>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function BrowserVersionBreakdownGrid({
  locale,
  messages,
  siteId,
  window,
  filters,
}: BrowserVersionBreakdownGridProps) {
  const [loading, setLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [breakdownData, setBreakdownData] = useState<BrowserVersionBreakdownData>(
    () => emptyBrowserVersionBreakdown(),
  );

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetchBrowserVersionBreakdown(siteId, window, filters, {
      browserLimit: 0,
      versionLimit: 5,
    })
      .catch(() => emptyBrowserVersionBreakdown())
      .then((nextData) => {
        if (!active) return;
        setBreakdownData(nextData);
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
        setHydrated(true);
      });

    return () => {
      active = false;
    };
  }, [
    filters,
    siteId,
    window.from,
    window.to,
  ]);

  const browsers = useMemo(
    () => buildVersionCardData(breakdownData, messages),
    [breakdownData, messages],
  );
  const showOverlayLoading = loading && hydrated;

  return (
    <section className="space-y-4">
      <div className="px-1">
        <h2 className="text-sm font-medium text-foreground">
          {messages.browsers.versionBreakdownTitle}
        </h2>
      </div>

      <ContentSwitch
        loading={loading && !hydrated}
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
}
