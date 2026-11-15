import type { QueryTime } from "@/lib/edge/analytics/contract";
import type { AdvancedFilterExecutionPlan } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import {
  freezeMembershipRecipeValue,
  planMembershipDependencies,
} from "@/lib/edge/analytics/engine/membership-dependency-plan";
import type { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { FilterDocument } from "@/lib/filter-contract/filters";

/**
 * Value execution recipe; this object grants no execution authority.
 * The provider establishes audience/request eligibility and binds the produced
 * relation through the existing request-owned qualification capability.
 */
export interface ReferrersTimeMembershipDependencyPlan {
  readonly kind: "referrers-time-membership-dependency";
  readonly dependencyRef: typeof EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY;
  readonly membership: AdvancedFilterExecutionPlan["decision"]["membership"];
  readonly steps: readonly [
    {
      readonly kind: "prepare-membership";
      readonly strategy: "sql-membership";
      readonly filterSemantics: "whole-original-tree";
      readonly fallback: "bounded-core";
      readonly filters: FilterDocument;
      readonly queryTime: QueryTime;
      /**
       * The evaluator freshly derives and enforces these fixed bounds
       * from the same frozen inputs.
       */
      readonly bounds: AdvancedFilterExecutionPlan["decision"]["coreBounds"];
    },
    {
      readonly kind: "read-report";
      readonly strategy: "consume-dependency";
      readonly sourceRole: "page";
      readonly queryTime: QueryTime;
      readonly maxPlans: 1;
      readonly maxSources: 1;
    },
  ];
  readonly consumer: {
    readonly operation: "referrers";
    readonly variant: "summary";
    readonly topN: number;
    readonly audience: "private-dashboard";
  };
}
export function planReferrersTimeMembershipDependency(input: {
  execution: AdvancedFilterExecutionPlan;
  topN: number;
  filters: FilterDocument;
  queryTime: QueryTime;
}): ReferrersTimeMembershipDependencyPlan | undefined {
  const recipe = planMembershipDependencies({
    preparations: [
      {
        key: "membership",
        execution: input.execution,
        filters: input.filters,
        queryTime: input.queryTime,
      },
    ],
    children: [
      {
        key: "report",
        preparationKey: "membership",
        readerProfile: "referrers-summary-page-v1",
        queryTime: input.queryTime,
        sourceRole: "page",
        maxPlans: 1,
        maxSources: 1,
      },
    ],
    consumer: {
      operation: "referrers" as const,
      variant: "summary" as const,
      topN: input.topN,
      audience: "private-dashboard" as const,
    },
  });
  if (!recipe) return undefined;
  const preparation = recipe.preparations[0]!;
  const child = recipe.children[0]!;
  return freezeMembershipRecipeValue({
    kind: "referrers-time-membership-dependency",
    dependencyRef: preparation.dependencyRef,
    membership: preparation.membership,
    steps: [
      {
        kind: preparation.kind,
        strategy: preparation.strategy,
        filterSemantics: preparation.filterSemantics,
        fallback: preparation.fallback,
        filters: preparation.filters,
        queryTime: preparation.queryTime,
        bounds: preparation.bounds,
      },
      {
        kind: "read-report",
        strategy: "consume-dependency",
        sourceRole: child.sourceRole,
        queryTime: child.queryTime,
        maxPlans: child.maxPlans,
        maxSources: child.maxSources,
      },
    ],
    consumer: recipe.consumer,
  });
}
