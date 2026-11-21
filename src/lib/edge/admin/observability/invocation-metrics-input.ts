import { normalizeTimeZone } from "@/lib/analytics/time-zone";

const VIEWS = ["overview", "routes", "hotspots", "errors", "samples"] as const;
export const HOTSPOT_KINDS = [
  "api-hot",
  "sql-engine-fallback",
  "scan",
] as const;
const SOURCES = ["worker", "do", "all"] as const;
const TRIGGERS = ["request", "alarm", "scheduled", "websocket"] as const;
const RESULTS = ["ok", "client_error", "failure", "canceled"] as const;
const INTERVALS = ["minute", "hour", "day"] as const;
const DAY = 86_400_000;

export type InvocationView = (typeof VIEWS)[number];
export type HotspotKind = (typeof HOTSPOT_KINDS)[number];

const ROUTE_KEY =
  /^(?:api:\/[A-Za-z0-9_./:{}*-]+|api\.other|page\.other|server_function\.handler|do\.(?:ingest|snapshot|active|diagnostic|reconcile|flush|ws|other|alarm|websocket)|scheduled\.tasks)$/;
const APP_VERSION =
  /^(?:unknown|\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)(?:\+[a-f0-9]{7,12})?$/;

export function parseInvocationQuery(params: URLSearchParams, now: number) {
  const read = (key: string, pattern: RegExp, max = 128) => {
    const value = params.get(key);
    if (
      params.getAll(key).length > 1 ||
      (value !== null &&
        (value.length > max || value !== value.trim() || !pattern.test(value)))
    ) {
      throw new Error("invalid_filter");
    }
    return value;
  };
  const choice = <T extends string>(key: string, values: readonly T[]) => {
    const value = read(key, /^[a-z_-]+$/);
    const selected = values.find((item) => item === value);
    if (value !== null && !selected) throw new Error("invalid_filter");
    return selected;
  };
  try {
    const view = choice("view", VIEWS) ?? "overview";
    const to = Number(read("to", /^\d{13}$/) ?? now);
    const from = Number(read("from", /^\d{13}$/) ?? to - DAY);
    const limit = Number(read("limit", /^\d{1,3}$/) ?? 100);
    const interval =
      choice("interval", INTERVALS) ?? (to - from <= 2 * DAY ? "hour" : "day");
    const zone = read("timeZone", /^[A-Za-z0-9_+/-]+$/);
    const timeZone = zone === null ? "UTC" : normalizeTimeZone(zone);
    const routeKey = read("routeKey", ROUTE_KEY, 72);
    const appVersion = read("appVersion", APP_VERSION, 61);
    const source = choice("source", SOURCES) ?? "all";
    const trigger = choice("trigger", TRIGGERS);
    const resultClass = choice("resultClass", RESULTS);
    const kind = choice("kind", HOTSPOT_KINDS);
    if (
      !timeZone ||
      to > now ||
      from >= to ||
      to - from > 90 * DAY ||
      limit < 1 ||
      limit > 100 ||
      (kind && view !== "hotspots")
    )
      return null;
    const canonicalZone = new Intl.DateTimeFormat("en", {
      timeZone,
    }).resolvedOptions().timeZone;
    if (!/^[A-Za-z0-9_+/-]+$/.test(canonicalZone)) return null;
    return {
      view,
      interval,
      timeZone: canonicalZone,
      source,
      trigger,
      resultClass,
      routeKey,
      appVersion,
      kind,
      limit,
      window: {
        from,
        to,
        effectiveFrom: Math.ceil(from / 1000) * 1000,
        effectiveTo: Math.ceil(to / 1000) * 1000,
      },
    };
  } catch {
    return null;
  }
}

export type InvocationQuery = NonNullable<
  ReturnType<typeof parseInvocationQuery>
>;
