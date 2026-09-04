import type {
  DashboardListRequestOptions,
  PrivateRequestParams,
} from "@/lib/dashboard/client-data-types";
import type {
  OverviewTabData,
  PaginatedCollection,
  PaginationMeta,
} from "@/lib/edge-client";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  type FilterScope,
  filterScopePreferenceFromDocument,
  serializeFilterParams,
  serializeFilterScopePreference,
} from "@/lib/filter-contract";

import type { OverviewTabRows } from "./client-data-types";

function normalizedPagination(
  value: unknown,
  fallbackLimit: number,
  itemCount: number,
): PaginationMeta {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const limit =
    typeof record.limit === "number" && Number.isFinite(record.limit)
      ? record.limit
      : fallbackLimit;
  const returned =
    typeof record.returned === "number" && Number.isFinite(record.returned)
      ? record.returned
      : itemCount;
  return {
    limit,
    returned,
    hasMore: record.hasMore === true,
    nextCursor:
      typeof record.nextCursor === "string" ? record.nextCursor : null,
  };
}

/** Normalize collection responses at the HTTP boundary before pagination code reads them. */
export function normalizePaginatedCollection<T>(
  value: unknown,
  fallbackLimit = 0,
): PaginatedCollection<T> {
  if (Array.isArray(value)) {
    return {
      items: value as T[],
      pagination: normalizedPagination(undefined, fallbackLimit, value.length),
    };
  }
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const items = Array.isArray(record.items) ? (record.items as T[]) : [];
  return {
    items,
    pagination: normalizedPagination(
      record.pagination,
      fallbackLimit,
      items.length,
    ),
  };
}

export function normalizeOverviewRows(
  rows:
    | OverviewTabData["data"]["items"]
    | Array<Record<string, unknown>>
    | undefined,
): OverviewTabRows {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    label:
      String((row as { label?: unknown }).label ?? "").trim() ||
      String((row as { value?: unknown }).value ?? "").trim(),
    views: Number((row as { views?: unknown }).views ?? 0),
    sessions: Number((row as { sessions?: unknown }).sessions ?? 0),
    visitors: Number((row as { visitors?: unknown }).visitors ?? 0),
  }));
}

export function decodeHashLabel(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";

  const prefixed = normalized.startsWith("#") ? normalized : `#${normalized}`;
  const encodedFragment = prefixed.slice(1);
  if (!encodedFragment) return "";

  try {
    return `#${decodeURIComponent(encodedFragment)}`;
  } catch {
    return prefixed;
  }
}

export function decodeQueryLabel(value: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) return "";

  const prefixed = normalized.startsWith("?") ? normalized : `?${normalized}`;
  const encodedQuery = prefixed.slice(1);
  if (!encodedQuery) return "";

  try {
    return `?${decodeURIComponent(encodedQuery)}`;
  } catch {
    return prefixed;
  }
}

export function withFilters(
  params: PrivateRequestParams,
  filters?: FilterDocument,
  resolvedScope?: FilterScope,
): PrivateRequestParams {
  const next = { ...params };
  delete next.scope;
  const scopePreference =
    resolvedScope ??
    (filters?.root ? filterScopePreferenceFromDocument(filters) : undefined);
  if (scopePreference) {
    const scopeParams = serializeFilterScopePreference(
      new URLSearchParams(),
      scopePreference,
    );
    const scope = scopeParams.get("scope");
    if (scope) next.scope = scope;
  }
  if (!filters) return next;
  for (const [key, value] of serializeFilterParams(
    filters,
    analyticsFilterRegistry,
  )) {
    next[key] = value;
  }
  return next;
}

export function withPagination(
  params: PrivateRequestParams,
  options?: DashboardListRequestOptions,
  defaultLimit?: number,
): PrivateRequestParams {
  return {
    ...params,
    ...(options?.limit !== undefined
      ? { limit: options.limit }
      : defaultLimit !== undefined
        ? { limit: defaultLimit }
        : {}),
    ...(options?.cursor ? { cursor: options.cursor } : {}),
  };
}

export function toQueryString(params?: PrivateRequestParams): string {
  if (!params) return "";
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}
