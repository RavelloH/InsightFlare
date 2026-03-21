"use client";

import { fetchBrowserTrend } from "@/lib/dashboard/client-data";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { ShareTrendCard } from "@/components/dashboard/share-trend-card";

interface BrowserShareTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: DashboardFilters;
}

export function BrowserShareTrendCard({
  locale,
  messages,
  siteId,
  window,
  filters,
}: BrowserShareTrendCardProps) {
  return (
    <ShareTrendCard
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
      title={messages.browsers.trendTitle}
      fetchTrend={fetchBrowserTrend}
    />
  );
}
