import { bad, forb, jsonResponseFor, na, nf } from "@/lib/response";
import type {
  DoDiagnosticAggregate,
  DoDiagnosticPayload,
  DoDiagnosticSiteEntry,
  SystemPerformanceData,
  SystemPerformanceWindowMinutes,
} from "@/lib/system-performance";

import { parseJson } from "./admin-response";
import type { Env } from "./types";
import { clampString } from "./utils";

type AdminActor = { isAdmin: boolean };
type AdminActorResolver = (
  env: Env,
  req: Request,
) => Promise<AdminActor | Response>;

const SYSTEM_PERFORMANCE_WINDOW_OPTIONS = [15, 60, 360, 1440] as const;
const SYSTEM_DELAYED_EVENT_MS = 5 * 60 * 1000;
const SYSTEM_FUTURE_SKEW_MS = 30 * 1000;
const SYSTEM_TRUSTED_LATENCY_MAX_MS = 24 * 60 * 60 * 1000;
const SYSTEM_STALE_OPEN_VISIT_MS = 30 * 60 * 1000;
const SYSTEM_TIMED_OUT_OPEN_VISIT_MS = 12 * 60 * 60 * 1000;

const SYSTEM_EVENTS_CTE = `
  WITH raw_events AS (
    SELECT
      'visit' AS kind,
      site_id AS siteId,
      started_at AS eventAtMs,
      created_at * 1000 AS serverAtMs,
      created_at AS createdAtSec
    FROM visits
    WHERE created_at >= ? AND created_at <= ?
    UNION ALL
    SELECT
      'custom_event' AS kind,
      site_id AS siteId,
      occurred_at AS eventAtMs,
      created_at * 1000 AS serverAtMs,
      created_at AS createdAtSec
    FROM custom_events
    WHERE created_at >= ? AND created_at <= ?
  ),
  events AS (
    SELECT
      kind,
      siteId,
      eventAtMs,
      serverAtMs,
      createdAtSec,
      serverAtMs - eventAtMs AS latencyMs
    FROM raw_events
  )
`;

const SYSTEM_EVENTS_MATERIALIZED_CTE = SYSTEM_EVENTS_CTE.replace(
  "events AS (",
  "events AS MATERIALIZED (",
);

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toNullableNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseSystemPerformanceWindowMinutes(
  url: URL,
): SystemPerformanceWindowMinutes {
  const value = Number(url.searchParams.get("minutes") || "60");
  return SYSTEM_PERFORMANCE_WINDOW_OPTIONS.includes(
    value as SystemPerformanceWindowMinutes,
  )
    ? (value as SystemPerformanceWindowMinutes)
    : 60;
}

function systemPerformanceBucketSizeSeconds(
  minutes: SystemPerformanceWindowMinutes,
): number {
  if (minutes <= 15) return 60;
  if (minutes <= 60) return 5 * 60;
  if (minutes <= 360) return 30 * 60;
  return 60 * 60;
}

function systemWindowBindings(fromSec: number, toSec: number): number[] {
  return [fromSec, toSec, fromSec, toSec];
}

