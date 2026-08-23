import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiSearchLine,
} from "@remixicon/react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { AnalyticsTableCard } from "@/components/dashboard/analytics-table-card";
import { ClickableTableCell } from "@/components/dashboard/clickable-table-cell";
import {
  BrowserMeta,
  CountryRegionMeta,
  DeviceMeta,
  formatRelativeTime,
  OsMeta,
  ReferrerMeta,
  VisitorAvatar,
} from "@/components/dashboard/journey-display";
import { PageHeading } from "@/components/dashboard/page-heading";
import {
  DETAIL_QUERY_PARAM,
  DetailDrawer,
} from "@/components/dashboard/site-pages/detail-query-modal";
import { useDashboardQuery } from "@/components/dashboard/site-pages/use-dashboard-query";
import { useInfiniteTableSentinel } from "@/components/dashboard/use-infinite-table-sentinel";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  pushUrlWithoutNavigation,
  replaceUrlWithoutNavigation,
  useLiveSearchParams,
} from "@/lib/client-history";
import { fetchVisitors } from "@/lib/dashboard/client-data";
import { serializeDashboardSearchParams } from "@/lib/dashboard/filter-state";
import { numberFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import dynamic from "@/lib/dynamic";
import type { VisitorsData } from "@/lib/edge-client";
import type { FilterDocument } from "@/lib/filter-contract";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

interface VisitorsClientPageProps {
  locale: Locale;
  messages: AppMessages;
  siteId: string;
  pathname: string;
}

type VisitorRow = VisitorsData["data"][number];

const VISITOR_PAGE_SIZE = 50;
const VISITOR_SKELETON_ROWS = 8;

const VisitorDetailClientPage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/visitor-detail-client-page").then(
      (module) => module.VisitorDetailClientPage,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    ),
  },
);

const SessionDetailClientPage = dynamic(
  () =>
    import("@/components/dashboard/site-pages/session-detail-client-page").then(
      (module) => module.SessionDetailClientPage,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="p-6 text-sm text-muted-foreground">Loading...</div>
    ),
  },
);

type SortDirection = "asc" | "desc";
type VisitorSortKey = "firstSeenAt" | "lastSeenAt" | "sessions" | "views";

interface VisitorSortState {
  key: VisitorSortKey;
  direction: SortDirection;
}

const DEFAULT_VISITOR_SORT: VisitorSortState = {
  key: "lastSeenAt",
  direction: "desc",
};

type NestedJourneyDetail = {
  kind: "session" | "visitor";
  id: string;
  stackKey: string;
};

