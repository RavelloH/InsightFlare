import { createTypedQueryProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type { TeamDashboardQueryResult } from "@/lib/edge/analytics/composition/d1-provider";
import {
  readTeamDashboard,
  type ReadTeamDashboardInput,
} from "@/lib/edge/analytics/composition/d1-provider";

export type SsrTeamDashboardData = TeamDashboardQueryResult["data"];

/** Creates the registry used by server-rendered dashboard loaders. */
export function createSsrTeamDashboardProviderRegistry(
  input: ReadTeamDashboardInput,
) {
  return createTypedQueryProviderRegistry<SsrTeamDashboardData>(
    "team-dashboard",
    async () => {
      const dashboard = await readTeamDashboard(input);
      return { value: dashboard.data, source: dashboard.source };
    },
  );
}
