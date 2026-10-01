import {
  and,
  compileD1Mutation,
  eq,
  insert,
  lt,
  onConflictDoUpdate,
  param,
  unixepoch,
  update,
} from "@/lib/db";
import type { CompiledMutation } from "@/lib/db/mutation/plan";
import { schema } from "@/lib/db/schema";
import {
  ROLLUP_LAG_HOURS,
  ROLLUP_SCHEMA_VERSION,
  type StoredRollupRow,
} from "@/lib/edge/analytics/contract/hourly-rollup";

export function prepareFinalizeStaleOpenVisitsMutation(
  cutoffMs: number,
  finalizedAt: number,
): CompiledMutation {
  return compileD1Mutation(
    update(schema.visits, (columns) => ({
      set: {
        status: "timeout",
        last_activity_at: finalizedAt,
        ended_at: finalizedAt,
        finalized_at: finalizedAt,
        duration_ms: null,
        duration_source: "timeout",
      },
      where: and(
        eq(columns.status, param("open")),
        lt(columns.last_activity_at, param(cutoffMs)),
      ),
    })),
    { tag: "scheduled_tasks.hourly_rollup.finalize_stale_visits" },
  );
}

export function prepareAggregationSuccessMutations(
  siteId: string,
  sitePk: number,
  endHour: number,
  inputCutoffMs: number,
  rollups: ReadonlyMap<number, StoredRollupRow>,
): CompiledMutation[] {
  const mutations: CompiledMutation[] = [];
  for (const [hour, rollup] of rollups) {
    const insertPlan = insert(schema.visit_hourly_rollups, {
      site_id: siteId,
      site_pk: sitePk,
      hour_bucket: hour,
      views: rollup.views,
      sessions: rollup.sessions,
      visitors: rollup.visitors,
      bounces: rollup.bounces,
      duration_ms_sum: rollup.durationMsSum,
      duration_ms_count: rollup.durationMsCount,
      visitor_set_json: rollup.visitorSetJson,
      session_counts_json: rollup.sessionCountsJson,
      perf_ttfb_sum: rollup.perfTtfbSum,
      perf_ttfb_count: rollup.perfTtfbCount,
      perf_fcp_sum: rollup.perfFcpSum,
      perf_fcp_count: rollup.perfFcpCount,
      perf_lcp_sum: rollup.perfLcpSum,
      perf_lcp_count: rollup.perfLcpCount,
      perf_cls_sum: rollup.perfClsSum,
      perf_cls_count: rollup.perfClsCount,
      perf_inp_sum: rollup.perfInpSum,
      perf_inp_count: rollup.perfInpCount,
      input_cutoff_ms: inputCutoffMs,
      aggregated_at: unixepoch(),
      schema_version: ROLLUP_SCHEMA_VERSION,
    });
    mutations.push(
      compileD1Mutation(
        onConflictDoUpdate(insertPlan, ["site_pk", "hour_bucket"], {
          site_pk: sitePk,
          views: rollup.views,
          sessions: rollup.sessions,
          visitors: rollup.visitors,
          bounces: rollup.bounces,
          duration_ms_sum: rollup.durationMsSum,
          duration_ms_count: rollup.durationMsCount,
          visitor_set_json: rollup.visitorSetJson,
          session_counts_json: rollup.sessionCountsJson,
          perf_ttfb_sum: rollup.perfTtfbSum,
          perf_ttfb_count: rollup.perfTtfbCount,
          perf_fcp_sum: rollup.perfFcpSum,
          perf_fcp_count: rollup.perfFcpCount,
          perf_lcp_sum: rollup.perfLcpSum,
          perf_lcp_count: rollup.perfLcpCount,
          perf_cls_sum: rollup.perfClsSum,
          perf_cls_count: rollup.perfClsCount,
          perf_inp_sum: rollup.perfInpSum,
          perf_inp_count: rollup.perfInpCount,
          input_cutoff_ms: inputCutoffMs,
          aggregated_at: unixepoch(),
          schema_version: ROLLUP_SCHEMA_VERSION,
        }),
        { tag: "scheduled_tasks.hourly_rollup.upsert_hour" },
      ),
    );
  }

  const stateInsert = insert(schema.visit_hourly_aggregation_state, {
    site_id: siteId,
    site_pk: sitePk,
    aggregated_until_hour: endHour,
    lag_hours: ROLLUP_LAG_HOURS,
    last_run_at: unixepoch(),
    last_success_at: unixepoch(),
    last_error: null,
  });
  mutations.push(
    compileD1Mutation(
      onConflictDoUpdate(stateInsert, ["site_pk"], {
        site_pk: sitePk,
        aggregated_until_hour: endHour,
        lag_hours: ROLLUP_LAG_HOURS,
        last_run_at: unixepoch(),
        last_success_at: unixepoch(),
        last_error: null,
      }),
      { tag: "scheduled_tasks.hourly_rollup.update_state" },
    ),
  );
  return mutations;
}

export function prepareAggregationFailureMutation(
  siteId: string,
  sitePk: number,
  message: string,
): CompiledMutation {
  const insertPlan = insert(schema.visit_hourly_aggregation_state, {
    site_id: siteId,
    site_pk: sitePk,
    aggregated_until_hour: 0,
    lag_hours: ROLLUP_LAG_HOURS,
    last_run_at: unixepoch(),
    last_error: message,
  });
  return compileD1Mutation(
    onConflictDoUpdate(insertPlan, ["site_pk"], {
      site_pk: sitePk,
      last_run_at: unixepoch(),
      last_error: message,
    }),
    { tag: "scheduled_tasks.hourly_rollup.mark_failed" },
  );
}
