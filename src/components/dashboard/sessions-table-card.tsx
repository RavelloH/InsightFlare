import {
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { RiArrowDownSLine, RiArrowUpSLine } from "@remixicon/react";

import { AnalyticsDataTable } from "@/components/dashboard/analytics-data-table";
import {
  AnalyticsDetailsTooltipTarget,
  AnalyticsTimeTooltipTarget,
} from "@/components/dashboard/analytics-time-tooltip";
import { ClickableTableCell } from "@/components/dashboard/clickable-table-cell";
import {
  BrowserMeta,
  CountryRegionMeta,
  DeviceMeta,
  formatDuration,
  formatPath,
  formatRelativeTime,
  formatScreen,
  OsMeta,
  ReferrerMeta,
  VisitorAvatar,
} from "@/components/dashboard/journey-display";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { numberFormat } from "@/lib/dashboard/format";
import type { JourneySession } from "@/lib/edge-client";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

export type SessionSortDirection = "asc" | "desc";
export type SessionSortKey = "startedAt" | "durationMs" | "views";

export interface SessionSortState {
  key: SessionSortKey;
  direction: SessionSortDirection;
}

export const SESSION_TABLE_COLUMN_IDS = [
  "visitor",
  "sessionId",
  "started",
  "duration",
  "pageViews",
  "customEvents",
  "referrer",
  "location",
  "os",
  "browser",
  "device",
  "entryPage",
  "exitPage",
  "screenSize",
  "exitTime",
] as const;

export type SessionTableColumnId = (typeof SESSION_TABLE_COLUMN_IDS)[number];

export type SessionsTableLabels = AppMessages["sessions"];

interface SessionsTableCardProps {
  locale: Locale;
  messages: AppMessages;
  labels: SessionsTableLabels;
  rows: JourneySession[];
  onOpenSession: (sessionId: string) => void;
  onOpenVisitor?: (visitorId: string) => void;
  sort: SessionSortState;
  onSort: (key: SessionSortKey) => void;
  loadingRows?: boolean;
  loadingMore?: boolean;
  error?: boolean;
  appendError?: boolean;
  hasMore?: boolean;
  skeletonRows?: number;
  onLoadMore?: () => void;
  visibleColumnIds?: readonly SessionTableColumnId[];
}

function SessionRowSkeletonContent({
  index,
  columns,
}: {
  index: number;
  columns: readonly SessionTableColumnId[];
}) {
  const widths: Record<SessionTableColumnId, string> = {
    visitor: "w-28",
    sessionId: "w-24",
    started: "w-20",
    duration: "w-16",
    pageViews: "w-10",
    customEvents: "w-10",
    referrer: "w-24",
    location: "w-28",
    os: "w-24",
    browser: "w-24",
    device: "w-20",
    entryPage: "w-36",
    exitPage: "w-36",
    screenSize: "w-20",
    exitTime: "w-20",
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
                ["duration", "pageViews", "customEvents"].includes(columnId) &&
                  "ml-auto",
                ["started", "screenSize", "exitTime"].includes(columnId) &&
                  "mx-auto",
              )}
            />
          )}
        </TableCell>
      ))}
    </>
  );
}

function PageViewsValue({ locale, views }: { locale: Locale; views: number }) {
  const value = numberFormat(locale, views);
  if (views === 1) {
    return (
      <span className="font-mono font-semibold tabular-nums text-amber-600 dark:text-amber-400">
        {value}
      </span>
    );
  }
  return <span className="font-mono tabular-nums">{value}</span>;
}

function CustomEventsValue({
  locale,
  events,
}: {
  locale: Locale;
  events: number;
}) {
  return (
    <span className="font-mono tabular-nums">
      {numberFormat(locale, events)}
    </span>
  );
}

function SessionDurationValue({
  locale,
  durationMs,
}: {
  locale: Locale;
  durationMs: number;
}) {
  if (durationMs === 0) {
    return <span className="text-muted-foreground">-</span>;
  }

  return <>{formatDuration(locale, durationMs)}</>;
}

function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction: SessionSortDirection;
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
  direction: SessionSortDirection;
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

function isSessionActive(row: JourneySession, now: number): boolean {
  if (typeof row.active === "boolean") return row.active;
  return row.endedAt > now - 5 * 60 * 1000;
}

