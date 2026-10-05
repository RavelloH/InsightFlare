export type ChartLocale = string;

export type DashboardInterval = "minute" | "hour" | "day" | "week" | "month";

export interface ChartTimeWindow {
  from: number;
  to: number;
  interval: DashboardInterval;
  timeZone: string;
}

export type PerformanceMetricKey = "ttfb" | "fcp" | "lcp" | "cls" | "inp";

export interface EventTrendSeries {
  key: string;
  eventName: string;
  label: string;
  events: number;
  sessions: number;
  visitors: number;
  isOther?: boolean;
}

export interface EventsTrendData {
  ok: boolean;
  interval: DashboardInterval;
  series: EventTrendSeries[];
  data: Array<{
    bucket: number;
    timestampMs: number;
    totalEvents: number;
    eventsBySeries: Record<string, number>;
  }>;
}

export interface SiteTrafficChartMessages {
  common: {
    sitesFiltered: string;
    cumulativeTraffic: string;
  };
}
