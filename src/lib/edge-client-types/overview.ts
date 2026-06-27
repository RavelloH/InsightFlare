export interface OverviewMetrics {
  views: number;
  sessions: number;
  visitors: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  bounceRate: number;
  approximateVisitors?: boolean;
}

export interface OverviewChangeRates {
  views: number | null;
  sessions: number | null;
  visitors: number | null;
  bounces: number | null;
  bounceRate: number | null;
  avgDurationMs: number | null;
}

export interface OverviewDetailPoint {
  bucket: number;
  timestampMs: number;
  views: number;
  visitors: number;
  sessions: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  source: "detail";
}

export interface OverviewDetailData {
  interval: "minute" | "hour" | "day" | "week" | "month";
  data: OverviewDetailPoint[];
}

export interface OverviewData {
  ok: boolean;
  data: OverviewMetrics;
  previousData?: OverviewMetrics;
  changeRates?: OverviewChangeRates;
  detail?: OverviewDetailData;
}

export interface TrendPoint {
  bucket: number;
  timestampMs: number;
  views: number;
  visitors: number;
  sessions: number;
  bounces: number;
  totalDurationMs: number;
  avgDurationMs: number;
  source: "detail";
}

export interface TrendData {
  ok: boolean;
  interval: "minute" | "hour" | "day" | "week" | "month";
  data: TrendPoint[];
}

export interface OverviewClientDimensionTabsData {
  ok: boolean;
  tabs: {
    browser: Array<{ label: string; views: number; sessions: number }>;
    osVersion: Array<{ label: string; views: number; sessions: number }>;
    deviceType: Array<{ label: string; views: number; sessions: number }>;
    language: Array<{ label: string; views: number; sessions: number }>;
    screenSize: Array<{ label: string; views: number; sessions: number }>;
  };
}

export interface OverviewGeoDimensionTabsData {
  ok: boolean;
  tabs: {
    country: Array<{ label: string; views: number; sessions: number }>;
    region: Array<{ label: string; views: number; sessions: number }>;
    city: Array<{ label: string; views: number; sessions: number }>;
    continent: Array<{ label: string; views: number; sessions: number }>;
    timezone: Array<{ label: string; views: number; sessions: number }>;
    organization: Array<{ label: string; views: number; sessions: number }>;
  };
}

export interface OverviewGeoPointsData {
  ok: boolean;
  data: Array<{
    latitude: number;
    longitude: number;
    timestampMs: number;
    country: string;
    region?: string;
    regionCode?: string;
    city?: string;
    pointCount?: number;
  }>;
  countryCounts: Array<{
    country: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  regionCounts: Array<{
    value: string;
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
  cityCounts: Array<{
    value: string;
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
}

export interface OverviewTabData {
  ok: boolean;
  data: Array<{
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
}

export interface OverviewGeoTabData {
  ok: boolean;
  data: Array<{
    value: string;
    label: string;
    views: number;
    sessions: number;
    visitors: number;
  }>;
}
