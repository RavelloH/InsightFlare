import { memo, useMemo } from "react";
import { RiBarChartBoxLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  StackedBreakdownBarChart,
  type StackedBreakdownBarRow,
  type StackedBreakdownBarSeries,
} from "@/components/dashboard/charts/stacked-breakdown-bar-chart";
import { ContentSwitch } from "@/components/dashboard/content-switch";
import {
  type DeviceTypeIcon,
  resolveDeviceTypeMeta,
} from "@/components/dashboard/journey-display";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { fetchBrowserCrossBreakdown } from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserCrossBreakdownData,
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
] as const;

interface BrowserCrossBreakdownGridProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

interface BrowserCrossDisplayItem extends BrowserCrossBreakdownItem {
  color: string;
  displayLabel: string;
  Icon?: DeviceTypeIcon;
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
  totalVisitors: number;
}

function emptyBrowserCrossBreakdown(): BrowserCrossBreakdownData {
  const emptyDimension: BrowserCrossBreakdownDimensionData = {
    columns: [],
    rows: [],
    totalVisitors: 0,
  };

  return {
    ok: true,
    operatingSystem: emptyDimension,
    deviceType: emptyDimension,
  };
}

function crossItemLabel(
  item: BrowserCrossBreakdownItem,
  messages: AppMessages,
  formatLabel?: (value: string) => string,
): string {
  if (item.isOther) return messages.browsers.otherLabel;
  if (item.isUnknown) return messages.common.unknown;
  return formatLabel ? formatLabel(item.label) : item.label;
}

function buildCrossDisplayDimension(
  data: BrowserCrossBreakdownDimensionData,
  messages: AppMessages,
  options?: {
    formatColumnLabel?: (value: string) => string;
    resolveColumnIcon?: (value: string) => DeviceTypeIcon;
  },
): BrowserCrossDisplayDimension {
  const columns = data.columns.map((column, index) => ({
    ...column,
    color: column.isOther
      ? "var(--muted-foreground)"
      : STACK_COLORS[index % STACK_COLORS.length],
    displayLabel: crossItemLabel(column, messages, options?.formatColumnLabel),
    Icon:
      column.isOther || column.isUnknown
        ? undefined
        : options?.resolveColumnIcon?.(column.label),
  }));
  const columnByKey = new Map(columns.map((column) => [column.key, column]));

  return {
    columns,
    totalVisitors: data.totalVisitors,
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
          displayLabel: crossItemLabel(
            cell,
            messages,
            options?.formatColumnLabel,
          ),
          Icon: column?.Icon,
        };
      }),
    })),
  };
}

const BrowserCrossStackedBarCard = memo(function BrowserCrossStackedBarCard({
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

  const chartSeries = useMemo<StackedBreakdownBarSeries[]>(
    () =>
      dimension.columns.map((column) => ({
        key: column.key,
        label: column.displayLabel,
        color: column.color,
        icon: column.Icon,
      })),
    [dimension.columns],
  );

  const chartRows = useMemo<StackedBreakdownBarRow[]>(
    () =>
      dimension.rows.map((row) => ({
        key: row.key,
        label: row.displayLabel,
        values: Object.fromEntries(
          row.cells.map((cell) => [cell.key, cell.visitors]),
        ),
      })),
    [dimension.rows],
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
          loading={loading && !hydrated}
          hasContent={hasContent}
          loadingLabel={messages.common.loading}
          emptyContent={<p>{messages.common.noData}</p>}
          minHeightClassName="min-h-[320px]"
        >
          <div className="relative">
            <StackedBreakdownBarChart
              rows={chartRows}
              series={chartSeries}
              locale={locale}
              categoryAxisWidth={104}
              maxCategoryLabelLength={18}
              stackId="browser-cross"
              className="w-full aspect-auto"
            />

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
});

function emptyBreakdownUnlessAborted(
  error: unknown,
): BrowserCrossBreakdownData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyBrowserCrossBreakdown();
}

export const BrowserCrossBreakdownGrid = memo(
  function BrowserCrossBreakdownGrid({
    locale,
    messages,
    siteId,
    window,
    filters,
  }: BrowserCrossBreakdownGridProps) {
    const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);
    const { data, isFetching, isPending } = useQuery({
      queryKey: [
        "dashboard",
        "browser-cross-breakdown",
        siteId,
        window.from,
        window.to,
        window.timeZone,
        filtersKey,
      ],
      queryFn: ({ signal }) =>
        fetchBrowserCrossBreakdown(siteId, window, filters, { signal }).catch(
          emptyBreakdownUnlessAborted,
        ),
      enabled: !import.meta.env.SSR,
    });
    const breakdownData = useMemo(
      () => data ?? emptyBrowserCrossBreakdown(),
      [data],
    );
    const loading = isPending || isFetching;
    const hydrated = data !== undefined;

    const operatingSystem = useMemo(
      () => buildCrossDisplayDimension(breakdownData.operatingSystem, messages),
      [breakdownData.operatingSystem, messages],
    );
    const deviceType = useMemo(
      () =>
        buildCrossDisplayDimension(breakdownData.deviceType, messages, {
          formatColumnLabel: (value) =>
            resolveDeviceTypeMeta(
              value,
              messages.common.deviceLabels,
              messages.common.unknown,
            ).label,
          resolveColumnIcon: (value) =>
            resolveDeviceTypeMeta(
              value,
              messages.common.deviceLabels,
              messages.common.unknown,
            ).Icon,
        }),
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
  },
);
