import { replaceUrlWithoutNavigation } from "@/lib/dashboard/client/history";
import type { TimeWindow } from "@/lib/dashboard/query-state";

export type PerformanceTab =
  "overview" | "hotspots" | "errors" | "samples" | "do";
export type PerformanceKind = "api-hot" | "sql-engine-fallback" | "scan";
export type PerformanceSource = "all" | "worker" | "do";
export type PerformanceResult = "ok" | "client_error" | "failure" | "canceled";
export type PerformanceTrigger =
  "request" | "alarm" | "scheduled" | "websocket";

export interface PerformanceState {
  tab: PerformanceTab;
  source: PerformanceSource;
  kind: PerformanceKind;
  routeKey: string;
  appVersion: string;
  sampleQueryId: string;
  sampleKind: PerformanceKind | "";
  sampleErrorCode: string;
  sampleResult: PerformanceResult | "";
  sampleTrigger: PerformanceTrigger | "";
}

export const PERFORMANCE_TABS = [
  "overview",
  "hotspots",
  "errors",
  "samples",
  "do",
] as const;
export const PERFORMANCE_KINDS = [
  "api-hot",
  "sql-engine-fallback",
  "scan",
] as const;
const SOURCES = ["all", "worker", "do"] as const;
const RESULTS = ["ok", "client_error", "failure", "canceled"] as const;
const TRIGGERS = ["request", "alarm", "scheduled", "websocket"] as const;

/** Mirrors the server-side route key allowlist so stale URLs never reach the API. */
const ROUTE_KEY =
  /^(?:api:\/[A-Za-z0-9_./:{}*-]+|api\.other|page\.other|server_function\.handler|do\.(?:ingest|snapshot|active|diagnostic|reconcile|flush|ws|other|alarm|websocket)|scheduled\.tasks)$/;
export const VERSION_PATTERN =
  /^(?:unknown|\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\+[a-f0-9]{7,12})?$/;
const QUERY_ID = /^[a-z0-9_.-]{1,96}$/;
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

function pick<T extends string>(
  value: string | null,
  choices: readonly T[],
  fallback: T,
): T {
  return choices.includes(value as T) ? (value as T) : fallback;
}

export function isValidRouteKey(value: string): boolean {
  return value.length <= 72 && ROUTE_KEY.test(value);
}

export function isValidAppVersion(value: string): boolean {
  return value.length <= 61 && VERSION_PATTERN.test(value);
}

export function readPerformanceState(
  search: URLSearchParams,
): PerformanceState {
  const routeKey = search.get("routeKey") ?? "";
  const appVersion = search.get("appVersion") ?? "";
  const sampleQueryId = search.get("sampleQueryId") ?? "";
  const sampleErrorCode = search.get("sampleErrorCode") ?? "";
  return {
    tab: pick(search.get("perfTab"), PERFORMANCE_TABS, "overview"),
    source: pick(search.get("perfSource"), SOURCES, "all"),
    kind: pick(search.get("hotspotKind"), PERFORMANCE_KINDS, "api-hot"),
    routeKey: isValidRouteKey(routeKey) ? routeKey : "",
    appVersion: isValidAppVersion(appVersion) ? appVersion : "",
    sampleQueryId: QUERY_ID.test(sampleQueryId) ? sampleQueryId : "",
    sampleKind: pick(search.get("sampleKind"), ["", ...PERFORMANCE_KINDS], ""),
    sampleErrorCode: ERROR_CODE.test(sampleErrorCode) ? sampleErrorCode : "",
    sampleResult: pick(search.get("sampleResult"), ["", ...RESULTS], ""),
    sampleTrigger: pick(search.get("sampleTrigger"), ["", ...TRIGGERS], ""),
  };
}

/**
 * The invocation dataset buckets by minute, hour or day only, and the API
 * rejects windows that end in the future.
 */
export function performanceRequestWindow(
  timeWindow: Pick<TimeWindow, "from" | "to" | "interval" | "timeZone">,
  now = Date.now(),
) {
  const to = Math.min(Math.floor(timeWindow.to), now - 1000);
  const from = Math.min(Math.floor(timeWindow.from), to - 60_000);
  const interval =
    timeWindow.interval === "minute" || timeWindow.interval === "hour"
      ? timeWindow.interval
      : "day";
  return { from, to, interval, timeZone: timeWindow.timeZone };
}

export type PerformanceUrlPatch = Partial<
  Record<
    | "perfTab"
    | "perfSource"
    | "hotspotKind"
    | "routeKey"
    | "appVersion"
    | "sampleQueryId"
    | "sampleKind"
    | "sampleErrorCode"
    | "sampleResult"
    | "sampleTrigger",
    string | null
  >
>;

export function patchPerformanceSearch(
  current: URLSearchParams,
  patch: PerformanceUrlPatch,
) {
  const next = new URLSearchParams(current);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, value);
  }
  if (next.get("perfTab") === "overview") next.delete("perfTab");
  return next;
}

export function updatePerformanceUrl(patch: PerformanceUrlPatch) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.search = patchPerformanceSearch(url.searchParams, patch).toString();
  replaceUrlWithoutNavigation(url.toString());
}
