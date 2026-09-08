/**
 * D1 composition surface for private Goal definitions.
 *
 * The private definition reader and typed analytics providers share this
 * small composition module so every D1 site runtime exposes the same Goal
 * operations.
 */
import {
  type AnalyticsProviderRegistry,
  typedQueryProvider,
} from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { readSiteGoalSummary } from "@/lib/edge/analytics/providers/d1/operations/site-goal-summary";
import { readSiteGoalTimeseries } from "@/lib/edge/analytics/providers/d1/operations/site-goal-timeseries";

import type { D1SiteQueryRuntimeOptions, RuntimeQuery } from "./shared";

export {
  decodeGoalDefinitionCursor,
  handleGoal,
  queryGoalDefinition,
  queryGoalDefinitionsPage,
} from "@/lib/edge/analytics/providers/d1/internal/goals";

function query(input: RuntimeQuery | undefined): RuntimeQuery {
  if (!input) throw new Error("goal_query_missing");
  return input;
}

export function registerGoalProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteQueryRuntimeOptions,
): void {
  registry.register(
    "goal-summary",
    typedQueryProvider(async (input) => {
      const request = query(input as RuntimeQuery | undefined);
      const result = await readSiteGoalSummary({
        env: options.env,
        siteId: options.siteId,
        goalId: typeof request.goalId === "string" ? request.goalId : "",
        window: {
          startMs: request.time.range.startMs,
          endExclusiveMs: request.time.range.endExclusiveMs,
          nowMs: request.time.capturedAtMs,
          timeZone: request.time.reportingTimeZone,
        },
        filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
        scopedDataset: request.scopedDataset,
      });
      return { value: result };
    }),
  );
  registry.register(
    "goal-timeseries",
    typedQueryProvider(async (input) => {
      const request = query(input as RuntimeQuery | undefined);
      const result = await readSiteGoalTimeseries({
        env: options.env,
        siteId: options.siteId,
        goalId: typeof request.goalId === "string" ? request.goalId : "",
        interval: (typeof request.interval === "string"
          ? request.interval
          : "day") as never,
        window: {
          startMs: request.time.range.startMs,
          endExclusiveMs: request.time.range.endExclusiveMs,
          nowMs: request.time.capturedAtMs,
          timeZone: request.time.reportingTimeZone,
        },
        filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
        scopedDataset: request.scopedDataset,
      });
      return { value: result };
    }),
  );
}
