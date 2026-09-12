import { describe, expect, it } from "vitest";

import {
  loadLocalTablePage,
  localTablePage,
  sortLocalTableRows,
} from "@/lib/dashboard/table-loader";

type Row = { key: string; value: number; secondary: number };

const columns = [
  { key: "value", getValue: (row: Row) => row.value },
  { key: "secondary", getValue: (row: Row) => row.secondary },
] as const;

const rows: Row[] = [
  { key: "charlie", value: 2, secondary: 1 },
  { key: "alpha", value: 2, secondary: 3 },
  { key: "bravo", value: 4, secondary: 0 },
];

describe("table loader helpers", () => {
  it("sorts complete local collections with metric and text tie breakers", () => {
    expect(
      sortLocalTableRows(
        rows,
        { key: "value", direction: "desc" },
        columns,
        "tab",
      ),
    ).toEqual([rows[2], rows[1], rows[0]]);
    expect(
      sortLocalTableRows(
        rows,
        { key: "value", direction: "asc" },
        columns,
        "tab",
        undefined,
        ["secondary"],
      ),
    ).toEqual([rows[1], rows[0], rows[2]]);
    expect(
      sortLocalTableRows(
        rows,
        { key: "missing", direction: "desc" },
        columns,
        "tab",
        undefined,
        undefined,
        false,
      ),
    ).toEqual([rows[2], rows[0], rows[1]]);
    expect(
      sortLocalTableRows(rows, { key: "value", direction: "desc" }, [], "tab"),
    ).toEqual(rows);
  });

  it("filters, sorts, and returns stable offset pages", () => {
    expect(
      loadLocalTablePage({
        rows,
        sort: { key: "value", direction: "desc" },
        columns,
        tab: "tab",
        limit: 1,
        cursor: null,
        search: "ALP",
        getSearchText: (row) => row.key,
      }),
    ).toEqual({
      items: [rows[1]],
      pagination: { limit: 1, returned: 1, hasMore: false, nextCursor: null },
    });

    expect(
      loadLocalTablePage({
        rows,
        sort: { key: "value", direction: "desc" },
        columns,
        tab: "tab",
        limit: 2,
        cursor: "1",
        getText: (row) => row.key,
      }),
    ).toEqual({
      items: [rows[1], rows[0]],
      pagination: { limit: 2, returned: 2, hasMore: false, nextCursor: null },
    });

    expect(
      loadLocalTablePage({
        rows,
        sort: { key: "secondary", direction: "asc" },
        columns,
        tab: "tab",
        limit: 0,
        cursor: "invalid",
        search: " ",
      }).pagination,
    ).toEqual({
      limit: 1,
      returned: 1,
      hasMore: true,
      nextCursor: "1",
    });
  });

  it("wraps already complete rows without changing their order", () => {
    expect(localTablePage(rows, 10)).toEqual({
      items: rows,
      pagination: { limit: 10, returned: 3, hasMore: false, nextCursor: null },
    });
    expect(localTablePage([])).toEqual({
      items: [],
      pagination: { limit: 1, returned: 0, hasMore: false, nextCursor: null },
    });
  });
});
