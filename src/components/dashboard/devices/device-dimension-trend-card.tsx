import { memo } from "react";

import { resolveDeviceTypeMeta } from "@/components/dashboard/journeys/journey-display";
import { ShareTrendCard } from "@/components/dashboard/sharing/share-trend-card";
import {
  fetchDeviceTypeTrend,
  fetchOperatingSystemTrend,
} from "@/lib/dashboard/client/data/browser";
import type { PrivateReadTransport } from "@/lib/dashboard/client/data/types";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { ClientDimensionKey } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface DeviceDimensionTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  transport?: PrivateReadTransport;
  dimension: Extract<ClientDimensionKey, "deviceType" | "operatingSystem">;
  title: string;
}

export const DeviceDimensionTrendCard = memo(function DeviceDimensionTrendCard({
  locale,
  messages,
  siteId,
  window,
  filters,
  transport,
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
      transport={transport}
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
