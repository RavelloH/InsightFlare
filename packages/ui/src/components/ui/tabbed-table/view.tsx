import { type ReactNode, useState } from "react";
import { RiArrowDownSLine, RiArrowUpSLine } from "@remixicon/react";
import { AnimatePresence, useReducedMotion } from "motion/react";

import { cn } from "../../../lib/utils";
import { Spinner } from "../spinner";
import type {
  TabbedDataTableColumn,
  TabbedDataTableRowAdapter,
  TabbedDataTableRowBase,
  TabbedDataTableRowContext,
  TabbedDataTableSortState,
  TabbedDataTableTab,
} from "../tabbed-table.types";
import {
  createTabRecord,
  firstSortableColumnKey,
  getColumnsForTab,
} from "../tabbed-table.utils";
import { TableCell, TableHead, TableRow } from "../table";
import { AnimatedDataTableRow } from "./animated-data-table-row";
import { DataTableSwitch } from "./data-table-switch";
import { TabbedScrollMaskCard } from "./tabbed-scroll-mask-card";

type NonEmptyTabs<TTab extends string> = readonly [
  TabbedDataTableTab<TTab>,
  ...TabbedDataTableTab<TTab>[],
];

export type TabbedDataTableViewState =
  "ready" | "loading" | "loading-more" | "empty" | "error";

type ViewRowAdapter<
  TRow extends TabbedDataTableRowBase,
  TTab extends string,
  TKey extends string,
> = Pick<
  TabbedDataTableRowAdapter<TRow, TTab, TKey>,
  | "renderLabel"
  | "getKey"
  | "getActive"
  | "getInteractive"
  | "getClassName"
  | "onClick"
>;

export interface TabbedDataTableViewProps<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string = string,
> {
  tabs: NonEmptyTabs<TTab>;
  columns:
    | readonly TabbedDataTableColumn<TRow, TKey, TTab>[]
    | ((tab: TTab) => readonly TabbedDataTableColumn<TRow, TKey, TTab>[]);
  rows: readonly TRow[];
  rowsByTab?: Partial<Record<TTab, readonly TRow[]>>;
  state: TabbedDataTableViewState;
  value?: TTab;
  defaultValue?: TTab;
  onValueChange?: (value: TTab) => void;
  sortByTab?: Partial<Record<TTab, TabbedDataTableSortState<TKey>>>;
  defaultSort?: TabbedDataTableSortState<TKey>;
  onSortChange?: (tab: TTab, sort: TabbedDataTableSortState<TKey>) => void;
  sortActionLabel?: (columnLabel: string) => string;
  labelColumnLabel?: string | ((tab: TabbedDataTableTab<TTab>) => string);
  loadingLabel: string;
  emptyLabel: string;
  errorLabel?: string;
  loadingMoreLabel?: string;
  loadingRows?: ReactNode;
  footer?: ReactNode;
  headerRight?: ReactNode;
  headerHidden?: boolean;
  className?: string;
  tabsListClassName?: string;
  tabTriggerClassName?: string;
  viewportClassName?: string;
  syncKey?: string | number | boolean | null;
  contentKey?: string | number;
  rowKeyPrefix?: string;
  rowAdapter?: ViewRowAdapter<TRow, TTab, TKey>;
  renderLabel?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => ReactNode;
  progress?: false | "sort" | TKey;
  getRowKey?: (row: TRow, tab: TTab) => string;
  getRowActive?: (row: TRow, tab: TTab) => boolean;
  getRowInteractive?: (row: TRow, tab: TTab) => boolean;
  getRowClassName?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => string | undefined;
  onRowClick?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => void;
  formatNumber?: (value: number, row: TRow, tab: TTab) => ReactNode;
  animate?: boolean;
}

interface TabbedDataTableHeaderProps<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string,
> {
  tabs: NonEmptyTabs<TTab>;
  tab: TTab;
  columns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[];
  sort: TabbedDataTableSortState<TKey>;
  labelColumnLabel?: string | ((tab: TabbedDataTableTab<TTab>) => string);
  sortActionLabel?: (columnLabel: string) => string;
  onSortChange: (tab: TTab, sort: TabbedDataTableSortState<TKey>) => void;
}

