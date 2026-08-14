import { requireActor } from "./admin-auth";
import { forb, j, na } from "./admin-response";
import { runPerformanceMaintenance } from "./performance-maintenance";
import type { Env } from "./types";

/**
 * System-admin-only exercise point for the Foundation maintenance lease. It
 * intentionally invokes no scheduled-task or analytics-base operation.
 */
export async function handlePerformanceMaintenanceAdmin(
  request: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, request);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin) {
    return forb(
      "Only system admin can run performance maintenance",
      undefined,
      request,
    );
  }
  if (request.method !== "POST") return na(request);

  await runPerformanceMaintenance(env);
  return j({ accepted: true });
}
