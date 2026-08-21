import { jsonError } from "@/lib/api-v1/wire-helpers";
import {
  ANALYTICS_DIMENSIONS,
  ANALYTICS_METRICS,
  type AnalyticsDimension,
  type AnalyticsMetric,
} from "@/lib/edge/analytics/catalog";

export const DEFAULT_PAGE_LIMIT = 100;
export const MAX_PAGE_LIMIT = 1000;
export const MAX_CURSOR_LENGTH = 12_288;

export interface ParsedSort {
  field: string;
  direction: "asc" | "desc";
}

export interface CursorPagination {
  limit: number;
  cursor: string | null;
}

const METRIC_SET = new Set<string>(ANALYTICS_METRICS);
const DIMENSION_SET = new Set<string>(ANALYTICS_DIMENSIONS);

function validationError(
  message: string,
  details?: Record<string, unknown>,
): Response {
  return jsonError("validation_failed", message, 400, details);
}

export function parseMetrics(
  raw: string | null,
  fallback: readonly AnalyticsMetric[] = ["views", "sessions", "visitors"],
): AnalyticsMetric[] | Response {
  if (!raw) return [...fallback];
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalid = values.find((value) => !METRIC_SET.has(value));
  if (invalid) return validationError("Unknown metric", { metric: invalid });
  return [...new Set(values)] as AnalyticsMetric[];
}

export function validateDimension(
  value: string,
): AnalyticsDimension | Response {
  if (DIMENSION_SET.has(value)) return value as AnalyticsDimension;
  return validationError("Unknown dimension", { dimension: value });
}

const UNSUPPORTED_CROSS_BREAKDOWN = new Set([
  "session.entryPath",
  "session.exitPath",
  "event.name",
]);

export function validateCrossBreakdownDimension(
  value: string,
): AnalyticsDimension | Response {
  const base = validateDimension(value);
  if (base instanceof Response) return base;
  if (UNSUPPORTED_CROSS_BREAKDOWN.has(value)) {
    return validationError("Dimension not supported for cross-breakdowns", {
      dimension: value,
    });
  }
  return base;
}

export function parseSort(raw: string | null): ParsedSort | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return {
    field: trimmed.startsWith("-") ? trimmed.slice(1) : trimmed,
    direction: trimmed.startsWith("-") ? "desc" : "asc",
  };
}

export function parseCursorPagination(url: URL): CursorPagination | Response {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_PAGE_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit <= 0) {
    return validationError("Invalid limit", { field: "limit" });
  }
  const cursor = url.searchParams.get("cursor");
  if (
    cursor !== null &&
    !new RegExp(`^[A-Za-z0-9._~:-]{1,${MAX_CURSOR_LENGTH}}$`).test(cursor)
  ) {
    return validationError("Invalid cursor", { field: "cursor" });
  }
  return { limit: Math.min(limit, MAX_PAGE_LIMIT), cursor };
}
