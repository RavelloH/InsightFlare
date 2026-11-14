import { createElement, useState } from "react";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from "@insightflare/ui/table";

import {
  type AnalyticsTableColumnDefinition,
  AnalyticsTableColumnSettings,
} from "./analytics-table-column-settings";

export interface AnalyticsTableColumnSettingsContractProps {
  preset: "default" | "all-columns";
}

const COLUMN_SETTINGS_BASE_COLUMNS: readonly AnalyticsTableColumnDefinition[] =
  [
    { id: "page", label: "Page", required: true },
    { id: "views", label: "Views" },
    { id: "visitors", label: "Visitors" },
    { id: "conversions", label: "Conversions", defaultVisible: false },
  ] as const satisfies readonly AnalyticsTableColumnDefinition[];

const COLUMN_SETTINGS_LABELS = {
  action: "Configure columns",
  title: "Table columns",
  description: "Choose which columns to show and drag to change their order.",
  visible: "Visible columns",
  required: "Required",
  reset: "Reset",
  dragHint: "Drag to reorder",
  close: "Done",
};

const AnalyticsTableColumnSettingsContractPreview = Object.assign(
  function AnalyticsTableColumnSettingsContractPreview({
    columns,
    orderedIds: initialOrderedIds,
    visibleIds: initialVisibleIds,
    onOrderChange,
    onVisibilityChange,
    onReset,
    labels,
  }: {
    columns: readonly AnalyticsTableColumnDefinition[];
    orderedIds: readonly string[];
    visibleIds: readonly string[];
    onOrderChange: (nextOrder: readonly string[]) => void;
    onVisibilityChange: (nextVisible: readonly string[]) => void;
    onReset: () => void;
    labels: typeof COLUMN_SETTINGS_LABELS;
  }) {
    const [orderedIds, setOrderedIds] = useState([...initialOrderedIds]);
    const [visibleIds, setVisibleIds] = useState([...initialVisibleIds]);
    const visibleColumnIds = orderedIds.filter((id) => visibleIds.includes(id));
    const columnsById = new Map(
      columns.map((column) => [column.id, column] as const),
    );
    const handleOrderChange = (nextOrder: readonly string[]) => {
      setOrderedIds([...nextOrder]);
      onOrderChange(nextOrder);
    };
    const handleVisibilityChange = (nextVisible: readonly string[]) => {
      setVisibleIds([...nextVisible]);
      onVisibilityChange(nextVisible);
    };
    const handleReset = () => {
      setOrderedIds(columns.map((column) => column.id));
      setVisibleIds(
        columns
          .filter(
            (column) => column.required || column.defaultVisible !== false,
          )
          .map((column) => column.id),
      );
      onReset();
    };

    return createElement(
      "div",
      { className: "grid w-full gap-3" },
      createElement(
        "div",
        { className: "flex items-center justify-between gap-3" },
        createElement("p", { className: "text-sm font-medium" }, "Page report"),
        createElement(AnalyticsTableColumnSettings, {
          columns,
          orderedIds,
          visibleIds,
          onOrderChange: handleOrderChange,
          onVisibilityChange: handleVisibilityChange,
          onReset: handleReset,
          labels,
        }),
      ),
      createElement(
        Table,
        null,
        createElement(
          "thead",
          null,
          createElement(
            TableRow,
            null,
            ...visibleColumnIds.map((id) =>
              createElement(
                TableHead,
                { key: id },
                columnsById.get(id)?.label ?? id,
              ),
            ),
          ),
        ),
        createElement(
          TableBody,
          null,
          ...[
            ["/pricing", "1,284", "842", "126"],
            ["/docs/getting-started", "946", "731", "84"],
          ].map((row) =>
            createElement(
              TableRow,
              { key: row[0]! },
              ...visibleColumnIds.map((id) => {
                const index = columns.findIndex((column) => column.id === id);
                return createElement(TableCell, { key: id }, row[index] ?? "—");
              }),
            ),
          ),
        ),
      ),
    );
  },
  { displayName: "AnalyticsTableColumnSettings" },
);

export const analyticsTableColumnSettingsFixtures = [
  {
    id: "analytics-table-column-settings.default",
    title: "Analytics table column settings",
    props: { preset: "default" },
  },
] as const satisfies readonly ComponentFixture<AnalyticsTableColumnSettingsContractProps>[];

export const analyticsTableColumnSettingsContract =
  defineComponentContract<AnalyticsTableColumnSettingsContractProps>({
    id: "analytics-table-column-settings",
    title: "Analytics table column settings",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    fixtures: analyticsTableColumnSettingsFixtures,
    render: ({ preset }) => {
      const columns = COLUMN_SETTINGS_BASE_COLUMNS.map((column) => ({
        ...column,
        defaultVisible:
          preset === "all-columns" || column.defaultVisible !== false,
      }));
      const orderedIds = columns.map((column) => column.id);
      const visibleIds = columns
        .filter((column) => column.required || column.defaultVisible !== false)
        .map((column) => column.id);

      return createElement(AnalyticsTableColumnSettingsContractPreview, {
        key: preset,
        columns,
        orderedIds,
        visibleIds,
        onOrderChange: () => {},
        onVisibilityChange: () => {},
        onReset: () => {},
        labels: COLUMN_SETTINGS_LABELS,
      });
    },
  });
