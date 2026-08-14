import {
  type PerformanceCacheState,
  writeSampledPerformanceDiagnostic,
} from "./performance-diagnostics";
import type { Env } from "./types";

interface D1ResultWithMeta {
  meta?: {
    rows_read?: unknown;
  };
}

export interface PerformanceQueryObserver {
  cacheState: PerformanceCacheState;
  completed: boolean;
  d1QueryCount: number;
  d1RowsRead: number;
  fingerprint: string;
  route: string;
  rowsReadAvailable: boolean;
  startedAtMs: number;
}

export interface CompletePerformanceQueryObservation {
  resultBucket: string;
  statusCode: number;
  windowBucket: string;
}

/**
 * Request-scoped D1 accounting for new performance-sensitive routes.
 * `.all()` results can carry `meta.rows_read`; `first`, `run`, and batch
 * operations intentionally make the aggregate unavailable rather than
 * reporting a misleading partial count.
 */
export function createPerformanceQueryObserver(
  route: string,
  fingerprint: string,
  cacheState: PerformanceCacheState = "miss",
): PerformanceQueryObserver {
  return {
    cacheState,
    completed: false,
    d1QueryCount: 0,
    d1RowsRead: 0,
    fingerprint,
    route,
    rowsReadAvailable: true,
    startedAtMs: Date.now(),
  };
}

/**
 * Records the result of one `D1PreparedStatement.all()` call. D1 exposes
 * `meta.rows_read` on this result shape only, so no other operation accepts a
 * result argument here.
 */
export function recordD1All(
  observer: PerformanceQueryObserver,
  result: D1ResultWithMeta,
): void {
  observer.d1QueryCount += 1;
  const rowsRead = result.meta?.rows_read;
  if (typeof rowsRead !== "number" || !Number.isFinite(rowsRead)) {
    observer.rowsReadAvailable = false;
    return;
  }
  observer.d1RowsRead += Math.max(0, Math.trunc(rowsRead));
}

/** Records a `first()` or `run()` call, whose rows-read metric is unavailable. */
export function recordD1FirstOrRun(observer: PerformanceQueryObserver): void {
  observer.d1QueryCount += 1;
  observer.rowsReadAvailable = false;
}

/**
 * Records one `batch()` call. Its constituent result metadata cannot be
 * reliably aggregated at request scope, so the entire request fails closed.
 */
export function recordD1Batch(
  observer: PerformanceQueryObserver,
  statementCount: number,
): void {
  observer.d1QueryCount += Math.max(0, Math.trunc(statementCount));
  observer.rowsReadAvailable = false;
}

export function completePerformanceQueryObservation(
  env: Env,
  observer: PerformanceQueryObserver,
  input: CompletePerformanceQueryObservation,
): Promise<boolean> {
  if (observer.completed) return Promise.resolve(false);
  observer.completed = true;
  return writeSampledPerformanceDiagnostic(env, {
    cacheState: observer.cacheState,
    d1QueryCount: observer.d1QueryCount,
    d1RowsRead: observer.rowsReadAvailable ? observer.d1RowsRead : null,
    fingerprint: observer.fingerprint,
    resultBucket: input.resultBucket,
    route: observer.route,
    statusCode: input.statusCode,
    wallMs: Math.max(0, Date.now() - observer.startedAtMs),
    windowBucket: input.windowBucket,
  });
}
