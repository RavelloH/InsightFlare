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
import { RiFileList3Line } from "@remixicon/react";
import { useQuery } from "@tanstack/react-query";

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
  CountryRegionMeta,
  formatRelativeTime,
  VisitorAvatar,
} from "@/components/dashboard/journeys/journey-display";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

import { fetchRequestObservationDetail } from "./data";
import { NormalRequestDetailDrawer } from "./detail-drawers";
import {
  CategoryBlocks,
  emptyValue,
  requestCategoryLabel,
  requestKindLabel,
  RequestObservationRowSkeletonContent,
} from "./helpers";
import {
  BOT_EVENT_FETCH_LIMIT,
  latencyFormat,
  NORMAL_REQUEST_COLUMN_ALIGNMENTS,
  NORMAL_REQUEST_SKELETON_WIDTHS,
  type NormalRequestEvent,
  type NormalRequestTableColumnId,
  requestObservationDetailId,
  requestObservationUiLabels,
  shortId,
} from "./model";
export const IncludedRequestsTable = memo(function IncludedRequestsTable({
  locale,
  messages,
  copy,
  events,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  timeWindow,
}: {
  locale: Locale;
  messages: AppMessages;
  copy: AppMessages["requestObservation"];
  events: NormalRequestEvent[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  timeWindow: TimeWindow;
  requestKey?: string;
}) {
  const ui = useMemo(
    () => requestObservationUiLabels(locale, copy),
    [copy, locale],
  );
  const [selectedEvent, setSelectedEvent] = useState<NormalRequestEvent | null>(
    null,
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const selectedEventId = selectedEvent
    ? requestObservationDetailId(selectedEvent)
    : "";
  const selectedEventCacheKey = selectedEventId
    ? selectedEventId
    : selectedEvent
      ? `${selectedEvent.siteId}:${selectedEvent.pathname}:${selectedEvent.receivedAt}`
      : "";
  const detailQuery = useQuery({
    queryKey: [
      "dashboard",
      "request-observation-detail",
      selectedEventCacheKey,
      timeWindow.from,
      timeWindow.to,
      timeWindow.interval,
      timeWindow.timeZone,
    ],
    queryFn: ({ signal }) =>
      selectedEvent
        ? fetchRequestObservationDetail<NormalRequestEvent>(
            timeWindow,
            selectedEvent,
            signal,
          )
        : null,
    enabled:
      typeof window !== "undefined" && drawerOpen && Boolean(selectedEvent),
    retry: false,
  });
  const detailEvent = detailQuery.data ?? null;
  const detailLoading = detailQuery.isPending;
  const detailError = detailQuery.isError
    ? detailQuery.error instanceof Error
      ? detailQuery.error.message
      : "load_request_observation_detail_failed"
    : null;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const title = ui.recentIncludedTitle;
  const description = ui.recentIncludedDescription;
  const openEvent = useCallback((event: NormalRequestEvent) => {
    setSelectedEvent(event);
    setDrawerOpen(true);
  }, []);
  const handleKeyDown = useCallback(
    (
      keyboardEvent: KeyboardEvent<HTMLTableRowElement>,
      event: NormalRequestEvent,
    ) => {
      if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
      keyboardEvent.preventDefault();
      openEvent(event);
    },
    [openEvent],
  );
  const columnDefinitions = useMemo<
    readonly AnalyticsTableColumnDefinition<NormalRequestTableColumnId>[]
  >(
    () => [
      { id: "id", label: copy.id, required: true },
      { id: "time", label: copy.time, required: true },
      { id: "site", label: copy.site, required: true },
      { id: "kind", label: copy.kind },
      { id: "category", label: copy.category },
      { id: "requestMethod", label: copy.normalDetail.requestMethod },
      { id: "hostname", label: copy.hostname },
      { id: "network", label: copy.network },
      { id: "location", label: copy.location },
      { id: "colo", label: copy.colo },
      { id: "pathname", label: copy.pathname },
      { id: "edgeLatency", label: copy.normalDetail.edgeLatency },
    ],
    [copy],
  );
  const tableColumns = useAnalyticsTableColumns({
    storageKey:
      "insightflare:analytics-table-columns:request-observation-normal",
    columns: columnDefinitions,
  });
  const headers = useMemo<Record<NormalRequestTableColumnId, ReactNode>>(
    () => ({
      id: <TableHead className="pl-4">{copy.id}</TableHead>,
      time: <TableHead className="text-center">{copy.time}</TableHead>,
      site: <TableHead>{copy.site}</TableHead>,
      kind: <TableHead>{copy.kind}</TableHead>,
      category: <TableHead className="text-center">{copy.category}</TableHead>,
      requestMethod: (
        <TableHead className="text-center">
          {copy.normalDetail.requestMethod}
        </TableHead>
      ),
      hostname: <TableHead>{copy.hostname}</TableHead>,
      network: <TableHead>{copy.network}</TableHead>,
      location: <TableHead>{copy.location}</TableHead>,
      colo: <TableHead>{copy.colo}</TableHead>,
      pathname: <TableHead>{copy.pathname}</TableHead>,
      edgeLatency: (
        <TableHead className="pr-4 text-right">
          {copy.normalDetail.edgeLatency}
        </TableHead>
      ),
    }),
    [copy],
  );
  const tableHeader = useMemo(
    () => (
      <TableRow>
        {tableColumns.visibleIds.map((columnId) => (
          <Fragment key={columnId}>{headers[columnId]}</Fragment>
        ))}
      </TableRow>
    ),
    [headers, tableColumns.visibleIds],
  );
  const renderRow = useCallback(
    (event: NormalRequestEvent) => {
      const eventId = event.traceId || event.rayId || "";
      const kindLabel = requestKindLabel(copy, event.kind);
      const categoryLabel = event.category
        ? requestCategoryLabel(copy, event.category)
        : emptyValue(copy);
      const requestMethodLabel = event.requestMethod || emptyValue(copy);
      const siteLabel =
        event.siteName || event.siteDomain || event.siteId || emptyValue(copy);
      const siteCopyValue =
        event.siteName || event.siteDomain || event.siteId || undefined;
      const networkLabel = event.asOrganization || emptyValue(copy);
      const networkCopyValue = event.asOrganization || undefined;
      const hostnameLabel = event.hostname || emptyValue(copy);
      const hostnameCopyValue = event.hostname || undefined;
      const asnLabel = event.asn ? `AS${event.asn}` : emptyValue(copy);
      const asnCopyValue = event.asn ? `AS${event.asn}` : undefined;
      const coloLabel = event.colo || emptyValue(copy);
      const coloCopyValue = event.colo || undefined;
      const pathnameLabel = event.pathname || "/";
      const edgeLatencyLabel = latencyFormat(locale, copy, event.edgeLatencyMs);
      const edgeLatencyCopyValue =
        event.edgeLatencyMs === null ||
        event.edgeLatencyMs === undefined ||
        !Number.isFinite(event.edgeLatencyMs)
          ? undefined
          : edgeLatencyLabel;
      const cells: Record<NormalRequestTableColumnId, ReactNode> = {
        id: (
          <TableCell className="pl-4 max-w-36">
            <div className="flex w-28 min-w-0 items-center gap-2">
              <VisitorAvatar seed={eventId || "normal"} className="size-6" />
              <AnalyticsDetailsTooltipTarget
                className="min-w-0 flex-1 truncate"
                locale={locale}
                request={{
                  key: `request-observation-normal-id:${eventId}:${event.receivedAt}`,
                  items: [
                    {
                      label: copy.id,
                      value: eventId || emptyValue(copy),
                      copyValue: eventId || undefined,
                    },
                  ],
                }}
              >
                <span className="truncate font-mono">
                  {eventId ? shortId(eventId) : "--"}
                </span>
              </AnalyticsDetailsTooltipTarget>
            </div>
          </TableCell>
        ),
        time: (
          <TableCell className="max-w-36 text-center font-mono text-muted-foreground">
            <AnalyticsTimeTooltipTarget
              className="block truncate"
              locale={locale}
              timestamp={event.receivedAt}
            >
              {formatRelativeTime(locale, event.receivedAt, now)}
            </AnalyticsTimeTooltipTarget>
          </TableCell>
        ),
        site: (
          <TableCell className="max-w-48">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-medium"
              locale={locale}
              request={{
                key: `request-observation-normal-site:${event.siteId}:${event.siteName}:${event.siteDomain}`,
                items: [
                  {
                    label: copy.site,
                    value: siteLabel,
                    copyValue: siteCopyValue,
                  },
                  {
                    label: copy.hostname,
                    value: hostnameLabel,
                    copyValue: hostnameCopyValue,
                  },
                ],
              }}
            >
              {event.siteName || event.siteDomain || event.siteId}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        kind: (
          <TableCell className="max-w-28">
            <AnalyticsDetailsTooltipTarget
              className="inline-flex"
              locale={locale}
              request={{
                key: `request-observation-normal-kind:${eventId}:${event.kind}`,
                items: [
                  {
                    label: copy.kind,
                    value: kindLabel,
                    copyValue: event.kind || undefined,
                  },
                ],
              }}
            >
              <span className="truncate">{kindLabel}</span>
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        category: (
          <TableCell className="max-w-36 text-center">
            <AnalyticsDetailsTooltipTarget
              className="inline-flex"
              locale={locale}
              request={{
                key: `request-observation-included-category:${eventId}:${event.category}`,
                items: [
                  {
                    label: copy.category,
                    value: categoryLabel,
                    copyValue: event.category || undefined,
                  },
                ],
              }}
            >
              <CategoryBlocks category={event.category} label={categoryLabel} />
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        requestMethod: (
          <TableCell className="max-w-24 text-center">
            <AnalyticsDetailsTooltipTarget
              className="block truncate text-center"
              locale={locale}
              request={{
                key: `request-observation-normal-method:${eventId}:${event.requestMethod}`,
                items: [
                  {
                    label: copy.normalDetail.requestMethod,
                    value: requestMethodLabel,
                    copyValue: event.requestMethod || undefined,
                  },
                ],
              }}
            >
              <span className="block truncate text-center font-mono">
                {event.requestMethod || "--"}
              </span>
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        hostname: (
          <TableCell className="max-w-44">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono"
              locale={locale}
              request={{
                key: `request-observation-normal-hostname:${eventId}:${event.hostname}`,
                items: [
                  {
                    label: copy.hostname,
                    value: hostnameLabel,
                    copyValue: event.hostname || undefined,
                  },
                ],
              }}
            >
              {event.hostname || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        network: (
          <TableCell className="max-w-44">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-normal-network:${eventId}:${event.asOrganization}:${event.asn}`,
                items: [
                  {
                    label: copy.network,
                    value: networkLabel,
                    copyValue: networkCopyValue,
                  },
                  {
                    label: copy.asn,
                    value: asnLabel,
                    copyValue: asnCopyValue,
                  },
                ],
              }}
            >
              {event.asOrganization || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        location: (
          <TableCell className="max-w-52">
            <AnalyticsDetailsTooltipTarget
              className="block min-w-0"
              locale={locale}
              request={{
                key: `request-observation-normal-location:${eventId}:${event.country}:${event.region}:${event.city}`,
                items: [
                  {
                    label: copy.location,
                    value: (
                      <CountryRegionMeta
                        locale={locale}
                        messages={messages}
                        country={event.country || ""}
                        region={event.region}
                        city={event.city}
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
                country={event.country || ""}
                region={event.region}
                className="w-full"
              />
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        colo: (
          <TableCell className="max-w-32">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-normal-colo:${eventId}:${event.colo}`,
                items: [
                  {
                    label: copy.colo,
                    value: coloLabel,
                    copyValue: coloCopyValue,
                  },
                ],
              }}
            >
              {event.colo || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        pathname: (
          <TableCell className="max-w-64">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono"
              locale={locale}
              request={{
                key: `request-observation-normal-pathname:${eventId}:${pathnameLabel}`,
                items: [
                  {
                    label: copy.pathname,
                    value: pathnameLabel,
                    copyValue: pathnameLabel,
                  },
                ],
              }}
            >
              {pathnameLabel}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        edgeLatency: (
          <TableCell className="max-w-28 pr-4 text-right">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-normal-edge-latency:${eventId}:${event.edgeLatencyMs}`,
                items: [
                  {
                    label: copy.normalDetail.edgeLatency,
                    value: edgeLatencyLabel,
                    copyValue: edgeLatencyCopyValue,
                  },
                ],
              }}
            >
              <span className="block truncate font-mono tabular-nums text-muted-foreground">
                {edgeLatencyLabel}
              </span>
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
      };
      return {
        children: (
          <>
            {tableColumns.visibleIds.map((columnId) => (
              <Fragment key={columnId}>{cells[columnId]}</Fragment>
            ))}
          </>
        ),
        props: {
          role: "button",
          tabIndex: 0,
          className:
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70",
          onClick: () => openEvent(event),
          onKeyDown: (keyboardEvent: KeyboardEvent<HTMLTableRowElement>) =>
            handleKeyDown(keyboardEvent, event),
        },
      };
    },
    [
      copy,
      handleKeyDown,
      locale,
      messages,
      now,
      openEvent,
      tableColumns.visibleIds,
    ],
  );
  const renderSkeletonRow = useCallback(
    (index: number) => (
      <RequestObservationRowSkeletonContent
        index={index}
        columns={tableColumns.visibleIds}
        widths={NORMAL_REQUEST_SKELETON_WIDTHS}
        alignments={NORMAL_REQUEST_COLUMN_ALIGNMENTS}
      />
    ),
    [tableColumns.visibleIds],
  );
  const getRowKey = useCallback(
    (event: NormalRequestEvent, index: number) =>
      event.traceId ||
      event.rayId ||
      `${event.siteId}:${event.pathname}:${event.receivedAt}:${index}`,
    [],
  );

  return (
    <>
      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="inline-flex items-center gap-2 text-sm font-medium">
              <RiFileList3Line className="size-4 shrink-0" />
              {title}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AnalyticsTableColumnSettings
              columns={columnDefinitions}
              orderedIds={tableColumns.orderedIds}
              visibleIds={tableColumns.visibleIds}
              onOrderChange={tableColumns.setOrder}
              onVisibilityChange={tableColumns.setVisible}
              onReset={tableColumns.reset}
              labels={messages.common.tableColumns}
            />
          </div>
        </div>

        <AnalyticsDataTable
          tableClassName="min-w-[80rem]"
          header={tableHeader}
          rows={events}
          renderRow={renderRow}
          renderSkeletonRow={renderSkeletonRow}
          getRowKey={getRowKey}
          skeletonRows={BOT_EVENT_FETCH_LIMIT}
          columnCount={tableColumns.visibleIds.length}
          loading={loading}
          loadingMore={loadingMore}
          errorContent={copy.loadFailed}
          emptyContent={copy.noData}
          hasMore={hasMore}
          onLoadMore={onLoadMore}
          enableTimeTooltips
          messages={messages}
        />
      </section>

      <NormalRequestDetailDrawer
        locale={locale}
        messages={messages}
        copy={copy}
        previewEvent={selectedEvent}
        detailEvent={detailEvent}
        loading={detailLoading}
        error={detailError}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </>
  );
});
