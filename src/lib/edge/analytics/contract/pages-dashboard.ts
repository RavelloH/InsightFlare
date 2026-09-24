import type { FilterDocument } from "@/lib/filter-contract/filters";

import type {
  Interval,
  PagesDashboardComparisonQuery,
  PagesDashboardMetric,
  QueryAudience,
  QueryWindow,
  SortDirection,
} from "./types";

export interface PageDashboardMetrics {
  readonly views: number;
  readonly visitors: number;
  readonly sessions: number;
  readonly bounceRate: number;
  readonly pagesPerSession: number;
  readonly avgDurationMs: number;
}
export interface PageDashboardItem {
  readonly pathname: string;
  readonly titles: readonly string[];
  readonly trend: readonly {
    readonly timestampMs: number;
    readonly views: number;
    readonly visitors: number;
  }[];
  readonly referenceTrend?: readonly {
    readonly timestampMs: number;
    readonly views: number;
    readonly visitors: number;
  }[];
  readonly metrics: PageDashboardMetrics;
  readonly changeRates: Readonly<
    Record<
      | "views"
      | "visitors"
      | "sessions"
      | "bounceRate"
      | "pagesPerSession"
      | "avgDurationMs",
      number | null
    >
  >;
  readonly reference?: PageDashboardMetrics;
  readonly change?: Readonly<
    Record<
      | "views"
      | "visitors"
      | "sessions"
      | "bounceRate"
      | "pagesPerSession"
      | "avgDurationMs",
      { readonly absolute: number; readonly relative: number | null }
    >
  >;
}
export interface PagesDashboardResult {
  readonly interval: Interval;
  readonly items: readonly PageDashboardItem[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}
export interface PagesDashboardReaderInput {
  readonly window: QueryWindow;
  readonly filters: FilterDocument;
  readonly interval: Interval;
  readonly page: { readonly limit: number; readonly cursor?: string | null };
  readonly search?: string;
  readonly sort?: {
    readonly key: PagesDashboardMetric;
    readonly direction: SortDirection;
  };
  readonly comparison?: PagesDashboardComparisonQuery;
  readonly audience?: QueryAudience;
}
