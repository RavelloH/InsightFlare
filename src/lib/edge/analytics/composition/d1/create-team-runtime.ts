import {
  AnalyticsProviderRegistry,
  typedQueryProviderFor,
} from "@/lib/edge/analytics/application/provider-registry";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  EMPTY_FILTER_DOCUMENT,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { d1AdvancedFilterMiddleware } from "@/lib/edge/analytics/providers/d1/internal/advanced-filter-execution";
import { readTeamBreakdown } from "@/lib/edge/analytics/providers/d1/operations/team-breakdown";
import { readTeamOverview } from "@/lib/edge/analytics/providers/d1/operations/team-overview";
import { readTeamSites } from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import { readTeamTimeseries } from "@/lib/edge/analytics/providers/d1/operations/team-timeseries";
import type { Env } from "@/lib/edge/types";
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

  registry.useMiddleware(d1AdvancedFilterMiddleware(options.env));
  return registry;
}

export function createD1TeamQueryRuntime(options: D1TeamRuntimeBindings) {
  return createAnalyticsQueryRuntime(createD1TeamProviderRegistry(options));
}
