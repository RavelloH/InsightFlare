import { createFileRoute } from "@tanstack/react-router";

import { UiGalleryShell } from "@/components/ui-gallery/ui-gallery-shell";

export const Route = createFileRoute("/$locale/ui")({
  head: () => ({
    meta: [{ name: "robots", content: "noindex,nofollow" }],
  }),
  component: UiGalleryShell,
});
