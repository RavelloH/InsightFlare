import { parseGeoFilterValue } from "./core-filters";
import { customEventJsonTypeLabel } from "./core-parsers";
import { avgDuration, bounceRate } from "./core-time";
import {
  type DashboardFilterOption,
  type DimensionRow,
  DIRECT_REFERRER_FILTER_VALUE,
  type EventAnalyticsContextCards,
  type EventFieldRow,
  type EventFieldValueRow,
  type EventRecordRow,
  type EventSummaryCards,
  type GeoTabRow,
  type OverviewAggregateRow,
  type OverviewGeoTabKey,
  type PageRow,
  type ReferrerRow,
  type TrendAggregateRow,
  type VisitorRow,
} from "./core-types";

export function mapOverviewAggregate(
  row: OverviewAggregateRow,
  options?: { approximateVisitors?: boolean },
) {
  return {
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
    bounces: row.bounces,
    totalDurationMs: row.totalDuration,
    avgDurationMs: avgDuration(row.totalDuration, row.sessions),
    bounceRate: bounceRate(row.bounces, row.sessions),
    approximateVisitors: Boolean(options?.approximateVisitors),
  };
}

export function emptyOverviewAggregateRow(): OverviewAggregateRow {
  return {
    views: 0,
    sessions: 0,
    visitors: 0,
    bounces: 0,
    totalDuration: 0,
    durationViews: 0,
  };
}

export function mapPageCardMetrics(row: OverviewAggregateRow) {
  const overview = mapOverviewAggregate(row);
  return {
    views: overview.views,
    visitors: overview.visitors,
    sessions: overview.sessions,
    bounceRate: overview.bounceRate,
    pagesPerSession:
      overview.sessions > 0 ? overview.views / overview.sessions : 0,
    avgDurationMs: overview.avgDurationMs,
  };
}

export function mapTrendRows(rows: TrendAggregateRow[], source: "detail") {
  return rows.map((row) => ({
    bucket: row.bucket,
    timestampMs: row.timestampMs,
    views: row.views,
    visitors: row.visitors,
    sessions: row.sessions,
    bounces: row.bounces,
    totalDurationMs: row.totalDuration,
    avgDurationMs: avgDuration(row.totalDuration, row.sessions),
    source,
  }));
}

export function mapPages(rows: PageRow[]) {
  return rows.map((row) => ({
    pathname: row.pathname,
    query: row.query,
    hash: row.hash,
    views: row.views,
    sessions: row.sessions,
  }));
}

export function mapTabs(rows: readonly DimensionRow[] | null | undefined) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    label: row.value,
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
  }));
}

export function mapDimensionRows(rows: DimensionRow[]) {
  return rows.map((row) => ({
    value: row.value,
    // Keep label for existing public consumers while exposing the typed value.
    label: row.value,
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
  }));
}

export function mapGeoTabs(rows: readonly GeoTabRow[] | null | undefined) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    value: row.value,
    label: row.label,
    views: row.views,
    sessions: row.sessions,
    visitors: row.visitors,
  }));
}

export function mapEventAnalyticsContextCards(
  cards: EventAnalyticsContextCards,
) {
  return {
    page: {
      path: mapTabs(cards.page.path),
      query: mapTabs(cards.page.query),
      title: mapTabs(cards.page.title),
      hostname: mapTabs(cards.page.hostname),
      entry: mapTabs(cards.page.entry),
      exit: mapTabs(cards.page.exit),
    },
    source: {
      domain: mapTabs(cards.source.domain),
      link: mapTabs(cards.source.link),
    },
    client: {
      browser: mapTabs(cards.client.browser),
      osVersion: mapTabs(cards.client.osVersion),
      deviceType: mapTabs(cards.client.deviceType),
      language: mapTabs(cards.client.language),
      screenSize: mapTabs(cards.client.screenSize),
    },
    geo: {
      country: mapGeoTabs(cards.geo.country),
      region: mapGeoTabs(cards.geo.region),
      city: mapGeoTabs(cards.geo.city),
      continent: mapGeoTabs(cards.geo.continent),
      timezone: mapGeoTabs(cards.geo.timezone),
      organization: mapGeoTabs(cards.geo.organization),
    },
  };
}

