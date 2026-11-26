import { memo, useMemo } from "react";
import { TechnologyShareOverviewView } from "@insightflare/product-ui/technology";
import { useQuery } from "@tanstack/react-query";

import { resolveDeviceTypeMeta } from "@/components/dashboard/journeys/journey-display";
import { shareTrendQueryOptions } from "@/components/dashboard/sharing/share-trend-card";
import { useDashboardQueryReady } from "@/components/dashboard/shell/dashboard-query-provider";
import {
  fetchDeviceTypeTrend,
  fetchOperatingSystemTrend,
} from "@/lib/dashboard/client/data/browser";
import type { PrivateReadTransport } from "@/lib/dashboard/client/data/types";
import type { DashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { buildDeviceShareOverviewLabels } from "@/lib/product-ui-labels/technology";

function emptyTrend(): BrowserTrendData {
  return { ok: true, interval: "day", series: [], data: [] };
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
  transport?: PrivateReadTransport;
  comparisonQuery?: DashboardComparisonQuery | null;
  comparisonLabel?: string;
}

export const DeviceShareOverview = memo(function DeviceShareOverview({
  locale,
  messages,
  siteId,
  window,
  filters,
  transport,
  comparisonQuery,
  comparisonLabel,
}: DeviceShareOverviewProps) {
  const enabled = useDashboardQueryReady();
  const primaryQuery = useQuery({
    ...shareTrendQueryOptions({
      siteId,
      window: window,
      filters,
      queryKey: ["device-dimension", "deviceType"],
      fetchTrend: fetchDeviceTypeTrend,
      comparisonQuery: comparisonQuery ?? null,
      transport,
    }),
    enabled,
  });
  const secondaryQuery = useQuery({
    ...shareTrendQueryOptions({
      siteId,
      window: window,
      filters,
      queryKey: ["device-dimension", "operatingSystem"],
      fetchTrend: fetchOperatingSystemTrend,
      comparisonQuery: comparisonQuery ?? null,
      transport,
    }),
    enabled,
  });
  const deviceTrend = useMemo(
    () => primaryQuery.data?.trendData ?? emptyTrend(),
    [primaryQuery.data?.trendData],
  );
  const osTrend = useMemo(
    () => secondaryQuery.data?.trendData ?? emptyTrend(),
    [secondaryQuery.data?.trendData],
  );
  const comparisonDeviceTrend =
    primaryQuery.data?.comparisonTrendData ?? undefined;
  const comparisonOsTrend =
    secondaryQuery.data?.comparisonTrendData ?? undefined;
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
  const showOverlayLoading =
    (primaryQuery.isFetching || secondaryQuery.isFetching) &&
    Boolean(primaryQuery.data && secondaryQuery.data);
  const showInitialLoading = primaryQuery.isPending || secondaryQuery.isPending;
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
