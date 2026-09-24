import { createFileRoute } from "@tanstack/react-router";

import { RetentionClientPage } from "@/components/dashboard/site-pages/retention/retention-client-page";
import { buildSitePath } from "@/lib/dashboard/paths";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/retention",
)({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.retention.title,
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
    <RetentionClientPage
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
      pathname={buildSitePath(
        locale,
        c.activeTeam.slug,
        c.activeSite.slug,
        "retention",
      )}
    />
  );
}
