import type { ReactNode } from "react";

export interface TabbedDataTableTab<T extends string = string> {
  value: T;
  label: string;
  columnLabel?: string;
  defaultSort?: TabbedDataTableSortState<string>;
}

export type TabbedDataTableSortDirection = "asc" | "desc";

export interface TabbedDataTableSortState<TKey extends string = string> {
  key: TKey;
  direction: TabbedDataTableSortDirection;
}

export interface TabbedDataTableRowBase {
  key?: string;
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
