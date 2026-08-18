import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ShareRadialCard } from "@/components/dashboard/share-radial-card";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Spinner } from "@/components/ui/spinner";
import {
  fetchBrowserEngineTrend,
  fetchBrowserTrend,
} from "@/lib/dashboard/client-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { BrowserTrendData } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

function emptyTrend(): BrowserTrendData {
  return { ok: true, interval: "day", series: [], data: [] };
}

function emptyTrendUnlessAborted(error: unknown): BrowserTrendData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyTrend();
}

interface BrowserShareOverviewProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  window: TimeWindow;
  filters: FilterDocument;
}

export function BrowserShareOverview({
  locale,
  messages,
  siteId,
  window: tw,
  filters,
}: BrowserShareOverviewProps) {
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);
  const { data, isFetching } = useQuery({
    queryKey: [
      "dashboard",
      "browser-share-overview",
      siteId,
      tw.from,
      tw.to,
      tw.interval,
      tw.timeZone,
      filtersKey,
    ],
    queryFn: async ({ signal }) => {
      const [browserTrend, engineTrend] = await Promise.all([
        fetchBrowserTrend(siteId, tw, filters, { limit: 5, signal }).catch(
          emptyTrendUnlessAborted,
        ),
        fetchBrowserEngineTrend(siteId, tw, filters, {
          limit: 5,
          signal,
        }).catch(emptyTrendUnlessAborted),
      ]);
      return { browserTrend, engineTrend };
    },
    enabled: typeof window !== "undefined",
  });
  const browserTrend = data?.browserTrend ?? emptyTrend();
  const engineTrend = data?.engineTrend ?? emptyTrend();
  const showOverlayLoading = isFetching && data !== undefined;
  const showInitialLoading = isFetching && data === undefined;

  return (
    <div className="relative">
      <div className="grid gap-4">
        <ShareRadialCard
          title={messages.browsers.browserShareTitle}
          items={browserTrend.series.map((item) => ({
            key: item.key,
            label: item.label,
            value: item.visitors,
            isOther: item.isOther,
          }))}
          locale={locale}
          valueLabel={messages.common.visitors}
          loading={showInitialLoading}
          emptyLabel={messages.common.noData}
        />
        <ShareRadialCard
          title={messages.browsers.engineShareTitle}
          items={engineTrend.series.map((item) => ({
            key: item.key,
            label: item.label,
            value: item.visitors,
            isOther: item.isOther,
          }))}
          locale={locale}
          valueLabel={messages.common.visitors}
          loading={showInitialLoading}
          emptyLabel={messages.common.noData}
        />
      </div>

      <AutoTransition
        type="fade"
        duration={0.22}
        className="pointer-events-none absolute top-2 right-2"
      >
        {showOverlayLoading ? (
          <span
            key="browser-share-overlay-loading"
            className="inline-flex items-center gap-2 rounded-none border border-border/50 bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm"
          >
            <Spinner className="size-3.5" />
            {messages.common.loading}
          </span>
        ) : (
          <div
            key="browser-share-overlay-idle"
            className="h-0 w-0 overflow-hidden"
          />
        )}
      </AutoTransition>
    </div>
  );
}
