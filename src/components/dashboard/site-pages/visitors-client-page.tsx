import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiSearchLine,
} from "@remixicon/react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { AnalyticsDataTable } from "@/components/dashboard/analytics-data-table";
import {
  type AnalyticsTableColumnDefinition,
  AnalyticsTableColumnSettings,
  useAnalyticsTableColumns,
} from "@/components/dashboard/analytics-table-column-settings";
import {
  AnalyticsDetailsTooltipTarget,
  AnalyticsTimeTooltipTarget,
} from "@/components/dashboard/analytics-time-tooltip";
import { ClickableTableCell } from "@/components/dashboard/clickable-table-cell";
import {
  BrowserMeta,
  CountryRegionMeta,
  DeviceMeta,
  formatRelativeTime,
  formatScreen,
  OsMeta,
  ReferrerMeta,
  VisitorAvatar,
} from "@/components/dashboard/journey-display";
import { PageHeading } from "@/components/dashboard/page-heading";
import {
  DETAIL_QUERY_PARAM,
  DetailDrawer,
} from "@/components/dashboard/site-pages/detail-query-modal";
import { SessionDetailClientPage } from "@/components/dashboard/site-pages/session-detail-client-page";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { VisitorDetailClientPage } from "@/components/dashboard/site-pages/visitor-detail-client-page";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import { fetchVisitors } from "@/lib/dashboard/client-data";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import { numberFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { VisitorsData } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

interface VisitorsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

type VisitorRow = VisitorsData["data"][number];

const VISITOR_PAGE_SIZE = 50;
const VISITOR_SKELETON_ROWS = 25;

type SortDirection = "asc" | "desc";
type VisitorSortKey = "firstSeenAt" | "lastSeenAt" | "sessions" | "views";

interface VisitorSortState {
  key: VisitorSortKey;
  direction: SortDirection;
}

type VisitorTableColumnId =
  | "visitor"
  | "sessionId"
  | "firstSeen"
  | "lastSeen"
  | "sessions"
  | "pageViews"
  | "customEvents"
  | "referrer"
  | "location"
  | "os"
  | "browser"
  | "device"
  | "screenSize";

const DEFAULT_VISITOR_SORT: VisitorSortState = {
  key: "lastSeenAt",
  direction: "desc",
};

type NestedJourneyDetail = {
  kind: "session" | "visitor";
  id: string;
  stackKey: string;
};

function VisitorRowSkeletonContent({
  index,
  columns,
}: {
  index: number;
  columns: readonly VisitorTableColumnId[];
}) {
  const widths: Record<VisitorTableColumnId, string> = {
    visitor: "w-24",
    sessionId: "w-24",
    firstSeen: "w-20",
    lastSeen: "w-20",
    sessions: "w-12",
    pageViews: "w-10",
    customEvents: "w-10",
    referrer: "w-24",
    location: "w-28",
    os: "w-24",
    browser: "w-24",
    device: "w-20",
    screenSize: "w-20",
  };

  return (
    <>
      {columns.map((columnId) => (
        <TableCell
          key={`${index}-${columnId}`}
          className={columnId === "visitor" ? "pl-4" : undefined}
        >
          {columnId === "visitor" ? (
            <div className="flex items-center gap-2">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-20" />
            </div>
          ) : (
            <Skeleton
              className={cn(
                "h-4",
                widths[columnId],
                columnId === "sessions" && "ml-auto",
                ["pageViews", "customEvents"].includes(columnId) && "ml-auto",
                ["firstSeen", "lastSeen", "screenSize"].includes(columnId) &&
                  "mx-auto",
              )}
            />
          )}
        </TableCell>
      ))}
    </>
  );
}

function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction: SortDirection;
}) {
  if (active) {
    return direction === "desc" ? (
      <RiArrowDownSLine className="size-3.5" />
    ) : (
      <RiArrowUpSLine className="size-3.5" />
    );
  }

  return (
    <span className="inline-flex flex-col leading-none text-muted-foreground">
      <RiArrowUpSLine className="-mb-1 size-3.5" />
      <RiArrowDownSLine className="-mt-1 size-3.5" />
    </span>
  );
}

