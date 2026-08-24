import "@tanstack/react-start/server-only";

import {
  assertFilterAudience,
  executePages,
  executeReferrers,
  type FilterDocument,
  type PagesResult,
  type ReferrersResult,
  siteQueryContext,
  validateTypedQueryFilters,
} from "@/lib/edge/analytics/contract";
import { analyticsFilterRegistry } from "@/lib/edge/analytics/contract/filter-registry";
import { createQueryTime } from "@/lib/edge/analytics/contract/helpers";
import type { QueryWindow } from "@/lib/edge/analytics/providers/d1/internal/core";
import {
  queryPagesAggregate,
  queryReferrerAggregate,
} from "@/lib/edge/analytics/providers/d1/internal/pages";
import type { Env } from "@/lib/edge/types";

export interface ReadSitePagesInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeDetails: boolean;
}

export interface ReadSiteReferrersInput {
  readonly env: Env;
  readonly siteId: string;
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeFullUrl: boolean;
}

function queryTime(window: QueryWindow) {
  return createQueryTime(
    window.startMs,
    window.endExclusiveMs,
    window.timeZone,
    window.nowMs,
  );
}

function assertApiV1Filters(siteId: string, filters: FilterDocument): void {
  const context = siteQueryContext(siteId, "api-v1");
  const error = validateTypedQueryFilters(context, filters);
  if (error) throw new Error(error.kind);
  try {
    assertFilterAudience(
      filters,
      analyticsFilterRegistry,
      context.policy.audience,
    );
  } catch {
    throw new Error("invalid-input");
  }
}

/** Typed page composite provider; HTTP adapters do not own its D1 calls. */
export async function readSitePages(
  input: ReadSitePagesInput,
): Promise<PagesResult> {
  assertApiV1Filters(input.siteId, input.filters);
  const result = await executePages(
    {
      async readPages(query) {
        return {
          value: await queryPagesAggregate(
            input.env,
            input.siteId,
            input.window,
            query.filters,
            query.limit,
            query.includeDetails,
          ),
          source: "raw" as const,
        };
      },
      async readReferrers() {
        throw new Error("referrer_reader_not_used");
      },
    },
    {
      context: siteQueryContext(input.siteId, "api-v1"),
      time: queryTime(input.window),
      filters: input.filters,
      limit: input.limit,
      includeDetails: input.includeDetails,
    },
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}

/** Typed referrer composite provider; HTTP adapters do not own its D1 calls. */
export async function readSiteReferrers(
  input: ReadSiteReferrersInput,
): Promise<ReferrersResult> {
  assertApiV1Filters(input.siteId, input.filters);
  const result = await executeReferrers(
    {
      async readPages() {
        throw new Error("pages_reader_not_used");
      },
      async readReferrers(query) {
        return {
          value: await queryReferrerAggregate(
            input.env,
            input.siteId,
            input.window,
            query.filters,
            query.limit,
            query.includeFullUrl,
          ),
          source: "raw" as const,
        };
      },
    },
    {
      context: siteQueryContext(input.siteId, "api-v1"),
      time: queryTime(input.window),
      filters: input.filters,
      limit: input.limit,
      includeFullUrl: input.includeFullUrl,
    },
  );
  if (!result.ok) throw new Error(result.error.kind);
  return result.data;
}
