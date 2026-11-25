import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  SettingsClientPage,
  siteConfigQueryOptions,
  siteSnippetQueryOptions,
} from "@/components/dashboard/site-pages/settings/settings-client-page";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { canManageTeam } from "@/lib/dashboard/permissions";
import {
  loadSiteConfigSnapshot,
  loadSiteSnippetSnapshot,
} from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/settings",
)({
  beforeLoad: ({ context }) => {
    const c = context.siteContext;
    if (!canManageTeam(c.activeTeam.membershipRole, c.user.systemRole))
      throw notFound();
  },
  loader: ({ context }) => {
    const c = context.siteContext;
    const siteId = c.activeSite.id;
    if (typeof window === "undefined")
      return {
        config: loadSiteConfigSnapshot({ data: { siteId } }).catch(() => null),
        snippet: loadSiteSnippetSnapshot({ data: { siteId } }).catch(
          () => null,
        ),
      };
    const queryClient = getBrowserQueryClient();
    void queryClient.prefetchQuery(
      siteConfigQueryOptions(c.user.id, siteId, null, true),
    );
    void queryClient.prefetchQuery(
      siteSnippetQueryOptions(c.user.id, siteId, null, true),
    );
    return { config: null, snippet: null };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.siteSettings.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, siteContext: c } = Route.useRouteContext();
  const { config, snippet } = Route.useLoaderData();
  return (
    <SettingsClientPage
      locale={locale}
      messages={messages}
      teamSlug={c.activeTeam.slug}
      activeTeamId={c.activeTeam.id}
      siteSlug={c.activeSite.slug}
      teams={c.teams.map((team) => ({
        id: team.id,
        slug: team.slug,
        name: team.name,
      }))}
      site={{
        id: c.activeSite.id,
        name: c.activeSite.name,
        domain: c.activeSite.domain,
        publicEnabled: c.activeSite.publicEnabled,
        publicSlug: c.activeSite.publicSlug,
      }}
      key={JSON.stringify([c.user.id, c.activeSite.id])}
      userId={c.user.id}
      deferredConfig={config}
      deferredSnippet={snippet}
    />
  );
}
