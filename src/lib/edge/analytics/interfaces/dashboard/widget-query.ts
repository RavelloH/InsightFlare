import { resolveTimeWindow } from "@/lib/dashboard/query-state";
import { createEdgeSiteAnalyticsRuntime } from "@/lib/edge/analytics/composition";
import {
  percentChange,
  previousComparableWindow,
  queryWindowToTime,
  siteQueryContext,
} from "@/lib/edge/analytics/contract";
import { appNow } from "@/lib/edge/runtime/e2e-clock";
import type { Env } from "@/lib/edge/types";
import type { WidgetConfig, WidgetData } from "@/lib/widgets/contract";
import { GEO_COUNTRY_ANCHORS } from "@/lib/widgets/geo-data";

const breakdownExpressions: Record<WidgetConfig["dimension"], string> = {
  "page.path": "pathname",
  "source.domain": "referrer_host",
  "geo.country": "country",
};
const distributionExpressions: Record<
  WidgetConfig["distributionDimension"],
  string
> = {
  "client.deviceType": "device_type",
  "client.browser": "browser",
  "source.domain": "referrer_host",
  "utm.source": "utm_source",
};

function overviewValue(
  values: {
    views: number;
    sessions: number;
    visitors: number;
    bounces: number;
    totalDurationMs: number;
  },
  metric: WidgetConfig["metric"],
): number {
  if (metric === "visitors") return values.visitors;
  if (metric === "views") return values.views;
  if (metric === "sessions") return values.sessions;
  if (metric === "bounces") return values.bounces;
  if (metric === "bounceRate")
    return values.sessions > 0 ? values.bounces / values.sessions : 0;
  if (metric === "avgDurationMs")
    return values.sessions > 0 ? values.totalDurationMs / values.sessions : 0;
  if (metric === "viewsPerSession")
    return values.sessions > 0 ? values.views / values.sessions : 0;
  throw new Error("Event counts use the event-summary operation");
}

export function widgetTimeWindow(config: WidgetConfig, now = appNow()) {
  const { from, to, timeZone } = resolveTimeWindow(config.range, now, {
    timeZone: config.timeZone,
    interval: "day",
  });
  return { startMs: from, endExclusiveMs: to, timeZone, nowMs: now };
}

