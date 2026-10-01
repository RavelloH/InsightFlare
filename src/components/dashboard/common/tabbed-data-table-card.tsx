import { memo } from "react";
import type { TabbedDataTableCardProps } from "@insightflare/product-ui/tabbed-table";
import {
  TabbedDataTableCardDataController,
  type TabbedDataTablePage,
  type TabbedDataTableQueryOptions,
  type TabbedDataTableRowBase,
} from "@insightflare/product-ui/tabbed-table";
import {
  type InfiniteData,
  type QueryKey,
  useInfiniteQuery,
} from "@tanstack/react-query";

export type * from "@insightflare/product-ui/tabbed-table";

function useDashboardTableQuery<TRow extends TabbedDataTableRowBase>(
  options: TabbedDataTableQueryOptions<TRow>,
) {
  return useInfiniteQuery<
    TabbedDataTablePage<TRow>,
    Error,
    InfiniteData<TabbedDataTablePage<TRow>, string | null>,
    QueryKey,
    string | null
  >({
    queryKey: options.queryKey,
    queryFn: ({ pageParam, signal }) => options.queryFn({ pageParam, signal }),
    initialPageParam: options.initialPageParam,
    getNextPageParam: options.getNextPageParam,
    placeholderData: options.placeholderData,
    enabled: options.enabled,
  });
}

function TabbedDataTableCardImpl<
  TTab extends string,
  TRow extends TabbedDataTableRowBase,
  TKey extends string = string,
>(props: TabbedDataTableCardProps<TTab, TRow, TKey>) {
  return (
    <TabbedDataTableCardDataController
      {...props}
      useDataQuery={useDashboardTableQuery}
    />
  );
}

export const TabbedDataTableCard = memo(
  TabbedDataTableCardImpl,
) as typeof TabbedDataTableCardImpl;
