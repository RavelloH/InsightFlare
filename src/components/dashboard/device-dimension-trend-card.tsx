"use client";

import { ShareTrendCard } from "@/components/dashboard/share-trend-card";
import { fetchClientDimensionTrend } from "@/lib/dashboard/client-data";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { ClientDimensionKey } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface DeviceDimensionTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
  dimension: Extract<ClientDimensionKey, "deviceType" | "operatingSystem">;
  title: string;
}

async function fetchDeviceTypeTrend(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: { limit?: number },
) {
  return fetchClientDimensionTrend(siteId, window, "deviceType", filters, options);
}

async function fetchOperatingSystemTrend(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: { limit?: number },
) {
  return fetchClientDimensionTrend(siteId, window, "operatingSystem", filters, options);
}

export function DeviceDimensionTrendCard({
  locale,
  messages,
  siteId,
  window,
  filters,
  dimension,
  title,
}: DeviceDimensionTrendCardProps) {
  const fetchTrend = dimension === "deviceType"
    ? fetchDeviceTypeTrend
    : fetchOperatingSystemTrend;

  return (
    <ShareTrendCard
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
      title={title}
      fetchTrend={fetchTrend}
      otherLabel={messages.devices.otherLabel}
    />
  );
}
