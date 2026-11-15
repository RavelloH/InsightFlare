import type { AdvancedCountFilterSupport } from "@/lib/edge/analytics/engine/advanced-filter-count-support";
import {
  type AdvancedFilterExecutionPlan,
  planAdvancedFilterExecution,
} from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import type { SupportedSequence } from "@/lib/edge/analytics/engine/advanced-filter-sequence-support";

export type WholeFilterMembershipJob =
  | {
      readonly kind: "sequence-membership";
      readonly support: SupportedSequence;
    }
  | {
      readonly kind: "count-membership";
      readonly support: Extract<
        AdvancedCountFilterSupport,
        { kind: "supported" }
      >;
    }
  | {
      readonly kind: "bounded-original-core";
      readonly bounds: AdvancedFilterExecutionPlan["decision"]["coreBounds"];
    };

/** Value planning only. This is not a capability, read port or budget override.
 * Keep both independent SQL proofs and their historical sequence→Count order;
 * refusal always continues the same original request, finally through Core. */
export function planWholeFilterMembershipJobs(
  input: Parameters<typeof planAdvancedFilterExecution>[0],
): {
  readonly execution: AdvancedFilterExecutionPlan;
  readonly jobs: readonly WholeFilterMembershipJob[];
} {
  const execution = planAdvancedFilterExecution(input);
  const jobs: WholeFilterMembershipJob[] = [];
  if (execution.decision.strategy === "sql-membership") {
    if (execution.sequenceSupport?.kind === "supported")
      jobs.push({
        kind: "sequence-membership",
        support: execution.sequenceSupport,
      });
    if (execution.support.kind === "supported")
      jobs.push({ kind: "count-membership", support: execution.support });
  }
  jobs.push({
    kind: "bounded-original-core",
    bounds: execution.decision.coreBounds,
  });
  return { execution, jobs };
}