function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 9)}...`;
}

function VisitorRowSkeleton({
  index,
  sentinelRef,
}: {
  index: number;
  sentinelRef?: (node: HTMLTableRowElement | null) => void;
}) {
  const widths = [
    "w-24",
    "w-24",
    "w-20",
    "w-20",
    "w-12",
    "w-10",
    "w-24",
    "w-28",
    "w-24",
    "w-24",
    "w-20",
  ];

  return (
    <TableRow ref={sentinelRef} aria-hidden="true">
      {widths.map((width, cellIndex) => (
        <TableCell
          key={`${index}-${cellIndex}`}
          className={cellIndex === 0 ? "pl-4" : undefined}
        >
          {cellIndex === 0 ? (
            <div className="flex items-center gap-2">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <Skeleton className="h-4 w-20" />
            </div>
          ) : (
            <Skeleton
              className={cn(
                "h-4",
                width,
                cellIndex === 4 && "ml-auto",
                cellIndex === 5 && "mx-auto",
              )}
            />
          )}
        </TableCell>
      ))}
    </TableRow>
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
  active,
  direction,
  onClick,
  align = "left",
  className,
}: {
  label: string;
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

function SessionIdValue({ value }: { value?: string }) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return <span className="font-mono text-muted-foreground">/</span>;
  }
  return <span className="font-mono font-medium">{shortId(normalized)}</span>;
}

const VisitorTableRow = memo(function VisitorTableRow({
  locale,
  messages,
  labels,
  row,
  now,
  onOpenDetail,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: AppMessages["visitors"];
  row: VisitorRow;
  now: number;
  onOpenDetail: (visitorId: string) => void;
}) {
  const openDetail = () => onOpenDetail(row.visitorId);

  return (
    <TableRow className="group cursor-pointer">
      <ClickableTableCell
        onClick={openDetail}
        className="w-32"
        buttonClassName="pl-4"
        focusable
        ariaLabel={`${labels.visitor}: ${row.visitorId}`}
      >
        <div className="flex w-28 items-center gap-2">
          <VisitorAvatar seed={row.visitorId} className="size-6" />
          <span className="truncate">{labels.anonymous}</span>
        </div>
      </ClickableTableCell>
      <ClickableTableCell onClick={openDetail}>
        <SessionIdValue value={row.sessionId} />
      </ClickableTableCell>
      <ClickableTableCell
        onClick={openDetail}
        className="font-mono text-muted-foreground"
      >
        {formatRelativeTime(locale, row.firstSeenAt, now)}
      </ClickableTableCell>
      <ClickableTableCell
        onClick={openDetail}
        className="font-mono text-muted-foreground"
      >
        {formatRelativeTime(locale, row.lastSeenAt, now)}
      </ClickableTableCell>
      <ClickableTableCell
        onClick={openDetail}
        className="text-right font-mono tabular-nums"
      >
        {numberFormat(locale, row.sessions)}
      </ClickableTableCell>
      <ClickableTableCell onClick={openDetail} className="text-center">
        <span className="font-mono tabular-nums">
          {numberFormat(locale, row.views)}
        </span>
      </ClickableTableCell>
      <ClickableTableCell onClick={openDetail} className="max-w-48">
        <ReferrerMeta
          referrerHost={row.referrerHost || ""}
          referrerUrl={row.referrerUrl}
          directLabel={messages.overview.direct}
        />
      </ClickableTableCell>
      <ClickableTableCell onClick={openDetail} className="max-w-52">
        <CountryRegionMeta
          locale={locale}
          messages={messages}
          country={row.country || ""}
          region={row.region}
          regionCode={row.regionCode}
        />
      </ClickableTableCell>
      <ClickableTableCell onClick={openDetail} className="max-w-40">
        <OsMeta
          os={row.os || ""}
          version={row.osVersion}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
      <ClickableTableCell onClick={openDetail} className="max-w-40">
        <BrowserMeta
          browser={row.browser || ""}
          version={row.browserVersion}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
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
    </TableRow>
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

export function VisitorsClientPage({
  locale,
  messages,
  siteId,
  pathname,
}: VisitorsClientPageProps) {
  const labels = messages.visitors;
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

  const sentinelRef = useInfiniteTableSentinel({
    enabled:
      !loadingInitial && !loadingMore && !appendError && !error && hasMore,
    onReachEnd: loadNextPage,
  });

  const toggleSort = (key: VisitorSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key, direction: "desc" },
    );
  };

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
  const closeNestedDetail = useCallback((stackKey: string) => {
    setNestedDetails((current) => {
      const index = current.findIndex((item) => item.stackKey === stackKey);
      return index < 0 ? current : current.slice(0, index);
    });
  }, []);

  const bodyState = replacingRows
    ? "loading"
    : error
      ? "error"
      : rows.length === 0 && !hasMore
        ? "empty"
        : "rows";

  return (
    <div className="space-y-6">
      <PageHeading
        title={messages.visitors.title}
        subtitle={messages.visitors.subtitle}
      />

      <div className="relative w-full sm:max-w-xs">
        <RiSearchLine className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={labels.search}
          className="pl-8"
        />
      </div>

      <AnalyticsTableCard>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32 pl-4">{labels.visitor}</TableHead>
              <TableHead>{labels.sessionId}</TableHead>
              <SortHeader
                label={labels.firstSeen}
                active={sort.key === "firstSeenAt"}
                direction={sort.direction}
                onClick={() => toggleSort("firstSeenAt")}
              />
              <SortHeader
                label={labels.lastSeen}
                active={sort.key === "lastSeenAt"}
                direction={sort.direction}
                onClick={() => toggleSort("lastSeenAt")}
              />
              <SortHeader
                label={labels.sessions}
                active={sort.key === "sessions"}
                direction={sort.direction}
                onClick={() => toggleSort("sessions")}
                align="right"
                className="text-right"
              />
              <SortHeader
                label={labels.pageViews}
                active={sort.key === "views"}
                direction={sort.direction}
                onClick={() => toggleSort("views")}
                align="center"
                className="text-center"
              />
              <TableHead>{labels.referrer}</TableHead>
              <TableHead>{labels.location}</TableHead>
              <TableHead>{labels.os}</TableHead>
              <TableHead>{labels.browser}</TableHead>
              <TableHead className="pr-4">{labels.device}</TableHead>
            </TableRow>
          </TableHeader>
          <AutoTransition
            as="tbody"
            transitionKey={bodyState}
            initial={false}
            duration={0.18}
            type="fade"
            presenceMode="wait"
            aria-busy={replacingRows || loadingMore}
            data-slot="table-body"
            className="[&_tr:last-child]:border-0"
          >
            {replacingRows ? (
              Array.from({ length: VISITOR_SKELETON_ROWS }, (_, index) => (
                <VisitorRowSkeleton
                  key={`initial-skeleton-${index}`}
                  index={index}
                />
              ))
            ) : error ? (
              <TableRow>
                <TableCell
                  colSpan={11}
                  className="h-28 text-center text-muted-foreground"
                >
                  {labels.loadError}
                </TableCell>
              </TableRow>
            ) : rows.length === 0 && !hasMore ? (
              <TableRow>
                <TableCell
                  colSpan={11}
                  className="h-28 text-center text-muted-foreground"
                >
                  {labels.empty}
                </TableCell>
              </TableRow>
            ) : (
              <>
                {rows.map((row) => (
                  <VisitorTableRow
                    key={row.visitorId}
                    locale={locale}
                    messages={messages}
                    labels={labels}
                    row={row}
                    now={now}
                    onOpenDetail={stableOpenVisitorDetail}
                  />
                ))}
                {appendError ? (
                  <TableRow>
                    <TableCell
                      colSpan={11}
                      className="h-16 text-center text-muted-foreground"
                    >
                      {labels.loadError}
                    </TableCell>
                  </TableRow>
                ) : hasMore ? (
                  Array.from({ length: VISITOR_SKELETON_ROWS }, (_, index) => (
                    <VisitorRowSkeleton
                      key={`append-skeleton-${rows.length}-${index}`}
                      index={index}
                      sentinelRef={index === 0 ? sentinelRef : undefined}
                    />
                  ))
                ) : null}
              </>
            )}
          </AutoTransition>
        </Table>
      </AnalyticsTableCard>

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
            onOpenSession={(sessionId) =>
              openNestedDetail("session", sessionId)
            }
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
              onOpenSession={(sessionId) =>
                openNestedDetail("session", sessionId)
              }
            />
          ) : (
            <SessionDetailClientPage
              locale={locale}
              messages={messages}
              siteId={siteId}
              pathname={sessionsPathname}
              sessionId={nestedDetail.id}
              onOpenVisitor={(visitorId) =>
                openNestedDetail("visitor", visitorId)
              }
            />
          )}
        </DetailDrawer>
      ))}
    </div>
  );
}
