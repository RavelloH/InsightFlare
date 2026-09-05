import type { TimeWindow } from "@/lib/dashboard/query-state";
import type {
  DashboardFilterOptionsData,
  DimensionData,
  EventBreakdownsData,
  EventField,
  EventFieldValuesData,
  EventRecordDetailData,
  EventsRecordsData,
  EventsSummaryData,
  EventsTrendData,
  EventTypeDetailData,
  JourneyEventDetailData,
  OverviewClientDimensionTabsData as OverviewClientDimensionTabsResponse,
  OverviewData,
  OverviewGeoDimensionTabsData as OverviewGeoDimensionTabsResponse,
  OverviewGeoPointsData,
  OverviewGeoTabData,
  OverviewTabData,
  PagesData,
  PerformanceData,
  PerformanceMetricKey,
  ReferrersData,
  SessionDetailData,
  SessionsData,
  TrendData,
  VisitorDetailData,
  VisitorsData,
} from "@/lib/edge-client";

function emptyPagination(limit = 0) {
  return {
    limit,
    returned: 0,
    hasMore: false,
    nextCursor: null,
  } as const;
}

type PageCardTabsData = NonNullable<PagesData["tabs"]>;
type OverviewClientDimensionTabsData =
  OverviewClientDimensionTabsResponse["tabs"];
type OverviewGeoDimensionTabsData = OverviewGeoDimensionTabsResponse["tabs"];

export function emptyOverview(): OverviewData {
  return {
    ok: true,
    data: {
      views: 0,
      sessions: 0,
      visitors: 0,
      bounces: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      bounceRate: 0,
      approximateVisitors: false,
    },
  };
}

export function emptyTrend(interval: TimeWindow["interval"]): TrendData {
  return {
    ok: true,
    interval,
    data: [],
  };
}

export function emptyPages(): PagesData {
  return { ok: true, data: { items: [], pagination: emptyPagination() } };
}

export function emptyPageCardTabs(): PageCardTabsData {
  return {
    path: [],
    title: [],
    hostname: [],
    entry: [],
    exit: [],
  };
}

export function emptyOverviewClientDimensionTabs(): OverviewClientDimensionTabsData {
  return {
    browser: [],
    osVersion: [],
    deviceType: [],
    language: [],
    screenSize: [],
  };
}

export function emptyOverviewGeoDimensionTabs(): OverviewGeoDimensionTabsData {
  return {
    country: [],
    region: [],
    city: [],
    continent: [],
    timezone: [],
    organization: [],
  };
}

export function emptyOverviewGeoPoints(): OverviewGeoPointsData {
  return {
    ok: true,
    data: [],
    countryCounts: [],
    regionCounts: [],
    cityCounts: [],
  };
}

export function emptyReferrers(): ReferrersData {
  return { ok: true, data: { items: [], pagination: emptyPagination() } };
}

export function emptyDimension(): DimensionData {
  return { ok: true, data: [] };
}

export function emptyVisitors(): VisitorsData {
  return {
    ok: true,
    data: { items: [], pagination: emptyPagination() },
  };
}

export function emptySessions(): SessionsData {
  return {
    ok: true,
    data: { items: [], pagination: emptyPagination() },
  };
}

export function emptyVisitorDetail(): VisitorDetailData {
  return { ok: true, data: null };
}

export function emptySessionDetail(): SessionDetailData {
  return { ok: true, data: null };
}

export function emptyEventsSummary(): EventsSummaryData {
  return {
    ok: true,
    summary: {
      events: 0,
      eventTypes: 0,
      sessions: 0,
      visitors: 0,
      avgEventsPerSession: 0,
    },
    cards: {
      event: {
        name: [],
      },
      page: {
        path: [],
        title: [],
        hostname: [],
      },
    },
  };
}

export function emptyEventBreakdowns(): EventBreakdownsData {
  return {
    pages: [],
    countries: [],
    devices: [],
    browsers: [],
  };
}

export function emptyEventsTrend(
  interval: TimeWindow["interval"],
): EventsTrendData {
  return {
    ok: true,
    interval,
    series: [],
    data: [],
  };
}

export function emptyEventsRecords(limit = 0): EventsRecordsData {
  return {
    ok: true,
    data: {
      items: [],
      pagination: {
        limit,
        returned: 0,
        hasMore: false,
        nextCursor: null,
      },
    },
  };
}

export function emptyEventTypeDetail(eventName = ""): EventTypeDetailData {
  return {
    ok: true,
    eventName,
    summary: {
      events: 0,
      eventTypes: eventName ? 1 : 0,
      sessions: 0,
      visitors: 0,
      avgEventsPerSession: 0,
      shareOfAllEvents: 0,
    },
    trend: {
      data: [],
    },
    breakdowns: emptyEventBreakdowns(),
    cards: emptyEventAnalyticsContextCards(),
    fields: [],
  };
}

export function emptyEventFieldValues(
  fieldPath = "",
  fieldValueType: EventField["valueType"] | "" = "",
): EventFieldValuesData {
  return {
    ok: true,
    fieldPath,
    fieldValueType,
    data: { items: [], pagination: emptyPagination() },
  };
}

export function emptyEventAnalyticsContextCards(): EventTypeDetailData["cards"] {
  return {
    page: {
      path: [],
      query: [],
      title: [],
      hostname: [],
      entry: [],
      exit: [],
    },
    source: {
      domain: [],
      link: [],
    },
    client: {
      browser: [],
      osVersion: [],
      deviceType: [],
      language: [],
      screenSize: [],
    },
    geo: {
      country: [],
      region: [],
      city: [],
      continent: [],
      timezone: [],
      organization: [],
    },
  };
}

export function emptyEventRecordDetail(): EventRecordDetailData {
  return { ok: true, data: null };
}

export function emptyJourneyEventDetail(): JourneyEventDetailData {
  return { ok: true, data: null };
}

export function emptyPerformance(
  interval: TimeWindow["interval"],
): PerformanceData {
  const emptyMetric = {
    avg: null,
    p50: null,
    p75: null,
    p95: null,
    samples: 0,
  };
  const emptyTrend: PerformanceData["trends"][PerformanceMetricKey] = [];
  return {
    ok: true,
    interval,
    summaries: {
      ttfb: { ...emptyMetric },
      fcp: { ...emptyMetric },
      lcp: { ...emptyMetric },
      cls: { ...emptyMetric },
      inp: { ...emptyMetric },
    },
    trends: {
      ttfb: [...emptyTrend],
      fcp: [...emptyTrend],
      lcp: [...emptyTrend],
      cls: [...emptyTrend],
      inp: [...emptyTrend],
    },
    routes: [],
    countries: [],
  };
}

export function emptyOverviewTab(): OverviewTabData {
  return { ok: true, data: { items: [], pagination: emptyPagination() } };
}

export function emptyOverviewGeoTab(): OverviewGeoTabData {
  return { ok: true, data: [] };
}

export function emptyDashboardFilterOptions(): DashboardFilterOptionsData {
  return {
    ok: true,
    data: { items: [], pagination: emptyPagination() },
  };
}