export async function handleSystemPerformanceAdmin(
  req: Request,
  env: Env,
  url: URL,
  requireActor: AdminActorResolver,
): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (!a.isAdmin)
    return forb(
      "Only system admin can view system performance",
      undefined,
      req,
    );
  if (req.method !== "GET") return na(req);

  const minutes = parseSystemPerformanceWindowMinutes(url);
  const generatedAt = Date.now();
  const from = generatedAt - minutes * 60 * 1000;
  const fromSec = Math.max(0, Math.floor(from / 1000));
  const toSec = Math.ceil(generatedAt / 1000);
  const bucketSizeSec = systemPerformanceBucketSizeSeconds(minutes);
  const eventBindings = systemWindowBindings(fromSec, toSec);

  const [
    summaryRow,
    percentileRow,
    trendRows,
    topSiteRows,
    slowEventRows,
    openVisitRow,
  ] = await Promise.all([
    env.DB.prepare(
      `
        ${SYSTEM_EVENTS_CTE}
        SELECT
          COUNT(*) AS totalEvents,
          SUM(CASE WHEN kind = 'visit' THEN 1 ELSE 0 END) AS visits,
          SUM(CASE WHEN kind = 'custom_event' THEN 1 ELSE 0 END) AS customEvents,
          COUNT(DISTINCT siteId) AS activeSites,
          AVG(CASE WHEN latencyMs >= 0 AND latencyMs <= ? THEN latencyMs END) AS avgLatencyMs,
          SUM(CASE WHEN latencyMs >= 0 AND latencyMs <= ? THEN 1 ELSE 0 END) AS trustedLatencySamples,
          SUM(CASE WHEN latencyMs > ? THEN 1 ELSE 0 END) AS delayedEvents,
          SUM(CASE WHEN latencyMs < -? THEN 1 ELSE 0 END) AS futureSkewedEvents,
          MAX(createdAtSec) AS latestCreatedAtSec
        FROM events
      `,
    )
      .bind(
        ...eventBindings,
        SYSTEM_TRUSTED_LATENCY_MAX_MS,
        SYSTEM_TRUSTED_LATENCY_MAX_MS,
        SYSTEM_DELAYED_EVENT_MS,
        SYSTEM_FUTURE_SKEW_MS,
      )
      .first<Record<string, unknown>>(),
    env.DB.prepare(
      `
        ${SYSTEM_EVENTS_CTE},
        valid_latency AS (
          SELECT latencyMs
          FROM events
          WHERE latencyMs >= 0 AND latencyMs <= ?
        ),
        ranked_latency AS (
          SELECT
            latencyMs,
            ROW_NUMBER() OVER (ORDER BY latencyMs) AS rn,
            COUNT(*) OVER () AS total
          FROM valid_latency
        )
        SELECT
          MIN(CASE WHEN rn >= total * 0.5 THEN latencyMs END) AS p50LatencyMs,
          MIN(CASE WHEN rn >= total * 0.75 THEN latencyMs END) AS p75LatencyMs,
          MIN(CASE WHEN rn >= total * 0.95 THEN latencyMs END) AS p95LatencyMs
        FROM ranked_latency
      `,
    )
      .bind(...eventBindings, SYSTEM_TRUSTED_LATENCY_MAX_MS)
      .first<Record<string, unknown>>(),
    env.DB.prepare(
      `
        ${SYSTEM_EVENTS_MATERIALIZED_CTE},
        trend_aggregate AS (
          SELECT
            CAST(createdAtSec / ? AS INTEGER) * ? AS bucketSec,
            SUM(CASE WHEN kind = 'visit' THEN 1 ELSE 0 END) AS visits,
            SUM(CASE WHEN kind = 'custom_event' THEN 1 ELSE 0 END) AS customEvents,
            COUNT(*) AS totalEvents,
            AVG(CASE WHEN latencyMs >= 0 AND latencyMs <= ? THEN latencyMs END) AS avgLatencyMs,
            SUM(CASE WHEN latencyMs > ? THEN 1 ELSE 0 END) AS delayedEvents,
            SUM(CASE WHEN latencyMs < -? THEN 1 ELSE 0 END) AS futureSkewedEvents
          FROM events
          GROUP BY bucketSec
        ),
        valid_bucket_latency AS (
          SELECT
            CAST(createdAtSec / ? AS INTEGER) * ? AS bucketSec,
            latencyMs
          FROM events
          WHERE latencyMs >= 0 AND latencyMs <= ?
        ),
        ranked_bucket_latency AS (
          SELECT
            bucketSec,
            latencyMs,
            ROW_NUMBER() OVER (PARTITION BY bucketSec ORDER BY latencyMs) AS rn,
            COUNT(*) OVER (PARTITION BY bucketSec) AS total
          FROM valid_bucket_latency
        ),
        bucket_percentiles AS (
          SELECT
            bucketSec,
            MIN(CASE WHEN rn >= total * 0.5 THEN latencyMs END) AS p50LatencyMs,
            MIN(CASE WHEN rn >= total * 0.75 THEN latencyMs END) AS p75LatencyMs,
            MIN(CASE WHEN rn >= total * 0.95 THEN latencyMs END) AS p95LatencyMs
          FROM ranked_bucket_latency
          GROUP BY bucketSec
        )
        SELECT
          a.bucketSec,
          a.visits,
          a.customEvents,
          a.totalEvents,
          a.avgLatencyMs,
          p.p50LatencyMs,
          p.p75LatencyMs,
          p.p95LatencyMs,
          a.delayedEvents,
          a.futureSkewedEvents
        FROM trend_aggregate a
        LEFT JOIN bucket_percentiles p ON p.bucketSec = a.bucketSec
        ORDER BY a.bucketSec ASC
      `,
    )
      .bind(
        ...eventBindings,
        bucketSizeSec,
        bucketSizeSec,
        SYSTEM_TRUSTED_LATENCY_MAX_MS,
        SYSTEM_DELAYED_EVENT_MS,
        SYSTEM_FUTURE_SKEW_MS,
        bucketSizeSec,
        bucketSizeSec,
        SYSTEM_TRUSTED_LATENCY_MAX_MS,
      )
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `
        ${SYSTEM_EVENTS_CTE}
        SELECT
          e.siteId,
          COALESCE(s.name, e.siteId) AS siteName,
          COALESCE(s.domain, '') AS siteDomain,
          COUNT(*) AS totalEvents,
          SUM(CASE WHEN e.kind = 'visit' THEN 1 ELSE 0 END) AS visits,
          SUM(CASE WHEN e.kind = 'custom_event' THEN 1 ELSE 0 END) AS customEvents,
          AVG(CASE WHEN e.latencyMs >= 0 AND e.latencyMs <= ? THEN e.latencyMs END) AS avgLatencyMs,
          SUM(CASE WHEN e.latencyMs > ? THEN 1 ELSE 0 END) AS delayedEvents,
          SUM(CASE WHEN e.latencyMs < -? THEN 1 ELSE 0 END) AS futureSkewedEvents
        FROM events e
        LEFT JOIN sites s ON s.id = e.siteId
        GROUP BY e.siteId
        ORDER BY totalEvents DESC, delayedEvents DESC
        LIMIT 8
      `,
    )
      .bind(
        ...eventBindings,
        SYSTEM_TRUSTED_LATENCY_MAX_MS,
        SYSTEM_DELAYED_EVENT_MS,
        SYSTEM_FUTURE_SKEW_MS,
      )
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `
        ${SYSTEM_EVENTS_CTE}
        SELECT
          e.kind,
          e.siteId,
          COALESCE(s.name, e.siteId) AS siteName,
          COALESCE(s.domain, '') AS siteDomain,
          e.eventAtMs,
          e.serverAtMs,
          e.latencyMs
        FROM events e
        LEFT JOIN sites s ON s.id = e.siteId
        WHERE e.latencyMs > 0
        ORDER BY e.latencyMs DESC
        LIMIT 10
      `,
    )
      .bind(...eventBindings)
      .all<Record<string, unknown>>(),
    env.DB.prepare(
      `
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN ? - last_activity_at > ? THEN 1 ELSE 0 END) AS stale,
          SUM(CASE WHEN ? - last_activity_at > ? THEN 1 ELSE 0 END) AS timedOut,
          MIN(started_at) AS oldestStartedAt,
          MAX(last_activity_at) AS newestActivityAt
        FROM visits
        WHERE status = 'open'
      `,
    )
      .bind(
        generatedAt,
        SYSTEM_STALE_OPEN_VISIT_MS,
        generatedAt,
        SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
      )
      .first<Record<string, unknown>>(),
  ]);

  const totalEvents = toFiniteNumber(summaryRow?.totalEvents);
  const delayedEvents = toFiniteNumber(summaryRow?.delayedEvents);
  const futureSkewedEvents = toFiniteNumber(summaryRow?.futureSkewedEvents);
  const latestCreatedAtSec =
    summaryRow?.latestCreatedAtSec === null ||
    summaryRow?.latestCreatedAtSec === undefined
      ? null
      : toNullableNumber(summaryRow.latestCreatedAtSec);
  const latestCreatedAt =
    latestCreatedAtSec === null ? null : latestCreatedAtSec * 1000;
  const data: SystemPerformanceData = {
    ok: true,
    generatedAt,
    window: {
      from: fromSec * 1000,
      to: generatedAt,
      minutes,
      bucketSizeMs: bucketSizeSec * 1000,
    },
    thresholds: {
      delayedMs: SYSTEM_DELAYED_EVENT_MS,
      futureSkewMs: SYSTEM_FUTURE_SKEW_MS,
      trustedLatencyMaxMs: SYSTEM_TRUSTED_LATENCY_MAX_MS,
      staleOpenVisitMs: SYSTEM_STALE_OPEN_VISIT_MS,
      timedOutOpenVisitMs: SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
    },
    summary: {
      totalEvents,
      visits: toFiniteNumber(summaryRow?.visits),
      customEvents: toFiniteNumber(summaryRow?.customEvents),
      activeSites: toFiniteNumber(summaryRow?.activeSites),
      eventsPerMinute: totalEvents / minutes,
      latestCreatedAt,
      dataFreshnessMs:
        latestCreatedAt === null
          ? null
          : Math.max(0, generatedAt - latestCreatedAt),
      avgLatencyMs: toNullableNumber(summaryRow?.avgLatencyMs),
      p50LatencyMs: toNullableNumber(percentileRow?.p50LatencyMs),
      p75LatencyMs: toNullableNumber(percentileRow?.p75LatencyMs),
      p95LatencyMs: toNullableNumber(percentileRow?.p95LatencyMs),
      trustedLatencySamples: toFiniteNumber(summaryRow?.trustedLatencySamples),
      delayedEvents,
      futureSkewedEvents,
      anomalyRate:
        totalEvents > 0
          ? (delayedEvents + futureSkewedEvents) / totalEvents
          : 0,
    },
    openVisits: {
      total: toFiniteNumber(openVisitRow?.total),
      stale: toFiniteNumber(openVisitRow?.stale),
      timedOut: toFiniteNumber(openVisitRow?.timedOut),
      oldestStartedAt: toNullableNumber(openVisitRow?.oldestStartedAt),
      newestActivityAt: toNullableNumber(openVisitRow?.newestActivityAt),
    },
    trend: trendRows.results.map((row) => {
      const bucketSec = toFiniteNumber(row.bucketSec);
      return {
        bucket: bucketSec,
        timestampMs: bucketSec * 1000,
        visits: toFiniteNumber(row.visits),
        customEvents: toFiniteNumber(row.customEvents),
        totalEvents: toFiniteNumber(row.totalEvents),
        avgLatencyMs: toNullableNumber(row.avgLatencyMs),
        p50LatencyMs: toNullableNumber(row.p50LatencyMs),
        p75LatencyMs: toNullableNumber(row.p75LatencyMs),
        p95LatencyMs: toNullableNumber(row.p95LatencyMs),
        delayedEvents: toFiniteNumber(row.delayedEvents),
        futureSkewedEvents: toFiniteNumber(row.futureSkewedEvents),
      };
    }),
    topSites: topSiteRows.results.map((row) => ({
      siteId: clampString(String(row.siteId || ""), 120),
      siteName: clampString(String(row.siteName || ""), 120),
      siteDomain: clampString(String(row.siteDomain || ""), 255),
      totalEvents: toFiniteNumber(row.totalEvents),
      visits: toFiniteNumber(row.visits),
      customEvents: toFiniteNumber(row.customEvents),
      avgLatencyMs: toNullableNumber(row.avgLatencyMs),
      delayedEvents: toFiniteNumber(row.delayedEvents),
      futureSkewedEvents: toFiniteNumber(row.futureSkewedEvents),
    })),
    slowEvents: slowEventRows.results.map((row) => ({
      kind:
        String(row.kind || "") === "custom_event" ? "custom_event" : "visit",
      siteId: clampString(String(row.siteId || ""), 120),
      siteName: clampString(String(row.siteName || ""), 120),
      siteDomain: clampString(String(row.siteDomain || ""), 255),
      eventAt: toFiniteNumber(row.eventAtMs),
      serverAt: toFiniteNumber(row.serverAtMs),
      latencyMs: toFiniteNumber(row.latencyMs),
    })),
  };

  return jsonResponseFor(req, data);
}

