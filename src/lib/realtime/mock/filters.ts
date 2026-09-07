// ---------------------------------------------------------------------------
//  Demo mock — filter / query-param parsing
//
//  All query-string parsing for /api/private and /api/public demo routes
//  flows through these helpers. Handlers call parseDemoFilters() to extract
//  user-selected dimension filters, plus parseDemoNumber / parseDemoLimit /
//  parseDemoBoolean / parseDemoInterval for primitive params.
// ---------------------------------------------------------------------------

import {
  dashboardFilterPresentation,
  withoutDashboardFilter,
} from "@/lib/dashboard/filter-state";
import type { QueryOperation } from "@/lib/edge/analytics/contract";
import {
  type FilterScope,
  normalizeFilterScopePreference,
  resolveFilterScope,
} from "@/lib/edge/analytics/contract/scoped-filter";
import {
  analyticsFilterRegistry,
  parseFilterParams,
} from "@/lib/filter-contract";
import { DEMO_GEO_SEGMENT_SEPARATOR } from "@/lib/realtime/mock/dimension-pools";
import type {
  DemoQueryFilters,
  ParsedDemoGeoFilter,
} from "@/lib/realtime/mock/types";

export const DEMO_DIRECT_REFERRER_FILTER_VALUE = "__direct__";
export const DEMO_INTERVALS = new Set([
  "minute",
  "hour",
  "day",
  "week",
  "month",
]);

export function normalizeDemoFilterValue(
  value: string | number | undefined,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim().slice(0, 120);
  if (normalized.length === 0) return undefined;
  const lowered = normalized.toLowerCase();
  if (lowered === "all" || lowered === "null" || lowered === "undefined") {
    return undefined;
  }
  return normalized;
}

export function parseDemoFilters(
  params: Record<string, string | number>,
): DemoQueryFilters {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith("filter[")) search.append(key, String(value));
  }
  const document = parseFilterParams(search, analyticsFilterRegistry);
  const presentation = dashboardFilterPresentation(document);
  const requestedScope = normalizeFilterScopePreference(params.scope);
  const explicitResolvedScope = normalizeDemoScope(params.resolvedScope);
  const operation =
    typeof params.operation === "string"
      ? (params.operation as QueryOperation)
      : undefined;
  const scope =
    explicitResolvedScope ??
    (operation
      ? (resolveFilterScope(operation, requestedScope) ?? undefined)
      : requestedScope === "auto"
        ? undefined
        : requestedScope);
  return {
    filterDocument: document,
    ...(scope ? { scope } : {}),
    ...presentation,
  };
}

function normalizeDemoScope(
  value: string | number | undefined,
): FilterScope | undefined {
  if (value === "event" || value === "session" || value === "visitor") {
    return value;
  }
  return undefined;
}

export function normalizeDemoSearch(
  params: Record<string, string | number>,
): string {
  return String(params.search ?? params.q ?? "")
    .trim()
    .toLowerCase();
}

export function demoValuesIncludeSearch(
  search: string,
  values: unknown[],
): boolean {
  if (!search) return true;
  return values.some((value) =>
    String(value ?? "")
      .trim()
      .toLowerCase()
      .includes(search),
  );
}

export function withoutDemoGeoFilter(
  filters: DemoQueryFilters,
): DemoQueryFilters {
  if (!filters.filterDocument) return { ...filters, geo: undefined };
  const filterDocument = withoutDashboardFilter(filters.filterDocument, "geo");
  return {
    filterDocument,
    ...dashboardFilterPresentation(filterDocument),
  };
}

export function parseDemoGeoFilterValue(
  value: string | undefined,
): ParsedDemoGeoFilter | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  const segments = normalized
    .split(DEMO_GEO_SEGMENT_SEPARATOR)
    .map((segment) => segment.trim());
  const country = (segments[0] || "").toUpperCase();
  if (!country) return null;

  if (segments.length === 1) {
    return { country };
  }
  if (segments.length === 2) {
    const city = segments[1] || "";
    return city ? { country, city } : { country };
  }

  const regionCode = segments[1] || "";
  const regionName = segments[2] || "";
  const city =
    segments.length >= 4
      ? segments.slice(3).join(DEMO_GEO_SEGMENT_SEPARATOR).trim()
      : "";

  return {
    country,
    ...(regionCode ? { regionCode } : {}),
    ...(regionName ? { regionName } : {}),
    ...(city ? { city } : {}),
  };
}

export function parseDemoNumber(
  value: string | number | undefined,
  fallback: number,
): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseDemoLimit(
  value: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Math.floor(parseDemoNumber(value, fallback));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/** Mirrors the real parseQueryLimit helper, including its minimum clamp. */
export function parseDemoQueryLimit(
  value: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (
    value === undefined ||
    (typeof value === "string" && value.length === 0)
  ) {
    return fallback;
  }
  const parsed = Math.floor(parseDemoNumber(value, fallback));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function parseDemoBoolean(value: string | number | undefined): boolean {
  if (typeof value === "number") return value === 1;
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function parseDemoInterval(
  value: string | number | undefined,
): "minute" | "hour" | "day" | "week" | "month" {
  const normalized = String(value ?? "day")
    .trim()
    .toLowerCase();
  if (DEMO_INTERVALS.has(normalized)) {
    return normalized as "minute" | "hour" | "day" | "week" | "month";
  }
  return "day";
}