function SortHeader({
  label,
  ariaLabel,
  active,
  direction,
  onClick,
  align = "left",
  className,
}: {
  label: string;
  ariaLabel?: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
  align?: "left" | "center" | "right";
  className?: string;
}) {
  return (
    <TableHead
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : "none"
      }
      className={className}
    >
      <div
        className={cn(
          "flex",
          align === "center" && "justify-center",
          align === "right" && "justify-end",
        )}
      >
        <button
          type="button"
          aria-label={ariaLabel ?? label}
          title={ariaLabel ?? label}
          className={cn(
            "inline-flex items-center gap-1 whitespace-nowrap transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            active ? "text-foreground" : "text-muted-foreground",
          )}
          onClick={onClick}
        >
          {label}
          <SortIndicator active={active} direction={direction} />
        </button>
      </div>
    </TableHead>
  );
}

function appendUniqueVisitors(
  current: VisitorRow[],
  incoming: VisitorRow[],
): VisitorRow[] {
  if (current.length === 0) return incoming;
  const seen = new Set(current.map((row) => row.visitorId));
  const nextRows = incoming.filter((row) => !seen.has(row.visitorId));
  return nextRows.length > 0 ? [...current, ...nextRows] : current;
}

function VisitorIdValue({ value }: { value?: string }) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return <span className="font-mono text-muted-foreground">/</span>;
  }
  return (
    <span className="block truncate font-mono font-medium">{normalized}</span>
  );
}

