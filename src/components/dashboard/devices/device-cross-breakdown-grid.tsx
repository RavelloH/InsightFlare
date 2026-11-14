import { memo, useMemo } from "react";
import { DeviceCrossBreakdownCardView } from "@insightflare/product-ui/technology";
import { useQuery } from "@tanstack/react-query";

import { resolveDeviceTypeMeta } from "@/components/dashboard/journeys/journey-display";
import { fetchClientCrossBreakdown } from "@/lib/dashboard/client/data/index";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  BrowserCrossBreakdownDimensionData,
  BrowserCrossBreakdownItem,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { buildDeviceCrossBreakdownLabels } from "@/lib/product-ui-labels/technology";
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
  comparisonQuery?: DashboardComparisonQuery | null;
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
interface CrossBreakdownResponse {
  browserData: BrowserCrossBreakdownDimensionData;
  osData: BrowserCrossBreakdownDimensionData;
}
function emptyCrossBreakdownResponse(): CrossBreakdownResponse {
  return {
    browserData: emptyDimension(),
    osData: emptyDimension(),
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
export const DeviceCrossBreakdownGrid = memo(function DeviceCrossBreakdownGrid({
  locale,
  messages,
  siteId,
  window,
  filters,
  comparisonQuery,
}: DeviceCrossBreakdownGridProps) {
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const crossBreakdownQuery = useQuery({
    queryKey: [
      "dashboard",
      "device-cross-breakdown",
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
      const fetchBreakdowns = async (
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ): Promise<CrossBreakdownResponse> => {
        const fetchDimension = (
          secondaryDimension: "browser" | "operatingSystem",
        ) =>
          fetchClientCrossBreakdown(
            siteId,
            requestedWindow,
            "deviceType",
            secondaryDimension,
            requestedFilters,
            { primaryLimit: 5, secondaryLimit: 6, signal },
          );

        try {
          const [browserData, osData] = await Promise.all([
            fetchDimension("browser"),
            fetchDimension("operatingSystem"),
          ]);
          return { browserData, osData };
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError")
            throw error;
          return emptyCrossBreakdownResponse();
        }
      };

      const [current, comparison] = await Promise.all([
        fetchBreakdowns(window, filters),
        comparisonQuery
          ? fetchBreakdowns(comparisonQuery.window, comparisonQuery.filters)
          : Promise.resolve(null),
      ]);

      return { ...current, comparison };
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
  const comparisonBrowserData = comparisonQuery
    ? (crossBreakdownQuery.data?.comparison?.browserData ?? emptyDimension())
    : undefined;
  const comparisonOsData = comparisonQuery
    ? (crossBreakdownQuery.data?.comparison?.osData ?? emptyDimension())
    : undefined;
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
  const comparisonBrowserDimension = useMemo(
    () =>
      comparisonBrowserData
        ? buildDisplayDimension(comparisonBrowserData, messages, {
            formatRowLabel: (value) =>
              resolveDeviceTypeMeta(
                value,
                messages.common.deviceLabels,
                messages.common.unknown,
              ).label,
          })
        : undefined,
    [comparisonBrowserData, messages],
  );
  const comparisonOsDimension = useMemo(
    () =>
      comparisonOsData
        ? buildDisplayDimension(comparisonOsData, messages, {
            formatRowLabel: (value) =>
              resolveDeviceTypeMeta(
                value,
                messages.common.deviceLabels,
                messages.common.unknown,
              ).label,
          })
        : undefined,
    [comparisonOsData, messages],
  );
  const labels = useMemo(
    () => buildDeviceCrossBreakdownLabels(messages),
    [messages],
  );

  return (
    <div className="grid items-stretch gap-4 xl:grid-cols-2">
      <DeviceCrossBreakdownCardView
        locale={locale}
        labels={labels}
        title={labels.firstTitle}
        dimension={browserDimension}
        comparisonDimension={comparisonBrowserDimension}
        loading={loading}
      />
      <DeviceCrossBreakdownCardView
        locale={locale}
        labels={labels}
        title={labels.secondTitle}
        dimension={osDimension}
        comparisonDimension={comparisonOsDimension}
        loading={loading}
      />
    </div>
  );
});
