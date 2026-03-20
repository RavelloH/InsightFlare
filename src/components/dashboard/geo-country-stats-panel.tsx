"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  RiArrowDownSLine,
  RiExternalLinkLine,
  RiArrowLeftLine,
  RiInformationLine,
  RiArrowUpSLine,
} from "@remixicon/react";
import { OverlayScrollbars } from "overlayscrollbars";
import type { PartialOptions } from "overlayscrollbars";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Card } from "@/components/ui/card";
import { Clickable } from "@/components/ui/clickable";
import {
  TableCell,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { numberFormat } from "@/lib/dashboard/format";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

interface GeoCountryStatsPanelProps {
  locale: Locale;
  messages: AppMessages;
  loading: boolean;
  stacked?: boolean;
  columnLabel: string;
  currentLocationInfo?: {
    lines: string[];
  } | null;
  wikiSummary?: {
    title: string;
    description: string | null;
    extract: string | null;
    pageUrl: string | null;
  } | null;
  investigationRows?: Array<{
    label: string;
    value: ReactNode;
    fullWidth?: boolean;
  }> | null;
  entries: Array<{
    key: string;
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  selectedEntryKey?: string | null;
  onSelectEntry?: ((key: string) => void) | undefined;
  onBack?: (() => void) | undefined;
}

type SortKey = "visitors" | "views";
type SortDirection = "asc" | "desc";

const PANEL_SCROLLBAR_OPTIONS = {
  overflow: {
    x: "hidden",
    y: "scroll",
  },
  scrollbars: {
    theme: "os-theme-insightflare",
    autoHide: "move",
  },
} satisfies PartialOptions;

export function GeoCountryStatsPanel({
  locale,
  messages,
  loading,
  stacked = false,
  columnLabel,
  currentLocationInfo,
  wikiSummary,
  investigationRows,
  entries,
  selectedEntryKey,
  onSelectEntry,
  onBack,
}: GeoCountryStatsPanelProps) {
  const [sort, setSort] = useState<{
    key: SortKey;
    direction: SortDirection;
  }>({
    key: "visitors",
    direction: "desc",
  });
  const scrollHostRef = useRef<HTMLDivElement | null>(null);
  const scrollbarsRef = useRef<ReturnType<typeof OverlayScrollbars> | null>(null);

  useEffect(() => {
    if (stacked) {
      scrollbarsRef.current?.destroy();
      scrollbarsRef.current = null;
      return;
    }

    const host = scrollHostRef.current;
    if (!host) return;

    const existing = OverlayScrollbars(host);
    const instance = existing ?? OverlayScrollbars(host, PANEL_SCROLLBAR_OPTIONS);
    scrollbarsRef.current = instance;

    instance.options(PANEL_SCROLLBAR_OPTIONS);

    return () => {
      if (scrollbarsRef.current === instance) {
        scrollbarsRef.current = null;
      }
      if (!existing) {
        instance.destroy();
      }
    };
  }, [stacked]);

  const toggleSort = (key: SortKey) => {
    setSort((previous) =>
      previous.key === key
        ? {
            key,
            direction: previous.direction === "desc" ? "asc" : "desc",
          }
        : {
            key,
            direction: "desc",
          },
    );
  };

  const renderSortIndicator = (key: SortKey) => {
    if (sort.key === key) {
      return sort.direction === "desc" ? (
        <RiArrowDownSLine className="size-3.5" />
      ) : (
        <RiArrowUpSLine className="size-3.5" />
      );
    }

    return (
      <span className="flex flex-col text-muted-foreground/70">
        <RiArrowUpSLine className="-mb-1 size-3.5" />
        <RiArrowDownSLine className="-mt-1 size-3.5" />
      </span>
    );
  };

  const sortedEntries = useMemo(() => {
    return [...entries]
      .sort((left, right) => {
        const direction = sort.direction === "asc" ? 1 : -1;
        const delta =
          (Number(left[sort.key] ?? 0) - Number(right[sort.key] ?? 0)) * direction;
        if (delta !== 0) return delta;
        return String(left.label).localeCompare(String(right.label), locale);
      });
  }, [entries, locale, sort.direction, sort.key]);

  const progressTotal = useMemo(
    () =>
      sortedEntries.reduce(
        (sum, entry) => sum + Math.max(0, Number(entry[sort.key] ?? 0)),
        0,
      ),
    [sort.key, sortedEntries],
  );
  const hasVisibleContent = sortedEntries.length > 0;
  const hasTopSectionContent = Boolean(
    onBack || (currentLocationInfo && currentLocationInfo.lines.length > 0),
  );
  const geoInvestigationNotice = messages.geo.investigationNotice;
  const topSectionTransitionKey = useMemo(() => {
    const linesKey =
      currentLocationInfo?.lines.map((line) => line.trim()).join("|") ?? "";
    const rowsKey =
      investigationRows?.map((row) => row.label.trim()).join("|") ?? "";
    const wikiKey = [
      wikiSummary?.title,
      wikiSummary?.description,
      wikiSummary?.extract,
      wikiSummary?.pageUrl,
    ]
      .map((value) => String(value ?? "").trim())
      .filter((value) => value.length > 0)
      .join("|");
    return `${onBack ? "back" : "root"}::${linesKey}::${rowsKey}::${wikiKey}`;
  }, [currentLocationInfo?.lines, investigationRows, onBack, wikiSummary]);

  useEffect(() => {
    if (stacked) return;
    scrollbarsRef.current?.update(true);
  }, [
    hasTopSectionContent,
    investigationRows,
    loading,
    onBack,
    sortedEntries.length,
    stacked,
    wikiSummary?.description,
    wikiSummary?.extract,
    wikiSummary?.pageUrl,
  ]);

  const tableHeader = (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{columnLabel}</div>
      </TableHead>
      <TableHead className="h-8 w-[4.75rem] p-0">
        <div className="flex justify-end px-2">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              sort.key === "visitors" ? "text-foreground" : "text-muted-foreground",
            )}
            onClick={() => toggleSort("visitors")}
          >
            {messages.common.visitors}
            {renderSortIndicator("visitors")}
          </button>
        </div>
      </TableHead>
      <TableHead className="h-8 w-[4.75rem] p-0">
        <div className="flex justify-end px-4">
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
              sort.key === "views" ? "text-foreground" : "text-muted-foreground",
            )}
            onClick={() => toggleSort("views")}
          >
            {messages.common.views}
            {renderSortIndicator("views")}
          </button>
        </div>
      </TableHead>
    </TableRow>
  );

  const rows = sortedEntries.map((entry) => {
    const rowValue = Math.max(0, Number(entry[sort.key] ?? 0));
    const progressPercent =
      progressTotal > 0 ? Math.min(100, (rowValue / progressTotal) * 100) : 0;
    const progressWidth = `${progressPercent.toFixed(2)}%`;
    const isSelected = entry.key === String(selectedEntryKey ?? "").trim();

    return (
      <TableRow
        key={entry.key}
        className={cn(
          "bg-no-repeat transition-[background-size,filter] duration-300 ease-out",
          onSelectEntry && "cursor-pointer hover:brightness-95",
          isSelected && "brightness-95",
        )}
        style={{
          backgroundImage:
            "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
          backgroundSize: `${progressWidth} 100%`,
          backgroundPosition: "left top",
        }}
        onClick={() => onSelectEntry?.(entry.key)}
      >
        <TableCell className="p-0 align-top">
          <div className="px-4 py-2 leading-5 whitespace-normal break-words">
            {entry.label}
          </div>
        </TableCell>
        <TableCell className="p-0">
          <div className="px-2 py-2 text-right font-mono tabular-nums">
            {numberFormat(locale, entry.visitors)}
          </div>
        </TableCell>
        <TableCell className="p-0">
          <div className="px-2 py-2 text-right font-mono tabular-nums">
            {numberFormat(locale, entry.views)}
          </div>
        </TableCell>
      </TableRow>
    );
  });

  const wrapperClassName = stacked
    ? "relative z-0 w-full"
    : "pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[44svh] p-3 sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:w-[23.5rem]";
  const cardClassName = stacked
    ? "pointer-events-auto border border-border/70 bg-background/90 py-0 shadow-sm"
    : "pointer-events-auto h-full overflow-hidden border-x-0 border-y border-border/70 bg-background/75 py-0 ring-0 backdrop-blur-xl";
  const scrollHostClassName = stacked
    ? "overflow-visible"
    : "h-full overflow-hidden";

  return (
    <aside className={wrapperClassName}>
      <Card className={cardClassName}>
        <div
          ref={scrollHostRef}
          className={scrollHostClassName}
          data-overlayscrollbars-initialize
        >
          <div className="min-h-full">
            <AutoResizer initial className="shrink-0">
              <AutoTransition initial>
                <div
                  key={topSectionTransitionKey}
                  className={cn(hasTopSectionContent ? "py-3" : "py-0")}
                >
                  <div className="space-y-3">
                    {onBack ? (
                      <div className="px-4">
                        <Clickable
                          onClick={onBack}
                          hoverScale={1.05}
                          tapScale={0.98}
                          aria-label={messages.geo.back}
                          className={cn(
                            "peer/menu-button group/menu-button flex h-8 w-full items-center justify-start gap-2 overflow-hidden rounded-none p-2 text-left text-xs outline-hidden transition-[width,height,padding]",
                            "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                            "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                            "active:bg-sidebar-accent active:text-sidebar-accent-foreground",
                            "[&_svg]:size-4 [&_svg]:shrink-0 [&>span:last-child]:truncate",
                          )}
                        >
                          <RiArrowLeftLine />
                          <span>{messages.geo.back}</span>
                        </Clickable>
                      </div>
                    ) : null}

                    {currentLocationInfo && currentLocationInfo.lines.length > 0 ? (
                      <div className="border-y border-border/70 px-4 py-3">
                      <div className="space-y-1">
                        {currentLocationInfo.lines.map((line) => (
                          <div
                            key={line}
                            className="text-2xl leading-tight font-semibold tracking-tight text-foreground sm:text-[1.9rem]"
                            >
                              {line}
                          </div>
                        ))}
                      </div>
                      {wikiSummary?.description ? (
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                          {wikiSummary.description}
                        </p>
                      ) : null}
                        {((investigationRows && investigationRows.length > 0) ||
                          wikiSummary?.extract ||
                          wikiSummary?.pageUrl) ? (
                          <div className="mt-3 space-y-3">
                            {investigationRows && investigationRows.length > 0 ? (
                              <dl className="grid grid-cols-1 gap-x-5 gap-y-2.5 sm:grid-cols-2">
                                {investigationRows.map((row, index) => (
                                  <div
                                    key={`${row.label}-${index}`}
                                    className={cn("min-w-0", row.fullWidth && "sm:col-span-2")}
                                  >
                                    <dt className="text-[11px] leading-4 text-muted-foreground">
                                      {row.label}
                                    </dt>
                                    <dd className="mt-0.5 break-words text-sm leading-5 font-medium whitespace-pre-line text-foreground">
                                      {row.value}
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            ) : null}
                            {wikiSummary?.extract ? (
                              <p className="text-sm leading-6 text-foreground/80">
                                {wikiSummary.extract}
                              </p>
                            ) : null}
                            {wikiSummary?.pageUrl ? (
                              <a
                                href={wikiSummary.pageUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
                              >
                                {messages.geo.viewOnWikipedia}
                                <RiExternalLinkLine className="size-3.5 shrink-0" />
                              </a>
                            ) : null}
                            <p className="text-[11px] leading-4 text-muted-foreground">
                              <span className="mr-1.5 inline-flex h-4 align-top items-center">
                                <RiInformationLine className="size-3.5" />
                              </span>
                              {geoInvestigationNotice}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </AutoTransition>
            </AutoResizer>

            <AutoResizer initial className="shrink-0">
              <div className="py-3">
                <DataTableSwitch
                  loading={loading}
                  hasContent={hasVisibleContent}
                  loadingLabel={messages.common.loading}
                  emptyLabel={messages.common.noData}
                  colSpan={3}
                  contentKey={`${sort.key}-${sort.direction}-${selectedEntryKey ?? "none"}`}
                  header={tableHeader}
                  rows={rows}
                />
              </div>
            </AutoResizer>
          </div>
        </div>
      </Card>
    </aside>
  );
}
