import { ShareTrendCard } from "@/components/dashboard/share-trend-card";
import { fetchBrowserTrend } from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface BrowserShareTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
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
      queryKey={["browser"]}
      title={messages.browsers.trendTitle}
      fetchTrend={fetchBrowserTrend}
    />
  );
}
