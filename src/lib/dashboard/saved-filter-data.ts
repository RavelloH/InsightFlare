import type {
  SavedFilterDeleteResponse,
  SavedFilterInput,
  SavedFilterListResponse,
  SavedFilterResponse,
} from "@/lib/saved-filters";

import { fetchPrivateJson, fetchPrivateJsonMutate } from "./client-request";

export function fetchSavedFilters(
  siteId: string,
  options?: { signal?: AbortSignal },
): Promise<SavedFilterListResponse> {
  return fetchPrivateJson<SavedFilterListResponse>(
    "/api/private/saved-filters",
    { siteId },
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
