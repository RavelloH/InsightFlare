import {
  type CSSProperties,
  memo,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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

type ShareTrendPeriod = "current" | "comparison";

interface ShareTrendPeriodHeights {
  current: number;
  comparison: number;
}

function AlignedShareTrendRow({ children }: { children: ReactNode }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [periodHeights, setPeriodHeights] = useState<ShareTrendPeriodHeights>({
    current: 0,
    comparison: 0,
  });

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;

    const periods: ShareTrendPeriod[] = ["current", "comparison"];
    const contentSelector = (period: ShareTrendPeriod) =>
      `[data-share-trend-period="${period}"] [data-share-trend-period-content]`;
    const updateHeights = () => {
      const next = periods.reduce<ShareTrendPeriodHeights>(
        (heights, period) => {
          heights[period] = Math.max(
            0,
            ...Array.from(
              row.querySelectorAll<HTMLElement>(contentSelector(period)),
              (element) =>
                Math.max(
                  element.scrollHeight,
                  element.getBoundingClientRect().height,
                ),
            ),
          );
          return heights;
        },
        { current: 0, comparison: 0 },
      );

      setPeriodHeights((previous) =>
        previous.current === next.current &&
        previous.comparison === next.comparison
          ? previous
          : next,
      );
    };

    const observer = new ResizeObserver(updateHeights);
    observer.observe(row);
    row
      .querySelectorAll<HTMLElement>("[data-share-trend-period-content]")
      .forEach((element) => observer.observe(element));
    updateHeights();

    return () => observer.disconnect();
  }, [children]);

  const style = useMemo(
    () =>
      ({
        "--share-trend-current-min-height":
          periodHeights.current > 0 ? `${periodHeights.current}px` : undefined,
        "--share-trend-comparison-min-height":
          periodHeights.comparison > 0
            ? `${periodHeights.comparison}px`
            : undefined,
      }) as CSSProperties,
    [periodHeights.comparison, periodHeights.current],
  );

  return (
    <div
      ref={rowRef}
      className="grid items-stretch gap-6 lg:grid-cols-2"
      style={style}
    >
      {children}
    </div>
  );
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

export const CampaignShareTrendCard = memo(function CampaignShareTrendCard(
  props: CampaignShareTrendCardProps,
) {
  const titles = props.messages.campaigns;

  return (
    <div className="grid gap-6">
      <AlignedShareTrendRow>
        <div className="h-full lg:col-span-2">
          <CampaignTrendPanel
            {...props}
            tab="source"
            title={titles.tabSource}
          />
        </div>
      </AlignedShareTrendRow>
      <AlignedShareTrendRow>
        <div className="h-full">
          <CampaignTrendPanel
            {...props}
            tab="medium"
            title={titles.tabMedium}
          />
        </div>
        <div className="h-full">
          <CampaignTrendPanel
            {...props}
            tab="campaign"
            title={titles.tabCampaign}
          />
        </div>
      </AlignedShareTrendRow>
      <AlignedShareTrendRow>
        <div className="h-full">
          <CampaignTrendPanel {...props} tab="term" title={titles.tabTerm} />
        </div>
        <div className="h-full">
          <CampaignTrendPanel
            {...props}
            tab="content"
            title={titles.tabContent}
          />
        </div>
      </AlignedShareTrendRow>
    </div>
  );
});
