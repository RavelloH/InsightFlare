import {
  type DemoSiteProfile,
  findSiteProfile,
} from "@/lib/demo/data/site-profiles";
import {
  createDemoRng,
  uniqueNonEmptyStrings,
  weightedDistribution,
  weightedDistributionFromWeights,
} from "@/lib/demo/generators/utils";
import {
  buildDemoComparisonRows,
  resolveDemoComparison,
} from "@/lib/demo/realtime/comparison";
import {
  applyDemoFilters,
  buildDemoFactDataset,
} from "@/lib/demo/realtime/fact-builder";
import {
  parseDemoFilters,
  parseDemoInterval,
  parseDemoLimit,
  parseDemoNumber,
} from "@/lib/demo/realtime/filters";
import { demoPage } from "@/lib/demo/realtime/pagination";
import {
  buildDemoTrendBuckets,
  createDemoShareTrendSeriesKey,
  DEMO_SHARE_TREND_OTHER_KEY,
  DEMO_SHARE_TREND_OTHER_LABEL,
  parseDemoTimeZone,
} from "@/lib/demo/realtime/shared";
import type {
  DemoDimensionRow,
  DemoQueryFilters,
} from "@/lib/demo/realtime/types";
function toDemoUtmSlug(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
function normalizeDemoUtmSourceLabel(value: string): string {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();
  if (!normalized || normalized === "(direct)") return "";

  const segments = normalized.split(".").filter(Boolean);
  if (segments.length >= 2) {
    return segments[segments.length - 2] || normalized;
  }

  return segments[0] || normalized;
}
function buildDemoUtmSourceEntries(
  profile: DemoSiteProfile,
): Array<{ label: string; weight: number }> {
  const baseEntries = profile.topReferrers
    .map((item) => ({
      label: normalizeDemoUtmSourceLabel(item.name),
      weight: Math.max(0, Number(item.weight) || 0),
    }))
    .filter((item) => item.label.length > 0 && item.weight > 0);

  return [
    ...baseEntries,
    { label: "newsletter", weight: 0.12 },
    { label: "partner", weight: 0.08 },
    { label: "community", weight: 0.05 },
    { label: "podcast", weight: 0.03 },
  ];
}
function buildDemoUtmLabelPool(
  profile: DemoSiteProfile,
  tab: "medium" | "campaign" | "term" | "content",
): string[] {
  const siteSlug =
    toDemoUtmSlug(profile.name) || toDemoUtmSlug(profile.domain) || "brand";
  const titleSlugs = uniqueNonEmptyStrings(
    profile.titles
      .map((title) => toDemoUtmSlug(title))
      .filter((value) => value.length > 0),
  );
  const titleTerms = uniqueNonEmptyStrings(
    titleSlugs
      .flatMap((slug) => slug.split("-"))
      .filter((token) => token.length >= 4),
  );
  const pathSlugs = uniqueNonEmptyStrings(
    profile.paths
      .map((path) => toDemoUtmSlug(path))
      .filter((value) => value.length > 0),
  );

  if (tab === "medium") {
    return [
      "email",
      "cpc",
      "paid-social",
      "organic-social",
      "referral",
      "affiliate",
      "display",
      "sponsored",
      "community",
      "influencer",
    ];
  }

  if (tab === "campaign") {
    return uniqueNonEmptyStrings([
      `${siteSlug}-launch`,
      `${siteSlug}-always-on`,
      `${siteSlug}-remarketing`,
      `${siteSlug}-newsletter`,
      `${siteSlug}-brand-search`,
      `${siteSlug}-retention`,
      ...titleSlugs.slice(0, 4).map((slug) => `${siteSlug}-${slug}`),
      "spring-promo",
      "partner-drop",
      "product-update",
    ]);
  }

  if (tab === "term") {
    return uniqueNonEmptyStrings([
      ...titleTerms.slice(0, 8),
      "brand",
      "pricing",
      "comparison",
      "automation",
      "guide",
      "template",
      "free-trial",
      "discount",
    ]);
  }

  return uniqueNonEmptyStrings([
    ...pathSlugs.slice(0, 6).map((slug) => `${slug}-hero`),
    ...pathSlugs.slice(0, 6).map((slug) => `${slug}-cta`),
    "hero-a",
    "hero-b",
    "pricing-card",
    "testimonial-video",
    "email-1",
    "email-2",
    "carousel-quote",
    "sidebar-banner",
  ]);
}
export type DemoUtmDimensionKey =
  "source" | "medium" | "campaign" | "term" | "content";
function parseDemoUtmDimensionKey(
  value: string | number | undefined,
): DemoUtmDimensionKey | null {
  const normalized = String(value ?? "").trim();
  if (
    normalized === "source" ||
    normalized === "medium" ||
    normalized === "campaign" ||
    normalized === "term" ||
    normalized === "content"
  ) {
    return normalized as DemoUtmDimensionKey;
  }
  return null;
}
function buildDemoUtmRows(
  siteId: string,
  tab: DemoUtmDimensionKey,
  params: Record<string, string | number>,
  limit: number,
  override?: { from: number; to: number; filters: DemoQueryFilters },
): DemoDimensionRow[] {
  const cappedLimit = Math.max(1, Math.floor(limit));
  const from = override?.from ?? parseDemoNumber(params.from, 0);
  const to = override?.to ?? parseDemoNumber(params.to, Date.now());
  const filters = override?.filters ?? parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const profile = findSiteProfile(siteId);
  const rng = createDemoRng(
    siteId,
    `utm:${tab}:${from}:${to}:${JSON.stringify(filters)}:${cappedLimit}`,
  );

  const totalViews = Math.max(
    0,
    Math.round(filtered.visits.length * dataset.viewWeight),
  );
  if (totalViews <= 0) {
    return [];
  }

  const taggedViews = Math.max(
    0,
    Math.round(totalViews * (0.22 + rng() * 0.34)),
  );
  if (taggedViews <= 0) {
    return [];
  }

  const rows =
    tab === "source"
      ? weightedDistributionFromWeights(
          rng,
          buildDemoUtmSourceEntries(profile),
          taggedViews,
          cappedLimit,
          [0.58, 0.88],
        )
      : weightedDistribution(
          rng,
          buildDemoUtmLabelPool(profile, tab),
          taggedViews,
          cappedLimit,
        );

  return rows
    .map((row) => ({
      label: row.label,
      views: row.views,
      sessions: row.sessions,
      visitors: Math.max(
        1,
        Math.min(
          row.sessions,
          Math.round(row.sessions * (0.68 + rng() * 0.24)),
        ),
      ),
    }))
    .sort(
      (left, right) =>
        right.views - left.views ||
        right.sessions - left.sessions ||
        right.visitors - left.visitors ||
        left.label.localeCompare(right.label),
    );
}
export function generateDemoUtmDimension(
  siteId: string,
  tab: DemoUtmDimensionKey,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const rows = buildDemoUtmRows(siteId, tab, params, 500).map((row) => ({
    value: row.label,
    label: row.label,
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
  }));
  const comparison = resolveDemoComparison(params, filters);
  const comparisonRows = comparison
    ? buildDemoComparisonRows(
        rows,
        buildDemoUtmRows(siteId, tab, params, 500, comparison).map((row) => ({
          label: row.label,
          views: row.views,
          sessions: row.sessions,
          visitors: row.visitors,
        })),
        params,
      )
    : null;
  const page = demoPage(
    comparisonRows ?? rows,
    params,
    {
      operation: "utm-dimension",
      siteId,
      tab,
      from,
      to,
      filters,
      search: String(params.search ?? "")
        .trim()
        .toLowerCase(),
      sort: String(params.sort ?? params.sortBy ?? "views"),
      direction: String(params.direction ?? params.sortDir ?? "desc"),
    },
    20,
    200,
    true,
    comparisonRows ? { compare: () => 0 } : undefined,
  );
  return {
    ok: true,
    data: page,
  };
}
export function generateDemoUtmTrend(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const dimension = parseDemoUtmDimensionKey(params.dimension);
  const interval = parseDemoInterval(params.interval);
  if (!dimension) {
    return {
      ok: true,
      interval,
      series: [],
      data: [],
    };
  }

  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const limit = parseDemoLimit(params.limit, 5, 1, 8);
  const filters = parseDemoFilters(params);
  const rows = buildDemoUtmRows(
    siteId,
    dimension,
    params,
    Math.min(limit + 6, 24),
  );
  const topRows = rows.slice(0, limit);
  const otherRows = rows.slice(limit);

  if (topRows.length === 0) {
    return {
      ok: true,
      interval,
      series: [],
      data: [],
    };
  }

  const usedKeys = new Set<string>([DEMO_SHARE_TREND_OTHER_KEY]);
  const series: Array<{
    key: string;
    label: string;
    views: number;
    visitors: number;
    sessions: number;
    isOther?: boolean;
  }> = topRows.map((row) => ({
    key: createDemoShareTrendSeriesKey(row.label, usedKeys, `utm-${dimension}`),
    label: row.label,
    views: row.views,
    visitors: row.visitors,
    sessions: row.sessions,
  }));

  if (otherRows.length > 0) {
    series.push({
      key: DEMO_SHARE_TREND_OTHER_KEY,
      label: DEMO_SHARE_TREND_OTHER_LABEL,
      views: otherRows.reduce((sum, row) => sum + row.views, 0),
      visitors: otherRows.reduce((sum, row) => sum + row.visitors, 0),
      sessions: otherRows.reduce((sum, row) => sum + row.sessions, 0),
      isOther: true,
    });
  }

  const distributeTotal = (total: number, weights: number[]): number[] => {
    if (total <= 0 || weights.length === 0) {
      return weights.map(() => 0);
    }

    const safeWeights = weights.map((weight) => Math.max(0, weight));
    const weightSum = safeWeights.reduce((sum, weight) => sum + weight, 0);
    if (weightSum <= 0) {
      const evenShare = Math.floor(total / weights.length);
      const remainder = total - evenShare * weights.length;
      return weights.map((_, index) => evenShare + (index < remainder ? 1 : 0));
    }

    const raw = safeWeights.map((weight) => (weight / weightSum) * total);
    const base = raw.map((value) => Math.floor(value));
    let remainder = total - base.reduce((sum, value) => sum + value, 0);
    const order = raw
      .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
      .sort(
        (left, right) =>
          right.fraction - left.fraction || left.index - right.index,
      );

    let cursor = 0;
    while (remainder > 0 && order.length > 0) {
      base[order[cursor % order.length].index] += 1;
      remainder -= 1;
      cursor += 1;
    }

    return base;
  };

  const bucketRows = buildDemoTrendBuckets(
    siteId,
    from,
    to,
    interval,
    filters,
    parseDemoTimeZone(params),
  );
  const dimensionOffset = Math.max(1, dimension.length);
  const data = bucketRows.map((bucketRow) => {
    const weights = series.map((item, index) => {
      const base = Math.max(1, item.visitors || item.sessions || item.views);
      const sine = Math.sin(
        (bucketRow.bucket + 1) * (index + 1) * 0.71 + dimensionOffset,
      );
      const cosine = Math.cos((bucketRow.bucket + 2) * 0.37 + index * 0.63);
      const variance = item.isOther
        ? 0.92 + sine * 0.04 + cosine * 0.03
        : 1 + sine * 0.12 + cosine * 0.08;
      return Math.max(0.05, base * variance);
    });

    const visitorAllocations = distributeTotal(bucketRow.visitors, weights);
    const visitorsBySeries = Object.fromEntries(
      series.map((item, index) => [item.key, visitorAllocations[index] ?? 0]),
    );

    return {
      bucket: bucketRow.bucket,
      timestampMs: bucketRow.timestampMs,
      totalVisitors: bucketRow.visitors,
      visitorsBySeries,
    };
  });

  return {
    ok: true,
    interval,
    series,
    data,
  };
}
