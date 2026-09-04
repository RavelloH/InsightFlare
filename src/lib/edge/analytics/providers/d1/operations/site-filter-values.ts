import "@tanstack/react-start/server-only";

import {
  type FilterDocument,
  type QueryAudience,
  stripTopLevelFacet,
} from "@/lib/edge/analytics/contract";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryFilterValuesFromD1,
  queryFilterValuesPageFromD1,
} from "@/lib/edge/analytics/providers/d1/internal/filter-values";
import type { Env } from "@/lib/edge/types";

export interface ReadSiteFilterValuesInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly field: string;
  readonly search?: string;
  readonly page?: { readonly limit: number; readonly cursor?: string | null };
  readonly limit?: number;
  readonly audience?: QueryAudience;
}

export interface SiteFilterValuesResult {
  readonly field: string;
  readonly items: readonly {
    readonly value: string;
    readonly label: string;
    readonly occurrences: number;
  }[];
  readonly pagination?: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
  readonly page?: {
    readonly limit: number;
    readonly hasMore: false;
    readonly nextCursor: null;
  };
}

/** Typed faceted-value provider; filtering is finalized before the D1 reader. */
export async function readSiteFilterValues(
  input: ReadSiteFilterValuesInput,
): Promise<SiteFilterValuesResult> {
  const filters = stripTopLevelFacet(input.filters, input.field);
  const requestedPage = input.page;
  if (!requestedPage) {
    const rows = await queryFilterValuesFromD1(
      input.env,
      input.siteId,
      input.window,
      filters,
      input.field,
      input.limit ?? 50,
      input.search,
    );
    return {
      field: input.field,
      items: rows.map((row) => ({
        value: row.value,
        label: row.value,
        occurrences: row.occurrences,
      })),
      page: { limit: input.limit ?? 50, hasMore: false, nextCursor: null },
    };
  }
  const page = await queryFilterValuesPageFromD1(
    input.env,
    input.siteId,
    input.window,
    filters,
    input.field,
    requestedPage.limit,
    requestedPage.cursor,
    input.search,
    input.audience,
  );
  return {
    field: input.field,
    items: page.items.map((row) => ({
      value: row.value,
      label: row.value,
      occurrences: row.occurrences,
    })),
    pagination: page.pagination,
  };
}
