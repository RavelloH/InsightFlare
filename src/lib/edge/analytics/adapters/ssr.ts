import { createTypedQueryProviderRegistry } from "@/lib/edge/analytics/application/provider-registry";
import type { TeamDashboardQueryResult } from "@/lib/edge/analytics/providers/d1/internal/team";
import {
  readTeamDashboard,
  type ReadTeamDashboardInput,
} from "@/lib/edge/analytics/providers/d1/operations/team-dashboard";

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
