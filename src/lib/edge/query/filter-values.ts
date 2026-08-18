import {
  analyticsFilterDefinition,
  type FilterDocument,
} from "@/lib/edge/query-contract";
import type { Env } from "@/lib/edge/types";

import type { DimensionRow, QueryWindow } from "./core";
import { DIRECT_REFERRER_FILTER_VALUE } from "./core";
import { resolveCrossBreakdownDimension } from "./core-dimensions";
import {
  queryDimensionFromD1,
  querySessionBoundaryDimensionFromD1,
} from "./dimensions";
import { queryEventTypeAggregate } from "./events-summary";
import { queryReferrerAggregate } from "./pages";

export interface FilterValueRow {
  readonly value: string;
  readonly occurrences: number;
}

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
