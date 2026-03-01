"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Users, Settings, Beaker, PanelLeftClose, PanelLeft, Flame } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebar } from "./sidebar-context";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface AppSidebarProps {
  locale: string;
  session: { userId: string; username: string; displayName: string; systemRole: string };
}

const navItems = [
  { id: "dashboard", icon: BarChart3, path: "/app" },
  { id: "teams", icon: Users, path: "/app/teams" },
  { id: "settings", icon: Settings, path: "/app/settings" },
  { id: "precision", icon: Beaker, path: "/app/precision" },
];

const navLabels: Record<string, Record<string, string>> = {
  dashboard: { en: "Dashboard", zh: "仪表盘" },
  teams: { en: "Teams", zh: "团队" },
  settings: { en: "Settings", zh: "设置" },
  precision: { en: "Precision", zh: "精准查询" },
};

export function AppSidebar({ locale, session }: AppSidebarProps) {
  const pathname = usePathname();
  const { collapsed, setCollapsed } = useSidebar();

  function isActive(path: string): boolean {
    const fullPath = `/${locale}${path}`;
    if (path === "/app") {
      return pathname === fullPath || pathname === `/${locale}/app`;
    }
    return pathname.startsWith(fullPath);
  }

  return (
    <aside
      className={cn(
        "hidden md:flex flex-col border-r bg-sidebar transition-all duration-300 ease-in-out",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className={cn("flex h-14 items-center border-b px-4", collapsed ? "justify-center" : "gap-2")}>
        <Flame className="h-6 w-6 text-primary shrink-0" />
        {!collapsed && (
          <span className="font-[var(--font-display)] text-lg font-semibold text-foreground">
            InsightFlare
          </span>
        )}
      </div>

      <ScrollArea className="flex-1 py-2">
        <TooltipProvider delayDuration={0}>
          <nav className="flex flex-col gap-1 px-2">
            {navItems.map((item) => {
              const active = isActive(item.path);
              const label = navLabels[item.id]?.[locale] ?? item.id;
              const link = (
                <Link
                  key={item.id}
                  href={`/${locale}${item.path}`}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-sidebar-primary text-sidebar-primary-foreground"
                      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    collapsed && "justify-center px-2",
                  )}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
                  {!collapsed && label}
                </Link>
              );

              if (collapsed) {
                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                    <TooltipContent side="right">{label}</TooltipContent>
                  </Tooltip>
                );
              }
              return link;
            })}
          </nav>
        </TooltipProvider>
      </ScrollArea>

      <Separator />
      <div className="p-2">
        <Button
          variant="ghost"
          size="icon"
          className="w-full"
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </Button>
      </div>
    </aside>
  );
}
