import { createD1DatabaseClient } from "@/lib/db";
import {
  type AggregateSiteHourMetricRow,
  ROLLUP_LAG_HOURS,
  type StoredRollupRow,
} from "@/lib/edge/analytics/contract/hourly-rollup";
import {
  aggregationCandidateQuery,
  firstClosedHourQuery,
  firstOpenHourQuery,
} from "@/lib/edge/analytics/providers/d1/internal/hourly-rollup-read-plans";
import type { Env } from "@/lib/edge/types";
import { ONE_HOUR_MS } from "@/lib/edge/utils";

import { buildHourlyRollupMetricPlan } from "./hourly-rollup-metric-plan";
import {
  prepareAggregationFailureMutation,
  prepareAggregationSuccessMutations,
  prepareFinalizeStaleOpenVisitsMutation,
} from "./hourly-rollup-persistence";
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
async function listAggregationCandidates(
  env: Env,
  endHour: number,
): Promise<AggregationCandidateRow[]> {
  const endExclusiveMs = (endHour + 1) * ONE_HOUR_MS;
  const result = await createD1DatabaseClient(env.DB).all(
    aggregationCandidateQuery(endExclusiveMs),
  );
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
  const row = await createD1DatabaseClient(env.DB).first(
    firstClosedHourQuery(sitePk, endExclusiveMs),
  );
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
  const row = await createD1DatabaseClient(env.DB).first(
    firstOpenHourQuery(sitePk, endExclusiveMs),
  );
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
  const result = await createD1DatabaseClient(env.DB).run(
    prepareFinalizeStaleOpenVisitsMutation(cutoffMs, finalizedAt),
  );
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
  const metricResult = await createD1DatabaseClient(env.DB).all(
    buildHourlyRollupMetricPlan(sitePk, startHour, endHour),
  );
  const metrics = {
    ...metricResult,
    results: metricResult.results.map((row): AggregateSiteHourMetricRow => ({
      ...row,
      hourBucket: Number(row.hourBucket),
    })),
  };
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

  const rollupsToWrite = new Map<number, StoredRollupRow>();
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
    rollupsToWrite.set(hour, {
      ...rollup,
      sessions: sessionCounts.length,
      visitors: visitorIds.length,
      bounces,
      visitorSetJson: JSON.stringify(visitorIds),
      sessionCountsJson: JSON.stringify(sessionCounts),
    });
  }
  const mutations = prepareAggregationSuccessMutations(
    siteId,
    sitePk,
    endHour,
    inputCutoffMs,
    rollupsToWrite,
  );
  await createD1DatabaseClient(env.DB).batch(mutations);
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
  await createD1DatabaseClient(env.DB).run(
    prepareAggregationFailureMutation(siteId, sitePk, message),
  );
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
