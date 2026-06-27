import type {
  OverviewGeoDimensionTab,
  OverviewGeoTabRows,
} from "@/lib/dashboard/client-data-types";
import {
  emptyOverviewGeoPoints,
  emptyOverviewGeoTab,
} from "@/lib/dashboard/client-empty-data";
import type { DashboardFilters, TimeWindow } from "@/lib/dashboard/query-state";
import type {
  OverviewGeoPointsData,
  OverviewGeoTabData,
} from "@/lib/edge-client";

import { fetchPrivateJson } from "./client-request";
import { withFilters } from "./client-utils";

function normalizeGeoDimensionLabel(
  tab: OverviewGeoDimensionTab,
  row: Record<string, unknown>,
): string {
  const label = String(row.label ?? "").trim();
  const value = String(row.value ?? "").trim();
  const fallback = label || value;
  if (tab !== "region" && tab !== "city") return fallback;
  const segmentIndex = tab === "region" ? 2 : 3;
  return (
    fallback
      .split("::")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)[segmentIndex] || fallback
  );
}

export async function fetchOverviewGeoPoints(
  siteId: string,
  window: TimeWindow,
  filters?: DashboardFilters,
  options?: {
    limit?: number;
    applyGeoFilter?: boolean;
  },
): Promise<OverviewGeoPointsData> {
  return fetchPrivateJson<OverviewGeoPointsData>(
    "/api/private/overview-geo-points",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        limit: options?.limit ?? 5000,
        ...(options?.applyGeoFilter ? { applyGeoFilter: 1 } : {}),
      },
      filters,
    ),
  )
    .then((payload) => ({
      ok: payload.ok,
      data: Array.isArray(payload.data)
        ? payload.data.map((row) => ({
            latitude: Number((row as { latitude?: unknown }).latitude ?? 0),
            longitude: Number((row as { longitude?: unknown }).longitude ?? 0),
            timestampMs: Number(
              (row as { timestampMs?: unknown }).timestampMs ?? 0,
            ),
            country: String((row as { country?: unknown }).country ?? ""),
            region: String((row as { region?: unknown }).region ?? ""),
            regionCode: String(
              (row as { regionCode?: unknown }).regionCode ?? "",
            ),
            city: String((row as { city?: unknown }).city ?? ""),
            pointCount: Math.max(
              1,
              Number((row as { pointCount?: unknown }).pointCount ?? 1),
            ),
          }))
        : [],
      countryCounts: Array.isArray(payload.countryCounts)
        ? payload.countryCounts.map((row) => ({
            country: String((row as { country?: unknown }).country ?? ""),
            views: Number((row as { views?: unknown }).views ?? 0),
            sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
            visitors: Number((row as { visitors?: unknown }).visitors ?? 0),
          }))
        : [],
      regionCounts: Array.isArray(payload.regionCounts)
        ? payload.regionCounts.map((row) => ({
            value: String((row as { value?: unknown }).value ?? ""),
            label: String((row as { label?: unknown }).label ?? ""),
            views: Number((row as { views?: unknown }).views ?? 0),
            sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
            visitors: Number((row as { visitors?: unknown }).visitors ?? 0),
          }))
        : [],
      cityCounts: Array.isArray(payload.cityCounts)
        ? payload.cityCounts.map((row) => ({
            value: String((row as { value?: unknown }).value ?? ""),
            label: String((row as { label?: unknown }).label ?? ""),
            views: Number((row as { views?: unknown }).views ?? 0),
            sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
            visitors: Number((row as { visitors?: unknown }).visitors ?? 0),
          }))
        : [],
    }))
    .catch(() => emptyOverviewGeoPoints());
}

export async function fetchOverviewGeoDimensionTab(
  siteId: string,
  window: TimeWindow,
  tab: OverviewGeoDimensionTab,
  filters?: DashboardFilters,
  options?: {
    limit?: number;
  },
): Promise<OverviewGeoTabRows> {
  const payload = await fetchPrivateJson<OverviewGeoTabData>(
    `/api/private/overview-geo-${tab}`,
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
  ).catch(() => emptyOverviewGeoTab());
  return Array.isArray(payload.data)
    ? payload.data.map((row) => ({
        value:
          String((row as { value?: unknown }).value ?? "").trim() ||
          String((row as { label?: unknown }).label ?? "").trim(),
        label: normalizeGeoDimensionLabel(tab, row as Record<string, unknown>),
        views: Number((row as { views?: unknown }).views ?? 0),
        sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
        visitors: Number((row as { visitors?: unknown }).visitors ?? 0),
      }))
    : [];
}
