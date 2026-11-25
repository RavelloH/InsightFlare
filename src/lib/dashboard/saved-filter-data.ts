import {
  fetchPrivateJson,
  fetchPrivateJsonMutate,
} from "@/lib/dashboard/client/request";
import type {
  SavedFilter,
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
/** Resource libraries must search all visible saved filters, not just the first page. */
export async function fetchAllSavedFilters(
  siteId: string,
  options?: { signal?: AbortSignal },
): Promise<{ items: readonly SavedFilter[] }> {
  const items = new Map<string, SavedFilter>();
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await fetchSavedFilters(siteId, {
      cursor,
      signal: options?.signal,
    });
    for (const item of page.items) items.set(item.id, item);
    if (!page.pagination.hasMore) break;
    const next = page.pagination.nextCursor;
    if (!next || seen.has(next))
      throw new Error("Invalid saved filter pagination cursor");
    seen.add(next);
    cursor = next;
  } while (cursor);
  return { items: [...items.values()] };
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
