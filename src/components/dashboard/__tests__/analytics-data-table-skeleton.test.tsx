import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsDataTable } from "@insightflare/product-ui/tables";
import { Skeleton } from "@insightflare/ui/skeleton";
import { describe, expect, it, vi } from "vitest";

function renderTable(loading: boolean, hasMore: boolean) {
  return renderToStaticMarkup(
    <AnalyticsDataTable
      header={
        <tr>
          <th>Page</th>
          <th>Views</th>
        </tr>
      }
      rows={[{ id: "home" }]}
      getRowKey={(row) => row.id}
      renderRow={(row) => ({ children: <td colSpan={2}>{row.id}</td> })}
      renderSkeletonRow={() => (
        <>
          <td>
            <Skeleton />
          </td>
          <td>
            <Skeleton />
          </td>
        </>
      )}
      skeletonRows={25}
      columnCount={2}
      loading={loading}
      hasMore={hasMore}
      emptyContent="Empty"
      errorContent="Error"
    />,
  );
}

describe("analytics table loading motion budget", () => {
  it.each([
    [true, false],
    [false, true],
  ])(
    "limits shimmer to one row for loading=%s and hasMore=%s",
    (loading, hasMore) => {
      const html = renderTable(loading, hasMore);
      expect(html.match(/data-skeleton-motion="active"/g)).toHaveLength(1);
      expect(html.match(/data-skeleton-motion="static"/g)).toHaveLength(24);
      expect(html.match(/data-slot="skeleton"/g)).toHaveLength(50);
    },
  );

  it("retains placeholder elements across pending and appended pages, and rebuilds them on column changes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const row = { id: "home" };
    const row2 = { id: "about" };
    const rows = [row];
    const appended = [row, row2];
    const renderRow = (item: typeof row) => ({ children: <td>{item.id}</td> });
    const getRowKey = (item: typeof row) => item.id;
    const renderSkeletonRow = vi.fn(() => <td>Loading</td>);
    const changed = vi.fn(() => <td>New column</td>);
    const render = (
      items: typeof rows,
      loadingMore: boolean,
      hasMore = true,
      skeleton = renderSkeletonRow,
    ) =>
      act(() =>
        root.render(
          <AnalyticsDataTable
            header={
              <tr>
                <th>Page</th>
              </tr>
            }
            rows={items}
            getRowKey={getRowKey}
            renderRow={renderRow}
            renderSkeletonRow={skeleton}
            skeletonRows={50}
            columnCount={1}
            loadingMore={loadingMore}
            hasMore={hasMore}
            errorContent="Error"
            emptyContent="Empty"
          />,
        ),
      );
    const nodes = () =>
      Array.from(container.querySelectorAll("tr[data-skeleton-motion]"));
    try {
      render(rows, false);
      const initial = nodes();
      expect(initial).toHaveLength(50);
      expect(renderSkeletonRow).toHaveBeenCalledTimes(50);
      render(rows, true);
      expect(nodes()).toEqual(initial);
      render(appended, false);
      expect(nodes()).toEqual(initial);
      expect(renderSkeletonRow).toHaveBeenCalledTimes(50);
      expect(
        container.querySelectorAll("tr[data-analytics-row-enter]"),
      ).toHaveLength(2);
      render(appended, false, true, changed);
      expect(changed).toHaveBeenCalledTimes(50);
      expect(nodes()[0]?.textContent).toBe("New column");
      render(appended, false, false, changed);
      expect(nodes()).toHaveLength(0);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("leaves loaded tables free of skeleton markers", () => {
    const html = renderTable(false, false);
    expect(html).not.toContain("data-skeleton-motion");
    expect(html).toContain("data-analytics-row-enter");
    expect(html).toContain("--analytics-data-row-delay:0ms");
    expect(html).not.toMatch(
      /<tr[^>]*data-analytics-row-enter[^>]*style="[^"]*opacity/,
    );
  });
});
