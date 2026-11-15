import { typedQueryProviderFor } from "@/lib/edge/analytics/application/provider-registry";
import { prepareSiteExactDimensionRequest } from "@/lib/edge/analytics/application/site-exact-dimension";
import { prepareSiteQueryForTeamRequest } from "@/lib/edge/analytics/application/team-site-delegation";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { D1ProgramProviderRegistry } from "@/lib/edge/analytics/composition/d1/program-provider-registry";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { scopedFilterMetadata } from "@/lib/edge/analytics/contract/scoped-filter";
import {
  planTeamExactDimensionExecution,
  type TeamExactDimensionQuery,
} from "@/lib/edge/analytics/engine/team-exact-dimension-plan";
import { planTeamSitesMembershipDependencies } from "@/lib/edge/analytics/engine/team-sites-membership-dependency-plan";
import {
  d1AdvancedFilterMiddleware,
  prepareSiteExactDimensionInputs,
  prepareTeamSitesQualification,
} from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { hasWholeOriginalCompletion } from "@/lib/edge/analytics/providers/d1/internal/whole-filter-reader-preparation";
import { readSiteExactDimension } from "@/lib/edge/analytics/providers/d1/operations/site-exact-dimension";
import { readTeamBreakdown } from "@/lib/edge/analytics/providers/d1/operations/team-breakdown";
import { readTeamOverview } from "@/lib/edge/analytics/providers/d1/operations/team-overview";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import { readTeamTimeseries } from "@/lib/edge/analytics/providers/d1/operations/team-timeseries";
import type { Env } from "@/lib/edge/types";
import { filterDocumentUsesAdvancedExpressions } from "@/lib/filter-contract/filter-types";
interface D1TeamRuntimeBindings {
  readonly env: Env;
}
function timeWindow(time: QueryTime) {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}
/** Team operations whose advanced filters are qualified one site at a time. */
const SITE_DELEGATED_OPERATIONS = new Set(["overview", "trend"]);

function usesAdvancedFilters(filters: FilterDocument | undefined): boolean {
  return (
    filters !== undefined && filterDocumentUsesAdvancedExpressions(filters)
  );
}

/**
 * Session and visitor identities are site-local, so a team filter qualifies
 * each site independently. Delegating to the site pipeline gives every site
 * the same bounded SQL qualification as a single-site request, under the
 * team request's own audience and authorized sites, without one joint
 * evaluation or a membership packed for the whole team.
 */
function siteDelegate(
  options: D1TeamRuntimeBindings,
  operation: "overview" | "trend",
  request: {
    readonly context: { readonly policy: { readonly audience: never } };
    readonly time: QueryTime;
    readonly filters?: FilterDocument;
    readonly scopePreference?: unknown;
    readonly interval?: unknown;
  },
) {
  return async (siteId: string) => {
    const registry = createD1SiteProviderRegistry({
      env: options.env,
      siteId,
    });
    const siteQuery = prepareSiteQueryForTeamRequest(operation, siteId, {
      audience: request.context.policy.audience,
      time: request.time,
      ...(request.filters !== undefined ? { filters: request.filters } : {}),
      ...(request.scopePreference !== undefined
        ? { scopePreference: request.scopePreference }
        : {}),
      ...(request.interval !== undefined ? { interval: request.interval } : {}),
    });
    const provider = registry.resolve(operation);
    if (!provider) throw new Error("team_site_delegate_provider_missing");
    return (await provider.execute(siteQuery as never)) as never;
  };
}

