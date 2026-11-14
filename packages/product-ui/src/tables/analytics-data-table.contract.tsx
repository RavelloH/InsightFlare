import { createElement, Fragment } from "react";
import {
  type ComponentFixture,
  defineComponentContract,
} from "@insightflare/ui/contracts";

import { AnalyticsDataTable } from "./analytics-data-table";

interface AnalyticsDataTableContractRow {
  id: string;
  page: string;
  views: string;
}

export interface AnalyticsDataTableContractProps {
  loading: boolean;
  rows: readonly AnalyticsDataTableContractRow[];
}

export const analyticsDataTableFixtures = [
  {
    id: "analytics-data-table.default",
    title: "Analytics table",
    props: {
      loading: false,
      rows: [
        { id: "pricing", page: "/pricing", views: "1,284" },
        { id: "docs", page: "/docs/getting-started", views: "946" },
        { id: "blog", page: "/blog/launch", views: "721" },
      ],
    },
  },
] as const satisfies readonly ComponentFixture<AnalyticsDataTableContractProps>[];

export const analyticsDataTableContract =
  defineComponentContract<AnalyticsDataTableContractProps>({
    id: "analytics-data-table",
    title: "Analytics data table",
    category: "Product UI / Analytics",
    categoryId: "product-analytics",
    fixtures: analyticsDataTableFixtures,
    render: ({ loading, rows }) =>
      createElement(AnalyticsDataTable<AnalyticsDataTableContractRow>, {
        loading,
        rows,
        header: createElement(
          "tr",
          null,
          createElement("th", { className: "px-4 py-3 text-left" }, "Page"),
          createElement("th", { className: "px-4 py-3 text-right" }, "Views"),
        ),
        columnCount: 2,
        skeletonRows: 3,
        getRowKey: (row) => row.id,
        renderRow: (row) => ({
          children: createElement(
            Fragment,
            null,
            createElement("td", { className: "px-4 py-3" }, row.page),
            createElement(
              "td",
              { className: "px-4 py-3 text-right tabular-nums" },
              row.views,
            ),
          ),
        }),
        renderSkeletonRow: () =>
          createElement(
            Fragment,
            null,
            createElement(
              "td",
              { className: "px-4 py-3" },
              createElement("div", {
                className: "h-4 w-40 animate-pulse bg-muted",
              }),
            ),
            createElement(
              "td",
              { className: "px-4 py-3" },
              createElement("div", {
                className: "ml-auto h-4 w-16 animate-pulse bg-muted",
              }),
            ),
          ),
        errorContent: "Unable to load pages.",
        emptyContent: "No pages found.",
        minTableWidth: "32rem",
      }),
  });
