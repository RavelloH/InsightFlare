import { memo, useMemo } from "react";
import { RiBarChartBoxLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { ContentSwitch } from "@/components/dashboard/content-switch";
import { resolveDeviceTypeMeta } from "@/components/dashboard/journey-display";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
} from "@/components/ui/chart";
import { fetchClientCrossBreakdown } from "@/lib/dashboard/client-data";
import { numberFormat, percentFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserCrossBreakdownDimensionData,
  BrowserCrossBreakdownItem,
} from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

const STACK_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--muted-foreground)",
] as const;

interface DeviceCrossBreakdownGridProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

interface CrossDisplayItem extends BrowserCrossBreakdownItem {
  color: string;
  displayLabel: string;
}

interface CrossDisplayDimension {
  columns: CrossDisplayItem[];
  rows: Array<{
    key: string;
    label: string;
    displayLabel: string;
    views: number;
    visitors: number;
    sessions: number;
    cells: CrossDisplayItem[];
  }>;
  totalVisitors: number;
}

interface CrossChartRow {
  segment: string;
  segmentFullLabel: string;
  [key: string]: string | number;
}

function emptyDimension(): BrowserCrossBreakdownDimensionData {
  return {
    columns: [],
    rows: [],
    totalVisitors: 0,
  };
}

function crossLabel(
  item: BrowserCrossBreakdownItem,
  messages: AppMessages,
  formatLabel?: (value: string) => string,
): string {
  if (item.isOther) return messages.devices.otherLabel;
  if (item.isUnknown) return messages.common.unknown;
  return formatLabel ? formatLabel(item.label) : item.label;
}

function shortenLabel(label: string, maxLength = 18): string {
  return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
}

function buildDisplayDimension(
  data: BrowserCrossBreakdownDimensionData,
  messages: AppMessages,
  options?: {
    formatRowLabel?: (value: string) => string;
  },
): CrossDisplayDimension {
  const columns = data.columns.map((column, index) => ({
    ...column,
    color: column.isOther
      ? "var(--muted-foreground)"
      : STACK_COLORS[index % STACK_COLORS.length],
    displayLabel: crossLabel(column, messages),
  }));
  const columnByKey = new Map(columns.map((column) => [column.key, column]));

  return {
    columns,
    totalVisitors: data.totalVisitors,
    rows: data.rows.map((row) => ({
      key: row.key,
      label: row.label,
      displayLabel: crossLabel(row, messages, options?.formatRowLabel),
      views: row.views,
      visitors: row.visitors,
      sessions: row.sessions,
      cells: row.cells.map((cell) => {
        const column = columnByKey.get(cell.key);
        return {
          ...cell,
          color: column?.color ?? "var(--muted-foreground)",
          displayLabel: crossLabel(cell, messages),
        };
      }),
    })),
  };
}

