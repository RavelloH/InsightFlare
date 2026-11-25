import type { InvocationLogger } from "@/lib/edge/observability/logger";

import type { SafeFilterShape } from "./filter-shape";
import {
  type TrustedQueryIdentity,
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
/** Fixed outcome keys only: no site IDs, filter values or SQL text. */
export const DIMENSION_BATCH_OUTCOMES = [
  "merged2",
  "merged3",
  "merged4",
  "budgetFallback",
  "queryFallback",
  "resultFallback",
  "singleton",
  "cancelled",
  "unfiltered",
  "eventScope",
  "unprepared",
  "pageLimit",
  "diagnostics",
  "audience",
  "dbMismatch",
] as const;
export type DimensionBatchOutcome = (typeof DIMENSION_BATCH_OUTCOMES)[number];
export type DimensionBatchSummary = Partial<
  Record<
    DimensionBatchOutcome,
    {
      events: number;
      items: number;
    }
  >
>;
export type InvocationHotspots = {
  readonly queries: readonly QueryHotspotSummary[];
  readonly queryCount: number;
  readonly unknownCount: number;
  readonly droppedQueries: number;
  readonly d1ApiWallSumMs: number;
  readonly d1ApiCallCount: number;
  readonly filter?: SafeFilterShape;
  readonly filterAmbiguous: boolean;
  readonly dimensionBatch?: DimensionBatchSummary;
};

const collectors = new WeakMap<InvocationLogger, HotspotCollector>();
// Shape-aware IDs multiply the key domain. Keep memory bounded independent
// of user-controlled AST cardinality and suppress ranking on overflow.
const MAX_QUERIES = 256;

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
  private filterAmbiguous = false;
  private dimensionBatch?: DimensionBatchSummary;

  setFilter(shape: SafeFilterShape): void {
    if (this.filterAmbiguous) return;
    if (!this.filter) this.filter = shape;
    else if (JSON.stringify(this.filter) !== JSON.stringify(shape)) {
      this.filterAmbiguous = true;
      this.filter = undefined;
    }
  }

  record(sample: QueryObservation): void {
    const identity = verifiedQueryIdentity(sample.identity);
    // An identical ID/variant can execute very different Filter-SQL plans.
    // The signature contains only stable enums/coarse buckets from safeFilterShape.
    const shapeSignature = sample.filter
      ? JSON.stringify(sample.filter)
      : "no_shape";
    const key = JSON.stringify([identity.id, identity.variant, shapeSignature]);
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

  /** One decision per group or skipped item; independent of D1 SQL metrics. */
  recordDimensionBatch(outcome: DimensionBatchOutcome, items = 1): void {
    if (
      !DIMENSION_BATCH_OUTCOMES.includes(outcome) ||
      !Number.isInteger(items) ||
      items < 1 ||
      items > 4
    )
      return;
    const summary = (this.dimensionBatch ??= {});
    const counter = (summary[outcome] ??= { events: 0, items: 0 });
    counter.events++;
    counter.items += items;
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
      filterAmbiguous: this.filterAmbiguous,
      ...(this.dimensionBatch
        ? { dimensionBatch: structuredClone(this.dimensionBatch) }
        : {}),
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
