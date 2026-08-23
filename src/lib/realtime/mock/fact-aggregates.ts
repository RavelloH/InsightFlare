import {
  classifyTrafficChannel,
  type TrafficChannelId,
} from "@/lib/analytics/traffic-channel-rules";
import {
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/realtime/mock/fact-weights";
import type {
  DemoDimensionRow,
  DemoFactDataset,
  DemoFilteredFacts,
  DemoVisitFact,
} from "@/lib/realtime/mock/types";

export function aggregateOverviewMetrics(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
) {
  const views = Math.round(filtered.visits.length * dataset.viewWeight);
  const sessions = Math.round(weightedSessionCount(dataset, filtered.sessions));
  const visitors = Math.round(weightedVisitorCount(dataset, filtered.visitors));
  let bouncesWeighted = 0;
  for (const [sessionId, count] of filtered.visitsBySession.entries()) {
    if (count === 1) {
      bouncesWeighted += dataset.sessions.get(sessionId)?.weight ?? 0;
    }
  }
  const bounces = Math.min(sessions, Math.round(bouncesWeighted));
  const totalDurationMs = Math.round(
    filtered.visits.reduce(
      (sum, visit) => sum + visit.durationMs * dataset.viewWeight,
      0,
    ),
  );
  const avgDurationMs =
    sessions > 0 ? Math.round(totalDurationMs / sessions) : 0;
  const bounceRate =
    sessions > 0 ? Math.round((bounces / sessions) * 10000) / 10000 : 0;
  return {
    views,
    sessions,
    visitors,
    bounces,
    totalDurationMs,
    avgDurationMs,
    bounceRate,
    approximateVisitors: false,
  };
}

export function aggregateDimensionRowsFromVisits(
  dataset: DemoFactDataset,
  visits: DemoVisitFact[],
  limit: number,
  getLabel: (visit: DemoVisitFact) => string,
  sortMetric: "views" | "visitors" = "views",
): DemoDimensionRow[] {
  const buckets = new Map<
    string,
    { views: number; sessions: Set<string>; visitors: Set<string> }
  >();
  for (const visit of visits) {
    const label = String(getLabel(visit) || "").trim();
    if (!label) continue;
    const bucket = buckets.get(label) ?? {
      views: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    bucket.views += dataset.viewWeight;
    bucket.sessions.add(visit.sessionId);
    bucket.visitors.add(visit.visitorId);
    buckets.set(label, bucket);
  }
  return Array.from(buckets.entries())
    .map(([label, bucket]) => ({
      label,
      views: Math.max(0, Math.round(bucket.views)),
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, bucket.visitors)),
      ),
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, bucket.sessions)),
      ),
    }))
    .sort(
      (left, right) =>
        right[sortMetric] - left[sortMetric] ||
        right.views - left.views ||
        right.sessions - left.sessions ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit);
}

export function aggregateSessionEdgeRows(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
  kind: "entry" | "exit",
  limit: number,
): DemoDimensionRow[] {
  const edges = new Map<string, { at: number; value: string }>();
  for (const visit of filtered.visits) {
    const existing = edges.get(visit.sessionId);
    if (!existing) {
      edges.set(visit.sessionId, {
        at: visit.startedAt,
        value: visit.pathname,
      });
      continue;
    }
    if (kind === "entry" && visit.startedAt < existing.at) {
      edges.set(visit.sessionId, {
        at: visit.startedAt,
        value: visit.pathname,
      });
    } else if (kind === "exit" && visit.startedAt >= existing.at) {
      edges.set(visit.sessionId, {
        at: visit.startedAt,
        value: visit.pathname,
      });
    }
  }
  const buckets = new Map<
    string,
    { views: number; sessions: Set<string>; visitors: Set<string> }
  >();
  for (const [sessionId, edge] of edges.entries()) {
    const value = edge.value.trim();
    if (!value) continue;
    const bucket = buckets.get(value) ?? {
      views: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    bucket.views += dataset.sessions.get(sessionId)?.weight ?? 0;
    bucket.sessions.add(sessionId);
    const visitorId = dataset.sessions.get(sessionId)?.visitorId;
    if (visitorId) bucket.visitors.add(visitorId);
    buckets.set(value, bucket);
  }
  return Array.from(buckets.entries())
    .map(([label, bucket]) => ({
      label,
      views: Math.max(0, Math.round(bucket.views)),
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, bucket.visitors)),
      ),
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, bucket.sessions)),
      ),
    }))
    .sort(
      (left, right) =>
        right.views - left.views ||
        right.sessions - left.sessions ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit);
}

