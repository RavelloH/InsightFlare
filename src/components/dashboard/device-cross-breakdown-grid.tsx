import { memo, useMemo } from "react";
import { RiBarChartBoxLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  StackedBreakdownBarChart,
  type StackedBreakdownBarRow,
  type StackedBreakdownBarSeries,
} from "@/components/dashboard/charts/stacked-breakdown-bar-chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import { resolveDeviceTypeMeta } from "@/components/dashboard/journey-display";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchClientCrossBreakdown } from "@/lib/dashboard/client-data";
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
  const chartRows = useMemo<StackedBreakdownBarRow[]>(
    () =>
      dimension.rows.map((row) => {
        const values = row.cells.reduce<Record<string, number>>(
          (result, cell) => {
            result[cell.key] = cell.visitors;
            return result;
          },
          {},
        );
        return { key: row.key, label: row.displayLabel, values };
      }),
    [dimension.rows],
  );
  const chartSeries = useMemo<StackedBreakdownBarSeries[]>(
    () =>
      dimension.columns.map((column) => ({
        key: column.key,
        label: column.displayLabel,
        color: column.color,
      })),
    [dimension.columns],
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
          <StackedBreakdownBarChart
            rows={chartRows}
            series={chartSeries}
            locale={locale}
            stackId={title}
            className="w-full aspect-auto"
          />
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
