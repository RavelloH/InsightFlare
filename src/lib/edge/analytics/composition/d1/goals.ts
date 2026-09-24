/**
 * D1 composition surface for private Goal definitions.
 *
 * The private definition reader and typed analytics providers share this
 * small composition module so every D1 site runtime exposes the same Goal
 * operations.
 */
import {
  type AnalyticsProviderRegistry,
  typedQueryProviderFor,
} from "@/lib/edge/analytics/application/provider-registry";
import { EMPTY_FILTER_DOCUMENT } from "@/lib/edge/analytics/contract";
import { readSiteGoalSummary } from "@/lib/edge/analytics/providers/d1/operations/site-goal-summary";
import { readSiteGoalTimeseries } from "@/lib/edge/analytics/providers/d1/operations/site-goal-timeseries";

import type { D1SiteRuntimeBindings } from "./shared";
export {
  archiveGoalDefinition,
  createGoalDefinition,
  decodeGoalDefinitionCursor,
  queryGoalDefinition,
  queryGoalDefinitionsPage,
  updateGoalDefinition,
} from "@/lib/edge/analytics/providers/d1/internal/goals";
export function registerGoalProviders(
  registry: AnalyticsProviderRegistry,
  options: D1SiteRuntimeBindings,
): void {
  registry.register(
    "goal-summary",
    typedQueryProviderFor("goal-summary", async (input) => {
      if (!input || !input.time) throw new Error("goal_query_missing");
      const request = input;
      const result = await readSiteGoalSummary({
        env: options.env,
        siteId: options.siteId,
        goalId: request.goalId ?? "",
        window: {
          startMs: request.time.range.startMs,
          endExclusiveMs: request.time.range.endExclusiveMs,
          nowMs: request.time.capturedAtMs,
          timeZone: request.time.reportingTimeZone,
        },
        filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
      });
      return { value: result };
    }),
  );
  registry.register(
    "goal-timeseries",
    typedQueryProviderFor("goal-timeseries", async (input) => {
      if (!input || !input.time) throw new Error("goal_query_missing");
      const request = input;
      const result = await readSiteGoalTimeseries({
        env: options.env,
        siteId: options.siteId,
        goalId: request.goalId ?? "",
        interval: request.interval ?? "day",
        window: {
          startMs: request.time.range.startMs,
          endExclusiveMs: request.time.range.endExclusiveMs,
          nowMs: request.time.capturedAtMs,
          timeZone: request.time.reportingTimeZone,
        },
        filters: request.filters ?? EMPTY_FILTER_DOCUMENT,
      });
      return { value: result };
    }),
  );
}
