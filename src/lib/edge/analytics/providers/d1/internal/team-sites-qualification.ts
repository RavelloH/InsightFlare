import type { QueryTime } from "@/lib/edge/analytics/contract";
import type { FilterDocument } from "@/lib/edge/analytics/contract";
import {
  attachScopedFilterMetadata,
  scopedFilterMetadata,
} from "@/lib/edge/analytics/contract/scoped-filter";
import { buildLatestSiteActivityPlan } from "@/lib/edge/analytics/engine/latest-site-activity-report-plan";
import { buildOverviewAggregatePlan } from "@/lib/edge/analytics/engine/overview-aggregate-report-plan";
import { buildOverviewTrendPlan } from "@/lib/edge/analytics/engine/overview-trend-report-plan";
import { EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY } from "@/lib/edge/analytics/engine/semantic/qualification-dependency";
import {
  planTeamSitesMembershipDependencies,
  type TeamSitesMembershipDependencyPlan,
  type TeamSitesMembershipQuery,
} from "@/lib/edge/analytics/engine/team-sites-membership-dependency-plan";
import {
  assertTeamSitesWholeOriginalReaderShape,
  buildTeamSitesWholeOriginalReader,
  type TeamSitesWholeOriginalReaderPlan,
  teamSitesWholeOriginalReaderSchedule,
} from "@/lib/edge/analytics/engine/team-sites-whole-reader-plan";
import type { AnalyticsDbRelation } from "@/lib/edge/analytics/providers/d1/internal/analytics-relational-storage";
import type { EventMembershipFallback } from "@/lib/edge/analytics/providers/d1/internal/event-membership-fallback";
import {
  assertPageVisitQualificationPreparationContext,
  bindPageVisitQualificationPreparation,
  createPageVisitQualificationPreparation,
  pageVisitQualificationConsumerKey,
  snapshotPageVisitQualificationPlan,
} from "@/lib/edge/analytics/providers/d1/internal/page-visit-qualification-execution";
import type { ReadTeamSitesInput } from "@/lib/edge/analytics/providers/d1/operations/team-sites";

