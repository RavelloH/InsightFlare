import {
  currentD1Operation,
  currentInvocationLogger,
} from "@/lib/edge/observability-logger";
import type { Env } from "@/lib/edge/types";

import { buildEventFilterSql } from "./core-filters";
import type { DashboardFilters, QueryWindow } from "./core-types";
import { type D1ReadDiagnostics, recordD1RowsRead } from "./diagnostics";

export const VISIT_SOURCE_COLUMNS = `
    visit_id, site_id, visitor_id, session_id, status, started_at, last_activity_at,
    ended_at, finalized_at, duration_ms, duration_source, exit_reason,
    pathname, query_string, hash_fragment, hostname, title, referrer_url, referrer_host,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content,
    is_eu, country, region, region_code, city, continent, latitude, longitude,
    postal_code, metro_code, timezone, as_organization, ua_raw, browser, browser_version,
    os, os_version, device_type, screen_width, screen_height, language,
    perf_ttfb_ms, perf_fcp_ms, perf_lcp_ms, perf_cls, perf_inp_ms,
    ae_synced_at
  `;

export function buildVisitSourceCte(): string {
  return `
visit_source AS (
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits
  WHERE site_id = ? AND started_at >= ? AND started_at < ?
)`;
}

export function buildCustomEventSourceCte(): string {
  return `
event_source AS (
  SELECT
    ce.event_id,
    ce.site_id,
    ce.visit_id,
    v.visitor_id,
    v.session_id,
    ce.occurred_at,
    cen.name AS event_name,
    '{}' AS event_data_json,
    v.pathname,
    v.query_string,
    v.hash_fragment,
    v.hostname,
    v.title,
    v.referrer_url,
    v.referrer_host,
    v.country,
    v.region,
    v.city,
    v.browser,
    v.os,
    v.os_version,
    v.device_type,
    v.language,
    v.timezone,
    v.screen_width,
    v.screen_height,
    ce.ae_synced_at
  FROM custom_events ce
  INNER JOIN custom_event_names cen
    ON cen.id = ce.event_name_id
  INNER JOIN visits v
    ON v.site_id = ce.site_id
   AND v.visit_id = ce.visit_id
  WHERE ce.site_id = ? AND ce.occurred_at >= ? AND ce.occurred_at < ?
)`;
}

export function buildTargetVisitSourceCte(
  targetColumn: "session_id" | "visitor_id",
): string {
  return `
visit_source AS (
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits
  WHERE site_id = ? AND ${targetColumn} = ?
)`;
}

export function buildDetailCustomEventSourceCte(options?: {
  materialize?: boolean;
}): string {
  return `
event_source${options?.materialize ? " AS MATERIALIZED" : " AS"} (
  SELECT
    ce.event_id, ce.site_id, ce.visit_id, fv.visitor_id, fv.session_id,
    ce.occurred_at, cen.name AS event_name, '{}' AS event_data_json,
    fv.pathname, fv.query_string,
    fv.hash_fragment,
    fv.hostname, fv.title,
    fv.referrer_url, fv.referrer_host, fv.country, fv.region, fv.city,
    fv.browser, fv.browser_version, fv.os, fv.os_version, fv.device_type,
    fv.language, fv.timezone, fv.screen_width, fv.screen_height,
    fv.perf_ttfb_ms, fv.perf_fcp_ms, fv.perf_lcp_ms, fv.perf_cls, fv.perf_inp_ms,
    ce.ae_synced_at
  FROM filtered_visits fv
  CROSS JOIN custom_events ce
  INNER JOIN custom_event_names cen
    ON cen.id = ce.event_name_id
  WHERE ce.site_id = ?
    AND ce.site_id = fv.site_id
    AND ce.visit_id = fv.visit_id
)`;
}

