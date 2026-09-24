import { createFileRoute } from "@tanstack/react-router";

import { PerformanceClientPage } from "@/components/dashboard/site-pages/performance/performance-client-page";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute(
  "/$locale/app/$teamSlug/$siteSlug/performance",
)({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.performance.title,
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
    <PerformanceClientPage
      locale={locale}
      messages={messages}
      siteId={c.activeSite.id}
    />
  );
}
