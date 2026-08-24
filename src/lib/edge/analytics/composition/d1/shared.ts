import type { QueryInput, QueryTime } from "@/lib/edge/analytics/contract";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  currentInvocationLogger,
  runWithD1Operation,
} from "@/lib/edge/observability-logger";
import type { Env } from "@/lib/edge/types";

export interface D1SiteQueryRuntimeOptions {
  readonly env: Env;
  readonly siteId: string;
  readonly diagnostics?: D1ReadDiagnostics;
}

export type RuntimeQuery = QueryInput & {
  readonly time: QueryTime;
  readonly [key: string]: unknown;
};

export function query(input: QueryInput): RuntimeQuery {
  return input as RuntimeQuery;
}

export function stringField(
  input: RuntimeQuery,
  name: string,
  fallback = "",
): string {
  const value = input[name];
  return typeof value === "string" ? value : fallback;
}

export function numberField(
  input: RuntimeQuery,
  name: string,
  fallback: number,
): number {
  const value = input[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function timeWindow(time: QueryTime) {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

export function measured<T>(
  operation: string,
  action: () => Promise<T>,
): Promise<T> {
  const logger = currentInvocationLogger();
  return logger
    ? logger.measure(operation, () => runWithD1Operation(operation, action))
    : action();
}

export function arrayField(
  input: RuntimeQuery,
  name: string,
): readonly unknown[] {
  return Array.isArray(input[name]) ? input[name] : [];
}

export function emptyEventContextCards() {
  return {
    page: { path: [], query: [], title: [], hostname: [], entry: [], exit: [] },
    source: { domain: [], link: [] },
    client: {
      browser: [],
      osVersion: [],
      deviceType: [],
      language: [],
      screenSize: [],
    },
    geo: {
      country: [],
      region: [],
      city: [],
      continent: [],
      timezone: [],
      organization: [],
    },
  };
}
