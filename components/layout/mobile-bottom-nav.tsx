"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FileText, Activity, Clock, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

interface MobileBottomNavProps {
  locale: string;
}

const navItems = [
  { id: "overview", icon: LayoutDashboard, path: "/app" },
  { id: "pages", icon: FileText, path: "/app/pages" },
  { id: "realtime", icon: Activity, path: "/app/realtime" },
  { id: "sessions", icon: Clock, path: "/app/sessions" },
  { id: "settings", icon: Settings, path: "/app/settings" },
];

const navLabels: Record<string, Record<string, string>> = {
  overview: { en: "Overview", zh: "总览" },
  pages: { en: "Pages", zh: "页面" },
  realtime: { en: "Realtime", zh: "实时" },
  sessions: { en: "Sessions", zh: "会话" },
  settings: { en: "Settings", zh: "设置" },
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
    <nav className="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-border bg-card md:hidden h-14">
      {navItems.map((item) => {
        const active = isActive(item.path);
        const label = navLabels[item.id]?.[locale] ?? item.id;
        return (
          <Link
            key={item.id}
            href={`/${locale}${item.path}`}
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
