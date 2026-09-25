import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { useAnalyticsTableColumns } from "@/components/dashboard/common/analytics-table-column-settings";
import { PageHeading } from "@/components/dashboard/common/page-heading";
import {
  dashboardComparisonLabel,
  useDashboardComparisonQuery,
} from "@/components/dashboard/comparison/use-dashboard-comparison-query";
import { PagesShareTrendCard } from "@/components/dashboard/pages/pages-share-trend-card";
import {
  createPagesTableColumnDefinitions,
  LEGACY_PAGES_TABLE_COLUMNS_STORAGE_KEY,
  PAGES_TABLE_COLUMNS_STORAGE_KEY,
  type PagesSortState,
  PagesTableCard,
} from "@/components/dashboard/pages/pages-table-card";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import { PageDetailDrawer } from "@/components/dashboard/site-pages/pages/page-detail-drawer";
import {
  fetchPagesDashboard,
  type PagesDashboardRow,
} from "@/lib/dashboard/client/data/index";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/dashboard/client/history";
import { resolveDashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import {
  normalizePagePath,
  PAGE_DETAIL_QUERY_PARAM,
} from "@/lib/dashboard/page-detail";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { PagesDashboardMetric } from "@/lib/dashboard-api/contract/types/pages";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
const PAGE_LIST_PAGE_SIZE = 25;
function moveTrendAfterPage(ids: readonly string[]): string[] {
  const withoutTrend = ids.filter((id) => id !== "trend");
  const pageIndex = withoutTrend.indexOf("page");
  withoutTrend.splice(pageIndex < 0 ? 0 : pageIndex + 1, 0, "trend");
  return withoutTrend;
}
function migratePagesTableColumnSettings(): void {
  if (typeof window === "undefined") return;

  try {
    if (window.localStorage.getItem(PAGES_TABLE_COLUMNS_STORAGE_KEY)) return;
    const legacyValue = window.localStorage.getItem(
      LEGACY_PAGES_TABLE_COLUMNS_STORAGE_KEY,
    );
    if (!legacyValue) return;

    const stored = JSON.parse(legacyValue) as {
      version?: unknown;
      order?: unknown;
      visible?: unknown;
    };
    if (
      stored.version !== 1 ||
      !Array.isArray(stored.order) ||
      !Array.isArray(stored.visible)
    ) {
      return;
    }

    const order = stored.order.filter(
      (id): id is string => typeof id === "string",
    );
    const visible = stored.visible.filter(
      (id): id is string => typeof id === "string",
    );
    const trendWasStored = order.includes("trend") || visible.includes("trend");

    window.localStorage.setItem(
      PAGES_TABLE_COLUMNS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        order: moveTrendAfterPage(order),
        visible: trendWasStored
          ? visible.includes("trend")
            ? moveTrendAfterPage(visible)
            : visible
          : moveTrendAfterPage(visible),
      }),
    );
  } catch {
    // Storage may be unavailable or contain invalid data; defaults will be used.
  }
}
interface PagesClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain?: string;
  pathname: string;
  sitePathname?: string;
}
function pageDetailQueryTarget(
  pathname: string,
  searchParams: URLSearchParams,
  pagePath: string,
): string {
  const params = new URLSearchParams(searchParams.toString());
  params.set(PAGE_DETAIL_QUERY_PARAM, pagePath);
  const query = serializeDashboardSearchParams(params);
  return query ? `${pathname}?${query}` : pathname;
}
export function PagesClientPage({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
  sitePathname,
}: PagesClientPageProps) {
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const globalComparisonQuery = useDashboardComparisonQuery(window, filters);
  const comparisonQuery = useMemo(
    () =>
      globalComparisonQuery ??
      resolveDashboardComparisonQuery(
        new URLSearchParams("compare=previous"),
        window,
        filters,
      ),
    [
      filters,
      globalComparisonQuery,
      window.from,
      window.interval,
      window.timeZone,
      window.to,
    ],
  );
  const comparisonActive = Boolean(comparisonQuery);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<PagesSortState>({
    key: "views",
    direction: "desc",
  });
  const columnDefinitions = useMemo(
    () => createPagesTableColumnDefinitions(messages),
    [messages],
  );
  useEffect(() => {
    migratePagesTableColumnSettings();
  }, []);
  const pageColumns = useAnalyticsTableColumns({
    storageKey: PAGES_TABLE_COLUMNS_STORAGE_KEY,
    columns: columnDefinitions,
  });
  const searchParams = useLiveSearchParams();
  const detailPagePath = normalizePagePath(
    searchParams.get(PAGE_DETAIL_QUERY_PARAM),
  );
  const openedDetailFromListRef = useRef(false);
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);
  const comparisonFiltersKey = useMemo(
    () =>
      comparisonQuery
        ? filterQueryKey(comparisonQuery.filters)
        : "no-comparison",
    [comparisonQuery],
  );

  useEffect(() => {
    const timeoutId = globalThis.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);
    return () => globalThis.clearTimeout(timeoutId);
  }, [query]);

  const {
    data,
    error: queryError,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
    isPending,
  } = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "pages-list",
      siteId,
      window.from,
      window.to,
      window.interval,
      window.timeZone,
      filtersKey,
      debouncedQuery,
      sort.key,
      sort.direction,
      comparisonQuery?.mode ?? "none",
      comparisonQuery?.window.from ?? null,
      comparisonQuery?.window.to ?? null,
      comparisonFiltersKey,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchPagesDashboard(siteId, window, filters, {
        cursor: pageParam,
        limit: PAGE_LIST_PAGE_SIZE,
        search: debouncedQuery,
        sort: sort.key,
        direction: sort.direction,
        comparison: comparisonQuery,
        comparisonMetric: sort.key,
        comparisonSortBy: "current",
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.data.pagination.hasMore
        ? lastPage.data.pagination.nextCursor
        : undefined,
    enabled: typeof window !== "undefined",
  });

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const result: PagesDashboardRow[] = [];
    for (const page of data?.pages ?? []) {
      for (const row of page.data.items) {
        if (seen.has(row.pathname)) continue;
        seen.add(row.pathname);
        result.push(row);
      }
    }
    return result;
  }, [data?.pages]);
  const loadingInitial = isPending;
  const loadingMore = isFetchingNextPage;
  const hasMore = hasNextPage ?? false;
  const error = Boolean(queryError) && rows.length === 0;
  const appendError = isFetchNextPageError;

  const loadNextPage = useCallback(() => {
    if (loadingInitial || loadingMore || appendError || !hasMore) return;
    void fetchNextPage();
  }, [appendError, fetchNextPage, hasMore, loadingInitial, loadingMore]);

  const toggleSort = useCallback((key: PagesDashboardMetric) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key, direction: "desc" },
    );
  }, []);

  const openPageDetail = useCallback(
    (pagePath: string) => {
      const normalizedPagePath = normalizePagePath(pagePath);
      if (!normalizedPagePath) return;
      openedDetailFromListRef.current = true;
      pushUrlWithoutNavigation(
        pageDetailQueryTarget(pathname, searchParams, normalizedPagePath),
      );
    },
    [pathname, searchParams],
  );

  const closePageDetail = useCallback(() => {
    const params = new URLSearchParams(globalThis.window.location.search);
    if (!params.has(PAGE_DETAIL_QUERY_PARAM)) return;
    if (openedDetailFromListRef.current) {
      openedDetailFromListRef.current = false;
      globalThis.window.history.back();
      return;
    }
    params.delete(PAGE_DETAIL_QUERY_PARAM);
    const query = serializeDashboardSearchParams(params);
    replaceUrlWithoutNavigation(query ? `${pathname}?${query}` : pathname);
  }, [pathname]);

  useEffect(() => {
    if (!detailPagePath) openedDetailFromListRef.current = false;
  }, [detailPagePath]);

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.pages.title}
        subtitle={messages.pages.subtitle}
      />

      <PagesShareTrendCard
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={filters}
      />

      <PagesTableCard
        locale={locale}
        messages={messages}
        rows={rows}
        sort={sort}
        onSort={toggleSort}
        onOpenPage={openPageDetail}
        comparisonActive={comparisonActive}
        comparisonLabel={dashboardComparisonLabel(messages, comparisonQuery)}
        currentWindow={window}
        comparisonWindow={comparisonQuery?.window}
        searchValue={query}
        searchPlaceholder={messages.common.search}
        onSearchChange={setQuery}
        columnDefinitions={columnDefinitions}
        orderedColumnIds={pageColumns.orderedIds}
        visibleColumnIds={pageColumns.visibleIds}
        onColumnOrderChange={pageColumns.setOrder}
        onColumnVisibilityChange={pageColumns.setVisible}
        onColumnReset={pageColumns.reset}
        columnSettingsLabels={messages.common.tableColumns}
        loading={loadingInitial}
        loadingMore={loadingMore}
        error={error}
        errorContent={messages.pages.loadError}
        emptyContent={messages.pages.empty}
        appendError={appendError}
        appendErrorContent={messages.pages.loadMoreError}
        hasMore={hasMore}
        skeletonRows={PAGE_LIST_PAGE_SIZE}
        onLoadMore={loadNextPage}
      />

      {detailPagePath ? (
        <PageDetailDrawer
          locale={locale}
          messages={messages}
          siteId={siteId}
          siteDomain={siteDomain ?? ""}
          pathname={sitePathname ?? pathname}
          pagePath={detailPagePath}
          onOpenChange={(open) => {
            if (!open) closePageDetail();
          }}
        />
      ) : null}
    </div>
  );
}
