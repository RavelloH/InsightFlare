import {
  Fragment,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiFileList3Line,
  RiSearchLine,
} from "@remixicon/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import {
  AnalyticsDetailsTooltipTarget,
  AnalyticsTimeTooltipTarget,
} from "@/components/dashboard/analytics-time-tooltip";
import { AnalyticsDataTable } from "@/components/dashboard/common/analytics-data-table";
import {
  type AnalyticsTableColumnDefinition,
  AnalyticsTableColumnSettings,
  useAnalyticsTableColumns,
} from "@/components/dashboard/common/analytics-table-column-settings";
import {
  BrowserMeta,
  CountryRegionMeta,
  DeviceMeta,
  formatPath,
  formatRelativeTime,
  OsMeta,
  ReferrerMeta,
  VisitorAvatar,
} from "@/components/dashboard/journeys/journey-display";
import { EventDetailDrawer } from "@/components/dashboard/site-pages/events/event-detail-drawer";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  fetchEventRecordDetail,
  fetchEventsRecords,
} from "@/lib/dashboard/client/data/index";
import { filterQueryKey } from "@/lib/dashboard/filter-query-key";
import { numberFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { EventRecord } from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract/index";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

import {
  DEFAULT_EVENT_RECORD_SORT,
  EVENT_PAGE_SIZE,
  EVENT_SKELETON_ROWS,
} from "./event-model";
import {
  type EventPageCopy,
  type EventRecordSortKey,
  type EventRecordSortState,
  type EventRecordTableColumnId,
  type SortDirection,
} from "./types";
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
function EventRowSkeletonContent({
  index,
  columns,
}: {
  index: number;
  columns: readonly EventRecordTableColumnId[];
}) {
  const widths: Record<EventRecordTableColumnId, string> = {
    visitor: "w-24",
    eventName: "w-28",
    eventId: "w-24",
    occurredAt: "w-28",
    page: "w-32",
    referrer: "w-40",
    location: "w-24",
    os: "w-28",
    browser: "w-24",
    device: "w-24",
    payload: "w-20",
    nodeCount: "w-16",
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
                ["payload", "nodeCount"].includes(columnId) && "ml-auto",
                columnId === "occurredAt" && "mx-auto",
              )}
            />
          )}
        </TableCell>
      ))}
    </>
  );
}
function appendUniqueEvents(
  current: EventRecord[],
  incoming: readonly EventRecord[] | null | undefined,
): EventRecord[] {
  const incomingRows = Array.isArray(incoming) ? [...incoming] : [];
  if (current.length === 0) return incomingRows;
  const seen = new Set(current.map((row) => row.eventId));
  const nextRows = incomingRows.filter((row) => !seen.has(row.eventId));
  return nextRows.length > 0 ? [...current, ...nextRows] : current;
}
const EventRecordTableRowContent = memo(function EventRecordTableRowContent({
  locale,
  messages,
  labels,
  row,
  now,
  columns,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: EventPageCopy;
  row: EventRecord;
  now: number;
  columns: readonly EventRecordTableColumnId[];
}) {
  const visitorDisplayId = row.visitorId || row.sessionId || row.visitId;
  const visitorIdentifier = row.visitorId.trim()
    ? { label: messages.realtime.visitorId, value: row.visitorId.trim() }
    : row.sessionId.trim()
      ? { label: messages.sessionDetail.sessionId, value: row.sessionId.trim() }
      : { label: labels.visit, value: row.visitId.trim() };
  const referrerHost = row.referrerHost.trim();
  const cells: Record<EventRecordTableColumnId, ReactNode> = {
    visitor: (
      <TableCell className="max-w-36 pl-4">
        <div className="flex w-28 min-w-0 items-center gap-2">
          <VisitorAvatar
            seed={visitorDisplayId || row.eventId}
            className="size-6"
          />
          <AnalyticsDetailsTooltipTarget
            className="min-w-0 truncate"
            locale={locale}
            request={{
              key: `event-visitor:${row.eventId}:${visitorIdentifier.label}:${visitorIdentifier.value}`,
              items: [
                {
                  label: visitorIdentifier.label,
                  value: visitorIdentifier.value || messages.common.unknown,
                  copyValue: visitorIdentifier.value || undefined,
                },
              ],
            }}
          >
            <span className="min-w-0 truncate font-mono">
              {visitorDisplayId}
            </span>
          </AnalyticsDetailsTooltipTarget>
        </div>
      </TableCell>
    ),
    eventName: (
      <TableCell className="max-w-48">
        <AnalyticsDetailsTooltipTarget
          className="block truncate"
          locale={locale}
          request={{
            key: `event-name:${row.eventId}:${row.eventName}`,
            items: [
              {
                label: labels.eventName,
                value: row.eventName || messages.common.unknown,
                copyValue: row.eventName || undefined,
              },
            ],
          }}
        >
          <span className="block truncate font-medium">{row.eventName}</span>
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    eventId: (
      <TableCell className="max-w-32">
        <AnalyticsDetailsTooltipTarget
          className="block truncate"
          locale={locale}
          request={{
            key: `event-id:${row.eventId}`,
            items: [
              {
                label: labels.eventId,
                value: row.eventId || messages.common.unknown,
                copyValue: row.eventId || undefined,
              },
            ],
          }}
        >
          <span className="block truncate font-mono text-muted-foreground">
            {row.eventId}
          </span>
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    occurredAt: (
      <TableCell className="max-w-36 text-center font-mono text-muted-foreground">
        <AnalyticsTimeTooltipTarget
          className="block truncate"
          locale={locale}
          timestamp={row.occurredAt}
        >
          {formatRelativeTime(locale, row.occurredAt, now)}
        </AnalyticsTimeTooltipTarget>
      </TableCell>
    ),
    page: (
      <TableCell className="max-w-64">
        <AnalyticsDetailsTooltipTarget
          className="block truncate"
          locale={locale}
          request={{
            key: `event-page:${row.eventId}:${row.pathname}`,
            items: [
              {
                label: labels.page,
                value: formatPath(row.pathname),
                copyValue: formatPath(row.pathname),
              },
            ],
          }}
        >
          <span className="block truncate font-mono">
            {formatPath(row.pathname)}
          </span>
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    referrer: (
      <TableCell className="max-w-44">
        <AnalyticsDetailsTooltipTarget
          className="block"
          locale={locale}
          request={{
            key: `event-referrer:${row.eventId}:${referrerHost}`,
            items: [
              referrerHost
                ? {
                    label: messages.common.referrerHost,
                    value: referrerHost,
                    copyValue: referrerHost,
                  }
                : {
                    label: messages.common.referrer,
                    value: messages.overview.direct,
                  },
            ],
          }}
        >
          <ReferrerMeta
            referrerHost={row.referrerHost || ""}
            directLabel={messages.overview.direct}
            className="w-full"
          />
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    location: (
      <TableCell className="max-w-52">
        <AnalyticsDetailsTooltipTarget
          className="block"
          locale={locale}
          request={{
            key: `event-location:${row.eventId}:${row.country}:${row.region}:${row.city}`,
            items: [
              {
                label: messages.common.location,
                value: (
                  <CountryRegionMeta
                    locale={locale}
                    messages={messages}
                    country={row.country || ""}
                    region={row.region}
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
            className="w-full"
          />
        </AnalyticsDetailsTooltipTarget>
      </TableCell>
    ),
    os: (
      <TableCell className="max-w-40">
        <OsMeta
          os={row.os || ""}
          version={row.osVersion}
          unknownLabel={messages.common.unknown}
          className="w-full"
        />
      </TableCell>
    ),
    browser: (
      <TableCell className="max-w-40">
        <BrowserMeta
          browser={row.browser || ""}
          version={row.browserVersion}
          unknownLabel={messages.common.unknown}
          className="w-full"
        />
      </TableCell>
    ),
    device: (
      <TableCell className="max-w-36">
        <DeviceMeta
          deviceType={row.deviceType || ""}
          deviceLabels={messages.common.deviceLabels}
          unknownLabel={messages.common.unknown}
          className="w-full"
        />
      </TableCell>
    ),
    payload: (
      <TableCell className="pr-4 text-right font-mono tabular-nums">
        {numberFormat(locale, row.valueCount)}
      </TableCell>
    ),
    nodeCount: (
      <TableCell className="pr-4 text-right font-mono tabular-nums">
        {numberFormat(locale, row.nodeCount)}
      </TableCell>
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
const EventRecordsTable = memo(function EventRecordsTable({
  locale,
  messages,
  labels,
  rows,
  sort,
  onSort,
  onOpenRecord,
  loadingRows,
  loadingMore,
  error,
  appendError,
  hasMore,
  onLoadMore,
  visibleColumnIds,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: EventPageCopy;
  rows: EventRecord[];
  sort: EventRecordSortState;
  onSort: (key: EventRecordSortKey) => void;
  onOpenRecord: (eventId: string) => void;
  loadingRows: boolean;
  loadingMore: boolean;
  error: boolean;
  appendError: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  visibleColumnIds: readonly EventRecordTableColumnId[];
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const headers = useMemo<Record<EventRecordTableColumnId, ReactNode>>(
    () => ({
      visitor: <TableHead className="pl-4">{labels.visitor}</TableHead>,
      eventName: (
        <SortHeader
          label={labels.eventName}
          ariaLabel={formatI18nTemplate(messages.common.sortBy, {
            label: labels.eventName,
          })}
          active={sort.key === "eventName"}
          direction={sort.direction}
          onClick={() => onSort("eventName")}
        />
      ),
      eventId: <TableHead>{labels.eventId}</TableHead>,
      occurredAt: (
        <SortHeader
          label={labels.occurredAt}
          ariaLabel={formatI18nTemplate(messages.common.sortBy, {
            label: labels.occurredAt,
          })}
          active={sort.key === "occurredAt"}
          direction={sort.direction}
          onClick={() => onSort("occurredAt")}
          align="center"
          className="text-center"
        />
      ),
      page: (
        <SortHeader
          label={labels.page}
          ariaLabel={formatI18nTemplate(messages.common.sortBy, {
            label: labels.page,
          })}
          active={sort.key === "pathname"}
          direction={sort.direction}
          onClick={() => onSort("pathname")}
        />
      ),
      referrer: <TableHead>{labels.referrer}</TableHead>,
      location: <TableHead>{labels.location}</TableHead>,
      os: <TableHead>{labels.os}</TableHead>,
      browser: <TableHead>{labels.browser}</TableHead>,
      device: <TableHead>{labels.device}</TableHead>,
      payload: (
        <TableHead className="pr-4 text-right">{labels.payload}</TableHead>
      ),
      nodeCount: (
        <TableHead className="pr-4 text-right">{labels.nodeCount}</TableHead>
      ),
    }),
    [labels, messages.common.sortBy, onSort, sort],
  );
  const header = useMemo(
    () => (
      <TableRow>
        {visibleColumnIds.map((columnId) => (
          <Fragment key={columnId}>{headers[columnId]}</Fragment>
        ))}
      </TableRow>
    ),
    [headers, visibleColumnIds],
  );
  const renderRow = useCallback(
    (row: EventRecord) => ({
      children: (
        <EventRecordTableRowContent
          locale={locale}
          messages={messages}
          labels={labels}
          row={row}
          now={now}
          columns={visibleColumnIds}
        />
      ),
      props: {
        role: "button" as const,
        tabIndex: 0,
        className:
          "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
        onClick: () => onOpenRecord(row.eventId),
        onKeyDown: (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onOpenRecord(row.eventId);
        },
      },
    }),
    [labels, locale, messages, now, onOpenRecord, visibleColumnIds],
  );
  const renderSkeletonRow = useCallback(
    (index: number) => (
      <EventRowSkeletonContent index={index} columns={visibleColumnIds} />
    ),
    [visibleColumnIds],
  );
  const getRowKey = useCallback((row: EventRecord) => row.eventId, []);

  return (
    <AnalyticsDataTable
      minTableWidth="92rem"
      tableClassName="min-w-[92rem]"
      header={header}
      rows={rows}
      renderRow={renderRow}
      renderSkeletonRow={renderSkeletonRow}
      getRowKey={getRowKey}
      skeletonRows={EVENT_SKELETON_ROWS}
      columnCount={visibleColumnIds.length}
      loading={loadingRows}
      loadingMore={loadingMore}
      error={error}
      errorContent={labels.loadError}
      emptyContent={labels.empty}
      appendError={appendError}
      appendErrorContent={labels.loadError}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      enableTimeTooltips
      messages={messages}
    />
  );
});
export const EventRecordsSection = memo(function EventRecordsSection({
  locale,
  messages,
  labels,
  siteId,
  pathname,
  window: timeWindow,
  filters,
  eventName,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: EventPageCopy;
  siteId: string;
  pathname: string;
  window: TimeWindow;
  filters: FilterDocument;
  eventName?: string;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState<EventRecordSortState>(
    DEFAULT_EVENT_RECORD_SORT,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState("");
  const eventColumnDefinitions = useMemo<
    readonly AnalyticsTableColumnDefinition<EventRecordTableColumnId>[]
  >(
    () => [
      { id: "visitor", label: labels.visitor, required: true },
      { id: "eventName", label: labels.eventName, required: true },
      { id: "eventId", label: labels.eventId },
      { id: "occurredAt", label: labels.occurredAt },
      { id: "page", label: labels.page },
      { id: "referrer", label: labels.referrer },
      { id: "location", label: labels.location },
      { id: "os", label: labels.os },
      { id: "browser", label: labels.browser },
      { id: "device", label: labels.device },
      { id: "payload", label: labels.payload },
      { id: "nodeCount", label: labels.nodeCount },
    ],
    [labels],
  );
  const eventColumns = useAnalyticsTableColumns({
    storageKey: "insightflare:analytics-table-columns:events",
    columns: eventColumnDefinitions,
  });
  const filtersKey = useMemo(() => filterQueryKey(filters), [filters]);

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
      "event-records",
      siteId,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
      filtersKey,
      debouncedQuery,
      sort.key,
      sort.direction,
      eventName ?? "",
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchEventsRecords(siteId, timeWindow, filters, {
        cursor: pageParam,
        limit: EVENT_PAGE_SIZE,
        sortBy: sort.key,
        sortDir: sort.direction,
        search: debouncedQuery,
        eventName,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => {
      const pagination = lastPage.data?.pagination;
      return pagination?.hasMore && pagination.nextCursor
        ? pagination.nextCursor
        : undefined;
    },
    enabled: typeof window !== "undefined",
  });
  const rows = useMemo(
    () =>
      data?.pages.reduce<EventRecord[]>(
        (current, page) => appendUniqueEvents(current, page.data.items),
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

  const detailQuery = useQuery({
    queryKey: [
      "dashboard",
      "event-record-detail",
      siteId,
      selectedEventId,
      timeWindow.from,
      timeWindow.to,
    ],
    queryFn: ({ signal }) =>
      fetchEventRecordDetail(siteId, selectedEventId, timeWindow, {
        signal,
        preserveErrors: true,
      }),
    enabled:
      typeof window !== "undefined" && drawerOpen && Boolean(selectedEventId),
  });
  const detail = detailQuery.data?.data ?? null;
  const detailLoading = detailQuery.isPending && !detail;
  const detailError = detailQuery.isError && !detail;

  const toggleSort = useCallback((key: EventRecordSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key, direction: "desc" },
    );
  }, []);

  const openRecord = useCallback((eventId: string) => {
    setSelectedEventId(eventId);
    setDrawerOpen(true);
  }, []);

  return (
    <section className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="inline-flex items-center gap-2 text-sm font-medium">
            <RiFileList3Line className="size-4 shrink-0" />
            {labels.recordsTitle}
          </h2>
        </div>
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
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
            columns={eventColumnDefinitions}
            orderedIds={eventColumns.orderedIds}
            visibleIds={eventColumns.visibleIds}
            onOrderChange={eventColumns.setOrder}
            onVisibilityChange={eventColumns.setVisible}
            onReset={eventColumns.reset}
            labels={messages.common.tableColumns}
          />
        </div>
      </div>

      <EventRecordsTable
        locale={locale}
        messages={messages}
        labels={labels}
        rows={rows}
        sort={sort}
        onSort={toggleSort}
        onOpenRecord={openRecord}
        loadingRows={replacingRows}
        loadingMore={loadingMore}
        error={error}
        appendError={appendError}
        hasMore={hasMore}
        onLoadMore={loadNextPage}
        visibleColumnIds={eventColumns.visibleIds}
      />

      <EventDetailDrawer
        locale={locale}
        messages={messages}
        labels={labels}
        siteId={siteId}
        pathname={pathname}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        detail={detail}
        loading={detailLoading}
        error={detailError}
        eventKind="custom"
      />
    </section>
  );
});
