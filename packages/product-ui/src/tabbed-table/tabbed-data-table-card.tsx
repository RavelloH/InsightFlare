import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@insightflare/ui/button";
import { Clickable } from "@insightflare/ui/clickable";
import { DataTableSwitch } from "@insightflare/ui/data-table-switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@insightflare/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerScrollArea,
  DrawerTitle,
} from "@insightflare/ui/drawer";
import { Input } from "@insightflare/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@insightflare/ui/select";
import { Spinner } from "@insightflare/ui/spinner";
import {
  TabbedDataTableHeader,
  TabbedDataTableRows,
  TabbedDataTableView,
  type TabbedDataTableViewState,
} from "@insightflare/ui/tabbed-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@insightflare/ui/tooltip";
import { useIsMobile } from "@insightflare/ui/use-mobile";
import { VerticalScrollMask } from "@insightflare/ui/vertical-scroll-mask";
import { RiDownloadLine, RiSearchLine } from "@remixicon/react";

import type {
  TabbedDataTableCardProps,
  TabbedDataTableColumn,
  TabbedDataTableExportRows,
  TabbedDataTableExportScope,
  TabbedDataTableQueryHook,
  TabbedDataTableRowBase,
  TabbedDataTableSortState,
} from "./types";
export type * from "./types";
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
} from "./utils";
import { sortLocalTableRows } from "./utils";

export interface TabbedDataTableCardDataControllerProps<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string = string,
> extends TabbedDataTableCardProps<TTab, TRow, TKey> {
  useDataQuery: TabbedDataTableQueryHook<TRow>;
}
export const MAX_EXPORT_ROWS = 50_000;
export const MAX_EXPORT_PAGES = 500;
function TabbedDataTableCardDataControllerImpl<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string = string,
>({
  useDataQuery,
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
  errorLabel,
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
}: TabbedDataTableCardDataControllerProps<TTab, TRow, TKey>) {
  const isMobile = useIsMobile();
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
  const [pendingTab, setPendingTab] = useState<TTab | null>(null);
  const [pendingSort, setPendingSort] = useState<{
    tab: TTab;
    sort: TabbedDataTableSortState<TKey>;
    fetchStarted: boolean;
  } | null>(null);
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
  const dataQuery = useDataQuery({
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
    // Sort changes on incomplete datasets are server-side requests. A cached
    // page for a recently used sort must still be revalidated before the
    // pending-sort transition is allowed to finish.
    staleTime: 0,
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
    // Keep the previous rows during same-tab refreshes (for example,
    // realtime snapshots), but never show another tab's rows while loading.
    placeholderData: (previousData, previousQuery) => {
      const previousQueryKey = previousQuery?.queryKey;
      return previousQueryKey?.[3] === tabsKey &&
        previousQueryKey[4] === activeTab
        ? previousData
        : undefined;
    },
    enabled: typeof window !== "undefined" && completedRows === null,
  });
  const {
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
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
  const pendingSortMatchesActive =
    pendingSort !== null &&
    pendingSort.tab === activeTab &&
    pendingSort.sort.key === activeSort.key &&
    pendingSort.sort.direction === activeSort.direction;
  const activeError = dataQuery.isError ?? false;
  const activeLoading = completedRows
    ? false
    : isPending ||
      (pendingTab === activeTab && isFetching) ||
      (pendingSortMatchesActive && !activeError);
  const searchLoading =
    activeSearchTab === activeTab ? (completedRows ? false : isPending) : false;
  useEffect(() => {
    if (
      pendingTab === activeTab &&
      (completedRows || (!isPending && !isPlaceholderData && !isFetching))
    ) {
      setPendingTab(null);
    }
  }, [
    activeTab,
    completedRows,
    isFetching,
    isPending,
    isPlaceholderData,
    pendingTab,
  ]);
  useEffect(() => {
    if (!pendingSort) return;
    if (completedRows || activeError) {
      setPendingSort(null);
      return;
    }
    if (!pendingSortMatchesActive) return;
    if (isFetching) {
      if (!pendingSort.fetchStarted) {
        setPendingSort({ ...pendingSort, fetchStarted: true });
      }
      return;
    }
    if (pendingSort.fetchStarted && !isPending && !isPlaceholderData) {
      setPendingSort(null);
    }
  }, [
    activeError,
    completedRows,
    isFetching,
    isPending,
    isPlaceholderData,
    pendingSort,
    pendingSortMatchesActive,
  ]);
  const activeSearchColumns = getColumnsForTab(columns, activeSearchTab);
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
    setPendingSort(null);
    if (next !== activeTab) setPendingTab(next);
    if (!controlled) {
      setInternalTab(next);
    }
    onValueChange?.(next);
  }

  function updateSort(tab: TTab, next: TabbedDataTableSortState<TKey>) {
    // A complete result is sorted from the local cache. Incomplete datasets
    // change the query key and let the loader fetch the first page in the new
    // server order; show the same loading transition used for tab changes.
    if (tab === activeTab && completedRows === null) {
      setPendingSort({ tab, sort: next, fetchStarted: false });
    }
    if (onSortChange) {
      onSortChange(tab, next);
      return;
    }
    setSortByTab((previous) => ({
      ...previous,
      [tab]: next,
    }));
  }

  function renderTableHeader(
    tab: TTab,
    metricColumns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[],
  ) {
    return (
      <TabbedDataTableHeader
        tabs={tabs}
        tab={tab}
        columns={metricColumns}
        sort={effectiveSortByTab[tab]}
        labelColumnLabel={labelColumnLabel}
        sortActionLabel={sortActionLabel}
        onSortChange={updateSort}
      />
    );
  }

  function renderRows(
    tab: TTab,
    rows: readonly TRow[],
    metricColumns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[],
    source: "card" | "search",
  ) {
    return (
      <TabbedDataTableRows
        tab={tab}
        rows={rows}
        columns={metricColumns}
        sort={effectiveSortByTab[tab]}
        source={source}
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
            loadingRowCount={Math.max(1, limit)}
            header={renderTableHeader(activeSearchTab, activeSearchColumns)}
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
              {exporting ? <Spinner /> : <RiDownloadLine />}
              {exporting ? loadingLabel : exportLabels.download}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ) : null;

  const syncKey = [
    requestKey ?? "",
    activeTab,
    activeError ? "error" : activeLoading ? "loading" : "idle",
    effectiveSortByTab[activeTab].key,
    effectiveSortByTab[activeTab].direction,
    activeRows.length,
  ].join(":");
  const activeState: TabbedDataTableViewState = activeError
    ? "error"
    : activeLoading
      ? "loading"
      : activeLoadingMore
        ? "loading-more"
        : activeRows.length === 0
          ? "empty"
          : "ready";

  return (
    <>
      <TabbedDataTableView
        tabs={tabs}
        columns={columns}
        rows={activeRows}
        state={activeState}
        value={activeTab}
        onValueChange={setActiveTab}
        sortByTab={effectiveSortByTab}
        onSortChange={updateSort}
        sortActionLabel={sortActionLabel}
        labelColumnLabel={labelColumnLabel}
        loadingLabel={loadingLabel}
        loadingMoreLabel={loadingLabel}
        hasMore={activeHasMore}
        onLoadMore={loadMore}
        emptyLabel={emptyLabel}
        errorLabel={errorLabel}
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
        contentKey={`card-${contentTransitionKey ?? requestKey ?? ""}-${activeTab}`}
      />
      {searchPanel}
      {exportPanel}
    </>
  );
}
export const TabbedDataTableCardDataController = memo(
  TabbedDataTableCardDataControllerImpl,
) as typeof TabbedDataTableCardDataControllerImpl;
