"use client";

import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { Spinner } from "@/components/ui/spinner";
import { fetchBrowserCrossBreakdown } from "@/lib/dashboard/client-data";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserCrossBreakdownData,
  BrowserCrossBreakdownDimensionData,
  BrowserCrossBreakdownItem,
} from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const STACK_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
] as const;

interface BrowserCrossBreakdownGridProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

interface BrowserCrossDisplayItem extends BrowserCrossBreakdownItem {
  color: string;
  displayLabel: string;
}

interface BrowserCrossChartRow {
  browser: string;
  browserFullLabel: string;
  [key: string]: string | number;
}

interface BrowserCrossDisplayDimension {
  columns: BrowserCrossDisplayItem[];
  rows: Array<{
    key: string;
    label: string;
    displayLabel: string;
    views: number;
    visitors: number;
    sessions: number;
    share: number;
    cells: BrowserCrossDisplayItem[];
  }>;
  totalViews: number;
  totalVisitors: number;
  totalSessions: number;
}

function emptyBrowserCrossBreakdown(): BrowserCrossBreakdownData {
  const emptyDimension: BrowserCrossBreakdownDimensionData = {
    columns: [],
    rows: [],
    totalViews: 0,
    totalVisitors: 0,
    totalSessions: 0,
  };

  return {
    ok: true,
    operatingSystem: emptyDimension,
    deviceType: emptyDimension,
  };
}

function crossItemLabel(item: BrowserCrossBreakdownItem, messages: AppMessages): string {
  if (item.isOther) return messages.browsers.otherLabel;
  if (item.isUnknown) return messages.common.unknown;
  return item.label;
}

function shortenLabel(label: string, maxLength = 18): string {
  return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
}

function buildCrossDisplayDimension(
  data: BrowserCrossBreakdownDimensionData,
  messages: AppMessages,
): BrowserCrossDisplayDimension {
  const columns = data.columns.map((column, index) => ({
    ...column,
    color: column.isOther
      ? "var(--muted-foreground)"
      : STACK_COLORS[index % STACK_COLORS.length],
    displayLabel: crossItemLabel(column, messages),
  }));
  const columnByKey = new Map(columns.map((column) => [column.key, column]));

  return {
    columns,
    totalViews: data.totalViews,
    totalVisitors: data.totalVisitors,
    totalSessions: data.totalSessions,
    rows: data.rows.map((row) => ({
      key: row.key,
      label: row.label,
      displayLabel: crossItemLabel(row, messages),
      views: row.views,
      visitors: row.visitors,
      sessions: row.sessions,
      share: data.totalVisitors > 0 ? row.visitors / data.totalVisitors : 0,
      cells: row.cells.map((cell) => {
        const column = columnByKey.get(cell.key);
        return {
          ...cell,
          color: column?.color ?? "var(--muted-foreground)",
          displayLabel: crossItemLabel(cell, messages),
        };
      }),
    })),
  };
}

