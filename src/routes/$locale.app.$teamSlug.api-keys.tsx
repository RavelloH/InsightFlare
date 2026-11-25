import { createFileRoute, notFound } from "@tanstack/react-router";

import {
  ApiKeysClient,
  apiKeysQueryOptions,
} from "@/components/dashboard/admin/api-keys-client";
import { getBrowserQueryClient } from "@/components/query-client-provider";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { loadApiKeysInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/api-keys")({
  beforeLoad: ({ context }) => {
    const c = context.teamContext;
    if (!canManageTeam(c.activeTeam.membershipRole, c.user.systemRole))
      throw notFound();
  },
  loader: ({ context }) => {
    const teamId = context.teamContext.activeTeam.id;
    if (typeof window === "undefined")
      return {
        deferred: loadApiKeysInitialData({ data: { teamId } }).catch(
          () => null,
        ),
      };
    void getBrowserQueryClient().prefetchQuery(
      apiKeysQueryOptions(context.teamContext.user.id, teamId, null, true),
    );
    return { deferred: null };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamManagement.apiKeys.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, teamContext: c } = Route.useRouteContext();
  const { deferred } = Route.useLoaderData();
  return (
    <ApiKeysClient
      key={JSON.stringify([c.user.id, c.activeTeam.id])}
      locale={locale}
      messages={messages}
      userId={c.user.id}
      teamId={c.activeTeam.id}
      sites={c.sites.map((site) => ({
        id: site.id,
        name: site.name,
        domain: site.domain,
      }))}
      deferredData={deferred}
    />
  );
}
