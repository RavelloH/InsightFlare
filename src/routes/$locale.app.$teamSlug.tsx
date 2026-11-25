import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/$locale/app/$teamSlug")({
  beforeLoad: ({ context, params }) => {
    const teamContext = context.bootstrapTeamContext;
    if (teamContext?.activeTeam.slug !== params.teamSlug) throw notFound();
    if (!teamContext) throw notFound();
    return { teamContext };
  },
  head: ({ match }) => {
    const title = match.context.teamContext?.activeTeam?.name;
    return { meta: title ? [{ title }] : [] };
  },
  component: Outlet,
});
