import { createFileRoute, notFound } from "@tanstack/react-router";

import { RequestObservationClient } from "@/components/dashboard/admin/request-observation/client";
import { dashboardPageTitle } from "@/lib/page-title";
export const Route = createFileRoute("/$locale/app/manage/request-observation")(
  {
    beforeLoad: ({ context }) => {
      if (context.dashboardRoot?.user.systemRole !== "admin") throw notFound();
    },
    head: ({ match }) => ({
      meta: [
        {
          title: dashboardPageTitle(
            match.context.messages.requestObservation.title,
            match.context,
          ),
        },
      ],
    }),
    component: Page,
  },
);
function Page() {
  const { locale, messages } = Route.useRouteContext();
  return <RequestObservationClient locale={locale} messages={messages} />;
}
