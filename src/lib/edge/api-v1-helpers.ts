/**
 * Compatibility barrel for API v1 transport helpers.
 * Implementations live under src/lib/api-v1 and are imported directly by
 * production modules. Keep this facade for existing internal consumers while
 * the API v1 helper split settles.
 */
export { requireScope } from "@/lib/api-v1/auth-helpers";
export {
  epochSecondsToIso,
  normalizeUnknownDirect,
} from "@/lib/api-v1/normalization";
export {
  type CursorPagination,
  DEFAULT_PAGE_LIMIT,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_LIMIT,
  parseCursorPagination,
  type ParsedSort,
  parseMetrics,
  parseSort,
  validateCrossBreakdownDimension,
  validateDimension,
} from "@/lib/api-v1/query-helpers";
export {
  isValidTimeZone,
  type ParsedTimeRange,
  parsePreset,
  parseTimeRange,
  type TimeRange,
} from "@/lib/api-v1/time-range-helpers";
export {
  API_V1_VERSION,
  type ApiMeta,
  BATCH_MAX_REQUESTS,
  generatedAt,
  getRequestMeta,
  jsonError,
  jsonList,
  jsonPaginated,
  jsonSuccess,
  methodNotAllowed,
} from "@/lib/api-v1/wire-helpers";
export {
  ANALYTICS_DIMENSIONS,
  ANALYTICS_METRICS,
  type AnalyticsDimension,
  type AnalyticsMetric,
  type ApiInterval,
  INTERVALS,
  TIME_PRESETS,
  type TimePreset,
} from "@/lib/edge/analytics/contract/catalog";
