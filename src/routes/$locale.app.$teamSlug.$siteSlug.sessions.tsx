import { createFileRoute } from "@tanstack/react-router";

import { SessionsClientPage } from "@/components/dashboard/site-pages/sessions/sessions-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/sessions",
)({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.sessions.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, siteContext: c } = Route.useRouteContext();
  return (
    <SessionsClientPage
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
      pathname={buildSitePath(
        locale,
        c.activeTeam.slug,
        c.activeSite.slug,
        "sessions",
      )}
    />
  );
}