const CrossBreakdownCard = memo(function CrossBreakdownCard({
  locale,
  messages,
  title,
  dimension,
  loading,
}: {
  locale: Locale;
  messages: AppMessages;
  title: string;
  dimension: CrossDisplayDimension;
  loading: boolean;
}) {
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
        const entry: CrossChartRow = {
          segment: shortenLabel(row.displayLabel),
          segmentFullLabel: row.displayLabel,
        };
        const rowVisitors = row.cells.reduce(
          (sum, cell) => sum + cell.visitors,
          0,
        );
        for (const cell of row.cells) {
          entry[cell.key] = rowVisitors > 0 ? cell.visitors / rowVisitors : 0;
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
        <CardTitle className="inline-flex items-center gap-2">
          <RiBarChartBoxLine className="size-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ContentSwitch
          loading={loading}
          hasContent={dimension.rows.length > 0 && dimension.columns.length > 0}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[320px]"
        >
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
                tickFormatter={(value) =>
                  percentFormat(locale, Number(value ?? 0))
                }
              />
              <YAxis
                type="category"
                dataKey="segment"
                tickLine={false}
                axisLine={false}
                width={104}
              />
              <ChartTooltip
                cursor={false}
                content={({ active, payload }) => {
                  const row = payload?.[0]?.payload as
                    | CrossChartRow
                    | undefined;
                  if (!active || !payload?.length || !row) return null;
                  const payloadByKey = new Map(
                    payload.map((item) => [String(item.dataKey ?? ""), item]),
                  );
                  const visibleItems = dimension.columns.flatMap((column) => {
                    const item = payloadByKey.get(column.key);
                    return item && Number(item.value ?? 0) > 0 ? [item] : [];
                  });

                  return (
                    <div className="grid min-w-[18rem] gap-2 rounded-none border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl">
                      <div className="font-medium">
                        {String(row.segmentFullLabel || "")}
                      </div>
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
                              key={`${row.segmentFullLabel}-${seriesKey}`}
                              className="flex items-center gap-3"
                            >
                              <span className="inline-flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                                  style={{
                                    backgroundColor: currentSeries?.color,
                                  }}
                                />
                                <span
                                  className="truncate text-muted-foreground"
                                  title={
                                    currentSeries?.displayLabel ?? seriesKey
                                  }
                                >
                                  {currentSeries?.displayLabel ?? seriesKey}
                                </span>
                              </span>
                              <span className="ml-auto min-w-[7.5rem] shrink-0 whitespace-nowrap text-right font-mono text-foreground tabular-nums">
                                {numberFormat(locale, visitors)} ·{" "}
                                {percentFormat(locale, share)}
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
                content={
                  <ChartLegendContent className="pt-4 flex-wrap justify-start gap-x-4 gap-y-2" />
                }
              />
              {dimension.columns.map((column) => (
                <Bar
                  key={column.key}
                  dataKey={column.key}
                  stackId={title}
                  fill={`var(--color-${column.key})`}
                  radius={0}
                />
              ))}
            </BarChart>
          </ChartContainer>
        </ContentSwitch>
      </CardContent>
    </Card>
  );
});

export const DeviceCrossBreakdownGrid = memo(function DeviceCrossBreakdownGrid({
  locale,
  messages,
  siteId,
  window,
  filters,
}: DeviceCrossBreakdownGridProps) {
  const crossBreakdownQuery = useQuery({
    queryKey: [
      "dashboard",
      "device-cross-breakdown",
      siteId,
      window.from,
      window.to,
      window.timeZone,
      filters,
    ],
    queryFn: async ({ signal }) => {
      const fetchDimension = (
        secondaryDimension: "browser" | "operatingSystem",
      ) =>
        fetchClientCrossBreakdown(
          siteId,
          window,
          "deviceType",
          secondaryDimension,
          filters,
          { primaryLimit: 5, secondaryLimit: 6, signal },
        );
      try {
        const [browserData, osData] = await Promise.all([
          fetchDimension("browser"),
          fetchDimension("operatingSystem"),
        ]);
        return { browserData, osData };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return { browserData: emptyDimension(), osData: emptyDimension() };
      }
    },
    enabled: !import.meta.env.SSR,
  });
  const browserData = useMemo(
    () => crossBreakdownQuery.data?.browserData ?? emptyDimension(),
    [crossBreakdownQuery.data?.browserData],
  );
  const osData = useMemo(
    () => crossBreakdownQuery.data?.osData ?? emptyDimension(),
    [crossBreakdownQuery.data?.osData],
  );
  const loading = crossBreakdownQuery.isPending;

  const browserDimension = useMemo(
    () =>
      buildDisplayDimension(browserData, messages, {
        formatRowLabel: (value) =>
          resolveDeviceTypeMeta(
            value,
            messages.common.deviceLabels,
            messages.common.unknown,
          ).label,
      }),
    [browserData, messages],
  );
  const osDimension = useMemo(
    () =>
      buildDisplayDimension(osData, messages, {
        formatRowLabel: (value) =>
          resolveDeviceTypeMeta(
            value,
            messages.common.deviceLabels,
            messages.common.unknown,
          ).label,
      }),
    [messages, osData],
  );

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <CrossBreakdownCard
        locale={locale}
        messages={messages}
        title={messages.devices.browserByDeviceTitle}
        dimension={browserDimension}
        loading={loading}
      />
      <CrossBreakdownCard
        locale={locale}
        messages={messages}
        title={messages.devices.osByDeviceTitle}
        dimension={osDimension}
        loading={loading}
      />
    </div>
  );
});
