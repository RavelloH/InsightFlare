import {
  aggregate,
  and,
  avg,
  caseWhen,
  castInteger,
  coalesce,
  count,
  countDistinct,
  div,
  eq,
  filter,
  gt,
  gte,
  join,
  limit,
  lt,
  lte,
  max,
  min,
  mul,
  param,
  project,
  rowNumber,
  scan,
  sort,
  sub,
  sum,
  union,
  window,
  windowCountRows,
} from "@/lib/db";
import { schema } from "@/lib/db";

export interface SystemPerformanceQueryThresholds {
  readonly trustedLatencyMaxMs: number;
  readonly delayedEventMs: number;
  readonly futureSkewMs: number;
}

export interface SystemOpenVisitQueryThresholds {
  readonly staleMs: number;
  readonly timedOutMs: number;
}

function eventRelation(fromSec: number, toSec: number) {
  const visitScan = scan(schema.visits);
  const visitColumns = project(visitScan, {
    site_id: visitScan.columns.site_id,
    started_at: visitScan.columns.started_at,
    created_at: visitScan.columns.created_at,
  });
  const visitRows = filter(
    visitColumns,
    and(
      gte(visitColumns.columns.created_at, param(fromSec)),
      lte(visitColumns.columns.created_at, param(toSec)),
    ),
  );
  // The legacy contract selects events by the database write timestamp. Keep
  // the closed, whole-second interval even though latency uses started_at.
  const visitEvents = project(visitRows, {
    kind: param("visit"),
    siteId: visitRows.columns.site_id,
    eventAtMs: visitRows.columns.started_at,
    serverAtMs: mul(visitRows.columns.created_at, param(1000)),
    createdAtSec: visitRows.columns.created_at,
  });
  const customEvents = scan(schema.custom_events);
  const customEventColumns = project(customEvents, {
    site_id: customEvents.columns.site_id,
    occurred_at: customEvents.columns.occurred_at,
    created_at: customEvents.columns.created_at,
  });
  const customEventWindow = filter(
    customEventColumns,
    and(
      gte(customEventColumns.columns.created_at, param(fromSec)),
      lte(customEventColumns.columns.created_at, param(toSec)),
    ),
  );
  const customEventRows = project(customEventWindow, {
    kind: param("custom_event"),
    siteId: customEventWindow.columns.site_id,
    eventAtMs: customEventWindow.columns.occurred_at,
    serverAtMs: mul(customEventWindow.columns.created_at, param(1000)),
    createdAtSec: customEventWindow.columns.created_at,
  });
  const rawEvents = union(visitEvents, customEventRows, true);
  return project(rawEvents, {
    kind: rawEvents.columns.kind,
    siteId: rawEvents.columns.siteId,
    eventAtMs: rawEvents.columns.eventAtMs,
    serverAtMs: rawEvents.columns.serverAtMs,
    createdAtSec: rawEvents.columns.createdAtSec,
    latencyMs: sub(rawEvents.columns.serverAtMs, rawEvents.columns.eventAtMs),
  });
}

