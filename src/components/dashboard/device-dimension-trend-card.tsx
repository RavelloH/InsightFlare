import { memo } from "react";

import { resolveDeviceTypeMeta } from "@/components/dashboard/journey-display";
import { ShareTrendCard } from "@/components/dashboard/share-trend-card";
import { fetchClientDimensionTrend } from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { ClientDimensionKey } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface DeviceDimensionTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  dimension: Extract<ClientDimensionKey, "deviceType" | "operatingSystem">;
  title: string;
}

async function fetchDeviceTypeTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { limit?: number; signal?: AbortSignal },
) {
  return fetchClientDimensionTrend(
    siteId,
    window,
    "deviceType",
    filters,
    options,
  );
}

async function fetchOperatingSystemTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { limit?: number; signal?: AbortSignal },
) {
  return fetchClientDimensionTrend(
    siteId,
    window,
    "operatingSystem",
    filters,
    options,
  );
}

export const DeviceDimensionTrendCard = memo(function DeviceDimensionTrendCard({
  locale,
  messages,
  siteId,
  window,
  filters,
  dimension,
  title,
}: DeviceDimensionTrendCardProps) {
  const fetchTrend =
    dimension === "deviceType"
      ? fetchDeviceTypeTrend
      : fetchOperatingSystemTrend;
  const isDeviceType = dimension === "deviceType";

  return (
    <ShareTrendCard
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
      queryKey={["device-dimension", dimension]}
      title={title}
      fetchTrend={fetchTrend}
      otherLabel={messages.devices.otherLabel}
      formatSeriesLabel={
        isDeviceType
          ? (series) =>
              resolveDeviceTypeMeta(
                series.label,
                messages.common.deviceLabels,
                messages.common.unknown,
              ).label
          : undefined
      }
      resolveSeriesIcon={
        isDeviceType
          ? (series) =>
              resolveDeviceTypeMeta(
                series.label,
                messages.common.deviceLabels,
                messages.common.unknown,
              ).Icon
          : undefined
      }
    />
  );
});
