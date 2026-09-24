import { createFileRoute } from "@tanstack/react-router";

import { PerformanceClientPage } from "@/components/dashboard/site-pages/performance/performance-client-page";
export const Route = createFileRoute("/$locale/share/$slug/performance")({
  component: Page,
});
function Page() {
  const { locale, messages, shareContext: c } = Route.useRouteContext();
  return (
    <PerformanceClientPage
      locale={locale}
      messages={messages}
      siteId={c.publicSiteId}
    />
  );
}
