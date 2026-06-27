import {
  DEMO_SITE_PROFILES,
  DEMO_TEAMS,
  demoSitePublicSlug,
} from "@/lib/realtime/demo-site-profiles";
import { fnv1a, mulberry32, sFloat, sInt } from "@/lib/realtime/demo-utils";
import { integrateViews } from "@/lib/realtime/mock/site-curves";
import {
  SCHEDULED_TASK_LOG_RETENTION_DAYS,
  type ScheduledTaskRun,
  type ScheduledTaskRunLog,
  type ScheduledTasksData,
  type ScheduledTaskStatus,
  type ScheduledTaskSummary,
} from "@/lib/scheduled-tasks";
import type {
  DoDiagnosticAggregate,
  DoDiagnosticSiteEntry,
  SystemPerformanceData,
  SystemPerformanceSlowEvent,
  SystemPerformanceTopSite,
  SystemPerformanceTrendPoint,
  SystemPerformanceWindowMinutes,
} from "@/lib/system-performance";
// ---------------------------------------------------------------------------
//  Admin data generators (fixed structure)
// ---------------------------------------------------------------------------

export function getDemoUser() {
  return {
    id: "demo-user-001",
    username: "demo",
    email: "demo@insightflare.app",
    name: "Demo User",
    systemRole: "admin" as const,
    timeZone: "",
    createdAt: Date.now() - 180 * 24 * 3600 * 1000,
    updatedAt: Date.now() - 2 * 24 * 3600 * 1000,
    teamCount: 1,
    ownedTeamCount: 1,
  };
}

export function getDemoTeams() {
  const now = Date.now();
  return DEMO_TEAMS.map((t) => {
    const teamSites = DEMO_SITE_PROFILES.filter((s) => s.teamId === t.id);
    return {
      id: t.id,
      name: t.name,
      slug: t.slug,
      ownerUserId: t.ownerUserId,
      createdAt: now - 180 * 24 * 3600 * 1000,
      updatedAt: now - sInt(mulberry32(fnv1a(t.id)), 1, 30) * 24 * 3600 * 1000,
      siteCount: teamSites.length,
      memberCount: 1,
      membershipRole: "owner",
    };
  });
}

export function getDemoSites(teamId: string) {
  const now = Date.now();
  return DEMO_SITE_PROFILES.filter((s) => s.teamId === teamId).map((s) => ({
    id: s.id,
    teamId: s.teamId,
    name: s.name,
    domain: s.domain,
    iconPath: s.iconPath,
    publicEnabled: true,
    publicSlug: demoSitePublicSlug(s),
    createdAt: now - 180 * 24 * 3600 * 1000,
    updatedAt: now - sInt(mulberry32(fnv1a(s.id)), 1, 14) * 24 * 3600 * 1000,
  }));
}

export function getDemoMembers(teamId: string) {
  const user = getDemoUser();
  return [
    {
      teamId,
      userId: user.id,
      role: "owner",
      joinedAt: user.createdAt,
      username: user.username,
      email: user.email,
      name: user.name,
    },
  ];
}

export function getDemoSiteConfig() {
  return {
    trackingStrength: "smart" as const,
    trackQueryParams: true,
    trackHash: true,
    domainWhitelist: [] as string[],
    pathBlacklist: [] as string[],
    ignoreDoNotTrack: true,
    performanceSampleRate: 100,
  };
}

export function getDemoScriptSnippet(siteId: string) {
  const edgeBase =
    process.env.NEXT_PUBLIC_INSIGHTFLARE_EDGE_URL ||
    (typeof window !== "undefined"
      ? window.location.origin
      : "https://localhost:3000");
  const src = `${edgeBase.replace(/\/$/, "")}/script.js?siteId=${encodeURIComponent(siteId)}`;
  return {
    siteId,
    src,
    snippet: `<script defer src="${src}"></script>`,
  };
}

const DEMO_SCHEDULED_TASK_DEFINITIONS = [
  {
    key: "visit_hourly_rollup",
    name: "Hourly visit aggregation",
    description:
      "Aggregates closed visit rows into hourly rollups for dashboard counters and trends.",
    schedule: "Every hour",
    trigger: "cron" as const,
    enabled: true,
  },
  {
    key: "email_digest",
    name: "Scheduled email delivery",
    description:
      "Reserved for scheduled team reports and alert digests. Not enabled yet.",
    schedule: "Not configured",
    trigger: "cron" as const,
    enabled: false,
  },
];

