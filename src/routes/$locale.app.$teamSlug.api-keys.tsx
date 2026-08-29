import { createFileRoute, notFound } from "@tanstack/react-router";

import { ApiKeysClient } from "@/components/dashboard/api-keys-client";
import { canManageTeam } from "@/lib/dashboard/permissions";
import { loadApiKeysInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/api-keys")({
  beforeLoad: async ({ context }) => {
    const c = context.teamContext;
    if (!canManageTeam(c.activeTeam.membershipRole, c.user.systemRole))
      throw notFound();
    return {
      apiKeysInitialData: await loadApiKeysInitialData({
        data: { teamId: c.activeTeam.id },
      }),
    };
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
  const {
    locale,
    messages,
    teamContext: c,
    apiKeysInitialData,
  } = Route.useRouteContext();
  return (
    <ApiKeysClient
      locale={locale}
      messages={messages}
      teamId={c.activeTeam.id}
      sites={c.sites.map((site) => ({
        id: site.id,
        name: site.name,
        domain: site.domain,
      }))}
      initialData={apiKeysInitialData}
    />
  );
}
