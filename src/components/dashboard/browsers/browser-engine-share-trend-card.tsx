import { memo } from "react";

import { ShareTrendCard } from "@/components/dashboard/sharing/share-trend-card";
import { fetchBrowserEngineTrend } from "@/lib/dashboard/client/data/index";
import type { PrivateReadTransport } from "@/lib/dashboard/client/data/types";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface BrowserEngineShareTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  transport?: PrivateReadTransport;
}

export const BrowserEngineShareTrendCard = memo(
  function BrowserEngineShareTrendCard({
    locale,
    messages,
    siteId,
    window,
    filters,
    transport,
  }: BrowserEngineShareTrendCardProps) {
    return (
      <ShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
        transport={transport}
        queryKey={["browser-engine"]}
        title={messages.browsers.engineTrendTitle}
        fetchTrend={fetchBrowserEngineTrend}
      />
    );
  },
);
