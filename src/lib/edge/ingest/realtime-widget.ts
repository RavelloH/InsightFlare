import { ACTIVE_NOW_WINDOW_MS } from "./constants";

export interface RealtimeWidgetAggregate {
  sampledAt: number;
  activeNow: number;
  bars: { minute: number; visitors: number; views: number }[];
  countries: { country: string; activeVisitors: number }[];
  pages: { path: string; activeVisitors: number }[];
}

interface ActiveVisit {
  visitorId: string;
  country: string;
  pathname: string;
}
interface MinuteBucket {
  minute: number;
  visitors: number;
  views: number;
}
interface SqlReader {
  sqlAll<T>(query: string, ...bindings: number[]): T[];
}

/**
 * This method runs inside a site's Ingest DO. Raw visitor IDs never leave
 * that DO: the public-facing result contains aggregates only.
 *
 * A minimum of 3 distinct active visitors per geographic/page bucket
 * prevents sharing a single visitor's whereabouts to public embedders.
 */
export function readRealtimeWidgetAggregate(
  reader: SqlReader,
  now = Date.now(),
): RealtimeWidgetAggregate {
  const activeRows = reader.sqlAll<ActiveVisit>(
    `SELECT visitor_id AS visitorId, country, pathname
     FROM buffered_visits
     WHERE status = 'open' AND last_activity_at >= ?`,
    now - ACTIVE_NOW_WINDOW_MS,
  );
  const visitors = new Set<string>();
  const countries = new Map<string, Set<string>>();
  const pages = new Map<string, Set<string>>();
  for (const row of activeRows) {
    if (typeof row.visitorId !== "string" || !row.visitorId) continue;
    visitors.add(row.visitorId);
    const country = (row.country ?? "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(country)) {
      const set = countries.get(country) ?? new Set<string>();
      set.add(row.visitorId);
      countries.set(country, set);
    }
    const path = (row.pathname ?? "").split(/[?#]/, 1)[0] ?? "";
    if (path.startsWith("/") && path.length <= 512) {
      const set = pages.get(path) ?? new Set<string>();
      set.add(row.visitorId);
      pages.set(path, set);
    }
  }
  const safeBuckets = (entries: Map<string, Set<string>>) =>
    [...entries]
      .map(([key, values]) => ({
        key,
        activeVisitors: values.size,
      }))
      .filter(({ activeVisitors }) => activeVisitors >= 3)
      .sort(
        (a, b) =>
          b.activeVisitors - a.activeVisitors || a.key.localeCompare(b.key),
      );

  const minuteNow = Math.floor(now / 60_000);
  const firstMinute = minuteNow - 29;
  const buckets = reader.sqlAll<MinuteBucket>(
    `SELECT CAST(started_at / 60000 AS INTEGER) AS minute,
       COUNT(DISTINCT visitor_id) AS visitors, COUNT(*) AS views
       FROM buffered_visits
       WHERE started_at >= ? AND started_at < ?
       GROUP BY CAST(started_at / 60000 AS INTEGER)
       ORDER BY minute`,
    firstMinute * 60_000,
    now + 1,
  );
  const byMinute = new Map(buckets.map((row) => [row.minute, row]));
  const bars = Array.from({ length: 30 }, (_, i) => {
    const minute = firstMinute + i;
    const row = byMinute.get(minute);
    return {
      minute: minute * 60_000,
      visitors: Math.max(0, row?.visitors ?? 0),
      views: Math.max(0, row?.views ?? 0),
    };
  });
  return {
    sampledAt: now,
    activeNow: visitors.size,
    bars,
    countries: safeBuckets(countries).map(({ key, activeVisitors }) => ({
      country: key,
      activeVisitors,
    })),
    pages: safeBuckets(pages)
      .slice(0, 10)
      .map(({ key, activeVisitors }) => ({
        path: key,
        activeVisitors,
      })),
  };
}
