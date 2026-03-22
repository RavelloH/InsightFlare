"use client";

import { DeviceCrossBreakdownGrid } from "@/components/dashboard/device-cross-breakdown-grid";
import { DeviceDimensionTrendCard } from "@/components/dashboard/device-dimension-trend-card";
import { DeviceScreenBreakdownCard } from "@/components/dashboard/device-screen-breakdown-card";
import { DeviceShareOverview } from "@/components/dashboard/device-share-overview";
import { PageHeading } from "@/components/dashboard/page-heading";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface DevicesClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

export function DevicesClientPage({
  locale,
  messages,
  siteId,
}: DevicesClientPageProps) {
  const { filters, window } = useDashboardQuery() as {
    filters: DashboardFilters;
    window: TimeWindow;
  };

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.devices.title}
        subtitle={messages.devices.subtitle}
      />

      <DeviceShareOverview
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />

      <DeviceDimensionTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        dimension="deviceType"
        title={messages.devices.deviceTrendTitle}
      />

      <DeviceDimensionTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        dimension="operatingSystem"
        title={messages.devices.osTrendTitle}
      />

      <DeviceScreenBreakdownCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />

      <DeviceCrossBreakdownGrid
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
    </div>
  );
}

