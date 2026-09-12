export interface LocalTableRowBase {
  key?: string;
}

export interface LocalTableSortState<TKey extends string = string> {
  key: TKey;
  direction: "asc" | "desc";
}

export interface LocalTableColumn<
  TRow,
  TKey extends string,
  TTab extends string,
> {
  key: TKey;
  getValue: (row: TRow, tab: TTab) => number;
  sortValue?: (row: TRow, tab: TTab) => number;
}

export interface LocalTablePageOptions<
  TRow extends LocalTableRowBase,
  TKey extends string,
  TTab extends string,
> {
  rows: readonly TRow[];
  sort: LocalTableSortState<TKey>;
  columns: readonly LocalTableColumn<TRow, TKey, TTab>[];
  tab: TTab;
  limit: number;
  cursor: string | null;
  search?: string;
  getText?: (row: TRow, tab: TTab) => string;
  getSearchText?: (row: TRow, tab: TTab) => string;
  tieBreakers?: readonly TKey[];
  tieBreakText?: boolean;
}

/**
 * Sort a complete in-memory collection using the same deterministic tie
 * breaking rules as the remote table readers.  Remote loaders must sort at
 * the query boundary; this helper is only for data that is already complete
 * in the browser.
 */
export function sortLocalTableRows<
  TRow extends LocalTableRowBase,
  TKey extends string,
  TTab extends string,
>(
  rows: readonly TRow[],
  sort: LocalTableSortState<TKey>,
  columns: readonly LocalTableColumn<TRow, TKey, TTab>[],
  tab: TTab,
  getText?: (row: TRow, tab: TTab) => string,
  tieBreakers?: readonly TKey[],
  tieBreakText = true,
): TRow[] {
  const column =
    columns.find((candidate) => candidate.key === sort.key) ?? columns[0];
  if (!column) return [...rows];
  const direction = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue =
      column.sortValue?.(left, tab) ?? column.getValue(left, tab);
    const rightValue =
      column.sortValue?.(right, tab) ?? column.getValue(right, tab);
    const primary = (leftValue - rightValue) * direction;
    if (primary !== 0) return primary;
    for (const tieBreaker of tieBreakers ?? []) {
      if (tieBreaker === sort.key) continue;
      const tieColumn = columns.find(
        (candidate) => candidate.key === tieBreaker,
      );
      if (!tieColumn) continue;
      const leftTieValue =
        tieColumn.sortValue?.(left, tab) ?? tieColumn.getValue(left, tab);
      const rightTieValue =
        tieColumn.sortValue?.(right, tab) ?? tieColumn.getValue(right, tab);
      if (leftTieValue !== rightTieValue) return rightTieValue - leftTieValue;
    }
    if (!tieBreakText) return 0;
    const leftText = getText?.(left, tab) ?? left.key ?? "";
    const rightText = getText?.(right, tab) ?? right.key ?? "";
    return String(leftText).localeCompare(String(rightText));
  });
}

function localTableCursorOffset(cursor: string | null): number {
  if (!cursor) return 0;
  const offset = Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset >= 0 ? offset : 0;
}

export function loadLocalTablePage<
  TRow extends LocalTableRowBase,
  TKey extends string,
  TTab extends string,
>({
  rows,
  sort,
  columns,
  tab,
  limit,
  cursor,
  search = "",
  getText,
  getSearchText,
  tieBreakers,
  tieBreakText = true,
}: LocalTablePageOptions<TRow, TKey, TTab>): {
  items: readonly TRow[];
  pagination: {
    limit: number;
    returned: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
} {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const searchedRows = normalizedSearch
    ? rows.filter((row) =>
        (getSearchText?.(row, tab) ?? getText?.(row, tab) ?? row.key ?? "")
          .toLocaleLowerCase()
          .includes(normalizedSearch),
      )
    : rows;
  const sortedRows = sortLocalTableRows(
    searchedRows,
    sort,
    columns,
    tab,
    getText,
    tieBreakers,
    tieBreakText,
  );
  const pageSize = Math.max(1, Math.floor(limit || 1));
  const start = Math.min(localTableCursorOffset(cursor), sortedRows.length);
  const end = Math.min(start + pageSize, sortedRows.length);
  const items = sortedRows.slice(start, end);
  const hasMore = end < sortedRows.length;

  return {
    items,
    pagination: {
      limit: pageSize,
      returned: items.length,
      hasMore,
      nextCursor: hasMore ? String(end) : null,
    },
  };
}

export function localTablePage<TRow extends LocalTableRowBase>(
  rows: readonly TRow[],
  limit = rows.length || 1,
): {
  items: readonly TRow[];
  pagination: {
    limit: number;
    returned: number;
    hasMore: false;
    nextCursor: null;
  };
} {
  return {
    items: rows,
    pagination: {
      limit,
      returned: rows.length,
      hasMore: false,
      nextCursor: null,
    },
  };
}
