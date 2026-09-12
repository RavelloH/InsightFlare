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

type DashboardComparisonRequest = NonNullable<
  DashboardListRequestOptions["comparison"]
>;

function normalizedPagination(
  value: unknown,
  itemCount: number,
): PaginationMeta {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pagination_contract_violation");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = ["limit", "returned", "hasMore", "nextCursor"];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in record))
  ) {
    throw new Error("pagination_contract_violation");
  }
  if (
    typeof record.limit !== "number" ||
    !Number.isSafeInteger(record.limit) ||
    record.limit < 1 ||
    typeof record.returned !== "number" ||
    !Number.isSafeInteger(record.returned) ||
    record.returned < 0 ||
    record.returned !== itemCount ||
    typeof record.hasMore !== "boolean" ||
    (record.nextCursor !== null && typeof record.nextCursor !== "string") ||
    record.hasMore !== (record.nextCursor !== null)
  ) {
    throw new Error("pagination_contract_violation");
  }
  return {
    limit: record.limit,
    returned: record.returned,
    hasMore: record.hasMore,
    nextCursor: record.nextCursor,
  };
}

/** Normalize collection responses at the HTTP boundary before pagination code reads them. */
export function normalizePaginatedCollection<T>(
  value: unknown,
): PaginatedCollection<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pagination_contract_violation");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !("items" in record) ||
    !("pagination" in record) ||
    !Array.isArray(record.items)
  ) {
    throw new Error("pagination_contract_violation");
  }
  const items = record.items as T[];
  return {
    items,
    pagination: normalizedPagination(record.pagination, items.length),
  };
}

export function normalizeOverviewRows(
  rows:
    | OverviewTabData["data"]["items"]
    | Array<Record<string, unknown>>
    | undefined,
): OverviewTabRows {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    const normalized: OverviewTabRows[number] = {
      ...(typeof record.key === "string" ? { key: record.key } : {}),
      ...(typeof record.value === "string" ? { value: record.value } : {}),
      label:
        String(record.label ?? "").trim() || String(record.value ?? "").trim(),
      views: Number(record.views ?? 0),
      sessions: Number(record.sessions ?? 0),
      visitors: Number(record.visitors ?? 0),
    };
    if (record.reference && typeof record.reference === "object") {
      const reference = record.reference as Record<string, unknown>;
      normalized.reference = {
        views: Number(reference.views ?? 0),
        sessions: Number(reference.sessions ?? 0),
        visitors: Number(reference.visitors ?? 0),
      };
    }
    if (record.change && typeof record.change === "object") {
      const change = record.change as Record<string, unknown>;
      const metricChange = (value: unknown) => {
        const item = value as Record<string, unknown> | null;
        return {
          absolute: Number(item?.absolute ?? 0),
          relative:
            item?.relative === null || item?.relative === undefined
              ? null
              : Number(item.relative),
        };
      };
      normalized.change = {
        views: metricChange(change.views),
        sessions: metricChange(change.sessions),
        visitors: metricChange(change.visitors),
      };
    }
    return normalized;
  });
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

/** Add the dashboard comparison state without changing the current filter. */
export function withComparison(
  params: PrivateRequestParams,
  comparison?: DashboardComparisonRequest | null,
  options?: {
    metric?: "views" | "visitors";
    sortBy?: "current" | "reference" | "change";
  },
): PrivateRequestParams {
  const next = { ...params };
  const cleanParams = Object.fromEntries(
    Object.entries(next).filter(([key]) => !key.startsWith("compareFilter[")),
  ) as PrivateRequestParams;
  if (!comparison) return cleanParams;
  cleanParams.compare = comparison.mode;
  if (options?.metric) cleanParams.metric = options.metric;
  if (options?.sortBy) cleanParams.sortBy = options.sortBy;
  for (const [key, value] of serializeFilterParams(
    comparison.filters,
    analyticsFilterRegistry,
  )) {
    cleanParams[`compareFilter${key.slice("filter".length)}`] = value;
  }
  return cleanParams;
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
