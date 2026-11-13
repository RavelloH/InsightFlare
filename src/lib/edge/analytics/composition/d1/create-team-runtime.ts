import {
  AnalyticsProviderRegistry,
  typedQueryProviderFor,
} from "@/lib/edge/analytics/application/provider-registry";
import { prepareSiteQueryForTeamRequest } from "@/lib/edge/analytics/application/team-site-delegation";
import { createD1SiteProviderRegistry } from "@/lib/edge/analytics/composition/d1/create-site-runtime";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  type FilterDocument,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
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
  const registry = new AnalyticsProviderRegistry()
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
      typedQueryProviderFor("team-sites", async (request) => {
        const page = request.page
          ? {
              limit: request.page.limit,
              cursor: request.page.cursor ?? null,
            }
          : undefined;
        const result = await readTeamSites({
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
      typedQueryProviderFor("dimension", async (request) => {
        if (request.mode !== "breakdown") {
          throw new Error("unsupported-team-dimension-mode");
        }
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
          }),
        };
      }),
    );

  const jointQualification = d1AdvancedFilterMiddleware(options.env);
  registry.useMiddleware(async (operation, input, next, execution) => {
    const filters = (input as { readonly filters?: FilterDocument }).filters;
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
