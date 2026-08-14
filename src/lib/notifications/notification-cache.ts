import type { queryOverviewAggregate } from "@/lib/edge/query/overview";

import type { NotificationEmailConfig } from "./email-config";
import type {
  MetricValueResult,
  NotificationMetric,
  NotificationMetricWindow,
  NotificationReportType,
  ReportData,
} from "./report-data";

export type NotificationOverviewLoaderResult = Awaited<
  ReturnType<typeof queryOverviewAggregate>
>;

export interface NotificationSiteInfo {
  name: string;
  domain: string;
}

/**
 * Request-local state shared by one notification evaluation invocation.
 * Nothing in this object is stored at module scope or persisted between ticks.
 */
export interface NotificationInvocationCache {
  sites: Map<string, Promise<NotificationSiteInfo | null>>;
  overviews: Map<string, Promise<NotificationOverviewLoaderResult>>;
  reports: Map<string, Promise<ReportData | null>>;
  metrics: Map<string, Promise<MetricValueResult>>;
  previousMetrics: Map<string, Promise<MetricValueResult>>;
  cumulativeMetrics: Map<string, Promise<number>>;
  lastSeenAt: Map<string, Promise<number | null>>;
  emailConfig: Promise<NotificationEmailConfig> | null;
}

export function createNotificationInvocationCache(): NotificationInvocationCache {
  return {
    sites: new Map(),
    overviews: new Map(),
    reports: new Map(),
    metrics: new Map(),
    previousMetrics: new Map(),
    cumulativeMetrics: new Map(),
    lastSeenAt: new Map(),
    emailConfig: null,
  };
}

export function getOrCreateCachedPromise<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  loader: () => Promise<T>,
): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing;

  const promise = loader();
  cache.set(key, promise);
  void promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}

export function notificationCacheKey(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      return JSON.stringify(part);
    })
    .join("|");
}

export type NotificationMetricCacheKey = readonly [
  string,
  NotificationMetric,
  NotificationMetricWindow,
  number,
  number,
  string,
];

export type NotificationReportCacheKey = readonly [
  string,
  NotificationReportType,
  number,
  string,
];
