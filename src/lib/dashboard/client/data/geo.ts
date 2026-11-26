import { parseGeoLocationValue } from "@/lib/analytics/geo-location";
import {
  emptyOverviewGeoPoints,
  emptyOverviewGeoTab,
} from "@/lib/dashboard/client/data/empty";
import type {
  DashboardListRequestOptions,
  OverviewGeoDimensionTab,
  OverviewGeoTabRows,
  PrivateReadTransport,
} from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import {
  normalizePaginatedCollection,
  withComparison,
  withFilters,
} from "@/lib/dashboard/client/utils";
import {
  type DashboardComparisonQuery,
  resolveDashboardComparisonQuery,
} from "@/lib/dashboard/comparison-query";
import { setDashboardFilterValue } from "@/lib/dashboard/filter-state";
import {
  parseFilterDocumentFromSearchParams,
  type TimeWindow,
} from "@/lib/dashboard/query-state";
import type {
  OverviewGeoPointsData,
  OverviewGeoTabData,
} from "@/lib/dashboard-api/client/edge";
import {
  attachFilterScopePreference,
  type FilterDocument,
  type FilterScope,
  filterScopePreferenceFromDocument,
} from "@/lib/filter-contract";
function emptyGeoPointsUnlessAborted(error: unknown): OverviewGeoPointsData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyOverviewGeoPoints();
}
function emptyGeoTabUnlessAborted(error: unknown): OverviewGeoTabData {
  if (error instanceof Error && error.name === "AbortError") throw error;
  return emptyOverviewGeoTab();
}
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
export function overviewGeoPointsFilters(
  filters: FilterDocument,
): FilterDocument {
  return attachFilterScopePreference(
    {
      ...filters,
      country: undefined,
      geo: undefined,
      geoContinent: undefined,
      geoTimezone: undefined,
      geoOrganization: undefined,
    } as FilterDocument,
    filterScopePreferenceFromDocument(filters) ?? "auto",
  );
}
export async function fetchOverviewGeoPoints(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: DashboardListRequestOptions & {
    applyGeoFilter?: boolean;
    resolvedScope?: FilterScope;
  },
): Promise<OverviewGeoPointsData> {
  return fetchPrivateJson<OverviewGeoPointsData>(
    "/api/private/overview-geo-points",
    withComparison(
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
        options?.resolvedScope,
      ),
      options?.comparison,
      {
        metric: options?.comparisonMetric,
        sortBy: options?.comparisonSortBy,
      },
    ),
    { signal: options?.signal, transport: options?.transport },
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
    .catch(emptyGeoPointsUnlessAborted);
}
export async function fetchOverviewGeoDimensionTab(
  siteId: string,
  window: TimeWindow,
  tab: OverviewGeoDimensionTab,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    signal?: AbortSignal;
    transport?: PrivateReadTransport;
    resolvedScope?: FilterScope;
    comparison?: DashboardListRequestOptions["comparison"];
    comparisonMetric?: DashboardListRequestOptions["comparisonMetric"];
    comparisonSortBy?: DashboardListRequestOptions["comparisonSortBy"];
  },
): Promise<OverviewGeoTabRows> {
  const page = await fetchOverviewGeoDimensionTabPage(
    siteId,
    window,
    tab,
    filters,
    options,
  );
  return page.items as unknown as OverviewGeoTabRows;
}
/** Paginated form used by TabbedDataTableCard loaders. */
export async function fetchOverviewGeoDimensionTabPage(
  siteId: string,
  window: TimeWindow,
  tab: OverviewGeoDimensionTab,
  filters?: FilterDocument,
  options?: DashboardListRequestOptions & { resolvedScope?: FilterScope },
): Promise<OverviewGeoTabData["data"]> {
  const payload = await fetchPrivateJson<OverviewGeoTabData>(
    `/api/private/overview-geo-${tab}`,
    withComparison(
      withFilters(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
          limit: options?.limit ?? 100,
          ...(options?.cursor ? { cursor: options.cursor } : {}),
          ...(options?.search?.trim() ? { search: options.search.trim() } : {}),
          ...(options?.sort ? { sort: options.sort } : {}),
          ...(options?.direction ? { direction: options.direction } : {}),
        },
        filters,
        options?.resolvedScope,
      ),
      options?.comparison,
      {
        metric: options?.comparisonMetric,
        sortBy: options?.comparisonSortBy,
      },
    ),
    {
      signal: options?.signal,
      batchOverview: options?.batchOverview,
      transport: options?.transport,
    },
  ).catch(emptyGeoTabUnlessAborted);
  const rows = normalizePaginatedCollection<
    OverviewGeoTabData["data"]["items"][number]
  >(payload.data);
  return {
    ...rows,
    items: rows.items.map((row) => ({
      ...row,
      value:
        String((row as { value?: unknown }).value ?? "").trim() ||
        String((row as { label?: unknown }).label ?? "").trim(),
      label: normalizeGeoDimensionLabel(
        tab,
        row as unknown as Record<string, unknown>,
      ),
      views: Number((row as { views?: unknown }).views ?? 0),
      sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
      visitors: Number((row as { visitors?: unknown }).visitors ?? 0),
    })) as OverviewGeoTabRows,
  };
}

/** A geographic drill-down replaces only the geographic control, in both periods. */
export function resolveGeoPageRequest(
  filters: FilterDocument,
  comparison: DashboardComparisonQuery | null,
  locationValue: string | null,
) {
  const location = parseGeoLocationValue(locationValue);
  const applyLocation = (document: FilterDocument) =>
    location
      ? setDashboardFilterValue(document, "geo", location.canonical)
      : document;
  const statsTab: OverviewGeoDimensionTab = location
    ? location.level === "country"
      ? "region"
      : "city"
    : "country";
  return {
    location,
    filters: applyLocation(filters),
    statsTab,
    comparison: comparison
      ? { ...comparison, filters: applyLocation(comparison.filters) }
      : null,
  };
}
export const GEO_PAGE_POINT_LIMIT = 5000;
export function geoPageStatsLimit(tab: OverviewGeoDimensionTab) {
  return tab === "city" ? 600 : 400;
}
export function startGeoInitialReads(
  siteId: string,
  window: TimeWindow,
  search: URLSearchParams,
  transport: PrivateReadTransport,
): void {
  const document = parseFilterDocumentFromSearchParams(search);
  const filters = document.root
    ? document
    : attachFilterScopePreference(document, "auto");
  const request = resolveGeoPageRequest(
    filters,
    resolveDashboardComparisonQuery(search, window, filters),
    search.get("location"),
  );
  void fetchOverviewGeoPoints(siteId, window, request.filters, {
    limit: GEO_PAGE_POINT_LIMIT,
    applyGeoFilter: Boolean(request.location),
    transport,
  }).catch(() => undefined);
  void fetchOverviewGeoDimensionTab(
    siteId,
    window,
    request.statsTab,
    request.filters,
    {
      limit: geoPageStatsLimit(request.statsTab),
      comparison: request.comparison,
      comparisonMetric: "views",
      comparisonSortBy: "current",
      transport,
    },
  ).catch(() => undefined);
}
