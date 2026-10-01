import {
  compileD1Mutation,
  compileD1Query,
  createD1DatabaseClient,
  insertOrIgnore,
  project,
  schema,
} from "@/lib/db";
import type {
  TrafficSessionEndedInput,
  TrafficVisitFinalizedInput,
} from "@/lib/edge/analytics-engine/traffic-writer";
import type {
  InvocationLogger,
  InvocationPerformanceCounter,
} from "@/lib/edge/observability/logger";
import { sitePkRelationForSiteId } from "@/lib/edge/sites/identity-query";
import type { Env } from "@/lib/edge/types";

import type { RealtimeSnapshotRecord } from "./normalize";
import type { BufferedVisitRow, SqlWriter } from "./types";
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
  getVisitCleanupDueAt?: () => number | null | undefined;
  setVisitCleanupDueAt?: (dueAt: number | null) => void;
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

  const client = createD1DatabaseClient(context.env.DB);
  const identity = sitePkRelationForSiteId(siteId);
  const identityQuery = () =>
    compileD1Query(project(identity, { sitePk: identity.columns.site_pk }), {
      tag: "ingest.site_identities.first",
    });
  const existing = await client.first(identityQuery());
  const existingPk = Number(existing?.sitePk ?? 0);
  if (Number.isSafeInteger(existingPk) && existingPk > 0) {
    context.sitePks.set(siteId, existingPk);
    return existingPk;
  }

  await client.run(
    compileD1Mutation(
      insertOrIgnore(schema.site_identities, { site_id: siteId }),
      { tag: "ingest.site_identities.insert" },
    ),
  );

  const created = await client.first(identityQuery());
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
