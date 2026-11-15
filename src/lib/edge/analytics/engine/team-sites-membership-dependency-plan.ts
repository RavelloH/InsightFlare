import type {
  Interval,
  QueryInput,
  QueryTime,
} from "@/lib/edge/analytics/contract";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import { advancedCountPayloadPaths } from "@/lib/edge/analytics/engine/advanced-count-payload-selector";
import { planAdvancedFilterExecution } from "@/lib/edge/analytics/engine/advanced-filter-execution-plan";
import {
  freezeMembershipRecipeValue,
  normalizeMembershipPreparations,
  validMembershipChildReferences,
} from "@/lib/edge/analytics/engine/membership-dependency-plan";
import { semanticSubjectFromQuerySubject } from "@/lib/edge/analytics/engine/semantic/subject";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";

export interface TeamSitesMembershipQuery extends QueryInput {
  readonly time: QueryTime;
  readonly teamId?: string;
  readonly allowedSiteIds?: readonly string[];
  readonly interval?: Interval;
  readonly page?: { readonly limit: number; readonly cursor?: string | null };
}

/** Finite reader declaration, not subject/admission or storage authority. */
export function planTeamSitesMembershipDependencies(
  query: TeamSitesMembershipQuery,
) {
  const subject = query.context.subject;
  if (
    subject.kind !== "team" ||
    query.context.policy.audience !== "private-dashboard" ||
    !query.filters ||
    !filterDocumentUsesAdvancedExpressions(query.filters)
  )
    return undefined;
  const metadata = scopedFilterMetadata(query.filters);
  if (
    !metadata ||
    metadata.plan !== query.scopePlan ||
    metadata.time !== query.time ||
    metadata.plan.preparedMembership !== undefined ||
    metadata.plan.mode !== "entity" ||
    (metadata.plan.scope !== "session" && metadata.plan.scope !== "visitor") ||
    metadata.plan.membership.kind !== "entity"
  )
    return undefined;
  const sites = metadata.siteIds;
  if (
    new Set(sites).size !== sites.length ||
    sites.some((id) => typeof id !== "string" || !id) ||
    sites.length !== subject.authorizedSiteIds.length ||
    sites.some(
      (id) =>
        !subject.authorizedSiteIds.some((authorized) => authorized === id),
    )
  )
    return undefined;
  const time = metadata.time,
    read = time.readRange ?? time.range;
  if (
    time.fullHistory ||
    time.filterRange !== undefined ||
    time.filterRangeEmpty ||
    read.startMs !== time.range.startMs ||
    read.endExclusiveMs !== time.range.endExclusiveMs ||
    advancedCountPayloadPaths(query.filters.root!).length > 0
  )
    return undefined;
  if (
    query.interval !== undefined &&
    !["minute", "hour", "day", "week", "month"].includes(query.interval)
  )
    return undefined;
  const execution = planAdvancedFilterExecution({
    subject: semanticSubjectFromQuerySubject(subject),
    filters: query.filters,
    scope: metadata.plan.scope,
    time,
    reportFusionAvailable: false,
  });
  const preparations = normalizeMembershipPreparations([
    { key: "joint", execution, filters: query.filters, queryTime: time },
  ]);
  if (!preparations || preparations.length !== 1) return undefined;
  const readers: {
    readonly key: "overview" | "trend" | "latest";
    readonly localOutputId:
      "overview-aggregate" | "overview-trend" | "overview-latest-site-activity";
    readonly sourceRoles: readonly ["page", "event"] | readonly ["page"];
    readonly maxSources: 1 | 2;
  }[] = [
    {
      key: "overview",
      localOutputId: "overview-aggregate",
      sourceRoles: ["page", "event"],
      maxSources: 2,
    },
    {
      key: "latest",
      localOutputId: "overview-latest-site-activity",
      sourceRoles: ["page"],
      maxSources: 1,
    },
  ];
  if (query.interval)
    readers.splice(1, 0, {
      key: "trend",
      localOutputId: "overview-trend",
      sourceRoles: ["page", "event"],
      maxSources: 2,
    });
  const children = sites.flatMap((siteId) =>
    readers.map((reader) => ({
      key: `site:${siteId}:${reader.key}`,
      siteId,
      preparationKey: "joint",
      readerKey: reader.key,
      readerProfile: query.interval
        ? ("team-site-metrics-trend-v1" as const)
        : ("team-site-metrics-v1" as const),
      localOutputId: reader.localOutputId,
      sourceRoles: reader.sourceRoles,
      maxPlans: 1 as const,
      maxSources: reader.maxSources,
      queryTime: time,
      ...(reader.key === "trend" ? { interval: query.interval } : {}),
    })),
  );
  if (!validMembershipChildReferences(preparations, children)) return undefined;
  const value = {
    kind: "team-sites-membership-dependencies" as const,
    admission: { ...preparations[0]!, siteIds: sites },
    children,
    consumer: {
      operation: "team-sites" as const,
      teamId: subject.teamId,
      audience: "private-dashboard" as const,
      scope: metadata.plan,
      interval: query.interval,
      page: query.page,
      allowedSiteIds: query.allowedSiteIds,
    },
  };
  return freezeMembershipRecipeValue(
    JSON.parse(JSON.stringify(value)) as typeof value,
  );
}
export type TeamSitesMembershipDependencyPlan = NonNullable<
  ReturnType<typeof planTeamSitesMembershipDependencies>
>;
