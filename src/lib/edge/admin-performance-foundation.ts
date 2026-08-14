import { errorResponse } from "@/lib/response";

import { requireActor } from "./admin-auth";
import { bad, forb, j, na } from "./admin-response";
import {
  compareAndSetPerformanceControl,
  type PerformanceRolloutState,
  readPerformanceControl,
} from "./performance-controls";
import type { Env } from "./types";

const STATES = new Set<PerformanceRolloutState>([
  "disabled",
  "shadow",
  "enabled",
]);

export async function handlePerformanceFoundationAdmin(
  request: Request,
  env: Env,
): Promise<Response> {
  const actor = await requireActor(env, request);
  if (actor instanceof Response) return actor;
  if (!actor.isAdmin)
    return forb(
      "Only system admin can manage performance rollout",
      undefined,
      request,
    );
  if (request.method === "GET")
    return j(
      (await readPerformanceControl(env)) ?? {
        state: "disabled",
        unavailable: true,
      },
    );
  if (request.method !== "PUT") return na(request);
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const state = body?.state;
  const generation = String(body?.generation ?? "").trim();
  const revision = Number(body?.revision);
  if (
    !STATES.has(state as PerformanceRolloutState) ||
    !generation ||
    !Number.isInteger(revision)
  )
    return bad(
      "state, generation, and integer revision are required",
      undefined,
      request,
    );
  if (state === "enabled") {
    return errorResponse(
      request,
      409,
      "performance_v2_not_ready",
      "Foundation routes have no P0 implementation; keep the rollout disabled or shadowed",
    );
  }
  const next = await compareAndSetPerformanceControl(env, {
    name: "foundation",
    revision,
    state: state as PerformanceRolloutState,
    generation,
    actorUserId: actor.user.id,
    requestId: request.headers.get("x-request-id") || crypto.randomUUID(),
  });
  return next
    ? j(next)
    : errorResponse(
        request,
        409,
        "rollout_control_conflict",
        "Performance rollout control changed; refresh and retry",
      );
}