const VisitorTableRowContent = memo(function VisitorTableRowContent({
  locale,
  messages,
  labels,
  row,
  now,
  onOpenDetail,
  columns,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: AppMessages["visitors"];
  row: VisitorRow;
  now: number;
  onOpenDetail: (visitorId: string) => void;
  columns: readonly VisitorTableColumnId[];
}) {
  const openDetail = () => onOpenDetail(row.visitorId);
  const visitorId = row.visitorId.trim();
  const referrerHost = String(row.referrerHost || "").trim();
  const referrerUrl = String(row.referrerUrl || "").trim();
  const referrerDetails = {
    key: `visitor-referrer:${visitorId}:${referrerHost}:${referrerUrl}`,
    items:
      referrerHost || referrerUrl
        ? [
            ...(referrerHost
              ? [
                  {
                    label: messages.common.referrerHost,
                    value: referrerHost,
                    copyValue: referrerHost,
                  },
                ]
              : []),
            ...(referrerUrl
              ? [
                  {
                    label: messages.sessionDetail.referrerUrl,
                    value: referrerUrl,
                    copyValue: referrerUrl,
                  },
                ]
              : []),
          ]
        : [
            {
              label: messages.common.referrer,
              value: messages.overview.direct,
            },
          ],
  };

  const cells: Record<VisitorTableColumnId, ReactNode> = {
    visitor: (
      <ClickableTableCell
        onClick={openDetail}
        className="w-32"
        buttonClassName="pl-4"
        focusable
        ariaLabel={`${labels.visitor}: ${row.visitorId}`}
      >
        <div className="flex w-28 items-center gap-2">
          <VisitorAvatar seed={row.visitorId} className="size-6" />
          <AnalyticsDetailsTooltipTarget
            locale={locale}
            request={{
              key: `visitor-id:${visitorId}`,
              items: [
                {
                  label: messages.visitorDetail.visitorId,
                  value: visitorId || messages.common.unknown,
                  copyValue: visitorId || undefined,
                  action: visitorId
                    ? {
                        label: messages.common.search,
                        onClick: openDetail,
                      }
                    : undefined,
                },
              ],
            }}
          >
            <span className="truncate">{labels.anonymous}</span>
          </AnalyticsDetailsTooltipTarget>
        </div>
      </ClickableTableCell>
    ),
    sessionId: (
      <ClickableTableCell onClick={openDetail} className="max-w-32">
        <div className="flex min-w-0 items-center gap-1">
          <AnalyticsDetailsTooltipTarget
            className="min-w-0 flex-1 truncate"
            locale={locale}
            request={{
              key: `visitor-id-column:${visitorId}`,
              items: [
                {
                  label: messages.visitorDetail.visitorId,
                  value: visitorId || messages.common.unknown,
                  copyValue: visitorId || undefined,
                  action: visitorId
                    ? {
                        label: messages.common.search,
                        onClick: openDetail,
                      }
                    : undefined,
                },
              ],
            }}
          >
            <VisitorIdValue value={visitorId} />
          </AnalyticsDetailsTooltipTarget>
        </div>
      </ClickableTableCell>
    ),
    firstSeen: (
      <ClickableTableCell
        onClick={openDetail}
        className="text-center font-mono text-muted-foreground"
      >
        <AnalyticsTimeTooltipTarget
          className="block"
          locale={locale}
          timestamp={row.firstSeenAt}
        >
          {formatRelativeTime(locale, row.firstSeenAt, now)}
        </AnalyticsTimeTooltipTarget>
      </ClickableTableCell>
    ),
    lastSeen: (
      <ClickableTableCell
        onClick={openDetail}
        className="text-center font-mono text-muted-foreground"
      >
        <AnalyticsTimeTooltipTarget
          className="block"
          locale={locale}
          timestamp={row.lastSeenAt}
        >
          {formatRelativeTime(locale, row.lastSeenAt, now)}
        </AnalyticsTimeTooltipTarget>
      </ClickableTableCell>
    ),
    sessions: (
      <ClickableTableCell
        onClick={openDetail}
        className="text-right font-mono tabular-nums"
      >
        {numberFormat(locale, row.sessions)}
      </ClickableTableCell>
    ),
    pageViews: (
      <ClickableTableCell onClick={openDetail} className="text-right">
        <span className="font-mono tabular-nums">
          {numberFormat(locale, row.views)}
        </span>
      </ClickableTableCell>
    ),
    customEvents: (
      <ClickableTableCell onClick={openDetail} className="text-right">
        <span className="font-mono tabular-nums">
          {numberFormat(locale, row.events ?? 0)}
        </span>
      </ClickableTableCell>
    ),
    referrer: (
      <ClickableTableCell onClick={openDetail} className="max-w-48">
        <AnalyticsDetailsTooltipTarget
          className="block"
          locale={locale}
          request={referrerDetails}
        >
          <ReferrerMeta
            referrerHost={row.referrerHost || ""}
            referrerUrl={row.referrerUrl}
            directLabel={messages.overview.direct}
          />
        </AnalyticsDetailsTooltipTarget>
      </ClickableTableCell>
    ),
    location: (
      <ClickableTableCell onClick={openDetail} className="max-w-52">
        <AnalyticsDetailsTooltipTarget
          className="block"
          locale={locale}
          request={{
            key: `visitor-location:${visitorId}:${row.country}:${row.region}:${row.regionCode}:${row.city}`,
            items: [
              {
                label: messages.common.location,
                value: (
                  <CountryRegionMeta
                    locale={locale}
                    messages={messages}
                    country={row.country || ""}
                    region={row.region}
                    regionCode={row.regionCode}
                    city={row.city}
                    className="max-w-none text-background [&_.text-foreground]:text-background"
                  />
                ),
              },
            ],
          }}
        >
          <CountryRegionMeta
            locale={locale}
            messages={messages}
            country={row.country || ""}
            region={row.region}
            regionCode={row.regionCode}
          />
        </AnalyticsDetailsTooltipTarget>
      </ClickableTableCell>
    ),
    os: (
      <ClickableTableCell onClick={openDetail} className="max-w-40">
        <OsMeta
          os={row.os || ""}
          version={row.osVersion}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
    ),
    browser: (
      <ClickableTableCell onClick={openDetail} className="max-w-40">
        <BrowserMeta
          browser={row.browser || ""}
          version={row.browserVersion}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
    ),
    device: (
      <ClickableTableCell
        onClick={openDetail}
        className="max-w-36"
        buttonClassName="pr-4"
      >
        <DeviceMeta
          deviceType={row.deviceType || ""}
          deviceLabels={messages.common.deviceLabels}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
    ),
    screenSize: (
      <ClickableTableCell
        onClick={openDetail}
        className="pr-4 text-center font-mono"
      >
        {formatScreen(row.screenWidth, row.screenHeight)}
      </ClickableTableCell>
    ),
  };

  return (
    <>
      {columns.map((columnId) => (
        <Fragment key={columnId}>{cells[columnId]}</Fragment>
      ))}
    </>
  );
});

function detailQueryTarget(
  pathname: string,
  searchParams: URLSearchParams,
  detailId: string,
): string {
  const params = new URLSearchParams(searchParams.toString());
  params.set(DETAIL_QUERY_PARAM, detailId);
  params.delete("visitorId");
  params.delete("sessionId");
  const query = serializeDashboardSearchParams(params);
  return query ? `${pathname}?${query}` : pathname;
}