declare const teamSitesQualificationBrand: unique symbol;
export type TeamSitesQualification = Readonly<{
  readonly [teamSitesQualificationBrand]: true;
}>;
interface State {
  readonly query: TeamSitesMembershipQuery;
  readonly recipe:
    TeamSitesMembershipDependencyPlan | TeamSitesWholeOriginalReaderPlan;
  readonly qualificationTime?: QueryTime;
  readonly relation: AnalyticsDbRelation;
  readonly assertFresh: () => void;
  claimed: boolean;
}
const states = new WeakMap<object, State>();
const snapshot = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (v instanceof Set ? [...v] : v));
/** The joint admission owner supplies the original complete sorted relation. */
export function createTeamSitesQualification(
  input: Omit<State, "claimed">,
): TeamSitesQualification {
  input.assertFresh();
  if (
    input.recipe.kind !== "team-sites-whole-original-readers-v1" &&
    snapshot(planTeamSitesMembershipDependencies(input.query)) !==
      snapshot(input.recipe)
  )
    throw new Error("team_sites_qualification_recipe_mismatch");
  const value = Object.freeze(Object.create(null)) as TeamSitesQualification;
  states.set(value, { ...input, claimed: false });
  return value;
}
/** No metadata/cursor/storage may precede the fresh joint admission check. */
export function teamSitesQualificationReaders(
  input: ReadTeamSitesInput,
  qualification: unknown,
) {
  const state =
    typeof qualification === "object" && qualification !== null
      ? states.get(qualification)
      : undefined;
  if (!state || state.claimed)
    throw new Error("team_sites_qualification_untrusted_or_replayed");
  const q = state.query;
  const whole = state.recipe.kind === "team-sites-whole-original-readers-v1";
  const wholeSchedule = whole
    ? teamSitesWholeOriginalReaderSchedule(input.interval)
    : undefined;
  // This is the existing synchronous readTeamSites handoff, after its original
  // qualification await. Later changes to q.time/page/interval must not replace
  // values already captured by composition in the actual reader input.
  const wholeReadData = whole
    ? snapshot({
        teamId: q.teamId ?? "",
        audience: q.context.policy.audience,
        interval: q.interval,
        allowedSiteIds: q.allowedSiteIds,
        page: q.page
          ? { limit: q.page.limit, cursor: q.page.cursor ?? null }
          : undefined,
        window: {
          startMs: q.time.range.startMs,
          endExclusiveMs: q.time.range.endExclusiveMs,
          nowMs: q.time.capturedAtMs,
          timeZone: q.time.reportingTimeZone,
        },
      })
    : undefined;
  const assertRead = () => {
    state.assertFresh();
    if (whole) {
      if (
        input.filters !== q.filters ||
        snapshot({
          teamId: input.teamId,
          audience: input.audience,
          interval: input.interval,
          allowedSiteIds: input.allowedSiteIds,
          page: input.page,
          window: input.window,
        }) !== wholeReadData
      )
        throw new Error("team_sites_qualification_request_mismatch");
      return;
    }
    if (
      input.filters !== q.filters ||
      input.teamId !== (q.teamId ?? "") ||
      input.audience !== q.context.policy.audience ||
      input.interval !== q.interval ||
      snapshot(input.allowedSiteIds) !== snapshot(q.allowedSiteIds) ||
      snapshot(input.page) !==
        snapshot(
          q.page
            ? { limit: q.page.limit, cursor: q.page.cursor ?? null }
            : undefined,
        ) ||
      snapshot(input.window) !==
        snapshot({
          startMs: q.time.range.startMs,
          endExclusiveMs: q.time.range.endExclusiveMs,
          nowMs: q.time.capturedAtMs,
          timeZone: q.time.reportingTimeZone,
        })
    )
      throw new Error("team_sites_qualification_request_mismatch");
  };
  assertRead();
  state.claimed = true;
  const usedSites = new Set<string>();
  return {
    assertFresh: assertRead,
    site(siteId: string): {
      readonly filters: FilterDocument;
      readonly membership: EventMembershipFallback;
    } {
      assertRead();
      if (
        usedSites.has(siteId) ||
        !(
          state.recipe.kind === "team-sites-whole-original-readers-v1"
            ? state.recipe.siteIds
            : state.recipe.admission.siteIds
        ).includes(siteId)
      )
        throw new Error("team_sites_qualification_site_mismatch");
      usedSites.add(siteId);
      const metadata = scopedFilterMetadata(q.filters)!;
      // Whole readers retain the actual forwarded document. A scoped shallow
      // view is made separately at each original canonical builder checkpoint.
      const filters = whole
        ? q.filters!
        : attachScopedFilterMetadata(q.filters!, {
            ...metadata,
            siteIds: [siteId],
          });
      const children =
        state.recipe.kind === "team-sites-whole-original-readers-v1"
          ? wholeSchedule!.readers.map((readerKey) => ({
              key: `site:${siteId}:${readerKey}`,
              readerKey,
              localOutputId:
                readerKey === "overview"
                  ? "overview-aggregate"
                  : readerKey === "trend"
                    ? "overview-trend"
                    : "overview-latest-site-activity",
              maxSources: readerKey === "latest" ? 1 : 2,
              sourceRoles:
                readerKey === "latest" ? ["page"] : ["page", "event"],
            }))
          : state.recipe.children.filter((c) => c.siteId === siteId);
      const consumerKey = pageVisitQualificationConsumerKey("team-sites", {
        consumer:
          state.recipe.kind === "team-sites-whole-original-readers-v1"
            ? {
                operation: "team-sites",
                schedule: wholeSchedule,
                audience: q.context.policy.audience,
              }
            : state.recipe.consumer,
        siteId,
      });
      const qualificationTime = whole ? state.qualificationTime! : q.time;
      let preparationFilters = filters;
      let preparation = whole
        ? undefined
        : createPageVisitQualificationPreparation({
            siteId,
            filters,
            queryTime: qualificationTime,
            scopePlan: metadata.plan,
            consumerKey,
            relation: state.relation,
            dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
            maxBindings: children.length,
            maxSourcesPerRole: 2,
          });
      const usedChildren = new Set<string>();
      const context = {
        siteId,
        filters,
        queryTime: qualificationTime,
        scopePlan: metadata.plan,
        consumerKey,
      };
      return {
        filters,
        membership: {
          bindPlan(build, readerQueryTime) {
            if (!whole) {
              assertRead();
              assertPageVisitQualificationPreparationContext({
                preparation: preparation!,
                ...context,
              });
              if (snapshot(readerQueryTime) !== snapshot(q.time))
                throw new Error(
                  "team_sites_qualification_reader_time_mismatch",
                );
            }
            const readerFilters = whole
              ? attachScopedFilterMetadata(filters, {
                  ...scopedFilterMetadata(filters)!,
                  siteIds: [siteId],
                })
              : filters;
            const reportContext = {
              queryTime: whole ? readerQueryTime! : q.time,
              ...(whole
                ? {
                    qualificationSemantics: "whole-original" as const,
                    readerFilters,
                  }
                : {}),
              scopePlan: metadata.plan,
              qualificationDependencyRefs: [
                EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
              ],
              pageVisitDependencyRefs: [
                EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
              ],
            };
            const plan = snapshotPageVisitQualificationPlan(
              build(reportContext),
            );
            const child = children.find(
              (c) => c.localOutputId === plan.outputs[0]?.id,
            );
            if (
              !child ||
              plan.outputs.length !== 1 ||
              usedChildren.has(child.key) ||
              (whole &&
                child.readerKey !== children[usedChildren.size]?.readerKey)
            )
              throw new Error("team_sites_qualification_reader_mismatch");
            const canonical = whole
              ? buildTeamSitesWholeOriginalReader({
                  query: q,
                  siteId,
                  filters: readerFilters,
                  readerQueryTime: readerQueryTime!,
                  reader: child.readerKey,
                  interval: input.interval,
                })
              : child.readerKey === "overview"
                ? buildOverviewAggregatePlan(contextWithRefs())
                : child.readerKey === "trend"
                  ? buildOverviewTrendPlan({
                      ...contextWithRefs(),
                      interval: q.interval!,
                    })
                  : buildLatestSiteActivityPlan(contextWithRefs());
            const sources = plan.nodes.filter((n) => n.kind === "source");
            if (
              sources.length !== child.maxSources ||
              snapshot(sources.map((s) => s.entity)) !==
                snapshot(child.sourceRoles) ||
              snapshot(plan) !==
                snapshot(snapshotPageVisitQualificationPlan(canonical))
            )
              throw new Error("team_sites_qualification_reader_mismatch");
            if (whole) {
              assertTeamSitesWholeOriginalReaderShape(plan, child.readerKey);
              assertRead();
              if (!preparation) {
                preparationFilters = sources[0]!.selection!.filter;
                preparation = createPageVisitQualificationPreparation({
                  ...context,
                  filters: preparationFilters,
                  relation: state.relation,
                  dependencyRef: EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
                  maxBindings: children.length,
                  maxSourcesPerRole: 2,
                  qualificationSemantics: "whole-original",
                });
              }
            }
            const executionInputs = bindPageVisitQualificationPreparation({
              preparation: preparation!,
              ...context,
              ...(whole
                ? {
                    filters: preparationFilters,
                    readerFilters: sources[0]!.selection!.filter,
                    readerPreparationTime: scopedFilterMetadata(filters)!.time,
                  }
                : {}),
              plan,
              readerQueryTime,
            });
            usedChildren.add(child.key);
            return { plan, executionInputs };
            function contextWithRefs() {
              return {
                siteId,
                filters,
                queryTime: q.time,
                scopePlan: metadata.plan,
                qualificationDependencyRefs: [
                  EVENT_FILTER_ENTITY_MEMBERSHIP_DEPENDENCY,
                ],
              };
            }
          },
        },
      };
    },
  };
}
