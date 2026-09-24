import { memo, useMemo } from "react";
import { RiCloseLine } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

import {
  AsyncDimensionBreakdownCard,
  type AsyncDimensionBreakdownLoader,
} from "@/components/dashboard/common/async-dimension-breakdown-card";
import { useDetailDrawerClose } from "@/components/dashboard/site-pages/common/detail-query-modal";
import { useDashboardQuery } from "@/components/dashboard/site-pages/common/use-dashboard-query";
import {
  OverviewMetricsSection,
  OverviewTrendSection,
} from "@/components/dashboard/site-pages/overview/metrics";
import { OverviewPagesSection } from "@/components/dashboard/site-pages/overview/pages-section";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchEventTypesTab,
  fetchOverviewPageCardTab,
  fetchPageHashTab,
  fetchPageQueryTab,
  type OverviewTabRows,
} from "@/lib/dashboard/client/data/index";
import { useLiveSearchParams } from "@/lib/dashboard/client/history";
import { resolveDashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import { setDashboardFilterValue } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import { loadLocalTablePage } from "@/lib/dashboard/table-loader";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
export interface PageDetailClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
  pagePath: string;
  showSourceLinkTab?: boolean;
  inDetailDrawer?: boolean;
}
function buildPageDetailFilters(
  filters: FilterDocument,
  pagePath: string,
): FilterDocument {
  return setDashboardFilterValue(filters, "path", pagePath);
}
function normalizeLabel(value: string, fallback: string): string {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}
function mapOverviewRows(
  rows: OverviewTabRows,
  fallbackLabel: string,
  options?: {
    mono?: boolean;
  },
) {
  return rows.map((row, index) => {
    const label = normalizeLabel(String(row.label ?? ""), fallbackLabel);

    return {
      ...row,
      key: `${label}-${index}`,
      label,
      views: Math.max(0, Number(row.views ?? 0)),
      visitors: Math.max(0, Number(row.visitors ?? 0)),
      mono: options?.mono ?? false,
    };
  });
}
function comparisonLabelForPageDetail(
  messages: AppMessages,
  comparisonQuery: ReturnType<typeof resolveDashboardComparisonQuery>,
  hasComparisonFilter: boolean,
): string {
  return comparisonQuery?.mode === "previous" && !hasComparisonFilter
    ? messages.dashboardHeader.previousPeriod
    : messages.dashboardHeader.compareButton;
}
function eventRowKey(row: OverviewTabRows[number]): string {
  return row.key?.trim() || row.value?.trim() || String(row.label ?? "").trim();
}
function mergeEventRows(
  currentRows: OverviewTabRows,
  comparisonRows: OverviewTabRows,
): OverviewTabRows {
  const currentByKey = new Map(
    currentRows.map((row) => [eventRowKey(row), row]),
  );
  const comparisonByKey = new Map(
    comparisonRows.map((row) => [eventRowKey(row), row]),
  );
  const keys = [
    ...currentRows.map(eventRowKey),
    ...comparisonRows.map(eventRowKey).filter((key) => !currentByKey.has(key)),
  ];

  return keys.map((key) => {
    const current = currentByKey.get(key);
    const comparison = comparisonByKey.get(key);
    const row = current ??
      comparison ?? { label: key, views: 0, sessions: 0, visitors: 0 };
    const views = Math.max(0, Number(current?.views ?? 0));
    const visitors = Math.max(0, Number(current?.visitors ?? 0));
    const referenceViews = Math.max(0, Number(comparison?.views ?? 0));
    const referenceVisitors = Math.max(0, Number(comparison?.visitors ?? 0));
    const relativeChange = (value: number, reference: number) =>
      reference === 0 ? null : (value - reference) / reference;

    return {
      ...row,
      key,
      label: row.label ?? key,
      views,
      visitors,
      reference: {
        views: referenceViews,
        sessions: 0,
        visitors: referenceVisitors,
      },
      change: {
        views: {
          absolute: views - referenceViews,
          relative: relativeChange(views, referenceViews),
        },
        sessions: { absolute: 0, relative: null },
        visitors: {
          absolute: visitors - referenceVisitors,
          relative: relativeChange(visitors, referenceVisitors),
        },
      },
    };
  });
}
export const PageDetailClientPage = memo(function PageDetailClientPage({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
  pagePath,
  showSourceLinkTab,
  inDetailDrawer = false,
}: PageDetailClientPageProps) {
  const drawerClose = useDetailDrawerClose();
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const liveSearchParams = useLiveSearchParams();
  const liveSearchParamsKey = liveSearchParams.toString();
  const hasComparisonFilter = useMemo(
    () =>
      [...new URLSearchParams(liveSearchParamsKey).keys()].some((key) =>
        key.startsWith("compareFilter["),
      ),
    [liveSearchParamsKey],
  );
  const detailFilters = useMemo(
    () => buildPageDetailFilters(filters, pagePath),
    [filters, pagePath],
  );
  const comparisonQuery = useMemo(
    () =>
      resolveDashboardComparisonQuery(
        new URLSearchParams(liveSearchParamsKey),
        window,
        detailFilters,
      ),
    [
      detailFilters,
      liveSearchParamsKey,
      window.from,
      window.interval,
      window.timeZone,
      window.to,
    ],
  );
  const comparisonLabel = comparisonLabelForPageDetail(
    messages,
    comparisonQuery,
    hasComparisonFilter,
  );
  const detailRequestKey = useMemo(
    () =>
      [
        siteId,
        pagePath,
        window.from,
        window.to,
        window.interval,
        JSON.stringify(detailFilters ?? {}),
        comparisonQuery?.mode ?? "none",
        comparisonQuery?.window.from ?? "none",
        comparisonQuery?.window.to ?? "none",
        JSON.stringify(comparisonQuery?.filters ?? null),
      ].join(":"),
    [
      comparisonQuery,
      detailFilters,
      pagePath,
      siteId,
      window.from,
      window.interval,
      window.to,
    ],
  );
  const pageCardFetchers = useMemo(
    () => ({
      path: (
        requestedSiteId: string,
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
        _resolvedScope?: unknown,
        options?: {
          limit?: number;
          cursor?: string | null;
          search?: string;
          sort?: "views" | "visitors" | "sessions";
          direction?: "asc" | "desc";
          comparison?: {
            mode: "same" | "previous";
            window: TimeWindow;
            filters: FilterDocument;
          } | null;
          comparisonMetric?: "views" | "visitors" | "sessions";
          comparisonSortBy?: "current" | "reference" | "change";
          signal?: AbortSignal;
        },
      ) =>
        fetchPageHashTab(requestedSiteId, requestedWindow, requestedFilters, {
          limit: options?.limit ?? 100,
          cursor: options?.cursor,
          search: options?.search,
          sort: options?.sort,
          direction: options?.direction,
          comparison: options?.comparison,
          comparisonMetric: options?.comparisonMetric,
          comparisonSortBy: options?.comparisonSortBy,
          signal: options?.signal,
        }),
      query: (
        requestedSiteId: string,
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
        resolvedScope?: unknown,
        options?: {
          limit?: number;
          cursor?: string | null;
          search?: string;
          sort?: "views" | "visitors" | "sessions";
          direction?: "asc" | "desc";
          comparison?: {
            mode: "same" | "previous";
            window: TimeWindow;
            filters: FilterDocument;
          } | null;
          comparisonMetric?: "views" | "visitors" | "sessions";
          comparisonSortBy?: "current" | "reference" | "change";
          signal?: AbortSignal;
        },
      ) =>
        fetchPageQueryTab(requestedSiteId, requestedWindow, requestedFilters, {
          limit: options?.limit ?? 100,
          cursor: options?.cursor,
          search: options?.search,
          sort: options?.sort,
          direction: options?.direction,
          comparison: options?.comparison,
          comparisonMetric: options?.comparisonMetric,
          comparisonSortBy: options?.comparisonSortBy,
          signal: options?.signal,
          resolvedScope:
            resolvedScope === "event" ||
            resolvedScope === "session" ||
            resolvedScope === "visitor"
              ? resolvedScope
              : undefined,
        }),
    }),
    [],
  );
  const pageCardTabs = useMemo(
    () => ["path", "query", "title", "hostname", "entry", "exit"] as const,
    [],
  );
  const pageCardNavigableTabs = useMemo(
    () => ["path", "query", "hostname", "entry", "exit"] as const,
    [],
  );
  const pageCardDetailTabs = useMemo(() => ["entry", "exit"] as const, []);
  const pageCardTargetUrlResolvers = useMemo(
    () => ({
      path: ({
        tab: _tab,
        value,
        unknownLabel,
        fallbackHostname,
      }: {
        tab: "path" | "query" | "title" | "hostname" | "entry" | "exit";
        value: string;
        unknownLabel: string;
        fallbackHostname: string;
      }) => {
        const normalizedHash = String(value || "").trim();
        if (
          normalizedHash.length === 0 ||
          normalizedHash === messages.pages.noHash ||
          normalizedHash === unknownLabel
        ) {
          return null;
        }

        const normalizedHost = String(siteDomain || fallbackHostname || "")
          .trim()
          .replace(/^[a-z][a-z\d+\-.]*:\/\//i, "")
          .replace(/\/+.*$/, "");
        if (!normalizedHost) return null;

        try {
          const target = new URL(pagePath, `https://${normalizedHost}`);
          target.hash = normalizedHash.startsWith("#")
            ? normalizedHash.slice(1)
            : normalizedHash;
          return target.toString();
        } catch {
          return null;
        }
      },
      query: ({
        tab: _tab,
        value,
        unknownLabel,
        fallbackHostname,
      }: {
        tab: "path" | "query" | "title" | "hostname" | "entry" | "exit";
        value: string;
        unknownLabel: string;
        fallbackHostname: string;
      }) => {
        const normalizedQuery = String(value || "").trim();
        if (
          normalizedQuery.length === 0 ||
          normalizedQuery === messages.pages.noQuery ||
          normalizedQuery === unknownLabel
        ) {
          return null;
        }

        const normalizedHost = String(siteDomain || fallbackHostname || "")
          .trim()
          .replace(/^[a-z][a-z\d+\-.]*:\/\//i, "")
          .replace(/\/+.*$/, "");
        if (!normalizedHost) return null;

        try {
          const target = new URL(pagePath, `https://${normalizedHost}`);
          target.search = normalizedQuery.startsWith("?")
            ? normalizedQuery
            : `?${normalizedQuery}`;
          return target.toString();
        } catch {
          return null;
        }
      },
    }),
    [messages.pages.noHash, messages.pages.noQuery, pagePath, siteDomain],
  );
  const eventTabs = useMemo(
    () =>
      [
        {
          value: "event",
          label: messages.pages.eventTab,
          columnLabel: messages.common.event,
          primaryMetricLabel: messages.pages.eventsMetric,
        },
      ] as const,
    [
      messages.common.event,
      messages.pages.eventTab,
      messages.pages.eventsMetric,
    ],
  );
  const eventLoader = useMemo<AsyncDimensionBreakdownLoader<"event">>(
    () =>
      async ({ cursor, limit, search, signal, sort }) => {
        if (!comparisonQuery) {
          const page = await fetchEventTypesTab(siteId, window, detailFilters, {
            cursor,
            limit,
            search,
            sort: sort.key === "visitors" ? "visitors" : "views",
            direction: sort.direction,
            signal,
          });
          const items = mapOverviewRows(page.items, messages.common.unknown, {
            mono: true,
          });
          return { items, pagination: page.pagination };
        }

        const requestOptions = {
          limit: 200,
          signal,
          sort: "views" as const,
          direction: "desc" as const,
        };
        const [currentPage, comparisonPage] = await Promise.all([
          fetchEventTypesTab(siteId, window, detailFilters, requestOptions),
          fetchEventTypesTab(
            siteId,
            comparisonQuery.window,
            comparisonQuery.filters,
            requestOptions,
          ),
        ]);
        const items = mapOverviewRows(
          mergeEventRows(currentPage.items, comparisonPage.items),
          messages.common.unknown,
          { mono: true },
        );

        return loadLocalTablePage({
          rows: items,
          sort,
          columns: [
            { key: "views", getValue: (row) => row.views },
            { key: "visitors", getValue: (row) => row.visitors },
            { key: "current", getValue: (row) => row.views },
            {
              key: "reference",
              getValue: (row) => row.reference?.views ?? 0,
            },
            {
              key: "change",
              getValue: (row) => row.change?.views.relative ?? -Infinity,
            },
          ],
          tab: "event",
          limit,
          cursor,
          search,
          getSearchText: (row) => row.label,
        });
      },
    [comparisonQuery, detailFilters, messages.common.unknown, siteId, window],
  );

  const { data: titleRows, isFetching: titlesLoading } = useQuery({
    queryKey: ["dashboard", "page-detail-titles", detailRequestKey],
    queryFn: ({ signal }) =>
      fetchOverviewPageCardTab(siteId, window, "title", detailFilters, {
        limit: 3,
        signal,
      }),
    enabled: typeof window !== "undefined",
  });
  const titles = useMemo(
    () =>
      (titleRows?.items ?? [])
        .map((row) => String(row.label ?? "").trim())
        .filter((value) => value.length > 0)
        .slice(0, 3),
    [titleRows],
  );

  const displayPagePath = decodeUrlDisplayValue(pagePath);
  const primaryTitle = titles[0] ?? displayPagePath;
  const alternateTitles = titles.slice(1, 3);

  return (
    <div
      className={
        inDetailDrawer
          ? "mx-auto w-full max-w-[1400px] space-y-6 p-4 md:p-6"
          : "space-y-6"
      }
    >
      <div className="relative flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <AutoResizer
          className={drawerClose ? "min-w-0 flex-1 pr-10" : "min-w-0 flex-1"}
          duration={0.24}
        >
          <AutoTransition
            initial={false}
            duration={0.22}
            type="fade"
            className="w-full"
          >
            <div
              key={
                titlesLoading
                  ? "page-detail-heading-loading"
                  : `page-detail-heading-${primaryTitle}-${alternateTitles.join("|")}`
              }
              className="space-y-1.5"
            >
              {titlesLoading ? (
                <div className="space-y-2.5">
                  <Skeleton className="h-8 w-[min(28rem,85%)]" />
                  <Skeleton className="h-4 w-[min(34rem,92%)]" />
                  <div className="flex flex-wrap gap-x-3 gap-y-2">
                    <Skeleton className="h-3 w-40" />
                    <Skeleton className="h-3 w-36" />
                  </div>
                </div>
              ) : (
                <>
                  <h1 className="text-2xl font-semibold tracking-tight">
                    {primaryTitle}
                  </h1>
                  <p className="break-all font-mono text-sm text-muted-foreground">
                    {displayPagePath}
                  </p>
                  {alternateTitles.length > 0 ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {alternateTitles.map((title) => (
                        <span key={title}>{title}</span>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </AutoTransition>
        </AutoResizer>
        {drawerClose ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0"
            aria-label={messages.common.close}
            onClick={drawerClose}
          >
            <RiCloseLine />
          </Button>
        ) : null}
      </div>

      <OverviewMetricsSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={detailFilters}
      />

      <OverviewTrendSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        window={window}
        filters={detailFilters}
      />

      <OverviewPagesSection
        locale={locale}
        messages={messages}
        siteId={siteId}
        siteDomain={siteDomain}
        pathname={pathname}
        filters={detailFilters}
        showSourceLinkTab={showSourceLinkTab}
        pageCardTabs={pageCardTabs}
        pageCardFetchers={pageCardFetchers}
        pageCardNavigableTabs={pageCardNavigableTabs}
        pageCardDetailTabs={pageCardDetailTabs}
        pageCardTargetUrlResolvers={pageCardTargetUrlResolvers}
        pageCardFilterEnabledOverride={{ path: false, query: false }}
        pageCardTabMetaOverride={{
          path: {
            label: messages.pages.hashTab,
            columnLabel: messages.pages.hashTab,
            mono: true,
            showIcon: false,
          },
          query: {
            label: messages.pages.queryTab,
            columnLabel: messages.pages.queryTab,
            mono: true,
            showIcon: false,
          },
        }}
        geoPageBasePathname={pathname}
      />

      <AsyncDimensionBreakdownCard
        locale={locale}
        messages={messages}
        tabs={eventTabs}
        requestKey={`${detailRequestKey}:event`}
        loader={eventLoader}
        comparisonLabel={comparisonQuery ? comparisonLabel : undefined}
        comparisonCurrentLabel={messages.pages.eventsMetric}
      />
    </div>
  );
});
