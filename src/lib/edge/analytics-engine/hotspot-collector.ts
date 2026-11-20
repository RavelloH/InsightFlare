import type { InvocationLogger } from "@/lib/edge/observability/logger";

import type { SafeFilterShape } from "./filter-shape";
import {
  type TrustedQueryIdentity,
  QUERY_REGISTRY,
  QUERY_VARIANTS,
  UNKNOWN_QUERY_ID,
  verifiedQueryIdentity,
} from "./query-registry";

export type QueryObservation = {
  readonly identity?: TrustedQueryIdentity;
  /** A batch's shared D1 API wall is recorded globally, not on each SQL. */
  readonly apiWallMs?: number;
  readonly rowsRead?: number;
  readonly rowsWritten?: number;
  readonly sqlEngineMs?: number;
  readonly attempts?: number;
  readonly failed?: boolean;
  readonly batchSharedWall?: boolean;
  readonly filter?: SafeFilterShape;
};

export type QueryHotspotSummary = {
  id: string;
  variant: string;
  count: number;
  apiWallMs: number;
  sqlEngineMs: number;
  rowsRead: number;
  rowsWritten: number;
  attempts: number;
  failed: number;
  wallObserved: number;
  engineObserved: number;
  readObserved: number;
  writeObserved: number;
  attemptsObserved: number;
  readonly filter?: SafeFilterShape;
};
export type InvocationHotspots = {
  readonly queries: readonly QueryHotspotSummary[];
  readonly queryCount: number;
  readonly unknownCount: number;
  readonly droppedQueries: number;
  readonly d1ApiWallSumMs: number;
  readonly d1ApiCallCount: number;
  readonly filter?: SafeFilterShape;
};

const collectors = new WeakMap<InvocationLogger, HotspotCollector>();
// Cover the entire bounded, code-owned (ID, variant) domain. A first-seen
// cap of 32 could silently discard the actual hottest/most-scanned query.
// One extra slot is reserved for the unknown_d1 identity.
const MAX_QUERIES = QUERY_REGISTRY.size * QUERY_VARIANTS.length + 1;

const finite = (value: number | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

/** AE-specific, request-owned and bounded. Never added to generic logs. */
export class HotspotCollector {
  private readonly queries = new Map<string, QueryHotspotSummary>();
  private count = 0;
  private unknown = 0;
  private dropped = 0;
  private apiWall = 0;
  private apiCalls = 0;
  private filter?: SafeFilterShape;

  setFilter(shape: SafeFilterShape): void {
    if (!this.filter || this.filter.family === "none") this.filter = shape;
  }

  record(sample: QueryObservation): void {
    const identity = verifiedQueryIdentity(sample.identity);
    const key = `${identity.id}:${identity.variant}`;
    this.count++;
    if (identity.id === UNKNOWN_QUERY_ID) this.unknown++;

    if (sample.apiWallMs !== undefined) {
      this.apiWall += finite(sample.apiWallMs) ?? 0;
      this.apiCalls++;
    }
    const group = this.queries.get(key);
    if (!group && this.queries.size >= MAX_QUERIES) {
      this.dropped++;
      return;
    }
    const current: QueryHotspotSummary = group ?? {
      id: identity.id,
      variant: identity.variant,
      count: 0,
      apiWallMs: 0,
      sqlEngineMs: 0,
      rowsRead: 0,
      rowsWritten: 0,
      attempts: 0,
      failed: 0,
      wallObserved: 0,
      engineObserved: 0,
      readObserved: 0,
      writeObserved: 0,
      attemptsObserved: 0,
      ...(sample.filter ? { filter: sample.filter } : {}),
    };
    current.count++;
    if (sample.failed) current.failed++;
    if (!sample.batchSharedWall && finite(sample.apiWallMs) !== undefined) {
      current.apiWallMs += sample.apiWallMs!;
      current.wallObserved++;
    }
    if (finite(sample.sqlEngineMs) !== undefined) {
      current.sqlEngineMs += sample.sqlEngineMs!;
      current.engineObserved++;
    }
    if (finite(sample.rowsRead) !== undefined) {
      current.rowsRead += sample.rowsRead!;
      current.readObserved++;
    }
    if (finite(sample.rowsWritten) !== undefined) {
      current.rowsWritten += sample.rowsWritten!;
      current.writeObserved++;
    }
    if (finite(sample.attempts) !== undefined) {
      current.attempts += sample.attempts!;
      current.attemptsObserved++;
    }
    this.queries.set(key, current);
  }

  /** Count shared batch wait exactly once, with no per-SQL wall attribution. */
  recordBatchApiWall(ms: number): void {
    this.apiCalls++;
    this.apiWall += finite(ms) ?? 0;
  }

  snapshot(): InvocationHotspots {
    return {
      queries: [...this.queries.values()].map((q) => ({
        ...q,
        ...(q.filter ? { filter: q.filter } : {}),
      })),
      queryCount: this.count,
      unknownCount: this.unknown,
      droppedQueries: this.dropped,
      d1ApiWallSumMs: this.apiWall,
      d1ApiCallCount: this.apiCalls,
      ...(this.filter ? { filter: this.filter } : {}),
    };
  }
}

export function registerHotspotCollector(
  logger: InvocationLogger,
): HotspotCollector {
  let collector = collectors.get(logger);
  if (!collector) {
    collector = new HotspotCollector();
    collectors.set(logger, collector);
  }
  return collector;
}
export function currentHotspotCollector(
  logger: InvocationLogger | undefined,
): HotspotCollector | undefined {
  return logger ? collectors.get(logger) : undefined;
}
