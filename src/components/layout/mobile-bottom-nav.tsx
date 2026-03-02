"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Activity, Clock, Settings, Globe2, Users, User, ArrowLeft, GanttChart } from "lucide-react";
import { cn } from "@/lib/utils";

interface MobileBottomNavProps {
  locale: string;
}

type NavMode = "team" | "site";

function parseNavContext(pathname: string, locale: string) {
  const appPrefix = `/${locale}/app`;
  const rest = pathname.startsWith(appPrefix) ? pathname.slice(appPrefix.length) : "";
  const segments = rest.split("/").filter(Boolean);

  if (segments.length === 0 || segments[0] === "settings") {
    return { mode: "team" as NavMode, teamId: null, siteId: null };
  }

  const teamId = segments[0];

  if (segments.length === 1 || segments[1] === "settings" || segments[1] === "members") {
    return { mode: "team" as NavMode, teamId, siteId: null };
  }

  return { mode: "site" as NavMode, teamId, siteId: segments[1] };
}

const navLabels: Record<string, Record<string, string>> = {
  sites: { en: "Sites", zh: "站点" },
  settings: { en: "Settings", zh: "设置" },
  members: { en: "Members", zh: "成员" },
  profile: { en: "Profile", zh: "我的" },
  overview: { en: "Overview", zh: "总览" },
  events: { en: "Events", zh: "事件" },
  realtime: { en: "Realtime", zh: "实时" },
  sessions: { en: "Sessions", zh: "会话" },
  back: { en: "Team", zh: "团队" },
};

export function MobileBottomNav({ locale }: MobileBottomNavProps) {
  const pathname = usePathname();
  const ctx = parseNavContext(pathname, locale);

  function isActive(fullPath: string): boolean {
    return pathname === fullPath;
  }

  function isStartsWith(fullPath: string): boolean {
    return pathname.startsWith(fullPath);
  }

  const teamItems: Array<{ id: string; icon: typeof Globe2; href: string; exact?: boolean }> = ctx.teamId
    ? [
        { id: "sites", icon: Globe2, href: `/${locale}/app/${ctx.teamId}`, exact: true },
        { id: "settings", icon: Settings, href: `/${locale}/app/${ctx.teamId}/settings` },
        { id: "members", icon: Users, href: `/${locale}/app/${ctx.teamId}/members` },
        { id: "profile", icon: User, href: `/${locale}/app/settings` },
      ]
    : [
        { id: "profile", icon: User, href: `/${locale}/app/settings` },
      ];

  const siteItems: Array<{ id: string; icon: typeof Globe2; href: string; exact?: boolean }> = ctx.teamId && ctx.siteId
    ? [
        { id: "overview", icon: LayoutDashboard, href: `/${locale}/app/${ctx.teamId}/${ctx.siteId}`, exact: true },
        { id: "realtime", icon: Activity, href: `/${locale}/app/${ctx.teamId}/${ctx.siteId}/realtime` },
        { id: "events", icon: GanttChart, href: `/${locale}/app/${ctx.teamId}/${ctx.siteId}/events` },
        { id: "sessions", icon: Clock, href: `/${locale}/app/${ctx.teamId}/${ctx.siteId}/sessions` },
        { id: "back", icon: ArrowLeft, href: `/${locale}/app/${ctx.teamId}` },
      ]
    : [];

  const items = ctx.mode === "site" ? siteItems : teamItems;

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-border bg-card md:hidden h-14">
      {items.map((item) => {
        const active = item.exact ? isActive(item.href) : isStartsWith(item.href);
        const label = navLabels[item.id]?.[locale] ?? item.id;
        return (
          <Link
            key={item.id}
            href={item.href}
            className={cn(
              "flex flex-col items-center gap-1 px-3 py-2 text-[10px] font-medium transition-colors",
              active ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <item.icon className="h-[22px] w-[22px]" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
