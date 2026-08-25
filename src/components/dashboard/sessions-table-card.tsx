import { memo, useEffect, useState } from "react";
import { RiArrowDownSLine, RiArrowUpSLine } from "@remixicon/react";

import { AnalyticsDataTable } from "@/components/dashboard/analytics-data-table";
import { ClickableTableCell } from "@/components/dashboard/clickable-table-cell";
import {
  BrowserMeta,
  CountryRegionMeta,
  DeviceMeta,
  formatDuration,
  formatPath,
  formatRelativeTime,
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
import { cn } from "@/lib/utils";

export type SessionSortDirection = "asc" | "desc";
export type SessionSortKey = "startedAt" | "durationMs" | "views";

export interface SessionSortState {
  key: SessionSortKey;
  direction: SessionSortDirection;
}

export type SessionsTableLabels = AppMessages["sessions"];

interface SessionsTableCardProps {
  locale: Locale;
  messages: AppMessages;
  labels: SessionsTableLabels;
  rows: JourneySession[];
  onOpenSession: (sessionId: string) => void;
  sort: SessionSortState;
  onSort: (key: SessionSortKey) => void;
  loadingRows?: boolean;
  loadingMore?: boolean;
  error?: boolean;
  appendError?: boolean;
  hasMore?: boolean;
  skeletonRows?: number;
  onLoadMore?: () => void;
}

function shortId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 9)}...`;
}

function SessionRowSkeletonContent({ index }: { index: number }) {
  const widths = [
    "w-28",
    "w-24",
    "w-20",
    "w-16",
    "w-10",
    "w-24",
    "w-28",
    "w-24",
    "w-24",
    "w-20",
    "w-36",
    "w-36",
  ];

  return (
    <>
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
                cellIndex === 3 && "ml-auto",
                cellIndex === 4 && "mx-auto",
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
  active,
  direction,
  onClick,
  align = "left",
  className,
}: {
  label: string;
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
}: {
  locale: Locale;
  messages: AppMessages;
  labels: SessionsTableLabels;
  row: JourneySession;
  now: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const active = isSessionActive(row, now);
  const openSession = () => onOpenSession(row.sessionId);

  return (
    <>
      <ClickableTableCell
        onClick={openSession}
        className="w-32"
        buttonClassName="pl-4"
        focusable
        ariaLabel={`${labels.sessionId}: ${row.sessionId}`}
      >
        <div className="flex w-28 items-center gap-2">
          <VisitorAvatar seed={row.visitorId} className="size-6" />
          <span className="truncate">{labels.anonymous}</span>
        </div>
      </ClickableTableCell>
      <ClickableTableCell onClick={openSession}>
        <span className="font-mono font-medium">{shortId(row.sessionId)}</span>
      </ClickableTableCell>
      <ClickableTableCell
        onClick={openSession}
        className={cn(
          "font-mono",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {formatRelativeTime(locale, row.startedAt, now)}
      </ClickableTableCell>
      <ClickableTableCell
        onClick={openSession}
        className="text-right font-mono tabular-nums"
      >
        <SessionDurationValue locale={locale} durationMs={row.durationMs} />
      </ClickableTableCell>
      <ClickableTableCell onClick={openSession} className="text-center">
        <PageViewsValue locale={locale} views={row.views} />
      </ClickableTableCell>
      <ClickableTableCell onClick={openSession} className="max-w-48">
        <ReferrerMeta
          referrerHost={row.referrerHost}
          referrerUrl={row.referrerUrl}
          directLabel={messages.overview.direct}
        />
      </ClickableTableCell>
      <ClickableTableCell onClick={openSession} className="max-w-52">
        <CountryRegionMeta
          locale={locale}
          messages={messages}
          country={row.country}
          region={row.region}
          regionCode={row.regionCode}
        />
      </ClickableTableCell>
      <ClickableTableCell onClick={openSession} className="max-w-40">
        <OsMeta
          os={row.os}
          version={row.osVersion}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
      <ClickableTableCell onClick={openSession} className="max-w-40">
        <BrowserMeta
          browser={row.browser}
          version={row.browserVersion}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
      <ClickableTableCell onClick={openSession} className="max-w-36">
        <DeviceMeta
          deviceType={row.deviceType}
          deviceLabels={messages.common.deviceLabels}
          unknownLabel={messages.common.unknown}
        />
      </ClickableTableCell>
      <ClickableTableCell
        onClick={openSession}
        className="max-w-56 font-mono"
        buttonClassName="truncate"
      >
        {formatPath(row.entryPath)}
      </ClickableTableCell>
      <ClickableTableCell
        onClick={openSession}
        className="max-w-56 font-mono"
        buttonClassName="truncate pr-4"
      >
        {formatPath(row.exitPath)}
      </ClickableTableCell>
    </>
  );
});

export function SessionsTableCard({
  locale,
  messages,
  labels,
  rows,
  onOpenSession,
  sort,
  onSort,
  loadingRows = false,
  loadingMore = false,
  error = false,
  appendError = false,
  hasMore = false,
  skeletonRows = 8,
  onLoadMore,
}: SessionsTableCardProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <AnalyticsDataTable
      header={
        <TableRow>
          <TableHead className="w-32 pl-4">{labels.visitor}</TableHead>
          <TableHead>{labels.sessionId}</TableHead>
          <SortHeader
            label={labels.started}
            active={sort.key === "startedAt"}
            direction={sort.direction}
            onClick={() => onSort("startedAt")}
          />
          <SortHeader
            label={labels.duration}
            active={sort.key === "durationMs"}
            direction={sort.direction}
            onClick={() => onSort("durationMs")}
            align="center"
            className="text-center"
          />
          <SortHeader
            label={labels.pageViews}
            active={sort.key === "views"}
            direction={sort.direction}
            onClick={() => onSort("views")}
            align="center"
            className="text-center"
          />
          <TableHead>{labels.referrer}</TableHead>
          <TableHead>{labels.location}</TableHead>
          <TableHead>{labels.os}</TableHead>
          <TableHead>{labels.browser}</TableHead>
          <TableHead>{labels.device}</TableHead>
          <TableHead>{labels.entryPage}</TableHead>
          <TableHead>{labels.exitPage}</TableHead>
        </TableRow>
      }
      rows={rows}
      renderRow={(row) => ({
        children: (
          <SessionTableRowContent
            locale={locale}
            messages={messages}
            labels={labels}
            row={row}
            now={now}
            onOpenSession={onOpenSession}
          />
        ),
        props: {
          "data-session-row": "",
          className: "cursor-pointer",
        },
      })}
      renderSkeletonRow={(index) => <SessionRowSkeletonContent index={index} />}
      getRowKey={(row) => row.sessionId}
      skeletonRows={skeletonRows}
      columnCount={12}
      loading={loadingRows}
      loadingMore={loadingMore}
      error={error}
      errorContent={labels.loadError}
      emptyContent={labels.empty}
      appendError={appendError}
      appendErrorContent={labels.loadError}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
    />
  );
}
