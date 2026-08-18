import { useMemo } from "react";

import { type CampaignTab } from "@/components/dashboard/campaign-utils";
import {
  ShareTrendCard,
  type ShareTrendFetcher,
} from "@/components/dashboard/share-trend-card";
import { fetchUtmTrend } from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface CampaignShareTrendCardProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

interface CampaignTrendPanelProps extends CampaignShareTrendCardProps {
  tab: CampaignTab;
  title: string;
}

function CampaignTrendPanel({
  locale,
  messages,
  siteId,
  window,
  filters,
  tab,
  title,
}: CampaignTrendPanelProps) {
  const fetchTrend = useMemo<ShareTrendFetcher>(() => {
    return (nextSiteId, nextWindow, nextFilters, options) =>
      fetchUtmTrend(nextSiteId, nextWindow, tab, nextFilters, options);
  }, [tab]);

  return (
    <ShareTrendCard
      locale={locale}
      messages={messages}
      siteId={siteId}
      window={window}
      filters={filters}
      queryKey={["campaign", tab]}
      title={title}
      fetchTrend={fetchTrend}
      otherLabel={messages.browsers.otherLabel}
    />
  );
}

export function CampaignShareTrendCard(props: CampaignShareTrendCardProps) {
  const panels: Array<{
    tab: CampaignTab;
    title: string;
    className?: string;
  }> = [
    {
      tab: "source",
      title: props.messages.campaigns.tabSource,
      className: "lg:col-span-2",
    },
    {
      tab: "medium",
      title: props.messages.campaigns.tabMedium,
    },
    {
      tab: "campaign",
      title: props.messages.campaigns.tabCampaign,
    },
    {
      tab: "term",
      title: props.messages.campaigns.tabTerm,
    },
    {
      tab: "content",
      title: props.messages.campaigns.tabContent,
    },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {panels.map((panel) => (
        <div key={panel.tab} className={panel.className}>
          <CampaignTrendPanel {...props} tab={panel.tab} title={panel.title} />
        </div>
      ))}
    </div>
  );
}
