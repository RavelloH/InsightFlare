import { memo, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { resolveDeviceTypeMeta } from "@/components/dashboard/journey-display";
import { ShareRadialCard } from "@/components/dashboard/share-radial-card";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Spinner } from "@/components/ui/spinner";
import { fetchClientDimensionTrend } from "@/lib/dashboard/client-data";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

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

  return (
    <div className="relative">
      <div className="grid gap-4">
        <ShareRadialCard
          title={messages.devices.deviceShareTitle}
          items={deviceItems}
          comparisonItems={comparisonDeviceItems}
          comparisonLabel={comparisonLabel}
          maxItems={6}
          locale={locale}
          valueLabel={messages.common.visitors}
          loading={showInitialLoading}
          emptyLabel={messages.common.noData}
        />
        <ShareRadialCard
          title={messages.devices.osShareTitle}
          items={osItems}
          comparisonItems={comparisonOsItems}
          comparisonLabel={comparisonLabel}
          maxItems={6}
          locale={locale}
          valueLabel={messages.common.visitors}
          loading={showInitialLoading}
          emptyLabel={messages.common.noData}
        />
      </div>

      <AutoTransition
        type="fade"
        duration={0.22}
        className="pointer-events-none absolute top-2 right-2"
      >
        {showOverlayLoading ? (
          <span
            key="device-share-overlay-loading"
            className="inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
          >
            <Spinner className="size-3.5" />
            {messages.common.loading}
          </span>
        ) : (
          <div
            key="device-share-overlay-idle"
            className="h-0 w-0 overflow-hidden"
          />
        )}
      </AutoTransition>
    </div>
  );
});