export function collectPageDataAndTabs(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
  limit: number,
): {
  data: Array<{ pathname: string; views: number; sessions: number }>;
  tabs: {
    path: Array<{
      label: string;
      views: number;
      sessions: number;
      visitors: number;
    }>;
    title: Array<{
      label: string;
      views: number;
      sessions: number;
      visitors: number;
    }>;
    hostname: Array<{
      label: string;
      views: number;
      sessions: number;
      visitors: number;
    }>;
    entry: Array<{
      label: string;
      views: number;
      sessions: number;
      visitors: number;
    }>;
    exit: Array<{
      label: string;
      views: number;
      sessions: number;
      visitors: number;
    }>;
  };
} {
  const pathRows = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.pathname,
  );
  const titleRows = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.title,
  );
  const hostRows = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.hostname,
  );
  const entryRows = aggregateSessionEdgeRows(dataset, filtered, "entry", limit);
  const exitRows = aggregateSessionEdgeRows(dataset, filtered, "exit", limit);

  return {
    data: pathRows.map((row) => ({
      pathname: row.label,
      views: row.views,
      sessions: row.sessions,
    })),
    tabs: {
      path: pathRows.map((row) => ({
        label: row.label,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      })),
      title: titleRows.map((row) => ({
        label: row.label,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      })),
      hostname: hostRows.map((row) => ({
        label: row.label,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      })),
      entry: entryRows.map((row) => ({
        label: row.label,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      })),
      exit: exitRows.map((row) => ({
        label: row.label,
        views: row.views,
        sessions: row.sessions,
        visitors: row.visitors,
      })),
    },
  };
}

export function collectReferrerRows(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
  limit: number,
  options?: {
    includeFullUrl?: boolean;
    directValue?: string;
  },
): Array<{
  referrer: string;
  views: number;
  sessions: number;
  visitors: number;
}> {
  const includeFullUrl = options?.includeFullUrl ?? false;
  const directValue = options?.directValue ?? "(direct)";
  // The generic dimension aggregator skips empty labels. Keep a private
  // bucket key so callers can still request an empty display value for direct
  // traffic without losing that bucket entirely.
  const directBucketKey = directValue || "\u0000direct";
  const rows = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => {
      const referrer = includeFullUrl
        ? visit.referrerUrl.trim()
        : visit.referrerHost.trim();
      return referrer || directBucketKey;
    },
  );
  return rows.map((row) => ({
    referrer: row.label === directBucketKey ? directValue : row.label,
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
  }));
}

export function collectTrafficChannelRows(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
  limit: number,
): Array<{
  channel: TrafficChannelId;
  views: number;
  sessions: number;
  visitors: number;
}> {
  const buckets = new Map<
    TrafficChannelId,
    { views: number; sessions: Set<string>; visitors: Set<string> }
  >();

  for (const visit of filtered.visits) {
    const channel = classifyTrafficChannel({
      referrerHost: visit.referrerHost,
      utmSource: visit.utmSource,
      utmMedium: visit.utmMedium,
      utmCampaign: visit.utmCampaign,
    });
    const bucket = buckets.get(channel) ?? {
      views: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    bucket.views += dataset.viewWeight;
    bucket.sessions.add(visit.sessionId);
    bucket.visitors.add(visit.visitorId);
    buckets.set(channel, bucket);
  }

  return Array.from(buckets.entries())
    .map(([channel, bucket]) => ({
      channel,
      views: Math.max(0, Math.round(bucket.views)),
      sessions: Math.max(
        0,
        Math.round(weightedSessionCount(dataset, bucket.sessions)),
      ),
      visitors: Math.max(
        0,
        Math.round(weightedVisitorCount(dataset, bucket.visitors)),
      ),
    }))
    .sort(
      (left, right) =>
        right.views - left.views ||
        right.sessions - left.sessions ||
        left.channel.localeCompare(right.channel),
    )
    .slice(0, limit);
}

export function collectClientTabs(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
  limit: number,
): {
  browser: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  osVersion: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  deviceType: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  language: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  screenSize: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
} {
  const browser = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.browser,
  );
  const osVersion = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.osVersion,
  );
  const deviceType = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.deviceType,
  );
  const language = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.language,
  );
  const screenSize = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.screenSize,
  );
  return {
    browser: browser.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    osVersion: osVersion.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    deviceType: deviceType.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    language: language.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    screenSize: screenSize.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
  };
}

export function collectGeoTabs(
  dataset: DemoFactDataset,
  filtered: DemoFilteredFacts,
  limit: number,
): {
  country: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  region: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  city: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  continent: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  timezone: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  organization: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
} {
  const country = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.country,
  );
  const region = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.region,
  );
  const city = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.city,
  );
  const continent = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.continent,
  );
  const timezone = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.timezone,
  );
  const organization = aggregateDimensionRowsFromVisits(
    dataset,
    filtered.visits,
    limit,
    (visit) => visit.organization,
  );
  return {
    country: country.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    region: region.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    city: city.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    continent: continent.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    timezone: timezone.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
    organization: organization.map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: row.visitors,
    })),
  };
}
