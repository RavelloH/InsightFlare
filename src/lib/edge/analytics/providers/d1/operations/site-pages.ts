import "@tanstack/react-start/server-only";

import {
  type FilterDocument,
  type PagesResult,
  type ReferrersResult,
} from "@/lib/edge/analytics/contract";
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

/** Typed page composite provider; HTTP adapters do not own its D1 calls. */
export async function readSitePages(
  input: ReadSitePagesInput,
): Promise<PagesResult> {
  return {
    items: await queryPagesAggregate(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.limit,
      input.includeDetails,
    ),
  };
}

/** Typed referrer composite provider; HTTP adapters do not own its D1 calls. */
export async function readSiteReferrers(
  input: ReadSiteReferrersInput,
): Promise<ReferrersResult> {
  return {
    items: await queryReferrerAggregate(
      input.env,
      input.siteId,
      input.window,
      input.filters,
      input.limit,
      input.includeFullUrl,
    ),
  };
}
