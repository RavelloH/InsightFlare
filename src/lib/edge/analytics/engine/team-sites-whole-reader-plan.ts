import type { QueryTime } from "@/lib/edge/analytics/contract";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import { buildLatestSiteActivityPlan } from "@/lib/edge/analytics/engine/latest-site-activity-report-plan";
import type { ValidatedLogicalPlan } from "@/lib/edge/analytics/engine/logical/plan";
import { validateLogicalPlan } from "@/lib/edge/analytics/engine/logical/validator";
import { buildOverviewAggregatePlan } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import { buildOverviewTrendPlan } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import type { TeamSitesMembershipQuery } from "@/lib/edge/analytics/engine/team-sites-membership-dependency-plan";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";

/** A closed reader declaration; not admission or physical relation authority.
 * It never calls Count eligibility or normalizes a live filter/time value. */
export function planTeamSitesWholeOriginalReaders(
  query: TeamSitesMembershipQuery,
) {
  const subject = query.context.subject;
  const filters = query.filters;
  if (
    subject.kind !== "team" ||
    query.context.policy.audience !== "private-dashboard" ||
    !filters?.root ||
    !filterDocumentUsesAdvancedExpressions(filters)
  )
    return undefined;
  const metadata = scopedFilterMetadata(filters);
  if (
    !metadata ||
    metadata.plan !== query.scopePlan ||
    metadata.time === undefined ||
    metadata.plan.preparedMembership !== undefined ||
    metadata.plan.mode !== "entity" ||
    (metadata.plan.scope !== "session" && metadata.plan.scope !== "visitor") ||
    metadata.plan.membership.kind !== "entity"
  )
    return undefined;
  const authorized = subject.authorizedSiteIds;
  if (
    new Set(metadata.siteIds).size !== metadata.siteIds.length ||
    metadata.siteIds.some((id) => typeof id !== "string" || !id) ||
    new Set(authorized).size !== authorized.length ||
    metadata.siteIds.length !== authorized.length ||
    metadata.siteIds.some(
      (id) => !authorized.some((allowed) => allowed === id),
    ) ||
    metadata.siteIds.some((id, i) => id !== [...new Set(authorized)].sort()[i])
  )
    return undefined;
  // Unknown configuration stays on the original route and its old error point.
  if (
    query.interval !== undefined &&
    !["minute", "hour", "day", "week", "month"].includes(query.interval)
  )
    return undefined;
  return Object.freeze({
    kind: "team-sites-whole-original-readers-v1" as const,
    siteIds: Object.freeze([...metadata.siteIds]),
  });
}
export type TeamSitesWholeOriginalReaderPlan = NonNullable<
  ReturnType<typeof planTeamSitesWholeOriginalReaders>
>;
/** Derive only from the actual original reader handoff input. Invalid
 * intervals still reach the original canonical builder error checkpoint. */
export function teamSitesWholeOriginalReaderSchedule(
  interval: TeamSitesMembershipQuery["interval"],
) {
  const readers = interval
    ? (["overview", "trend", "latest"] as const)
    : (["overview", "latest"] as const);
  return Object.freeze({
    interval,
    readers: Object.freeze([...readers]),
    planBindingsPerSite: readers.length,
    sourceOccurrencesPerSite: interval ? 5 : 3,
  });
}
export type TeamSitesWholeOriginalReader = ReturnType<
  typeof teamSitesWholeOriginalReaderSchedule
>["readers"][number];

/** Uses actual IR, not the output count or a caller-provided budget. */
export function buildTeamSitesWholeOriginalReader(input: {
  readonly query: TeamSitesMembershipQuery;
  readonly siteId: string;
  readonly filters: NonNullable<TeamSitesMembershipQuery["filters"]>;
  readonly readerQueryTime: QueryTime;
  readonly reader: TeamSitesWholeOriginalReader;
  readonly interval?: TeamSitesMembershipQuery["interval"];
}): ValidatedLogicalPlan {
  const metadata = scopedFilterMetadata(input.filters);
  if (!metadata) throw new Error("team_sites_whole_reader_context_missing");
  const context = {
    siteId: input.siteId,
    filters: input.filters,
    queryTime: input.readerQueryTime,
    scopePlan: metadata.plan,
    qualificationDependencyRefs: [EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY],
    qualificationSemantics: "whole-original" as const,
  };
  return input.reader === "overview"
    ? buildOverviewAggregatePlan(context)
    : input.reader === "trend"
      ? buildOverviewTrendPlan({ ...context, interval: input.interval! })
      : buildLatestSiteActivityPlan(context);
}

export function assertTeamSitesWholeOriginalReaderShape(
  plan: ValidatedLogicalPlan,
  reader: TeamSitesWholeOriginalReader,
): void {
  validateLogicalPlan(plan);
  const output =
    reader === "overview"
      ? "overview-aggregate"
      : reader === "trend"
        ? "overview-trend"
        : "overview-latest-site-activity";
  const roles = reader === "latest" ? ["page"] : ["page", "event"];
  const sources = plan.nodes.filter((node) => node.kind === "source");
  if (
    !Object.isFrozen(plan) ||
    plan.outputs.length !== 1 ||
    plan.outputs[0]?.id !== output ||
    sources.length !== roles.length ||
    sources.some(
      (source, i) =>
        source.entity !== roles[i] ||
        source.selection?.profile !==
          "prepared-whole-filter-reader-window-v1" ||
        source.selection.qualificationDependencyRefs?.length !== 1 ||
        source.selection.qualificationDependencyRefs[0] !==
          EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
    )
  )
    throw new Error("team_sites_whole_reader_shape_mismatch");
}
