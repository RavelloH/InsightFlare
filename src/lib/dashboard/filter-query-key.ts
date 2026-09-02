import {
  analyticsFilterRegistry,
  type FilterDocument,
  filterFingerprint,
  filterScopePreferenceFromDocument,
} from "@/lib/filter-contract";

const EMPTY_FILTER_DOCUMENT: FilterDocument = { version: 1, root: null };

/**
 * Builds a stable, browser-safe identity for a filtered dashboard query.
 *
 * Scope preference is stored as non-enumerable metadata on FilterDocument,
 * so JSON.stringify(filters) cannot distinguish otherwise identical
 * expressions with different scope semantics.
 */
export function filterQueryKey(filters?: FilterDocument): string {
  const document = filters ?? EMPTY_FILTER_DOCUMENT;
  const fingerprint = filterFingerprint(document, analyticsFilterRegistry);
  const scope = filterScopePreferenceFromDocument(document) ?? "auto";
  return `${fingerprint}:scope=${scope}`;
}
