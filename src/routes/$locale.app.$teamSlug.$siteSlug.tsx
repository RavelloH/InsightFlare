import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { dashboardSiteContext } from "@/lib/dashboard/site-context";

export const Route = createFileRoute("/$locale/app/$teamSlug/$siteSlug")({
  beforeLoad: ({ params, context }) => {
    const siteContext = dashboardSiteContext(
      context.teamContext,
      params.siteSlug,
    );
    if (!siteContext) throw notFound();
    return { siteContext };
  },
  head: ({ match }) => ({
    meta: [{ title: match.context.siteContext.activeSite.name }],
  }),
  component: Outlet,
});
