import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import type { TimeWindow } from "@/lib/dashboard/query-state";
import { requestAdminService } from "@/lib/dashboard-api/client/admin-service";

import type { PerformanceResponse } from "./model";
import {
  performanceRequestWindow,
  type PerformanceState,
} from "./performance-url-state";

export const PERFORMANCE_QUERY_ROOT = ["admin", "system-performance"] as const;

type Params = Record<string, string | number>;

/** Window and filter params shared by every invocation view. */
export function useBaseParams(
  timeWindow: TimeWindow,
  state: Pick<PerformanceState, "source" | "routeKey" | "appVersion">,
): Params {
  const { from, to, interval, timeZone } = timeWindow;
  return useMemo(() => {
    const window = performanceRequestWindow({ from, to, interval, timeZone });
    return {
      from: window.from,
      to: window.to,
      interval: window.interval,
      timeZone: window.timeZone,
      source: state.source,
      ...(state.routeKey ? { routeKey: state.routeKey } : {}),
      ...(state.appVersion ? { appVersion: state.appVersion } : {}),
    };
  }, [
    from,
    to,
    interval,
    timeZone,
    state.source,
    state.routeKey,
    state.appVersion,
  ]);
}

export function usePerformanceView<T>(
  view: "overview" | "routes" | "hotspots" | "errors" | "samples",
  params: Params,
  enabled = true,
) {
  return useQuery({
    queryKey: [...PERFORMANCE_QUERY_ROOT, view, params],
    queryFn: ({ signal }) =>
      requestAdminService<PerformanceResponse<T>>("system-performance", {
        params: { view, ...params },
        signal,
      }),
    enabled: typeof window !== "undefined" && enabled,
    staleTime: 30_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