export function mapEventSummaryCards(cards: EventSummaryCards) {
  return {
    event: {
      name: mapTabs(cards?.event?.name),
    },
    page: {
      path: mapTabs(cards?.page?.path),
      title: mapTabs(cards?.page?.title),
      hostname: mapTabs(cards?.page?.hostname),
    },
  };
}

export function mapEventRecord(row: EventRecordRow) {
  return {
    eventId: row.eventId,
    eventName: row.eventName,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    sequence: row.sequence,
    visitId: row.visitId,
    sessionId: row.sessionId,
    visitorId: row.visitorId,
    pathname: row.pathname,
    title: row.title,
    hostname: row.hostname,
    referrerHost: row.referrerHost,
    country: row.country,
    region: row.region,
    city: row.city,
    browser: row.browser,
    browserVersion: row.browserVersion,
    os: row.os,
    osVersion: row.osVersion,
    deviceType: row.deviceType,
    nodeCount: row.nodeCount,
    valueCount: row.valueCount,
  };
}

export function mapEventField(row: EventFieldRow) {
  let exampleValue: string | number | boolean | null = null;
  if (row.valueType === 1 && row.stringValue !== null) {
    exampleValue = row.stringValue;
  } else if (row.valueType === 2 && row.numberValue !== null) {
    exampleValue = row.numberValue;
  } else if (row.valueType === 3 && row.booleanValue !== null) {
    exampleValue = row.booleanValue === 1;
  }
  return {
    path: row.path,
    valueType: customEventJsonTypeLabel(row.valueType),
    events: row.events,
    occurrences: row.occurrences,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    exampleValue,
  };
}

export function mapEventFieldValue(row: EventFieldValueRow) {
  let value: string | number | boolean | null = null;
  if (row.valueType === 1) {
    value = row.stringValue ?? "";
  } else if (row.valueType === 2) {
    value = Number(row.numberValue ?? 0);
  } else if (row.valueType === 3) {
    value = row.booleanValue === 1;
  }
  return {
    value,
    events: Number(row.events ?? 0),
    occurrences: Number(row.occurrences ?? 0),
    firstSeenAt: Number(row.firstSeenAt ?? 0),
    lastSeenAt: Number(row.lastSeenAt ?? 0),
  };
}

export function mapReferrers(rows: ReferrerRow[]) {
  return rows.map((row) => ({
    referrer: row.referrer,
    views: row.views,
    sessions: row.sessions,
  }));
}

export function mapVisitors(rows: VisitorRow[]) {
  return rows.map((row) => ({
    visitorId: row.visitorId,
    sessionId: row.sessionId ?? "",
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    views: row.views,
    sessions: row.sessions,
    events: row.events ?? 0,
    country: row.country ?? "",
    region: row.region ?? "",
    regionCode: row.regionCode ?? "",
    city: row.city ?? "",
    referrerHost: row.referrerHost ?? "",
    referrerUrl: row.referrerUrl ?? "",
    browser: row.browser ?? "",
    browserVersion: row.browserVersion ?? "",
    os: row.os ?? "",
    osVersion: row.osVersion ?? "",
    deviceType: row.deviceType ?? "",
    screenWidth: row.screenWidth ?? null,
    screenHeight: row.screenHeight ?? null,
  }));
}

