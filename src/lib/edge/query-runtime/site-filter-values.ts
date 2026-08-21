import "@tanstack/react-start/server-only";

import type { QueryWindow } from "@/lib/edge/query/core";
import { queryFilterValuesFromD1 } from "@/lib/edge/query/filter-values";
import {
  analyticsFilterDefinition,
  assertFilterAudience,
  executeQueryOperation,
  type FilterDocument,
  siteQueryContext,
  stripTopLevelFacet,
} from "@/lib/edge/query-contract";
import { analyticsFilterRegistry } from "@/lib/edge/query-contract/filter-registry";
import { createQueryTime } from "@/lib/edge/query-contract/helpers";
import type { Env } from "@/lib/edge/types";

export interface ReadSiteFilterValuesInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly field: string;
  readonly search?: string;
  readonly limit: number;
}

export interface SiteFilterValuesResult {
  readonly field: string;
  readonly items: readonly {
    readonly value: string;
    readonly label: string;
    readonly occurrences: number;
  }[];
  readonly page: {
    readonly limit: number;
    readonly hasMore: false;
    readonly nextCursor: null;
  };
}

/** Typed faceted-value provider; filtering is finalized before the D1 reader. */
export async function readSiteFilterValues(
  input: ReadSiteFilterValuesInput,
): Promise<SiteFilterValuesResult> {
  const context = siteQueryContext(input.siteId, "api-v1");
  const definition = analyticsFilterDefinition(input.field);
  if (
    !definition ||
    definition.source === "payload" ||
    !definition.audiences.has(context.policy.audience)
  ) {
    throw new Error("unsupported-filter-field");
  }
  try {
    assertFilterAudience(
      input.filters,
      analyticsFilterRegistry,
      context.policy.audience,
    );
  } catch {
    throw new Error("invalid-input");
  }
  const filters = stripTopLevelFacet(input.filters, input.field);
  const result = await executeQueryOperation(
    "filter-values",
    {
      context,
      time: createQueryTime(
        input.window.startMs,
        input.window.endExclusiveMs,
        input.window.timeZone,
        input.window.nowMs,
      ),
      filters,
    },
    async () => ({
      value: await queryFilterValuesFromD1(
        input.env,
        input.siteId,
        input.window,
        filters,
        input.field,
        input.limit,
        input.search,
      ),
    }),
  );
  if (!result.ok) throw new Error(result.error.kind);
  return {
    field: input.field,
    items: result.data.map((row) => ({
      value: row.value,
      label: row.value,
      occurrences: row.occurrences,
    })),
    page: { limit: input.limit, hasMore: false, nextCursor: null },
  };
}
