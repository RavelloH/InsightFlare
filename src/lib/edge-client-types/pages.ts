import type { PaginatedCollection } from "./pagination";

export interface PageItem {
  pathname: string;
  query?: string;
  hash?: string;
  views: number;
  sessions: number;
}

export interface PagesData {
  ok: boolean;
  data: PaginatedCollection<PageItem>;
  tabs?: {
    path: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
    title: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
    hostname: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
    entry: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
    exit: Array<{
      label: string;
      views: number;
      sessions: number;
    }>;
  };
}

export interface PagesDashboardMetrics {
  views: number;
  visitors: number;
  sessions: number;
  bounceRate: number;
  pagesPerSession: number;
  avgDurationMs: number;
}

export interface PagesDashboardChangeRates {
  views: number | null;
  visitors: number | null;
  sessions: number | null;
  bounceRate: number | null;
  pagesPerSession: number | null;
  avgDurationMs: number | null;
}

export interface PagesDashboardItem {
  pathname: string;
  titles: string[];
  trend: Array<{
    timestampMs: number;
    views: number;
    visitors: number;
  }>;
  metrics: PagesDashboardMetrics;
  changeRates: PagesDashboardChangeRates;
}

export interface PagesDashboardData {
  ok: boolean;
  interval: "minute" | "hour" | "day" | "week" | "month";
  data: PagesDashboardItem[];
  meta: {
    page: number;
    pageSize: number;
    returned: number;
    hasMore: boolean;
    nextPage: number | null;
  };
}
