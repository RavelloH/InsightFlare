import { PageHeading } from "@insightflare/ui/page-heading";

import { BrowserCrossBreakdownGrid } from "@/components/dashboard/browsers/browser-cross-breakdown-grid";
import { BrowserEngineShareTrendCard } from "@/components/dashboard/browsers/browser-engine-share-trend-card";
import { BrowserPerformanceRadarCard } from "@/components/dashboard/browsers/browser-performance-radar-card";
import { BrowserShareOverview } from "@/components/dashboard/browsers/browser-share-overview";
import { BrowserShareTrendCard } from "@/components/dashboard/browsers/browser-share-trend-card";
import { BrowserVersionBreakdownGrid } from "@/components/dashboard/browsers/browser-version-breakdown-grid";
import { CanIUseCompatCard } from "@/components/dashboard/browsers/caniuse-compat-card";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/comparison/use-dashboard-comparison-query";
import { useDashboardDeferredReadTransport } from "@/components/dashboard/shell/dashboard-query-provider";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import { type DeferredPrivateReads } from "@/lib/dashboard/client/request";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
interface BrowsersClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
  deferredReads?: DeferredPrivateReads | null;
}
export function BrowsersClientPage({
  locale,
  messages,
  siteId,
  deferredReads,
}: BrowsersClientPageProps) {
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const transport = useDashboardDeferredReadTransport(deferredReads);
  const comparisonQuery = useDashboardComparisonQuery(window, filters);

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.browsers.title}
        subtitle={messages.browsers.subtitle}
      />

      <BrowserShareOverview
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
        comparisonQuery={comparisonQuery}
        comparisonLabel={dashboardComparisonLabel(messages, comparisonQuery)}
      />

      <BrowserShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
      />

      <BrowserEngineShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
      />

      <BrowserPerformanceRadarCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
      />

      <BrowserVersionBreakdownGrid
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
        comparisonQuery={comparisonQuery}
        comparisonLabel={dashboardComparisonLabel(messages, comparisonQuery)}
      />

      <BrowserCrossBreakdownGrid
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
        comparisonQuery={comparisonQuery}
      />

      <CanIUseCompatCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
      />
    </div>
  );
}
