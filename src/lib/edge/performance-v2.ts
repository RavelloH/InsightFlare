import { jsonResponseFor } from "@/lib/response";

import { readPerformanceControl } from "./performance-controls";
import type { Env } from "./types";

export type PerformanceV2Scope = "journey-v2" | "scheduled-tasks-v2";

/**
 * Foundation routes deliberately expose no business result. A missing,
 * malformed, disabled, or shadow control stays unavailable until its later
 * P0 implementation and rollout gates are complete.
 */
export async function performanceV2StubResponse(
  request: Request,
  env: Env,
  scope: PerformanceV2Scope,
): Promise<Response> {
  const control = await readPerformanceControl(env, "foundation");
  const state = control?.state ?? "disabled";
  const code =
    state === "enabled"
      ? "performance_v2_not_implemented"
      : "performance_v2_disabled";
  const message =
    state === "enabled"
      ? "The requested performance v2 route is not implemented"
      : "Performance v2 is not enabled";
  return jsonResponseFor(
    request,
    {
      ok: false,
      error: { code, message },
      scope,
      state,
    },
    503,
    { "cache-control": "no-store" },
  );
}
