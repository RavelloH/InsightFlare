import type {
  TrafficSessionEndedInput,
  TrafficVisitFinalizedInput,
} from "./analytics-engine/traffic-writer";
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
  sitePks: Map<string, number>;
  readPersistedVisitRow(
    siteId: string,
    visitId: string,
  ): Promise<BufferedVisitRow | null>;
  insertBufferedVisitRow(row: BufferedVisitRow): void;
  hasOpenVisitsForVisitor(siteId: string, visitorId: string): boolean;
  pushRealtimeRecord(record: RealtimeSnapshotRecord): Promise<void>;
  writeTrafficVisitFinalizedFact?: (input: TrafficVisitFinalizedInput) => void;
  writeTrafficSessionEndedFact?: (input: TrafficSessionEndedInput) => void;
  /**
   * Owned by the DO invocation boundary.  Flush helpers only report stable
   * aggregate counters and event codes; they never emit their own logs.
   */
  observability?: Pick<
    InvocationLogger,
    "increment" | "info" | "warn" | "error"
  >;
}

/**
 * Resolve the durable internal site key once per DO lifetime.  The first
 * lookup keeps the common path read-only; INSERT OR IGNORE handles a site
 * whose identity was not present when migration 0039 ran, and the final
 * lookup obtains the winner if concurrent writers raced to create it.
 */
export async function resolveSitePk(
  context: IngestFlushContext,
  siteId: string,
): Promise<number> {
  const cached = context.sitePks.get(siteId);
  if (cached !== undefined) return cached;

  recordFlushCounter(context, "d1Statements");
  const existing = await context.env.DB.prepare(
    `SELECT site_pk AS sitePk FROM site_identities WHERE site_id = ? LIMIT 1`,
  )
    .bind(siteId)
    .first<{ sitePk: number }>();
  const existingPk = Number(existing?.sitePk ?? 0);
  if (Number.isSafeInteger(existingPk) && existingPk > 0) {
    context.sitePks.set(siteId, existingPk);
    return existingPk;
  }

  recordFlushCounter(context, "d1Statements");
  await context.env.DB.prepare(
    `INSERT OR IGNORE INTO site_identities (site_id) VALUES (?)`,
  )
    .bind(siteId)
    .run();

  recordFlushCounter(context, "d1Statements");
  const created = await context.env.DB.prepare(
    `SELECT site_pk AS sitePk FROM site_identities WHERE site_id = ? LIMIT 1`,
  )
    .bind(siteId)
    .first<{ sitePk: number }>();
  const sitePk = Number(created?.sitePk ?? 0);
  if (!Number.isSafeInteger(sitePk) || sitePk <= 0) {
    throw new Error(`Failed to resolve site identity for ${siteId}`);
  }
  context.sitePks.set(siteId, sitePk);
  return sitePk;
}

export function recordFlushCounter(
  context: IngestFlushContext,
  counter: InvocationPerformanceCounter,
  amount = 1,
): void {
  context.observability?.increment(counter, amount);
}
