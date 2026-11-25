import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { isValidLocale } from "@/lib/i18n/config";
import { getRuntimeMessages } from "@/lib/i18n/runtime-messages";

export const Route = createFileRoute("/$locale")({
  // Route context is reconstructed on both server and hydration. The static
  // dictionary must not be transported in beforeLoad's serialized payload.
  context: ({ params }) => {
    if (!isValidLocale(params.locale)) throw notFound();
    return {
      locale: params.locale,
      messages: getRuntimeMessages(params.locale),
    };
  },
  component: Outlet,
});
