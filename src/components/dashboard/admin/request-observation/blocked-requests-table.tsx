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
import { numberFormat } from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { usePathname, useSearchParams } from "@/lib/router";

import { fetchRequestObservationDetail } from "./data";
import { BotRequestDetailDrawer } from "./detail-drawers";
import {
  botReasonLabel,
  CategoryBlocks,
  emptyValue,
  requestCategoryLabel,
  requestKindLabel,
  RequestObservationRowSkeletonContent,
} from "./helpers";
import {
  type BlockedRequestTableColumnId,
  BOT_EVENT_COLUMN_ALIGNMENTS,
  BOT_EVENT_FETCH_LIMIT,
  BOT_EVENT_SKELETON_WIDTHS,
  type BotDimensionRow,
  type BotEvent,
  DIMENSION_ROW_LIMIT,
  type NetworkDimensionTab,
  type NormalRequestEvent,
  requestObservationDetailId,
  requestObservationUiLabels,
  shortId,
  type TargetDimensionTab,
} from "./model";
export const BlockedRequestsTable = memo(function BlockedRequestsTable({
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
  events: BotEvent[];
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  timeWindow: TimeWindow;
}) {
  const ui = useMemo(
    () => requestObservationUiLabels(locale, copy),
    [copy, locale],
  );
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedEvent, setSelectedEvent] = useState<BotEvent | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [detailParam, setDetailParam] = useState(
    () => searchParams.get("detail")?.trim() || "",
  );
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
        ? fetchRequestObservationDetail<BotEvent>(
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
      : "load_bot_protection_detail_failed"
    : null;

  useEffect(() => {
    setDetailParam(searchParams.get("detail")?.trim() || "");
  }, [searchParams]);

  useEffect(() => {
    const handlePopState = () => {
      setDetailParam(
        new URLSearchParams(window.location.search).get("detail")?.trim() || "",
      );
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const updateDetailParam = useCallback(
    (detailId: string, mode: "push" | "replace") => {
      const nextParams = new URLSearchParams(window.location.search);
      if (detailId) nextParams.set("detail", detailId);
      else nextParams.delete("detail");

      const nextQuery = nextParams.toString();
      const nextUrl = nextQuery ? `${pathname}?${nextQuery}` : pathname;
      if (`${window.location.pathname}${window.location.search}` === nextUrl) {
        setDetailParam(detailId);
        return;
      }
      if (mode === "push") window.history.pushState(null, "", nextUrl);
      else window.history.replaceState(null, "", nextUrl);
      setDetailParam(detailId);
    },
    [pathname],
  );

  const openEvent = useCallback(
    (event: BotEvent, options?: { syncUrl?: boolean }) => {
      setSelectedEvent(event);
      setDrawerOpen(true);

      if (options?.syncUrl !== false) {
        const detailId = requestObservationDetailId(event);
        if (detailId) updateDetailParam(detailId, "push");
      }
    },
    [updateDetailParam],
  );

  const handleDrawerOpenChange = useCallback(
    (nextOpen: boolean) => {
      setDrawerOpen(nextOpen);
      if (nextOpen || !detailParam) return;
      updateDetailParam("", "replace");
    },
    [detailParam, updateDetailParam],
  );

  useEffect(() => {
    if (!detailParam) {
      setDrawerOpen(false);
      return;
    }
    const matchingEvent = events.find(
      (event) => event.traceId === detailParam || event.rayId === detailParam,
    );
    if (!matchingEvent) return;
    if (
      selectedEvent &&
      requestObservationDetailId(selectedEvent) === detailParam
    ) {
      setDrawerOpen(true);
      return;
    }
    openEvent(matchingEvent, { syncUrl: false });
  }, [detailParam, events, openEvent, selectedEvent]);

  const handleKeyDown = useCallback(
    (keyboardEvent: KeyboardEvent<HTMLTableRowElement>, event: BotEvent) => {
      if (keyboardEvent.key !== "Enter" && keyboardEvent.key !== " ") return;
      keyboardEvent.preventDefault();
      openEvent(event);
    },
    [openEvent],
  );

  const columnDefinitions = useMemo<
    readonly AnalyticsTableColumnDefinition<BlockedRequestTableColumnId>[]
  >(
    () => [
      { id: "id", label: copy.id, required: true },
      { id: "time", label: copy.time, required: true },
      { id: "site", label: copy.site, required: true },
      { id: "kind", label: copy.kind },
      { id: "reason", label: copy.reason },
      { id: "category", label: copy.category },
      { id: "network", label: copy.network },
      { id: "ip", label: copy.ip },
      { id: "location", label: copy.location },
      { id: "pathname", label: copy.pathname },
      { id: "userAgent", label: copy.userAgent },
      { id: "botScore", label: copy.botScore },
      { id: "verifiedBotCategory", label: copy.verifiedBotCategory },
    ],
    [copy],
  );
  const tableColumns = useAnalyticsTableColumns({
    storageKey:
      "insightflare:analytics-table-columns:request-observation-abnormal",
    columns: columnDefinitions,
  });
  const headers = useMemo<Record<BlockedRequestTableColumnId, ReactNode>>(
    () => ({
      id: <TableHead className="pl-4">{copy.id}</TableHead>,
      time: <TableHead className="text-center">{copy.time}</TableHead>,
      site: <TableHead>{copy.site}</TableHead>,
      kind: <TableHead>{copy.kind}</TableHead>,
      reason: <TableHead>{copy.reason}</TableHead>,
      category: <TableHead className="text-center">{copy.category}</TableHead>,
      botScore: <TableHead className="text-right">{copy.botScore}</TableHead>,
      verifiedBotCategory: <TableHead>{copy.verifiedBotCategory}</TableHead>,
      network: <TableHead>{copy.network}</TableHead>,
      ip: <TableHead>{copy.ip}</TableHead>,
      location: <TableHead>{copy.location}</TableHead>,
      pathname: <TableHead>{copy.pathname}</TableHead>,
      userAgent: <TableHead className="pr-4">{copy.userAgent}</TableHead>,
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
    (event: BotEvent) => {
      const reasonLabel = botReasonLabel(copy, event.reasons[0] || "");
      const reasonItems =
        event.reasons.length > 0
          ? event.reasons.map((reason, index) => {
              const value = botReasonLabel(copy, reason);
              return {
                label: `${copy.reason}#${index + 1}`,
                value,
                copyValue: value,
              };
            })
          : [
              {
                label: copy.reason,
                value: reasonLabel || emptyValue(copy),
                copyValue: reasonLabel || undefined,
              },
            ];
      const eventId = event.traceId || event.rayId || "";
      const kindLabel = requestKindLabel(copy, event.kind);
      const categoryLabel = event.category
        ? requestCategoryLabel(copy, event.category)
        : emptyValue(copy);
      const siteLabel =
        event.siteName || event.siteDomain || event.siteId || emptyValue(copy);
      const siteCopyValue =
        event.siteName || event.siteDomain || event.siteId || undefined;
      const hostnameLabel = event.hostname || emptyValue(copy);
      const hostnameCopyValue = event.hostname || undefined;
      const networkLabel = event.asOrganization || emptyValue(copy);
      const networkCopyValue = event.asOrganization || undefined;
      const asnLabel = event.asn ? `AS${event.asn}` : emptyValue(copy);
      const asnCopyValue = event.asn ? `AS${event.asn}` : undefined;
      const botScoreLabel =
        event.botScore === null || !Number.isFinite(event.botScore)
          ? emptyValue(copy)
          : numberFormat(locale, event.botScore);
      const verifiedBotCategoryLabel =
        event.verifiedBotCategory || emptyValue(copy);
      const verifiedBotCategoryCopyValue =
        event.verifiedBotCategory || undefined;
      const pathnameLabel = event.pathname || "/";
      const userAgentLabel = event.userAgent || emptyValue(copy);
      const cells: Record<BlockedRequestTableColumnId, ReactNode> = {
        id: (
          <TableCell className="pl-4 max-w-36">
            <div className="flex w-28 min-w-0 items-center gap-2">
              <VisitorAvatar seed={eventId || "unknown"} className="size-6" />
              <AnalyticsDetailsTooltipTarget
                className="min-w-0 flex-1 truncate"
                locale={locale}
                request={{
                  key: `request-observation-abnormal-id:${eventId}:${event.receivedAt}`,
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
                key: `request-observation-abnormal-site:${event.siteId}:${event.siteName}:${event.siteDomain}`,
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
              {event.siteName}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        kind: (
          <TableCell className="max-w-36">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-abnormal-kind:${eventId}:${event.kind}`,
                items: [
                  {
                    label: copy.kind,
                    value: kindLabel,
                    copyValue: event.kind || undefined,
                  },
                ],
              }}
            >
              {kindLabel}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        reason: (
          <TableCell className="max-w-48">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-medium"
              locale={locale}
              request={{
                key: `request-observation-abnormal-reason:${eventId}:${event.reasons.join(",")}:${reasonLabel}`,
                items: reasonItems,
              }}
            >
              {reasonLabel}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        category: (
          <TableCell className="max-w-36 text-center">
            <AnalyticsDetailsTooltipTarget
              className="inline-flex"
              locale={locale}
              request={{
                key: `request-observation-abnormal-category:${eventId}:${event.category}`,
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
        botScore: (
          <TableCell className="max-w-24 text-right">
            <span className="block truncate font-mono tabular-nums">
              {botScoreLabel}
            </span>
          </TableCell>
        ),
        verifiedBotCategory: (
          <TableCell className="max-w-44">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-abnormal-verified-bot:${eventId}:${event.verifiedBotCategory}`,
                items: [
                  {
                    label: copy.verifiedBotCategory,
                    value: verifiedBotCategoryLabel,
                    copyValue: verifiedBotCategoryCopyValue,
                  },
                ],
              }}
            >
              {event.verifiedBotCategory || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        network: (
          <TableCell className="max-w-44">
            <AnalyticsDetailsTooltipTarget
              className="block truncate"
              locale={locale}
              request={{
                key: `request-observation-abnormal-network:${eventId}:${event.asOrganization}:${event.asn}`,
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
        ip: (
          <TableCell className="max-w-36">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono text-muted-foreground"
              locale={locale}
              request={{
                key: `request-observation-abnormal-ip:${eventId}:${event.ip}`,
                items: [
                  {
                    label: copy.ip,
                    value: event.ip || emptyValue(copy),
                    copyValue: event.ip || undefined,
                  },
                ],
              }}
            >
              {event.ip || "--"}
            </AnalyticsDetailsTooltipTarget>
          </TableCell>
        ),
        location: (
          <TableCell className="max-w-52">
            <AnalyticsDetailsTooltipTarget
              className="block min-w-0"
              locale={locale}
              request={{
                key: `request-observation-abnormal-location:${eventId}:${event.country}:${event.region}:${event.city}`,
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
        pathname: (
          <TableCell className="max-w-64">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono"
              locale={locale}
              request={{
                key: `request-observation-abnormal-pathname:${eventId}:${pathnameLabel}`,
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
        userAgent: (
          <TableCell className="max-w-80 pr-4">
            <AnalyticsDetailsTooltipTarget
              className="block truncate font-mono text-muted-foreground"
              locale={locale}
              request={{
                key: `request-observation-abnormal-user-agent:${eventId}:${event.userAgent}`,
                items: [
                  {
                    label: copy.userAgent,
                    value: userAgentLabel,
                    copyValue: event.userAgent || undefined,
                  },
                ],
              }}
            >
              {event.userAgent || "--"}
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
        widths={BOT_EVENT_SKELETON_WIDTHS}
        alignments={BOT_EVENT_COLUMN_ALIGNMENTS}
      />
    ),
    [tableColumns.visibleIds],
  );
  const getRowKey = useCallback(
    (event: BotEvent, index: number) =>
      event.traceId ||
      event.rayId ||
      `${event.siteId}:${event.ip}:${event.pathname}:${event.receivedAt}:${index}`,
    [],
  );

  return (
    <>
      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="inline-flex items-center gap-2 text-sm font-medium">
              <RiFileList3Line className="size-4 shrink-0" />
              {ui.recentBlockedTitle}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {ui.recentBlockedDescription}
            </p>
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
          minTableWidth="92rem"
          tableClassName="min-w-[92rem]"
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

      <BotRequestDetailDrawer
        locale={locale}
        messages={messages}
        copy={copy}
        previewEvent={selectedEvent}
        detailEvent={detailEvent}
        loading={detailLoading}
        error={detailError}
        open={drawerOpen}
        onOpenChange={handleDrawerOpenChange}
      />
    </>
  );
});
function _valuesForNormalTargetTab(
  event: NormalRequestEvent,
  tab: TargetDimensionTab,
): string[] {
  if (tab === "site") {
    return [event.siteName || event.siteDomain || event.siteId];
  }
  if (tab === "hostname") return [event.hostname];
  if (tab === "pathname") return [event.pathname || "/"];
  return [event.origin];
}
function _valuesForNormalNetworkTab(
  event: NormalRequestEvent,
  tab: NetworkDimensionTab,
): string[] {
  if (tab === "asOrganization") return [event.asOrganization];
  if (tab === "asn") return [event.asn ? `AS${event.asn}` : ""];
  if (tab === "country") return [event.country];
  if (tab === "region") return [event.region];
  if (tab === "city") return [event.city];
  return [event.colo];
}
function _aggregateNormalDimensionRows(
  events: NormalRequestEvent[],
  copy: AppMessages["requestObservation"],
  resolveValues: (event: NormalRequestEvent) => string[],
): BotDimensionRow[] {
  const rowMap = new Map<
    string,
    { count: number; sampleEvent: NormalRequestEvent | null }
  >();

  for (const event of events) {
    const values = resolveValues(event)
      .map((value) => value.trim())
      .filter(Boolean);
    const normalizedValues = values.length > 0 ? values : [emptyValue(copy)];
    for (const value of normalizedValues) {
      const current = rowMap.get(value) ?? {
        count: 0,
        sampleEvent: event,
      };
      current.count += 1;
      current.sampleEvent ??= event;
      rowMap.set(value, current);
    }
  }

  return Array.from(rowMap.entries())
    .map(([label, row]) => ({
      label,
      count: row.count,
      botCount: 0,
      sampleEvent: row.sampleEvent
        ? ({
            ...row.sampleEvent,
            category: "",
            disposition: "included",
            reasons: [],
            ip: "",
            userAgent: "",
            requestMethod: "",
            verifiedBotCategory: "",
            botScore: null,
            metadataJson: "",
          } satisfies BotEvent)
        : null,
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.label.localeCompare(right.label),
    )
    .slice(0, DIMENSION_ROW_LIMIT);
}
