import { ShareTrendCard } from "@/components/dashboard/share-trend-card";
import { fetchBrowserEngineTrend } from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface BrowserEngineShareTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

export function BrowserEngineShareTrendCard({
  locale,
  messages,
  siteId,
  window,
  filters,
}: BrowserEngineShareTrendCardProps) {
  return (
    <ShareTrendCard
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
      queryKey={["browser-engine"]}
      title={messages.browsers.engineTrendTitle}
      fetchTrend={fetchBrowserEngineTrend}
    />
  );
}
