import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type Key,
  memo,
  type ReactNode,
} from "react";

import { AnalyticsTableCard } from "@/components/dashboard/analytics-table-card";
import { AnalyticsTimeTooltipProvider } from "@/components/dashboard/analytics-time-tooltip";
import { useInfiniteTableSentinel } from "@/components/dashboard/use-infinite-table-sentinel";
import { AutoTransition } from "@/components/ui/auto-transition";
import { Table, TableCell, TableHeader } from "@/components/ui/table";
import type { AppMessages } from "@/lib/i18n/messages";
import { cn } from "@/lib/utils";

type AnalyticsDataTableRowProps = Pick<
  ComponentPropsWithoutRef<"tr">,
  "aria-hidden" | "className" | "onClick" | "onKeyDown" | "role" | "tabIndex"
> & {
  [key: `data-${string}`]: string | undefined;
};

export interface AnalyticsDataTableRow {
  children: ReactNode;
  props?: AnalyticsDataTableRowProps;
}

interface AnalyticsDataTableProps<TRow> {
  header: ReactNode;
  rows: readonly TRow[];
  renderRow: (row: TRow, index: number) => AnalyticsDataTableRow;
  renderSkeletonRow: (index: number) => ReactNode;
  getRowKey: (row: TRow, index: number) => Key;
  skeletonRows: number;
  columnCount: number;
  loading?: boolean;
  loadingMore?: boolean;
  error?: boolean;
  errorContent: ReactNode;
  emptyContent: ReactNode;
  appendError?: boolean;
  appendErrorContent?: ReactNode;
  hasMore?: boolean;
  onLoadMore?: () => void;
  minTableWidth?: string;
  tableClassName?: string;
  tableBodyClassName?: string;
  className?: string;
  enableTimeTooltips?: boolean;
  messages?: AppMessages;
}

interface AnalyticsDataTableBodyProps<TRow> {
  rows: readonly TRow[];
  renderRow: (row: TRow, index: number) => AnalyticsDataTableRow;
  renderSkeletonRow: (index: number) => ReactNode;
  getRowKey: (row: TRow, index: number) => Key;
  skeletonRows: number;
  columnCount: number;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
  errorContent: ReactNode;
  emptyContent: ReactNode;
  appendError: boolean;
  appendErrorContent?: ReactNode;
  hasMore: boolean;
  sentinelRef: (node: HTMLElement | null) => void;
  tableBodyClassName?: string;
}

const NOOP = () => undefined;
const TABLE_ROW_CLASS_NAME =
  "group border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted";
const DATA_ROW_STAGGER_MS = 8;

function renderStateRow(key: string, content: ReactNode, columnCount: number) {
  return (
    <AutoTransition
      as="tr"
      key={key}
      transitionKey={key}
      duration={0.18}
      type="fade"
      data-slot="table-row"
      className={TABLE_ROW_CLASS_NAME}
    >
      <TableCell
        colSpan={columnCount}
        className="h-28 text-center text-muted-foreground"
      >
        {content}
      </TableCell>
    </AutoTransition>
  );
}

function renderAppendErrorRow(
  content: ReactNode,
  columnCount: number,
): ReactNode {
  return (
    <AutoTransition
      as="tr"
      key="append-error"
      transitionKey="append-error"
      duration={0.18}
      type="fade"
      data-slot="table-row"
      className={TABLE_ROW_CLASS_NAME}
    >
      <TableCell
        colSpan={columnCount}
        className="h-16 text-center text-muted-foreground"
      >
        {content}
      </TableCell>
    </AutoTransition>
  );
}

