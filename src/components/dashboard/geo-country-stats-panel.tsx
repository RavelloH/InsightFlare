"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  RiArrowDownSLine,
  RiArrowLeftSLine,
  RiArrowUpSLine,
} from "@remixicon/react";
import { OverlayScrollbars } from "overlayscrollbars";
import type { PartialOptions } from "overlayscrollbars";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import { AutoResizer } from "@/components/ui/auto-resizer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
  columnLabel: string;
  currentLocationInfo?: {
    lines: string[];
  } | null;
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
    autoHideDelay: 420,
    autoHideSuspend: false,
  },
} satisfies PartialOptions;

export function GeoCountryStatsPanel({
  locale,
  messages,
  loading,
  columnLabel,
  currentLocationInfo,
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

  useEffect(() => {
    const host = scrollHostRef.current;
    if (!host) return;

    const existing = OverlayScrollbars(host);
    const instance =
      existing ?? OverlayScrollbars(host, PANEL_SCROLLBAR_OPTIONS);

    if (existing) {
      existing.options(PANEL_SCROLLBAR_OPTIONS);
    }

    return () => {
      if (!existing) {
        instance.destroy();
      }
    };
  }, []);

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

  return (
    <aside className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[44svh] p-3 sm:inset-y-0 sm:right-0 sm:left-auto sm:h-full sm:w-[23.5rem]">
      <Card className="pointer-events-auto h-full border-x-0 border-y border-border/70 bg-background/75 py-0 ring-0 backdrop-blur-xl">
        <div
          ref={scrollHostRef}
          className="h-full overflow-hidden"
          data-overlayscrollbars-initialize
        >
          <div className="space-y-3 py-3">
            {onBack ? (
              <div className="px-4">
                <Button variant="ghost" size="xs" onClick={onBack}>
                  <RiArrowLeftSLine className="size-3.5" />
                  <span>{locale === "zh" ? "返回上一级" : "Back"}</span>
                </Button>
              </div>
            ) : null}

            {currentLocationInfo && currentLocationInfo.lines.length > 0 ? (
              <AutoResizer initial className="w-full">
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
                </div>
              </AutoResizer>
            ) : null}

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
        </div>
      </Card>
    </aside>
  );
}
