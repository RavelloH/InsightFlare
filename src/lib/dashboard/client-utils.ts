import type { PrivateRequestParams } from "@/lib/dashboard/client-data-types";
import type { OverviewTabData } from "@/lib/edge-client";
import {
  analyticsFilterRegistry,
  type FilterDocument,
  type FilterScope,
  filterScopePreferenceFromDocument,
  serializeFilterParams,
  serializeFilterScopePreference,
} from "@/lib/filter-contract";

import type { OverviewTabRows } from "./client-data-types";

export function normalizeOverviewRows(
  rows: OverviewTabData["data"] | Array<Record<string, unknown>> | undefined,
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

export function toQueryString(params?: PrivateRequestParams): string {
  if (!params) return "";
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded.length > 0 ? `?${encoded}` : "";
}
