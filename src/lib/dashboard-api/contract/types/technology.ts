export type ClientDimensionKey =
  | "browser"
  | "operatingSystem"
  | "osVersion"
  | "deviceType"
  | "language"
  | "screenSize";

export interface BrowserTrendSeries {
  key: string;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
  isOther?: boolean;
}

export interface BrowserTrendPoint {
  bucket: number;
  timestampMs: number;
  totalVisitors: number;
  visitorsBySeries: Record<string, number>;
}

export interface BrowserTrendData {
  ok: boolean;
  interval: "minute" | "hour" | "day" | "week" | "month";
  series: BrowserTrendSeries[];
  data: BrowserTrendPoint[];
}

export interface ShareTrendDimensionData {
  series: BrowserTrendSeries[];
  data: BrowserTrendPoint[];
}

export interface ReferrerChannelTrendData {
  ok: boolean;
  interval: BrowserTrendData["interval"];
  source: ShareTrendDimensionData;
  channel: ShareTrendDimensionData;
}

export interface BrowserVersionSlice {
  key: string;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
  isOther?: boolean;
  isUnknown?: boolean;
}

export interface BrowserVersionBreakdownBrowser {
  browser: string;
  views: number;
  visitors: number;
  sessions: number;
  versions: BrowserVersionSlice[];
}

export interface BrowserVersionBreakdownData {
  ok: boolean;
  data: BrowserVersionBreakdownBrowser[];
}

export interface BrowserCrossBreakdownItem {
  key: string;
  label: string;
  views: number;
  visitors: number;
  sessions: number;
  isOther?: boolean;
  isUnknown?: boolean;
}

export interface BrowserCrossBreakdownRow extends BrowserCrossBreakdownItem {
  cells: BrowserCrossBreakdownItem[];
}

export interface BrowserCrossBreakdownDimensionData {
  columns: BrowserCrossBreakdownItem[];
  rows: BrowserCrossBreakdownRow[];
  totalVisitors: number;
}

export interface ClientCrossBreakdownData {
  ok: boolean;
  data: BrowserCrossBreakdownDimensionData;
}

export interface BrowserCrossBreakdownData {
  ok: boolean;
  operatingSystem: BrowserCrossBreakdownDimensionData;
  deviceType: BrowserCrossBreakdownDimensionData;
}

export interface BrowserRadarMetrics {
  /** Average session duration in ms */
  duration: number;
  /** Non-bounce rate (0..1) */
  engagement: number;
  /** Average pages per session */
  depth: number;
  /** Return visitor rate (0..1) */
  loyalty: number;
  /** Average sessions per visitor */
  frequency: number;
  /** Visitor share of total (0..1) */
  traffic: number;
}

export interface BrowserRadarItem {
  browser: string;
  visitors: number;
  sessions: number;
  metrics: BrowserRadarMetrics;
}

export interface BrowserRadarData {
  ok: boolean;
  data: BrowserRadarItem[];
}
