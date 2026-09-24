import type { FilterDocument } from "./filters";

export type FilterScope = "event" | "session" | "visitor";
export type FilterScopePreference = FilterScope | "auto";

const FILTER_SCOPE_PREFERENCE = Symbol("insightflare.filter-scope-preference");
const SAVED_FILTER_SCOPE_PREFERENCE = Symbol(
  "insightflare.saved-filter-scope-preference",
);

type ScopedFilterDocument = FilterDocument & {
  readonly [FILTER_SCOPE_PREFERENCE]?: FilterScopePreference;
  readonly [SAVED_FILTER_SCOPE_PREFERENCE]?: FilterScopePreference;
};

export function normalizeFilterScopePreference(
  value: unknown,
): FilterScopePreference {
  if (value === undefined || value === null || value === "") return "auto";
  if (
    value === "auto" ||
    value === "event" ||
    value === "session" ||
    value === "visitor"
  ) {
    return value;
  }
  throw new Error("invalid_filter_scope");
}

function scopeSearchParams(
  input: string | URL | URLSearchParams,
): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (input instanceof URL) return input.searchParams;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    return new URL(input).searchParams;
  }
  return new URLSearchParams(input.startsWith("?") ? input.slice(1) : input);
}

export function parseFilterScopePreference(
  input: string | URL | URLSearchParams,
  parameter = "scope",
): FilterScopePreference {
  return normalizeFilterScopePreference(
    scopeSearchParams(input).get(parameter),
  );
}

export function serializeFilterScopePreference(
  input: URLSearchParams,
  preference: FilterScopePreference,
  parameter = "scope",
): URLSearchParams {
  const result = new URLSearchParams(input);
  if (preference === "auto") result.delete(parameter);
  else result.set(parameter, preference);
  return result;
}

export function copyFilterScopePreferenceMetadata(
  source: FilterDocument,
  target: ScopedFilterDocument,
  skip?: "caller" | "saved",
): void {
  const sourceRecord = source as ScopedFilterDocument;
  const entries = [
    ["caller", FILTER_SCOPE_PREFERENCE],
    ["saved", SAVED_FILTER_SCOPE_PREFERENCE],
  ] as const;
  for (const [kind, key] of entries) {
    if (kind === skip) continue;
    const value =
      kind === "caller"
        ? sourceRecord[FILTER_SCOPE_PREFERENCE]
        : sourceRecord[SAVED_FILTER_SCOPE_PREFERENCE];
    if (value !== undefined) {
      Object.defineProperty(target, key, {
        value,
        enumerable: false,
        writable: false,
      });
    }
  }
}

export function attachFilterScopePreference(
  filters: FilterDocument,
  preference: FilterScopePreference,
): FilterDocument {
  const scopedFilters = { ...filters } as ScopedFilterDocument;
  copyFilterScopePreferenceMetadata(filters, scopedFilters, "caller");
  Object.defineProperty(scopedFilters, FILTER_SCOPE_PREFERENCE, {
    value: preference,
    enumerable: false,
    writable: false,
  });
  return scopedFilters;
}

export function filterScopePreferenceFromDocument(
  filters: FilterDocument | undefined,
): FilterScopePreference | undefined {
  if (!filters) return undefined;
  return (filters as ScopedFilterDocument)[FILTER_SCOPE_PREFERENCE];
}

export function attachSavedFilterScopePreference(
  filters: FilterDocument,
  preference: FilterScopePreference,
): FilterDocument {
  const scopedFilters = { ...filters } as ScopedFilterDocument;
  copyFilterScopePreferenceMetadata(filters, scopedFilters, "saved");
  Object.defineProperty(scopedFilters, SAVED_FILTER_SCOPE_PREFERENCE, {
    value: preference,
    enumerable: false,
    writable: false,
  });
  return scopedFilters;
}

export function savedFilterScopePreferenceFromDocument(
  filters: FilterDocument | undefined,
): FilterScopePreference | undefined {
  if (!filters) return undefined;
  return (filters as ScopedFilterDocument)[SAVED_FILTER_SCOPE_PREFERENCE];
}
