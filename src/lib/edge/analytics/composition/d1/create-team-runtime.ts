import {
  AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import {
  type BreakdownResult,
  EMPTY_FILTER_DOCUMENT,
  type QueryInput,
  type QueryTime,
} from "@/lib/edge/analytics/contract";
import { readTeamBreakdown } from "@/lib/edge/analytics/providers/d1/operations/team-breakdown";
import {
  readTeamOverview,
  type TeamOverviewQueryResult,
} from "@/lib/edge/analytics/providers/d1/operations/team-overview";
import {
  readTeamSites,
  type TeamSitesQueryResult,
} from "@/lib/edge/analytics/providers/d1/operations/team-sites";
import {
  readTeamTimeseries,
  type TeamTimeseriesQueryResult,
} from "@/lib/edge/analytics/providers/d1/operations/team-timeseries";
import type { Env } from "@/lib/edge/types";

type RuntimeQuery = QueryInput & {
  readonly time: QueryTime;
  readonly [key: string]: unknown;
};

export interface D1TeamQueryRuntimeOptions {
  readonly env: Env;
}

function query(input: QueryInput): RuntimeQuery {
  return input as RuntimeQuery;
}

function stringField(input: RuntimeQuery, name: string, fallback = ""): string {
  const value = input[name];
  return typeof value === "string" ? value : fallback;
}

function numberField(
  input: RuntimeQuery,
  name: string,
  fallback: number,
): number {
  const value = input[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function allowedSiteIds(input: RuntimeQuery): readonly string[] | undefined {
  const value = input.allowedSiteIds;
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function timeWindow(time: QueryTime) {
  return {
    startMs: time.range.startMs,
    endExclusiveMs: time.range.endExclusiveMs,
    nowMs: time.capturedAtMs,
    timeZone: time.reportingTimeZone,
  };
}

export function createD1TeamQueryRuntime(options: D1TeamQueryRuntimeOptions) {
  const registry = new AnalyticsProviderRegistry()
    .register(
      "overview",
      typedQueryProvider<TeamOverviewQueryResult>(async (input) => {
        const request = query(input!);
        return {
          value: await readTeamOverview({
            env: options.env,
            teamId: stringField(request, "teamId"),
            allowedSiteIds: allowedSiteIds(request),
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          }),
        };
      }),
    )
    .register(
      "trend",
      typedQueryProvider<TeamTimeseriesQueryResult>(async (input) => {
        const request = query(input!);
        return {
          value: await readTeamTimeseries({
            env: options.env,
            teamId: stringField(request, "teamId"),
            allowedSiteIds: allowedSiteIds(request),
            interval: request.interval as never,
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          }),
        };
      }),
    )
    .register(
      "team-sites",
      typedQueryProvider<TeamSitesQueryResult>(async (input) => {
        const request = query(input!);
        return {
          value: await readTeamSites({
            env: options.env,
            teamId: stringField(request, "teamId"),
            allowedSiteIds: allowedSiteIds(request),
            interval:
              typeof request.interval === "string"
                ? (request.interval as never)
                : undefined,
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          }),
        };
      }),
    )
    .register(
      "dimension",
      typedQueryProvider<BreakdownResult>(async (input) => {
        const request = query(input!);
        return {
          value: await readTeamBreakdown({
            env: options.env,
            teamId: stringField(request, "teamId"),
            allowedSiteIds: allowedSiteIds(request),
            dimension: stringField(request, "dimension"),
            limit: numberField(request, "limit", 20),
            window: timeWindow(request.time),
            filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
          }),
        };
      }),
    );

  return createAnalyticsQueryRuntime(registry);
}
