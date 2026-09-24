import {
  DEMO_SITE_PROFILES,
  demoSitePublicSlug,
} from "@/lib/demo/data/site-profiles";
import { fnv1a, mulberry32, sInt } from "@/lib/demo/generators/utils";
import { parseDemoInterval } from "@/lib/demo/realtime/filters";
import {
  buildDemoTimeBuckets,
  parseDemoTimeZone,
} from "@/lib/demo/realtime/shared";
import {
  computeMetrics,
  integrateViews,
  siteRatios,
} from "@/lib/demo/realtime/site-curves";
export function generateDemoTeamDashboard(
  teamId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const teamSites = DEMO_SITE_PROFILES.filter((s) => s.teamId === teamId);
  const from = Number(params.from || 0);
  const to = Number(params.to || Date.now());
  const interval = String(params.interval || "day");
  const timeZone = parseDemoTimeZone(params);
  const now = Date.now();
  const span = to - from;

  const sites = teamSites.map((site) => {
    const metrics = computeMetrics(site.id, from, to);
    const prevMetrics = computeMetrics(site.id, Math.max(0, from - span), from);
    const cr = (cur: number, prev: number) =>
      prev === 0 ? null : Math.round(((cur - prev) / prev) * 10000) / 10000;
    const pagesPerSession =
      metrics.sessions > 0 ? metrics.views / metrics.sessions : 0;
    const previousPagesPerSession =
      prevMetrics.sessions > 0 ? prevMetrics.views / prevMetrics.sessions : 0;
    return {
      id: site.id,
      teamId: site.teamId,
      name: site.name,
      domain: site.domain,
      iconPath: site.iconPath,
      publicEnabled: true,
      publicSlug: demoSitePublicSlug(site),
      createdAt: now - 180 * 24 * 3600 * 1000,
      updatedAt:
        now - sInt(mulberry32(fnv1a(site.id)), 1, 14) * 24 * 3600 * 1000,
      overview: metrics,
      changeRates: {
        views: cr(metrics.views, prevMetrics.views),
        sessions: cr(metrics.sessions, prevMetrics.sessions),
        visitors: cr(metrics.visitors, prevMetrics.visitors),
        bounceRate: cr(metrics.bounceRate, prevMetrics.bounceRate),
        avgDurationMs: cr(metrics.avgDurationMs, prevMetrics.avgDurationMs),
        pagesPerSession: cr(pagesPerSession, previousPagesPerSession),
      },
    };
  });

  const buckets = buildDemoTimeBuckets(
    from,
    to,
    parseDemoInterval(interval),
    timeZone,
  );
  const trend: Array<{
    bucket: number;
    timestampMs: number;
    sites: Array<{ siteId: string; views: number; visitors: number }>;
  }> = [];
  for (const bucket of buckets) {
    const ts = Math.max(from, bucket.fromMs);
    const end = Math.min(bucket.toMs, to);
    const sitesForBucket = teamSites.map((site) => {
      const views = integrateViews(site.id, ts, end);
      const r = siteRatios(site.id);
      const visitors = Math.max(
        views > 0 ? 1 : 0,
        Math.round(views * r.sessionsPerView * r.visitorsPerSession),
      );
      return { siteId: site.id, views, visitors };
    });
    trend.push({
      bucket: bucket.index,
      timestampMs: bucket.timestampMs,
      sites: sitesForBucket,
    });
  }

  return { ok: true, data: { sites, trend } };
}
