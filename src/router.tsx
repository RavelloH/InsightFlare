import { createRouter } from "@tanstack/react-router";

import { preloadPathMessages } from "@/lib/i18n/runtime-messages";
import { ErrorPage, NotFoundPage } from "@/routes/__root";
import { routeTree } from "@/routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    // Hydration reconstructs route context without rerunning beforeLoad.
    hydrate: async () => {
      if (typeof window !== "undefined")
        await preloadPathMessages(window.location.pathname);
    },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultNotFoundComponent: NotFoundPage,
    defaultErrorComponent: ErrorPage,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