export function TabbedDataTableHeader<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string,
>({
  tabs,
  tab,
  columns,
  sort,
  labelColumnLabel,
  sortActionLabel,
  onSortChange,
}: TabbedDataTableHeaderProps<TTab, TRow, TKey>) {
  const tabMeta = tabs.find((candidate) => candidate.value === tab) ?? tabs[0];
  const firstColumnLabel =
    typeof labelColumnLabel === "function"
      ? labelColumnLabel(tabMeta)
      : (labelColumnLabel ?? tabMeta.columnLabel ?? tabMeta.label);

  return (
    <TableRow className="hover:bg-transparent">
      <TableHead className="h-8 p-0">
        <div className="px-4">{firstColumnLabel}</div>
      </TableHead>
      {columns.map((column) => {
        const sortable = column.sortable !== false;
        const active = sort.key === column.key;

        return (
          <TableHead
            key={column.key}
            aria-sort={
              sortable && active
                ? sort.direction === "asc"
                  ? "ascending"
                  : "descending"
                : "none"
            }
            className={cn("h-8 w-20 p-0", column.widthClassName)}
          >
            <div className="flex justify-end px-2">
              <button
                type="button"
                aria-label={
                  sortable ? sortActionLabel?.(column.label) : undefined
                }
                className={cn(
                  "inline-flex items-center gap-1 whitespace-nowrap transition-colors",
                  active ? "text-foreground" : "text-muted-foreground",
                  !sortable && "cursor-default",
                  column.headerClassName,
                )}
                onClick={() => {
                  if (!sortable) return;
                  onSortChange(tab, {
                    key: column.key,
                    direction:
                      active && sort.direction === "desc" ? "asc" : "desc",
                  });
                }}
              >
                {column.label}
                {sortable ? (
                  active ? (
                    sort.direction === "desc" ? (
                      <RiArrowDownSLine className="size-3.5" />
                    ) : (
                      <RiArrowUpSLine className="size-3.5" />
                    )
                  ) : (
                    <span className="inline-flex flex-col leading-none text-muted-foreground">
                      <RiArrowUpSLine className="-mb-1 size-3.5" />
                      <RiArrowDownSLine className="-mt-1 size-3.5" />
                    </span>
                  )
                ) : null}
              </button>
            </div>
          </TableHead>
        );
      })}
    </TableRow>
  );
}

interface TabbedDataTableRowsProps<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string,
> {
  tab: TTab;
  rows: readonly TRow[];
  columns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[];
  sort: TabbedDataTableSortState<TKey>;
  source: "card" | "search";
  rowAdapter?: ViewRowAdapter<TRow, TTab, TKey>;
  renderLabel?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => ReactNode;
  progress?: false | "sort" | TKey;
  rowKeyPrefix?: string;
  getRowKey?: (row: TRow, tab: TTab) => string;
  getRowActive?: (row: TRow, tab: TTab) => boolean;
  getRowInteractive?: (row: TRow, tab: TTab) => boolean;
  getRowClassName?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => string | undefined;
  onRowClick?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => void;
  formatNumber?: (value: number, row: TRow, tab: TTab) => ReactNode;
}

