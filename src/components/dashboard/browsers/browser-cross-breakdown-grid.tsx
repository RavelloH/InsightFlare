import { memo, useMemo } from "react";
import { BrowserCrossBreakdownCardView } from "@insightflare/product-ui/technology";
import { useQuery } from "@tanstack/react-query";

import {
  type DeviceTypeIcon,
  resolveDeviceTypeMeta,
} from "@/components/dashboard/journeys/journey-display";
import { fetchBrowserCrossBreakdown } from "@/lib/dashboard/client/data/index";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserCrossBreakdownData,
  BrowserCrossBreakdownDimensionData,
  BrowserCrossBreakdownItem,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { buildBrowserCrossBreakdownLabels } from "@/lib/product-ui-labels/technology";
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
  comparisonQuery?: DashboardComparisonQuery | null;
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
    comparisonQuery,
  }: BrowserCrossBreakdownGridProps) {
    const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
    const comparisonFiltersKey = useMemo(
      () =>
        comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none",
      [comparisonQuery],
    );
    const { data, isFetching, isPending } = useQuery({
      queryKey: [
        "dashboard",
        "browser-cross-breakdown",
        siteId,
        window.from,
        window.to,
        window.interval,
        window.timeZone,
        filtersKey,
        comparisonQuery?.mode ?? "none",
        comparisonQuery?.window.from ?? "none",
        comparisonQuery?.window.to ?? "none",
        comparisonQuery?.window.interval ?? "none",
        comparisonQuery?.window.timeZone ?? "none",
        comparisonFiltersKey,
      ],
      queryFn: async ({ signal }) => {
        const fetchBreakdown = (
          requestedWindow: TimeWindow,
          requestedFilters: FilterDocument,
        ) =>
          fetchBrowserCrossBreakdown(
            siteId,
            requestedWindow,
            requestedFilters,
            { signal },
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
      () => data?.current ?? emptyBrowserCrossBreakdown(),
      [data?.current],
    );
    const comparisonBreakdownData = comparisonQuery
      ? (data?.comparison ?? emptyBrowserCrossBreakdown())
      : undefined;
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
    const comparisonOperatingSystem = useMemo(
      () =>
        comparisonBreakdownData
          ? buildCrossDisplayDimension(
              comparisonBreakdownData.operatingSystem,
              messages,
            )
          : undefined,
      [comparisonBreakdownData?.operatingSystem, messages],
    );
    const comparisonDeviceType = useMemo(
      () =>
        comparisonBreakdownData
          ? buildCrossDisplayDimension(
              comparisonBreakdownData.deviceType,
              messages,
              {
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
              },
            )
          : undefined,
      [comparisonBreakdownData?.deviceType, messages],
    );
    const labels = useMemo(
      () => buildBrowserCrossBreakdownLabels(messages),
      [messages],
    );

    return (
      <section className="grid items-stretch gap-4 2xl:grid-cols-2">
        <BrowserCrossBreakdownCardView
          locale={locale}
          labels={labels}
          title={labels.firstTitle}
          dimension={operatingSystem}
          comparisonDimension={comparisonOperatingSystem}
          loading={loading}
          hydrated={hydrated}
        />
        <BrowserCrossBreakdownCardView
          locale={locale}
          labels={labels}
          title={labels.secondTitle}
          dimension={deviceType}
          comparisonDimension={comparisonDeviceType}
          loading={loading}
          hydrated={hydrated}
        />
      </section>
    );
  },
);
