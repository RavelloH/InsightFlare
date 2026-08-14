import { heartbeatPerformanceDiagnostics } from "./performance-diagnostics-health";
import type { Env } from "./types";

const LEASE_MS = 90_000;

export interface PerformanceMaintenanceLease {
  jobKey: string;
  owner: string;
  token: string;
  revision: number;
}

export async function claimPerformanceMaintenanceJob(
  env: Env,
  jobKey: string,
  owner: string = crypto.randomUUID(),
  now = Date.now(),
): Promise<PerformanceMaintenanceLease | null> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO performance_maintenance_jobs
     (job_key, cursor_json, high_water_json, phase) VALUES (?, '{}', '{}', 'idle')`,
  )
    .bind(jobKey)
    .run();
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE performance_maintenance_jobs
     SET owner=?, lease_token=?, lease_until=?, revision=revision+1, updated_at=unixepoch()
     WHERE job_key=? AND (lease_until IS NULL OR lease_until < ?)`,
  )
    .bind(owner, token, now + LEASE_MS, jobKey, now)
    .run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) return null;
  const row = await env.DB.prepare(
    "SELECT revision FROM performance_maintenance_jobs WHERE job_key=? AND owner=? AND lease_token=? LIMIT 1",
  )
    .bind(jobKey, owner, token)
    .first<{ revision: number }>();
  if (!row) return null;
  return { jobKey, owner, token, revision: row.revision };
}

export async function releasePerformanceMaintenanceJob(
  env: Env,
  lease: PerformanceMaintenanceLease,
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE performance_maintenance_jobs
     SET owner=NULL, lease_token=NULL, lease_until=NULL, revision=revision+1, updated_at=unixepoch()
     WHERE job_key=? AND owner=? AND lease_token=? AND revision=?`,
  )
    .bind(lease.jobKey, lease.owner, lease.token, lease.revision)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/** Foundation-only scheduled hook. Future maintenance handlers must fence each
 * side-effect with the returned lease; this hook intentionally touches no
 * analytics or scheduled-task base table. */
export async function runPerformanceMaintenance(env: Env): Promise<void> {
  let lease: PerformanceMaintenanceLease | null = null;
  try {
    lease = await claimPerformanceMaintenanceJob(env, "foundation-health");
    if (!lease) return;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "performance_maintenance_claim_failed",
        jobKey: "foundation-health",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }

  try {
    await heartbeatPerformanceDiagnostics(env);
    // The Foundation release intentionally has no analytics-base side
    // effects. Any future batch must include the lease owner, token, and
    // revision in its conditional write before it mutates a projection/cursor.
  } finally {
    try {
      await releasePerformanceMaintenanceJob(env, lease);
    } catch (error) {
      // A stale lease is expected to fail its CAS. Keep the cron invocation
      // best-effort so existing scheduled tasks continue to run.
      console.warn(
        JSON.stringify({
          event: "performance_maintenance_release_failed",
          jobKey: lease.jobKey,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}
