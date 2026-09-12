import { parseDemoFilters, parseDemoNumber } from "@/lib/realtime/mock/filters";
import type { DemoQueryFilters } from "@/lib/realtime/mock/types";

export type DemoComparisonMetric = "views" | "visitors";

export type DemoComparisonRow = {
  label: string;
  views: number;
  sessions: number;
  visitors: number;
};

export type DemoComparisonFields = {
  reference: {
    views: number;
    sessions: number;
    visitors: number;
  };
  change: {
    views: { absolute: number; relative: number | null };
    sessions: { absolute: number; relative: number | null };
    visitors: { absolute: number; relative: number | null };
  };
};

export type DemoComparisonRowResult = DemoComparisonRow & DemoComparisonFields;

export interface DemoComparisonWindow {
  mode: "same" | "previous";
  from: number;
  to: number;
  filters: DemoQueryFilters;
}

export function resolveDemoComparison(
  params: Record<string, string | number>,
  currentFilters: DemoQueryFilters,
): DemoComparisonWindow | null {
  const mode = params.compare;
  if (mode !== "same" && mode !== "previous") return null;

  const compareFilterParams: Record<string, string | number> = {};
  let hasCompareFilter = false;
  for (const [key, value] of Object.entries(params)) {
    if (!key.startsWith("compareFilter[")) continue;
    hasCompareFilter = true;
    compareFilterParams[`filter${key.slice("compareFilter".length)}`] = value;
  }

  // The real contract treats compare=same without compareFilter as invalid.
  if (mode === "same" && !hasCompareFilter) return null;

  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  if (to <= from) return null;

  const filters = hasCompareFilter
    ? parseDemoFilters({
        ...compareFilterParams,
        ...(params.operation !== undefined
          ? { operation: params.operation }
          : {}),
      })
    : currentFilters;

  if (mode === "same") {
    return { mode, from, to, filters };
  }

  const span = Math.max(1, to - from);
  const referenceTo = Math.max(from - 1, 0);
  const referenceFrom = Math.max(referenceTo - span, 0);
  if (referenceFrom >= referenceTo) return null;

  return {
    mode,
    from: referenceFrom,
    to: referenceTo,
    filters,
  };
}

function metricValue(
  row: Pick<DemoComparisonRow, "views" | "visitors"> | undefined,
  metric: DemoComparisonMetric,
): number {
  return Math.max(0, Number(row?.[metric] ?? 0));
}

function relativeChange(current: number, reference: number): number | null {
  if (reference === 0) return current === 0 ? 0 : null;
  return (current - reference) / reference;
}

function rowChange(
  current: DemoComparisonRow,
  reference: DemoComparisonRow,
): DemoComparisonRowResult["change"] {
  return {
    views: {
      absolute: current.views - reference.views,
      relative: relativeChange(current.views, reference.views),
    },
    sessions: {
      absolute: current.sessions - reference.sessions,
      relative: relativeChange(current.sessions, reference.sessions),
    },
    visitors: {
      absolute: current.visitors - reference.visitors,
      relative: relativeChange(current.visitors, reference.visitors),
    },
  };
}

export function buildDemoComparisonRows<TRow extends DemoComparisonRow>(
  currentRows: readonly TRow[],
  referenceRows: readonly DemoComparisonRow[],
  params: Record<string, string | number>,
): Array<TRow & DemoComparisonFields> {
  const rowsByLabel = new Map<
    string,
    { current?: DemoComparisonRow; reference?: DemoComparisonRow }
  >();
  for (const row of currentRows) {
    const label = String(row.label ?? "");
    const entry = rowsByLabel.get(label) ?? {};
    entry.current = row;
    rowsByLabel.set(label, entry);
  }
  for (const row of referenceRows) {
    const label = String(row.label ?? "");
    const entry = rowsByLabel.get(label) ?? {};
    entry.reference = row;
    rowsByLabel.set(label, entry);
  }

  const rows = Array.from(rowsByLabel.values()).map(
    ({ current, reference }) => {
      const currentRow = current ?? {
        ...(reference ?? { label: "" }),
        views: 0,
        sessions: 0,
        visitors: 0,
      };
      const referenceRow = reference ?? {
        ...(current ?? { label: "" }),
        views: 0,
        sessions: 0,
        visitors: 0,
      };
      return {
        ...currentRow,
        label: currentRow.label || referenceRow.label,
        views: currentRow.views,
        sessions: currentRow.sessions,
        visitors: currentRow.visitors,
        reference: {
          views: referenceRow.views,
          sessions: referenceRow.sessions,
          visitors: referenceRow.visitors,
        },
        change: rowChange(currentRow, referenceRow),
      } as TRow & DemoComparisonFields;
    },
  );

  const metric: DemoComparisonMetric =
    params.metric === "visitors" ? "visitors" : "views";
  const sortBy =
    params.sortBy === "reference" || params.sortBy === "change"
      ? params.sortBy
      : "current";
  const direction = params.direction === "asc" ? 1 : -1;
  const valueFor = (row: DemoComparisonRowResult): number => {
    if (sortBy === "reference") return metricValue(row.reference, metric);
    if (sortBy === "change") {
      return row.change[metric].relative ?? -Infinity;
    }
    return metricValue(row, metric);
  };

  rows.sort((left, right) => {
    if (sortBy === "change") {
      const leftNew =
        metricValue(left.reference, metric) === 0 &&
        metricValue(left, metric) > 0;
      const rightNew =
        metricValue(right.reference, metric) === 0 &&
        metricValue(right, metric) > 0;
      if (leftNew !== rightNew) {
        return direction === 1 ? (leftNew ? 1 : -1) : leftNew ? -1 : 1;
      }
    }
    return (
      (valueFor(left) - valueFor(right)) * direction ||
      (right.views - left.views) * direction ||
      (right.sessions - left.sessions) * direction ||
      left.label.localeCompare(right.label)
    );
  });

  return rows;
}
