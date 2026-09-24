import type { QueryTime } from "@/lib/edge/analytics/contract";
import type { D1ReadDiagnostics } from "@/lib/edge/analytics/providers/d1/internal/diagnostics";
import {
  currentInvocationLogger,
  runWithD1Operation,
} from "@/lib/edge/observability/logger";
import type { Env } from "@/lib/edge/types";
export interface D1SiteRuntimeBindings {
  readonly env: Env;
  readonly siteId: string;
  readonly diagnostics?: D1ReadDiagnostics;
}
export function stringField<Input extends object, Field extends keyof Input>(
  input: Input,
  name: Field,
  fallback = "",
): string {
  const value = input[name];
  return typeof value === "string" ? value : fallback;
}
export function numberField<Input extends object, Field extends keyof Input>(
  input: Input,
  name: Field,
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
export function arrayField<Input extends object, Field extends keyof Input>(
  input: Input,
  name: Field,
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
