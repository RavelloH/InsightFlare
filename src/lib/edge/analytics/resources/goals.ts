import type { GoalDefinition } from "@/lib/edge/analytics/contract/goal";
import type { GoalConfigV1 } from "@/lib/edge/analytics/contract/goal-config";

export interface GoalDefinitionPage {
  readonly items: readonly GoalDefinition[];
  readonly pagination: {
    readonly limit: number;
    readonly returned: number;
    readonly hasMore: boolean;
    readonly nextCursor: string | null;
  };
}

/** Source-neutral application boundary for persisted Goal definitions. */
export interface GoalDefinitionResource {
  list(input: {
    readonly siteId: string;
    readonly limit: number;
    readonly cursor?: string | null;
  }): Promise<
    | { readonly ok: true; readonly page: GoalDefinitionPage }
    | { readonly ok: false; readonly error: "invalid-cursor" }
  >;
  get(siteId: string, goalId: string): Promise<GoalDefinition | null>;
  create(
    siteId: string,
    name: string,
    config: GoalConfigV1,
  ): Promise<GoalDefinition>;
  update(
    siteId: string,
    goalId: string,
    name: string,
    config: GoalConfigV1,
  ): Promise<GoalDefinition>;
  archive(siteId: string, goalId: string): Promise<void>;
}