const DO_DIAGNOSTIC_FETCH_TIMEOUT_MS = 4000;
const DO_DIAGNOSTIC_PARALLELISM = 8;
const DO_DIAGNOSTIC_TOP_SITES = 20;

async function fetchDoDiagnostic(
  env: Env,
  site: { id: string; name: string; domain: string },
): Promise<DoDiagnosticSiteEntry> {
  const startedAt = Date.now();
  const baseEntry = {
    siteId: site.id,
    siteName: site.name || site.id,
    siteDomain: site.domain || "",
  };
  try {
    const stubId = env.INGEST_DO.idFromName(site.id);
    const stub = env.INGEST_DO.get(stubId);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DO_DIAGNOSTIC_FETCH_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await stub.fetch("https://ingest.internal/diagnostic", {
        method: "GET",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ...baseEntry,
        ok: false,
        error: `do_status_${response.status}`,
        durationMs,
      };
    }
    const payload = (await response.json()) as
      DoDiagnosticPayload | { ok: false; error?: string };
    if ("ok" in payload && payload.ok === true) {
      return {
        ...baseEntry,
        ok: true,
        durationMs,
        diagnostic: payload,
      };
    }
    return {
      ...baseEntry,
      ok: false,
      error:
        ("error" in payload && typeof payload.error === "string"
          ? payload.error
          : null) || "do_invalid_response",
      durationMs,
    };
  } catch (error) {
    return {
      ...baseEntry,
      ok: false,
      error: clampString(
        String(error instanceof Error ? error.message : error),
        160,
      ),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function fetchDoDiagnosticsBatched(
  env: Env,
  sites: Array<{ id: string; name: string; domain: string }>,
): Promise<DoDiagnosticSiteEntry[]> {
  const results: DoDiagnosticSiteEntry[] = new Array(sites.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(DO_DIAGNOSTIC_PARALLELISM, sites.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= sites.length) return;
        results[index] = await fetchDoDiagnostic(env, sites[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function siteAnomalyScore(entry: DoDiagnosticSiteEntry): number {
  if (!entry.ok || !entry.diagnostic) return -1;
  const d = entry.diagnostic;
  const o = d.visits.open;
  return (
    o.futureSkewed * 1000 +
    o.hardAged * 100 +
    o.timedOut * 10 +
    d.visits.dirty.stuck * 100 +
    d.customEvents.stuck * 100 +
    d.visits.dirty.maxFlushAttempts +
    d.customEvents.maxFlushAttempts +
    d.visits.open.total
  );
}

export async function handleDoDiagnosticAdmin(
  req: Request,
  env: Env,
  _url: URL,
  requireActor: AdminActorResolver,
): Promise<Response> {
  const a = await requireActor(env, req);
  if (a instanceof Response) return a;
  if (!a.isAdmin)
    return forb("Only system admin can view DO diagnostics", undefined, req);
  if (req.method !== "GET") return na(req);

  const generatedAt = Date.now();
  const sitesResult = await env.DB.prepare(
    "SELECT id, name, domain FROM sites ORDER BY created_at ASC",
  ).all<{ id: string; name: string; domain: string }>();
  const sites = sitesResult.results.map((row) => ({
    id: String(row.id || ""),
    name: String(row.name || ""),
    domain: String(row.domain || ""),
  }));

  const siteEntries = await fetchDoDiagnosticsBatched(env, sites);

  const totals = {
    bufferedVisits: 0,
    openVisits: 0,
    openStale: 0,
    openTimedOut: 0,
    openHardAged: 0,
    openFutureSkewed: 0,
    dirtyVisits: 0,
    stuckDirtyVisits: 0,
    bufferedCustomEvents: 0,
    dirtyCustomEvents: 0,
    stuckDirtyCustomEvents: 0,
    activeAlarms: 0,
    maxVisitFlushAttempts: 0,
    maxCustomEventFlushAttempts: 0,
  };
  let oldestOpenStartedAt: number | null = null;
  let futureMaxActivityAt: number | null = null;
  let reachable = 0;
  let referenceThresholds: DoDiagnosticPayload["thresholds"] | null = null;

  for (const entry of siteEntries) {
    if (!entry.ok || !entry.diagnostic) continue;
    reachable += 1;
    const d = entry.diagnostic;
    if (!referenceThresholds) referenceThresholds = d.thresholds;
    totals.bufferedVisits += d.visits.total;
    totals.openVisits += d.visits.open.total;
    totals.openStale += d.visits.open.stale;
    totals.openTimedOut += d.visits.open.timedOut;
    totals.openHardAged += d.visits.open.hardAged;
    totals.openFutureSkewed += d.visits.open.futureSkewed;
    totals.dirtyVisits += d.visits.dirty.total;
    totals.stuckDirtyVisits += d.visits.dirty.stuck;
    totals.bufferedCustomEvents += d.customEvents.total;
    totals.dirtyCustomEvents += d.customEvents.dirty;
    totals.stuckDirtyCustomEvents += d.customEvents.stuck;
    if (d.alarm.scheduledAt !== null) totals.activeAlarms += 1;
    totals.maxVisitFlushAttempts = Math.max(
      totals.maxVisitFlushAttempts,
      d.visits.dirty.maxFlushAttempts,
    );
    totals.maxCustomEventFlushAttempts = Math.max(
      totals.maxCustomEventFlushAttempts,
      d.customEvents.maxFlushAttempts,
    );
    if (
      d.visits.open.oldestStartedAt !== null &&
      (oldestOpenStartedAt === null ||
        d.visits.open.oldestStartedAt < oldestOpenStartedAt)
    ) {
      oldestOpenStartedAt = d.visits.open.oldestStartedAt;
    }
    if (
      d.visits.open.futureMaxActivityAt !== null &&
      (futureMaxActivityAt === null ||
        d.visits.open.futureMaxActivityAt > futureMaxActivityAt)
    ) {
      futureMaxActivityAt = d.visits.open.futureMaxActivityAt;
    }
  }

  const sortedSites = [...siteEntries].sort(
    (left, right) => siteAnomalyScore(right) - siteAnomalyScore(left),
  );
  const topSites = sortedSites.slice(0, DO_DIAGNOSTIC_TOP_SITES);

  const aggregate: DoDiagnosticAggregate = {
    ok: true,
    generatedAt,
    totalSites: sites.length,
    reachableSites: reachable,
    unreachableSites: siteEntries.length - reachable,
    thresholds: referenceThresholds ?? {
      staleMs: 30 * 60 * 1000,
      timeoutMs: 12 * 60 * 60 * 1000,
      hardAgedMs: 36 * 60 * 60 * 1000,
      stuckFlushAttempts: 5,
    },
    totals,
    oldestOpenStartedAt,
    futureMaxActivityAt,
    sites: topSites,
  };

  return jsonResponseFor(req, aggregate);
}

/** E2E-only deterministic flush; unavailable unless the generated local config opts in. */
export async function handleE2eFlushAdmin(
  req: Request,
  env: Env,
  _url: URL,
  requireActor: AdminActorResolver,
): Promise<Response> {
  if (env.INSIGHTFLARE_E2E !== "1") return nf();
  const actor = await requireActor(env, req);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin)
    return forb("Only system admin can flush E2E ingest", undefined, req);
  if (req.method !== "POST") return na(req);
  const body = await parseJson(req);
  const siteId = clampString(String(body.siteId || ""), 120);
  if (!siteId) return bad("siteId is required", undefined, req);
  const site = await env.DB.prepare("SELECT id FROM sites WHERE id=? LIMIT 1")
    .bind(siteId)
    .first<{ id: string }>();
  if (!site) return nf("Site not found", undefined, req);
  const stub = env.INGEST_DO.get(env.INGEST_DO.idFromName(siteId));
  const response = await stub.fetch("https://ingest.internal/flush?force=1", {
    method: "POST",
  });
  if (!response.ok)
    return jsonResponseFor(req, { ok: false, error: "flush_failed" }, 502);
  return jsonResponseFor(req, { ok: true, data: { flushed: true, siteId } });
}
