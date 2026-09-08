import { handleGoal } from "@/lib/edge/analytics/providers/d1/internal/goals";

/**
 * Private Goal definition protocol adapter.
 *
 * GET intentionally returns only the persisted definition. Goal analysis is
 * exposed by the separate analytics operation and must not be coupled to
 * this CRUD endpoint.
 */
export { handleGoal };

/** Descriptive alias for callers that only need the private definition API. */
export const handleGoalDefinitionContract = handleGoal;
