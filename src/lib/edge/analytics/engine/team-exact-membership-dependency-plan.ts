import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { crossBreakdownPageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  freezeMembershipRecipeValue,
  normalizeMembershipPreparations,
  validMembershipChildReferences,
} from "@/lib/edge/analytics/engine/membership-dependency-plan";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import {
  planTeamExactDimensionExecution,
  type TeamExactDimensionQuery,
} from "@/lib/edge/analytics/engine/team-exact-dimension-plan";
import { planWholeFilterMembershipJobs } from "@/lib/edge/analytics/engine/whole-filter-membership-jobs";

/** A value recipe only. Joint completion and per-site authority stay private to D1. */
export function planTeamExactMembershipDependencies(
  query: TeamExactDimensionQuery,
) {
  const decision = planTeamExactDimensionExecution(query);
  if (
    decision.kind !== "exact" ||
    decision.qualification !== "sql-membership" ||
    query.context.subject.kind !== "team"
  )
    return undefined;
  const metadata = scopedFilterMetadata(query.filters)!;
  const selection = crossBreakdownPageDimensionSelection(query.dimension)!;
  // Retain the existing whole-tree planner and its fixed fallback bounds. Never
  // infer authority from the number of report children or the listing subset.
  const execution = planAdvancedFilterExecution({
    subject: semanticSubjectFromQuerySubject(query.context.subject),
    filters: query.filters!,
    scope: metadata.plan.scope,
    time: metadata.time,
    reportFusionAvailable: false,
  });
  if (
    metadata.plan.mode !== "entity" ||
    metadata.plan.membership.kind !== "entity" ||
    execution.decision.membership.identity.grain === "activity"
  )
    return undefined;
  const siteIds = metadata.siteIds;
  // Keep the evaluator's original domain, including duplicate/empty IDs.
  // Coverage and lowering retain their existing validation/error checkpoints.
  if (siteIds.some((siteId) => typeof siteId !== "string")) return undefined;
  const countPreparations = normalizeMembershipPreparations([
    {
      key: "joint",
      execution,
      filters: query.filters!,
      queryTime: metadata.time,
    },
  ]);
  // Keep the shared normalizer Count-only. This Team residual must have the
  // independently supported Seq job and the original bounded-Core successor.
  const sequenceJobs = countPreparations
    ? undefined
    : planWholeFilterMembershipJobs({
        subject: semanticSubjectFromQuerySubject(query.context.subject),
        filters: query.filters!,
        scope: metadata.plan.scope,
        time: metadata.time,
        reportFusionAvailable: false,
      });
  const preparations =
    countPreparations ??
    (execution.support.kind === "unsupported" &&
    sequenceJobs?.jobs.length === 2 &&
    sequenceJobs.jobs[0]?.kind === "sequence-membership" &&
    sequenceJobs.jobs[1]?.kind === "bounded-original-core"
      ? [
          {
            kind: "prepare-membership" as const,
            key: "joint",
            strategy: "sql-membership" as const,
            executionKind: "sequence-membership" as const,
            filterSemantics: "whole-original-tree" as const,
            fallback: "bounded-core" as const,
            dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
            membership: sequenceJobs.execution.decision.membership,
            filters: query.filters!,
            queryTime: metadata.time,
            bounds: sequenceJobs.jobs[1].bounds,
          },
        ]
      : undefined);
  if (!preparations || preparations.length !== 1) return undefined;
  const children = [...new Set(siteIds)].map((siteId) => ({
    key: `site:${siteId}`,
    preparationKey: "joint" as const,
    siteId,
    readerProfile: "team-exact-dimension-page-v1" as const,
    dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
    sourceRole: "page" as const,
    maxPlans: 1 as const,
    maxSources: 1 as const,
    localOutputId: "dimension-top" as const,
    queryTime: metadata.time,
  }));
  if (!validMembershipChildReferences(preparations, children)) return undefined;
  const value = {
    kind: "team-exact-page-membership-dependencies" as const,
    admission: { ...preparations[0]!, siteIds },
    children,
    consumer: {
      operation: "dimension" as const,
      mode: "breakdown" as const,
      audience: "private-dashboard" as const,
      dimension: query.dimension,
      selection,
      teamId: query.context.subject.teamId,
      scope: {
        ...metadata.plan,
        requiredSources: [...metadata.plan.requiredSources],
      },
      // Per-site reads are complete; only the existing merge applies user limit.
      perSiteLimit: 0 as const,
      excludeEmpty: true as const,
    },
  };
  return freezeMembershipRecipeValue(
    JSON.parse(JSON.stringify(value)) as typeof value,
  );
}
export type TeamExactMembershipDependencyPlan = NonNullable<
  ReturnType<typeof planTeamExactMembershipDependencies>
>;
