import {
  and,
  castInteger,
  coalesce,
  compileD1Query,
  div,
  eq,
  filter,
  gte,
  inSubquery,
  isNotNull,
  join,
  limit,
  lt,
  neq,
  or,
  param,
  project,
  scalar,
  scan,
  sort,
} from "@/lib/db";
import type { CompiledQuery } from "@/lib/db/query/compiled";
import { schema } from "@/lib/db/schema";
import type { StoredRollupRow } from "@/lib/edge/analytics/contract/hourly-rollup";
import { sitePksForSiteIds } from "@/lib/edge/sites/identity-query";
import { ONE_HOUR_MS } from "@/lib/edge/utils";

import type { QueryWindow } from "./core-types";

export interface AggregationCandidateReadRow {
  siteId: string | null;
  sitePk: number | null;
  aggregatedUntilHour: number | null;
  lastError: string | null;
}

export function aggregationCandidateQuery(
  endExclusiveMs: number,
): CompiledQuery<AggregationCandidateReadRow> {
  const siteTable = scan(schema.sites);
  const sites = project(siteTable, { id: siteTable.columns.id });
  const identityTable = scan(schema.site_identities);
  const identities = project(identityTable, {
    site_pk: identityTable.columns.site_pk,
    site_id: identityTable.columns.site_id,
  });
  const siteIdentity = join(
    sites,
    identities,
    eq(sites.columns.id, identities.columns.site_id),
  );
  const stateTable = scan(schema.visit_hourly_aggregation_state);
  const states = project(stateTable, {
    site_pk: stateTable.columns.site_pk,
    aggregated_until_hour: stateTable.columns.aggregated_until_hour,
    last_success_at: stateTable.columns.last_success_at,
    last_error: stateTable.columns.last_error,
  });
  const siteWithState = join(
    siteIdentity,
    states,
    eq(siteIdentity.columns.right_site_pk, states.columns.site_pk),
    "left",
  );

  const visitTable = scan(schema.visits);
  const visits = project(visitTable, {
    site_pk: visitTable.columns.site_pk,
    started_at: visitTable.columns.started_at,
  });
  const earlierVisits = filter(
    visits,
    and(
      eq(visits.columns.site_pk, siteWithState.columns.left_right_site_pk),
      lt(visits.columns.started_at, param(endExclusiveMs)),
    ),
  );
  const hasEarlierVisit = isNotNull(
    scalar(limit(project(earlierVisits, { marker: param(1) }), 1)),
  );

  const candidates = filter(
    siteWithState,
    or(isNotNull(siteWithState.columns.right_site_pk), hasEarlierVisit),
  );
  const ordered = sort(candidates, [
    {
      expression: coalesce(candidates.columns.right_last_success_at, param(0)),
      direction: "ASC",
    },
    { expression: candidates.columns.left_left_id, direction: "ASC" },
  ]);
  return compileD1Query(
    project(ordered, {
      siteId: ordered.columns.left_left_id,
      sitePk: ordered.columns.left_right_site_pk,
      aggregatedUntilHour: ordered.columns.right_aggregated_until_hour,
      lastError: ordered.columns.right_last_error,
    }),
    { tag: "scheduled-tasks.sites.all" },
  );
}

function firstHourQuery(
  sitePk: number,
  endExclusiveMs: number,
  status: "open" | "closed",
) {
  const visitTable = scan(schema.visits);
  const visits = project(visitTable, {
    site_pk: visitTable.columns.site_pk,
    started_at: visitTable.columns.started_at,
    status: visitTable.columns.status,
  });
  const conditions = [
    eq(visits.columns.site_pk, param(sitePk)),
    lt(visits.columns.started_at, param(endExclusiveMs)),
    status === "open"
      ? eq(visits.columns.status, param("open"))
      : neq(visits.columns.status, param("open")),
  ] as const;
  const matching = filter(visits, and(...conditions));
  const earliest = limit(
    sort(matching, [
      { expression: matching.columns.started_at, direction: "ASC" },
    ]),
    1,
  );
  return project(earliest, {
    hourBucket: castInteger(
      div(earliest.columns.started_at, param(ONE_HOUR_MS)),
    ),
  });
}

export function firstClosedHourQuery(sitePk: number, endExclusiveMs: number) {
  return compileD1Query(firstHourQuery(sitePk, endExclusiveMs, "closed"), {
    tag: "scheduled-tasks.visits.first",
  });
}

export function firstOpenHourQuery(sitePk: number, endExclusiveMs: number) {
  return compileD1Query(firstHourQuery(sitePk, endExclusiveMs, "open"), {
    tag: "scheduled-tasks.visits.first",
  });
}

export function aggregationStatesQuery(siteIds: readonly string[]) {
  const stateTable = scan(schema.visit_hourly_aggregation_state);
  const states = project(stateTable, {
    site_pk: stateTable.columns.site_pk,
    site_id: stateTable.columns.site_id,
    aggregated_until_hour: stateTable.columns.aggregated_until_hour,
  });
  const requested = filter(
    states,
    inSubquery(states.columns.site_pk, sitePksForSiteIds(siteIds)),
  );
  return compileD1Query(
    project(requested, {
      siteId: requested.columns.site_id,
      aggregatedUntilHour: requested.columns.aggregated_until_hour,
    }),
    { tag: "analytics.visit_hourly_aggregation_state.all" },
  );
}

