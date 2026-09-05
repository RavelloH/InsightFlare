import type {
  DashboardFilterOptionKey,
  DashboardListRequestOptions,
  OverviewClientDimensionTab,
  OverviewPageCardTab,
  OverviewSourceCardTab,
} from "@/lib/dashboard/client-data-types";
import {
  emptyDashboardFilterOptions,
  emptyOverviewTab,
} from "@/lib/dashboard/client-empty-data";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  DashboardFilterOptionsData,
  OverviewTabData,
} from "@/lib/edge-client";
import type { FilterDocument, FilterScope } from "@/lib/filter-contract";

import { fetchPrivateJson } from "./client-request";
import {
  decodeHashLabel,
  decodeQueryLabel,
  normalizeOverviewRows,
  normalizePaginatedCollection,
  withFilters,
  withPagination,
} from "./client-utils";

const clientPathByTab: Record<OverviewClientDimensionTab, string> = {
  browser: "browser",
  osVersion: "os-version",
  deviceType: "device-type",
  language: "language",
  screenSize: "screen-size",
};

function emptyOverviewTabUnlessAborted(error: unknown): OverviewTabData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyOverviewTab();
}

export async function fetchOverviewPageCardTab(
  siteId: string,
  window: TimeWindow,
  tab: OverviewPageCardTab,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
    resolvedScope?: FilterScope;
  },
): Promise<OverviewTabData["data"]> {
  const endpoint =
    tab === "query"
      ? "/api/private/page-query"
      : `/api/private/overview-page-${tab}`;
  const payload = await fetchPrivateJson<OverviewTabData>(
    endpoint,
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
        },
        options,
        100,
      ),
      filters,
      options?.resolvedScope,
    ),
    { signal: options?.signal },
  ).catch(emptyOverviewTabUnlessAborted);
  const data = normalizePaginatedCollection<
    OverviewTabData["data"]["items"][number]
  >(payload.data);
  const items = normalizeOverviewRows(data.items);
  return {
    ...data,
    items:
      tab === "query"
        ? items.map((row) => ({
            ...row,
            label: decodeQueryLabel(row.label),
          }))
        : items,
  };
}

export async function fetchPageHashTab(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: DashboardListRequestOptions,
): Promise<OverviewTabData["data"]> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    "/api/private/page-hash",
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
        },
        options,
        100,
      ),
      filters,
    ),
    { signal: options?.signal },
  ).catch(emptyOverviewTabUnlessAborted);
  const data = normalizePaginatedCollection<
    OverviewTabData["data"]["items"][number]
  >(payload.data);
  return {
    ...data,
    items: normalizeOverviewRows(data.items).map((row) => ({
      ...row,
      label: decodeHashLabel(row.label),
    })),
  };
}

export async function fetchPageQueryTab(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
    resolvedScope?: FilterScope;
  },
): Promise<OverviewTabData["data"]> {
  return fetchOverviewPageCardTab(siteId, window, "query", filters, options);
}

export async function fetchOverviewSourceCardTab(
  siteId: string,
  window: TimeWindow,
  tab: OverviewSourceCardTab,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    search?: string;
    sort?: "views" | "visitors";
    direction?: "asc" | "desc";
    signal?: AbortSignal;
    resolvedScope?: FilterScope;
  },
): Promise<OverviewTabData["data"]> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    `/api/private/overview-source-${tab}`,
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
          ...(options?.search?.trim() ? { search: options.search.trim() } : {}),
          ...(options?.sort ? { sort: options.sort } : {}),
          ...(options?.direction ? { direction: options.direction } : {}),
        },
        options,
        100,
      ),
      filters,
      options?.resolvedScope,
    ),
    { signal: options?.signal },
  ).catch(emptyOverviewTabUnlessAborted);
  const data = normalizePaginatedCollection<
    OverviewTabData["data"]["items"][number]
  >(payload.data);
  return { ...data, items: normalizeOverviewRows(data.items) };
}

export async function fetchEventTypesTab(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  },
): Promise<OverviewTabData["data"]> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    "/api/private/event-types",
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
        },
        options,
        100,
      ),
      filters,
    ),
    { signal: options?.signal },
  ).catch(emptyOverviewTabUnlessAborted);
  const data = normalizePaginatedCollection<
    OverviewTabData["data"]["items"][number]
  >(payload.data);
  return { ...data, items: normalizeOverviewRows(data.items) };
}

export async function fetchOverviewClientDimensionTab(
  siteId: string,
  window: TimeWindow,
  tab: OverviewClientDimensionTab,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
    resolvedScope?: FilterScope;
  },
): Promise<OverviewTabData["data"]> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    `/api/private/overview-client-${clientPathByTab[tab]}`,
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
        },
        options,
        100,
      ),
      filters,
      options?.resolvedScope,
    ),
    { signal: options?.signal },
  ).catch(emptyOverviewTabUnlessAborted);
  const data = normalizePaginatedCollection<
    OverviewTabData["data"]["items"][number]
  >(payload.data);
  return { ...data, items: normalizeOverviewRows(data.items) };
}

export async function fetchFilterValues(
  siteId: string,
  window: TimeWindow,
  filterKey: DashboardFilterOptionKey,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    search?: string;
    signal?: AbortSignal;
    resolvedScope?: FilterScope;
  },
): Promise<DashboardFilterOptionsData["data"]> {
  const payload = await fetchPrivateJson<DashboardFilterOptionsData>(
    "/api/private/filter-values",
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
          filterKey,
          ...(options?.search?.trim() ? { search: options.search.trim() } : {}),
        },
        options,
        200,
      ),
      filters,
      options?.resolvedScope,
    ),
    { signal: options?.signal },
  ).catch(() => emptyDashboardFilterOptions());
  return normalizePaginatedCollection<
    DashboardFilterOptionsData["data"]["items"][number]
  >(payload.data);
}
