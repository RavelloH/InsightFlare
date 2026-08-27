import {
  memo,
  type ReactNode,
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
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, useReducedMotion } from "motion/react";

import { AnimatedDataTableRow } from "@/components/dashboard/animated-data-table-row";
import { DataTableSwitch } from "@/components/dashboard/data-table-switch";
import {
  TabbedScrollMaskCard,
  type TabbedScrollMaskCardTab,
} from "@/components/dashboard/tabbed-scroll-mask-card";
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
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { VerticalScrollMask } from "@/components/ui/vertical-scroll-mask";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

type NonEmptyArray<T> = readonly [T, ...T[]];
const EMPTY_ROWS_BY_TAB = {};

export type TabbedDataTableSortDirection = "asc" | "desc";

export interface TabbedDataTableSortState<TKey extends string = string> {
  key: TKey;
  direction: TabbedDataTableSortDirection;
}

export interface TabbedDataTableRowBase {
  key?: string;
}

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
  allTabsUnavailable?: string;
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
  rowsByTab?: Partial<Record<TTab, readonly TRow[] | null>>;
  loadingByTab?: Partial<Record<TTab, boolean>>;
  loadRows?: (tab: TTab, signal: AbortSignal) => Promise<readonly TRow[]>;
  normalizeRows?: (rows: readonly TRow[], tab: TTab) => TRow[];
  filterRows?: (rows: readonly TRow[], tab: TTab) => TRow[];
  compareRows?: (
    left: TRow,
    right: TRow,
    context: {
      tab: TTab;
      sort: TabbedDataTableSortState<TKey>;
      columns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[];
    },
  ) => number;
  value?: TTab;
  defaultValue?: TTab;
  onValueChange?: (value: TTab) => void;
  requestKey?: string | number;
  defaultSort?: TabbedDataTableSortState<TKey>;
  sortByTab?: Partial<Record<TTab, TabbedDataTableSortState<TKey>>>;
  onSortChange?: (tab: TTab, sort: TabbedDataTableSortState<TKey>) => void;
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

function defaultNormalizeRows<TRow extends TabbedDataTableRowBase>(
  rows: readonly TRow[],
): TRow[] {
  // Sorting always works on a copy, so the default path can preserve the
  // external rows reference and avoid cloning every inactive tab.
  return rows as TRow[];
}