export function TabbedDataTableRows<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string,
>({
  tab,
  rows,
  columns,
  sort,
  source,
  rowAdapter,
  renderLabel,
  progress = "sort",
  rowKeyPrefix,
  getRowKey,
  getRowActive,
  getRowInteractive,
  getRowClassName,
  onRowClick,
  formatNumber,
}: TabbedDataTableRowsProps<TTab, TRow, TKey>) {
  const reduceMotion = useReducedMotion() ?? false;
  const progressColumn =
    progress === false
      ? null
      : (columns.find((column) =>
          progress === "sort"
            ? column.key === sort.key
            : column.key === progress,
        ) ?? columns[0]);
  const progressTotal = progressColumn
    ? rows.reduce(
        (sum, row) =>
          sum +
          Math.max(
            0,
            Number(
              progressColumn.sortValue?.(row, tab) ??
                progressColumn.getValue(row, tab),
            ),
          ),
        0,
      )
    : 0;

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {rows.map((row, index) => {
        const key =
          rowAdapter?.getKey?.(row, tab) ??
          getRowKey?.(row, tab) ??
          row.key ??
          String(index);
        const rowValue = progressColumn
          ? Math.max(
              0,
              Number(
                progressColumn.sortValue?.(row, tab) ??
                  progressColumn.getValue(row, tab),
              ),
            )
          : 0;
        const progressPercent =
          progressColumn && progressTotal > 0
            ? Math.min(100, (rowValue / progressTotal) * 100)
            : 0;
        const context = { row, tab, sort, source };
        const active =
          rowAdapter?.getActive?.(row, tab) ??
          getRowActive?.(row, tab) ??
          false;
        const interactive =
          rowAdapter?.getInteractive?.(row, tab) ??
          getRowInteractive?.(row, tab) ??
          Boolean(rowAdapter?.onClick ?? onRowClick);

        return (
          <AnimatedDataTableRow
            key={`${rowKeyPrefix ?? source}-${tab}-${key}`}
            reduceMotion={reduceMotion}
            className={cn(
              "group/row bg-no-repeat transition-[background-size,filter] duration-300 ease-out hover:bg-transparent",
              interactive
                ? "cursor-pointer hover:brightness-95"
                : "cursor-default",
              active && "brightness-95",
              rowAdapter?.getClassName?.(row, context),
              getRowClassName?.(row, context),
            )}
            style={
              progressColumn
                ? {
                    backgroundImage:
                      "linear-gradient(90deg, var(--muted) 0%, var(--muted) 100%)",
                    backgroundSize: `${progressPercent.toFixed(2)}% 100%`,
                    backgroundPosition: "left top",
                  }
                : undefined
            }
            onClick={() => (rowAdapter?.onClick ?? onRowClick)?.(row, context)}
          >
            <TableCell className="whitespace-normal p-0 align-top">
              <div className="px-4 py-2 leading-5 whitespace-normal break-words">
                {(
                  rowAdapter?.renderLabel ??
                  renderLabel ??
                  ((fallbackRow: TRow) => fallbackRow.key ?? "")
                )(row, context)}
              </div>
            </TableCell>
            {columns.map((column, columnIndex) => {
              const value = column.getValue(row, tab);
              return (
                <TableCell key={column.key} className="p-0">
                  <div
                    className={cn(
                      columnIndex === columns.length - 1
                        ? "px-4 py-2 text-right"
                        : "px-2 py-2 text-right",
                      column.className,
                    )}
                  >
                    {column.format?.(value, row, tab) ??
                      formatNumber?.(value, row, tab) ??
                      value}
                  </div>
                </TableCell>
              );
            })}
          </AnimatedDataTableRow>
        );
      })}
    </AnimatePresence>
  );
}

