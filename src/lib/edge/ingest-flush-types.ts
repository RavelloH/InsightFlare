import type { RealtimeSnapshotRecord } from "./ingest-normalize";
import type { BufferedVisitRow, SqlWriter } from "./ingest-types";
import type {
  InvocationLogger,
  InvocationPerformanceCounter,
} from "./observability-logger";
import type { Env } from "./types";

export interface IngestFlushContext extends SqlWriter {
  env: Pick<Env, "DB">;
  dictionaryIds: Map<string, number>;
  readPersistedVisitRow(
    siteId: string,
    visitId: string,
  ): Promise<BufferedVisitRow | null>;
  insertBufferedVisitRow(row: BufferedVisitRow): void;
  hasOpenVisitsForVisitor(siteId: string, visitorId: string): boolean;
  pushRealtimeRecord(record: RealtimeSnapshotRecord): Promise<void>;
  /**
   * Owned by the DO invocation boundary.  Flush helpers only report stable
   * aggregate counters and event codes; they never emit their own logs.
   */
  observability?: Pick<
    InvocationLogger,
    "increment" | "info" | "warn" | "error"
  >;
}

export function recordFlushCounter(
  context: IngestFlushContext,
  counter: InvocationPerformanceCounter,
  amount = 1,
): void {
  context.observability?.increment(counter, amount);
}
