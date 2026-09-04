import { useCallback, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { PageHeading } from "@/components/dashboard/page-heading";
import { ReferrerBreakdownCard } from "@/components/dashboard/referrer-breakdown-card";
import { ReferrerPerformanceRadarCard } from "@/components/dashboard/referrer-performance-radar-card";
import { ReferrerShareTrendCard } from "@/components/dashboard/referrer-share-trend-card";
import { ReferrerSummarySection } from "@/components/dashboard/referrer-summary-section";
import {
  buildReferrerRowsByTab,
  type ReferrerSortKey,
  type ReferrerTab,
} from "@/components/dashboard/referrer-utils";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import {
  fetchOverviewSourceCardTab,
  fetchReferrerSummary,
  type OverviewTabRows,
} from "@/lib/dashboard/client-data";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface ReferrersClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
  showSourceLinkTab?: boolean;
}

const EMPTY_ROWS: OverviewTabRows = [];

export function ReferrersClientPage({
  locale,
  messages,
  siteId,
  pathname,
  showSourceLinkTab = true,
}: ReferrersClientPageProps) {
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const requestFilters = filters;
  const requestWindow = useMemo(
    () => ({
      preset: window.preset,
      from: window.from,
      to: window.to,
      interval: window.interval,
      timeZone: window.timeZone,
    }),
    [window.from, window.interval, window.preset, window.timeZone, window.to],
  );
  const [sortByTab, setSortByTab] = useState<
    Record<ReferrerTab, { key: ReferrerSortKey; direction: "asc" | "desc" }>
  >({
    domain: { key: "views", direction: "desc" },
    link: { key: "views", direction: "desc" },
    channel: { key: "views", direction: "desc" },
  });
  const [searchByTab, setSearchByTab] = useState<
    Partial<Record<ReferrerTab, string>>
  >({});
  const handleSortChange = useCallback(
    (
      tab: ReferrerTab,
      sort: { key: ReferrerSortKey; direction: "asc" | "desc" },
    ) => {
      setSortByTab((previous) => ({ ...previous, [tab]: sort }));
    },
    [],
  );
  const handleSearchChange = useCallback((tab: ReferrerTab, value: string) => {
    setSearchByTab((previous) => ({ ...previous, [tab]: value }));
  }, []);

  const queryOptions = {
    limit: 100,
  } as const;
  const summaryQuery = useQuery({
    queryKey: [
      "dashboard",
      "referrer-summary",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
    ],
    queryFn: ({ signal }) =>
      fetchReferrerSummary(siteId, requestWindow, requestFilters, {
        topN: 5,
        signal,
      }),
    enabled: typeof window !== "undefined",
  });
  const domainQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "referrer-breakdown",
      "domain",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
      searchByTab.domain,
      sortByTab.domain.key,
      sortByTab.domain.direction,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchOverviewSourceCardTab(
        siteId,
        requestWindow,
        "domain",
        requestFilters,
        {
          limit: 100,
          search: searchByTab.domain,
          sort: sortByTab.domain.key,
          direction: sortByTab.domain.direction,
          cursor: pageParam,
          signal,
        },
      ),
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.nextCursor : undefined,
    enabled: typeof window !== "undefined",
  });
  const linkQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "referrer-breakdown",
      "link",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
      searchByTab.link,
      sortByTab.link.key,
      sortByTab.link.direction,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchOverviewSourceCardTab(
        siteId,
        requestWindow,
        "link",
        requestFilters,
        {
          ...queryOptions,
          search: searchByTab.link,
          sort: sortByTab.link.key,
          direction: sortByTab.link.direction,
          cursor: pageParam,
          signal,
        },
      ),
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.nextCursor : undefined,
    enabled: typeof window !== "undefined" && showSourceLinkTab,
  });
  const channelQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "referrer-breakdown",
      "channel",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
      searchByTab.channel,
      sortByTab.channel.key,
      sortByTab.channel.direction,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      fetchOverviewSourceCardTab(
        siteId,
        requestWindow,
        "channel",
        requestFilters,
        {
          ...queryOptions,
          search: searchByTab.channel,
          sort: sortByTab.channel.key,
          direction: sortByTab.channel.direction,
          cursor: pageParam,
          signal,
        },
      ),
    getNextPageParam: (lastPage) =>
      lastPage.pagination?.hasMore ? lastPage.pagination.nextCursor : undefined,
    enabled: typeof window !== "undefined",
  });
  const loading =
    domainQuery.isFetching ||
    channelQuery.isFetching ||
    (showSourceLinkTab && linkQuery.isFetching);
  const resolvedRowsByTab = useMemo(
    () => ({
      domain:
        domainQuery.data?.pages.flatMap((page) => page.items) ?? EMPTY_ROWS,
      link: showSourceLinkTab
        ? (linkQuery.data?.pages.flatMap((page) => page.items) ?? EMPTY_ROWS)
        : EMPTY_ROWS,
      channel:
        channelQuery.data?.pages.flatMap((page) => page.items) ?? EMPTY_ROWS,
    }),
    [channelQuery.data, domainQuery.data, linkQuery.data, showSourceLinkTab],
  );

  const normalizedRowsByTab = useMemo(
    () =>
      buildReferrerRowsByTab(
        resolvedRowsByTab,
        messages.overview.direct,
        messages.overview.channelLabels,
      ),
    [
      messages.overview.channelLabels,
      messages.overview.direct,
      resolvedRowsByTab,
    ],
  );
  const nextCursorByTab = useMemo(
    () => ({
      domain: domainQuery.data?.pages.at(-1)?.pagination.nextCursor ?? null,
      link: linkQuery.data?.pages.at(-1)?.pagination.nextCursor ?? null,
      channel: channelQuery.data?.pages.at(-1)?.pagination.nextCursor ?? null,
    }),
    [channelQuery.data, domainQuery.data, linkQuery.data],
  );
  const loadPageForExport = useCallback(
    async (
      tab: ReferrerTab,
      options: { cursor: string | null; signal: AbortSignal },
    ) => {
      const page = await fetchOverviewSourceCardTab(
        siteId,
        requestWindow,
        tab,
        requestFilters,
        {
          limit: 100,
          search: searchByTab[tab],
          sort: sortByTab[tab].key,
          direction: sortByTab[tab].direction,
          cursor: options.cursor,
          signal: options.signal,
        },
      );
      const normalized = buildReferrerRowsByTab(
        {
          domain: tab === "domain" ? page.items : [],
          link: tab === "link" ? page.items : [],
          channel: tab === "channel" ? page.items : [],
        },
        messages.overview.direct,
        messages.overview.channelLabels,
      );
      return {
        items: normalized[tab],
        hasMore: page.pagination.hasMore,
        nextCursor: page.pagination.nextCursor,
      };
    },
    [
      messages.overview.channelLabels,
      messages.overview.direct,
      requestFilters,
      requestWindow,
      searchByTab,
      siteId,
      sortByTab,
    ],
  );

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.referrers.title}
        subtitle={messages.referrers.subtitle}
      />

      <ReferrerSummarySection
        locale={locale}
        messages={messages}
        summary={summaryQuery.data?.data ?? null}
        loading={summaryQuery.isFetching}
        hideSummaryCard
      />

      <ReferrerShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={requestWindow}
        filters={requestFilters}
      />

      <ReferrerPerformanceRadarCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={requestWindow}
        filters={requestFilters}
      />

      <ReferrerBreakdownCard
        locale={locale}
        messages={messages}
        pathname={pathname}
        filters={requestFilters}
        rowsByTab={normalizedRowsByTab}
        loading={loading}
        sortByTab={sortByTab}
        onSortChange={handleSortChange}
        searchByTab={searchByTab}
        onSearchChange={handleSearchChange}
        hasMoreByTab={{
          domain: domainQuery.hasNextPage,
          link: linkQuery.hasNextPage,
          channel: channelQuery.hasNextPage,
        }}
        nextCursorByTab={nextCursorByTab}
        loadingMoreByTab={{
          domain: domainQuery.isFetchingNextPage,
          link: linkQuery.isFetchingNextPage,
          channel: channelQuery.isFetchingNextPage,
        }}
        onLoadMore={(tab) => {
          if (tab === "domain") void domainQuery.fetchNextPage();
          if (tab === "link") void linkQuery.fetchNextPage();
          if (tab === "channel") void channelQuery.fetchNextPage();
        }}
        loadPageForExport={loadPageForExport}
        showSourceLinkTab={showSourceLinkTab}
      />
    </div>
  );
}
