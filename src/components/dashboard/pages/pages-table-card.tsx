import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useMemo,
} from "react";
import {
  RiArrowDownLine,
  RiArrowDownSLine,
  RiArrowUpLine,
  RiArrowUpSLine,
  RiSearchLine,
} from "@remixicon/react";

import { AnalyticsDetailsTooltipTarget } from "@/components/dashboard/analytics-time-tooltip";
import { TrafficPairBarChart } from "@/components/dashboard/charts/traffic-pair-bar-chart";
import { AnalyticsDataTable } from "@/components/dashboard/common/analytics-data-table";
import {
  type AnalyticsTableColumnDefinition,
  AnalyticsTableColumnSettings,
  type AnalyticsTableColumnSettingsLabels,
} from "@/components/dashboard/common/analytics-table-column-settings";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import type { PagesDashboardRow } from "@/lib/dashboard/client/data/types";
import {
  durationFormat,
  intlLocale,
  numberFormat,
  percentFormat,
} from "@/lib/dashboard/format";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import type { PagesDashboardMetric } from "@/lib/dashboard-api/contract/types/pages";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";
export const PAGES_TABLE_COLUMN_IDS = [
  "page",
  "trend",
  "views",
  "viewsChange",
  "visitors",
  "visitorsChange",
  "sessions",
  "sessionsChange",
  "bounceRate",
  "bounceRateChange",
  "pagesPerSession",
  "pagesPerSessionChange",
  "avgDurationMs",
  "avgDurationMsChange",
] as const;
export type PagesTableColumnId = (typeof PAGES_TABLE_COLUMN_IDS)[number];
type PagesChangeColumnId = `${PagesDashboardMetric}Change`;
const CHANGE_COLUMN_METRICS: Record<PagesChangeColumnId, PagesDashboardMetric> =
  {
    viewsChange: "views",
    visitorsChange: "visitors",
    sessionsChange: "sessions",
    bounceRateChange: "bounceRate",
    pagesPerSessionChange: "pagesPerSession",
    avgDurationMsChange: "avgDurationMs",
  };
export const PAGES_TABLE_COLUMNS_STORAGE_KEY =
  "insightflare:analytics-table-columns:pages:v2";
export const LEGACY_PAGES_TABLE_COLUMNS_STORAGE_KEY =
  "insightflare:analytics-table-columns:pages";
