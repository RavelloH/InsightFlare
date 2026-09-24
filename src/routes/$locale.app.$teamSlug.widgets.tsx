import { RiHammerLine } from "@remixicon/react";
import { createFileRoute } from "@tanstack/react-router";

import { PageHeading } from "@/components/dashboard/common/page-heading";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/app/$teamSlug/widgets")({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.teamManagement.widgets.title,
          match.context,
        ),
      },
    ],
  }),
  component: WidgetsPage,
});

function WidgetsPage() {
  const copy = Route.useRouteContext().messages.teamManagement.widgets;
  return (
    <div className="space-y-4">
      <PageHeading title={copy.title} subtitle={copy.subtitle} />
      <div className="flex min-h-72 items-center justify-center border-y border-dashed">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="flex size-12 items-center justify-center border bg-muted/30 text-muted-foreground">
            <RiHammerLine className="size-5" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium">{copy.underConstruction}</p>
        </div>
      </div>
    </div>
  );
}
