"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

import { AnalyticsTabs } from "@/components/dashboard/analytics-tabs";
import { DashboardQueryProvider } from "@/components/dashboard/dashboard-query-provider";
import { ShareHeader } from "@/components/dashboard/share-header";
import { PageTransition } from "@/components/page-transition";
import { publicDashboardSiteId } from "@/lib/dashboard/client-request";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";

interface ShareDashboardShellProps {
  locale: Locale;
  messages: AppMessages;
  slug: string;
  siteName: string;
  children: ReactNode;
}

const SHARE_TABS = [
  "overview",
  "pages",
  "referrers",
  "geo",
  "devices",
  "browsers",
  "performance",
] as const;

function shareTabHref(locale: Locale, slug: string, key: string): string {
  const base = `/${locale}/share/${encodeURIComponent(slug)}`;
  return key === "overview" ? base : `${base}/${key}`;
}

export function ShareDashboardShell({
  locale,
  messages,
  slug,
  siteName,
  children,
}: ShareDashboardShellProps) {
  const publicSiteId = publicDashboardSiteId(slug);
  const pathname = usePathname() || "";
  const isGeoRoute = pathname.endsWith("/geo");
  const rootClassName = isGeoRoute
    ? "flex h-svh min-h-0 flex-col bg-background text-foreground"
    : "min-h-svh bg-background text-foreground";
  const contentClassName = isGeoRoute
    ? "flex min-h-0 w-full min-w-0 flex-1 flex-col md:overflow-hidden [&>[data-page-transition]]:flex [&>[data-page-transition]]:h-full [&>[data-page-transition]]:min-h-0 [&>[data-page-transition]]:flex-1 [&>[data-page-transition]]:flex-col"
    : "mx-auto w-full max-w-[1400px] p-4 md:p-6";

  return (
    <DashboardQueryProvider
      scopeKey={publicSiteId}
      maxRangeDays={365}
      initialTimeZonePreference=""
    >
      <div className={rootClassName}>
        <div className="sticky top-0 z-20 shrink-0 border-b bg-background/92 backdrop-blur">
          <div className="p-3">
            <ShareHeader
              locale={locale}
              messages={messages}
              publicSiteId={publicSiteId}
              siteName={siteName}
            />
          </div>
          <div className="px-3">
            <AnalyticsTabs
              items={SHARE_TABS.map((key) => ({
                key,
                href: shareTabHref(locale, slug, key),
                label: messages.navigation[key],
              }))}
            />
          </div>
        </div>
        <main className={contentClassName}>
          <PageTransition>{children}</PageTransition>
        </main>
      </div>
    </DashboardQueryProvider>
  );
}