export function TabbedDataTableView<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string = string,
>({
  tabs,
  columns,
  rows,
  rowsByTab,
  state,
  value,
  defaultValue,
  onValueChange,
  sortByTab: controlledSortByTab,
  defaultSort,
  onSortChange,
  sortActionLabel,
  labelColumnLabel,
  loadingLabel,
  emptyLabel,
  errorLabel,
  loadingMoreLabel,
  loadingRows,
  footer,
  headerRight,
  headerHidden,
  className,
  tabsListClassName,
  tabTriggerClassName,
  viewportClassName,
  syncKey,
  contentKey,
  rowKeyPrefix,
  rowAdapter,
  renderLabel,
  progress = "sort",
  getRowKey,
  getRowActive,
  getRowInteractive,
  getRowClassName,
  onRowClick,
  formatNumber,
  animate = true,
}: TabbedDataTableViewProps<TTab, TRow, TKey>) {
  const controlled = value !== undefined;
  const [internalTab, setInternalTab] = useState<TTab>(
    defaultValue ?? tabs[0].value,
  );
  const selectedTab = value ?? internalTab;
  const activeTab = tabs.some((tab) => tab.value === selectedTab)
    ? selectedTab
    : tabs[0].value;
  const activeColumns = getColumnsForTab(columns, activeTab);
  const activeRows = rowsByTab?.[activeTab] ?? rows;
  const [internalSortByTab, setInternalSortByTab] = useState<
    Record<TTab, TabbedDataTableSortState<TKey>>
  >(() =>
    createTabRecord(tabs, (tab) => {
      const tabColumns = getColumnsForTab(columns, tab.value);
      return {
        key:
          (tab.defaultSort?.key as TKey | undefined) ??
          defaultSort?.key ??
          firstSortableColumnKey(tabColumns),
        direction:
          tab.defaultSort?.direction ?? defaultSort?.direction ?? "desc",
      };
    }),
  );
  const effectiveSortByTab = createTabRecord(tabs, (tab) => {
    const configured =
      controlledSortByTab?.[tab.value] ?? internalSortByTab[tab.value];
    const tabColumns = getColumnsForTab(columns, tab.value);
    if (
      configured &&
      tabColumns.some(
        (column) => column.key === configured.key && column.sortable !== false,
      )
    ) {
      return configured;
    }

    return {
      key:
        (tab.defaultSort?.key as TKey | undefined) ??
        defaultSort?.key ??
        firstSortableColumnKey(tabColumns),
      direction: tab.defaultSort?.direction ?? defaultSort?.direction ?? "desc",
    };
  });
  const activeSort = effectiveSortByTab[activeTab];
  const handleTabChange = (next: TTab) => {
    if (!controlled) setInternalTab(next);
    onValueChange?.(next);
  };
  const handleSortChange = (
    tab: TTab,
    next: TabbedDataTableSortState<TKey>,
  ) => {
    if (onSortChange) {
      onSortChange(tab, next);
      return;
    }
    setInternalSortByTab((previous) => ({ ...previous, [tab]: next }));
  };
  const contentRows =
    state === "error" ? (
      <TableRow>
        <TableCell
          colSpan={1 + activeColumns.length}
          className="h-24 text-center text-destructive"
          role="alert"
        >
          {errorLabel ?? emptyLabel}
        </TableCell>
      </TableRow>
    ) : (
      <TabbedDataTableRows
        tab={activeTab}
        rows={activeRows}
        columns={activeColumns}
        sort={activeSort}
        source="card"
        rowAdapter={rowAdapter}
        renderLabel={renderLabel}
        progress={progress}
        rowKeyPrefix={rowKeyPrefix}
        getRowKey={getRowKey}
        getRowActive={getRowActive}
        getRowInteractive={getRowInteractive}
        getRowClassName={getRowClassName}
        onRowClick={onRowClick}
        formatNumber={formatNumber}
      />
    );
  const loadMoreFooter =
    state === "loading-more" && !footer ? (
      <TableRow>
        <TableCell
          colSpan={1 + activeColumns.length}
          className="h-12 text-center text-muted-foreground"
        >
          <span className="inline-flex items-center gap-2">
            <Spinner className="size-4" />
            {loadingMoreLabel ?? loadingLabel}
          </span>
        </TableCell>
      </TableRow>
    ) : null;

  return (
    <TabbedScrollMaskCard
      value={activeTab}
      onValueChange={handleTabChange}
      tabs={tabs}
      headerRight={headerRight}
      headerHidden={headerHidden}
      className={className}
      tabsListClassName={tabsListClassName}
      tabTriggerClassName={tabTriggerClassName}
      viewportClassName={viewportClassName}
      syncKey={syncKey ?? `${activeTab}:${activeRows.length}`}
    >
      <DataTableSwitch
        loading={state === "loading"}
        hasContent={
          state === "ready" || state === "loading-more" || state === "error"
        }
        loadingLabel={loadingLabel}
        emptyLabel={emptyLabel}
        colSpan={1 + activeColumns.length}
        header={
          <TabbedDataTableHeader
            tabs={tabs}
            tab={activeTab}
            columns={activeColumns}
            sort={activeSort}
            labelColumnLabel={labelColumnLabel}
            sortActionLabel={sortActionLabel}
            onSortChange={handleSortChange}
          />
        }
        rows={contentRows}
        loadingRows={loadingRows}
        footer={
          state === "ready" || state === "loading-more"
            ? (footer ?? loadMoreFooter)
            : null
        }
        contentKey={contentKey ?? `${activeTab}:${activeRows.length}`}
        animate={animate}
      />
    </TabbedScrollMaskCard>
  );
}
