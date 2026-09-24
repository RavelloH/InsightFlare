import {
  aggregateOverviewMetrics,
  applyDemoFilters,
  buildDemoFactDataset,
} from "@/lib/demo/realtime/fact-builder";
import {
  parseDemoBoolean,
  parseDemoFilters,
  parseDemoInterval,
  parseDemoNumber,
} from "@/lib/demo/realtime/filters";
import {
  buildDemoTrendBuckets,
  parseDemoTimeZone,
} from "@/lib/demo/realtime/shared";
export function generateDemoOverview(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const data = aggregateOverviewMetrics(dataset, filtered);
  const result: Record<string, unknown> = { ok: true, data };

  if (parseDemoBoolean(params.includeChange)) {
    const span = to - from;
    const previousFrom = Math.max(0, from - span);
    const previousDataset = buildDemoFactDataset(siteId, previousFrom, from);
    const previousFiltered = applyDemoFilters(previousDataset, filters);
    const previousData = aggregateOverviewMetrics(
      previousDataset,
      previousFiltered,
    );
    result.previousData = previousData;
    const cr = (cur: number, prev: number) =>
      prev === 0 ? null : Math.round(((cur - prev) / prev) * 10000) / 10000;
    result.changeRates = {
      views: cr(data.views, previousData.views),
      sessions: cr(data.sessions, previousData.sessions),
      visitors: cr(data.visitors, previousData.visitors),
      bounces: cr(data.bounces, previousData.bounces),
      bounceRate: cr(data.bounceRate, previousData.bounceRate),
      avgDurationMs: cr(data.avgDurationMs, previousData.avgDurationMs),
    };
  }

  if (parseDemoBoolean(params.includeDetail)) {
    const interval = parseDemoInterval(params.interval);
    const timeZone = parseDemoTimeZone(params);
    result.detail = {
      interval,
      data: buildDemoTrendBuckets(
        siteId,
        from,
        to,
        interval,
        filters,
        timeZone,
      ),
    };
  }

  return result;
}
export function generateDemoTrend(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const interval = parseDemoInterval(params.interval);
  const filters = parseDemoFilters(params);
  const timeZone = parseDemoTimeZone(params);
  return {
    ok: true,
    interval,
    data: buildDemoTrendBuckets(siteId, from, to, interval, filters, timeZone),
  };
}