export function dedupeFilterOptions(
  options: DashboardFilterOption[],
): DashboardFilterOption[] {
  const seen = new Set<string>();
  const deduped: DashboardFilterOption[] = [];
  for (const option of options) {
    const value = String(option.value ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push({
      value,
      label: String(option.label ?? value).trim() || value,
      ...(option.group ? { group: option.group } : {}),
    });
  }
  return deduped;
}

export function mapDimensionRowsToFilterOptions(
  rows: DimensionRow[],
): DashboardFilterOption[] {
  return dedupeFilterOptions(
    rows.map((row) => {
      const value = String(row.value ?? "").trim();
      return {
        value,
        label: value,
      };
    }),
  );
}

export function mapReferrerRowsToFilterOptions(
  rows: ReferrerRow[],
): DashboardFilterOption[] {
  return dedupeFilterOptions(
    rows.map((row) => {
      const value = String(row.referrer ?? "").trim();
      if (!value) {
        return {
          value: DIRECT_REFERRER_FILTER_VALUE,
          label: DIRECT_REFERRER_FILTER_VALUE,
        };
      }
      return {
        value,
        label: value,
      };
    }),
  );
}

export function mapGeoRowsToFilterOptions(
  rows: DimensionRow[],
  group: "country" | "region" | "city",
): DashboardFilterOption[] {
  return dedupeFilterOptions(
    rows.map((row) => {
      const value = String(row.value ?? "").trim();
      if (!value) {
        return {
          value: "",
          label: "",
          group,
        };
      }
      const parsed = parseGeoFilterValue(value);
      if (group === "country") {
        return {
          value,
          label: parsed?.country || value,
          group,
        };
      }
      if (group === "region") {
        return {
          value,
          label:
            parsed?.regionName ||
            parsed?.regionCode ||
            parsed?.country ||
            value,
          group,
        };
      }
      return {
        value,
        label:
          parsed?.city ||
          parsed?.regionName ||
          parsed?.regionCode ||
          parsed?.country ||
          value,
        group,
      };
    }),
  );
}

export interface DimensionAccumulator {
  views: number;
  sessions: Set<string>;
  visitors: Set<string>;
}

export interface GeoDimensionAccumulator extends DimensionAccumulator {
  visitors: Set<string>;
}

export function addDimensionValue(
  buckets: Map<string, DimensionAccumulator>,
  rawValue: string,
  sessionId: string,
  visitorId?: string,
): void {
  const value = rawValue.trim();
  if (!value) return;
  const bucket = buckets.get(value) ?? {
    views: 0,
    sessions: new Set<string>(),
    visitors: new Set<string>(),
  };
  bucket.views += 1;
  if (sessionId) bucket.sessions.add(sessionId);
  if (visitorId) bucket.visitors.add(visitorId);
  buckets.set(value, bucket);
}

export function finalizeDimensionBuckets(
  buckets: Map<string, DimensionAccumulator>,
  limit: number,
): DimensionRow[] {
  return [...buckets.entries()]
    .map(([value, bucket]) => ({
      value,
      views: bucket.views,
      sessions: bucket.sessions.size,
      visitors: bucket.visitors.size,
    }))
    .sort(
      (left, right) =>
        right.views - left.views ||
        right.sessions - left.sessions ||
        left.value.localeCompare(right.value),
    )
    .slice(0, limit);
}

export function addGeoDimensionValue(
  buckets: Map<string, GeoDimensionAccumulator>,
  rawValue: string,
  sessionId: string,
  visitorId: string,
): void {
  const value = rawValue.trim();
  if (!value) return;
  const bucket = buckets.get(value) ?? {
    views: 0,
    sessions: new Set<string>(),
    visitors: new Set<string>(),
  };
  bucket.views += 1;
  if (sessionId) bucket.sessions.add(sessionId);
  if (visitorId) bucket.visitors.add(visitorId);
  buckets.set(value, bucket);
}

export function finalizeGeoDimensionBuckets(
  buckets: Map<string, GeoDimensionAccumulator>,
  limit: number,
  labelResolver?: (value: string) => string,
): GeoTabRow[] {
  return [...buckets.entries()]
    .map(([value, bucket]) => ({
      value,
      label: labelResolver ? labelResolver(value) : value,
      views: bucket.views,
      sessions: bucket.sessions.size,
      visitors: bucket.visitors.size,
    }))
    .sort(
      (left, right) =>
        right.views - left.views ||
        right.sessions - left.sessions ||
        right.visitors - left.visitors ||
        left.label.localeCompare(right.label),
    )
    .slice(0, limit);
}

export function geoTabLabel(value: string, tab: OverviewGeoTabKey): string {
  const parsed = parseGeoFilterValue(value);
  if (tab === "country") {
    return parsed?.country || value;
  }
  if (tab === "region") {
    return parsed?.regionName || parsed?.regionCode || parsed?.country || value;
  }
  if (tab === "city") {
    return (
      parsed?.city ||
      parsed?.regionName ||
      parsed?.regionCode ||
      parsed?.country ||
      value
    );
  }
  return value;
}
