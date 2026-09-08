import type { GoalConfigV1 } from "./goal-config";

/** Persisted Goal definition with display and lifecycle metadata. */
export interface GoalDefinition extends GoalConfigV1 {
  readonly id: string;
  readonly siteId: string;
  readonly name: string;
  readonly semanticFingerprint: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