export function detailVisitsQuery(
  siteIds: readonly string[],
  window: QueryWindow,
  orderByStartedAt = false,
) {
  const visitTable = scan(schema.visits);
  const visits = project(visitTable, {
    site_pk: visitTable.columns.site_pk,
    site_id: visitTable.columns.site_id,
    started_at: visitTable.columns.started_at,
    visitor_id: visitTable.columns.visitor_id,
    session_id: visitTable.columns.session_id,
    duration_ms: visitTable.columns.duration_ms,
    perf_ttfb_ms: visitTable.columns.perf_ttfb_ms,
    perf_fcp_ms: visitTable.columns.perf_fcp_ms,
    perf_lcp_ms: visitTable.columns.perf_lcp_ms,
    perf_cls: visitTable.columns.perf_cls,
    perf_inp_ms: visitTable.columns.perf_inp_ms,
  });
  const matching = filter(
    visits,
    and(
      inSubquery(visits.columns.site_pk, sitePksForSiteIds(siteIds)),
      gte(visits.columns.started_at, param(window.startMs)),
      lt(visits.columns.started_at, param(window.endExclusiveMs)),
    ),
  );
  const projected = project(matching, {
    siteId: matching.columns.site_id,
    startedAt: matching.columns.started_at,
    visitorId: coalesce(matching.columns.visitor_id, param("")),
    sessionId: coalesce(matching.columns.session_id, param("")),
    durationMs: matching.columns.duration_ms,
    perfTtfbMs: matching.columns.perf_ttfb_ms,
    perfFcpMs: matching.columns.perf_fcp_ms,
    perfLcpMs: matching.columns.perf_lcp_ms,
    perfCls: matching.columns.perf_cls,
    perfInpMs: matching.columns.perf_inp_ms,
  });
  const ordered = orderByStartedAt
    ? sort(projected, [
        { expression: projected.columns.startedAt, direction: "ASC" },
      ])
    : projected;
  return compileD1Query(ordered, { tag: "analytics.visits.all" });
}

export function storedRollupsQuery(
  siteIds: readonly string[],
  startHour: number,
  endExclusiveHour: number,
): CompiledQuery<StoredRollupRow> {
  const rollupTable = scan(schema.visit_hourly_rollups);
  const rollups = project(rollupTable, {
    site_pk: rollupTable.columns.site_pk,
    site_id: rollupTable.columns.site_id,
    hour_bucket: rollupTable.columns.hour_bucket,
    views: rollupTable.columns.views,
    sessions: rollupTable.columns.sessions,
    visitors: rollupTable.columns.visitors,
    bounces: rollupTable.columns.bounces,
    duration_ms_sum: rollupTable.columns.duration_ms_sum,
    duration_ms_count: rollupTable.columns.duration_ms_count,
    visitor_set_json: rollupTable.columns.visitor_set_json,
    session_counts_json: rollupTable.columns.session_counts_json,
    perf_ttfb_sum: rollupTable.columns.perf_ttfb_sum,
    perf_ttfb_count: rollupTable.columns.perf_ttfb_count,
    perf_fcp_sum: rollupTable.columns.perf_fcp_sum,
    perf_fcp_count: rollupTable.columns.perf_fcp_count,
    perf_lcp_sum: rollupTable.columns.perf_lcp_sum,
    perf_lcp_count: rollupTable.columns.perf_lcp_count,
    perf_cls_sum: rollupTable.columns.perf_cls_sum,
    perf_cls_count: rollupTable.columns.perf_cls_count,
    perf_inp_sum: rollupTable.columns.perf_inp_sum,
    perf_inp_count: rollupTable.columns.perf_inp_count,
  });
  const matching = filter(
    rollups,
    and(
      inSubquery(rollups.columns.site_pk, sitePksForSiteIds(siteIds)),
      gte(rollups.columns.hour_bucket, param(startHour)),
      lt(rollups.columns.hour_bucket, param(endExclusiveHour)),
    ),
  );
  const projected = project(matching, {
    siteId: matching.columns.site_id,
    hourBucket: matching.columns.hour_bucket,
    views: matching.columns.views,
    sessions: matching.columns.sessions,
    visitors: matching.columns.visitors,
    bounces: matching.columns.bounces,
    durationMsSum: matching.columns.duration_ms_sum,
    durationMsCount: matching.columns.duration_ms_count,
    visitorSetJson: matching.columns.visitor_set_json,
    sessionCountsJson: matching.columns.session_counts_json,
    perfTtfbSum: matching.columns.perf_ttfb_sum,
    perfTtfbCount: matching.columns.perf_ttfb_count,
    perfFcpSum: matching.columns.perf_fcp_sum,
    perfFcpCount: matching.columns.perf_fcp_count,
    perfLcpSum: matching.columns.perf_lcp_sum,
    perfLcpCount: matching.columns.perf_lcp_count,
    perfClsSum: matching.columns.perf_cls_sum,
    perfClsCount: matching.columns.perf_cls_count,
    perfInpSum: matching.columns.perf_inp_sum,
    perfInpCount: matching.columns.perf_inp_count,
  });
  const ordered = sort(projected, [
    { expression: projected.columns.hourBucket, direction: "ASC" },
  ]);
  return compileD1Query(ordered, {
    tag: "analytics.visit_hourly_rollups.all",
  });
}
