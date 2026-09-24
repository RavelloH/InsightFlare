import { memo, useCallback, useMemo, useState } from "react";
import { RiRouteLine } from "@remixicon/react";

import {
  TabbedDataTableCard,
  type TabbedDataTableColumn,
  type TabbedDataTableLoader,
  type TabbedDataTableRowAdapter,
  type TabbedDataTableSortState,
} from "@/components/dashboard/common/tabbed-data-table-card";
import {
  formatPanelValue,
  panelLabel,
  PATH_TABLE_SKELETON_ROWS,
  type PathPerformanceRow,
  type PathSortKey,
  type PerformancePanelKey,
  type PerformanceStatus,
  type SortDirection,
  STATUS_STYLE,
  statusLabel,
} from "@/components/dashboard/site-pages/performance/model";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { numberFormat } from "@/lib/dashboard/format";
import { loadLocalTablePage } from "@/lib/dashboard/table-loader";
import { decodeUrlDisplayValue } from "@/lib/dashboard/url-display";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { formatI18nTemplate } from "@/lib/i18n/template";
import { cn } from "@/lib/utils";

import { pathStatusRangeLabel } from "./health-map";
import { PerformanceDynamicValue, PerformancePanelText } from "./shared";
const PathStatusColumn = memo(function PathStatusColumn({
  locale,
  messages,
  activePanel,
  status,
  rows,
  sort,
  onSort,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  status: Exclude<PerformanceStatus, "none">;
  rows: PathPerformanceRow[];
  sort: { key: PathSortKey; direction: SortDirection };
  onSort: (key: PathSortKey) => void;
  comparisonLabel?: string;
  loading?: boolean;
}) {
  const statusStyle = STATUS_STYLE[status];
  const StatusIcon = statusStyle.icon;
  const displayRows = loading ? PATH_TABLE_SKELETON_ROWS : rows;
  const rangeLabel = pathStatusRangeLabel(
    locale,
    messages,
    activePanel,
    status,
  );
  const columns = useMemo<
    readonly TabbedDataTableColumn<
      PathPerformanceRow,
      PathSortKey,
      typeof status
    >[]
  >(() => {
    const metricLabel =
      activePanel === "score"
        ? messages.performance.score
        : messages.performance.metricValueColumn;

    if (comparisonLabel) {
      return [
        {
          key: "samples",
          label: comparisonLabel,
          getValue: (row) => row.comparisonValue ?? row.comparisonScore ?? 0,
          format: (_value, row) =>
            loading ? (
              <Skeleton className="ml-auto h-4 w-14" />
            ) : (
              <span className="text-muted-foreground">
                {formatPanelValue(
                  locale,
                  messages,
                  activePanel,
                  row.comparisonValue ?? row.comparisonScore,
                )}
              </span>
            ),
          className: "font-mono tabular-nums",
        },
        {
          key: "value",
          label: metricLabel,
          getValue: (row) => row.value ?? row.score ?? 0,
          format: (_value, row) =>
            loading ? (
              <Skeleton className="ml-auto h-4 w-14" />
            ) : (
              <span>
                {formatPanelValue(
                  locale,
                  messages,
                  activePanel,
                  row.value ?? row.score,
                )}
              </span>
            ),
          className: "font-mono tabular-nums",
        },
      ];
    }

    return [
      {
        key: "samples",
        label: messages.performance.samplesLabel,
        getValue: (row) => row.samples,
        format: (value) =>
          loading ? (
            <Skeleton className="ml-auto h-4 w-12" />
          ) : (
            <span>{numberFormat(locale, value)}</span>
          ),
        className: "font-mono tabular-nums",
      },
      {
        key: "value",
        label: metricLabel,
        getValue: (row) => row.value ?? row.score ?? 0,
        format: (_value, row) =>
          loading ? (
            <Skeleton className="ml-auto h-4 w-14" />
          ) : (
            <span>
              {formatPanelValue(
                locale,
                messages,
                activePanel,
                row.value ?? row.score,
              )}
            </span>
          ),
        className: "font-mono tabular-nums",
      },
    ];
  }, [
    activePanel,
    comparisonLabel,
    loading,
    locale,
    messages,
    messages.performance.metricValueColumn,
    messages.performance.samplesLabel,
    messages.performance.score,
  ]);
  const tabs = useMemo(
    () =>
      [
        {
          value: status,
          label: statusLabel(messages, status),
          columnLabel: messages.common.path,
          defaultSort: sort,
        },
      ] as const,
    [messages, sort, status],
  );
  const sortByTab = useMemo(
    () => ({ [status]: sort }) as Record<typeof status, typeof sort>,
    [sort, status],
  );
  const handleSortChange = useCallback(
    (_tab: typeof status, next: TabbedDataTableSortState<PathSortKey>) =>
      onSort(next.key),
    [onSort],
  );
  const loader = useCallback<
    TabbedDataTableLoader<typeof status, PathPerformanceRow, PathSortKey>
  >(
    async ({ cursor, limit, search, sort }) =>
      loadLocalTablePage({
        rows: displayRows,
        sort,
        columns,
        tab: status,
        limit,
        cursor,
        search,
        getText: (row) => row.pathname || "/",
        tieBreakText: false,
      }),
    [columns, displayRows, status],
  );
  const tableRequestKey = useMemo(
    () => `${activePanel}:${locale}:${JSON.stringify(displayRows)}`,
    [activePanel, displayRows, locale],
  );
  const rowAdapter = useMemo<
    TabbedDataTableRowAdapter<PathPerformanceRow, typeof status, PathSortKey>
  >(
    () => ({
      renderLabel: (row) =>
        loading ? (
          <Skeleton className="h-4 w-[min(14rem,82%)]" />
        ) : (
          <span className="max-w-[18rem] font-mono break-words">
            {decodeUrlDisplayValue(row.pathname || "/")}
          </span>
        ),
      getSearchText: (row) => row.pathname || "/",
      getExportLabel: (row) => row.pathname || "/",
      getClassName: () => "hover:brightness-[0.98] dark:hover:brightness-125",
    }),
    [loading],
  );

  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-3 px-4 py-4">
        <div className="min-w-0 space-y-1">
          <div
            className={cn(
              "flex items-center gap-2 font-medium",
              statusStyle.labelClassName,
            )}
          >
            <StatusIcon className="size-4" />
            {statusLabel(messages, status)}
          </div>
          <PerformancePanelText
            transitionKey={rangeLabel}
            className="text-xs text-muted-foreground"
          >
            {rangeLabel}
          </PerformancePanelText>
        </div>
        <PerformancePanelText
          transitionKey={rows.length}
          className="font-mono text-sm text-muted-foreground tabular-nums"
        >
          {numberFormat(locale, rows.length)}
        </PerformancePanelText>
      </div>
      <div className="pb-4">
        <TabbedDataTableCard<typeof status, PathPerformanceRow, PathSortKey>
          tabs={tabs}
          loader={loader}
          columns={columns}
          value={status}
          sortByTab={sortByTab}
          onSortChange={handleSortChange}
          rowAdapter={rowAdapter}
          requestKey={tableRequestKey}
          sortActionLabel={(label) =>
            formatI18nTemplate(messages.common.sortBy, { label })
          }
          loadingLabel={messages.common.loading}
          emptyLabel={messages.common.noData}
          headerHidden
          search={false}
          progress={comparisonLabel ? "value" : "samples"}
        />
      </div>
    </div>
  );
});
export const PathPerformanceTable = memo(function PathPerformanceTable({
  locale,
  messages,
  activePanel,
  rows,
  comparisonLabel,
  loading = false,
}: {
  locale: Locale;
  messages: AppMessages;
  activePanel: PerformancePanelKey;
  rows: PathPerformanceRow[];
  comparisonLabel?: string;
  loading?: boolean;
}) {
  const [sort, setSort] = useState<{
    key: PathSortKey;
    direction: SortDirection;
  }>({
    key: "samples",
    direction: "desc",
  });
  const sortedRows = useMemo(() => {
    const direction = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sort.key === "samples") {
        if (comparisonLabel) {
          return (
            ((a.comparisonValue ?? a.comparisonScore ?? -1) -
              (b.comparisonValue ?? b.comparisonScore ?? -1)) *
            direction
          );
        }
        return (a.samples - b.samples) * direction;
      }
      if (sort.key === "score") {
        return ((a.score ?? -1) - (b.score ?? -1)) * direction;
      }
      return ((a.value ?? -1) - (b.value ?? -1)) * direction;
    });
  }, [comparisonLabel, rows, sort.direction, sort.key]);
  const groupedRows = useMemo(
    () => ({
      poor: sortedRows.filter((row) => row.status === "poor"),
      "needs-improvement": sortedRows.filter(
        (row) => row.status === "needs-improvement",
      ),
      great: sortedRows.filter((row) => row.status === "great"),
    }),
    [sortedRows],
  );

  const updateSort = useCallback((key: PathSortKey) => {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : { key, direction: "desc" },
    );
  }, []);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <CardTitle className="inline-flex items-center gap-2">
              <RiRouteLine className="size-4" />
              {messages.performance.pathsTitle}
            </CardTitle>
            <PerformancePanelText
              transitionKey={activePanel}
              className="text-sm text-muted-foreground"
            >
              {panelLabel(messages, activePanel)}
            </PerformancePanelText>
          </div>
          <div className="inline-flex items-center gap-1 text-sm text-muted-foreground">
            {messages.performance.pathsAnalyzedLabel}:{" "}
            <PerformanceDynamicValue
              loading={loading}
              skeletonClassName="h-4 w-8"
              className="shrink-0"
            >
              <span className="font-mono tabular-nums">
                {numberFormat(locale, rows.length)}
              </span>
            </PerformanceDynamicValue>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid min-h-[18rem] divide-y divide-border/70 lg:grid-cols-3 lg:divide-x lg:divide-y-0">
          {(["poor", "needs-improvement", "great"] as const).map((status) => (
            <PathStatusColumn
              key={status}
              locale={locale}
              messages={messages}
              activePanel={activePanel}
              status={status}
              rows={groupedRows[status]}
              sort={sort}
              onSort={updateSort}
              comparisonLabel={comparisonLabel}
              loading={loading}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
});
