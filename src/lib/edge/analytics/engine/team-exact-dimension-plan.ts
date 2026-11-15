import type { QueryInput, QueryTime } from "@/lib/edge/analytics/contract";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import { advancedCountPayloadPaths } from "@/lib/edge/analytics/engine/advanced-count-payload-selector";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import { crossBreakdownPageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";

export interface TeamExactDimensionQuery extends QueryInput {
  readonly time: QueryTime;
  readonly mode?: unknown;
  readonly dimension: string;
}

export type TeamExactDimensionDecision =
  | {
      readonly kind: "exact";
      readonly qualification: "native" | "sql-membership";
    }
  | {
      readonly kind: "legacy";
      readonly reason:
        | "unsupported-report"
        | "audience"
        | "request-context-mismatch"
        | "independent-time-domains"
        | "payload"
        | "unsupported-membership";
    };

/** The first exact port preserves the existing request-wide Count controls. */
export function planTeamExactDimensionExecution(
  query: TeamExactDimensionQuery,
): TeamExactDimensionDecision {
  if (
    query.context.subject.kind !== "team" ||
    query.mode !== "breakdown" ||
    !crossBreakdownPageDimensionSelection(query.dimension)
  )
    return { kind: "legacy", reason: "unsupported-report" };
  if (query.context.policy.audience !== "private-dashboard")
    return { kind: "legacy", reason: "audience" };
  if (!query.filters || !filterDocumentUsesAdvancedExpressions(query.filters))
    return { kind: "exact", qualification: "native" };
  const metadata = scopedFilterMetadata(query.filters);
  const authorized = query.context.subject.authorizedSiteIds;
  if (
    !metadata ||
    metadata.plan !== query.scopePlan ||
    metadata.time !== query.time ||
    metadata.plan.preparedMembership !== undefined ||
    metadata.siteIds.length !== authorized.length ||
    metadata.siteIds.some((siteId) => !authorized.some((id) => id === siteId))
  )
    return { kind: "legacy", reason: "request-context-mismatch" };
  const time = metadata.time;
  const read = time.readRange ?? time.range;
  if (
    time.fullHistory ||
    time.filterRange !== undefined ||
    time.filterRangeEmpty ||
    read.startMs !== time.range.startMs ||
    read.endExclusiveMs !== time.range.endExclusiveMs
  )
    return { kind: "legacy", reason: "independent-time-domains" };
  if (advancedCountPayloadPaths(query.filters.root!).length > 0)
    return { kind: "legacy", reason: "payload" };
  const plan = planAdvancedFilterExecution({
    subject: semanticSubjectFromQuerySubject(query.context.subject),
    filters: query.filters,
    scope: metadata.plan.scope,
    time,
    reportFusionAvailable: false,
  });
  return plan.decision.strategy === "sql-membership"
    ? { kind: "exact", qualification: "sql-membership" }
    : { kind: "legacy", reason: "unsupported-membership" };
}
