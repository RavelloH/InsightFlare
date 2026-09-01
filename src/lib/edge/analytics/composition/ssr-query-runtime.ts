import { AnalyticsProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import { createAnalyticsQueryRuntime } from "@/lib/edge/analytics/composition/query-runtime";
import type {
  AnalyticsResult,
  QueryInput,
} from "@/lib/edge/analytics/contract";
import {
  readTeamDashboard,
  type ReadTeamDashboardInput,
  resolveTeamDashboardScope,
} from "@/lib/edge/analytics/providers/d1/operations/team-dashboard";

export interface SsrTeamDashboardRuntimeInput extends Omit<
  ReadTeamDashboardInput,
  "window"
> {
  readonly window: ReadTeamDashboardInput["window"];
}

/**
 * Composition root for the server-rendered team dashboard. The route only
 * supplies canonical query data; the concrete D1 dashboard provider stays in
 * composition.
 */
export function createTeamDashboardQueryRuntime(
  input: SsrTeamDashboardRuntimeInput,
) {
  const registry = new AnalyticsProviderRegistry().register("team-dashboard", {
    execute: async (query: QueryInput) => {
      const dashboard = await readTeamDashboard({
        ...input,
        window: input.window,
        filters: query.filters,
      });
      return {
        value: dashboard.data,
        source: dashboard.source,
      };
    },
  });
  return createAnalyticsQueryRuntime(registry);
}

/** @deprecated Prefer the source-neutral team dashboard runtime name. */
export const createSsrTeamDashboardQueryRuntime =
  createTeamDashboardQueryRuntime;

export type SsrTeamDashboardData = Awaited<
  ReturnType<typeof readTeamDashboard>
>["data"];
export type SsrTeamDashboardResult = AnalyticsResult<SsrTeamDashboardData>;

/** Composition-only access to the authenticated dashboard scope resolver. */
export { resolveTeamDashboardScope };