const AnalyticsDataTableBody = memo(function AnalyticsDataTableBody<TRow>({
  rows,
  renderRow,
  renderSkeletonRow,
  getRowKey,
  skeletonRows,
  columnCount,
  loading,
  loadingMore,
  error,
  errorContent,
  emptyContent,
  appendError,
  appendErrorContent,
  hasMore,
  sentinelRef,
  tableBodyClassName,
}: AnalyticsDataTableBodyProps<TRow>) {
  const isEmpty = !loading && !error && rows.length === 0 && !hasMore;
  const tableBodyTransitionKey = loading
    ? "loading"
    : error
      ? "error"
      : isEmpty
        ? "empty"
        : "content";

  return (
    <AutoTransition
      as="tbody"
      initial={false}
      transitionKey={tableBodyTransitionKey}
      duration={0.18}
      type="fade"
      presenceMode="wait"
      aria-busy={loading || loadingMore}
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", tableBodyClassName)}
    >
      {loading
        ? Array.from({ length: skeletonRows }, (_, index) => (
            <AutoTransition
              as="tr"
              key={`skeleton-${index}`}
              transitionKey={`skeleton-${index}`}
              duration={0.18}
              type="fade"
              aria-hidden="true"
              data-slot="table-row"
              className={TABLE_ROW_CLASS_NAME}
            >
              {renderSkeletonRow(index)}
            </AutoTransition>
          ))
        : error
          ? renderStateRow("error", errorContent, columnCount)
          : isEmpty
            ? renderStateRow("empty", emptyContent, columnCount)
            : [
                ...rows.map((row, index) => {
                  const rendered = renderRow(row, index);
                  const rowKey = String(getRowKey(row, index));
                  const { className: rowClassName, ...rowProps } =
                    rendered.props ?? {};
                  return (
                    <AutoTransition
                      as="tr"
                      key={`row-${rowKey}`}
                      transitionKey={`row-${rowKey}`}
                      initial
                      duration={0.18}
                      type="fade"
                      style={
                        {
                          "--analytics-data-row-delay": `${
                            (index % Math.max(skeletonRows, 1)) *
                            DATA_ROW_STAGGER_MS
                          }ms`,
                        } as CSSProperties
                      }
                      {...rowProps}
                      data-slot="table-row"
                      data-analytics-row-enter=""
                      className={cn(TABLE_ROW_CLASS_NAME, rowClassName)}
                    >
                      {rendered.children}
                    </AutoTransition>
                  );
                }),
                ...(appendError
                  ? [
                      appendErrorContent !== undefined
                        ? renderAppendErrorRow(appendErrorContent, columnCount)
                        : renderStateRow(
                            "append-error",
                            errorContent,
                            columnCount,
                          ),
                    ]
                  : hasMore
                    ? Array.from({ length: skeletonRows }, (_, index) => (
                        <AutoTransition
                          as="tr"
                          key={`skeleton-more-${index}`}
                          transitionKey={`skeleton-more-${index}`}
                          duration={0.18}
                          type="fade"
                          ref={sentinelRef}
                          aria-hidden="true"
                          data-slot="table-row"
                          className={TABLE_ROW_CLASS_NAME}
                        >
                          {renderSkeletonRow(index)}
                        </AutoTransition>
                      ))
                    : []),
              ]}
    </AutoTransition>
  );
}) as <TRow>(props: AnalyticsDataTableBodyProps<TRow>) => ReactNode;

export function AnalyticsDataTable<TRow>({
  header,
  rows,
  renderRow,
  renderSkeletonRow,
  getRowKey,
  skeletonRows,
  columnCount,
  loading = false,
  loadingMore = false,
  error = false,
  errorContent,
  emptyContent,
  appendError = false,
  appendErrorContent,
  hasMore = false,
  onLoadMore,
  minTableWidth,
  tableClassName,
  tableBodyClassName,
  className,
  enableTimeTooltips = false,
  messages,
}: AnalyticsDataTableProps<TRow>) {
  const loadMore = onLoadMore ?? NOOP;
  const sentinelRef = useInfiniteTableSentinel({
    enabled:
      Boolean(onLoadMore) &&
      !loading &&
      !loadingMore &&
      !appendError &&
      !error &&
      hasMore,
    onReachEnd: loadMore,
  });

  const table = (
    <AnalyticsTableCard minTableWidth={minTableWidth} className={className}>
      <Table className={tableClassName}>
        <TableHeader>{header}</TableHeader>
        <AnalyticsDataTableBody
          rows={rows}
          renderRow={renderRow}
          renderSkeletonRow={renderSkeletonRow}
          getRowKey={getRowKey}
          skeletonRows={skeletonRows}
          columnCount={columnCount}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          errorContent={errorContent}
          emptyContent={emptyContent}
          appendError={appendError}
          appendErrorContent={appendErrorContent}
          hasMore={hasMore}
          sentinelRef={sentinelRef}
          tableBodyClassName={tableBodyClassName}
        />
      </Table>
    </AnalyticsTableCard>
  );

  return enableTimeTooltips && messages ? (
    <AnalyticsTimeTooltipProvider messages={messages}>
      {table}
    </AnalyticsTimeTooltipProvider>
  ) : (
    table
  );
}
