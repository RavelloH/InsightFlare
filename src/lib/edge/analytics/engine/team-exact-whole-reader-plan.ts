import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import { crossBreakdownPageDimensionSelection } from "@/lib/edge/analytics/engine/dimension-report-plan";
import {
  planTeamExactDimensionExecution,
  type TeamExactDimensionQuery,
} from "@/lib/edge/analytics/engine/team-exact-dimension-plan";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";

/** Closed declaration only. Existing native/Count readers retain priority.
 * Complete canonical authorization is required; duplicates/noncanonical domains
 * retain the existing legacy route rather than silently changing joint work. */
export function planTeamExactWholeOriginalReader(
  query: TeamExactDimensionQuery,
) {
  const subject = query.context.subject;
  const filters = query.filters;
  const selection = crossBreakdownPageDimensionSelection(query.dimension);
  if (
    subject.kind !== "team" ||
    query.context.policy.audience !== "private-dashboard" ||
    query.mode !== "breakdown" ||
    !selection ||
    !filters?.root ||
    !filterDocumentUsesAdvancedExpressions(filters) ||
    planTeamExactDimensionExecution(query).kind === "exact"
  )
    return undefined;
  const metadata = scopedFilterMetadata(filters);
  if (
    !metadata ||
    metadata.plan !== query.scopePlan ||
    !metadata.time ||
    metadata.plan.preparedMembership !== undefined ||
    metadata.plan.mode !== "entity" ||
    (metadata.plan.scope !== "session" && metadata.plan.scope !== "visitor") ||
    metadata.plan.membership.kind !== "entity"
  )
    return undefined;
  const authorized = subject.authorizedSiteIds;
  const canonical = [...new Set(authorized)].sort();
  if (
    canonical.length !== authorized.length ||
    canonical.some((id) => typeof id !== "string" || !id) ||
    metadata.siteIds.length !== canonical.length ||
    metadata.siteIds.some((id, index) => id !== canonical[index])
  )
    return undefined;
  return Object.freeze({
    kind: "team-exact-dimension-whole-original-reader-v1" as const,
    teamId: subject.teamId,
    siteIds: Object.freeze([...metadata.siteIds]),
  });
}
export type TeamExactWholeOriginalReader = NonNullable<
  ReturnType<typeof planTeamExactWholeOriginalReader>
>;
