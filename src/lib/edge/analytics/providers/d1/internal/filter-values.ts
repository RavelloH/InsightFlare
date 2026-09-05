import { buildTrafficChannelSqlExpression } from "@/lib/analytics/traffic-channel-rules";
import {
  analyticsFilterDefinition,
  type FilterDocument,
  type QueryAudience,
} from "@/lib/edge/analytics/contract";
import type { Env } from "@/lib/edge/types";
import { InvalidCursorError } from "@/lib/pagination";

import type { DimensionRow, QueryWindow } from "./core";
import { DIRECT_REFERRER_FILTER_VALUE } from "./core";
import { resolveCrossBreakdownDimension } from "./core-dimensions";
import {
  decodeDimensionCursor,
  decodeSessionPathDimensionCursor,
  queryDimensionFromD1,
  queryDimensionPageFromD1,
  querySessionBoundaryDimensionFromD1,
  querySessionPathDimensionPageFromD1,
} from "./dimensions";
import {
  decodeEventTypeCursor,
  queryEventTypeAggregate,
  queryEventTypePageFromD1,
} from "./events-summary";
import {
  decodeReferrersCursor,
  queryReferrerAggregate,
  queryReferrersPageFromD1,
} from "./pages";
import type { PageResult } from "./pagination";

export interface FilterValueRow {
  readonly value: string;
  readonly occurrences: number;
}

export type FilterValuePage = PageResult<FilterValueRow>;

function matchesSearch(value: string, search?: string): boolean {
  const needle = search?.trim().toLocaleLowerCase();
  return !needle || value.toLocaleLowerCase().includes(needle);
}

function mapRows(
  rows: readonly DimensionRow[],
  search?: string,
): FilterValueRow[] {
  return rows
    .map((row) => ({
      value: String(row.value ?? "").trim(),
      occurrences: Number(row.views ?? 0),
    }))
    .filter((row) => row.value.length > 0 && matchesSearch(row.value, search));
}

/**
 * Candidate values for registered canonical fields. Dynamic event payload
 * paths deliberately do not enter this reader; they use event-field-values.
 */
export async function queryFilterValuesFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  field: string,
  limit: number,
  search?: string,
): Promise<FilterValueRow[]> {
  const definition = analyticsFilterDefinition(field);
  if (!definition || definition.source === "payload") return [];

  // Query a bounded superset before applying the UI search token. This keeps
  // the SQL reader shared with existing dimension contracts while preserving
  // the query-layer limit on D1 work.
  const readLimit = limit;
  let rows: DimensionRow[];
  if (field === "event.name") {
    rows = await queryEventTypeAggregate(
      env,
      siteId,
      window,
      filters,
      readLimit,
      search,
    );
  } else if (field === "referrer.domain" || field === "referrer.url") {
    rows = (
      await queryReferrerAggregate(
        env,
        siteId,
        window,
        filters,
        readLimit,
        field === "referrer.url",
        undefined,
        search,
      )
    ).map((row) => ({
      value: row.referrer || DIRECT_REFERRER_FILTER_VALUE,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    }));
  } else if (field === "session.entryPath" || field === "session.exitPath") {
    rows = await querySessionBoundaryDimensionFromD1(
      env,
      siteId,
      window,
      filters,
      readLimit,
      field === "session.entryPath" ? "entry" : "exit",
      undefined,
      search,
    );
  } else if (field === "traffic.channel") {
    rows = await queryDimensionFromD1(
      env,
      siteId,
      window,
      filters,
      readLimit,
      buildTrafficChannelSqlExpression(),
      { excludeEmpty: true, search },
    );
  } else {
    const dimension = resolveCrossBreakdownDimension(field);
    if (!dimension) return [];
    rows = await queryDimensionFromD1(
      env,
      siteId,
      window,
      filters,
      readLimit,
      dimension.labelExpr,
      { excludeEmpty: true, search },
    );
  }
  return mapRows(rows, search).slice(0, limit);
}

export async function queryFilterValuesPageFromD1(
  env: Env,
  siteId: string,
  window: QueryWindow,
  filters: FilterDocument,
  field: string,
  limit: number,
  cursor?: string | null,
  search?: string,
  audience: QueryAudience = "private-dashboard",
): Promise<FilterValuePage> {
  const definition = analyticsFilterDefinition(field);
  if (!definition || definition.source === "payload") {
    return {
      items: [],
      pagination: { limit, returned: 0, hasMore: false, nextCursor: null },
    };
  }
  if (field === "event.name") {
    const eventCursor = await decodeEventTypeCursor(
      env,
      siteId,
      window,
      filters,
      search,
      cursor,
      audience,
    );
    if (cursor && !eventCursor) throw new InvalidCursorError("filter-values");
    const page = await queryEventTypePageFromD1(
      env,
      siteId,
      window,
      filters,
      limit,
      search,
      eventCursor,
      audience,
    );
    return {
      items: page.items.map((row) => ({
        value: row.value,
        occurrences: row.views,
      })),
      pagination: page.pagination,
    };
  }
  if (field === "referrer.domain" || field === "referrer.url") {
    const includeFullUrl = field === "referrer.url";
    const referrerCursor = await decodeReferrersCursor(
      env,
      siteId,
      window,
      filters,
      includeFullUrl,
      search,
      cursor,
      audience,
    );
    if (cursor && !referrerCursor)
      throw new InvalidCursorError("filter-values");
    const page = await queryReferrersPageFromD1(
      env,
      siteId,
      window,
      filters,
      limit,
      includeFullUrl,
      search,
      referrerCursor,
      undefined,
      audience,
    );
    return {
      items: page.items
        .map((row) => ({
          value: row.referrer || DIRECT_REFERRER_FILTER_VALUE,
          occurrences: row.views,
        }))
        .filter((row) => row.value.length > 0),
      pagination: page.pagination,
    };
  }

  if (field === "session.entryPath" || field === "session.exitPath") {
    const kind = field === "session.entryPath" ? "entry" : "exit";
    const boundaryCursor = await decodeSessionPathDimensionCursor(
      env,
      siteId,
      window,
      filters,
      kind,
      search,
      cursor,
      audience,
    );
    if (cursor && !boundaryCursor)
      throw new InvalidCursorError("filter-values");
    const page = await querySessionPathDimensionPageFromD1(
      env,
      siteId,
      window,
      filters,
      limit,
      kind,
      undefined,
      search,
      boundaryCursor,
      audience,
    );
    const items = mapRows(page.items, search);
    return {
      items,
      pagination: {
        limit,
        returned: items.length,
        hasMore: page.pagination.hasMore,
        nextCursor: page.pagination.nextCursor,
      },
    };
  }

  const selectExpr =
    field === "traffic.channel"
      ? buildTrafficChannelSqlExpression()
      : resolveCrossBreakdownDimension(field)?.labelExpr;
  if (!selectExpr) {
    return {
      items: [],
      pagination: { limit, returned: 0, hasMore: false, nextCursor: null },
    };
  }
  const dimensionCursor = await decodeDimensionCursor(
    env,
    siteId,
    window,
    filters,
    selectExpr,
    search,
    cursor,
    audience,
  );
  if (cursor && !dimensionCursor) throw new InvalidCursorError("filter-values");
  const page = await queryDimensionPageFromD1(
    env,
    siteId,
    window,
    filters,
    limit,
    selectExpr,
    { excludeEmpty: true, search },
    dimensionCursor,
    undefined,
    audience,
  );
  return {
    items: mapRows(page.items, search),
    pagination: page.pagination,
  };
}
