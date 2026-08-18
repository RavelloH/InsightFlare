import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { AsyncDimensionBreakdownCard } from "@/components/dashboard/async-dimension-breakdown-card";
import {
  OverviewMetricsSection,
  OverviewPagesSection,
  OverviewTrendSection,
} from "@/components/dashboard/site-pages/overview-client-page";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchEventTypesTab,
  fetchOverviewPageCardTab,
  fetchPageHashTab,
  fetchPageQueryTab,
  type OverviewTabRows,
} from "@/lib/dashboard/client-data";
import { setDashboardFilterValue } from "@/lib/dashboard/filter-state";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface PageDetailClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  siteDomain: string;
  pathname: string;
  pagePath: string;
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
      key: `${label}-${index}`,
      label,
      views: Math.max(0, Number(row.views ?? 0)),
      visitors: Math.max(0, Number(row.visitors ?? 0)),
      mono: options?.mono ?? false,
    };
  });
}

export function PageDetailClientPage({
  locale,
  messages,
  siteId,
  siteDomain,
  pathname,
  pagePath,
}: PageDetailClientPageProps) {
  const { filters, window } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const detailFilters = useMemo(
    () => buildPageDetailFilters(filters, pagePath),
    [filters, pagePath],
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
      ].join(":"),
    [detailFilters, pagePath, siteId, window.from, window.interval, window.to],
  );
  const pageCardFetchers = useMemo(
    () => ({
      path: (
        requestedSiteId: string,
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ) =>
        fetchPageHashTab(requestedSiteId, requestedWindow, requestedFilters, {
          limit: 100,
        }),
      query: (
        requestedSiteId: string,
        requestedWindow: TimeWindow,
        requestedFilters: FilterDocument,
      ) =>
        fetchPageQueryTab(requestedSiteId, requestedWindow, requestedFilters, {
          limit: 100,
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
      (titleRows ?? [])
        .map((row) => String(row.label ?? "").trim())
        .filter((value) => value.length > 0)
        .slice(0, 3),
    [titleRows],
  );

  const displayPagePath = decodeUrlDisplayValue(pagePath);
  const primaryTitle = titles[0] ?? displayPagePath;
  const alternateTitles = titles.slice(1, 3);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <AutoResizer className="min-w-0 flex-1" duration={0.24}>
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
        pageCardTabs={pageCardTabs}
        pageCardFetchers={pageCardFetchers}
        pageCardNavigableTabs={pageCardNavigableTabs}
        pageCardDetailTabs={pageCardDetailTabs}
        pageCardTargetUrlResolvers={pageCardTargetUrlResolvers}
        pageCardQueryParamOverride={{ path: null, query: null }}
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
        loadRows={async () =>
          mapOverviewRows(
            await fetchEventTypesTab(siteId, window, detailFilters, {
              limit: 100,
            }),
            messages.common.unknown,
            { mono: true },
          )
        }
      />
    </div>
  );
}
