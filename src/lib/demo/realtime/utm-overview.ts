import {
  buildDemoComparisonRows,
  resolveDemoComparison,
} from "@/lib/demo/realtime/comparison";
import {
  parseDemoCityLabel,
  parseDemoRegionLabel,
} from "@/lib/demo/realtime/dimension-pickers";
import {
  applyDemoFilters,
  buildDemoFactDataset,
  collectClientTabs,
  collectGeoTabs,
  collectPageDataAndTabs,
  collectReferrerRows,
  collectTrafficChannelRows,
  weightedSessionCount,
  weightedVisitorCount,
} from "@/lib/demo/realtime/fact-builder";
import {
  parseDemoBoolean,
  parseDemoFilters,
  parseDemoGeoFilterValue,
  parseDemoLimit,
  parseDemoNumber,
  withoutDemoGeoFilter,
} from "@/lib/demo/realtime/filters";
export {
  generateDemoUtmDimension,
  generateDemoUtmTrend,
} from "@/lib/demo/realtime/utm-dimensions";
export function generateDemoGeoPoints(
  siteId: string,
  params: Record<string, string | number>,
): Record<string, unknown> {
  const limit = parseDemoLimit(params.limit, 5000, 1, 20_000);
  const from = parseDemoNumber(
    params.from,
    Math.max(0, Date.now() - 24 * 3600 * 1000),
  );
  const to = parseDemoNumber(params.to, Date.now());
  const rawFilters = parseDemoFilters(params);
  const filters = parseDemoBoolean(params.applyGeoFilter)
    ? rawFilters
    : withoutDemoGeoFilter(rawFilters);
  const parsedGeo = parseDemoGeoFilterValue(filters.geo);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const orderedVisits = [...filtered.visits].sort(
    (left, right) => right.startedAt - left.startedAt,
  );

  const countryBuckets = new Map<
    string,
    { views: number; sessions: Set<string>; visitors: Set<string> }
  >();
  for (const visit of filtered.visits) {
    const bucket = countryBuckets.get(visit.country) ?? {
      views: 0,
      sessions: new Set<string>(),
      visitors: new Set<string>(),
    };
    bucket.views += dataset.viewWeight;
    bucket.sessions.add(visit.sessionId);
    bucket.visitors.add(visit.visitorId);
    countryBuckets.set(visit.country, bucket);
  }

  const countryCounts = Array.from(countryBuckets.entries())
    .map(([country, bucket]) => ({
      country,
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
        right.views - left.views || left.country.localeCompare(right.country),
    );

  const regionBuckets = new Map<
    string,
    {
      label: string;
      views: number;
      sessions: Set<string>;
      visitors: Set<string>;
    }
  >();
  const cityBuckets = new Map<
    string,
    {
      label: string;
      views: number;
      sessions: Set<string>;
      visitors: Set<string>;
    }
  >();

  for (const visit of filtered.visits) {
    if (visit.region) {
      const regionBucket = regionBuckets.get(visit.region) ?? {
        label: parseDemoRegionLabel(visit.region)?.regionName || visit.region,
        views: 0,
        sessions: new Set<string>(),
        visitors: new Set<string>(),
      };
      regionBucket.views += dataset.viewWeight;
      regionBucket.sessions.add(visit.sessionId);
      regionBucket.visitors.add(visit.visitorId);
      regionBuckets.set(visit.region, regionBucket);
    }

    if (visit.city) {
      const cityBucket = cityBuckets.get(visit.city) ?? {
        label: parseDemoCityLabel(visit.city)?.cityName || visit.city,
        views: 0,
        sessions: new Set<string>(),
        visitors: new Set<string>(),
      };
      cityBucket.views += dataset.viewWeight;
      cityBucket.sessions.add(visit.sessionId);
      cityBucket.visitors.add(visit.visitorId);
      cityBuckets.set(visit.city, cityBucket);
    }
  }

  const regionCounts =
    parsedGeo?.country && !parsedGeo.regionCode && !parsedGeo.regionName
      ? Array.from(regionBuckets.entries())
          .map(([value, bucket]) => ({
            value,
            label: bucket.label,
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
              right.views - left.views || left.label.localeCompare(right.label),
          )
      : [];

  const cityCounts =
    parsedGeo?.country && (parsedGeo.regionCode || parsedGeo.regionName)
      ? Array.from(cityBuckets.entries())
          .map(([value, bucket]) => ({
            value,
            label: bucket.label,
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
              right.views - left.views || left.label.localeCompare(right.label),
          )
      : [];

  // Aggregate points by rounded coordinates (3 decimal places, ~110m precision)
  const aggregatedPoints = new Map<
    string,
    {
      latitude: number;
      longitude: number;
      timestampMs: number;
      country: string;
      region: string;
      regionCode: string;
      city: string;
      pointCount: number;
    }
  >();

  for (const visit of orderedVisits) {
    const latBucket = Math.round(visit.latitude * 1000) / 1000;
    const lonBucket = Math.round(visit.longitude * 1000) / 1000;
    const key = `${latBucket}:${lonBucket}:${visit.country}:${visit.region}:${visit.regionCode}:${visit.city}`;

    const existing = aggregatedPoints.get(key);
    if (existing) {
      existing.pointCount += 1;
      existing.timestampMs = Math.max(existing.timestampMs, visit.startedAt);
    } else {
      aggregatedPoints.set(key, {
        latitude: latBucket,
        longitude: lonBucket,
        timestampMs: visit.startedAt,
        country: visit.country,
        region: visit.region,
        regionCode: visit.regionCode,
        city: visit.city,
        pointCount: 1,
      });
    }
  }

  const sortedAggregated = [...aggregatedPoints.values()].sort(
    (left, right) => right.timestampMs - left.timestampMs,
  );

  return {
    ok: true,
    data: sortedAggregated.slice(0, limit),
    countryCounts,
    regionCounts,
    cityCounts,
  };
}
export function generateDemoOverviewPageTab(
  siteId: string,
  params: Record<string, string | number>,
  tab: "path" | "title" | "hostname" | "entry" | "exit",
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const tabs = collectPageDataAndTabs(
    dataset,
    filtered,
    Math.max(1, filtered.visits.length),
  ).tabs;
  const data = tabs[tab] ?? [];
  const comparison = resolveDemoComparison(params, filters);
  const comparisonData = comparison
    ? (() => {
        const referenceDataset = buildDemoFactDataset(
          siteId,
          comparison.from,
          comparison.to,
        );
        const referenceFiltered = applyDemoFilters(
          referenceDataset,
          comparison.filters,
        );
        const referenceTabs = collectPageDataAndTabs(
          referenceDataset,
          referenceFiltered,
          Math.max(1, referenceFiltered.visits.length),
        ).tabs;
        return buildDemoComparisonRows(data, referenceTabs[tab] ?? [], params);
      })()
    : data;
  return {
    ok: true,
    data: comparisonData,
  };
}
export function generateDemoOverviewSourceTab(
  siteId: string,
  params: Record<string, string | number>,
  tab: "domain" | "link" | "channel",
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const comparison = resolveDemoComparison(params, filters);
  if (tab === "channel") {
    const rows = collectTrafficChannelRows(
      dataset,
      filtered,
      Math.max(1, filtered.visits.length),
    );
    const comparisonRows = comparison
      ? (() => {
          const referenceDataset = buildDemoFactDataset(
            siteId,
            comparison.from,
            comparison.to,
          );
          const referenceFiltered = applyDemoFilters(
            referenceDataset,
            comparison.filters,
          );
          return buildDemoComparisonRows(
            rows.map((item) => ({
              label: item.channel,
              views: item.views,
              sessions: item.sessions,
              visitors: item.visitors,
            })),
            collectTrafficChannelRows(
              referenceDataset,
              referenceFiltered,
              Math.max(1, referenceFiltered.visits.length),
            ).map((item) => ({
              label: item.channel,
              views: item.views,
              sessions: item.sessions,
              visitors: item.visitors,
            })),
            params,
          );
        })()
      : null;
    return {
      ok: true,
      data: (comparisonRows ?? rows).map((item) => ({
        label: String(
          "label" in item ? (item.label ?? "") : (item.channel ?? ""),
        ),
        views: Number(item.views ?? 0),
        sessions: Number(item.sessions ?? 0),
        visitors: Number(item.visitors ?? 0),
        ...("reference" in item && item.reference
          ? { reference: item.reference }
          : {}),
        ...("change" in item && item.change ? { change: item.change } : {}),
      })),
    };
  }
  const rows = collectReferrerRows(
    dataset,
    filtered,
    Math.max(1, filtered.visits.length),
    {
      includeFullUrl: tab === "link",
      directValue: "",
    },
  );
  const comparisonRows = comparison
    ? (() => {
        const referenceDataset = buildDemoFactDataset(
          siteId,
          comparison.from,
          comparison.to,
        );
        const referenceFiltered = applyDemoFilters(
          referenceDataset,
          comparison.filters,
        );
        return buildDemoComparisonRows(
          rows.map((item) => ({
            label: item.referrer,
            views: item.views,
            sessions: item.sessions,
            visitors: item.visitors,
          })),
          collectReferrerRows(
            referenceDataset,
            referenceFiltered,
            Math.max(1, referenceFiltered.visits.length),
            { includeFullUrl: tab === "link", directValue: "" },
          ).map((item) => ({
            label: item.referrer,
            views: item.views,
            sessions: item.sessions,
            visitors: item.visitors,
          })),
          params,
        );
      })()
    : null;
  return {
    ok: true,
    data: (comparisonRows ?? rows).map((item) => ({
      label: String(
        "label" in item ? (item.label ?? "") : (item.referrer ?? ""),
      ),
      views: Number(item.views ?? 0),
      sessions: Number(item.sessions ?? 0),
      visitors: Number(item.visitors ?? 0),
      ...("reference" in item && item.reference
        ? { reference: item.reference }
        : {}),
      ...("change" in item && item.change ? { change: item.change } : {}),
    })),
  };
}
export function generateDemoOverviewClientTab(
  siteId: string,
  params: Record<string, string | number>,
  tab: "browser" | "osVersion" | "deviceType" | "language" | "screenSize",
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const filters = parseDemoFilters(params);
  const dataset = buildDemoFactDataset(siteId, from, to);
  const filtered = applyDemoFilters(dataset, filters);
  const tabs = collectClientTabs(
    dataset,
    filtered,
    Math.max(1, filtered.visits.length),
  );
  const data = tabs[tab] ?? [];
  const comparison = resolveDemoComparison(params, filters);
  const comparisonData = comparison
    ? (() => {
        const referenceDataset = buildDemoFactDataset(
          siteId,
          comparison.from,
          comparison.to,
        );
        const referenceFiltered = applyDemoFilters(
          referenceDataset,
          comparison.filters,
        );
        const referenceTabs = collectClientTabs(
          referenceDataset,
          referenceFiltered,
          Math.max(1, referenceFiltered.visits.length),
        );
        return buildDemoComparisonRows(data, referenceTabs[tab] ?? [], params);
      })()
    : data;
  return {
    ok: true,
    data: comparisonData,
  };
}
export function generateDemoOverviewGeoTab(
  siteId: string,
  params: Record<string, string | number>,
  tab:
    "country" | "region" | "city" | "continent" | "timezone" | "organization",
): Record<string, unknown> {
  const from = parseDemoNumber(params.from, 0);
  const to = parseDemoNumber(params.to, Date.now());
  const dataset = buildDemoFactDataset(siteId, from, to);
  const rawFilters = parseDemoFilters(params);
  const filters =
    tab === "country" ? withoutDemoGeoFilter(rawFilters) : rawFilters;
  const tabs = collectGeoTabs(
    dataset,
    applyDemoFilters(dataset, filters),
    Math.max(1, dataset.visits.length),
  );
  const data = tabs[tab] ?? [];
  const comparison = resolveDemoComparison(params, rawFilters);
  const comparisonData = comparison
    ? (() => {
        const referenceDataset = buildDemoFactDataset(
          siteId,
          comparison.from,
          comparison.to,
        );
        const referenceFilters =
          tab === "country"
            ? withoutDemoGeoFilter(comparison.filters)
            : comparison.filters;
        const referenceFiltered = applyDemoFilters(
          referenceDataset,
          referenceFilters,
        );
        const referenceTabs = collectGeoTabs(
          referenceDataset,
          referenceFiltered,
          Math.max(1, referenceFiltered.visits.length),
        );
        return buildDemoComparisonRows(data, referenceTabs[tab] ?? [], params);
      })()
    : data;
  return {
    ok: true,
    data: comparisonData,
  };
}
export {
  generateDemoFilterOptions,
  generateDemoFilterValues,
} from "@/lib/demo/realtime/filter-options";
