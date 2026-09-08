import type { GoalDefinition } from "@/lib/edge/analytics/contract/goal";
import {
  decodeGoalConfig,
  encodeGoalConfig,
  type GoalConfigV1,
  GoalConfigValidationError,
  goalSemanticFingerprint,
  validateGoalConfigForWrite,
} from "@/lib/edge/analytics/contract/goal-config";
import type { Env } from "@/lib/edge/types";

import {
  badRequest,
  jsonResponseWith,
  notAllowed,
  notFound,
  queryD1All,
  type ResponseContext,
} from "./core";
import {
  decodePageCursor,
  encodePageCursor,
  hasExactKeys,
  pageResult,
  paginationBinding,
} from "./pagination";

const GOAL_ANALYSIS_KIND = "goal";

export type {
  GoalConfigV1,
  GoalDefinition,
} from "@/lib/edge/analytics/contract";

function rowConfig(row: Record<string, unknown>): GoalConfigV1 {
  return decodeGoalConfig(
    Number(row.config_version ?? 0),
    String(row.config_json ?? ""),
  );
}

async function mapGoalDefinition(
  row: Record<string, unknown>,
): Promise<GoalDefinition> {
  const config = rowConfig(row);
  return {
    id: String(row.id ?? ""),
    siteId: String(row.site_id ?? ""),
    name: String(row.name ?? ""),
    filterDslVersion: config.filterDslVersion,
    filterDsl: config.filterDsl,
    semanticFingerprint: await goalSemanticFingerprint(config),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

interface GoalDefinitionCursor {
  readonly createdAt: number;
  readonly id: string;
}

function goalDefinitionCursor(value: unknown): GoalDefinitionCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  return hasExactKeys(candidate, ["createdAt", "id"]) &&
    typeof candidate.id === "string" &&
    Number.isSafeInteger(candidate.createdAt)
    ? { id: candidate.id, createdAt: candidate.createdAt as number }
    : null;
}

async function goalCursorBinding(siteId: string): Promise<string> {
  return paginationBinding(["goals-v1", siteId, "createdAt:desc,id:desc"]);
}

export async function queryGoalDefinitionsPage(
  env: Env,
  siteId: string,
  limit: number,
  cursor?: GoalDefinitionCursor | null,
) {
  const cursorClause = cursor
    ? "AND (created_at < ? OR (created_at = ? AND id < ?))"
    : "";
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    `SELECT id, site_id, name, config_json, config_version, created_at, updated_at
     FROM analysis_definitions
     WHERE site_id = ? AND kind = ? AND archived_at IS NULL
     ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT ?`,
    [
      siteId,
      GOAL_ANALYSIS_KIND,
      ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []),
      limit + 1,
    ],
  );
  const mapped = await Promise.all(rows.map(mapGoalDefinition));
  const page = pageResult(mapped, limit);
  const nextCursor =
    page.hasMore && page.last
      ? await encodePageCursor(env, await goalCursorBinding(siteId), {
          createdAt: page.last.createdAt,
          id: page.last.id,
        })
      : null;
  return {
    items: page.rows,
    pagination: {
      limit,
      returned: page.rows.length,
      hasMore: page.hasMore,
      nextCursor,
    },
  };
}

export async function decodeGoalDefinitionCursor(
  env: Env,
  siteId: string,
  cursor?: string | null,
): Promise<GoalDefinitionCursor | null> {
  return decodePageCursor<GoalDefinitionCursor>(
    env,
    await goalCursorBinding(siteId),
    cursor,
    "goals",
    goalDefinitionCursor,
  );
}

export async function queryGoalDefinition(
  env: Env,
  siteId: string,
  goalId: string,
): Promise<GoalDefinition | null> {
  const rows = await queryD1All<Record<string, unknown>>(
    env,
    "SELECT id, site_id, name, config_json, config_version, created_at, updated_at FROM analysis_definitions WHERE id = ? AND site_id = ? AND kind = ? AND archived_at IS NULL LIMIT 1",
    [goalId, siteId, GOAL_ANALYSIS_KIND],
  );
  return rows[0] ? mapGoalDefinition(rows[0]) : null;
}

async function handleGoalList(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(200, Math.max(1, limitParam))
    : 50;
  const cursorText = url.searchParams.get("cursor");
  const cursor = await decodeGoalDefinitionCursor(env, siteId, cursorText);
  if (cursorText && !cursor) return badRequest("Invalid cursor");
  const page = await queryGoalDefinitionsPage(env, siteId, limit, cursor);
  return jsonResponseWith(ctx, { ok: true, data: page });
}

async function handleGoalDetail(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const goalId = url.searchParams.get("id")?.trim();
  if (!goalId) return handleGoalList(env, siteId, url, ctx);
  const goal = await queryGoalDefinition(env, siteId, goalId);
  if (!goal) return notFound();
  return jsonResponseWith(ctx, { ok: true, data: { goal } });
}

