import { type ReactNode } from "react";

import { type TabbedScrollMaskCardTab } from "@/components/dashboard/common/tabbed-scroll-mask-card";
import type { PaginationMeta } from "@/lib/pagination";

type NonEmptyArray<T> = readonly [T, ...T[]];

export type TabbedDataTableSortDirection = "asc" | "desc";

export interface TabbedDataTableSortState<TKey extends string = string> {
  key: TKey;
  direction: TabbedDataTableSortDirection;
}

export interface TabbedDataTableRowBase {
  key?: string;
}

export interface TabbedDataTableLoaderOptions<
  TTab extends string,
  TKey extends string,
> {
  tab: TTab;
  cursor: string | null;
  limit: number;
  search: string;
  sort: TabbedDataTableSortState<TKey>;
  signal: AbortSignal;
}

export interface TabbedDataTablePage<TRow extends TabbedDataTableRowBase> {
  items: readonly TRow[];
  pagination: PaginationMeta;
}

export type TabbedDataTableLoader<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string,
> = (
  options: TabbedDataTableLoaderOptions<TTab, TKey>,
) => Promise<TabbedDataTablePage<TRow>>;

export interface TabbedDataTableTab<
  TTab extends string = string,
> extends TabbedScrollMaskCardTab<TTab> {
  columnLabel?: string;
  defaultSort?: TabbedDataTableSortState<string>;
}

export interface TabbedDataTableColumn<
  TRow extends TabbedDataTableRowBase,
  TKey extends string = string,
  TTab extends string = string,
> {
  key: TKey;
  label: string;
  getValue: (row: TRow, tab: TTab) => number;
  format?: (value: number, row: TRow, tab: TTab) => ReactNode;
  sortable?: boolean;
  sortValue?: (row: TRow, tab: TTab) => number;
  exportable?: boolean;
  exportLabel?: string;
  exportValue?: (row: TRow, tab: TTab) => string | number | null | undefined;
  className?: string;
  headerClassName?: string;
  widthClassName?: string;
}

export interface TabbedDataTableRowContext<
  TRow extends TabbedDataTableRowBase,
  TTab extends string,
  TKey extends string,
> {
  row: TRow;
  tab: TTab;
  sort: TabbedDataTableSortState<TKey>;
  source: "card" | "search";
}

export interface TabbedDataTableSearchConfig<
  TRow extends TabbedDataTableRowBase,
  TTab extends string,
> {
  enabled?: boolean;
  getText?: (row: TRow, tab: TTab) => string;
  placeholder?: (tab: TabbedDataTableTab<TTab>) => string;
  title?: (tab: TabbedDataTableTab<TTab>) => string;
  actionLabel?: string;
}

export interface TabbedDataTableRowAdapter<
  TRow extends TabbedDataTableRowBase,
  TTab extends string,
  TKey extends string,
> {
  renderLabel?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => ReactNode;
  getSearchText?: (row: TRow, tab: TTab) => string;
  getExportLabel?: (row: TRow, tab: TTab) => string;
  getKey?: (row: TRow, tab: TTab) => string;
  getActive?: (row: TRow, tab: TTab) => boolean;
  getInteractive?: (row: TRow, tab: TTab) => boolean;
  getClassName?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => string | undefined;
  onClick?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => void;
}

export type TabbedDataTableExportScope = "currentTab" | "allTabs";

export type TabbedDataTableExportRows = "currentView" | "rawRows";

export interface TabbedDataTableExportLabels {
  action?: string;
  title?: string;
  description?: string;
  scopeLabel?: string;
  currentTab?: string;
  allTabs?: string;
  rowsLabel?: string;
  currentView?: string;
  rawRows?: string;
  fileNameLabel?: string;
  download?: string;
  empty?: string;
  budgetExceeded?: string;
}

export interface TabbedDataTableExportConfig<
  TRow extends TabbedDataTableRowBase,
  TTab extends string,
  TKey extends string,
> {
  enabled?: boolean;
  filename?: string | ((tab: TabbedDataTableTab<TTab>) => string);
  defaultScope?: TabbedDataTableExportScope;
  defaultRows?: TabbedDataTableExportRows;
  labels?: TabbedDataTableExportLabels;
  getRowLabel?: (row: TRow, tab: TTab) => string;
  getCellValue?: (
    value: number,
    row: TRow,
    column: TabbedDataTableColumn<TRow, TKey, TTab>,
    tab: TTab,
  ) => string | number | null | undefined;
}

export interface TabbedDataTableCardProps<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string = string,
> {
  tabs: NonEmptyArray<TabbedDataTableTab<TTab>>;
  columns:
    | readonly TabbedDataTableColumn<TRow, TKey, TTab>[]
    | ((tab: TTab) => readonly TabbedDataTableColumn<TRow, TKey, TTab>[]);
  rowAdapter?: TabbedDataTableRowAdapter<TRow, TTab, TKey>;
  renderLabel?: (
    row: TRow,
    context: TabbedDataTableRowContext<TRow, TTab, TKey>,
  ) => ReactNode;
  loader: TabbedDataTableLoader<TTab, TRow, TKey>;
  limit?: number;
  normalizeRows?: (rows: readonly TRow[], tab: TTab) => TRow[];
  filterRows?: (rows: readonly TRow[], tab: TTab) => TRow[];
  value?: TTab;
  defaultValue?: TTab;
  onValueChange?: (value: TTab) => void;
  requestKey?: string | number;
  /** Keeps the card-level content transition stable while the data refreshes. */
  contentTransitionKey?: string | number;
  defaultSort?: TabbedDataTableSortState<TKey>;
  sortByTab?: Partial<Record<TTab, TabbedDataTableSortState<TKey>>>;
  onSortChange?: (tab: TTab, sort: TabbedDataTableSortState<TKey>) => void;
  sortActionLabel?: (columnLabel: string) => string;
  labelColumnLabel?: string | ((tab: TabbedDataTableTab<TTab>) => string);
  loadingLabel: string;
  emptyLabel: string;
  search?: false | TabbedDataTableSearchConfig<TRow, TTab>;
  export?: false | TabbedDataTableExportConfig<TRow, TTab, TKey>;
  headerRight?: ReactNode;
  headerHidden?: boolean;
  className?: string;
  tabsListClassName?: string;
  tabTriggerClassName?: string;
  viewportClassName?: string;
  rowKeyPrefix?: string;
  progress?: false | "sort" | TKey;
  getRowKey?: (row: TRow, tab: TTab) => string;
  getRowSearchText?: (row: TRow, tab: TTab) => string;
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
