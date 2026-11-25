import type { JSX } from "react";
import {
  createFileRoute,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";

import { DashboardShell } from "@/components/dashboard/shell/dashboard-shell";
import { createBootstrapHandoff } from "@/lib/dashboard/bootstrap-handoff";
import { loadDashboardBootstrap } from "@/lib/dashboard/route-data";
import type {
  DashboardContext,
  DashboardTeamContext,
} from "@/lib/dashboard/server";
import { buildManagementSections } from "@/lib/dashboard/team-sections";
import { usePathname } from "@/lib/router";
const handoff =
  createBootstrapHandoff<Awaited<ReturnType<typeof loadDashboardBootstrap>>>();
// Keep this callback independent of the globally registered route union:
// the root route itself is part of that union.
async function bootstrapRoute(
  options: unknown,
): Promise<Awaited<ReturnType<typeof loadDashboardBootstrap>>> {
  const { matches, preload, location } = options as {
    matches: Array<{ routeId: string; params: Record<string, unknown> }>;
    preload: boolean;
    location: { href: string };
  };
  const teamMatch = matches.find(
    (match) => match.routeId === "/$locale/app/$teamSlug",
  );
  const page = matches.some((match) => match.routeId === "/$locale/app/")
    ? "workspace"
    : matches.some((match) => match.routeId === "/$locale/app/$teamSlug/")
      ? "team"
      : undefined;
  const read = () =>
    loadDashboardBootstrap({
      data: {
        teamSlug:
          typeof teamMatch?.params.teamSlug === "string"
            ? teamMatch.params.teamSlug
            : undefined,
        page,
      },
    });
  // Server requests must never share data across users. Use an exact
  // destination and cookie state; never reuse a consumed result.
  if (typeof document === "undefined") return read();
  return handoff(
    JSON.stringify([location.href, document.cookie]),
    preload,
    read,
  );
}
export const Route = createFileRoute("/$locale/app")({
  beforeLoad: bootstrapRoute,
  component: AppLayout,
});
function AppLayout(): JSX.Element {
  const { locale, messages, dashboardRoot, initialDashboardWindow } =
    Route.useRouteContext();
  const pathname = usePathname();
  const teamRouteContext = useRouterState({
    select: ({ matches }) =>
      matches.find((match) => match.routeId === "/$locale/app/$teamSlug")
        ?.context as { teamContext?: DashboardTeamContext } | undefined,
  });
  const teamContext = teamRouteContext?.teamContext;
  const siteRouteContext = useRouterState({
    select: ({ matches }) =>
      matches.find(
        (match) => match.routeId === "/$locale/app/$teamSlug/$siteSlug",
      )?.context as { siteContext?: DashboardContext } | undefined,
  });
  const authorizedActiveSite = siteRouteContext?.siteContext?.activeSite;

  const shellContext = dashboardRoot ?? teamContext;
  if (!shellContext) return <Outlet />;
  return (
    <DashboardShell
      locale={locale}
      pathname={pathname}
      messages={messages}
      user={shellContext.user}
      teams={shellContext.teams}
      teamGroups={shellContext.teamGroups}
      activeTeamSlug={teamContext?.activeTeam.slug}
      authorizedActiveSite={authorizedActiveSite}
      sites={teamContext?.sites}
      unreadAttentionCount={shellContext.unreadAttentionCount}
      initialQueryWindow={initialDashboardWindow}
      managementSections={
        shellContext.user.systemRole === "admin"
          ? buildManagementSections(locale, messages)
          : undefined
      }
    >
      <Outlet />
    </DashboardShell>
  );
}
