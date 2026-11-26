import { PageHeading } from "@insightflare/ui/page-heading";

import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/comparison/use-dashboard-comparison-query";
import { DeviceCrossBreakdownGrid } from "@/components/dashboard/devices/device-cross-breakdown-grid";
import { DeviceDimensionTrendCard } from "@/components/dashboard/devices/device-dimension-trend-card";
import { DeviceScreenBreakdownCard } from "@/components/dashboard/devices/device-screen-breakdown-card";
import { DeviceShareOverview } from "@/components/dashboard/devices/device-share-overview";
import { useDashboardDeferredReadTransport } from "@/components/dashboard/shell/dashboard-query-provider";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import { type DeferredPrivateReads } from "@/lib/dashboard/client/request";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
interface DevicesClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
  deferredReads?: DeferredPrivateReads | null;
}
export function DevicesClientPage({
  locale,
  messages,
  siteId,
  siteDomain,
  deferredReads,
}: DevicesClientPageProps) {
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const transport = useDashboardDeferredReadTransport(deferredReads);
  const comparisonQuery = useDashboardComparisonQuery(window, filters);

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
        transport={transport}
        comparisonQuery={comparisonQuery}
        comparisonLabel={dashboardComparisonLabel(messages, comparisonQuery)}
      />

      <DeviceDimensionTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
        dimension="deviceType"
        title={messages.devices.deviceTrendTitle}
      />

      <DeviceDimensionTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
        dimension="operatingSystem"
        title={messages.devices.osTrendTitle}
      />

      <DeviceScreenBreakdownCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        window={window}
        filters={filters}
        transport={transport}
        comparisonQuery={comparisonQuery}
        comparisonLabel={dashboardComparisonLabel(messages, comparisonQuery)}
      />

      <DeviceCrossBreakdownGrid
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
        comparisonQuery={comparisonQuery}
      />
    </div>
  );
}
