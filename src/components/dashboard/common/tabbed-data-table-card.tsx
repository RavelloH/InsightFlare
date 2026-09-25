import {
  memo,
  startTransition,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiDownloadLine,
  RiSearchLine,
} from "@remixicon/react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { AnimatePresence, useReducedMotion } from "motion/react";

import { AnimatedDataTableRow } from "@/components/dashboard/common/animated-data-table-row";
import { DataTableSwitch } from "@/components/dashboard/common/data-table-switch";
import { TabbedScrollMaskCard } from "@/components/dashboard/common/tabbed-scroll-mask-card";
import { useInfiniteTableSentinel } from "@/components/dashboard/common/use-infinite-table-sentinel";
import { Button } from "@/components/ui/button";
import { Clickable } from "@/components/ui/clickable";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { useIsMobile } from "@/hooks/use-mobile";
import { sortLocalTableRows } from "@/lib/dashboard/table-loader";
import { cn } from "@/lib/utils";

import type {
  TabbedDataTableCardProps,
  TabbedDataTableColumn,
  TabbedDataTableExportRows,
  TabbedDataTableExportScope,
  TabbedDataTableRowBase,
  TabbedDataTableSortState,
} from "./tabbed-data-table-card/types";
export type * from "./tabbed-data-table-card/types";
import {
  buildCsv,
  createTabRecord,
  DEFAULT_EXPORT_LABELS,
  defaultNormalizeRows,
  downloadCsv,
  exportRowLabelFallback,
  firstSortableColumnKey,
  getColumnsForTab,
  sanitizeCsvFilename,
} from "./tabbed-data-table-card/utils";
export const MAX_EXPORT_ROWS = 50_000;
export const MAX_EXPORT_PAGES = 500;
function TabbedDataTableCardImpl<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string = string,
>({
  tabs,
  columns,
  rowAdapter,
  renderLabel,
  loader,
  limit = 100,
  normalizeRows = defaultNormalizeRows,
  filterRows,
  value,
  defaultValue,
  onValueChange,
  requestKey,
  contentTransitionKey,
  defaultSort,
  sortByTab: controlledSortByTab,
  onSortChange,
  sortActionLabel,
  labelColumnLabel,
  loadingLabel,
  emptyLabel,
  search,
  export: exportConfigProp,
  headerRight,
  headerHidden = false,
  className,
  tabsListClassName,
  tabTriggerClassName,
  viewportClassName,
  rowKeyPrefix,
  progress = "sort",
  getRowKey,
  getRowSearchText,
  getRowActive,
  getRowInteractive,
  getRowClassName,
  onRowClick,
  formatNumber,
}: TabbedDataTableCardProps<TTab, TRow, TKey>) {
  const isMobile = useIsMobile();
  const reduceDataRowMotion = useReducedMotion() ?? false;
  const controlled = value !== undefined;
  const tabsKey = useMemo(
    () =>
      tabs
        .map(
          (tab) =>
            `${tab.value}:${tab.label}:${tab.columnLabel ?? ""}:${tab.defaultSort?.key ?? ""}:${tab.defaultSort?.direction ?? ""}`,
        )
        .join("|"),
    [tabs],
  );
  const [internalTab, setInternalTab] = useState<TTab>(
    defaultValue ?? tabs[0].value,
  );
  const selectedTab = controlled ? value : internalTab;
  const activeTab: TTab =
    selectedTab !== undefined && tabs.some((tab) => tab.value === selectedTab)
      ? selectedTab
      : tabs[0].value;
  const [sortByTab, setSortByTab] = useState<
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
  const [searchTab, setSearchTab] = useState<TTab | null>(null);
  const [searchTermsByTab, setSearchTermsByTab] = useState<
    Record<TTab, string>
  >(() => createTabRecord(tabs, () => ""));
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportScope, setExportScope] =
    useState<TabbedDataTableExportScope>("currentTab");
  const [exportRows, setExportRows] =
    useState<TabbedDataTableExportRows>("currentView");
  const [exportFilename, setExportFilename] = useState("");
  const [exportError, setExportError] = useState<string | null>(null);
  const exportAbortControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => exportAbortControllerRef.current?.abort(), []);
  const activeSearchTab =
    searchTab !== null && tabs.some((tab) => tab.value === searchTab)
      ? searchTab
      : activeTab;
  const resolvedSearchTerm = searchTermsByTab[activeSearchTab] ?? "";
  const deferredSearchTerm = useDeferredValue(resolvedSearchTerm);
  const updateSearchTerm = useCallback(
    (value: string) => {
      const tab = searchTab ?? activeTab;
      setSearchTermsByTab((previous) => ({ ...previous, [tab]: value }));
    },
    [activeTab, searchTab],
  );
  const latestTabsRef = useRef(tabs);

  useEffect(() => {
    latestTabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    const nextTabs = latestTabsRef.current;
    if (nextTabs.some((tab) => tab.value === selectedTab)) return;
    const next = nextTabs[0].value;
    if (!controlled) setInternalTab(next);
    onValueChange?.(next);
  }, [controlled, onValueChange, selectedTab, tabsKey]);

  const searchConfig = search === false ? null : (search ?? {});
  const searchEnabled = searchConfig?.enabled ?? true;
  const exportConfig =
    exportConfigProp === false ? null : (exportConfigProp ?? {});
  const exportEnabled = exportConfig?.enabled ?? true;
  const exportLabels = {
    ...DEFAULT_EXPORT_LABELS,
    ...exportConfig?.labels,
  };
  const effectiveSortByTab = useMemo(
    () =>
      createTabRecord(tabs, (tab) => {
        const configured =
          controlledSortByTab?.[tab.value] ?? sortByTab[tab.value];
        const tabColumns = getColumnsForTab(columns, tab.value);
        if (
          configured &&
          tabColumns.some(
            (column) =>
              column.key === configured.key && column.sortable !== false,
          )
        ) {
          return configured;
        }

        return {
          key:
            (tab.defaultSort?.key as TKey | undefined) ??
            defaultSort?.key ??
            firstSortableColumnKey(tabColumns),
          direction:
            tab.defaultSort?.direction ?? defaultSort?.direction ?? "desc",
        };
      }),
    [columns, controlledSortByTab, defaultSort, sortByTab, tabs],
  );
  const activeSort = effectiveSortByTab[activeTab];
  const activeColumns = getColumnsForTab(columns, activeTab);
  const localSortText = rowAdapter?.getSearchText ?? getRowSearchText;
  const completedRowsByDatasetRef = useRef<Map<string, readonly TRow[]>>(
    new Map(),
  );
  const datasetKey = useMemo(
    () =>
      JSON.stringify([
        requestKey ?? "",
        tabsKey,
        activeTab,
        deferredSearchTerm,
      ]),
    [activeTab, deferredSearchTerm, requestKey, tabsKey],
  );
  const completedRows =
    completedRowsByDatasetRef.current.get(datasetKey) ?? null;
  const querySortKey = completedRows ? "local" : activeSort.key;
  const querySortDirection = completedRows ? "local" : activeSort.direction;
  const dataQuery = useInfiniteQuery({
    queryKey: [
      "dashboard",
      "tabbed-data",
      requestKey ?? "",
      tabsKey,
      activeTab,
      querySortKey,
      querySortDirection,
      deferredSearchTerm,
    ],
    queryFn: ({ pageParam, signal }) =>
      loader({
        tab: activeTab,
        cursor: pageParam,
        limit,
        search: deferredSearchTerm,
        sort: activeSort,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) =>
      lastPage.pagination.hasMore
        ? (lastPage.pagination.nextCursor ?? undefined)
        : undefined,
    // A changing request key should refresh rows in place. In particular,
    // realtime snapshots must not replace the whole table with a loading
    // state before the next snapshot arrives.
    placeholderData: keepPreviousData,
    enabled: typeof window !== "undefined" && completedRows === null,
  });
  const {
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    isPlaceholderData,
  } = dataQuery;

  useEffect(() => {
    const pages = dataQuery.data?.pages;
    const lastPage = pages?.at(-1);
    if (
      isPlaceholderData ||
      !pages ||
      !lastPage ||
      lastPage.pagination.hasMore
    ) {
      return;
    }
    completedRowsByDatasetRef.current.set(
      datasetKey,
      pages.flatMap((page) => page.items),
    );
  }, [dataQuery.data, datasetKey, isPlaceholderData]);

  const rawActiveRows = useMemo(() => {
    if (completedRows) {
      return sortLocalTableRows(
        completedRows,
        activeSort,
        activeColumns,
        activeTab,
        localSortText,
      );
    }
    return (
      dataQuery.data?.pages.flatMap((page) => page.items) ??
      (null as readonly TRow[] | null)
    );
  }, [
    activeColumns,
    activeSort,
    activeTab,
    completedRows,
    dataQuery.data,
    localSortText,
  ]);
  const rawRowsByTab = useMemo(
    () =>
      createTabRecord(tabs, (tab) =>
        tab.value === activeTab ? rawActiveRows : null,
      ),
    [activeTab, rawActiveRows, tabs],
  );
  const resolvedRowsByTab = useMemo(
    () =>
      createTabRecord(tabs, (tab) =>
        tab.value === activeTab && rawActiveRows !== null
          ? normalizeRows(rawActiveRows, tab.value)
          : null,
      ),
    [activeTab, normalizeRows, rawActiveRows, tabs],
  );

  // The loader owns row order while data is paginated. Once the complete
  // result is cached locally, sortLocalTableRows owns the display order
  // instead.
  const activeRows = useMemo(() => {
    const rows = resolvedRowsByTab[activeTab] ?? [];
    return filterRows ? filterRows(rows, activeTab) : rows;
  }, [activeTab, filterRows, resolvedRowsByTab]);
  const normalizedSearchTerm = deferredSearchTerm.trim().toLocaleLowerCase();
  const searchedRows = useMemo(() => {
    const normalizedRows = resolvedRowsByTab[activeSearchTab] ?? [];
    const rows =
      activeSearchTab === activeTab
        ? activeRows
        : filterRows
          ? filterRows(normalizedRows, activeSearchTab)
          : normalizedRows;
    if (!normalizedSearchTerm) return rows;
    const getText =
      searchConfig?.getText ??
      rowAdapter?.getSearchText ??
      getRowSearchText ??
      ((row: TRow) => row.key ?? "");
    return rows.filter((row) =>
      getText(row, activeSearchTab)
        .toLocaleLowerCase()
        .includes(normalizedSearchTerm),
    );
  }, [
    activeSearchTab,
    activeTab,
    activeRows,
    filterRows,
    getRowSearchText,
    normalizedSearchTerm,
    resolvedRowsByTab,
    rowAdapter,
    searchConfig,
  ]);

  const tabByValue = useMemo(
    () => new Map(tabs.map((tab) => [tab.value, tab])),
    [tabs],
  );
  const activeTabMeta = tabByValue.get(activeTab) ?? tabs[0];
  const activeSearchTabMeta = tabByValue.get(activeSearchTab) ?? activeTabMeta;
  const activeLoading = completedRows ? false : isPending;
  const searchLoading =
    activeSearchTab === activeTab ? (completedRows ? false : isPending) : false;
  const activeSearchColumns = getColumnsForTab(columns, activeSearchTab);
  const colSpan = 1 + activeColumns.length;
  const searchColSpan = 1 + activeSearchColumns.length;
  const activeHasMore = Boolean(hasNextPage);
  const activeLoadingMore = isFetchingNextPage;
  const loadMoreInFlightRef = useRef(false);
  useEffect(() => {
    if (!activeLoadingMore) loadMoreInFlightRef.current = false;
  }, [activeLoadingMore, activeHasMore, activeRows.length, activeTab]);
  const loadMore = useCallback(() => {
    if (!activeHasMore || activeLoadingMore || loadMoreInFlightRef.current) {
      return;
    }
    loadMoreInFlightRef.current = true;
    void fetchNextPage();
  }, [activeHasMore, activeLoadingMore, fetchNextPage]);
  const loadMoreSentinelRef = useInfiniteTableSentinel({
    enabled: !activeLoading && !activeLoadingMore && activeHasMore,
    onReachEnd: loadMore,
    rootMargin: "0px",
    triggerDistance: 0,
  });

  const activeSearchTitle =
    searchConfig?.title?.(activeSearchTabMeta) ??
    searchConfig?.placeholder?.(activeSearchTabMeta) ??
    activeSearchTabMeta.label;
  const activeSearchPlaceholder =
    searchConfig?.placeholder?.(activeSearchTabMeta) ?? activeSearchTitle;
  const searchActionLabel = searchConfig?.actionLabel ?? activeSearchTitle;
  const defaultExportFilename = useMemo(() => {
    const configured = exportConfig?.filename;
    const base =
      typeof configured === "function"
        ? configured(activeTabMeta)
        : (configured ?? `table-${activeTabMeta.value}`);
    return sanitizeCsvFilename(base);
  }, [activeTabMeta, exportConfig]);

  useEffect(() => {
    if (!exportOpen) return;
    setExportError(null);
    setExportScope(exportConfig?.defaultScope ?? "currentTab");
    setExportRows(exportConfig?.defaultRows ?? "currentView");
    setExportFilename(defaultExportFilename);
  }, [
    defaultExportFilename,
    exportConfig?.defaultRows,
    exportConfig?.defaultScope,
    exportOpen,
  ]);

  function setActiveTab(next: TTab) {
    if (!controlled) {
      startTransition(() => setInternalTab(next));
    }
    onValueChange?.(next);
  }

  function toggleSort(tab: TTab, key: TKey) {
    const current = effectiveSortByTab[tab];
    const next: TabbedDataTableSortState<TKey> =
      current.key === key
        ? {
            key,
            direction: current.direction === "desc" ? "asc" : "desc",
          }
        : { key, direction: "desc" as const };
    if (onSortChange) {
      onSortChange(tab, next);
      return;
    }
    setSortByTab((previous) => ({
      ...previous,
      [tab]: next,
    }));
  }

  function renderSortIndicator(tab: TTab, key: TKey) {
    const sort = effectiveSortByTab[tab];
    if (sort.key === key) {
      return sort.direction === "desc" ? (
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

  function renderTableHeader(
    tab: TTab,
    metricColumns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[],
  ) {
    const tabMeta = tabByValue.get(tab) ?? tabs[0];
    const firstColumnLabel =
      typeof labelColumnLabel === "function"
        ? labelColumnLabel(tabMeta)
        : (labelColumnLabel ?? tabMeta.columnLabel ?? tabMeta.label);

    return (
      <TableRow className="hover:bg-transparent">
        <TableHead className="h-8 p-0">
          <div className="px-4">{firstColumnLabel}</div>
        </TableHead>
        {metricColumns.map((column) => {
          const sortable = column.sortable !== false;
          const active = effectiveSortByTab[tab].key === column.key;

          return (
            <TableHead
              key={column.key}
              aria-sort={
                sortable && active
                  ? effectiveSortByTab[tab].direction === "asc"
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
                    if (sortable) toggleSort(tab, column.key);
                  }}
                >
                  {column.label}
                  {sortable ? renderSortIndicator(tab, column.key) : null}
                </button>
              </div>
            </TableHead>
          );
        })}
      </TableRow>
    );
  }

  function renderRows(
    tab: TTab,
    rows: readonly TRow[],
    metricColumns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[],
    source: "card" | "search",
  ) {
    const sort = effectiveSortByTab[tab];
    const progressColumn =
      progress === false
        ? null
        : (metricColumns.find((column) =>
            progress === "sort"
              ? column.key === sort.key
              : column.key === progress,
          ) ?? metricColumns[0]);
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
              reduceMotion={reduceDataRowMotion}
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
              onClick={() =>
                (rowAdapter?.onClick ?? onRowClick)?.(row, context)
              }
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
              {metricColumns.map((column, index) => {
                const value = column.getValue(row, tab);
                return (
                  <TableCell key={column.key} className="p-0">
                    <div
                      className={cn(
                        index === metricColumns.length - 1
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

  function renderLoadMoreRows(
    tab: TTab,
    metricColumns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[],
  ) {
    return Array.from({ length: 3 }, (_, rowIndex) => (
      <TableRow
        key={`load-more-skeleton-${tab}-${rowIndex}`}
        aria-hidden="true"
        className="pointer-events-none hover:bg-transparent"
      >
        <TableCell className="whitespace-normal p-0 align-top">
          <div className="px-4 py-2">
            <Skeleton
              className={cn("h-5", rowIndex === 1 ? "w-[72%]" : "w-[58%]")}
            />
          </div>
        </TableCell>
        {metricColumns.map((column, columnIndex) => (
          <TableCell key={column.key} className="p-0">
            <div
              ref={
                columnIndex === metricColumns.length - 1
                  ? loadMoreSentinelRef
                  : undefined
              }
              className={cn(
                "flex justify-end px-2 py-2",
                columnIndex === metricColumns.length - 1 && "px-4",
              )}
            >
              <Skeleton className="h-4 w-14" />
            </div>
          </TableCell>
        ))}
      </TableRow>
    ));
  }

  function renderInitialLoadingRows(
    tab: TTab,
    metricColumns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[],
    source: "card" | "search",
  ) {
    return Array.from({ length: Math.max(1, limit) }, (_, rowIndex) => (
      <TableRow
        key={`initial-loading-skeleton-${source}-${tab}-${rowIndex}`}
        aria-hidden="true"
        className="pointer-events-none hover:bg-transparent"
      >
        <TableCell className="whitespace-normal p-0 align-top">
          <div className="px-4 py-2 leading-5">
            <Skeleton
              className={cn("h-5", rowIndex % 3 === 1 ? "w-[72%]" : "w-[58%]")}
            />
          </div>
        </TableCell>
        {metricColumns.map((column, columnIndex) => (
          <TableCell key={column.key} className="p-0">
            <div
              className={cn(
                "flex justify-end px-2 py-2",
                columnIndex === metricColumns.length - 1 && "px-4",
              )}
            >
              <Skeleton className="h-4 w-14" />
            </div>
          </TableCell>
        ))}
      </TableRow>
    ));
  }

  function rowLabel(row: TRow, tab: TTab) {
    return (
      exportConfig?.getRowLabel?.(row, tab) ??
      rowAdapter?.getExportLabel?.(row, tab) ??
      exportRowLabelFallback(row)
    );
  }

  function exportCellValue(
    row: TRow,
    column: TabbedDataTableColumn<TRow, TKey, TTab>,
    tab: TTab,
  ) {
    const rawValue = column.getValue(row, tab);
    return (
      column.exportValue?.(row, tab) ??
      exportConfig?.getCellValue?.(rawValue, row, column, tab) ??
      rawValue
    );
  }

  function exportRowsForTab(
    tab: TTab,
    rowsByTabOverride?: ReadonlyMap<TTab, readonly TRow[]>,
  ) {
    const sourceRows = rowsByTabOverride?.has(tab)
      ? (rowsByTabOverride.get(tab) ?? [])
      : exportRows === "rawRows"
        ? (rawRowsByTab[tab] ?? [])
        : (resolvedRowsByTab[tab] ?? []);
    return exportRows === "rawRows"
      ? sourceRows
      : filterRows
        ? filterRows(sourceRows, tab)
        : sourceRows;
  }

  function buildExportCsv(
    rowsByTabOverride?: ReadonlyMap<TTab, readonly TRow[]>,
  ) {
    const selectedTabs =
      exportScope === "allTabs" ? [...tabs] : [activeTabMeta];
    const rows: (string | number | null | undefined)[][] = [];
    selectedTabs.forEach((tabMeta, tabIndex) => {
      const tabColumns = getColumnsForTab(columns, tabMeta.value).filter(
        (column) => column.exportable !== false,
      );
      const firstColumnLabel =
        typeof labelColumnLabel === "function"
          ? labelColumnLabel(tabMeta)
          : (labelColumnLabel ?? tabMeta.columnLabel ?? tabMeta.label);
      if (selectedTabs.length > 1) {
        if (tabIndex > 0) rows.push([]);
        rows.push([tabMeta.label]);
      }
      rows.push([
        firstColumnLabel,
        ...tabColumns.map((column) => column.exportLabel ?? column.label),
      ]);
      exportRowsForTab(tabMeta.value, rowsByTabOverride).forEach((row) => {
        rows.push([
          rowLabel(row, tabMeta.value),
          ...tabColumns.map((column) =>
            exportCellValue(row, column, tabMeta.value),
          ),
        ]);
      });
    });
    return buildCsv(rows);
  }

  function countExportRows(
    rowsByTabOverride?: ReadonlyMap<TTab, readonly TRow[]>,
  ) {
    const selectedTabs =
      exportScope === "allTabs" ? [...tabs] : [activeTabMeta];
    return selectedTabs.reduce(
      (sum, tab) => sum + exportRowsForTab(tab.value, rowsByTabOverride).length,
      0,
    );
  }

  async function collectRowsForExport(signal: AbortSignal) {
    const selectedTabs =
      exportScope === "allTabs" ? [...tabs] : [activeTabMeta];
    const rowsByTabForExport = new Map<TTab, readonly TRow[]>();
    let exportRowCount = 0;
    let exportPageCount = 0;

    for (const tabMeta of selectedTabs) {
      const tab = tabMeta.value;
      const tabSearchTerm =
        tab === activeTab ? deferredSearchTerm : (searchTermsByTab[tab] ?? "");
      const completedTabRows =
        completedRowsByDatasetRef.current.get(
          JSON.stringify([requestKey ?? "", tabsKey, tab, tabSearchTerm]),
        ) ?? null;
      const tabPageData = tab === activeTab ? dataQuery.data : undefined;
      const loadedRawRows =
        completedTabRows ??
        tabPageData?.pages.flatMap((page) => page.items) ??
        [];
      const lastPage = completedTabRows ? undefined : tabPageData?.pages.at(-1);
      let rows =
        exportRows === "rawRows"
          ? [...loadedRawRows]
          : [...normalizeRows(loadedRawRows, tab)];
      exportRowCount += rows.length;
      exportPageCount += tabPageData?.pages.length ?? 0;
      if (
        exportRowCount > MAX_EXPORT_ROWS ||
        exportPageCount > MAX_EXPORT_PAGES
      ) {
        throw new Error("export_budget_exceeded");
      }
      let hasMore = completedTabRows
        ? false
        : tabPageData === undefined || Boolean(lastPage?.pagination.hasMore);
      let cursor = lastPage?.pagination.nextCursor ?? null;

      const seenCursors = new Set<string>();
      while (hasMore) {
        if (cursor !== null) {
          if (seenCursors.has(cursor)) {
            throw new Error("The export cursor did not advance.");
          }
          seenCursors.add(cursor);
        }

        const page = await loader({
          tab,
          cursor,
          limit,
          search: tabSearchTerm,
          sort: effectiveSortByTab[tab],
          signal,
        });
        exportPageCount += 1;
        const pageRows =
          exportRows === "rawRows"
            ? [...page.items]
            : normalizeRows(page.items, tab);
        if (
          exportPageCount > MAX_EXPORT_PAGES ||
          exportRowCount + pageRows.length > MAX_EXPORT_ROWS
        ) {
          throw new Error("export_budget_exceeded");
        }
        rows = [...rows, ...pageRows];
        exportRowCount += pageRows.length;
        hasMore = page.pagination.hasMore;
        cursor = page.pagination.nextCursor;
        if (hasMore && cursor === null) {
          throw new Error("The export page did not provide a next cursor.");
        }
        if (hasMore && exportRowCount >= MAX_EXPORT_ROWS) {
          throw new Error("export_budget_exceeded");
        }
        if (hasMore && exportPageCount >= MAX_EXPORT_PAGES) {
          throw new Error("export_budget_exceeded");
        }
      }

      rowsByTabForExport.set(tab, rows);
    }

    return rowsByTabForExport;
  }

  async function handleExport() {
    if (exporting) return;
    const controller = new AbortController();
    exportAbortControllerRef.current = controller;
    setExporting(true);
    setExportError(null);
    try {
      const rowsByTabForExport = await collectRowsForExport(controller.signal);
      if (countExportRows(rowsByTabForExport) === 0) return;
      const csv = buildExportCsv(rowsByTabForExport);
      downloadCsv(exportFilename || defaultExportFilename, csv);
      setExportOpen(false);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        if (
          error instanceof Error &&
          error.message === "export_budget_exceeded"
        ) {
          setExportError(exportLabels.budgetExceeded);
        } else {
          console.error("Failed to export table data", error);
        }
      }
    } finally {
      if (exportAbortControllerRef.current === controller) {
        exportAbortControllerRef.current = null;
      }
      setExporting(false);
    }
  }

  const searchContent =
    searchEnabled && searchTab !== null ? (
      <div className="space-y-3">
        <Input
          value={resolvedSearchTerm}
          onChange={(event) => updateSearchTerm(event.target.value)}
          placeholder={activeSearchPlaceholder}
        />
        <VerticalScrollMask className="max-h-[60vh]" contentClassName="pr-1">
          <DataTableSwitch
            loading={searchLoading}
            hasContent={searchedRows.length > 0}
            loadingLabel={loadingLabel}
            emptyLabel={emptyLabel}
            colSpan={searchColSpan}
            header={renderTableHeader(activeSearchTab, activeSearchColumns)}
            loadingRows={
              searchLoading
                ? renderInitialLoadingRows(
                    activeSearchTab,
                    activeSearchColumns,
                    "search",
                  )
                : undefined
            }
            rows={renderRows(
              activeSearchTab,
              searchedRows,
              activeSearchColumns,
              "search",
            )}
            contentKey={`search-${activeSearchTab}-${deferredSearchTerm}-${searchedRows.length}`}
          />
        </VerticalScrollMask>
      </div>
    ) : null;

  const searchPanel = searchContent ? (
    isMobile ? (
      <Drawer
        open={searchTab !== null}
        onOpenChange={(open) => {
          if (!open) setSearchTab(null);
        }}
      >
        <DrawerContent className="max-h-[80dvh]">
          <DrawerHeader>
            <DrawerTitle>{activeSearchTitle}</DrawerTitle>
          </DrawerHeader>
          <DrawerScrollArea contentClassName="px-4 pb-4">
            {searchContent}
          </DrawerScrollArea>
        </DrawerContent>
      </Drawer>
    ) : (
      <Dialog
        open={searchTab !== null}
        onOpenChange={(open) => {
          if (!open) setSearchTab(null);
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle icon={RiSearchLine}>{activeSearchTitle}</DialogTitle>
          </DialogHeader>
          {searchContent}
        </DialogContent>
      </Dialog>
    )
  ) : null;

  const searchAction =
    searchEnabled && !headerHidden ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Clickable
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => setSearchTab(activeTab)}
            aria-label={searchActionLabel}
          >
            <RiSearchLine className="size-4" />
          </Clickable>
        </TooltipTrigger>
        <TooltipContent>{searchActionLabel}</TooltipContent>
      </Tooltip>
    ) : null;

  const exportAction =
    exportEnabled && !headerHidden ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Clickable
            className="size-6 text-muted-foreground hover:text-foreground"
            onClick={() => setExportOpen(true)}
            aria-label={exportLabels.action}
          >
            <RiDownloadLine className="size-4" />
          </Clickable>
        </TooltipTrigger>
        <TooltipContent>{exportLabels.action}</TooltipContent>
      </Tooltip>
    ) : null;

  const exportRowCount =
    exportEnabled && !headerHidden && exportOpen ? countExportRows() : 0;
  const exportCanLoadRows = Boolean(loader);
  const exportPanel =
    exportEnabled && !headerHidden && exportOpen ? (
      <Dialog
        open={exportOpen}
        onOpenChange={(open) => {
          setExportOpen(open);
          if (!open) exportAbortControllerRef.current?.abort();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle icon={RiDownloadLine}>
              {exportLabels.title}
            </DialogTitle>
            <DialogDescription>{exportLabels.description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <label
                className="text-xs font-medium"
                htmlFor="table-export-scope"
              >
                {exportLabels.scopeLabel}
              </label>
              <Select
                value={exportScope}
                onValueChange={(value) =>
                  setExportScope(value as TabbedDataTableExportScope)
                }
              >
                <SelectTrigger id="table-export-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="currentTab">
                    {exportLabels.currentTab}
                  </SelectItem>
                  <SelectItem value="allTabs">
                    {exportLabels.allTabs}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <label
                className="text-xs font-medium"
                htmlFor="table-export-rows"
              >
                {exportLabels.rowsLabel}
              </label>
              <Select
                value={exportRows}
                onValueChange={(value) =>
                  setExportRows(value as TabbedDataTableExportRows)
                }
              >
                <SelectTrigger id="table-export-rows" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="currentView">
                    {exportLabels.currentView}
                  </SelectItem>
                  <SelectItem value="rawRows">
                    {exportLabels.rawRows}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <label
                className="text-xs font-medium"
                htmlFor="table-export-name"
              >
                {exportLabels.fileNameLabel}
              </label>
              <Input
                id="table-export-name"
                value={exportFilename}
                onChange={(event) => setExportFilename(event.target.value)}
              />
            </div>
            {exportRowCount === 0 && !exportCanLoadRows ? (
              <p className="text-xs text-muted-foreground">
                {exportLabels.empty}
              </p>
            ) : null}
            {exportError ? (
              <p className="text-xs text-destructive" role="alert">
                {exportError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              onClick={handleExport}
              disabled={
                exporting || (exportRowCount === 0 && !exportCanLoadRows)
              }
              aria-busy={exporting}
            >
              {exporting ? <Spinner className="size-4" /> : <RiDownloadLine />}
              {exporting ? loadingLabel : exportLabels.download}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ) : null;

  const syncKey = [
    requestKey ?? "",
    activeTab,
    activeLoading ? "loading" : "idle",
    effectiveSortByTab[activeTab].key,
    effectiveSortByTab[activeTab].direction,
    activeRows.length,
  ].join(":");

  return (
    <>
      <TabbedScrollMaskCard
        value={activeTab}
        onValueChange={(next) => setActiveTab(next)}
        tabs={tabs}
        headerRight={
          headerRight || exportAction || searchAction ? (
            <div className="inline-flex items-center gap-1">
              {headerRight}
              {exportAction}
              {searchAction}
            </div>
          ) : undefined
        }
        headerHidden={headerHidden}
        className={className}
        tabsListClassName={tabsListClassName}
        tabTriggerClassName={tabTriggerClassName}
        viewportClassName={viewportClassName}
        syncKey={syncKey}
      >
        <DataTableSwitch
          loading={activeLoading}
          hasContent={activeRows.length > 0}
          loadingLabel={loadingLabel}
          emptyLabel={emptyLabel}
          colSpan={colSpan}
          header={renderTableHeader(activeTab, activeColumns)}
          loadingRows={
            activeLoading
              ? renderInitialLoadingRows(activeTab, activeColumns, "card")
              : undefined
          }
          rows={renderRows(activeTab, activeRows, activeColumns, "card")}
          footer={
            activeHasMore ? renderLoadMoreRows(activeTab, activeColumns) : null
          }
          contentKey={`card-${contentTransitionKey ?? requestKey ?? ""}-${activeTab}`}
        />
      </TabbedScrollMaskCard>
      {searchPanel}
      {exportPanel}
    </>
  );
}
export const TabbedDataTableCard = memo(
  TabbedDataTableCardImpl,
) as typeof TabbedDataTableCardImpl;
