import {
  archiveGoalDefinition,
  createGoalDefinition,
  decodeGoalDefinitionCursor,
  queryGoalDefinition,
  queryGoalDefinitionsPage,
  updateGoalDefinition,
} from "@/lib/edge/analytics/composition/d1/goals";
import type { GoalDefinition } from "@/lib/edge/analytics/contract/goal";
import {
  type GoalConfigV1,
  GoalConfigValidationError,
} from "@/lib/edge/analytics/contract/goal-config";
import type { Env } from "@/lib/edge/types";
import {
  bad as badRequest,
  jsonResponseWith,
  na as notAllowed,
  nf as notFound,
  type ResponseContext,
} from "@/lib/response";
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
  return { name, config: { filterDslVersion, filterDsl: body.filterDsl } };
}
async function readWriteBody(
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
function validationResponse(error: unknown): Response | null {
  return error instanceof GoalConfigValidationError
    ? badRequest("Invalid goal configuration")
    : null;
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
async function handleGoalCreate(
  env: Env,
  siteId: string,
  request: Request,
  ctx?: ResponseContext,
): Promise<Response> {
  const body = await readWriteBody(request);
  if (body instanceof Response) return body;
  const input = readWriteConfig(body);
  if (!input) return badRequest("Invalid goal configuration");
  try {
    const goal = await createGoalDefinition(
      env,
      siteId,
      input.name,
      input.config,
    );
    return jsonResponseWith(ctx, { ok: true, data: { goal } }, 201);
  } catch (error) {
    const response = validationResponse(error);
    if (response) return response;
    throw error;
  }
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
  const body = await readWriteBody(request);
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
  try {
    const goal = await updateGoalDefinition(env, siteId, goalId, name, {
      filterDslVersion,
      filterDsl,
    });
    return jsonResponseWith(ctx, { ok: true, data: { goal } });
  } catch (error) {
    const response = validationResponse(error);
    if (response) return response;
    throw error;
  }
}
async function handleGoalDelete(
  env: Env,
  siteId: string,
  url: URL,
  ctx?: ResponseContext,
): Promise<Response> {
  const goalId = url.searchParams.get("id")?.trim();
  if (!goalId) return badRequest("Goal id is required");
  await archiveGoalDefinition(env, siteId, goalId);
  return jsonResponseWith(ctx, { ok: true });
}
/** Private Goal definition protocol adapter. */
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
/** Descriptive alias for callers that only need the private definition API. */
export const handleGoalDefinitionContract = handleGoal;
export type { GoalDefinition };
