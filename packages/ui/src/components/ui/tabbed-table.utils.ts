import type {
  TabbedDataTableColumn,
  TabbedDataTableRowBase,
  TabbedDataTableTab,
} from "./tabbed-table.types";

export function createTabRecord<TTab extends string, TValue>(
  tabs: readonly TabbedDataTableTab<TTab>[],
  createValue: (tab: TabbedDataTableTab<TTab>) => TValue,
): Record<TTab, TValue> {
  return tabs.reduce(
    (acc, tab) => {
      acc[tab.value] = createValue(tab);
      return acc;
    },
    {} as Record<TTab, TValue>,
  );
}

export function getColumnsForTab<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string,
>(
  columns:
    | readonly TabbedDataTableColumn<TRow, TKey, TTab>[]
    | ((tab: TTab) => readonly TabbedDataTableColumn<TRow, TKey, TTab>[]),
  tab: TTab,
): readonly TabbedDataTableColumn<TRow, TKey, TTab>[] {
  return typeof columns === "function" ? columns(tab) : columns;
}

export function firstSortableColumnKey<
  TRow extends TabbedDataTableRowBase,
  TKey extends string,
  TTab extends string,
>(columns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[]): TKey {
  return (columns.find((column) => column.sortable !== false) ?? columns[0])
    .key;
}
