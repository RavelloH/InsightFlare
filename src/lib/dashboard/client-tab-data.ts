import type {
  DashboardFilterOptionData,
  DashboardFilterOptionKey,
  OverviewClientDimensionTab,
  OverviewPageCardTab,
  OverviewSourceCardTab,
  OverviewTabRows,
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
import type { FilterDocument } from "@/lib/filter-contract";

import { fetchPrivateJson } from "./client-request";
import {
  decodeHashLabel,
  decodeQueryLabel,
  normalizeOverviewRows,
  withFilters,
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
    signal?: AbortSignal;
  },
): Promise<OverviewTabRows> {
  const endpoint =
    tab === "query"
      ? "/api/private/page-query"
      : `/api/private/overview-page-${tab}`;
  const payload = await fetchPrivateJson<OverviewTabData>(
    endpoint,
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
    { signal: options?.signal },
  ).catch(emptyOverviewTabUnlessAborted);
  const rows = normalizeOverviewRows(payload.data);
  return tab === "query"
    ? rows.map((row) => ({
        ...row,
        label: decodeQueryLabel(row.label),
      }))
    : rows;
}

export async function fetchPageHashTab(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
  },
): Promise<OverviewTabRows> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    "/api/private/page-hash",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
  ).catch(() => emptyOverviewTab());
  return normalizeOverviewRows(payload.data).map((row) => ({
    ...row,
    label: decodeHashLabel(row.label),
  }));
}

export async function fetchPageQueryTab(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
  },
): Promise<OverviewTabRows> {
  return fetchOverviewPageCardTab(siteId, window, "query", filters, options);
}

export async function fetchOverviewSourceCardTab(
  siteId: string,
  window: TimeWindow,
  tab: OverviewSourceCardTab,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<OverviewTabRows> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    `/api/private/overview-source-${tab}`,
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
    { signal: options?.signal },
  ).catch(emptyOverviewTabUnlessAborted);
  return normalizeOverviewRows(payload.data);
}

export async function fetchEventTypesTab(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<OverviewTabRows> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    "/api/private/event-types",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
    { signal: options?.signal },
  ).catch(emptyOverviewTabUnlessAborted);
  return normalizeOverviewRows(payload.data);
}

export async function fetchOverviewClientDimensionTab(
  siteId: string,
  window: TimeWindow,
  tab: OverviewClientDimensionTab,
  filters?: FilterDocument,
  options?: {
    limit?: number;
  },
): Promise<OverviewTabRows> {
  const payload = await fetchPrivateJson<OverviewTabData>(
    `/api/private/overview-client-${clientPathByTab[tab]}`,
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: options?.limit ?? 100,
      },
      filters,
    ),
  ).catch(() => emptyOverviewTab());
  return normalizeOverviewRows(payload.data);
}

export async function fetchDashboardFilterOptions(
  siteId: string,
  window: TimeWindow,
  filterKey: DashboardFilterOptionKey,
  filters?: FilterDocument,
  options?: {
    limit?: number;
  },
): Promise<DashboardFilterOptionData[]> {
  const payload = await fetchPrivateJson<DashboardFilterOptionsData>(
    "/api/private/filter-options",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        filterKey,
        limit: options?.limit ?? 200,
      },
      filters,
    ),
  ).catch(() => emptyDashboardFilterOptions());
  return Array.isArray(payload.data) ? payload.data : [];
}
