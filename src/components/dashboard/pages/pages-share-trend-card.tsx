import { memo } from "react";

import { ShareTrendCard } from "@/components/dashboard/sharing/share-trend-card";
import { fetchPagesShareTrend } from "@/lib/dashboard/client/data/index";
import { PAGE_SHARE_TREND_LIMIT } from "@/lib/dashboard/client/data/pages";
import type { PrivateReadTransport } from "@/lib/dashboard/client/data/types";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface PagesShareTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
  transport?: PrivateReadTransport;
}

export const PagesShareTrendCard = memo(function PagesShareTrendCard({
  locale,
  messages,
  siteId,
  window,
  filters,
  transport,
}: PagesShareTrendCardProps) {
  return (
    <ShareTrendCard
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
      queryKey={["pages"]}
      title={messages.pages.trendTitle}
      fetchTrend={fetchPagesShareTrend}
      limit={PAGE_SHARE_TREND_LIMIT}
      transport={transport}
      otherLabel={messages.pages.otherPages}
    />
  );
});
