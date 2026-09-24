import {
  type AggregateSiteHourMetricRow,
  ROLLUP_LAG_HOURS,
  ROLLUP_SCHEMA_VERSION,
  type StoredRollupRow,
} from "@/lib/edge/analytics/contract/hourly-rollup";
import type { Env } from "@/lib/edge/types";
import { ONE_HOUR_MS } from "@/lib/edge/utils";

import type { ScheduledTaskLogger, ScheduledTaskOutcome } from "./runner";
const ROLLUP_MAX_HOURS_PER_SITE = 24 * 7;
interface HourlyAggregationOptions {
  logger?: ScheduledTaskLogger;
}
interface HourlyAggregationSummary {
  cutoffMs: number;
  endHour: number;
  staleOpenVisitsFinalized: number;
  candidateSites: number;
  sitesProcessed: number;
  sitesSkippedNoClosedVisit: number;
  sitesAlreadyCurrent: number;
  sitesBlockedByOpenVisit: number;
  sitesFailed: number;
  hoursAggregated: number;
  rollupRowsWritten: number;
}
interface AggregationCandidateRow {
  siteId: string;
  sitePk: number;
  aggregatedUntilHour: number | null;
  lastError: string | null;
}
interface HourBucketRow {
  hourBucket: number | null;
}
async function listAggregationCandidates(
  env: Env,
  endHour: number,
): Promise<AggregationCandidateRow[]> {
  const endExclusiveMs = (endHour + 1) * ONE_HOUR_MS;
  const result = await env.DB.prepare(
    `
      SELECT
        s.id AS siteId,
        si.site_pk AS sitePk,
        st.aggregated_until_hour AS aggregatedUntilHour,
        st.last_error AS lastError
      FROM sites s
      INNER JOIN site_identities si
        ON si.site_id = s.id
      LEFT JOIN visit_hourly_aggregation_state st
        ON st.site_pk = si.site_pk
      WHERE st.site_pk IS NOT NULL
         OR EXISTS (
           SELECT 1
           FROM visits v
           WHERE v.site_pk = si.site_pk
             AND v.started_at < ?
           LIMIT 1
         )
      ORDER BY COALESCE(st.last_success_at, 0) ASC, s.id ASC
    `,
  )
    .bind(endExclusiveMs)
    .all<AggregationCandidateRow>();
  return result.results.map((row) => ({
    siteId: String(row.siteId ?? ""),
    sitePk: Number(row.sitePk),
    aggregatedUntilHour:
      row.aggregatedUntilHour === null || row.aggregatedUntilHour === undefined
        ? null
        : Number(row.aggregatedUntilHour),
    lastError:
      row.lastError === null || row.lastError === undefined
        ? null
        : String(row.lastError),
  }));
}
async function readFirstClosedHour(
  env: Env,
  sitePk: number,
  endHour: number,
): Promise<number | null> {
  const endExclusiveMs = (endHour + 1) * ONE_HOUR_MS;
  const row = await env.DB.prepare(
    `
      SELECT CAST(started_at / ? AS INTEGER) AS hourBucket
      FROM visits
      WHERE site_pk = ?
        AND started_at < ?
        AND status != 'open'
      ORDER BY started_at ASC
      LIMIT 1
    `,
  )
    .bind(ONE_HOUR_MS, sitePk, endExclusiveMs)
    .first<HourBucketRow>();
  if (!row || row.hourBucket === null || row.hourBucket === undefined) {
    return null;
  }
  const hour = Number(row.hourBucket);
  return Number.isFinite(hour) ? hour : null;
}
async function readFirstOpenHour(
  env: Env,
  sitePk: number,
  endHour: number,
): Promise<number | null> {
  const endExclusiveMs = (endHour + 1) * ONE_HOUR_MS;
  const row = await env.DB.prepare(
    `
      SELECT CAST(started_at / ? AS INTEGER) AS hourBucket
      FROM visits
      WHERE site_pk = ?
        AND status = 'open'
        AND started_at < ?
      ORDER BY started_at ASC
      LIMIT 1
    `,
  )
    .bind(ONE_HOUR_MS, sitePk, endExclusiveMs)
    .first<HourBucketRow>();
  if (!row || row.hourBucket === null || row.hourBucket === undefined) {
    return null;
  }
  const hour = Number(row.hourBucket);
  return Number.isFinite(hour) ? hour : null;
}
async function finalizeStaleOpenVisits(
  env: Env,
  cutoffMs: number,
  finalizedAt: number,
): Promise<number> {
  const result = await env.DB.prepare(
    `
      UPDATE visits
      SET status = 'timeout',
          last_activity_at = ?,
          ended_at = ?,
          finalized_at = ?,
          duration_ms = NULL,
          duration_source = 'timeout'
      WHERE status = 'open'
        AND last_activity_at < ?
    `,
  )
    .bind(finalizedAt, finalizedAt, finalizedAt, cutoffMs)
    .run();
  return Number(result.meta.changes ?? 0);
}
async function aggregateSiteHours(
  env: Env,
  siteId: string,
  sitePk: number,
  startHour: number,
  endHour: number,
  inputCutoffMs: number,
): Promise<number> {
  if (endHour < startHour) return 0;
  const startMs = startHour * ONE_HOUR_MS;
  const endExclusiveMs = (endHour + 1) * ONE_HOUR_MS;
  const metrics = await env.DB.prepare(
    `
      WITH base_visits AS MATERIALIZED (
        SELECT
          site_id AS siteId,
          CAST(started_at / ? AS INTEGER) AS hourBucket,
          duration_ms,
          perf_ttfb_ms,
          perf_fcp_ms,
          perf_lcp_ms,
          perf_cls,
          perf_inp_ms,
          visitor_id,
          session_id
        FROM visits
        WHERE site_pk = ?
          AND started_at >= ?
          AND started_at < ?
          AND status != 'open'
      )
      SELECT
        'basic' AS metric,
        siteId,
        hourBucket,
        COUNT(*) AS views,
        COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN duration_ms ELSE 0 END), 0) AS durationMsSum,
        COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL AND duration_ms >= 0 THEN 1 ELSE 0 END), 0) AS durationMsCount,
        COALESCE(SUM(CASE WHEN perf_ttfb_ms IS NOT NULL THEN perf_ttfb_ms ELSE 0 END), 0) AS perfTtfbSum,
        COALESCE(SUM(CASE WHEN perf_ttfb_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfTtfbCount,
        COALESCE(SUM(CASE WHEN perf_fcp_ms IS NOT NULL THEN perf_fcp_ms ELSE 0 END), 0) AS perfFcpSum,
        COALESCE(SUM(CASE WHEN perf_fcp_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfFcpCount,
        COALESCE(SUM(CASE WHEN perf_lcp_ms IS NOT NULL THEN perf_lcp_ms ELSE 0 END), 0) AS perfLcpSum,
        COALESCE(SUM(CASE WHEN perf_lcp_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfLcpCount,
        COALESCE(SUM(CASE WHEN perf_cls IS NOT NULL THEN perf_cls ELSE 0 END), 0) AS perfClsSum,
        COALESCE(SUM(CASE WHEN perf_cls IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfClsCount,
        COALESCE(SUM(CASE WHEN perf_inp_ms IS NOT NULL THEN perf_inp_ms ELSE 0 END), 0) AS perfInpSum,
        COALESCE(SUM(CASE WHEN perf_inp_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS perfInpCount,
        CAST(NULL AS TEXT) AS visitorId,
        CAST(NULL AS TEXT) AS sessionId,
        CAST(NULL AS INTEGER) AS visitCount
      FROM base_visits
      GROUP BY siteId, hourBucket

      UNION ALL

      SELECT
        'visitor' AS metric,
        siteId,
        hourBucket,
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        visitor_id AS visitorId,
        CAST(NULL AS TEXT) AS sessionId,
        CAST(NULL AS INTEGER) AS visitCount
      FROM base_visits
      WHERE TRIM(COALESCE(visitor_id, '')) != ''
      GROUP BY siteId, hourBucket, visitor_id

      UNION ALL

      SELECT
        'session' AS metric,
        siteId,
        hourBucket,
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS INTEGER),
        CAST(NULL AS TEXT) AS visitorId,
        session_id AS sessionId,
        COUNT(*) AS visitCount
      FROM base_visits
      WHERE TRIM(COALESCE(session_id, '')) != ''
      GROUP BY siteId, hourBucket, session_id
      ORDER BY metric ASC, hourBucket ASC, visitorId ASC, sessionId ASC
    `,
  )
    .bind(ONE_HOUR_MS, sitePk, startMs, endExclusiveMs)
    .all<AggregateSiteHourMetricRow>();
  const byHour = new Map<number, StoredRollupRow>();
  for (const row of metrics.results.filter((item) => item.metric === "basic")) {
    byHour.set(Number(row.hourBucket), {
      siteId,
      hourBucket: Number(row.hourBucket),
      views: Number(row.views ?? 0),
      sessions: 0,
      visitors: 0,
      bounces: 0,
      durationMsSum: Number(row.durationMsSum ?? 0),
      durationMsCount: Number(row.durationMsCount ?? 0),
      visitorSetJson: "[]",
      sessionCountsJson: "[]",
      perfTtfbSum: Number(row.perfTtfbSum ?? 0),
      perfTtfbCount: Number(row.perfTtfbCount ?? 0),
      perfFcpSum: Number(row.perfFcpSum ?? 0),
      perfFcpCount: Number(row.perfFcpCount ?? 0),
      perfLcpSum: Number(row.perfLcpSum ?? 0),
      perfLcpCount: Number(row.perfLcpCount ?? 0),
      perfClsSum: Number(row.perfClsSum ?? 0),
      perfClsCount: Number(row.perfClsCount ?? 0),
      perfInpSum: Number(row.perfInpSum ?? 0),
      perfInpCount: Number(row.perfInpCount ?? 0),
    });
  }

  const visitorsByHour = new Map<number, string[]>();
  for (const row of metrics.results.filter(
    (item) => item.metric === "visitor",
  )) {
    const hour = Number(row.hourBucket);
    const list = visitorsByHour.get(hour) ?? [];
    list.push(String(row.visitorId ?? ""));
    visitorsByHour.set(hour, list);
  }

  const sessionsByHour = new Map<number, Array<[string, number]>>();
  for (const row of metrics.results.filter(
    (item) => item.metric === "session",
  )) {
    const hour = Number(row.hourBucket);
    const list = sessionsByHour.get(hour) ?? [];
    list.push([String(row.sessionId ?? ""), Number(row.visitCount ?? 0)]);
    sessionsByHour.set(hour, list);
  }

  const statements: D1PreparedStatement[] = [];
  for (const [hour, rollup] of byHour.entries()) {
    const visitorIds = Array.from(new Set(visitorsByHour.get(hour) ?? []))
      .map((value) => value.trim())
      .filter(Boolean)
      .sort();
    const sessionCounts = (sessionsByHour.get(hour) ?? [])
      .map(
        ([sessionId, count]) =>
          [sessionId.trim(), Math.max(0, count)] as [string, number],
      )
      .filter(([sessionId, count]) => sessionId.length > 0 && count > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    const bounces = sessionCounts.filter(([, count]) => count === 1).length;
    statements.push(
      env.DB.prepare(
        `
          INSERT INTO visit_hourly_rollups (
            site_id, site_pk, hour_bucket, views, sessions, visitors, bounces,
            duration_ms_sum, duration_ms_count, visitor_set_json,
            session_counts_json, perf_ttfb_sum, perf_ttfb_count,
            perf_fcp_sum, perf_fcp_count, perf_lcp_sum, perf_lcp_count,
            perf_cls_sum, perf_cls_count, perf_inp_sum, perf_inp_count,
            input_cutoff_ms, aggregated_at, schema_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)
          ON CONFLICT(site_pk, hour_bucket) DO UPDATE SET
            site_pk = excluded.site_pk,
            views = excluded.views,
            sessions = excluded.sessions,
            visitors = excluded.visitors,
            bounces = excluded.bounces,
            duration_ms_sum = excluded.duration_ms_sum,
            duration_ms_count = excluded.duration_ms_count,
            visitor_set_json = excluded.visitor_set_json,
            session_counts_json = excluded.session_counts_json,
            perf_ttfb_sum = excluded.perf_ttfb_sum,
            perf_ttfb_count = excluded.perf_ttfb_count,
            perf_fcp_sum = excluded.perf_fcp_sum,
            perf_fcp_count = excluded.perf_fcp_count,
            perf_lcp_sum = excluded.perf_lcp_sum,
            perf_lcp_count = excluded.perf_lcp_count,
            perf_cls_sum = excluded.perf_cls_sum,
            perf_cls_count = excluded.perf_cls_count,
            perf_inp_sum = excluded.perf_inp_sum,
            perf_inp_count = excluded.perf_inp_count,
            input_cutoff_ms = excluded.input_cutoff_ms,
            aggregated_at = excluded.aggregated_at,
            schema_version = excluded.schema_version
        `,
      ).bind(
        siteId,
        sitePk,
        hour,
        rollup.views,
        sessionCounts.length,
        visitorIds.length,
        bounces,
        rollup.durationMsSum,
        rollup.durationMsCount,
        JSON.stringify(visitorIds),
        JSON.stringify(sessionCounts),
        rollup.perfTtfbSum,
        rollup.perfTtfbCount,
        rollup.perfFcpSum,
        rollup.perfFcpCount,
        rollup.perfLcpSum,
        rollup.perfLcpCount,
        rollup.perfClsSum,
        rollup.perfClsCount,
        rollup.perfInpSum,
        rollup.perfInpCount,
        inputCutoffMs,
        ROLLUP_SCHEMA_VERSION,
      ),
    );
  }

  statements.push(
    env.DB.prepare(
      `
        INSERT INTO visit_hourly_aggregation_state (
          site_id, site_pk, aggregated_until_hour, lag_hours, last_run_at,
          last_success_at, last_error
        ) VALUES (?, ?, ?, ?, unixepoch(), unixepoch(), NULL)
        ON CONFLICT(site_pk) DO UPDATE SET
          site_pk = excluded.site_pk,
          aggregated_until_hour = excluded.aggregated_until_hour,
          lag_hours = excluded.lag_hours,
          last_run_at = excluded.last_run_at,
          last_success_at = excluded.last_success_at,
          last_error = NULL
      `,
    ).bind(siteId, sitePk, endHour, ROLLUP_LAG_HOURS),
  );

  await env.DB.batch(statements);
  return byHour.size;
}
async function markAggregationFailed(
  env: Env,
  siteId: string,
  sitePk: number,
  error: unknown,
): Promise<void> {
  const message = String(error instanceof Error ? error.message : error).slice(
    0,
    400,
  );
  await env.DB.prepare(
    `
      INSERT INTO visit_hourly_aggregation_state (
        site_id, site_pk, aggregated_until_hour, lag_hours, last_run_at, last_error
      ) VALUES (?, ?, 0, ?, unixepoch(), ?)
      ON CONFLICT(site_pk) DO UPDATE SET
        site_pk = excluded.site_pk,
        last_run_at = excluded.last_run_at,
        last_error = excluded.last_error
    `,
  )
    .bind(siteId, sitePk, ROLLUP_LAG_HOURS, message)
    .run();
}
export async function runHourlyAggregation(
  env: Env,
  scheduledTime?: number,
  options: HourlyAggregationOptions = {},
): Promise<ScheduledTaskOutcome> {
  const nowMs =
    typeof scheduledTime === "number" && Number.isFinite(scheduledTime)
      ? scheduledTime
      : Date.now();
  const cutoffMs = nowMs - ROLLUP_LAG_HOURS * ONE_HOUR_MS;
  const endHour = Math.floor(cutoffMs / ONE_HOUR_MS) - 1;
  const summary: HourlyAggregationSummary = {
    cutoffMs,
    endHour,
    staleOpenVisitsFinalized: 0,
    candidateSites: 0,
    sitesProcessed: 0,
    sitesSkippedNoClosedVisit: 0,
    sitesAlreadyCurrent: 0,
    sitesBlockedByOpenVisit: 0,
    sitesFailed: 0,
    hoursAggregated: 0,
    rollupRowsWritten: 0,
  };
  if (endHour < 0) {
    await options.logger?.info(
      "aggregation_skipped",
      "Cutoff is before epoch",
      {
        cutoffMs,
        endHour,
      },
    );
    return { status: "skipped", summary: { ...summary } };
  }

  summary.staleOpenVisitsFinalized = await finalizeStaleOpenVisits(
    env,
    cutoffMs,
    nowMs,
  );

  const candidates = await listAggregationCandidates(env, endHour);
  summary.candidateSites = candidates.length;
  await options.logger?.info(
    "aggregation_candidates",
    "Aggregation candidates loaded",
    {
      candidateSites: candidates.length,
      endHour,
      lagHours: ROLLUP_LAG_HOURS,
      maxHoursPerSite: ROLLUP_MAX_HOURS_PER_SITE,
      staleOpenVisitsFinalized: summary.staleOpenVisitsFinalized,
    },
  );

  for (const site of candidates) {
    if (!site.siteId) continue;
    if (
      site.aggregatedUntilHour !== null &&
      Number.isFinite(site.aggregatedUntilHour) &&
      site.aggregatedUntilHour >= endHour &&
      site.lastError === null
    ) {
      summary.sitesAlreadyCurrent += 1;
      continue;
    }
    const firstClosedHour = await readFirstClosedHour(
      env,
      site.sitePk,
      endHour,
    );
    if (firstClosedHour === null) {
      summary.sitesSkippedNoClosedVisit += 1;
      continue;
    }
    const startHour =
      site.aggregatedUntilHour === null
        ? firstClosedHour
        : Math.max(firstClosedHour, site.aggregatedUntilHour + 1);
    if (startHour > endHour) {
      summary.sitesAlreadyCurrent += 1;
      continue;
    }
    const batchEndHour = Math.min(
      endHour,
      startHour + ROLLUP_MAX_HOURS_PER_SITE - 1,
    );
    const minOpenHour = await readFirstOpenHour(env, site.sitePk, batchEndHour);
    const safeEndHour =
      minOpenHour !== null && minOpenHour <= batchEndHour
        ? minOpenHour - 1
        : batchEndHour;
    if (safeEndHour < startHour) {
      summary.sitesBlockedByOpenVisit += 1;
      continue;
    }
    try {
      const rollupRowsWritten = await aggregateSiteHours(
        env,
        site.siteId,
        site.sitePk,
        startHour,
        safeEndHour,
        cutoffMs,
      );
      summary.sitesProcessed += 1;
      summary.hoursAggregated += safeEndHour - startHour + 1;
      summary.rollupRowsWritten += rollupRowsWritten;
    } catch (error) {
      summary.sitesFailed += 1;
      await options.logger?.error(
        "site_aggregation_failed",
        "Failed to aggregate a site",
        {
          siteId: site.siteId,
          startHour,
          endHour: safeEndHour,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await markAggregationFailed(env, site.siteId, site.sitePk, error);
    }
  }
  const status =
    summary.sitesFailed > 0
      ? "partial"
      : summary.sitesProcessed > 0
        ? "success"
        : "skipped";
  await options.logger?.info("aggregation_summary", "Aggregation completed", {
    status,
    candidateSites: summary.candidateSites,
    sitesProcessed: summary.sitesProcessed,
    sitesFailed: summary.sitesFailed,
    hoursAggregated: summary.hoursAggregated,
    rollupRowsWritten: summary.rollupRowsWritten,
    staleOpenVisitsFinalized: summary.staleOpenVisitsFinalized,
  });
  return { status, summary: { ...summary } };
}
