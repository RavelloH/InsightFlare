import {
  and,
  compileD1Mutation,
  eq,
  excluded,
  inList,
  insert,
  isDistinctFrom,
  onConflictDoUpdate,
  or,
  param,
  update,
} from "@/lib/db";
import type { CompiledMutation } from "@/lib/db/mutation/plan";
import { schema } from "@/lib/db/schema";

import type { BufferedVisitRow } from "./types";

const ACTIVE_VISIT_STATUSES = ["open", "hidden_pending"] as const;

function isActiveVisit(row: BufferedVisitRow): boolean {
  return row.status === "open" || row.status === "hidden_pending";
}

function visitInsertValues(row: BufferedVisitRow, sitePk: number) {
  return {
    visit_id: row.visitId,
    site_id: row.siteId,
    site_pk: sitePk,
    visitor_id: row.visitorId,
    session_id: row.sessionId,
    status: row.status,
    started_at: row.startedAt,
    last_activity_at: row.lastActivityAt,
    ended_at: row.endedAt,
    finalized_at: row.finalizedAt,
    duration_ms: row.durationMs,
    duration_source: row.durationSource || null,
    exit_reason: row.exitReason || null,
    pathname: row.pathname,
    query_string: row.queryString,
    hash_fragment: row.hashFragment,
    hostname: row.hostname,
    title: row.title,
    referrer_url: row.referrerUrl,
    referrer_host: row.referrerHost,
    utm_source: row.utmSource,
    utm_medium: row.utmMedium,
    utm_campaign: row.utmCampaign,
    utm_term: row.utmTerm,
    utm_content: row.utmContent,
    is_eu: row.isEU,
    country: row.country,
    region: row.region,
    region_code: row.regionCode,
    city: row.city,
    continent: row.continent,
    latitude: row.latitude,
    longitude: row.longitude,
    postal_code: row.postalCode,
    metro_code: row.metroCode,
    timezone: row.timezone,
    as_organization: row.asOrganization,
    ua_raw: row.uaRaw,
    browser: row.browser,
    browser_version: row.browserVersion,
    os: row.os,
    os_version: row.osVersion,
    device_type: row.deviceType,
    screen_width: row.screenWidth,
    screen_height: row.screenHeight,
    language: row.language,
    user_id: row.userId || null,
    user_name: row.userName || null,
    perf_ttfb_ms: row.perfTtfbMs,
    perf_fcp_ms: row.perfFcpMs,
    perf_lcp_ms: row.perfLcpMs,
    perf_cls: row.perfCls,
    perf_inp_ms: row.perfInpMs,
    ae_synced_at: null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function prepareVisitMutations(
  row: BufferedVisitRow,
  sitePk: number,
): CompiledMutation[] {
  const active = isActiveVisit(row);
  const insertPlan = insert(schema.visits, visitInsertValues(row, sitePk));
  const statePlan = active
    ? onConflictDoUpdate(insertPlan, ["visit_id"], (columns) => ({
        set: {
          status: excluded(schema.visits.columns.status),
          last_activity_at: excluded(schema.visits.columns.last_activity_at),
          updated_at: excluded(schema.visits.columns.updated_at),
        },
        where: and(
          inList(columns.status, ACTIVE_VISIT_STATUSES),
          or(
            isDistinctFrom(
              columns.status,
              excluded(schema.visits.columns.status),
            ),
            isDistinctFrom(
              columns.last_activity_at,
              excluded(schema.visits.columns.last_activity_at),
            ),
          ),
        ),
      }))
    : onConflictDoUpdate(insertPlan, ["visit_id"], (columns) => ({
        set: {
          status: excluded(schema.visits.columns.status),
          last_activity_at: excluded(schema.visits.columns.last_activity_at),
          ended_at: excluded(schema.visits.columns.ended_at),
          finalized_at: excluded(schema.visits.columns.finalized_at),
          duration_ms: excluded(schema.visits.columns.duration_ms),
          duration_source: excluded(schema.visits.columns.duration_source),
          exit_reason: excluded(schema.visits.columns.exit_reason),
          updated_at: excluded(schema.visits.columns.updated_at),
        },
        where: or(
          isDistinctFrom(
            columns.status,
            excluded(schema.visits.columns.status),
          ),
          isDistinctFrom(
            columns.last_activity_at,
            excluded(schema.visits.columns.last_activity_at),
          ),
          isDistinctFrom(
            columns.ended_at,
            excluded(schema.visits.columns.ended_at),
          ),
          isDistinctFrom(
            columns.finalized_at,
            excluded(schema.visits.columns.finalized_at),
          ),
          isDistinctFrom(
            columns.duration_ms,
            excluded(schema.visits.columns.duration_ms),
          ),
          isDistinctFrom(
            columns.duration_source,
            excluded(schema.visits.columns.duration_source),
          ),
          isDistinctFrom(
            columns.exit_reason,
            excluded(schema.visits.columns.exit_reason),
          ),
        ),
      }));

  const detailPlan = update(schema.visits, (columns) => {
    const detailsChanged = or(
      isDistinctFrom(columns.user_id, param(row.userId || null)),
      isDistinctFrom(columns.user_name, param(row.userName || null)),
      isDistinctFrom(columns.perf_ttfb_ms, param(row.perfTtfbMs)),
      isDistinctFrom(columns.perf_fcp_ms, param(row.perfFcpMs)),
      isDistinctFrom(columns.perf_lcp_ms, param(row.perfLcpMs)),
      isDistinctFrom(columns.perf_cls, param(row.perfCls)),
      isDistinctFrom(columns.perf_inp_ms, param(row.perfInpMs)),
    );
    return {
      set: {
        user_id: row.userId || null,
        user_name: row.userName || null,
        perf_ttfb_ms: row.perfTtfbMs,
        perf_fcp_ms: row.perfFcpMs,
        perf_lcp_ms: row.perfLcpMs,
        perf_cls: row.perfCls,
        perf_inp_ms: row.perfInpMs,
        updated_at: row.updatedAt,
      },
      where: active
        ? and(
            eq(columns.visit_id, param(row.visitId)),
            inList(columns.status, ACTIVE_VISIT_STATUSES),
            detailsChanged,
          )
        : and(eq(columns.visit_id, param(row.visitId)), detailsChanged),
    };
  });

  return [
    compileD1Mutation(statePlan, { tag: "ingest.visits.upsert_state" }),
    compileD1Mutation(detailPlan, { tag: "ingest.visits.update_details" }),
  ];
}