const VisitorAnalyticsTable = memo(function VisitorAnalyticsTable({
  locale,
  messages,
  labels,
  rows,
  now,
  columns,
  sort,
  onToggleSort,
  onOpenDetail,
  loading,
  loadingMore,
  error,
  errorContent,
  emptyContent,
  appendError,
  appendErrorContent,
  hasMore,
  onLoadMore,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: AppMessages["visitors"];
  rows: readonly VisitorRow[];
  now: number;
  columns: readonly VisitorTableColumnId[];
  sort: VisitorSortState;
  onToggleSort: (key: VisitorSortKey) => void;
  onOpenDetail: (visitorId: string) => void;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  errorContent: string;
  emptyContent: string;
  appendError: boolean;
  appendErrorContent: string;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const headers = useMemo<Record<VisitorTableColumnId, ReactNode>>(
    () => ({
      visitor: <TableHead className="w-32 pl-4">{labels.visitor}</TableHead>,
      sessionId: <TableHead>{messages.visitorDetail.visitorId}</TableHead>,
      firstSeen: (
        <SortHeader
          label={labels.firstSeen}
          ariaLabel={formatI18nTemplate(messages.common.sortBy, {
            label: labels.firstSeen,
          })}
          active={sort.key === "firstSeenAt"}
          direction={sort.direction}
          onClick={() => onToggleSort("firstSeenAt")}
          align="center"
          className="text-center"
        />
      ),
      lastSeen: (
        <SortHeader
          label={labels.lastSeen}
          ariaLabel={formatI18nTemplate(messages.common.sortBy, {
            label: labels.lastSeen,
          })}
          active={sort.key === "lastSeenAt"}
          direction={sort.direction}
          onClick={() => onToggleSort("lastSeenAt")}
          align="center"
          className="text-center"
        />
      ),
      sessions: (
        <SortHeader
          label={labels.sessions}
          ariaLabel={formatI18nTemplate(messages.common.sortBy, {
            label: labels.sessions,
          })}
          active={sort.key === "sessions"}
          direction={sort.direction}
          onClick={() => onToggleSort("sessions")}
          align="right"
          className="text-right"
        />
      ),
      pageViews: (
        <SortHeader
          label={labels.pageViews}
          ariaLabel={formatI18nTemplate(messages.common.sortBy, {
            label: labels.pageViews,
          })}
          active={sort.key === "views"}
          direction={sort.direction}
          onClick={() => onToggleSort("views")}
          align="right"
          className="text-right"
        />
      ),
      customEvents: (
        <TableHead className="text-right">{labels.customEvents}</TableHead>
      ),
      referrer: <TableHead>{labels.referrer}</TableHead>,
      location: <TableHead>{labels.location}</TableHead>,
      os: <TableHead>{labels.os}</TableHead>,
      browser: <TableHead>{labels.browser}</TableHead>,
      device: <TableHead className="pr-4">{labels.device}</TableHead>,
      screenSize: (
        <TableHead className="pr-4 text-center">{labels.screenSize}</TableHead>
      ),
    }),
    [
      labels,
      messages.common.sortBy,
      messages.visitorDetail.visitorId,
      onToggleSort,
      sort,
    ],
  );
  const header = useMemo(
    () => (
      <TableRow>
        {columns.map((columnId) => (
          <Fragment key={columnId}>{headers[columnId]}</Fragment>
        ))}
      </TableRow>
    ),
    [columns, headers],
  );
  const renderRow = useCallback(
    (row: VisitorRow) => ({
      children: (
        <VisitorTableRowContent
          locale={locale}
          messages={messages}
          labels={labels}
          row={row}
          now={now}
          onOpenDetail={onOpenDetail}
          columns={columns}
        />
      ),
      props: { className: "cursor-pointer" },
    }),
    [columns, labels, locale, messages, now, onOpenDetail],
  );
  const renderSkeletonRow = useCallback(
    (index: number) => (
      <VisitorRowSkeletonContent index={index} columns={columns} />
    ),
    [columns],
  );
  const getRowKey = useCallback((row: VisitorRow) => row.visitorId, []);

  return (
    <AnalyticsDataTable
      header={header}
      rows={rows}
      renderRow={renderRow}
      renderSkeletonRow={renderSkeletonRow}
      getRowKey={getRowKey}
      skeletonRows={VISITOR_SKELETON_ROWS}
      columnCount={columns.length}
      loading={loading}
      loadingMore={loadingMore}
      error={error}
      errorContent={errorContent}
      emptyContent={emptyContent}
      appendError={appendError}
      appendErrorContent={appendErrorContent}
      enableTimeTooltips
      messages={messages}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
    />
  );
});

export function VisitorsClientPage({
  locale,
  messages,
  siteId,
  pathname,
}: VisitorsClientPageProps) {
  const labels = messages.visitors;
  const visitorColumnDefinitions = useMemo<
    readonly AnalyticsTableColumnDefinition<VisitorTableColumnId>[]
  >(
    () => [
      { id: "visitor", label: labels.visitor, required: true },
      { id: "sessionId", label: messages.visitorDetail.visitorId },
      { id: "firstSeen", label: labels.firstSeen },
      { id: "lastSeen", label: labels.lastSeen },
      { id: "sessions", label: labels.sessions },
      { id: "pageViews", label: labels.pageViews },
      { id: "customEvents", label: labels.customEvents },
      { id: "referrer", label: labels.referrer },
      { id: "location", label: labels.location },
      { id: "os", label: labels.os },
      { id: "browser", label: labels.browser },
      { id: "device", label: labels.device },
      { id: "screenSize", label: labels.screenSize },
    ],
    [labels, messages.visitorDetail.visitorId],
  );
  const visitorColumns = useAnalyticsTableColumns({
    storageKey: "insightflare:analytics-table-columns:visitors",
    columns: visitorColumnDefinitions,
  });
  const { filters, window: timeWindow } = useDashboardQuery() as {
    filters: FilterDocument;
    window: TimeWindow;
  };
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<VisitorSortState>(DEFAULT_VISITOR_SORT);
  const [now, setNow] = useState(() => Date.now());
  const searchParams = useLiveSearchParams();
  const detailVisitorId = searchParams.get(DETAIL_QUERY_PARAM)?.trim() || "";
  const [nestedDetails, setNestedDetails] = useState<NestedJourneyDetail[]>([]);
  const nestedDetailKeyRef = useRef(0);
  const openedDetailFromListRef = useRef(false);
  const filtersKey = useMemo(() => JSON.stringify(filters ?? {}), [filters]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!detailVisitorId) {
      openedDetailFromListRef.current = false;
      setNestedDetails([]);
    }
  }, [detailVisitorId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  const {
    data,
    error: queryError,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetching,
    isFetchingNextPage,
    isPending,
  } = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "visitors",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.timeZone,
      filtersKey,
      debouncedQuery,
      sort.key,
      sort.direction,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchVisitors(siteId, timeWindow, filters, {
        cursor: pageParam,
        pageSize: VISITOR_PAGE_SIZE,
        sortBy: sort.key,
        sortDir: sort.direction,
        search: debouncedQuery,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.meta.hasMore ? lastPage.meta.nextCursor : undefined,
    enabled: typeof window !== "undefined",
  });
  const rows = useMemo(
    () =>
      data?.pages.reduce<VisitorRow[]>(
        (current, page) => appendUniqueVisitors(current, page.data),
        [],
      ) ?? [],
    [data?.pages],
  );
  const loadingInitial = isPending;
  const loadingMore = isFetchingNextPage;
  const error = Boolean(queryError) && rows.length === 0;
  const appendError = isFetchNextPageError;
  const replacingRows = isPending || (isFetching && !isFetchingNextPage);
  const hasMore = hasNextPage ?? false;
  const loadNextPage = useCallback(() => {
    if (loadingInitial || loadingMore || appendError || !hasMore) return;
    void fetchNextPage();
  }, [appendError, fetchNextPage, hasMore, loadingInitial, loadingMore]);

  const toggleSort = useCallback((key: VisitorSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key, direction: "desc" },
    );
  }, []);

  const openVisitorDetail = useCallback(
    (visitorId: string) => {
      openedDetailFromListRef.current = true;
      pushUrlWithoutNavigation(
        detailQueryTarget(pathname, searchParams, visitorId),
      );
    },
    [pathname, searchParams],
  );
  const openVisitorDetailRef = useRef(openVisitorDetail);
  openVisitorDetailRef.current = openVisitorDetail;
  const stableOpenVisitorDetail = useCallback((visitorId: string) => {
    openVisitorDetailRef.current(visitorId);
  }, []);

  const closeVisitorDetail = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has(DETAIL_QUERY_PARAM)) return;

    if (openedDetailFromListRef.current) {
      openedDetailFromListRef.current = false;
      window.history.back();
      return;
    }

    params.delete(DETAIL_QUERY_PARAM);
    const query = serializeDashboardSearchParams(params);
    replaceUrlWithoutNavigation(query ? `${pathname}?${query}` : pathname);
  }, [pathname]);
  const sessionsPathname = useMemo(
    () => pathname.replace(/\/visitors(?:\/detail)?$/, "/sessions"),
    [pathname],
  );
  const openNestedDetail = useCallback(
    (kind: NestedJourneyDetail["kind"], id: string) => {
      const normalizedId = id.trim();
      if (!normalizedId) return;

      setNestedDetails((current) => {
        const topDetail = current.at(-1);
        if (topDetail?.kind === kind && topDetail.id === normalizedId) {
          return current;
        }
        nestedDetailKeyRef.current += 1;
        return [
          ...current,
          {
            kind,
            id: normalizedId,
            stackKey: `${kind}:${normalizedId}:${nestedDetailKeyRef.current}`,
          },
        ];
      });
    },
    [],
  );
  const openNestedSession = useCallback(
    (sessionId: string) => openNestedDetail("session", sessionId),
    [openNestedDetail],
  );
  const openNestedVisitor = useCallback(
    (visitorId: string) => openNestedDetail("visitor", visitorId),
    [openNestedDetail],
  );
  const closeNestedDetail = useCallback((stackKey: string) => {
    setNestedDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      return index < 0 ? current : current.slice(0, index);
    });
  }, []);

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.visitors.title}
        subtitle={messages.visitors.subtitle}
        actions={
          <div className="flex w-full items-center justify-end gap-2">
            <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
              <RiSearchLine className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={labels.search}
                className="pl-8"
              />
            </div>
            <AnalyticsTableColumnSettings
              columns={visitorColumnDefinitions}
              orderedIds={visitorColumns.orderedIds}
              visibleIds={visitorColumns.visibleIds}
              onOrderChange={visitorColumns.setOrder}
              onVisibilityChange={visitorColumns.setVisible}
              onReset={visitorColumns.reset}
              labels={messages.common.tableColumns}
            />
          </div>
        }
      />

      <VisitorAnalyticsTable
        locale={locale}
        messages={messages}
        labels={labels}
        rows={rows}
        now={now}
        columns={visitorColumns.visibleIds}
        sort={sort}
        onToggleSort={toggleSort}
        onOpenDetail={stableOpenVisitorDetail}
        loading={replacingRows}
        loadingMore={loadingMore}
        error={error}
        errorContent={labels.loadError}
        emptyContent={labels.empty}
        appendError={appendError}
        appendErrorContent={labels.loadError}
        hasMore={hasMore}
        onLoadMore={loadNextPage}
      />

      {detailVisitorId ? (
        <DetailDrawer
          ariaLabel={messages.visitors.title}
          drawerKey={`visitor:${detailVisitorId}`}
          open={Boolean(detailVisitorId)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) closeVisitorDetail();
          }}
        >
          <VisitorDetailClientPage
            locale={locale}
            messages={messages}
            siteId={siteId}
            pathname={pathname}
            visitorId={detailVisitorId}
            onOpenSession={openNestedSession}
          />
        </DetailDrawer>
      ) : null}

      {nestedDetails.map((nestedDetail) => (
        <DetailDrawer
          key={nestedDetail.stackKey}
          ariaLabel={
            nestedDetail.kind === "visitor"
              ? messages.visitors.title
              : messages.sessionDetail.visitDetailsTitle
          }
          drawerKey={nestedDetail.stackKey}
          open
          onOpenChange={(nextOpen) => {
            if (!nextOpen) closeNestedDetail(nestedDetail.stackKey);
          }}
        >
          {nestedDetail.kind === "visitor" ? (
            <VisitorDetailClientPage
              locale={locale}
              messages={messages}
              siteId={siteId}
              pathname={pathname}
              visitorId={nestedDetail.id}
              onOpenSession={openNestedSession}
            />
          ) : (
            <SessionDetailClientPage
              locale={locale}
              messages={messages}
              siteId={siteId}
              pathname={sessionsPathname}
              sessionId={nestedDetail.id}
              onOpenVisitor={openNestedVisitor}
            />
          )}
        </DetailDrawer>
      ))}
    </div>
  );
}
