import {
  fetchOverviewGeoDimensionTabPage,
  overviewGeoPointsFilters,
  requestOverviewGeoPoints,
} from "@/lib/dashboard/client/data/geo";
import {
  fetchOverviewClientDimensionTab,
  fetchOverviewPageCardTab,
  fetchOverviewSourceCardTab,
} from "@/lib/dashboard/client/data/tabs";
import type { PrivateReadTransport } from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import { withFilters, withPagination } from "@/lib/dashboard/client/utils";
import { resolveDashboardComparisonQuery } from "@/lib/dashboard/comparison-query";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  OverviewData,
  PagesData,
  TrendData,
} from "@/lib/dashboard-api/client/edge";
import { resolveFilterScope } from "@/lib/edge/analytics/contract/scoped-filter";
import type { FilterDocument } from "@/lib/filter-contract";
import {
  analyticsFilterRegistry,
  attachFilterScopePreference,
  parseFilterParams,
  parseFilterScopePreference,
} from "@/lib/filter-contract";
export async function fetchOverview(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    transport?: PrivateReadTransport;
    includeChange?: boolean;
    includeDetail?: boolean;
    signal?: AbortSignal;
  },
): Promise<OverviewData> {
  return fetchPrivateJson<OverviewData>(
    "/api/private/overview",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        ...(options?.includeChange ? { includeChange: 1 } : {}),
        ...(options?.includeDetail
          ? { includeDetail: 1, interval: window.interval }
          : {}),
      },
      filters,
    ),
    { signal: options?.signal, transport: options?.transport },
  );
}
export async function fetchTrend(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal; transport?: PrivateReadTransport },
): Promise<TrendData> {
  return fetchPrivateJson<TrendData>(
    "/api/private/trend",
    withFilters(
      {
        siteId,
        from: window.from,
        to: window.to,
        timeZone: window.timeZone,
        interval: window.interval,
      },
      filters,
    ),
    { signal: options?.signal, transport: options?.transport },
  );
}
export async function fetchPages(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    limit?: number;
    cursor?: string | null;
    signal?: AbortSignal;
  },
): Promise<PagesData> {
  return fetchPrivateJson<PagesData>(
    "/api/private/pages",
    withFilters(
      withPagination(
        {
          siteId,
          from: window.from,
          to: window.to,
          timeZone: window.timeZone,
          details: 1,
        },
        options,
        100,
      ),
      filters,
    ),
    { signal: options?.signal },
  );
}

/** The initial visible tabs use the same builders as CSR, including pagination
 * and the separate country/geo filtering semantics. Nothing waits for unrelated
 * cards. Only the existing private batch allowlist runs in the shared scope. */
export function startOverviewInitialReads(
  siteId: string,
  window: TimeWindow,
  search: URLSearchParams,
  transport: PrivateReadTransport,
  runBatch: (action: () => Promise<unknown>) => Promise<unknown>,
): void {
  const document = parseFilterParams(search, analyticsFilterRegistry);
  const preference = document.root
    ? parseFilterScopePreference(search)
    : "auto";
  const scope = resolveFilterScope("overview", preference) ?? undefined;
  const filters = attachFilterScopePreference(document, scope ?? "auto");
  const comparison = resolveDashboardComparisonQuery(search, window, filters);
  const options = {
    transport,
    limit: 100,
    sort: "views" as const,
    direction: "desc" as const,
    resolvedScope: scope,
    comparison,
    comparisonMetric: comparison ? ("views" as const) : undefined,
    comparisonSortBy: comparison ? ("current" as const) : undefined,
  };
  const ignore = (promise: Promise<unknown>) => {
    void promise.catch(() => undefined);
  };
  ignore(
    fetchOverview(siteId, window, filters, {
      transport,
      includeChange: !comparison,
      includeDetail: true,
    }),
  );
  if (comparison) {
    ignore(
      fetchOverview(siteId, comparison.window, comparison.filters, {
        transport,
        includeDetail: true,
      }),
    );
  }
  ignore(
    fetchOverviewSourceCardTab(siteId, window, "domain", filters, options),
  );
  ignore(
    requestOverviewGeoPoints<unknown>(
      siteId,
      window,
      overviewGeoPointsFilters(filters),
      {
        transport,
        limit: 5000,
        resolvedScope: scope,
      },
    ),
  );
  const dimensions = () =>
    Promise.allSettled([
      fetchOverviewPageCardTab(siteId, window, "path", filters, options),
      fetchOverviewClientDimensionTab(
        siteId,
        window,
        "browser",
        filters,
        options,
      ),
      fetchOverviewGeoDimensionTabPage(
        siteId,
        window,
        "country",
        filters,
        options,
      ),
    ]);
  // Comparisons retain independent reads, just like the existing client.
  ignore(comparison ? dimensions() : runBatch(dimensions));
}
