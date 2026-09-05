import { FILTER_DSL_VERSION } from "@/lib/filter-contract";
import type { PageResult } from "@/lib/pagination";

/** Saved filters currently persist the shared Filter DSL v1 source. */
export const SAVED_FILTER_DSL_VERSION = FILTER_DSL_VERSION;

export const SAVED_FILTER_VISIBILITIES = ["private", "team"] as const;
export type SavedFilterVisibility = (typeof SAVED_FILTER_VISIBILITIES)[number];

export const SAVED_FILTER_SCOPE_PREFERENCES = [
  "auto",
  "event",
  "session",
  "visitor",
] as const;
export type SavedFilterScopePreference =
  (typeof SAVED_FILTER_SCOPE_PREFERENCES)[number];

export interface SavedFilter {
  readonly id: string;
  readonly siteId: string;
  readonly ownerUserId: string;
  readonly authorName: string;
  readonly isOwner: boolean;
  readonly visibility: SavedFilterVisibility;
  readonly scopePreference: SavedFilterScopePreference;
  readonly name: string;
  readonly description: string;
  /** Exact user-authored DSL. Never treat this as a canonical query string. */
  readonly filterDsl: string;
  readonly filterDslVersion: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SavedFilterListResponse {
  readonly items: readonly SavedFilter[];
  readonly pagination: PageResult<SavedFilter>["pagination"];
}

export interface SavedFilterInput {
  readonly name: string;
  readonly description: string;
  readonly visibility: SavedFilterVisibility;
  /** Defaults to auto when omitted by older clients. */
  readonly scopePreference?: SavedFilterScopePreference;
  /** Exact user-authored DSL, intentionally never normalized by the client. */
  readonly filterDsl: string;
}

export interface SavedFilterResponse {
  readonly filter: SavedFilter;
}

export interface SavedFilterDeleteResponse {
  readonly deletedId: string;
}
