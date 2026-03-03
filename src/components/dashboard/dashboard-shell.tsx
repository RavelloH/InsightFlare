import Link from "next/link";
import type { ReactNode } from "react";
import type { TeamData } from "@/lib/edge-client";
import type { SiteWithSlug } from "@/lib/dashboard/server";
import { buildSitePath } from "@/lib/dashboard/server";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";

interface DashboardShellProps {
  locale: Locale;
  pathname: string;
  messages: AppMessages;
  teams: TeamData[];
  activeTeamSlug: string;
  sites: SiteWithSlug[];
  activeSiteSlug: string;
  children: ReactNode;
}

function normalizeLocalePath(pathname: string): string {
  const cleaned = pathname || "";
  if (cleaned.length === 0) return "/app";
  const withoutLocale = cleaned.replace(/^\/(en|zh)(?=\/|$)/, "") || "/app";
  if (withoutLocale === "/") return "/app";
  return withoutLocale.endsWith("/") ? withoutLocale.slice(0, -1) : withoutLocale;
}

export function DashboardShell({
  locale,
  pathname,
  messages,
  teams,
  activeTeamSlug,
  sites,
  activeSiteSlug,
  children,
}: DashboardShellProps) {
  const activeSiteBase = buildSitePath(locale, activeTeamSlug, activeSiteSlug);
  const normalizedPathname = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

  const sections: Array<{
    key:
      | "overview"
      | "pages"
      | "referrers"
      | "sessions"
      | "events"
      | "visitors"
      | "geo"
      | "devices"
      | "browsers";
    href: string;
  }> = [
    { key: "overview", href: activeSiteBase },
    { key: "pages", href: `${activeSiteBase}/pages` },
    { key: "referrers", href: `${activeSiteBase}/referrers` },
    { key: "sessions", href: `${activeSiteBase}/sessions` },
    { key: "events", href: `${activeSiteBase}/events` },
    { key: "visitors", href: `${activeSiteBase}/visitors` },
    { key: "geo", href: `${activeSiteBase}/geo` },
    { key: "devices", href: `${activeSiteBase}/devices` },
    { key: "browsers", href: `${activeSiteBase}/browsers` },
  ];

  const localeSuffix = normalizeLocalePath(pathname);
  const switchToEn = `/en${localeSuffix}`;
  const switchToZh = `/zh${localeSuffix}`;

  return (
    <SidebarProvider>
      <Sidebar variant="inset" collapsible="icon">
        <SidebarHeader>
          <div className="px-2 py-2">
            <p className="text-xs text-muted-foreground">{messages.appName}</p>
            <p className="text-sm font-semibold">{messages.common.site}</p>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>{messages.common.team}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {teams.map((team) => {
                  const href = `/${locale}/app/${team.slug}`;
                  return (
                    <SidebarMenuItem key={team.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={team.slug === activeTeamSlug}
                        tooltip={team.name}
                      >
                        <Link href={href}>
                          <span>{team.name}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          <SidebarGroup>
            <SidebarGroupLabel>{messages.common.site}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {sites.map((site) => (
                  <SidebarMenuItem key={site.id}>
                    <SidebarMenuButton
                      asChild
                      isActive={site.slug === activeSiteSlug}
                      tooltip={site.name}
                    >
                      <Link href={buildSitePath(locale, activeTeamSlug, site.slug)}>
                        <span>{site.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          <SidebarSeparator />

          <SidebarGroup>
            <SidebarGroupLabel>Analytics</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {sections.map((item) => {
                  const isActive =
                    item.key === "overview"
                      ? normalizedPathname === item.href
                      : normalizedPathname.startsWith(item.href);
                  return (
                    <SidebarMenuItem key={item.key}>
                      <SidebarMenuButton asChild isActive={isActive}>
                        <Link href={item.href}>
                          <span>{messages.navigation[item.key]}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <div className="p-2 pb-0">
            <ThemeToggle
              lightLabel={messages.actions.switchToLight}
              darkLabel={messages.actions.switchToDark}
              className="w-full"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 p-2">
            <Button variant={locale === "en" ? "default" : "outline"} size="sm" asChild>
              <Link href={switchToEn}>{messages.actions.switchToEnglish}</Link>
            </Button>
            <Button variant={locale === "zh" ? "default" : "outline"} size="sm" asChild>
              <Link href={switchToZh}>{messages.actions.switchToChinese}</Link>
            </Button>
          </div>
          <form action="/api/auth/logout" method="post" className="p-2 pt-0">
            <Button type="submit" variant="outline" size="sm" className="w-full">
              {messages.actions.logout}
            </Button>
          </form>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <div className="sticky top-0 z-20 border-b bg-background/90 p-3 backdrop-blur">
          <SidebarTrigger />
        </div>
        <div className="mx-auto w-full max-w-[1400px] p-4 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
