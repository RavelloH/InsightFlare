import type { ReactNode } from "react";
import type {
  TabbedDataTableColumn,
  TabbedDataTableRowAdapter,
  TabbedDataTableRowBase,
  TabbedDataTableRowContext,
  TabbedDataTableSortState,
} from "@insightflare/ui/tabbed-table";

export type {
  TabbedDataTableColumn,
  TabbedDataTableRowAdapter,
  TabbedDataTableRowBase,
  TabbedDataTableRowContext,
  TabbedDataTableSortDirection,
  TabbedDataTableSortState,
  TabbedDataTableTab,
} from "@insightflare/ui/tabbed-table";

type NonEmptyArray<T> = readonly [T, ...T[]];

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
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    limit?: number;
    returned?: number;
  };
}

export type TabbedDataTableLoader<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string,
> = (
  options: TabbedDataTableLoaderOptions<TTab, TKey>,
) => Promise<TabbedDataTablePage<TRow>>;

export interface TabbedDataTableQueryOptions<
  TRow extends TabbedDataTableRowBase,
> {
  queryKey: readonly unknown[];
  queryFn: (context: {
    pageParam: string | null;
    signal: AbortSignal;
  }) => Promise<TabbedDataTablePage<TRow>>;
  initialPageParam: string | null;
  getNextPageParam: (lastPage: TabbedDataTablePage<TRow>) => string | undefined;
  placeholderData: (
    previousData:
      | {
          pages: TabbedDataTablePage<TRow>[];
          pageParams: (string | null)[];
        }
      | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined,
  ) =>
    | {
        pages: TabbedDataTablePage<TRow>[];
        pageParams: (string | null)[];
      }
    | undefined;
  enabled: boolean;
}

export interface TabbedDataTableQueryResult<
  TRow extends TabbedDataTableRowBase,
> {
  data?: {
    pages: TabbedDataTablePage<TRow>[];
    pageParams: (string | null)[];
  };
  fetchNextPage: () => Promise<unknown>;
  hasNextPage: boolean | undefined;
  isFetchingNextPage: boolean;
  isFetching: boolean;
  isPending: boolean;
  isPlaceholderData: boolean;
  isError?: boolean;
}

export type TabbedDataTableQueryHook<TRow extends TabbedDataTableRowBase> = (
  options: TabbedDataTableQueryOptions<TRow>,
) => TabbedDataTableQueryResult<TRow>;

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
  errorLabel?: string;
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
