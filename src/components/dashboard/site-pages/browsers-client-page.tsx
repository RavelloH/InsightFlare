"use client";

import { PageHeading } from "@/components/dashboard/page-heading";
import { BrowserShareTrendCard } from "@/components/dashboard/browser-share-trend-card";
import { BrowserEngineShareTrendCard } from "@/components/dashboard/browser-engine-share-trend-card";
import { BrowserCrossBreakdownGrid } from "@/components/dashboard/browser-cross-breakdown-grid";
import { BrowserVersionBreakdownGrid } from "@/components/dashboard/browser-version-breakdown-grid";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface BrowsersClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

export function BrowsersClientPage({
  locale,
  messages,
  siteId,
}: BrowsersClientPageProps) {
  const { filters, window } = useDashboardQuery() as {
    filters: DashboardFilters;
    window: TimeWindow;
  };

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.browsers.title}
        subtitle={messages.browsers.subtitle}
      />

      <BrowserShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />

      <BrowserEngineShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />

      <BrowserVersionBreakdownGrid
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />

      <BrowserCrossBreakdownGrid
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />
    </div>
  );
}
