import type {
  TabbedDataTableColumn,
  TabbedDataTableExportLabels,
  TabbedDataTableRowBase,
  TabbedDataTableTab,
} from "./types";
export function defaultNormalizeRows<TRow extends TabbedDataTableRowBase>(
  rows: readonly TRow[],
): TRow[] {
  // Preserve the loader-provided order and avoid cloning every inactive tab.
  return rows as TRow[];
}
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
export function sanitizeCsvFilename(value: string): string {
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
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
export function buildCsv(
  rows: readonly (readonly (string | number | null | undefined)[])[],
) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
export function exportRowLabelFallback<TRow extends TabbedDataTableRowBase>(
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
export function downloadCsv(filename: string, csv: string) {
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
export const DEFAULT_EXPORT_LABELS = {
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
  budgetExceeded:
    "Export limit reached. Narrow the time range or add filters and try again.",
} satisfies Required<TabbedDataTableExportLabels>;
