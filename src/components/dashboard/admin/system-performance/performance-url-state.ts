import { replaceUrlWithoutNavigation } from "@/lib/dashboard/client/history";

export type PerformanceTab =
  "overview" | "hotspots" | "errors" | "do" | "samples";
export type PerformanceRange = "1h" | "6h" | "24h" | "7d" | "30d" | "custom";
export type PerformanceKind = "api-hot" | "sql-engine-fallback" | "scan";
export type PerformanceSource = "all" | "worker" | "do";
export type PerformanceState = {
  view: PerformanceTab;
  range: PerformanceRange;
  customFrom: number | null;
  customTo: number | null;
  source: PerformanceSource;
  kind: PerformanceKind;
  routeKey: string;
  appVersion: string;
  doView: "live" | "history";
  sampleQueryId: string;
  sampleKind: PerformanceKind | "";
  sampleErrorCode: string;
  sampleResult: string;
  sampleTrigger: string;
};

const HOUR = 3_600_000;
const RANGE_HOURS: Record<Exclude<PerformanceRange, "custom">, number> = {
  "1h": 1,
  "6h": 6,
  "24h": 24,
  "7d": 168,
  "30d": 720,
};
const ROUTE_KEY =
  /^(?:api:\/[A-Za-z0-9_./:{}*-]+|api\.other|page\.other|server_function\.handler|do\.(?:ingest|snapshot|active|diagnostic|reconcile|flush|ws|other|alarm|websocket)|scheduled\.tasks)$/;
export const VERSION_PATTERN =
  /^(?:unknown|\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\+[a-f0-9]{7,12})?$/;

export function readPerformanceState(
  search: URLSearchParams,
  now = Date.now(),
): PerformanceState {
  const select = <T extends string>(
    key: string,
    choices: readonly T[],
    fallback: T,
  ) => {
    const value = search.get(key);
    return choices.includes(value as T) ? (value as T) : fallback;
  };
  let range = select(
    "perfRange",
    ["1h", "6h", "24h", "7d", "30d", "custom"] as const,
    "24h",
  );
  let customFrom: number | null = null;
  let customTo: number | null = null;
  if (range === "custom") {
    const rawFrom = search.get("perfFrom") ?? "";
    const rawTo = search.get("perfTo") ?? "";
    const from = Number(rawFrom);
    const to = Number(rawTo);
    if (
      /^\d{13}$/.test(rawFrom) &&
      /^\d{13}$/.test(rawTo) &&
      from < to &&
      to <= now &&
      to - from <= 90 * 24 * HOUR
    ) {
      customFrom = from;
      customTo = to;
    } else range = "24h";
  }
  const routeKey = search.get("routeKey") ?? "";
  const appVersion = search.get("appVersion") ?? "";
  const sampleQueryId = search.get("sampleQueryId") ?? "";
  const sampleErrorCode = search.get("sampleErrorCode") ?? "";
  return {
    view: select(
      "perfTab",
      ["overview", "hotspots", "errors", "do", "samples"] as const,
      "overview",
    ),
    range,
    customFrom,
    customTo,
    source: select("perfSource", ["all", "worker", "do"] as const, "all"),
    kind: select(
      "hotspotKind",
      ["api-hot", "sql-engine-fallback", "scan"] as const,
      "api-hot",
    ),
    routeKey: routeKey.length <= 72 && ROUTE_KEY.test(routeKey) ? routeKey : "",
    appVersion:
      appVersion.length <= 61 && VERSION_PATTERN.test(appVersion)
        ? appVersion
        : "",
    doView: select("perfDoView", ["live", "history"] as const, "live"),
    sampleQueryId: /^[a-z0-9_.-]{1,96}$/.test(sampleQueryId)
      ? sampleQueryId
      : "",
    sampleKind: select(
      "sampleKind",
      ["", "api-hot", "sql-engine-fallback", "scan"] as const,
      "",
    ),
    sampleErrorCode: /^[a-z0-9_]{1,64}$/.test(sampleErrorCode)
      ? sampleErrorCode
      : "",
    sampleResult: select(
      "sampleResult",
      ["", "ok", "client_error", "failure", "canceled"] as const,
      "",
    ),
    sampleTrigger: select(
      "sampleTrigger",
      ["", "request", "alarm", "scheduled", "websocket"] as const,
      "",
    ),
  };
}
export function performanceWindow(state: PerformanceState, now = Date.now()) {
  const to =
    state.range === "custom" && state.customTo !== null
      ? state.customTo
      : now - 3000;
  const from =
    state.range === "custom" && state.customFrom !== null
      ? state.customFrom
      : to - RANGE_HOURS[state.range === "custom" ? "24h" : state.range] * HOUR;
  const span = to - from;
  return {
    from,
    to,
    interval: span <= HOUR ? "minute" : span <= 48 * HOUR ? "hour" : "day",
  };
}

export type PerformanceUrlPatch = Partial<
  Record<
    | "perfTab"
    | "perfRange"
    | "perfFrom"
    | "perfTo"
    | "perfSource"
    | "hotspotKind"
    | "routeKey"
    | "appVersion"
    | "perfDoView"
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
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  }
  return next;
}
export function updatePerformanceUrl(patch: PerformanceUrlPatch) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.search = patchPerformanceSearch(url.searchParams, patch).toString();
  replaceUrlWithoutNavigation(url.toString());
}