function demoScheduledTaskStatus(index: number): ScheduledTaskStatus {
  if (index === 0) return "success";
  if (index % 29 === 0) return "failed";
  if (index % 17 === 0) return "partial";
  if (index % 11 === 0) return "skipped";
  return "success";
}

function demoScheduledRuns(now: number): ScheduledTaskRun[] {
  const runs: ScheduledTaskRun[] = [];
  for (let index = 0; index < 30 * 24; index += 1) {
    const startedAt =
      now -
      index * 60 * 60 * 1000 -
      sInt(mulberry32(fnv1a(`scheduled-run:${index}:offset`)), 8_000, 90_000);
    const status = demoScheduledTaskStatus(index);
    const rng = mulberry32(fnv1a(`scheduled-run:${index}`));
    const processedSites = status === "skipped" ? 0 : sInt(rng, 7, 12);
    const failedSites = status === "failed" ? 3 : status === "partial" ? 1 : 0;
    const hoursAggregated =
      status === "skipped" ? 0 : processedSites * sInt(rng, 4, 14);
    const durationMs =
      status === "skipped" ? sInt(rng, 140, 420) : sInt(rng, 1_300, 7_800);
    runs.push({
      id: `demo-run-${String(index).padStart(4, "0")}`,
      invocationId: `demo-invocation-${String(index).padStart(4, "0")}`,
      taskKey: "visit_hourly_rollup",
      taskName: "Hourly visit aggregation",
      triggerType: "cron",
      status,
      scheduledAt: Math.floor(startedAt / (60 * 60 * 1000)) * 60 * 60 * 1000,
      startedAt,
      finishedAt: startedAt + durationMs,
      durationMs,
      scopeType: "system",
      scopeId: null,
      summary: {
        cutoffMs: startedAt - 12 * 60 * 60 * 1000,
        candidateSites: processedSites + (status === "skipped" ? 0 : 1),
        sitesProcessed: processedSites,
        sitesFailed: failedSites,
        sitesBlockedByOpenVisit: status === "partial" ? 1 : 0,
        hoursAggregated,
        rollupRowsWritten:
          status === "skipped" ? 0 : hoursAggregated - sInt(rng, 0, 6),
      },
      errorName: status === "failed" ? "D1BatchError" : null,
      errorMessage:
        status === "failed"
          ? "D1 batch rejected while updating one site rollup"
          : status === "partial"
            ? "One site failed; remaining sites completed"
            : null,
      workerVersion: "demo",
      createdAt: startedAt,
      expiresAt:
        startedAt + SCHEDULED_TASK_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
  }
  return runs;
}

function demoScheduledLogs(run: ScheduledTaskRun): ScheduledTaskRunLog[] {
  const summary = run.summary as Record<string, number>;
  const base = run.startedAt;
  const rows: ScheduledTaskRunLog[] = [
    {
      id: `${run.id}-log-1`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 1,
      level: "info",
      event: "start",
      message: "Task run started",
      data: {
        triggerType: run.triggerType,
        scheduledAt: run.scheduledAt,
      },
      createdAt: base,
    },
    {
      id: `${run.id}-log-2`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 2,
      level: "info",
      event: "aggregation_candidates",
      message: "Aggregation candidates loaded",
      data: {
        candidateSites: summary.candidateSites ?? 0,
        lagHours: 12,
        maxHoursPerSite: 168,
      },
      createdAt: base + 120,
    },
  ];
  if (run.status === "partial" || run.status === "failed") {
    rows.push({
      id: `${run.id}-log-3`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 3,
      level: run.status === "failed" ? "error" : "warn",
      event: "site_aggregation_failed",
      message: "Failed to aggregate a site",
      data: {
        siteId: "demo-site-006",
        error: run.errorMessage ?? "Unknown aggregation failure",
      },
      createdAt: base + 360,
    });
  }
  rows.push(
    {
      id: `${run.id}-log-4`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 4,
      level: "info",
      event: "aggregation_summary",
      message: "Aggregation completed",
      data: {
        status: run.status,
        sitesProcessed: summary.sitesProcessed ?? 0,
        sitesFailed: summary.sitesFailed ?? 0,
        hoursAggregated: summary.hoursAggregated ?? 0,
        rollupRowsWritten: summary.rollupRowsWritten ?? 0,
      },
      createdAt: base + Math.max(420, Math.floor((run.durationMs ?? 0) * 0.72)),
    },
    {
      id: `${run.id}-log-5`,
      runId: run.id,
      taskKey: run.taskKey,
      sequence: 5,
      level: run.status === "failed" ? "error" : "info",
      event: run.status === "failed" ? "error" : "finish",
      message:
        run.status === "failed"
          ? (run.errorMessage ?? "Task failed")
          : "Task run finished",
      data: {
        status: run.status,
        durationMs: run.durationMs ?? 0,
      },
      createdAt: run.finishedAt ?? base,
    },
  );
  return rows.sort((left, right) => left.sequence - right.sequence);
}

function countByStatus(runs: ScheduledTaskRun[], status: ScheduledTaskStatus) {
  return runs.filter((run) => run.status === status).length;
}

function demoTaskSummary(
  definition: (typeof DEMO_SCHEDULED_TASK_DEFINITIONS)[number],
  runs: ScheduledTaskRun[],
): ScheduledTaskSummary {
  const taskRuns = runs.filter((run) => run.taskKey === definition.key);
  const success30d = countByStatus(taskRuns, "success");
  const durations = taskRuns
    .map((run) => run.durationMs)
    .filter((value): value is number => typeof value === "number");
  return {
    ...definition,
    lastRun: taskRuns[0] ?? null,
    runs30d: taskRuns.length,
    success30d,
    partial30d: countByStatus(taskRuns, "partial"),
    failed30d: countByStatus(taskRuns, "failed"),
    skipped30d: countByStatus(taskRuns, "skipped"),
    running: countByStatus(taskRuns, "running"),
    successRate30d: taskRuns.length > 0 ? success30d / taskRuns.length : null,
    avgDurationMs:
      durations.length > 0
        ? durations.reduce((sum, value) => sum + value, 0) / durations.length
        : null,
  };
}

function parseDemoScheduledTaskLimit(
  value: string | number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function generateDemoScheduledTasks(
  params: Record<string, string | number>,
): ScheduledTasksData {
  const now = Date.now();
  const allRuns = demoScheduledRuns(now);
  const taskKey = String(params.taskKey || "");
  const status = String(params.status || "");
  const page = parseDemoScheduledTaskLimit(params.page, 1, 1, 10_000);
  const pageSize = parseDemoScheduledTaskLimit(
    params.pageSize ?? params.limit,
    50,
    1,
    100,
  );
  const filteredRuns = allRuns
    .filter((run) => !taskKey || run.taskKey === taskKey)
    .filter((run) => !status || run.status === status);
  const offset = (page - 1) * pageSize;
  const requestedRuns = filteredRuns.slice(offset, offset + pageSize + 1);
  const hasMore = requestedRuns.length > pageSize;
  const runs = requestedRuns.slice(0, pageSize);
  const requestedRunId = String(params.runId || "");
  const selectedRun =
    (requestedRunId
      ? (allRuns.find((run) => run.id === requestedRunId) ?? null)
      : runs[0]) ?? null;
  const runs24h = allRuns.filter(
    (run) => run.startedAt >= now - 24 * 60 * 60 * 1000,
  );
  const success24h = countByStatus(runs24h, "success");
  return {
    ok: true,
    generatedAt: now,
    retentionDays: SCHEDULED_TASK_LOG_RETENTION_DAYS,
    tasks: DEMO_SCHEDULED_TASK_DEFINITIONS.map((task) =>
      demoTaskSummary(task, allRuns),
    ),
    runs,
    runsMeta: {
      page,
      pageSize,
      returned: runs.length,
      hasMore,
      nextPage: hasMore ? page + 1 : null,
    },
    selectedRun,
    logs: selectedRun ? demoScheduledLogs(selectedRun) : [],
    health: {
      totalRuns24h: runs24h.length,
      failedRuns24h: countByStatus(runs24h, "failed"),
      partialRuns24h: countByStatus(runs24h, "partial"),
      runningRuns: countByStatus(runs24h, "running"),
      staleRunningRuns: 0,
      successRate24h: runs24h.length > 0 ? success24h / runs24h.length : null,
      lastRunAt: allRuns[0]?.startedAt ?? null,
    },
  };
}

const DEMO_SYSTEM_WINDOW_OPTIONS = [15, 60, 360, 1440] as const;
const DEMO_SYSTEM_DELAYED_EVENT_MS = 5 * 60 * 1000;
const DEMO_SYSTEM_FUTURE_SKEW_MS = 30 * 1000;
const DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS = 24 * 60 * 60 * 1000;
const DEMO_SYSTEM_STALE_OPEN_VISIT_MS = 30 * 60 * 1000;
const DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS = 12 * 60 * 60 * 1000;

interface DemoSystemEvent {
  kind: "visit" | "custom_event";
  siteId: string;
  siteName: string;
  siteDomain: string;
  eventAt: number;
  serverAt: number;
  latencyMs: number;
}

function parseDemoSystemPerformanceWindow(
  params: Record<string, string | number>,
): SystemPerformanceWindowMinutes {
  const value = Number(params.minutes || 60);
  return DEMO_SYSTEM_WINDOW_OPTIONS.includes(
    value as SystemPerformanceWindowMinutes,
  )
    ? (value as SystemPerformanceWindowMinutes)
    : 60;
}

function demoSystemBucketSizeMs(
  minutes: SystemPerformanceWindowMinutes,
): number {
  if (minutes <= 15) return 60 * 1000;
  if (minutes <= 60) return 5 * 60 * 1000;
  if (minutes <= 360) return 30 * 60 * 1000;
  return 60 * 60 * 1000;
}

function demoSystemLatencyMs(rng: () => number): number {
  const roll = rng();
  if (roll < 0.012) {
    return sInt(rng, DEMO_SYSTEM_DELAYED_EVENT_MS, 18 * 60 * 1000);
  }
  if (roll < 0.02) {
    return -sInt(rng, DEMO_SYSTEM_FUTURE_SKEW_MS, 4 * 60 * 1000);
  }
  const fastPath = sInt(rng, 90, 850);
  const queueDelay = rng() < 0.16 ? sInt(rng, 850, 6500) : 0;
  const beaconDelay = rng() < 0.05 ? sInt(rng, 6500, 90 * 1000) : 0;
  return fastPath + queueDelay + beaconDelay;
}

function percentileNumber(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.min(
    ordered.length - 1,
    Math.max(0, Math.ceil(ordered.length * percentile) - 1),
  );
  return ordered[index];
}

export function generateDemoSystemPerformance(
  params: Record<string, string | number>,
): SystemPerformanceData {
  const minutes = parseDemoSystemPerformanceWindow(params);
  const generatedAt = Date.now();
  const from = generatedAt - minutes * 60 * 1000;
  const bucketSizeMs = demoSystemBucketSizeMs(minutes);
  const firstBucket = Math.floor(from / bucketSizeMs) * bucketSizeMs;
  const events: DemoSystemEvent[] = [];

  for (
    let bucketStart = firstBucket;
    bucketStart <= generatedAt;
    bucketStart += bucketSizeMs
  ) {
    const bucketEnd = Math.min(bucketStart + bucketSizeMs, generatedAt);
    if (bucketEnd <= from) continue;
    for (const site of DEMO_SITE_PROFILES) {
      const bucketSeed = `${site.id}:system:${bucketStart}:${minutes}`;
      const rng = mulberry32(fnv1a(bucketSeed));
      const rawViews = integrateViews(site.id, bucketStart, bucketEnd);
      const visits = Math.max(0, Math.round(rawViews * 0.32));
      const customEvents = Math.max(
        0,
        Math.round(visits * sFloat(rng, 0.06, 0.18)),
      );

      for (let index = 0; index < visits + customEvents; index += 1) {
        const isCustom = index >= visits;
        const eventRng = mulberry32(fnv1a(`${bucketSeed}:${index}`));
        const serverAt = Math.min(
          generatedAt,
          bucketStart +
            Math.floor(eventRng() * Math.max(1, bucketEnd - bucketStart)),
        );
        const latencyMs = demoSystemLatencyMs(eventRng);
        events.push({
          kind: isCustom ? "custom_event" : "visit",
          siteId: site.id,
          siteName: site.name,
          siteDomain: site.domain,
          eventAt: serverAt - latencyMs,
          serverAt,
          latencyMs,
        });
      }
    }
  }

  const trustedLatencies = events
    .map((event) => event.latencyMs)
    .filter(
      (value) => value >= 0 && value <= DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS,
    );
  const totalEvents = events.length;
  const visits = events.filter((event) => event.kind === "visit").length;
  const customEvents = totalEvents - visits;
  const delayedEvents = events.filter(
    (event) => event.latencyMs > DEMO_SYSTEM_DELAYED_EVENT_MS,
  ).length;
  const futureSkewedEvents = events.filter(
    (event) => event.latencyMs < -DEMO_SYSTEM_FUTURE_SKEW_MS,
  ).length;
  const latestCreatedAt =
    events.length > 0
      ? Math.max(...events.map((event) => event.serverAt))
      : null;

  const trendMap = new Map<number, SystemPerformanceTrendPoint>();
  const siteMap = new Map<string, SystemPerformanceTopSite>();
  const siteLatencyMap = new Map<string, number[]>();

  for (const event of events) {
    const bucket = Math.floor(event.serverAt / bucketSizeMs) * bucketSizeMs;
    const trend = trendMap.get(bucket) ?? {
      bucket: Math.floor(bucket / 1000),
      timestampMs: bucket,
      visits: 0,
      customEvents: 0,
      totalEvents: 0,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p75LatencyMs: null,
      p95LatencyMs: null,
      delayedEvents: 0,
      futureSkewedEvents: 0,
    };
    if (event.kind === "visit") trend.visits += 1;
    else trend.customEvents += 1;
    trend.totalEvents += 1;
    if (event.latencyMs > DEMO_SYSTEM_DELAYED_EVENT_MS) {
      trend.delayedEvents += 1;
    }
    if (event.latencyMs < -DEMO_SYSTEM_FUTURE_SKEW_MS) {
      trend.futureSkewedEvents += 1;
    }
    trendMap.set(bucket, trend);

    const site = siteMap.get(event.siteId) ?? {
      siteId: event.siteId,
      siteName: event.siteName,
      siteDomain: event.siteDomain,
      totalEvents: 0,
      visits: 0,
      customEvents: 0,
      avgLatencyMs: null,
      delayedEvents: 0,
      futureSkewedEvents: 0,
    };
    site.totalEvents += 1;
    if (event.kind === "visit") site.visits += 1;
    else site.customEvents += 1;
    if (event.latencyMs > DEMO_SYSTEM_DELAYED_EVENT_MS) {
      site.delayedEvents += 1;
    }
    if (event.latencyMs < -DEMO_SYSTEM_FUTURE_SKEW_MS) {
      site.futureSkewedEvents += 1;
    }
    siteMap.set(event.siteId, site);
    if (
      event.latencyMs >= 0 &&
      event.latencyMs <= DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS
    ) {
      const latencies = siteLatencyMap.get(event.siteId) ?? [];
      latencies.push(event.latencyMs);
      siteLatencyMap.set(event.siteId, latencies);
    }
  }

  for (const [siteId, site] of siteMap.entries()) {
    const latencies = siteLatencyMap.get(siteId) ?? [];
    site.avgLatencyMs =
      latencies.length > 0
        ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
        : null;
  }

  const trendLatencyMap = new Map<number, number[]>();
  for (const event of events) {
    if (
      event.latencyMs < 0 ||
      event.latencyMs > DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS
    ) {
      continue;
    }
    const bucket = Math.floor(event.serverAt / bucketSizeMs) * bucketSizeMs;
    const latencies = trendLatencyMap.get(bucket) ?? [];
    latencies.push(event.latencyMs);
    trendLatencyMap.set(bucket, latencies);
  }
  for (const [bucket, trend] of trendMap.entries()) {
    const latencies = trendLatencyMap.get(bucket) ?? [];
    trend.avgLatencyMs =
      latencies.length > 0
        ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
        : null;
    trend.p50LatencyMs = percentileNumber(latencies, 0.5);
    trend.p75LatencyMs = percentileNumber(latencies, 0.75);
    trend.p95LatencyMs = percentileNumber(latencies, 0.95);
  }

  const openTotal = Math.max(
    1,
    Math.round(
      integrateViews(
        "demo-site-001",
        generatedAt - 5 * 60 * 1000,
        generatedAt,
      ) * 0.18,
    ),
  );
  const stale = Math.max(0, Math.round(openTotal * 0.08));
  const timedOut = Math.max(0, Math.round(openTotal * 0.015));
  const dataFreshnessMs =
    latestCreatedAt === null
      ? null
      : Math.max(0, generatedAt - latestCreatedAt);

  return {
    ok: true,
    generatedAt,
    window: {
      from,
      to: generatedAt,
      minutes,
      bucketSizeMs,
    },
    thresholds: {
      delayedMs: DEMO_SYSTEM_DELAYED_EVENT_MS,
      futureSkewMs: DEMO_SYSTEM_FUTURE_SKEW_MS,
      trustedLatencyMaxMs: DEMO_SYSTEM_TRUSTED_LATENCY_MAX_MS,
      staleOpenVisitMs: DEMO_SYSTEM_STALE_OPEN_VISIT_MS,
      timedOutOpenVisitMs: DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
    },
    summary: {
      totalEvents,
      visits,
      customEvents,
      activeSites: new Set(events.map((event) => event.siteId)).size,
      eventsPerMinute: totalEvents / minutes,
      latestCreatedAt,
      dataFreshnessMs,
      avgLatencyMs:
        trustedLatencies.length > 0
          ? trustedLatencies.reduce((sum, value) => sum + value, 0) /
            trustedLatencies.length
          : null,
      p50LatencyMs: percentileNumber(trustedLatencies, 0.5),
      p75LatencyMs: percentileNumber(trustedLatencies, 0.75),
      p95LatencyMs: percentileNumber(trustedLatencies, 0.95),
      trustedLatencySamples: trustedLatencies.length,
      delayedEvents,
      futureSkewedEvents,
      anomalyRate:
        totalEvents > 0
          ? (delayedEvents + futureSkewedEvents) / totalEvents
          : 0,
    },
    openVisits: {
      total: openTotal,
      stale,
      timedOut,
      oldestStartedAt:
        openTotal > 0
          ? generatedAt -
            sInt(mulberry32(fnv1a("system:oldest-open")), 8, 150) * 60 * 1000
          : null,
      newestActivityAt:
        openTotal > 0
          ? generatedAt -
            sInt(mulberry32(fnv1a("system:newest-activity")), 5, 90) * 1000
          : null,
    },
    trend: Array.from(trendMap.values()).sort(
      (left, right) => left.timestampMs - right.timestampMs,
    ),
    topSites: Array.from(siteMap.values())
      .sort(
        (left, right) =>
          right.totalEvents - left.totalEvents ||
          right.delayedEvents - left.delayedEvents,
      )
      .slice(0, 8),
    slowEvents: events
      .filter((event) => event.latencyMs > 0)
      .sort((left, right) => right.latencyMs - left.latencyMs)
      .slice(0, 10)
      .map(
        (event): SystemPerformanceSlowEvent => ({
          kind: event.kind,
          siteId: event.siteId,
          siteName: event.siteName,
          siteDomain: event.siteDomain,
          eventAt: event.eventAt,
          serverAt: event.serverAt,
          latencyMs: event.latencyMs,
        }),
      ),
  };
}

const DEMO_DO_HARD_AGED_MS = 36 * 60 * 60 * 1000;
const DEMO_DO_STUCK_FLUSH_ATTEMPTS = 5;

export function generateDemoDoDiagnostic(): DoDiagnosticAggregate {
  const generatedAt = Date.now();
  const sites: DoDiagnosticSiteEntry[] = DEMO_SITE_PROFILES.slice(0, 12).map(
    (site, index) => {
      const rng = mulberry32(fnv1a(`do-diag:${site.id}:${index}`));
      const openTotal = Math.floor(rng() * 30);
      const stale = Math.min(openTotal, Math.floor(rng() * 12));
      const timedOut = Math.min(stale, Math.floor(rng() * 4));
      const hardAged = index === 0 ? Math.floor(rng() * 3) : 0;
      const futureSkewed = index === 1 ? Math.floor(rng() * 2) : 0;
      const dirty = Math.floor(rng() * 8);
      const stuck = index < 2 ? Math.floor(rng() * 2) : 0;
      const customEventsTotal = Math.floor(rng() * 40);
      const customEventsDirty = Math.floor(rng() * 6);
      return {
        siteId: site.id,
        siteName: site.name,
        siteDomain: site.domain,
        ok: true,
        durationMs: Math.round(40 + rng() * 80),
        diagnostic: {
          ok: true,
          snapshotAt: generatedAt,
          thresholds: {
            staleMs: DEMO_SYSTEM_STALE_OPEN_VISIT_MS,
            timeoutMs: DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
            hardAgedMs: DEMO_DO_HARD_AGED_MS,
            stuckFlushAttempts: DEMO_DO_STUCK_FLUSH_ATTEMPTS,
          },
          visits: {
            total: openTotal + Math.floor(rng() * 60),
            byStatus: { open: openTotal },
            open: {
              total: openTotal,
              stale,
              timedOut,
              hardAged,
              futureSkewed,
              oldestStartedAt:
                openTotal > 0
                  ? generatedAt - Math.floor(rng() * 12 * 60 * 60 * 1000)
                  : null,
              newestActivityAt:
                openTotal > 0
                  ? generatedAt - Math.floor(rng() * 60 * 1000)
                  : null,
              futureMaxActivityAt:
                futureSkewed > 0
                  ? generatedAt + Math.floor(rng() * 24 * 60 * 60 * 1000)
                  : null,
            },
            dirty: {
              total: dirty,
              stuck,
              maxFlushAttempts:
                stuck > 0 ? Math.floor(5 + rng() * 20) : Math.floor(rng() * 3),
            },
          },
          customEvents: {
            total: customEventsTotal,
            dirty: customEventsDirty,
            stuck: 0,
            maxFlushAttempts: Math.floor(rng() * 3),
            oldestOccurredAt:
              customEventsDirty > 0
                ? generatedAt - Math.floor(rng() * 30 * 60 * 1000)
                : null,
          },
          alarm: {
            scheduledAt:
              openTotal > 0
                ? generatedAt + Math.floor(rng() * 60 * 1000)
                : null,
          },
        },
      };
    },
  );

  const totals = sites.reduce(
    (acc, entry) => {
      const d = entry.diagnostic;
      if (!d) return acc;
      acc.bufferedVisits += d.visits.total;
      acc.openVisits += d.visits.open.total;
      acc.openStale += d.visits.open.stale;
      acc.openTimedOut += d.visits.open.timedOut;
      acc.openHardAged += d.visits.open.hardAged;
      acc.openFutureSkewed += d.visits.open.futureSkewed;
      acc.dirtyVisits += d.visits.dirty.total;
      acc.stuckDirtyVisits += d.visits.dirty.stuck;
      acc.bufferedCustomEvents += d.customEvents.total;
      acc.dirtyCustomEvents += d.customEvents.dirty;
      acc.stuckDirtyCustomEvents += d.customEvents.stuck;
      if (d.alarm.scheduledAt !== null) acc.activeAlarms += 1;
      acc.maxVisitFlushAttempts = Math.max(
        acc.maxVisitFlushAttempts,
        d.visits.dirty.maxFlushAttempts,
      );
      acc.maxCustomEventFlushAttempts = Math.max(
        acc.maxCustomEventFlushAttempts,
        d.customEvents.maxFlushAttempts,
      );
      return acc;
    },
    {
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
    },
  );

  const oldestOpenStartedAt = sites.reduce<number | null>((acc, entry) => {
    const value = entry.diagnostic?.visits.open.oldestStartedAt ?? null;
    if (value === null) return acc;
    if (acc === null) return value;
    return value < acc ? value : acc;
  }, null);
  const futureMaxActivityAt = sites.reduce<number | null>((acc, entry) => {
    const value = entry.diagnostic?.visits.open.futureMaxActivityAt ?? null;
    if (value === null) return acc;
    if (acc === null) return value;
    return value > acc ? value : acc;
  }, null);

  return {
    ok: true,
    generatedAt,
    totalSites: sites.length,
    reachableSites: sites.length,
    unreachableSites: 0,
    thresholds: {
      staleMs: DEMO_SYSTEM_STALE_OPEN_VISIT_MS,
      timeoutMs: DEMO_SYSTEM_TIMED_OUT_OPEN_VISIT_MS,
      hardAgedMs: DEMO_DO_HARD_AGED_MS,
      stuckFlushAttempts: DEMO_DO_STUCK_FLUSH_ATTEMPTS,
    },
    totals,
    oldestOpenStartedAt,
    futureMaxActivityAt,
    sites,
  };
}