function BrowserCrossStackedBarCard({
  locale,
  messages,
  title,
  dimension,
  loading,
  hydrated,
}: {
  locale: Locale;
  messages: AppMessages;
  title: string;
  dimension: BrowserCrossDisplayDimension;
  loading: boolean;
  hydrated: boolean;
}) {
  const hasContent = dimension.rows.length > 0 && dimension.columns.length > 0;
  const showOverlayLoading = loading && hydrated;

  const chartConfig = useMemo(
    () =>
      dimension.columns.reduce((config, column) => {
        config[column.key] = {
          label: column.displayLabel,
          color: column.color,
        };
        return config;
      }, {} as ChartConfig),
    [dimension.columns],
  );

  const chartData = useMemo(
    () =>
      dimension.rows.map((row) => {
        const entry: BrowserCrossChartRow = {
          browser: shortenLabel(row.displayLabel),
          browserFullLabel: row.displayLabel,
        };
        const rowSegmentVisitors = row.cells.reduce(
          (sum, cell) => sum + cell.visitors,
          0,
        );

        for (const cell of row.cells) {
          entry[cell.key] = rowSegmentVisitors > 0
            ? cell.visitors / rowSegmentVisitors
            : 0;
          entry[`${cell.key}Visitors`] = cell.visitors;
        }

        return entry;
      }),
    [dimension.rows],
  );

  const chartHeight = useMemo(
    () => Math.max(300, dimension.rows.length * 56 + 40),
    [dimension.rows.length],
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ContentSwitch
          loading={loading && !hydrated}
          hasContent={hasContent}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[320px]"
        >
          <div className="relative">
            <ChartContainer
              className="w-full aspect-auto"
              config={chartConfig}
              style={{ height: chartHeight }}
            >
              <BarChart
                accessibilityLayer
                data={chartData}
                layout="vertical"
                margin={{ top: 8, right: 12, bottom: 8, left: 12 }}
                barCategoryGap={12}
              >
                <CartesianGrid horizontal={false} />
                <XAxis
                  type="number"
                  domain={[0, 1]}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={24}
                  tickFormatter={(value) => percentFormat(locale, Number(value ?? 0))}
                />
                <YAxis
                  type="category"
                  dataKey="browser"
                  tickLine={false}
                  axisLine={false}
                  width={104}
                />
                <ChartTooltip
                  cursor={false}
                  content={({ active, payload }) => {
                    const row = payload?.[0]?.payload as BrowserCrossChartRow | undefined;
                    if (!active || !payload?.length || !row) return null;

                    const payloadByKey = new Map(
                      payload.map((item) => [String(item.dataKey ?? ""), item]),
                    );
                    const visibleItems = dimension.columns
                      .flatMap((column) => {
                        const item = payloadByKey.get(column.key);
                        return item && Number(item.value ?? 0) > 0 ? [item] : [];
                      });

                    return (
                      <div className="grid min-w-[18rem] gap-2 rounded-none border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl">
                        <div className="font-medium">{String(row.browserFullLabel || "")}</div>
                        <div className="grid gap-1.5">
                          {visibleItems.map((item) => {
                            const seriesKey = String(item.dataKey ?? "");
                            const currentSeries = dimension.columns.find(
                              (column) => column.key === seriesKey,
                            );
                            const share = Math.max(0, Number(item.value ?? 0));
                            const visitors = Math.max(
                              0,
                              Number(row[`${seriesKey}Visitors`] ?? 0),
                            );

                            return (
                              <div
                                key={`${row.browserFullLabel}-${seriesKey}`}
                                className="flex items-center gap-3"
                              >
                                <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                                  <span
                                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                                    style={{ backgroundColor: currentSeries?.color }}
                                  />
                                  <span
                                    className="truncate text-muted-foreground"
                                    title={currentSeries?.displayLabel ?? seriesKey}
                                  >
                                    {currentSeries?.displayLabel ?? seriesKey}
                                  </span>
                                </span>
                                <span className="ml-auto min-w-[7.5rem] shrink-0 whitespace-nowrap text-right font-mono text-foreground tabular-nums">
                                  {numberFormat(locale, visitors)} · {percentFormat(locale, share)}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }}
                />
                <ChartLegend
                  content={(
                    <ChartLegendContent className="pt-4 flex-wrap justify-start gap-x-4 gap-y-2" />
                  )}
                />
                {dimension.columns.map((column) => (
                  <Bar
                    key={column.key}
                    dataKey={column.key}
                    stackId="browser-cross"
                    fill={`var(--color-${column.key})`}
                    radius={0}
                  />
                ))}
              </BarChart>
            </ChartContainer>

            <AutoTransition
              type="fade"
              duration={0.22}
              className="pointer-events-none absolute top-2 right-2"
            >
              {showOverlayLoading ? (
                <span
                  key={`browser-cross-${title}-loading`}
                  className="inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
                >
                  <Spinner className="size-3.5" />
                  {messages.common.loading}
                </span>
              ) : (
                <div
                  key={`browser-cross-${title}-idle`}
                  className="h-0 w-0 overflow-hidden"
                />
              )}
            </AutoTransition>
          </div>
        </ContentSwitch>
      </CardContent>
    </Card>
  );
}

export function BrowserCrossBreakdownGrid({
  locale,
  messages,
  siteId,
  window,
  filters,
}: BrowserCrossBreakdownGridProps) {
  const [loading, setLoading] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  const [breakdownData, setBreakdownData] = useState<BrowserCrossBreakdownData>(
    () => emptyBrowserCrossBreakdown(),
  );

  useEffect(() => {
    let active = true;
    setLoading(true);

    fetchBrowserCrossBreakdown(siteId, window, filters)
      .catch(() => emptyBrowserCrossBreakdown())
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

  const operatingSystem = useMemo(
    () => buildCrossDisplayDimension(breakdownData.operatingSystem, messages),
    [breakdownData.operatingSystem, messages],
  );
  const deviceType = useMemo(
    () => buildCrossDisplayDimension(breakdownData.deviceType, messages),
    [breakdownData.deviceType, messages],
  );

  return (
    <section className="grid gap-4 2xl:grid-cols-2">
      <BrowserCrossStackedBarCard
        locale={locale}
        messages={messages}
        title={messages.browsers.osBreakdownTitle}
        dimension={operatingSystem}
        loading={loading}
        hydrated={hydrated}
      />
      <BrowserCrossStackedBarCard
        locale={locale}
        messages={messages}
        title={messages.browsers.deviceTypeBreakdownTitle}
        dimension={deviceType}
        loading={loading}
        hydrated={hydrated}
      />
    </section>
  );
}