const SessionTableRowContent = memo(function SessionTableRowContent({
  locale,
  messages,
  labels,
  row,
  now,
  onOpenSession,
  onOpenVisitor,
  columns,
}: {
  locale: Locale;
  messages: AppMessages;
  labels: SessionsTableLabels;
  row: JourneySession;
  now: number;
  onOpenSession: (sessionId: string) => void;
  onOpenVisitor?: (visitorId: string) => void;
  columns: readonly SessionTableColumnId[];
}) {
  const active = isSessionActive(row, now);
  const openSession = () => onOpenSession(row.sessionId);
  const sessionId = row.sessionId.trim();
  const visitorId = row.visitorId.trim();
  const entryPath = formatPath(row.entryPath);
  const exitPath = formatPath(row.exitPath);
  const referrerHost = row.referrerHost.trim();
  const referrerUrl = row.referrerUrl.trim();
  const referrerDetails = {
    key: `session-referrer:${sessionId}:${referrerHost}:${referrerUrl}`,
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

  const cells: Record<SessionTableColumnId, ReactNode> = {
    visitor: (
      <ClickableTableCell
        onClick={openSession}
        className="w-32"
        buttonClassName="pl-4"
        focusable
        ariaLabel={`${labels.sessionId}: ${row.sessionId}`}
      >
        <div className="flex w-28 min-w-0 items-center gap-2">
          <VisitorAvatar seed={row.visitorId} className="size-6" />
          <AnalyticsDetailsTooltipTarget
            className="min-w-0 flex-1 truncate"
            locale={locale}
            request={{
              key: `session-visitor:${sessionId}:${visitorId}`,
              items: [
                {
                  label: messages.sessionDetail.visitorId,
                  value: visitorId || messages.common.unknown,
                  copyValue: visitorId || undefined,
                  action:
                    visitorId && onOpenVisitor
                      ? {
                          label: messages.common.search,
                          onClick: () => onOpenVisitor(visitorId),
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
      <ClickableTableCell onClick={openSession} className="max-w-32">
        <div className="flex min-w-0 items-center gap-1">
          <AnalyticsDetailsTooltipTarget
            className="min-w-0 flex-1 truncate"
            locale={locale}
            request={{
              key: `session-id:${sessionId}`,
              items: [
                {
                  label: labels.sessionId,
                  value: sessionId || messages.common.unknown,
                  copyValue: sessionId || undefined,
                  action: sessionId
                    ? {
                        label: messages.common.search,
                        onClick: openSession,
                      }
                    : undefined,
                },
              ],
            }}
          >
            <span className="block truncate font-mono font-medium">
              {row.sessionId}
            </span>
          </AnalyticsDetailsTooltipTarget>
        </div>
      </ClickableTableCell>
    ),
    started: (
      <ClickableTableCell
        onClick={openSession}
        className={cn(
          "text-center font-mono",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <AnalyticsTimeTooltipTarget
          className="block"
          locale={locale}
          timestamp={row.startedAt}
        >
          {formatRelativeTime(locale, row.startedAt, now)}
        </AnalyticsTimeTooltipTarget>
      </ClickableTableCell>
    ),
    duration: (
      <ClickableTableCell
        onClick={openSession}
        className="text-right font-mono tabular-nums"
      >
        <SessionDurationValue locale={locale} durationMs={row.durationMs} />
      </ClickableTableCell>
    ),
    pageViews: (
      <ClickableTableCell onClick={openSession} className="text-right">
        <PageViewsValue locale={locale} views={row.views} />
      </ClickableTableCell>
    ),
    customEvents: (
      <ClickableTableCell onClick={openSession} className="text-right">
        <CustomEventsValue locale={locale} events={row.events} />
      </ClickableTableCell>
    ),
    referrer: (
      <ClickableTableCell onClick={openSession} className="max-w-48">
        <AnalyticsDetailsTooltipTarget
          className="block"
          locale={locale}
          request={referrerDetails}
        >
          <ReferrerMeta
            referrerHost={row.referrerHost}
            referrerUrl={row.referrerUrl}
            directLabel={messages.overview.direct}
          />
        </AnalyticsDetailsTooltipTarget>
      </ClickableTableCell>
    ),
    location: (
      <ClickableTableCell onClick={openSession} className="max-w-52">
        <AnalyticsDetailsTooltipTarget
          className="block"
          locale={locale}
          request={{
            key: `session-location:${sessionId}:${row.country}:${row.region}:${row.regionCode}:${row.city}`,
            items: [
              {
                label: messages.common.location,
                value: (
                  <CountryRegionMeta
                    locale={locale}
                    messages={messages}
                    country={row.country}
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
            country={row.country}
            region={row.region}
            regionCode={row.regionCode}
          />
        </AnalyticsDetailsTooltipTarget>
      </ClickableTableCell>
    ),
    os: (
      <ClickableTableCell onClick={openSession} className="max-w-40">
        <OsMeta
          os={row.os}
          version={row.osVersion}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
    ),
    browser: (
      <ClickableTableCell onClick={openSession} className="max-w-40">
        <BrowserMeta
          browser={row.browser}
          version={row.browserVersion}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
    ),
    device: (
      <ClickableTableCell onClick={openSession} className="max-w-36">
        <DeviceMeta
          deviceType={row.deviceType}
          deviceLabels={messages.common.deviceLabels}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
    ),
    entryPage: (
      <ClickableTableCell
        onClick={openSession}
        className="max-w-56 font-mono"
        buttonClassName="truncate"
      >
        <AnalyticsDetailsTooltipTarget
          className="block truncate"
          locale={locale}
          request={{
            key: `session-entry-page:${sessionId}:${row.entryPath}`,
            items: [
              {
                label: labels.entryPage,
                value: entryPath,
                copyValue: entryPath,
              },
            ],
          }}
        >
          {entryPath}
        </AnalyticsDetailsTooltipTarget>
      </ClickableTableCell>
    ),
    exitPage: (
      <ClickableTableCell
        onClick={openSession}
        className="max-w-56 font-mono"
        buttonClassName="truncate pr-4"
      >
        <AnalyticsDetailsTooltipTarget
          className="block truncate"
          locale={locale}
          request={{
            key: `session-exit-page:${sessionId}:${row.exitPath}`,
            items: [
              {
                label: labels.exitPage,
                value: exitPath,
                copyValue: exitPath,
              },
            ],
          }}
        >
          {exitPath}
        </AnalyticsDetailsTooltipTarget>
      </ClickableTableCell>
    ),
    screenSize: (
      <ClickableTableCell
        onClick={openSession}
        className="text-center font-mono"
      >
        {formatScreen(row.screenWidth, row.screenHeight)}
      </ClickableTableCell>
    ),
    exitTime: (
      <ClickableTableCell
        onClick={openSession}
        className={cn(
          "text-center font-mono",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        <AnalyticsTimeTooltipTarget
          className="block"
          locale={locale}
          timestamp={row.endedAt}
        >
          {formatRelativeTime(locale, row.endedAt, now)}
        </AnalyticsTimeTooltipTarget>
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

export const SessionsTableCard = memo(function SessionsTableCard({
  locale,
  messages,
  labels,
  rows,
  onOpenSession,
  onOpenVisitor,
  sort,
  onSort,
  loadingRows = false,
  loadingMore = false,
  error = false,
  appendError = false,
  hasMore = false,
  skeletonRows = 25,
  onLoadMore,
  visibleColumnIds = SESSION_TABLE_COLUMN_IDS,
}: SessionsTableCardProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const headers = useMemo<Record<SessionTableColumnId, ReactNode>>(
    () => ({
      visitor: <TableHead className="w-32 pl-4">{labels.visitor}</TableHead>,
      sessionId: <TableHead>{labels.sessionId}</TableHead>,
      started: (
        <SortHeader
          label={labels.started}
          ariaLabel={formatI18nTemplate(messages.common.sortBy, {
            label: labels.started,
          })}
          active={sort.key === "startedAt"}
          direction={sort.direction}
          onClick={() => onSort("startedAt")}
          align="center"
          className="text-center"
        />
      ),
      duration: (
        <SortHeader
          label={labels.duration}
          ariaLabel={formatI18nTemplate(messages.common.sortBy, {
            label: labels.duration,
          })}
          active={sort.key === "durationMs"}
          direction={sort.direction}
          onClick={() => onSort("durationMs")}
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
          onClick={() => onSort("views")}
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
      device: <TableHead>{labels.device}</TableHead>,
      entryPage: <TableHead>{labels.entryPage}</TableHead>,
      exitPage: <TableHead>{labels.exitPage}</TableHead>,
      screenSize: (
        <TableHead className="text-center">{labels.screenSize}</TableHead>
      ),
      exitTime: (
        <TableHead className="text-center">{labels.exitTime}</TableHead>
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
    (row: JourneySession) => ({
      children: (
        <SessionTableRowContent
          locale={locale}
          messages={messages}
          labels={labels}
          row={row}
          now={now}
          onOpenSession={onOpenSession}
          onOpenVisitor={onOpenVisitor}
          columns={visibleColumnIds}
        />
      ),
      props: {
        "data-session-row": "",
        className: "cursor-pointer",
      },
    }),
    [
      labels,
      locale,
      messages,
      now,
      onOpenSession,
      onOpenVisitor,
      visibleColumnIds,
    ],
  );
  const renderSkeletonRow = useCallback(
    (index: number) => (
      <SessionRowSkeletonContent index={index} columns={visibleColumnIds} />
    ),
    [visibleColumnIds],
  );
  const getRowKey = useCallback((row: JourneySession) => row.sessionId, []);

  return (
    <AnalyticsDataTable
      header={header}
      rows={rows}
      renderRow={renderRow}
      renderSkeletonRow={renderSkeletonRow}
      getRowKey={getRowKey}
      skeletonRows={skeletonRows}
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

SessionsTableCard.displayName = "SessionsTableCard";