export function buildSystemPerformanceSummaryQuery(
  fromSec: number,
  toSec: number,
  thresholds: SystemPerformanceQueryThresholds,
) {
  const events = eventRelation(fromSec, toSec);
  return aggregate(events, {
    groupBy: {},
    aggregates: {
      totalEvents: count(),
      visits: sum(
        caseWhen(
          [{ when: eq(events.columns.kind, param("visit")), then: param(1) }],
          param(0),
        ),
      ),
      customEvents: sum(
        caseWhen(
          [
            {
              when: eq(events.columns.kind, param("custom_event")),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      activeSites: countDistinct(events.columns.siteId),
      avgLatencyMs: avg(
        caseWhen([
          {
            when: and(
              gte(events.columns.latencyMs, param(0)),
              lte(
                events.columns.latencyMs,
                param(thresholds.trustedLatencyMaxMs),
              ),
            ),
            then: events.columns.latencyMs,
          },
        ]),
      ),
      trustedLatencySamples: sum(
        caseWhen(
          [
            {
              when: and(
                gte(events.columns.latencyMs, param(0)),
                lte(
                  events.columns.latencyMs,
                  param(thresholds.trustedLatencyMaxMs),
                ),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      delayedEvents: sum(
        caseWhen(
          [
            {
              when: gt(
                events.columns.latencyMs,
                param(thresholds.delayedEventMs),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      futureSkewedEvents: sum(
        caseWhen(
          [
            {
              when: lt(
                events.columns.latencyMs,
                param(-thresholds.futureSkewMs),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      latestCreatedAtSec: max(events.columns.createdAtSec),
    },
  });
}

function trustedEvents(
  events: ReturnType<typeof eventRelation>,
  trustedLatencyMaxMs: number,
) {
  return filter(
    events,
    and(
      gte(events.columns.latencyMs, param(0)),
      lte(events.columns.latencyMs, param(trustedLatencyMaxMs)),
    ),
  );
}

export function buildSystemPerformancePercentileQuery(
  fromSec: number,
  toSec: number,
  trustedLatencyMaxMs: number,
) {
  const events = eventRelation(fromSec, toSec);
  const validEvents = trustedEvents(events, trustedLatencyMaxMs);
  const latencies = project(validEvents, {
    latencyMs: validEvents.columns.latencyMs,
  });
  const ranked = window(latencies, {
    rank: rowNumber({
      orderBy: [{ expression: latencies.columns.latencyMs, direction: "ASC" }],
    }),
    totalCount: windowCountRows(),
  });
  const percentileInput = project(ranked, {
    rank: ranked.columns.rank,
    totalCount: ranked.columns.totalCount,
    latencyMs: ranked.columns.latencyMs,
  });
  return aggregate(percentileInput, {
    groupBy: {},
    aggregates: {
      p50LatencyMs: min(
        caseWhen([
          {
            when: gte(
              percentileInput.columns.rank,
              mul(percentileInput.columns.totalCount, param(0.5)),
            ),
            then: percentileInput.columns.latencyMs,
          },
        ]),
      ),
      p75LatencyMs: min(
        caseWhen([
          {
            when: gte(
              percentileInput.columns.rank,
              mul(percentileInput.columns.totalCount, param(0.75)),
            ),
            then: percentileInput.columns.latencyMs,
          },
        ]),
      ),
      p95LatencyMs: min(
        caseWhen([
          {
            when: gte(
              percentileInput.columns.rank,
              mul(percentileInput.columns.totalCount, param(0.95)),
            ),
            then: percentileInput.columns.latencyMs,
          },
        ]),
      ),
    },
  });
}

export function buildSystemPerformanceTrendQuery(
  fromSec: number,
  toSec: number,
  bucketSizeSec: number,
  thresholds: SystemPerformanceQueryThresholds,
) {
  const events = eventRelation(fromSec, toSec);
  const trendEvents = project(events, {
    kind: events.columns.kind,
    createdAtSec: events.columns.createdAtSec,
    latencyMs: events.columns.latencyMs,
  });
  const bucketSec = mul(
    castInteger(div(trendEvents.columns.createdAtSec, param(bucketSizeSec))),
    param(bucketSizeSec),
  );
  const trend = aggregate(trendEvents, {
    groupBy: { bucketSec },
    aggregates: {
      visits: sum(
        caseWhen(
          [
            {
              when: eq(trendEvents.columns.kind, param("visit")),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      customEvents: sum(
        caseWhen(
          [
            {
              when: eq(trendEvents.columns.kind, param("custom_event")),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      totalEvents: count(),
      avgLatencyMs: avg(
        caseWhen([
          {
            when: and(
              gte(trendEvents.columns.latencyMs, param(0)),
              lte(
                trendEvents.columns.latencyMs,
                param(thresholds.trustedLatencyMaxMs),
              ),
            ),
            then: trendEvents.columns.latencyMs,
          },
        ]),
      ),
      delayedEvents: sum(
        caseWhen(
          [
            {
              when: gt(
                trendEvents.columns.latencyMs,
                param(thresholds.delayedEventMs),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      futureSkewedEvents: sum(
        caseWhen(
          [
            {
              when: lt(
                trendEvents.columns.latencyMs,
                param(-thresholds.futureSkewMs),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
    },
  });
  const validEvents = filter(
    trendEvents,
    and(
      gte(trendEvents.columns.latencyMs, param(0)),
      lte(trendEvents.columns.latencyMs, param(thresholds.trustedLatencyMaxMs)),
    ),
  );
  const bucketedLatency = project(validEvents, {
    bucketSec: mul(
      castInteger(div(validEvents.columns.createdAtSec, param(bucketSizeSec))),
      param(bucketSizeSec),
    ),
    latencyMs: validEvents.columns.latencyMs,
  });
  const ranked = window(bucketedLatency, {
    rank: rowNumber({
      partitionBy: [bucketedLatency.columns.bucketSec],
      orderBy: [
        { expression: bucketedLatency.columns.latencyMs, direction: "ASC" },
      ],
    }),
    bucketCount: windowCountRows({
      partitionBy: [bucketedLatency.columns.bucketSec],
    }),
  });
  const rankedProjection = project(ranked, {
    bucketSec: ranked.columns.bucketSec,
    rank: ranked.columns.rank,
    bucketCount: ranked.columns.bucketCount,
    latencyMs: ranked.columns.latencyMs,
  });
  const percentiles = aggregate(rankedProjection, {
    groupBy: { bucketSec: rankedProjection.columns.bucketSec },
    aggregates: {
      p50LatencyMs: min(
        caseWhen([
          {
            when: gte(
              rankedProjection.columns.rank,
              mul(rankedProjection.columns.bucketCount, param(0.5)),
            ),
            then: rankedProjection.columns.latencyMs,
          },
        ]),
      ),
      p75LatencyMs: min(
        caseWhen([
          {
            when: gte(
              rankedProjection.columns.rank,
              mul(rankedProjection.columns.bucketCount, param(0.75)),
            ),
            then: rankedProjection.columns.latencyMs,
          },
        ]),
      ),
      p95LatencyMs: min(
        caseWhen([
          {
            when: gte(
              rankedProjection.columns.rank,
              mul(rankedProjection.columns.bucketCount, param(0.95)),
            ),
            then: rankedProjection.columns.latencyMs,
          },
        ]),
      ),
    },
  });
  const joined = join(
    trend,
    percentiles,
    eq(trend.columns.bucketSec, percentiles.columns.bucketSec),
    "left",
  );
  const output = project(joined, {
    bucketSec: joined.columns.left_bucketSec,
    visits: joined.columns.left_visits,
    customEvents: joined.columns.left_customEvents,
    totalEvents: joined.columns.left_totalEvents,
    avgLatencyMs: joined.columns.left_avgLatencyMs,
    p50LatencyMs: joined.columns.right_p50LatencyMs,
    p75LatencyMs: joined.columns.right_p75LatencyMs,
    p95LatencyMs: joined.columns.right_p95LatencyMs,
    delayedEvents: joined.columns.left_delayedEvents,
    futureSkewedEvents: joined.columns.left_futureSkewedEvents,
  });
  return sort(output, [
    { expression: output.columns.bucketSec, direction: "ASC" },
  ]);
}

export function buildSystemPerformanceTopSitesQuery(
  fromSec: number,
  toSec: number,
  thresholds: SystemPerformanceQueryThresholds,
) {
  const events = eventRelation(fromSec, toSec);
  const siteScan = scan(schema.sites);
  const sites = project(siteScan, {
    id: siteScan.columns.id,
    name: siteScan.columns.name,
    domain: siteScan.columns.domain,
  });
  const joined = join(
    events,
    sites,
    eq(events.columns.siteId, sites.columns.id),
    "left",
  );
  const grouped = aggregate(joined, {
    groupBy: { siteId: joined.columns.left_siteId },
    aggregates: {
      siteName: max(joined.columns.right_name),
      siteDomain: max(joined.columns.right_domain),
      totalEvents: count(),
      visits: sum(
        caseWhen(
          [
            {
              when: eq(joined.columns.left_kind, param("visit")),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      customEvents: sum(
        caseWhen(
          [
            {
              when: eq(joined.columns.left_kind, param("custom_event")),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      avgLatencyMs: avg(
        caseWhen([
          {
            when: and(
              gte(joined.columns.left_latencyMs, param(0)),
              lte(
                joined.columns.left_latencyMs,
                param(thresholds.trustedLatencyMaxMs),
              ),
            ),
            then: joined.columns.left_latencyMs,
          },
        ]),
      ),
      delayedEvents: sum(
        caseWhen(
          [
            {
              when: gt(
                joined.columns.left_latencyMs,
                param(thresholds.delayedEventMs),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      futureSkewedEvents: sum(
        caseWhen(
          [
            {
              when: lt(
                joined.columns.left_latencyMs,
                param(-thresholds.futureSkewMs),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
    },
  });
  const named = project(grouped, {
    siteId: grouped.columns.siteId,
    siteName: coalesce(grouped.columns.siteName, grouped.columns.siteId),
    siteDomain: coalesce(grouped.columns.siteDomain, param("")),
    totalEvents: grouped.columns.totalEvents,
    visits: grouped.columns.visits,
    customEvents: grouped.columns.customEvents,
    avgLatencyMs: grouped.columns.avgLatencyMs,
    delayedEvents: grouped.columns.delayedEvents,
    futureSkewedEvents: grouped.columns.futureSkewedEvents,
  });
  return limit(
    sort(named, [
      { expression: named.columns.totalEvents, direction: "DESC" },
      { expression: named.columns.delayedEvents, direction: "DESC" },
    ]),
    8,
  );
}

export function buildSystemPerformanceSlowEventsQuery(
  fromSec: number,
  toSec: number,
) {
  const events = eventRelation(fromSec, toSec);
  const siteScan = scan(schema.sites);
  const sites = project(siteScan, {
    id: siteScan.columns.id,
    name: siteScan.columns.name,
    domain: siteScan.columns.domain,
  });
  const joined = join(
    events,
    sites,
    eq(events.columns.siteId, sites.columns.id),
    "left",
  );
  const positiveLatency = filter(
    joined,
    gt(joined.columns.left_latencyMs, param(0)),
  );
  const named = project(positiveLatency, {
    kind: positiveLatency.columns.left_kind,
    siteId: positiveLatency.columns.left_siteId,
    siteName: coalesce(
      positiveLatency.columns.right_name,
      positiveLatency.columns.left_siteId,
    ),
    siteDomain: coalesce(positiveLatency.columns.right_domain, param("")),
    eventAtMs: positiveLatency.columns.left_eventAtMs,
    serverAtMs: positiveLatency.columns.left_serverAtMs,
    latencyMs: positiveLatency.columns.left_latencyMs,
  });
  return limit(
    sort(named, [{ expression: named.columns.latencyMs, direction: "DESC" }]),
    10,
  );
}

export function buildSystemPerformanceOpenVisitsQuery(
  generatedAt: number,
  thresholds: SystemOpenVisitQueryThresholds,
) {
  const visitScan = scan(schema.visits);
  const visits = project(visitScan, {
    status: visitScan.columns.status,
    last_activity_at: visitScan.columns.last_activity_at,
    started_at: visitScan.columns.started_at,
  });
  const openVisits = filter(visits, eq(visits.columns.status, param("open")));
  return aggregate(openVisits, {
    groupBy: {},
    aggregates: {
      total: count(),
      stale: sum(
        caseWhen(
          [
            {
              when: gt(
                sub(param(generatedAt), openVisits.columns.last_activity_at),
                param(thresholds.staleMs),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      timedOut: sum(
        caseWhen(
          [
            {
              when: gt(
                sub(param(generatedAt), openVisits.columns.last_activity_at),
                param(thresholds.timedOutMs),
              ),
              then: param(1),
            },
          ],
          param(0),
        ),
      ),
      oldestStartedAt: min(openVisits.columns.started_at),
      newestActivityAt: max(openVisits.columns.last_activity_at),
    },
  });
}

export function buildDoDiagnosticSitesQuery() {
  const siteScan = scan(schema.sites);
  const sites = project(siteScan, {
    id: siteScan.columns.id,
    name: siteScan.columns.name,
    domain: siteScan.columns.domain,
    created_at: siteScan.columns.created_at,
  });
  const ordered = sort(sites, [
    { expression: sites.columns.created_at, direction: "ASC" },
  ]);
  return project(ordered, {
    id: ordered.columns.id,
    name: ordered.columns.name,
    domain: ordered.columns.domain,
  });
}

export function buildE2eFlushSiteQuery(siteId: string) {
  const siteScan = scan(schema.sites);
  const sites = project(siteScan, { id: siteScan.columns.id });
  const target = filter(sites, eq(sites.columns.id, param(siteId)));
  return limit(project(target, { id: target.columns.id }), 1);
}
