"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Users, Settings, Beaker } from "lucide-react";
import { cn } from "@/lib/utils";

interface MobileBottomNavProps {
  locale: string;
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
  precision: { en: "Precision", zh: "精准" },
};

export function MobileBottomNav({ locale }: MobileBottomNavProps) {
  const pathname = usePathname();

  function isActive(path: string): boolean {
    const fullPath = `/${locale}${path}`;
    if (path === "/app") {
      return pathname === fullPath;
    }
    return pathname.startsWith(fullPath);
  }

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 md:hidden h-16">
      {navItems.map((item) => {
        const active = isActive(item.path);
        const label = navLabels[item.id]?.[locale] ?? item.id;
        return (
          <Link
            key={item.id}
            href={`/${locale}${item.path}`}
            className={cn(
              "flex flex-col items-center gap-1 px-3 py-2 text-xs transition-colors",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <item.icon className="h-5 w-5" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