const PAGES_PER_SESSION_FORMATTERS = new Map<Locale, Intl.NumberFormat>();
const CHANGE_FORMATTERS = new Map<Locale, Intl.NumberFormat>();
export type PagesSortState = {
  key: PagesDashboardMetric;
  direction: "asc" | "desc";
};
export function createPagesTableColumnDefinitions(
  messages: AppMessages,
): readonly AnalyticsTableColumnDefinition<PagesTableColumnId>[] {
  return [
    { id: "page", label: messages.common.path, required: true },
    { id: "trend", label: messages.pages.trendTitle },
    { id: "views", label: messages.common.views },
    {
      id: "viewsChange",
      label: formatI18nTemplate(messages.pages.changePercentColumnLabel, {
        metric: messages.common.views,
      }),
      defaultVisible: true,
    },
    { id: "visitors", label: messages.common.visitors },
    {
      id: "visitorsChange",
      label: formatI18nTemplate(messages.pages.changePercentColumnLabel, {
        metric: messages.common.visitors,
      }),
      defaultVisible: true,
    },
    { id: "sessions", label: messages.common.sessions },
    {
      id: "sessionsChange",
      label: formatI18nTemplate(messages.pages.changePercentColumnLabel, {
        metric: messages.common.sessions,
      }),
      defaultVisible: true,
    },
    { id: "bounceRate", label: messages.common.bounceRate },
    {
      id: "bounceRateChange",
      label: formatI18nTemplate(messages.pages.changePointsColumnLabel, {
        metric: messages.common.bounceRate,
      }),
      defaultVisible: false,
    },
    { id: "pagesPerSession", label: messages.pages.pagesPerSession },
    {
      id: "pagesPerSessionChange",
      label: formatI18nTemplate(messages.pages.changePercentColumnLabel, {
        metric: messages.pages.pagesPerSession,
      }),
      defaultVisible: false,
    },
    { id: "avgDurationMs", label: messages.common.avgDuration },
    {
      id: "avgDurationMsChange",
      label: formatI18nTemplate(messages.pages.changePercentColumnLabel, {
        metric: messages.common.avgDuration,
      }),
      defaultVisible: false,
    },
  ];
}
interface PagesTableCardProps {
  locale: Locale;
  messages: AppMessages;
  rows: readonly PagesDashboardRow[];
  sort: PagesSortState;
  onSort: (key: PagesDashboardMetric) => void;
  onOpenPage: (pathname: string) => void;
  comparisonActive: boolean;
  comparisonLabel: string;
  currentWindow: TimeWindow;
  comparisonWindow?: TimeWindow;
  searchValue: string;
  searchPlaceholder: string;
  onSearchChange: (value: string) => void;
  columnDefinitions: readonly AnalyticsTableColumnDefinition<PagesTableColumnId>[];
  orderedColumnIds: readonly PagesTableColumnId[];
  visibleColumnIds: readonly PagesTableColumnId[];
  onColumnOrderChange: (nextOrder: readonly PagesTableColumnId[]) => void;
  onColumnVisibilityChange: (
    nextVisible: readonly PagesTableColumnId[],
  ) => void;
  onColumnReset: () => void;
  columnSettingsLabels: AnalyticsTableColumnSettingsLabels;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  errorContent: ReactNode;
  emptyContent: ReactNode;
  appendError: boolean;
  appendErrorContent: ReactNode;
  hasMore: boolean;
  skeletonRows: number;
  onLoadMore: () => void;
}
function SortIndicator({
  active,
  direction,
}: {
  active: boolean;
  direction: "asc" | "desc";
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
  align = "right",
}: {
  label: string;
  active: boolean;
  direction: "asc" | "desc";
  onClick: () => void;
  align?: "center" | "right";
}) {
  return (
    <TableHead className={align === "center" ? "text-center" : "text-right"}>
      <div
        className={cn(
          "flex",
          align === "center" ? "justify-center" : "justify-end",
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
function formatChange(locale: Locale, value: number, suffix: string): string {
  let formatter = CHANGE_FORMATTERS.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(intlLocale(locale), {
      signDisplay: "always",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    CHANGE_FORMATTERS.set(locale, formatter);
  }
  const formatted = formatter.format(value);
  return `${formatted}${suffix}`;
}
function changeClass(value: number | null, lowerIsBetter = false): string {
  if (value === null) return "text-muted-foreground";
  const improvement = lowerIsBetter ? value <= 0 : value >= 0;
  return improvement ? "text-emerald-600" : "text-rose-600";
}
function ChangeValue({
  locale,
  value,
  lowerIsBetter = false,
  suffix = "%",
}: {
  locale: Locale;
  value: number | null;
  lowerIsBetter?: boolean;
  suffix?: string;
}) {
  if (value === null) return <span className="text-muted-foreground">—</span>;
  const Icon = value >= 0 ? RiArrowUpLine : RiArrowDownLine;
  return (
    <span
      className={cn(
        "inline-flex items-baseline justify-center gap-1 whitespace-nowrap font-mono text-xs tabular-nums leading-none",
        changeClass(value, lowerIsBetter),
      )}
    >
      <Icon className="relative top-px size-3 shrink-0" />
      {formatChange(locale, value, suffix)}
    </span>
  );
}
function metricLabel(messages: AppMessages, metric: PagesDashboardMetric) {
  if (metric === "pagesPerSession") return messages.pages.pagesPerSession;
  if (metric === "avgDurationMs") return messages.common.avgDuration;
  return messages.common[metric];
}
function metricValue(
  locale: Locale,
  row: PagesDashboardRow,
  metric: PagesDashboardMetric,
): string {
  const value = row.metrics[metric];
  if (metric === "bounceRate") return percentFormat(locale, value);
  if (metric === "pagesPerSession") {
    let formatter = PAGES_PER_SESSION_FORMATTERS.get(locale);
    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
      PAGES_PER_SESSION_FORMATTERS.set(locale, formatter);
    }
    return formatter.format(value);
  }
  if (metric === "avgDurationMs") return durationFormat(locale, value);
  return numberFormat(locale, value);
}
function PageLabel({
  messages,
  row,
}: {
  messages: AppMessages;
  row: PagesDashboardRow;
}) {
  const title = row.titles[0]?.trim() || messages.pages.untitled;
  const path = decodeUrlDisplayValue(row.pathname || "/");
  return (
    <div className="min-w-0 text-left">
      <p className="truncate font-medium text-foreground">{title}</p>
      <p className="truncate font-mono text-xs text-muted-foreground">{path}</p>
    </div>
  );
}
function PageSkeletonRow({
  columnIds,
}: {
  columnIds: readonly PagesTableColumnId[];
}) {
  return (
    <>
      {columnIds.map((columnId) => (
        <TableCell key={columnId}>
          {columnId === "trend" ? (
            <Skeleton className="h-4 w-full" />
          ) : columnId === "page" ? (
            <div className="space-y-0">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-36" />
            </div>
          ) : (
            <Skeleton className={cn("h-4", "ml-auto w-20")} />
          )}
        </TableCell>
      ))}
    </>
  );
}
export function PagesTableCard({
  locale,
  messages,
  rows,
  sort,
  onSort,
  onOpenPage,
  comparisonActive,
  comparisonLabel,
  currentWindow,
  comparisonWindow,
  searchValue,
  searchPlaceholder,
  onSearchChange,
  columnDefinitions,
  orderedColumnIds,
  visibleColumnIds,
  onColumnOrderChange,
  onColumnVisibilityChange,
  onColumnReset,
  columnSettingsLabels,
  loading,
  loadingMore,
  error,
  errorContent,
  emptyContent,
  appendError,
  appendErrorContent,
  hasMore,
  skeletonRows,
  onLoadMore,
}: PagesTableCardProps) {
  const headers = useMemo(() => {
    const headerById: Record<PagesTableColumnId, ReactNode> = {
      page: (
        <TableHead key="page" className="min-w-64 pl-4">
          {messages.common.path}
        </TableHead>
      ),
      views: (
        <SortHeader
          key="views"
          label={metricLabel(messages, "views")}
          active={sort.key === "views"}
          direction={sort.direction}
          onClick={() => onSort("views")}
        />
      ),
      visitors: (
        <SortHeader
          key="visitors"
          label={metricLabel(messages, "visitors")}
          active={sort.key === "visitors"}
          direction={sort.direction}
          onClick={() => onSort("visitors")}
        />
      ),
      viewsChange: (
        <TableHead key="viewsChange" className="whitespace-nowrap text-center">
          {formatI18nTemplate(messages.pages.changePercentColumnLabel, {
            metric: messages.common.views,
          })}
        </TableHead>
      ),
      visitorsChange: (
        <TableHead
          key="visitorsChange"
          className="whitespace-nowrap text-center"
        >
          {formatI18nTemplate(messages.pages.changePercentColumnLabel, {
            metric: messages.common.visitors,
          })}
        </TableHead>
      ),
      sessionsChange: (
        <TableHead
          key="sessionsChange"
          className="whitespace-nowrap text-center"
        >
          {formatI18nTemplate(messages.pages.changePercentColumnLabel, {
            metric: messages.common.sessions,
          })}
        </TableHead>
      ),
      sessions: (
        <SortHeader
          key="sessions"
          label={metricLabel(messages, "sessions")}
          active={sort.key === "sessions"}
          direction={sort.direction}
          onClick={() => onSort("sessions")}
        />
      ),
      bounceRate: (
        <SortHeader
          key="bounceRate"
          label={metricLabel(messages, "bounceRate")}
          active={sort.key === "bounceRate"}
          direction={sort.direction}
          onClick={() => onSort("bounceRate")}
          align="center"
        />
      ),
      bounceRateChange: (
        <TableHead
          key="bounceRateChange"
          className="whitespace-nowrap text-center"
        >
          {formatI18nTemplate(messages.pages.changePointsColumnLabel, {
            metric: messages.common.bounceRate,
          })}
        </TableHead>
      ),
      pagesPerSession: (
        <SortHeader
          key="pagesPerSession"
          label={metricLabel(messages, "pagesPerSession")}
          active={sort.key === "pagesPerSession"}
          direction={sort.direction}
          onClick={() => onSort("pagesPerSession")}
          align="center"
        />
      ),
      pagesPerSessionChange: (
        <TableHead
          key="pagesPerSessionChange"
          className="whitespace-nowrap text-center"
        >
          {formatI18nTemplate(messages.pages.changePercentColumnLabel, {
            metric: messages.pages.pagesPerSession,
          })}
        </TableHead>
      ),
      avgDurationMs: (
        <SortHeader
          key="avgDurationMs"
          label={metricLabel(messages, "avgDurationMs")}
          active={sort.key === "avgDurationMs"}
          direction={sort.direction}
          onClick={() => onSort("avgDurationMs")}
          align="center"
        />
      ),
      avgDurationMsChange: (
        <TableHead
          key="avgDurationMsChange"
          className="whitespace-nowrap text-center"
        >
          {formatI18nTemplate(messages.pages.changePercentColumnLabel, {
            metric: messages.common.avgDuration,
          })}
        </TableHead>
      ),
      trend: (
        <TableHead key="trend" className="w-40 max-w-40 text-center">
          {messages.pages.trendTitle}
        </TableHead>
      ),
    };
    return (
      <TableRow>
        {visibleColumnIds.map((columnId) => headerById[columnId])}
      </TableRow>
    );
  }, [messages, onSort, sort.direction, sort.key, visibleColumnIds]);

  const renderRow = useCallback(
    (row: PagesDashboardRow) => {
      const open = () => onOpenPage(row.pathname);
      const renderColumn = (columnId: PagesTableColumnId) => {
        if (columnId === "page") {
          const title = row.titles[0]?.trim() || messages.pages.untitled;
          const path = decodeUrlDisplayValue(row.pathname || "/");
          return (
            <TableCell key="page" className="pl-2">
              <AnalyticsDetailsTooltipTarget
                className="block min-w-0"
                locale={locale}
                request={{
                  key: `page:${row.pathname}:${title}`,
                  items: [
                    {
                      label: messages.common.title,
                      value: title,
                      copyValue: title,
                    },
                    {
                      label: messages.common.path,
                      value: path,
                      copyValue: row.pathname || "/",
                    },
                  ],
                }}
              >
                <PageLabel messages={messages} row={row} />
              </AnalyticsDetailsTooltipTarget>
            </TableCell>
          );
        }
        if (columnId === "trend") {
          return (
            <TableCell key="trend" className="w-40 max-w-40 px-3">
              <div className="mx-auto w-full max-w-40 overflow-hidden">
                <TrafficPairBarChart
                  data={row.trend}
                  locale={locale}
                  timeZone={currentWindow.timeZone}
                  interval={currentWindow.interval}
                  range={currentWindow}
                  viewsLabel={messages.common.views}
                  visitorsLabel={messages.common.visitors}
                  compact
                  maxPoints={36}
                  className="h-4"
                  {...(comparisonActive
                    ? {
                        comparisonData: row.referenceTrend ?? [],
                        comparisonRange: comparisonWindow,
                        currentPeriodLabel:
                          messages.dashboardHeader.compareCurrentPeriod,
                        comparisonLabel,
                      }
                    : {})}
                />
              </div>
            </TableCell>
          );
        }

        if (columnId in CHANGE_COLUMN_METRICS) {
          const metric = CHANGE_COLUMN_METRICS[columnId as PagesChangeColumnId];
          const change = row.change?.[metric];
          const points = metric === "bounceRate";
          const value = points
            ? change
              ? change.absolute * 100
              : null
            : (change?.relative ?? null);
          return (
            <TableCell
              key={columnId}
              className="whitespace-nowrap text-center font-mono tabular-nums"
            >
              <ChangeValue
                locale={locale}
                value={value}
                lowerIsBetter={metric === "bounceRate"}
                suffix={
                  points ? ` ${messages.pages.percentagePointSuffix}` : "%"
                }
              />
            </TableCell>
          );
        }

        const metric = columnId as PagesDashboardMetric;
        const value = metricValue(locale, row, metric);
        const centeredMetric =
          metric === "bounceRate" ||
          metric === "pagesPerSession" ||
          metric === "avgDurationMs";
        return (
          <TableCell
            key={columnId}
            className={cn(
              "font-mono tabular-nums",
              centeredMetric ? "text-center" : "text-right",
            )}
          >
            {value}
          </TableCell>
        );
      };

      return {
        children: visibleColumnIds.map(renderColumn),
        props: {
          "aria-label": `${messages.pages.viewDetails}: ${row.pathname}`,
          className:
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          onClick: open,
          onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            open();
          },
          tabIndex: 0,
        },
      };
    },
    [
      comparisonActive,
      comparisonLabel,
      comparisonWindow,
      currentWindow,
      locale,
      messages,
      onOpenPage,
      visibleColumnIds,
    ],
  );

  const toolbar = (
    <div className="flex w-full min-w-0 items-center justify-end gap-2">
      <div className="relative min-w-0 flex-1 sm:w-80 sm:flex-none">
        <RiSearchLine className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchValue}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          className="pl-8"
        />
      </div>
      <AnalyticsTableColumnSettings
        columns={columnDefinitions}
        orderedIds={orderedColumnIds}
        visibleIds={visibleColumnIds}
        onOrderChange={onColumnOrderChange}
        onVisibilityChange={onColumnVisibilityChange}
        onReset={onColumnReset}
        labels={columnSettingsLabels}
      />
    </div>
  );

  return (
    <div className="space-y-3">
      {toolbar}
      <AnalyticsDataTable
        header={headers}
        rows={rows}
        renderRow={renderRow}
        renderSkeletonRow={() => (
          <PageSkeletonRow columnIds={visibleColumnIds} />
        )}
        getRowKey={(row) => row.pathname}
        skeletonRows={skeletonRows}
        columnCount={visibleColumnIds.length}
        loading={loading}
        loadingMore={loadingMore}
        error={error}
        errorContent={errorContent}
        emptyContent={emptyContent}
        appendError={appendError}
        appendErrorContent={appendErrorContent}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        minTableWidth="82rem"
        enableTimeTooltips
        messages={messages}
      />
    </div>
  );
}
