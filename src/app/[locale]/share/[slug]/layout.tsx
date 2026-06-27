import type { ReactNode } from "react";
import type { Metadata } from "next";

import { ShareDashboardShell } from "@/components/dashboard/share-dashboard-shell";

import { getShareRouteContext } from "./share-utils";

interface ShareLayoutProps {
  children: ReactNode;
  params: Promise<{
    locale: string;
    slug: string;
  }>;
}

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default async function ShareLayout({
  children,
  params,
}: ShareLayoutProps) {
  const { locale, slug } = await params;
  const context = await getShareRouteContext(locale, slug);

  return (
    <ShareDashboardShell
      locale={context.locale}
      messages={context.messages}
      slug={slug}
      siteName={context.site.name}
    >
      {children}
    </ShareDashboardShell>
  );
}
