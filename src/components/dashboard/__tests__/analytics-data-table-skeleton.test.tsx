import { renderToStaticMarkup } from "react-dom/server";
import { AnalyticsDataTable } from "@insightflare/product-ui/tables";
import { Skeleton } from "@insightflare/ui/skeleton";
import { describe, expect, it } from "vitest";

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
