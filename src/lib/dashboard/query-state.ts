export type RangePreset = "24h" | "7d" | "30d" | "90d";

export interface TimeWindow {
  preset: RangePreset;
  from: number;
  to: number;
  interval: "hour" | "day";
}

export interface DashboardFilters {
  country?: string;
  device?: string;
  browser?: string;
  eventType?: string;
}

const RANGE_PRESETS: readonly RangePreset[] = ["24h", "7d", "30d", "90d"] as const;

function normalizeFilterValue(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : undefined;
}

export function resolveRangePreset(value: string | null | undefined): RangePreset {
  if (!value) return "7d";
  if (RANGE_PRESETS.includes(value as RangePreset)) return value as RangePreset;
  return "7d";
}

export function resolveTimeWindow(range: string | null | undefined, now = Date.now()): TimeWindow {
  const preset = resolveRangePreset(range);
  const to = now;

  if (preset === "24h") {
    return {
      preset,
      from: now - 24 * 60 * 60 * 1000,
      to,
      interval: "hour",
    };
  }

  if (preset === "30d") {
    return {
      preset,
      from: now - 30 * 24 * 60 * 60 * 1000,
      to,
      interval: "day",
    };
  }

  if (preset === "90d") {
    return {
      preset,
      from: now - 90 * 24 * 60 * 60 * 1000,
      to,
      interval: "day",
    };
  }

  return {
    preset: "7d",
    from: now - 7 * 24 * 60 * 60 * 1000,
    to,
    interval: "day",
  };
}

export function parseDashboardFiltersFromSearchParams(searchParams: URLSearchParams): DashboardFilters {
  return {
    country: normalizeFilterValue(searchParams.get("country")),
    device: normalizeFilterValue(searchParams.get("device")),
    browser: normalizeFilterValue(searchParams.get("browser")),
    eventType: normalizeFilterValue(searchParams.get("eventType")),
  };
}

function applyFiltersToParams(params: URLSearchParams, filters?: DashboardFilters): URLSearchParams {
  if (!filters) return params;
  if (filters.country) params.set("country", filters.country);
  if (filters.device) params.set("device", filters.device);
  if (filters.browser) params.set("browser", filters.browser);
  if (filters.eventType) params.set("eventType", filters.eventType);
  return params;
}

export function withRangeAndFilters(pathname: string, range: RangePreset, filters?: DashboardFilters): string {
  const params = applyFiltersToParams(new URLSearchParams(), filters);
  params.set("range", range);
  return `${pathname}?${params.toString()}`;
}