export function buildEventAnalyticsSourceCte(options?: {
  eventName?: string;
  eventNames?: string[];
  cteName?: string;
}): string {
  const cteName = options?.cteName ?? "event_source";
  const eventNameSource = options?.eventName
    ? `
target_event_name AS (
  SELECT id
  FROM custom_event_names
  WHERE site_id = ? AND name = ?
),`
    : options?.eventNames?.length
      ? `
target_event_names AS (
  SELECT id
  FROM custom_event_names
  WHERE site_id = ? AND name IN (${options.eventNames.map(() => "?").join(", ")})
),`
      : "";
  const eventNameJoin = options?.eventName
    ? `
  INNER JOIN target_event_name ten
    ON ten.id = ce.event_name_id`
    : options?.eventNames?.length
      ? `
  INNER JOIN target_event_names ten
    ON ten.id = ce.event_name_id`
      : "";
  return `
${eventNameSource}
${cteName} AS (
  SELECT
    ce.event_pk,
    ce.event_id,
    ce.site_id,
    ce.visit_id,
    cen.name AS event_name,
    ce.occurred_at,
    ce.received_at,
    ce.sequence,
    ce.node_count,
    ce.value_count,
    v.visitor_id,
    v.session_id,
    v.pathname,
    v.query_string,
    v.hash_fragment,
    v.hostname,
    v.title,
    v.referrer_url,
    v.referrer_host,
    v.country,
    v.region,
    v.region_code,
    v.city,
    v.continent,
    v.browser,
    v.browser_version,
    v.os,
    v.os_version,
    v.device_type,
    v.language,
    v.timezone,
    v.screen_width,
    v.screen_height,
    v.as_organization
  FROM custom_events ce
  INNER JOIN custom_event_names cen
    ON cen.id = ce.event_name_id
${eventNameJoin}
  INNER JOIN visits v
    ON v.site_id = ce.site_id
   AND v.visit_id = ce.visit_id
  WHERE ce.site_id = ? AND ce.occurred_at >= ? AND ce.occurred_at < ?
)`;
}

export function buildEventFilteredSourceCte(
  siteId: string,
  window: QueryWindow,
  filters: DashboardFilters,
  eventName?: string,
  options?: { materialize?: boolean },
): {
  cte: string;
  bindings: Array<string | number>;
} {
  const filter = buildEventFilterSql(filters, "es");
  return {
    cte: `
WITH
${buildEventAnalyticsSourceCte({ eventName })},
filtered_events ${options?.materialize ? "AS MATERIALIZED" : "AS"} (
  SELECT *
  FROM event_source es
  ${filter.clause}
)`,
    bindings: [
      ...eventSourceBindings(siteId, window, eventName),
      ...filter.bindings,
    ],
  };
}

export function visitSourceBindings(
  siteId: string,
  window: QueryWindow,
): Array<string | number> {
  return [siteId, window.startMs, window.endExclusiveMs];
}

export function eventSourceBindings(
  siteId: string,
  window: QueryWindow,
  eventName?: string | string[],
): Array<string | number> {
  return typeof eventName === "string"
    ? [siteId, eventName, siteId, window.startMs, window.endExclusiveMs]
    : eventName?.length
      ? [siteId, ...eventName, siteId, window.startMs, window.endExclusiveMs]
      : [siteId, window.startMs, window.endExclusiveMs];
}

export function targetVisitSourceBindings(
  siteId: string,
  targetValue: string,
): Array<string | number> {
  return [siteId, targetValue];
}

export function detailCustomEventSourceBindings(
  siteId: string,
): Array<string | number> {
  return [siteId];
}

export function buildVisitSourceCteForSites(siteCount: number): string {
  const placeholders = Array.from({ length: siteCount }, () => "?").join(", ");
  return `
visit_source AS (
  SELECT ${VISIT_SOURCE_COLUMNS}
  FROM visits
  WHERE site_id IN (${placeholders}) AND started_at >= ? AND started_at < ?
)`;
}

export function visitSourceBindingsForSites(
  siteIds: string[],
  window: QueryWindow,
): Array<string | number> {
  return [...siteIds, window.startMs, window.endExclusiveMs];
}

export async function queryD1All<T extends object>(
  env: Env,
  sql: string,
  bindings: Array<string | number | null>,
  diagnostics?: D1ReadDiagnostics,
): Promise<T[]> {
  const logger = currentInvocationLogger();
  const operation = currentD1Operation();
  const startedAt = globalThis.performance?.now() ?? Date.now();
  const result = await env.DB.prepare(sql)
    .bind(...bindings)
    .all<T>();
  const finishedAt = globalThis.performance?.now() ?? Date.now();
  recordD1RowsRead(diagnostics, result);
  if (logger && operation) {
    const rowsRead = result.meta?.rows_read;
    logger.recordD1Operation(operation, {
      durationMs: finishedAt - startedAt,
      ...(typeof rowsRead === "number" && Number.isFinite(rowsRead)
        ? { rowsRead: Math.max(0, Math.trunc(rowsRead)) }
        : {}),
      rowsReadAvailable:
        typeof rowsRead === "number" && Number.isFinite(rowsRead),
    });
  }
  return result.results;
}
