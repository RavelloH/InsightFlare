import type { PaginatedCollection } from "./pagination";

export interface ReferrerRadarMetrics {
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

export interface ReferrerRadarItem {
  referrer: string;
  visitors: number;
  sessions: number;
  metrics: ReferrerRadarMetrics;
}

export interface ReferrerRadarData {
  ok: boolean;
  data: ReferrerRadarItem[];
}

export interface ReferrersData {
  ok: boolean;
  data: PaginatedCollection<{
    referrer: string;
    views: number;
    sessions: number;
  }>;
}

export interface ReferrerSummaryData {
  ok: boolean;
  data: {
    totalViews: number;
    directViews: number;
    externalViews: number;
    uniqueDomains: number;
    uniqueLinks: number;
    truncated: boolean;
    topSources: Array<{
      referrer: string;
      views: number;
    }>;
  };
}
