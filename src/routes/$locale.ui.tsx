import { createFileRoute } from "@tanstack/react-router";

import { UiGalleryShell } from "@/components/ui-gallery/ui-gallery-shell";
import { dashboardPageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/$locale/ui")({
  head: ({ match }) => ({
    meta: [
      {
        title: dashboardPageTitle(
          match.context.messages.uiGallery.pageTitle,
          {},
        ),
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: UiGalleryShell,
});
