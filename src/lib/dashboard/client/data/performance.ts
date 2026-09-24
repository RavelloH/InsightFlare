import { emptyPerformance } from "@/lib/dashboard/client/data/empty";
import type { RetentionGranularity } from "@/lib/dashboard/client/data/types";
import { fetchPrivateJson } from "@/lib/dashboard/client/request";
import { withFilters } from "@/lib/dashboard/client/utils";
import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  PerformanceData,
  RetentionData,
} from "@/lib/dashboard-api/client/edge";
import type { FilterDocument } from "@/lib/filter-contract";
function fallbackUnlessAborted<T>(error: unknown, fallback: () => T): T {
  if (error instanceof Error && error.name === "AbortError") throw error;
  if (
    error instanceof Error &&
    (error.message === "pagination_contract_violation" ||
      error.message === "events_trend_contract_violation")
  ) {
    throw error;
  }
  return fallback();
}
export async function fetchPerformance(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: { signal?: AbortSignal },
): Promise<PerformanceData> {
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
      interval: window.interval,
    },
    filters,
  );
  const request = options?.signal
    ? fetchPrivateJson<PerformanceData>(
        "/api/private/performance",
        requestParams,
        { signal: options.signal },
      )
    : fetchPrivateJson<PerformanceData>(
        "/api/private/performance",
        requestParams,
      );
  return request.catch((error) =>
    fallbackUnlessAborted(error, () => emptyPerformance(window.interval)),
  );
}
export async function fetchRetention(
  siteId: string,
  window: TimeWindow,
  filters?: FilterDocument,
  options?: {
    granularity?: RetentionGranularity;
    signal?: AbortSignal;
  },
): Promise<RetentionData> {
  const granularity = options?.granularity ?? "week";
  const requestParams = withFilters(
    {
      siteId,
      from: window.from,
      to: window.to,
      timeZone: window.timeZone,
      granularity,
    },
    filters,
  );
  return options?.signal
    ? fetchPrivateJson<RetentionData>("/api/private/retention", requestParams, {
        signal: options.signal,
      })
    : fetchPrivateJson<RetentionData>("/api/private/retention", requestParams);
}
