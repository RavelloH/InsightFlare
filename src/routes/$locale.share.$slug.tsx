import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { ShareDashboardShell } from "@/components/dashboard/sharing/share-dashboard-shell";
import { loadShareSite } from "@/lib/dashboard/route-data";

export const Route = createFileRoute("/$locale/share/$slug")({
  beforeLoad: async ({ params }) => {
    const shareContext = await loadShareSite({ data: { slug: params.slug } });
    if (!shareContext) throw notFound();
    return { shareContext };
  },
  head: () => ({ meta: [{ name: "robots", content: "noindex, nofollow" }] }),
  component: Layout,
});
function Layout() {
  const { locale, messages, shareContext } = Route.useRouteContext();
  const { slug } = Route.useParams();
  return (
    <ShareDashboardShell
      locale={locale}
      messages={messages}
      slug={slug}
      siteName={shareContext.site.name}
    >
      <Outlet />
    </ShareDashboardShell>
  );
}
