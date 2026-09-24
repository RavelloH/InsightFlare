import {
  fetchPrivateJson,
  fetchPrivateJsonMutate,
} from "@/lib/dashboard/client/request";
import type {
  SavedFilterDeleteResponse,
  SavedFilterInput,
  SavedFilterListResponse,
  SavedFilterResponse,
} from "@/lib/saved-filters";
export function fetchSavedFilters(
  siteId: string,
  options?: { limit?: number; cursor?: string | null; signal?: AbortSignal },
): Promise<SavedFilterListResponse> {
  const params: Record<string, string | number> = {
    siteId,
    limit: options?.limit ?? 100,
  };
  if (options?.cursor) params.cursor = options.cursor;
  return fetchPrivateJson<SavedFilterListResponse>(
    "/api/private/saved-filters",
    params,
    { signal: options?.signal },
  );
}
export function createSavedFilter(
  siteId: string,
  input: SavedFilterInput,
): Promise<SavedFilterResponse> {
  return fetchPrivateJsonMutate<SavedFilterResponse>(
    "/api/private/saved-filters",
    "POST",
    { siteId },
    input,
  );
}
export function updateSavedFilter(
  siteId: string,
  filterId: string,
  input: SavedFilterInput,
): Promise<SavedFilterResponse> {
  return fetchPrivateJsonMutate<SavedFilterResponse>(
    `/api/private/saved-filters/${encodeURIComponent(filterId)}`,
    "PUT",
    { siteId },
    input,
  );
}
export function deleteSavedFilter(
  siteId: string,
  filterId: string,
): Promise<SavedFilterDeleteResponse> {
  return fetchPrivateJsonMutate<SavedFilterDeleteResponse>(
    `/api/private/saved-filters/${encodeURIComponent(filterId)}`,
    "DELETE",
    { siteId },
  );
}
