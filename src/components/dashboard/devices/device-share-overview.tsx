import { memo, useMemo } from "react";
import { TechnologyShareOverviewView } from "@insightflare/product-ui/technology";
import { useQuery } from "@tanstack/react-query";

import { resolveDeviceTypeMeta } from "@/components/dashboard/journeys/journey-display";
import { fetchClientDimensionTrend } from "@/lib/dashboard/client/data/index";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { buildDeviceShareOverviewLabels } from "@/lib/product-ui-labels/technology";

function emptyTrend(): BrowserTrendData {
  return { ok: true, interval: "day", series: [], data: [] };
}

function emptyTrendUnlessAborted(error: unknown): BrowserTrendData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyTrend();
}

function seriesLabel(
  series: BrowserTrendData["series"][number],
  messages: AppMessages,
): string {
  if (series.isOther) return messages.devices.otherLabel;
  return series.label;
}

interface DeviceShareOverviewProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  comparisonQuery?: DashboardComparisonQuery | null;
  comparisonLabel?: string;
}

export const DeviceShareOverview = memo(function DeviceShareOverview({
  locale,
  messages,
  siteId,
  window,
  filters,
  comparisonQuery,
  comparisonLabel,
}: DeviceShareOverviewProps) {
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonFiltersKey = useMemo(
    () => (comparisonQuery ? filterQueryKey(comparisonQuery.filters) : "none"),
    [comparisonQuery],
  );
  const { data, isFetching, isPending } = useQuery({
    queryKey: [
      "dashboard",
      "device-share-overview",
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
      const fetchShareData = async (
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ) => {
        const [deviceTrend, osTrend] = await Promise.all([
          fetchClientDimensionTrend(
            siteId,
            requestedWindow,
            "deviceType",
            requestedFilters,
            { limit: 5, signal },
          ).catch(emptyTrendUnlessAborted),
          fetchClientDimensionTrend(
            siteId,
            requestedWindow,
            "operatingSystem",
            requestedFilters,
            { limit: 5, signal },
          ).catch(emptyTrendUnlessAborted),
        ]);
        return { deviceTrend, osTrend };
      };
      const [current, comparison] = await Promise.all([
        fetchShareData(window, filters),
        comparisonQuery
          ? fetchShareData(comparisonQuery.window, comparisonQuery.filters)
          : Promise.resolve(null),
      ]);
      return { ...current, comparison };
    },
    enabled: !import.meta.env.SSR,
  });
  const deviceTrend = useMemo(
    () => data?.deviceTrend ?? emptyTrend(),
    [data?.deviceTrend],
  );
  const osTrend = useMemo(() => data?.osTrend ?? emptyTrend(), [data?.osTrend]);
  const comparisonDeviceTrend = data?.comparison?.deviceTrend;
  const comparisonOsTrend = data?.comparison?.osTrend;
  const deviceItems = useMemo(
    () =>
      deviceTrend.series.map((item) => {
        const deviceMeta = resolveDeviceTypeMeta(
          item.label,
          messages.common.deviceLabels,
          messages.common.unknown,
        );
        return {
          key: item.key,
          label: item.isOther ? messages.devices.otherLabel : deviceMeta.label,
          value: item.visitors,
          isOther: item.isOther,
          icon: item.isOther ? undefined : deviceMeta.Icon,
        };
      }),
    [
      deviceTrend.series,
      messages.common.deviceLabels,
      messages.common.unknown,
      messages.devices.otherLabel,
    ],
  );
  const osItems = useMemo(
    () =>
      osTrend.series.map((item) => ({
        key: item.key,
        label: seriesLabel(item, messages),
        value: item.visitors,
        isOther: item.isOther,
      })),
    [messages, osTrend.series],
  );
  const comparisonDeviceItems = useMemo(
    () =>
      comparisonDeviceTrend?.series.map((item) => {
        const deviceMeta = resolveDeviceTypeMeta(
          item.label,
          messages.common.deviceLabels,
          messages.common.unknown,
        );
        return {
          key: item.key,
          label: item.isOther ? messages.devices.otherLabel : deviceMeta.label,
          value: item.visitors,
          isOther: item.isOther,
          icon: item.isOther ? undefined : deviceMeta.Icon,
        };
      }),
    [
      comparisonDeviceTrend?.series,
      messages.common.deviceLabels,
      messages.common.unknown,
      messages.devices.otherLabel,
    ],
  );
  const comparisonOsItems = useMemo(
    () =>
      comparisonOsTrend?.series.map((item) => ({
        key: item.key,
        label: seriesLabel(item, messages),
        value: item.visitors,
        isOther: item.isOther,
      })),
    [comparisonOsTrend?.series, messages],
  );
  const showOverlayLoading = isFetching && data !== undefined;
  const showInitialLoading = isPending;
  const labels = useMemo(
    () => buildDeviceShareOverviewLabels(messages),
    [messages],
  );
  const primary = useMemo(
    () => ({ items: deviceItems, comparisonItems: comparisonDeviceItems }),
    [deviceItems, comparisonDeviceItems],
  );
  const secondary = useMemo(
    () => ({ items: osItems, comparisonItems: comparisonOsItems }),
    [osItems, comparisonOsItems],
  );

  return (
    <TechnologyShareOverviewView
      variant="device"
      locale={locale}
      labels={labels}
      primary={primary}
      secondary={secondary}
      comparisonLabel={comparisonLabel}
      loading={showInitialLoading}
      refreshing={showOverlayLoading}
    />
  );
});
