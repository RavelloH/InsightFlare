import type { PageResult } from "@/lib/pagination";

import { type FilterDocument } from "./filters";
import { EMPTY_FILTER_DOCUMENT } from "./helpers";
import { assertDetailAllowed, assertOperationAllowed } from "./policy";
import type {
  AnalyticsResult,
  PageItem,
  PagesQuery,
  PagesResult,
  QuerySource,
  QueryTime,
  ReferrerItem,
  ReferrersQuery,
  ReferrersResult,
} from "./types";

export interface PagesReaderInput {
  readonly context: PagesQuery["context"];
  readonly time: QueryTime;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeDetails: boolean;
}

export interface ReferrersReaderInput {
  readonly context: ReferrersQuery["context"];
  readonly time: QueryTime;
  readonly filters: FilterDocument;
  readonly limit: number;
  readonly includeFullUrl: boolean;
}

export interface PagesReader {
  readPages(input: PagesReaderInput): Promise<{
    readonly value: PageResult<PageItem>;
    readonly source: QuerySource;
  }>;
  readReferrers(input: ReferrersReaderInput): Promise<{
    readonly value: PageResult<ReferrerItem>;
    readonly source: QuerySource;
  }>;
}

export async function executePages(
  reader: PagesReader,
  input: PagesQuery,
): Promise<AnalyticsResult<PagesResult>> {
  const error = assertOperationAllowed(input.context, "pages");
  if (error) return { ok: false, error };
  if (input.includeDetails) {
    const queryError = assertDetailAllowed(input.context, "page.query");
    if (queryError) return { ok: false, error: queryError };
    const hashError = assertDetailAllowed(input.context, "page.hash");
    if (hashError) return { ok: false, error: hashError };
  }
  const result = await reader.readPages({
    context: input.context,
    time: input.time,
    filters: input.filters ?? EMPTY_FILTER_DOCUMENT,
    limit: input.limit,
    includeDetails: input.includeDetails,
  });
  return {
    ok: true,
    data: result.value,
    meta: {
      time: input.time,
      source: result.source,
      approximateVisitors: false,
    },
  };
}

export async function executeReferrers(
  reader: PagesReader,
  input: ReferrersQuery,
): Promise<AnalyticsResult<ReferrersResult>> {
  const error = assertOperationAllowed(input.context, "referrers");
  if (error) return { ok: false, error };
  if (input.includeFullUrl) {
    const detailError = assertDetailAllowed(input.context, "referrer.url");
    if (detailError) return { ok: false, error: detailError };
  }
  const result = await reader.readReferrers({
    context: input.context,
    time: input.time,
    filters: input.filters ?? EMPTY_FILTER_DOCUMENT,
    limit: input.limit,
    includeFullUrl: input.includeFullUrl,
  });
  return {
    ok: true,
    data: result.value,
    meta: {
      time: input.time,
      source: result.source,
      approximateVisitors: false,
    },
  };
}
