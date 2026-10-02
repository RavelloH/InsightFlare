import {
  type ComponentContract,
  type ComponentFixture,
  defineComponentContract,
} from "../../contracts/component-contract";
import {
  TabbedDataTableView,
  type TabbedDataTableViewProps,
} from "./tabbed-table/view";
import type {
  TabbedDataTableColumn,
  TabbedDataTableRowBase,
  TabbedDataTableTab,
} from "./tabbed-table.types";

type TabbedTableTab = "pages" | "sources";
type TabbedTableColumn = "views" | "visitors";

interface TabbedTableRow extends TabbedDataTableRowBase {
  key: string;
  label: string;
  pages: { views: number; visitors: number };
  sources: { views: number; visitors: number };
}

type TabbedTableViewProps = TabbedDataTableViewProps<
  TabbedTableTab,
  TabbedTableRow,
  TabbedTableColumn
>;

export type TabbedDataTableViewFixture = ComponentFixture<TabbedTableViewProps>;
export type TabbedDataTableViewContract =
  ComponentContract<TabbedTableViewProps>;

const tabs = [
  { value: "pages", label: "Pages", columnLabel: "Page" },
  { value: "sources", label: "Sources", columnLabel: "Source" },
] as const satisfies readonly TabbedDataTableTab<TabbedTableTab>[];

const pagesRows: readonly TabbedTableRow[] = [
  {
    key: "overview",
    label: "/overview",
    pages: { views: 12_480, visitors: 8_940 },
    sources: { views: 0, visitors: 0 },
  },
  {
    key: "pricing",
    label: "/pricing",
    pages: { views: 8_320, visitors: 6_110 },
    sources: { views: 0, visitors: 0 },
  },
  {
    key: "signup",
    label: "/signup",
    pages: { views: 4_560, visitors: 3_420 },
    sources: { views: 0, visitors: 0 },
  },
];

const sourceRows: readonly TabbedTableRow[] = [
  {
    key: "search",
    label: "Search",
    pages: { views: 0, visitors: 0 },
    sources: { views: 14_820, visitors: 10_240 },
  },
  {
    key: "direct",
    label: "Direct",
    pages: { views: 0, visitors: 0 },
    sources: { views: 9_640, visitors: 7_110 },
  },
  {
    key: "social",
    label: "Social",
    pages: { views: 0, visitors: 0 },
    sources: { views: 3_180, visitors: 2_460 },
  },
];

const columns: readonly TabbedDataTableColumn<
  TabbedTableRow,
  TabbedTableColumn,
  TabbedTableTab
>[] = [
  {
    key: "views",
    label: "Views",
    getValue: (row, tab) => row[tab].views,
    format: (value) => value.toLocaleString("en-US"),
  },
  {
    key: "visitors",
    label: "Visitors",
    getValue: (row, tab) => row[tab].visitors,
    format: (value) => value.toLocaleString("en-US"),
  },
];

const rowsByTab: Record<TabbedTableTab, readonly TabbedTableRow[]> = {
  pages: pagesRows,
  sources: sourceRows,
};

const commonProps = {
  tabs,
  columns,
  rows: pagesRows,
  rowsByTab,
  defaultValue: "pages",
  defaultSort: { key: "views", direction: "desc" },
  sortActionLabel: (columnLabel: string) => `Sort by ${columnLabel}`,
  renderLabel: (row: TabbedTableRow) => row.label,
  loadingLabel: "Loading table…",
  loadingMoreLabel: "Loading more rows…",
  loadingRowCount: 3,
  hasMore: false,
  onLoadMore: () => {},
  emptyLabel: "No data available.",
  errorLabel: "Unable to load table data.",
} satisfies Omit<TabbedTableViewProps, "state">;

export const tabbedDataTableViewFixtures = [
  {
    id: "tabbed-table.ready",
    title: "Ready",
    props: { ...commonProps, state: "ready" },
  },
  {
    id: "tabbed-table.loading",
    title: "Loading",
    props: { ...commonProps, state: "loading" },
  },
  {
    id: "tabbed-table.loading-more",
    title: "Loading more",
    props: { ...commonProps, state: "loading-more", hasMore: true },
  },
  {
    id: "tabbed-table.empty",
    title: "Empty",
    props: {
      ...commonProps,
      state: "empty",
      rows: [],
      rowsByTab: { pages: [], sources: [] },
    },
  },
  {
    id: "tabbed-table.error",
    title: "Error",
    props: { ...commonProps, state: "error" },
  },
] as const satisfies readonly TabbedDataTableViewFixture[];

export const tabbedDataTableViewContract: TabbedDataTableViewContract =
  defineComponentContract<TabbedTableViewProps>({
    id: "tabbed-table",
    title: "Tabbed table",
    category: "Data display",
    categoryId: "data-display",
    fixtures: tabbedDataTableViewFixtures,
    render: (props) => (
      <TabbedDataTableView key={props.value ?? props.defaultValue} {...props} />
    ),
  });
