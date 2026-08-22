import { createFileRoute, notFound } from "@tanstack/react-router";

import { SystemPerformanceClient } from "@/components/dashboard/system-performance-client";
import { loadSystemPerformanceInitialData } from "@/lib/dashboard/route-data";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/manage/system-performance")({
  beforeLoad: async ({ context }) => {
    if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
    return {
      systemPerformanceInitialData: await loadSystemPerformanceInitialData(),
    };
  },
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.systemPerformance.title,
          match.context,
        ),
      },
    ],
  }),
  component: Page,
});
function Page() {
  const { locale, messages, systemPerformanceInitialData } =
    Route.useRouteContext();
  return (
    <SystemPerformanceClient
      locale={locale}
      messages={messages}
      initialData={systemPerformanceInitialData}
    />
  );
}