export function createD1TeamProviderRegistry(options: D1TeamRuntimeBindings) {
  const registry = new D1ProgramProviderRegistry()
    .register(
      "overview",
      typedQueryProviderFor("overview", async (request) => {
        const result = await readTeamOverview({
          env: options.env,
          teamId: request.teamId ?? "",
          allowedSiteIds: request.allowedSiteIds,
          window: timeWindow(request.time),
          filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          ...(usesAdvancedFilters(request.filters)
            ? {
                readSite: async (siteId: string) => {
                  const site = (await siteDelegate(
                    options,
                    "overview",
                    request as never,
                  )(siteId)) as {
                    value: { current: never };
                    source: never;
                    approximateVisitors: boolean;
                  };
                  return {
                    value: site.value.current,
                    source: site.source,
                    approximateVisitors: site.approximateVisitors,
                  };
                },
              }
            : {}),
        });
        return {
          value: { current: result.data },
          source: result.source,
          approximateVisitors: result.approximateVisitors,
        };
      }),
    )
    .register(
      "trend",
      typedQueryProviderFor("trend", async (request) => {
        const result = await readTeamTimeseries({
          env: options.env,
          teamId: request.teamId ?? "",
          allowedSiteIds: request.allowedSiteIds,
          interval: request.interval,
          window: timeWindow(request.time),
          filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          ...(usesAdvancedFilters(request.filters)
            ? {
                readSite: async (siteId: string) => {
                  const site = (await siteDelegate(
                    options,
                    "trend",
                    request as never,
                  )(siteId)) as {
                    value: { points: never };
                    source: never;
                    approximateVisitors: boolean;
                  };
                  return {
                    value: site.value.points,
                    source: site.source,
                    approximateVisitors: site.approximateVisitors,
                  };
                },
              }
            : {}),
        });
        return {
          value: result.data,
          source: result.source,
          approximateVisitors: result.approximateVisitors,
        };
      }),
    )
    .register(
      "team-sites",
      typedQueryProviderFor("team-sites", async (request, execution) => {
        const qualification = await prepareTeamSitesQualification({
          env: options.env,
          query: request,
          signal: execution?.signal,
        });
        const page = request.page
          ? {
              limit: request.page.limit,
              cursor: request.page.cursor ?? null,
            }
          : undefined;
        const result = await readTeamSites({
          ...(qualification ? { qualification } : {}),
          env: options.env,
          teamId: request.teamId ?? "",
          allowedSiteIds: request.allowedSiteIds,
          interval: request.interval,
          window: timeWindow(request.time),
          filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          page,
          audience: request.context.policy.audience,
        });
        return {
          value: result.data,
          source: result.source,
          approximateVisitors: result.approximateVisitors,
        };
      }),
    )
    .register(
      "dimension",
      typedQueryProviderFor("dimension", async (request, execution) => {
        if (request.mode !== "breakdown") {
          throw new Error("unsupported-team-dimension-mode");
        }
        const exact = planTeamExactDimensionExecution(request);
        // Qualification used to precede the team site listing. Keep that
        // ordering and the full authorized domain even when no site remains.
        const inputsBySite =
          exact.kind === "exact" && request.context.subject.kind === "team"
            ? await prepareSiteExactDimensionInputs({
                env: options.env,
                query: request,
                siteIds: request.context.subject.authorizedSiteIds,
                signal: execution?.signal,
              })
            : undefined;
        return {
          value: await readTeamBreakdown({
            env: options.env,
            teamId: "teamId" in request ? (request.teamId ?? "") : "",
            allowedSiteIds:
              "allowedSiteIds" in request ? request.allowedSiteIds : undefined,
            dimension: request.dimension,
            limit:
              typeof request.limit === "number" &&
              Number.isFinite(request.limit)
                ? request.limit
                : 20,
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
            ...(hasWholeOriginalCompletion(request, "team-exact-dimension")
              ? { wholeOriginalOwner: request }
              : {}),
            ...(exact.kind === "exact"
              ? {
                  readExactSites: async (siteIds: readonly string[]) => {
                    if (siteIds.some((siteId) => !inputsBySite!.has(siteId)))
                      throw new Error(
                        "site_exact_dimension_request_context_mismatch",
                      );
                    return Promise.all(
                      siteIds.map((siteId) => {
                        const input = inputsBySite!.get(siteId)!;
                        const filters = input.filters;
                        const metadata = scopedFilterMetadata(filters);
                        return readSiteExactDimension(
                          options.env,
                          prepareSiteExactDimensionRequest({
                            siteId,
                            audience: request.context.policy.audience,
                            dimension: request.dimension,
                            time: request.time,
                            filters,
                            scopePreference: request.scopePreference,
                            ...(exact.qualification === "sql-membership"
                              ? {
                                  qualifiedPlan:
                                    input.qualifiedPlan ?? metadata!.plan,
                                  ...(input.qualification
                                    ? { qualification: input.qualification }
                                    : {}),
                                }
                              : {}),
                          }),
                        );
                      }),
                    );
                  },
                }
              : {}),
          }),
        };
      }),
    );

  const jointQualification = d1AdvancedFilterMiddleware(options.env);
  registry.useMiddleware(async (operation, input, next, execution) => {
    const filters = (input as { readonly filters?: FilterDocument }).filters;
    if (
      operation === "dimension" &&
      planTeamExactDimensionExecution(input as TeamExactDimensionQuery).kind ===
        "exact"
    )
      return next(input);
    if (
      operation === "team-sites" &&
      planTeamSitesMembershipDependencies(input as never)
    )
      return next(input);
    // Delegated operations qualify each site in its own pipeline.
    if (
      SITE_DELEGATED_OPERATIONS.has(operation) &&
      usesAdvancedFilters(filters)
    )
      return next(input);
    return jointQualification(operation, input, next, execution);
  });
  return registry;
}

export function createD1TeamQueryRuntime(options: D1TeamRuntimeBindings) {
  return createAnalyticsQueryRuntime(createD1TeamProviderRegistry(options));
}
