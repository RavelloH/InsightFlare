import { errorLogData, type InvocationLogger } from "./observability-logger";
import type { Env } from "./types";

const SWEEP_PARALLELISM = 8;

interface SiteRow {
  id: string;
}

/**
 * Wake every site DO so previously stranded due work can re-enter the normal
 * per-DO Alarm pipeline. This only reconciles the Alarm; it does not force a
 * flush or delete any buffered rows.
 */
export async function sweepIngestAlarms(
  env: Env,
  logger: InvocationLogger,
): Promise<void> {
  let sites: SiteRow[];
  try {
    const result = await env.DB.prepare(
      "SELECT id FROM sites ORDER BY created_at ASC",
    ).all<SiteRow>();
    sites = result.results;
  } catch (error) {
    logger.error("scheduled.ingest_alarm_sweep_failed", errorLogData(error));
    return;
  }

  let cursor = 0;
  let reconciled = 0;
  let failed = 0;
  const workers = Array.from(
    { length: Math.min(SWEEP_PARALLELISM, sites.length) },
    async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= sites.length) return;

        const siteId = String(sites[index]?.id ?? "");
        if (!siteId) continue;
        try {
          const stub = env.INGEST_DO.get(env.INGEST_DO.idFromName(siteId));
          const response = await stub.fetch(
            "https://ingest.internal/reconcile",
            { method: "POST" },
          );
          if (!response.ok) {
            throw new Error(`reconcile_status_${response.status}`);
          }
          reconciled += 1;
        } catch (error) {
          failed += 1;
          logger.warn("scheduled.ingest_alarm_sweep_site_failed", {
            siteId,
            ...errorLogData(error),
          });
        }
      }
    },
  );

  await Promise.all(workers);
  logger.info("scheduled.ingest_alarm_sweep_completed", {
    siteCount: sites.length,
    reconciled,
    failed,
  });
}
