"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import {
  parseDashboardFiltersFromSearchParams,
  resolveRangePreset,
  resolveTimeWindow,
} from "@/lib/dashboard/query-state";

export function useDashboardQuery() {
  const searchParams = useSearchParams();
  const range = resolveRangePreset(searchParams.get("range"));

  const filters = useMemo(
    () => parseDashboardFiltersFromSearchParams(searchParams),
    [searchParams],
  );

  const window = useMemo(
    () => resolveTimeWindow(range),
    [range],
  );

  return {
    range,
    filters,
    window,
  };
}