function publicRankingLabel(
  key: string,
  dimension: WidgetConfig["dimension"],
): string | null {
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (dimension === "page.path") {
    const path = trimmed.split(/[?#]/, 1)[0];
    return path?.startsWith("/") ? path : null;
  }
  if (dimension === "source.domain") {
    return /^[\p{L}\p{N}.-]+$/u.test(trimmed) ? trimmed : null;
  }
  return /^[A-Z]{2}$/i.test(trimmed) ? trimmed.toUpperCase() : null;
}

async function queryRealtimeWidgetData(
  env: Env,
  siteId: string,
  config: WidgetConfig,
): Promise<WidgetData> {
  const stub = env.INGEST_DO.get(env.INGEST_DO.idFromName(siteId));
  const response = await stub.fetch("https://ingest.internal/widget-realtime", {
    method: "GET",
  });
  if (!response.ok) throw new Error("Realtime Widget aggregate unavailable");
  const snapshot = (await response.json()) as {
    sampledAt: number;
    activeNow: number;
    bars: { minute: number; visitors: number; views: number }[];
    countries: { country: string; activeVisitors: number }[];
    pages: { path: string; activeVisitors: number }[];
  };
  if (
    !Number.isSafeInteger(snapshot.activeNow) ||
    snapshot.activeNow < 0 ||
    !Number.isFinite(snapshot.sampledAt) ||
    !Array.isArray(snapshot.bars) ||
    !Array.isArray(snapshot.countries) ||
    !Array.isArray(snapshot.pages)
  ) {
    throw new Error("Invalid realtime Widget aggregate");
  }
  // Never forward visitor IDs, detailed geolocation or raw visit records.
  const points =
    config.realtimeLayout === "map"
      ? snapshot.countries.flatMap((item) => {
          const country = item.country.trim().toUpperCase();
          const anchor = GEO_COUNTRY_ANCHORS[country];
          return anchor && item.activeVisitors >= 3
            ? [
                {
                  country,
                  lat: anchor[0],
                  lon: anchor[1],
                  value: item.activeVisitors,
                },
              ]
            : [];
        })
      : [];
  const rows =
    config.realtimeLayout === "pages"
      ? snapshot.pages
          .filter(
            (item) =>
              item.activeVisitors >= 3 &&
              item.path.startsWith("/") &&
              item.path.length <= 512,
          )
          .slice(0, config.limit)
          .map((item) => ({ label: item.path, value: item.activeVisitors }))
      : [];
  const bars =
    config.realtimeLayout === "trend"
      ? snapshot.bars
          .slice(-30)
          .filter(
            (item) =>
              Number.isFinite(item.minute) &&
              Number.isFinite(item.visitors) &&
              Number.isFinite(item.views),
          )
          .map((item) => ({
            minute: item.minute,
            visitors: Math.max(0, item.visitors),
            views: Math.max(0, item.views),
          }))
      : [];
  return {
    type: "realtime",
    metric: "visitors",
    from: snapshot.sampledAt - 30 * 60_000,
    to: snapshot.sampledAt,
    timeZone: config.timeZone,
    updatedAt: snapshot.sampledAt,
    activeNow: snapshot.activeNow,
    points,
    rows,
    bars,
  };
}

export async function queryWidgetData(
  env: Env,
  siteId: string,
  config: WidgetConfig,
  window = widgetTimeWindow(config),
): Promise<WidgetData> {
  if (config.type === "realtime") {
    return queryRealtimeWidgetData(env, siteId, config);
  }
  const { metric } = config;
  const base = {
    metric,
    from: window.startMs,
    to: window.endExclusiveMs,
    timeZone: window.timeZone,
    updatedAt: window.nowMs,
  };
  const query = {
    context: siteQueryContext(siteId, "public-share"),
    time: queryWindowToTime(window),
  };
  const runtime = createEdgeSiteAnalyticsRuntime({ env, siteId });

  // A published Widget UUID is a capability for a fixed, validated aggregate.
  // Event/goal operations are not broadly available to public-share queries.
  // Execute only the named configured aggregate using the server-side policy;
  // never accept arbitrary public query filters or goal/event identifiers.
  if (config.type === "conversion") {
    const authorizedQuery = {
      ...query,
      context: siteQueryContext(siteId, "private-dashboard"),
    };
    if (config.conversionKind === "event") {
      const result = await runtime.execute("event-trend", {
        ...authorizedQuery,
        interval: "day",
        limit: 1,
        eventName: config.eventName,
      });
      if (!result.ok) throw new Error("Widget event trend query failed");
      const points = result.data.data.map((point) => ({
        timestampMs: point.timestampMs,
        value: point.totalEvents,
      }));
      return {
        ...base,
        type: "conversion",
        kind: "event",
        label: config.eventName,
        value: points.reduce((sum, point) => sum + point.value, 0),
        rate: null,
        total: null,
        points,
      };
    }
    const result = await runtime.execute("goal-timeseries", {
      ...authorizedQuery,
      interval: "day",
      goalId: config.goalId,
    });
    if (!result.ok || !result.data) {
      throw new Error("Widget goal query failed");
    }
    const points = result.data.timeseries.map((point) => ({
      timestampMs: point.timestampMs,
      value: point.sessions.converted,
      rate: point.sessions.total > 0 ? point.sessions.conversionRate : null,
    }));
    const total = result.data.timeseries.reduce(
      (sum, point) => sum + point.sessions.total,
      0,
    );
    const converted = points.reduce((sum, point) => sum + point.value, 0);
    return {
      ...base,
      type: "conversion",
      kind: "goal",
      label: result.data.goal.name,
      value: converted,
      total,
      rate: total > 0 ? converted / total : null,
      points,
    };
  }

  if (config.type === "metric" && metric === "events") {
    const current = await runtime.execute("event-summary", {
      ...query,
      context: siteQueryContext(siteId, "private-dashboard"),
    });
    if (!current.ok) throw new Error("Widget event summary query failed");
    const previous = config.comparison
      ? await runtime.execute("event-summary", {
          ...query,
          context: siteQueryContext(siteId, "private-dashboard"),
          time: queryWindowToTime(previousComparableWindow(window)),
        })
      : null;
    if (previous && !previous.ok)
      throw new Error("Widget event comparison failed");
    const value = current.data.summary.events;
    const before =
      previous && previous.ok ? previous.data.summary.events : null;
    const change = before === null ? null : percentChange(value, before);
    return {
      ...base,
      type: "metric",
      value,
      change: change === null ? null : change / 100,
    };
  }

  if (config.type === "metric") {
    const result = await runtime.execute("overview", {
      ...query,
      previousTime: config.comparison
        ? queryWindowToTime(previousComparableWindow(window))
        : undefined,
    });
    if (!result.ok) throw new Error("Widget overview query failed");
    const value = overviewValue(result.data.current, metric);
    const change = result.data.previous
      ? percentChange(value, overviewValue(result.data.previous, metric))
      : null;
    return {
      ...base,
      type: "metric",
      value,
      change: change === null ? null : change / 100,
    };
  }

  if (config.type === "trend") {
    const result = await runtime.execute("trend", {
      ...query,
      interval: "day",
    });
    if (!result.ok) throw new Error("Widget trend query failed");
    const metrics =
      config.trendMetrics.length > 0
        ? config.trendMetrics
        : [metric as "visitors" | "views" | "sessions"];
    const series = metrics.map((selectedMetric) => ({
      metric: selectedMetric,
      points: result.data.points.map((point) => ({
        timestampMs: point.timestampMs,
        value: point[selectedMetric],
      })),
    }));
    return {
      ...base,
      type: "trend",
      points: series[0]?.points ?? [],
      ...(config.trendMetrics.length > 0 ? { series } : {}),
    };
  }

  if (config.type === "geo") {
    const result = await runtime.execute("dimension", {
      ...query,
      mode: "breakdown",
      dimension: "country",
      limit: 220,
      sort: {
        key: metric as "visitors" | "views" | "sessions",
        direction: "desc",
      },
    });
    if (!result.ok || !("items" in result.data)) {
      throw new Error("Widget geographic breakdown query failed");
    }
    let unmapped = 0;
    const points: {
      country: string;
      lat: number;
      lon: number;
      value: number;
    }[] = [];
    for (const item of result.data.items) {
      const country = item.key.trim().toUpperCase();
      const value = item[metric as "visitors" | "views" | "sessions"];
      if (!Number.isFinite(value) || value <= 0) continue;
      const anchor = GEO_COUNTRY_ANCHORS[country];
      if (!anchor || !/^[A-Z]{2}$/.test(country)) {
        unmapped += value;
        continue;
      }
      points.push({ country, lat: anchor[0], lon: anchor[1], value });
    }
    return { ...base, type: "geo", points, unmapped };
  }

  const distribution = config.type === "distribution";
  const result = await runtime.execute("dimension", {
    ...query,
    mode: "breakdown",
    dimension: distribution
      ? distributionExpressions[config.distributionDimension]
      : breakdownExpressions[config.dimension],
    limit: config.limit + 1,
    sort: {
      key: metric as "visitors" | "views" | "sessions",
      direction: "desc",
    },
  });
  if (!result.ok || !("items" in result.data)) {
    throw new Error("Widget ranking query failed");
  }
  const rows = result.data.items
    .flatMap((item) => {
      const label = distribution
        ? item.key.trim()
        : publicRankingLabel(item.key, config.dimension);
      return label
        ? [{ label, value: item[metric as "visitors" | "views" | "sessions"] }]
        : [];
    })
    .slice(0, config.limit);
  if (distribution) {
    // Percentages describe the displayed categories, not all hidden traffic.
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    return {
      ...base,
      type: "distribution",
      rows: rows.map((row) => ({
        ...row,
        percent: total > 0 ? row.value / total : 0,
      })),
    };
  }
  return { ...base, type: "ranking", rows };
}
