import type { QueryTime } from "@/lib/edge/analytics/contract";
import type { AdvancedFilterExecutionPlan } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import {
  freezeMembershipRecipeValue,
  planMembershipDependencies,
} from "@/lib/edge/analytics/engine/membership-dependency-plan";
import type { FilterDocument } from "@/lib/filter-contract/filters";

export const COMPARISON_MEMBERSHIP_CHILD_OUTPUTS = {
  current: "comparison-current-membership-rollup",
  reference: "comparison-reference-membership-rollup",
} as const;
export interface ComparisonMembershipSideInput {
  readonly execution: AdvancedFilterExecutionPlan;
  readonly filters: FilterDocument;
  readonly queryTime: QueryTime;
  readonly readerQueryTime: QueryTime;
}
/** Value recipe only. The existing evaluator re-proves strategy/bounds, and
 * request-owned preparations authorize exact imported child-plan binding. */
export function planComparisonMembershipDependencies(input: {
  readonly current: ComparisonMembershipSideInput;
  readonly reference: ComparisonMembershipSideInput;
  readonly consumer: unknown;
}) {
  const recipe = planMembershipDependencies({
    preparations: (["current", "reference"] as const).map((side) => ({
      key: side,
      execution: input[side].execution,
      filters: input[side].filters,
      queryTime: input[side].queryTime,
    })),
    children: (["current", "reference"] as const).map((side) => ({
      key: side,
      preparationKey: side,
      outputId: COMPARISON_MEMBERSHIP_CHILD_OUTPUTS[side],
      readerProfile: "comparison-page-dimension-v1" as const,
      queryTime: input[side].readerQueryTime,
      sourceRole: "page" as const,
      maxPlans: 1 as const,
      maxSources: 1 as const,
    })),
    consumer: input.consumer,
  });
  if (!recipe) return undefined;
  const sides = (["current", "reference"] as const).map((side, index) => {
    const preparation = recipe.preparations[index]!;
    const child = recipe.children[index]!;
    return {
      kind: "prepare-membership" as const,
      side,
      childOutputId: COMPARISON_MEMBERSHIP_CHILD_OUTPUTS[side],
      strategy: "sql-membership" as const,
      filterSemantics: "whole-original-tree" as const,
      fallback: "bounded-core" as const,
      dependencyRef: preparation.dependencyRef,
      membership: preparation.membership,
      filters: preparation.filters,
      queryTime: preparation.queryTime,
      readerQueryTime: child.queryTime,
      bounds: preparation.bounds,
    };
  });
  return freezeMembershipRecipeValue({
    kind: "comparison-membership-dependencies",
    steps: [
      sides[0]!,
      sides[1]!,
      {
        kind: "read-report",
        strategy: "consume-independent-analysis-dependencies",
        sourceRole: "page",
        maxPlansPerSide: 1,
        maxSourcesPerSide: 1,
      },
    ],
    ...(Object.hasOwn(recipe, "consumer") ? { consumer: recipe.consumer } : {}),
  } as {
    readonly kind: "comparison-membership-dependencies";
    readonly steps: readonly [
      (typeof sides)[number],
      (typeof sides)[number],
      {
        readonly kind: "read-report";
        readonly strategy: "consume-independent-analysis-dependencies";
        readonly sourceRole: "page";
        readonly maxPlansPerSide: 1;
        readonly maxSourcesPerSide: 1;
      },
    ];
    readonly consumer: unknown;
  });
}
export type ComparisonMembershipDependencyPlan = NonNullable<
  ReturnType<typeof planComparisonMembershipDependencies>
>;
