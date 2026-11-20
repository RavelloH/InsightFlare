/**
 * Invocation metrics is a separate single-point dataset. The existing three
 * business Analytics Engine schemas must remain unchanged.
 *
 * Physical columns are 1-based; array positions are 0-based. Do not reorder
 * slots without bumping INVOCATION_METRICS_SCHEMA_VERSION.
 */
export const INVOCATION_METRICS_DATASET =
  "insightflare_invocation_metrics" as const;
export const INVOCATION_METRICS_SCHEMA_VERSION = 1 as const;
export const INVOCATION_METRICS_BLOBS = [
  "source",
  "trigger",
  "routeGroup",
  "routeKey",
  "method",
  "resultClass",
  "outcome",
  "cache",
  "dataSource",
  "appVersion",
  "primaryErrorCategory",
  "primaryErrorCode",
  "primaryErrorOperation",
  "primaryErrorLocation",
  "primaryErrorClass",
  "dominantOperation",
  "primaryErrorSeverity",
  "secondarySignalCodes",
  "safeDetailsJson",
  "reserved",
] as const;
export const INVOCATION_METRICS_DOUBLES = [
  "invocationMs",
  "handlerMs",
  "wsLifetimeMs",
  "d1Statements",
  "d1FinishedStatements",
  "d1UnobservedStatements",
  "d1SettledOperations",
  "d1FailedStatements",
  "d1RowsRead",
  "d1RowsWritten",
  "d1SqlDurationMs",
  "d1Attempts",
  "d1Retries",
  "d1OperationCumulativeDurationMs",
  "doCalls",
  "externalFetches",
  "errorEvents",
  "httpStatus",
  "validityCoverageFlags",
  "schemaVersion",
] as const;

export type InvocationMetricsBlob = (typeof INVOCATION_METRICS_BLOBS)[number];
export type InvocationMetricsDouble =
  (typeof INVOCATION_METRICS_DOUBLES)[number];
export type InvocationResultClass =
  "ok" | "client_error" | "failure" | "canceled";
export type InvocationCoverage = "unavailable" | "partial" | "complete";
export type InvocationMetricsPoint = {
  indexes: [string];
  blobs: string[];
  doubles: number[];
};

/**
 * Version 1 double19 (exact integer, safely within 53 bits):
 * bits 0/1/2: handler/status/WS lifetime present; bit 3: logs truncated.
 * Each 2-bit coverage field: 0=unavailable, 1=partial, 2=complete.
 * bits 4-5 rowsRead, 6-7 rowsWritten, 8-9 SQL engine duration,
 * 10-11 attempts AND retries, 12-13 DO SQL rowsRead,
 * 14-15 DO SQL rowsWritten. Never treat a zero placeholder as measured
 * without checking the corresponding presence/coverage flags.
 */
export const INV_FLAG_HANDLER_PRESENT = 1 << 0;
export const INV_FLAG_STATUS_PRESENT = 1 << 1;
export const INV_FLAG_WS_PRESENT = 1 << 2;
export const INV_FLAG_LOGS_TRUNCATED = 1 << 3;
export const INV_COVERAGE_SHIFT = {
  rowsRead: 4,
  rowsWritten: 6,
  sqlDuration: 8,
  attempts: 10,
  doSqlRowsRead: 12,
  doSqlRowsWritten: 14,
} as const;
const COVERAGE_ENCODE: Record<InvocationCoverage, number> = {
  unavailable: 0,
  partial: 1,
  complete: 2,
};
export function addInvocationCoverageFlag(
  flags: number,
  field: keyof typeof INV_COVERAGE_SHIFT,
  coverage: InvocationCoverage,
): number {
  const shift = INV_COVERAGE_SHIFT[field];
  return (flags & ~(3 << shift)) | (COVERAGE_ENCODE[coverage] << shift);
}
export function readInvocationCoverageFlag(
  flags: number,
  field: keyof typeof INV_COVERAGE_SHIFT,
): InvocationCoverage {
  const encoded = (Math.trunc(flags) >>> INV_COVERAGE_SHIFT[field]) & 3;
  return encoded === 2 ? "complete" : encoded === 1 ? "partial" : "unavailable";
}