function createTabRecord<TTab extends string, TValue>(
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

function getColumnsForTab<
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

function firstSortableColumnKey<
  TRow extends TabbedDataTableRowBase,
  TKey extends string,
  TTab extends string,
>(columns: readonly TabbedDataTableColumn<TRow, TKey, TTab>[]): TKey {
  return (columns.find((column) => column.sortable !== false) ?? columns[0])
    .key;
}

function sanitizeCsvFilename(value: string): string {
  const trimmed = value.trim() || "table-export";
  const safe = Array.from(trimmed)
    .map((character) =>
      character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character)
        ? "-"
        : character,
    )
    .join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return safe.toLocaleLowerCase().endsWith(".csv")
    ? safe
    : `${safe || "table-export"}.csv`;
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(
  rows: readonly (readonly (string | number | null | undefined)[])[],
) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function exportRowLabelFallback<TRow extends TabbedDataTableRowBase>(
  row: TRow,
): string {
  const record = row as Record<string, unknown>;
  for (const key of ["displayLabel", "label", "rawLabel"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return row.key ?? "";
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([`\uFEFF${csv}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeCsvFilename(filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

const DEFAULT_EXPORT_LABELS = {
  action: "Export",
  title: "Export CSV",
  description: "Download table data as a CSV file.",
  scopeLabel: "Scope",
  currentTab: "Current tab",
  allTabs: "All tabs",
  rowsLabel: "Data",
  currentView: "Current displayed data",
  rawRows: "Original data",
  fileNameLabel: "File name",
  download: "Export CSV",
  empty: "No rows available to export.",
  allTabsUnavailable: "All tabs are available after their data has loaded.",
} satisfies Required<TabbedDataTableExportLabels>;

function TabbedDataTableCardImpl<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string = string,
>({
  tabs,
  columns,
  rowAdapter,
  renderLabel,
  rowsByTab,
  loadingByTab,
  loadRows,
  normalizeRows = defaultNormalizeRows,
  filterRows,
  compareRows,
  value,
  defaultValue,
  onValueChange,
  requestKey,
  defaultSort,
  sortByTab: controlledSortByTab,
  onSortChange,
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
  const activeTab = controlled ? value : internalTab;
  const [loadedRowsByTab, setLoadedRowsByTab] = useState<
    Record<TTab, TRow[] | null>
  >(() => createTabRecord(tabs, () => null));
  const [rawLoadedRowsByTab, setRawLoadedRowsByTab] = useState<
    Record<TTab, readonly TRow[] | null>
  >(() => createTabRecord(tabs, () => null));
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
  const [searchTerm, setSearchTerm] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] =
    useState<TabbedDataTableExportScope>("currentTab");
  const [exportRows, setExportRows] =
    useState<TabbedDataTableExportRows>("currentView");
  const [exportFilename, setExportFilename] = useState("");
  const deferredSearchTerm = useDeferredValue(searchTerm);
  const latestTabsRef = useRef(tabs);
  const latestColumnsRef = useRef(columns);
  const externalRowsByTab = (rowsByTab ?? EMPTY_ROWS_BY_TAB) as Partial<
    Record<TTab, readonly TRow[] | null>
  >;
  const activeExternalRows = externalRowsByTab[activeTab];
  const dataQuery = useQuery({
    queryKey: [
      "dashboard",
      "tabbed-data",
      requestKey ?? "",
      tabsKey,
      activeTab,
    ],
    queryFn: async ({ signal }) => {
      if (!loadRows) return [] as readonly TRow[];
      try {
        return await loadRows(activeTab, signal);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return [] as readonly TRow[];
      }
    },
    enabled:
      typeof window !== "undefined" &&
      Boolean(loadRows) &&
      activeExternalRows === undefined,
  });

  useEffect(() => {
    latestTabsRef.current = tabs;
    latestColumnsRef.current = columns;
  }, [columns, tabs]);

  useEffect(() => {
    const nextTabs = latestTabsRef.current;
    if (nextTabs.some((tab) => tab.value === activeTab)) return;
    const next = nextTabs[0].value;
    if (!controlled) setInternalTab(next);
    onValueChange?.(next);
  }, [activeTab, controlled, onValueChange, tabsKey]);

  useEffect(() => {
    const nextTabs = latestTabsRef.current;
    const nextColumns = latestColumnsRef.current;
    setLoadedRowsByTab(createTabRecord(nextTabs, () => null));
    setRawLoadedRowsByTab(createTabRecord(nextTabs, () => null));
    setSortByTab(
      createTabRecord(nextTabs, (tab) => {
        const tabColumns = getColumnsForTab(nextColumns, tab.value);
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
    setSearchTab(null);
    setSearchTerm("");
  }, [defaultSort?.direction, defaultSort?.key, requestKey, tabsKey]);

  useEffect(() => {
    if (activeExternalRows !== undefined || dataQuery.data === undefined)
      return;
    setRawLoadedRowsByTab((previous) => ({
      ...previous,
      [activeTab]: dataQuery.data,
    }));
    setLoadedRowsByTab((previous) => ({
      ...previous,
      [activeTab]: normalizeRows(dataQuery.data, activeTab),
    }));
  }, [activeExternalRows, activeTab, dataQuery.data, normalizeRows]);

  useEffect(() => {
    if (searchTab !== null) return;
    setSearchTerm("");
  }, [searchTab]);

  const effectiveSortByTab = useMemo(
    () =>
      createTabRecord(
        tabs,
        (tab) => controlledSortByTab?.[tab.value] ?? sortByTab[tab.value],
      ),
    [controlledSortByTab, sortByTab, tabs],
  );
  const searchConfig = search === false ? null : (search ?? {});
  const searchEnabled = searchConfig?.enabled ?? true;
  const exportConfig =
    exportConfigProp === false ? null : (exportConfigProp ?? {});
  const exportEnabled = exportConfig?.enabled ?? true;
  const exportLabels = {
    ...DEFAULT_EXPORT_LABELS,
    ...exportConfig?.labels,
  };
  const activeSearchTab = searchTab ?? activeTab;

  const rawRowsByTab = useMemo(() => {
    return createTabRecord(tabs, (tab) => {
      const externalRows = externalRowsByTab[tab.value];
      if (externalRows !== undefined) return externalRows;
      if (tab.value === activeTab && dataQuery.data !== undefined) {
        return dataQuery.data;
      }
      return rawLoadedRowsByTab[tab.value];
    });
  }, [activeTab, dataQuery.data, externalRowsByTab, rawLoadedRowsByTab, tabs]);

  const resolvedRowsByTab = useMemo(() => {
    return createTabRecord(tabs, (tab) => {
      const externalRows = externalRowsByTab[tab.value];
      if (externalRows !== undefined) {
        return externalRows === null
          ? null
          : normalizeRows(externalRows, tab.value);
      }
      if (tab.value === activeTab && dataQuery.data !== undefined) {
        return normalizeRows(dataQuery.data, tab.value);
      }
      return loadedRowsByTab[tab.value];
    });
  }, [
    activeTab,
    dataQuery.data,
    externalRowsByTab,
    loadedRowsByTab,
    normalizeRows,
    tabs,
  ]);

  const resolvedLoadingByTab = useMemo(
    () =>
      createTabRecord(tabs, (tab) =>
        Boolean(
          loadingByTab?.[tab.value] ??
          (tab.value === activeTab &&
            dataQuery.isFetching &&
            dataQuery.data === undefined),
        ),
      ),
    [activeTab, dataQuery.data, dataQuery.isFetching, loadingByTab, tabs],
  );

  const sortRowsForTab = useCallback(
    (tabValue: TTab): TRow[] => {
      const tabRows = resolvedRowsByTab[tabValue] ?? [];
      const tabColumns = getColumnsForTab(columns, tabValue);
      const sort = effectiveSortByTab[tabValue];
      const sortColumn =
        tabColumns.find((column) => column.key === sort.key) ?? tabColumns[0];
      const direction = sort.direction === "asc" ? 1 : -1;
      const sorted = [...tabRows].sort((left, right) => {
        if (compareRows) {
          const custom = compareRows(left, right, {
            tab: tabValue,
            sort,
            columns: tabColumns,
          });
          if (custom !== 0) return custom;
        }

        const leftValue =
          sortColumn.sortValue?.(left, tabValue) ??
          sortColumn.getValue(left, tabValue);
        const rightValue =
          sortColumn.sortValue?.(right, tabValue) ??
          sortColumn.getValue(right, tabValue);
        const primary = (leftValue - rightValue) * direction;
        if (primary !== 0) return primary;
        const leftText =
          rowAdapter?.getSearchText?.(left, tabValue) ??
          getRowSearchText?.(left, tabValue) ??
          left.key ??
          "";
        const rightText =
          rowAdapter?.getSearchText?.(right, tabValue) ??
          getRowSearchText?.(right, tabValue) ??
          right.key ??
          "";
        return String(leftText).localeCompare(String(rightText));
      });

      return filterRows ? filterRows(sorted, tabValue) : sorted;
    },
    [
      columns,
      compareRows,
      effectiveSortByTab,
      filterRows,
      getRowSearchText,
      resolvedRowsByTab,
      rowAdapter,
    ],
  );

  const activeRows = useMemo(
    () => sortRowsForTab(activeTab),
    [activeTab, sortRowsForTab],
  );
  const normalizedSearchTerm = deferredSearchTerm.trim().toLocaleLowerCase();
  const searchedRows = useMemo(() => {
    const rows =
      activeSearchTab === activeTab
        ? activeRows
        : sortRowsForTab(activeSearchTab);
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
    getRowSearchText,
    normalizedSearchTerm,
    rowAdapter,
    searchConfig,
    sortRowsForTab,
  ]);

  const tabByValue = useMemo(
    () => new Map(tabs.map((tab) => [tab.value, tab])),
    [tabs],
  );
  const activeTabMeta = tabByValue.get(activeTab) ?? tabs[0];
  const activeSearchTabMeta = tabByValue.get(activeSearchTab) ?? activeTabMeta;
  const activeLoading =
    resolvedLoadingByTab[activeTab] || resolvedRowsByTab[activeTab] === null;
  const searchLoading =
    resolvedLoadingByTab[activeSearchTab] ||
    resolvedRowsByTab[activeSearchTab] === null;
  const activeColumns = getColumnsForTab(columns, activeTab);
  const activeSearchColumns = getColumnsForTab(columns, activeSearchTab);
  const colSpan = 1 + activeColumns.length;
  const searchColSpan = 1 + activeSearchColumns.length;
  const allExportTabsLoaded = tabs.every(
    (tab) =>
      resolvedRowsByTab[tab.value] !== null && !resolvedLoadingByTab[tab.value],
  );

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
    setExportScope(
      exportConfig?.defaultScope === "allTabs" && allExportTabsLoaded
        ? "allTabs"
        : "currentTab",
    );
    setExportRows(exportConfig?.defaultRows ?? "currentView");
    setExportFilename(defaultExportFilename);
  }, [
    allExportTabsLoaded,
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
              className={cn("h-8 w-20 p-0", column.widthClassName)}
            >
              <div className="flex justify-end px-2">
                <button
                  type="button"
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

  function exportRowsForTab(tab: TTab) {
    if (exportRows === "rawRows") {
      return rawRowsByTab[tab] ?? [];
    }
    return tab === activeTab ? activeRows : sortRowsForTab(tab);
  }

  function buildExportCsv() {
    const selectedTabs =
      exportScope === "allTabs" && allExportTabsLoaded
        ? [...tabs]
        : [activeTabMeta];
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
      exportRowsForTab(tabMeta.value).forEach((row) => {
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

  function countExportRows() {
    const selectedTabs =
      exportScope === "allTabs" && allExportTabsLoaded
        ? [...tabs]
        : [activeTabMeta];
    return selectedTabs.reduce(
      (sum, tab) => sum + exportRowsForTab(tab.value).length,
      0,
    );
  }

  function handleExport() {
    const csv = buildExportCsv();
    downloadCsv(exportFilename || defaultExportFilename, csv);
    setExportOpen(false);
  }

  const searchContent =
    searchEnabled && searchTab !== null ? (
      <div className="space-y-3">
        <Input
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
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
      <Clickable
        className="size-6 text-muted-foreground hover:text-foreground"
        onClick={() => setSearchTab(activeTab)}
        aria-label={searchActionLabel}
        title={searchActionLabel}
      >
        <RiSearchLine className="size-4" />
      </Clickable>
    ) : null;

  const exportAction =
    exportEnabled && !headerHidden ? (
      <Clickable
        className="size-6 text-muted-foreground hover:text-foreground"
        onClick={() => setExportOpen(true)}
        aria-label={exportLabels.action}
        title={exportLabels.action}
      >
        <RiDownloadLine className="size-4" />
      </Clickable>
    ) : null;

  const exportRowCount =
    exportEnabled && !headerHidden && exportOpen ? countExportRows() : 0;
  const exportPanel =
    exportEnabled && !headerHidden && exportOpen ? (
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
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
                  <SelectItem value="allTabs" disabled={!allExportTabsLoaded}>
                    {exportLabels.allTabs}
                  </SelectItem>
                </SelectContent>
              </Select>
              {!allExportTabsLoaded ? (
                <p className="text-xs text-muted-foreground">
                  {exportLabels.allTabsUnavailable}
                </p>
              ) : null}
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
            {exportRowCount === 0 ? (
              <p className="text-xs text-muted-foreground">
                {exportLabels.empty}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={handleExport} disabled={exportRowCount === 0}>
              <RiDownloadLine />
              {exportLabels.download}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ) : null;

  const syncKey = [
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
          rows={renderRows(activeTab, activeRows, activeColumns, "card")}
          contentKey={`card-${activeTab}-${activeRows.length}`}
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
