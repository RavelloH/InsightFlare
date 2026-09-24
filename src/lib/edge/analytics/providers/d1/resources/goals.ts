import {
  archiveGoalDefinition,
  createGoalDefinition,
  decodeGoalDefinitionCursor,
  queryGoalDefinition,
  queryGoalDefinitionsPage,
  updateGoalDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/goals";
import type { GoalDefinitionResource } from "@/lib/edge/analytics/resources/goals";
import type { Env } from "@/lib/edge/types";

/** D1 adapter for the source-neutral Goal definition resource. */
export function createD1GoalDefinitionResource(
  env: Env,
): GoalDefinitionResource {
  return {
    async list({ siteId, limit, cursor }) {
      const decoded = await decodeGoalDefinitionCursor(env, siteId, cursor);
      if (cursor && !decoded) {
        return { ok: false, error: "invalid-cursor" };
      }
      return {
        ok: true,
        page: await queryGoalDefinitionsPage(env, siteId, limit, decoded),
      };
    },
    get: (siteId, goalId) => queryGoalDefinition(env, siteId, goalId),
    create: (siteId, name, config) =>
      createGoalDefinition(env, siteId, name, config),
    update: (siteId, goalId, name, config) =>
      updateGoalDefinition(env, siteId, goalId, name, config),
    archive: (siteId, goalId) => archiveGoalDefinition(env, siteId, goalId),
  };
}
