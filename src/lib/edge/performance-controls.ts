import type { Env } from "./types";

export type PerformanceRolloutState = "disabled" | "shadow" | "enabled";

export interface PerformanceControl {
  name: string;
  routeScope: string;
  state: PerformanceRolloutState;
  generation: string;
  revision: number;
  updatedAt: number;
}

function validState(value: unknown): value is PerformanceRolloutState {
  return value === "disabled" || value === "shadow" || value === "enabled";
}

export async function readPerformanceControl(
  env: Env,
  name = "foundation",
): Promise<PerformanceControl | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT name, route_scope AS routeScope, state, generation, revision,
            updated_at AS updatedAt
     FROM performance_rollout_controls WHERE name=? LIMIT 1`,
    )
      .bind(name)
      .first<Record<string, unknown>>();
    if (!row || !validState(row.state)) return null;
    const revision = Number(row.revision);
    const updatedAt = Number(row.updatedAt);
    const routeScope = String(row.routeScope ?? "").trim();
    const generation = String(row.generation ?? "").trim();
    if (
      !routeScope ||
      !generation ||
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      !Number.isFinite(updatedAt)
    )
      return null;
    return {
      name: String(row.name),
      routeScope,
      state: row.state,
      generation,
      revision,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export async function compareAndSetPerformanceControl(
  env: Env,
  input: {
    name: string;
    revision: number;
    state: PerformanceRolloutState;
    generation: string;
    actorUserId: string;
    requestId: string;
  },
): Promise<PerformanceControl | null> {
  let updated: D1Result;
  try {
    updated = await env.DB.prepare(
      `UPDATE performance_rollout_controls
     SET state=?, generation=?, revision=revision+1, updated_at=unixepoch(),
         updated_by=?, current_request_id=?
     WHERE name=? AND revision=?`,
    )
      .bind(
        input.state,
        input.generation,
        input.actorUserId,
        input.requestId,
        input.name,
        input.revision,
      )
      .run();
  } catch {
    return null;
  }
  if (Number(updated.meta?.changes ?? 0) !== 1) return null;
  return readPerformanceControl(env, input.name);
}