interface GoalWriteBody {
  readonly name?: unknown;
  readonly filterDslVersion?: unknown;
  readonly filterDsl?: unknown;
}

function readWriteConfig(
  body: GoalWriteBody,
): { name: string; config: GoalConfigV1 } | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const filterDslVersion = body.filterDslVersion ?? 1;
  if (!name || filterDslVersion !== 1 || typeof body.filterDsl !== "string") {
    return null;
  }
  return {
    name,
    config: {
      filterDslVersion,
      filterDsl: body.filterDsl,
    },
  };
}

async function decodeWriteBody(
  request: Request,
): Promise<GoalWriteBody | Response> {
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return badRequest("Invalid JSON body");
    }
    return parsed as GoalWriteBody;
  } catch {
    return badRequest("Invalid JSON body");
  }
}

function encodeWriteConfig(config: GoalConfigV1) {
  try {
    validateGoalConfigForWrite(config);
    return encodeGoalConfig(config);
  } catch (error) {
    if (error instanceof GoalConfigValidationError) {
      return null;
    }
    throw error;
  }
}

async function handleGoalCreate(
  env: Env,
  siteId: string,
  request: Request,
  ctx?: ResponseContext,
): Promise<Response> {
  const body = await decodeWriteBody(request);
  if (body instanceof Response) return body;
  const input = readWriteConfig(body);
  if (!input) return badRequest("Invalid goal configuration");
  const encoded = encodeWriteConfig(input.config);
  if (!encoded) return badRequest("Invalid goal configuration");

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    "INSERT INTO analysis_definitions (id, site_id, kind, name, config_json, config_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      siteId,
      GOAL_ANALYSIS_KIND,
      input.name,
      encoded.configJson,
      encoded.configVersion,
      now,
      now,
    )
    .run();
  const goal = await queryGoalDefinition(env, siteId, id);
  if (!goal) throw new Error("goal_create_readback_failed");
  return jsonResponseWith(ctx, { ok: true, data: { goal } }, 201);
}

async function handleGoalUpdate(
  env: Env,
  siteId: string,
  url: URL,
  request: Request,
  ctx?: ResponseContext,
): Promise<Response> {
  const goalId = url.searchParams.get("id")?.trim();
  if (!goalId) return badRequest("Goal id is required");
  const current = await queryGoalDefinition(env, siteId, goalId);
  if (!current) return notFound();

  const body = await decodeWriteBody(request);
  if (body instanceof Response) return body;
  if (body.name !== undefined && typeof body.name !== "string") {
    return badRequest("Name is required");
  }
  const name = body.name === undefined ? current.name : body.name.trim();
  if (!name) return badRequest("Name is required");
  const filterDslVersion =
    body.filterDslVersion === undefined
      ? current.filterDslVersion
      : body.filterDslVersion;
  const filterDsl =
    body.filterDsl === undefined ? current.filterDsl : body.filterDsl;
  if (filterDslVersion !== 1 || typeof filterDsl !== "string") {
    return badRequest("Invalid goal configuration");
  }

  const encoded = encodeWriteConfig({ filterDslVersion, filterDsl });
  if (!encoded) return badRequest("Invalid goal configuration");
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    "UPDATE analysis_definitions SET name=?, config_json=?, config_version=?, updated_at=? WHERE id=? AND site_id=? AND kind=? AND archived_at IS NULL",
  )
    .bind(
      name,
      encoded.configJson,
      encoded.configVersion,
      now,
      goalId,
      siteId,
      GOAL_ANALYSIS_KIND,
    )
    .run();
  const goal = await queryGoalDefinition(env, siteId, goalId);
  if (!goal) throw new Error("goal_update_readback_failed");
  return jsonResponseWith(ctx, { ok: true, data: { goal } });
}

async function handleGoalDelete(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const goalId = url.searchParams.get("id")?.trim();
  if (!goalId) return badRequest("Goal id is required");
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    "UPDATE analysis_definitions SET archived_at = ?, updated_at = ? WHERE id = ? AND site_id = ? AND kind = ? AND archived_at IS NULL",
  )
    .bind(now, now, goalId, siteId, GOAL_ANALYSIS_KIND)
    .run();
  return jsonResponseWith(ctx, { ok: true });
}

export async function handleGoal(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
  request?: Request,
): Promise<Response> {
  const method = request?.method ?? "GET";
  if (method === "GET") return handleGoalDetail(env, siteId, url, ctx);
  if (method === "POST" && request)
    return handleGoalCreate(env, siteId, request, ctx);
  if (method === "PATCH" && request)
    return handleGoalUpdate(env, siteId, url, request, ctx);
  if (method === "DELETE") return handleGoalDelete(env, siteId, url, ctx);
  return notAllowed();
}
