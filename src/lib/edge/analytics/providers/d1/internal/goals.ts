import {
  compileD1Mutation,
  compileD1Query,
  createD1DatabaseClient,
} from "@/lib/db";
import type { GoalDefinition } from "@/lib/edge/analytics/contract/goal";
import {
  decodeGoalConfig,
  encodeGoalConfig,
  type GoalConfigV1,
  goalSemanticFingerprint,
  validateGoalConfigForWrite,
} from "@/lib/edge/analytics/contract/goal-config";
import type { Env } from "@/lib/edge/types";

import {
  analysisDefinitionByIdQuery,
  analysisDefinitionsPageQuery,
  archiveAnalysisDefinition,
  insertAnalysisDefinition,
  updateAnalysisDefinition,
} from "./analysis-definition-queries";
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
  const result = await createD1DatabaseClient(env.DB).all(
    compileD1Query(
      analysisDefinitionsPageQuery({
        kind: GOAL_ANALYSIS_KIND,
        siteId,
        limit: limit + 1,
        cursor,
      }),
      { tag: "analytics.goals.page" },
    ),
  );
  const mapped = await Promise.all(result.results.map(mapGoalDefinition));
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
  const result = await createD1DatabaseClient(env.DB).all(
    compileD1Query(
      analysisDefinitionByIdQuery({
        kind: GOAL_ANALYSIS_KIND,
        siteId,
        id: goalId,
      }),
      { tag: "analytics.goals.detail" },
    ),
  );
  const row = result.results[0];
  return row ? mapGoalDefinition(row) : null;
}
export async function createGoalDefinition(
  env: Env,
  siteId: string,
  name: string,
  config: GoalConfigV1,
): Promise<GoalDefinition> {
  validateGoalConfigForWrite(config);
  const encoded = encodeGoalConfig(config);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      insertAnalysisDefinition({
        id,
        siteId,
        kind: GOAL_ANALYSIS_KIND,
        name,
        configJson: encoded.configJson,
        configVersion: encoded.configVersion,
        timestamp: now,
      }),
      { tag: "analytics.goals.insert" },
    ),
  );
  const goal = await queryGoalDefinition(env, siteId, id);
  if (!goal) throw new Error("goal_create_readback_failed");
  return goal;
}
export async function updateGoalDefinition(
  env: Env,
  siteId: string,
  goalId: string,
  name: string,
  config: GoalConfigV1,
): Promise<GoalDefinition> {
  validateGoalConfigForWrite(config);
  const encoded = encodeGoalConfig(config);
  const now = Math.floor(Date.now() / 1_000);
  await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      updateAnalysisDefinition({
        kind: GOAL_ANALYSIS_KIND,
        siteId,
        id: goalId,
        name,
        configJson: encoded.configJson,
        configVersion: encoded.configVersion,
        timestamp: now,
      }),
      { tag: "analytics.goals.update" },
    ),
  );
  const goal = await queryGoalDefinition(env, siteId, goalId);
  if (!goal) throw new Error("goal_update_readback_failed");
  return goal;
}
export async function archiveGoalDefinition(
  env: Env,
  siteId: string,
  goalId: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1_000);
  await createD1DatabaseClient(env.DB).run(
    compileD1Mutation(
      archiveAnalysisDefinition({
        kind: GOAL_ANALYSIS_KIND,
        siteId,
        id: goalId,
        timestamp: now,
      }),
      { tag: "analytics.goals.archive" },
    ),
  );
}
