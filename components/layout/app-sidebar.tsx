"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Flame, Wallpaper, Beaker, Users, Settings, Globe2, Sun, Moon, FileText, Activity, Clock } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { useSidebar } from "./sidebar-context";

interface AppSidebarProps {
  locale: string;
  session: { userId: string; username: string; displayName: string; systemRole: string };
}

const sectionLabels: Record<string, Record<string, string>> = {
  analytics: { en: "Analytics", zh: "分析" },
  manage: { en: "Manage", zh: "管理" },
};

const navLabels: Record<string, Record<string, string>> = {
  overview: { en: "Overview", zh: "总览" },
  pages: { en: "Pages", zh: "页面" },
  realtime: { en: "Realtime", zh: "实时" },
  sessions: { en: "Sessions", zh: "会话" },
  precision: { en: "Precision", zh: "精准查询" },
  teams: { en: "Teams", zh: "团队" },
  settings: { en: "Settings", zh: "设置" },
};

const localeLabels: Record<string, string> = {
  en: "EN",
  zh: "中文",
};

const analyticsItems = [
  { id: "overview", icon: Wallpaper, path: "/app" },
  { id: "pages", icon: FileText, path: "/app/pages" },
  { id: "realtime", icon: Activity, path: "/app/realtime" },
  { id: "sessions", icon: Clock, path: "/app/sessions" },
  { id: "precision", icon: Beaker, path: "/app/precision" },
];

const manageItems = [
  { id: "teams", icon: Users, path: "/app/teams" },
  { id: "settings", icon: Settings, path: "/app/settings" },
];

export function AppSidebar({ locale, session }: AppSidebarProps) {
  const pathname = usePathname();
  const { mobileOpen, setMobileOpen } = useSidebar();
  const { theme, setTheme } = useTheme();

  function isActive(path: string): boolean {
    const fullPath = `/${locale}${path}`;
    if (path === "/app") {
      return pathname === fullPath || pathname === `/${locale}/app`;
    }
    return pathname.startsWith(fullPath);
  }

  function switchLocale() {
    const newLocale = locale === "en" ? "zh" : "en";
    const newPath = pathname.replace(`/${locale}`, `/${newLocale}`);
    document.cookie = `if_locale=${newLocale};path=/;max-age=31536000`;
    window.location.href = newPath;
  }

  function toggleTheme() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  const userInitial = (session.displayName || session.username || "U").charAt(0).toUpperCase();

  const sidebarContent = (
    <aside className="flex h-full w-64 flex-col bg-card border-r">
      {/* Logo */}
      <div className="flex h-16 items-center gap-2 border-b px-4">
        <Flame className="h-6 w-6 text-primary shrink-0" />
        <span className="font-[var(--font-display)] text-lg font-semibold text-foreground">
          InsightFlare
        </span>
      </div>

      {/* Navigation - scrollable middle section */}
      <div className="relative flex-1">
        <nav className="overflow-auto hide-scrollbar h-full px-3 pb-10">
          {/* Analytics section */}
          <p className="text-xs font-medium text-muted-foreground mb-2 mt-4 px-3">
            {sectionLabels.analytics[locale] ?? "Analytics"}
          </p>
          <div className="flex flex-col gap-0.5">
            {analyticsItems.map((item) => {
              const active = isActive(item.path);
              const label = navLabels[item.id]?.[locale] ?? item.id;
              return (
                <Link
                  key={item.id}
                  href={`/${locale}${item.path}`}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors",
                    active
                      ? "bg-def-200 text-foreground"
                      : "text-muted-foreground hover:bg-def-200 hover:text-foreground",
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" />
                  {label}
                </Link>
              );
            })}
          </div>

          {/* Manage section */}
          <p className="text-xs font-medium text-muted-foreground mb-2 mt-4 px-3">
            {sectionLabels.manage[locale] ?? "Manage"}
          </p>
          <div className="flex flex-col gap-0.5">
            {manageItems.map((item) => {
              const active = isActive(item.path);
              const label = navLabels[item.id]?.[locale] ?? item.id;
              return (
                <Link
                  key={item.id}
                  href={`/${locale}${item.path}`}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors",
                    active
                      ? "bg-def-200 text-foreground"
                      : "text-muted-foreground hover:bg-def-200 hover:text-foreground",
                  )}
                >
                  <item.icon className="h-5 w-5 shrink-0" />
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Gradient fade at bottom of nav area */}
        <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-8 bg-gradient-to-t from-card to-card/0" />
      </div>

      {/* Footer */}
      <div className="flex border-t">
        {/* Language switcher */}
        <button
          type="button"
          onClick={switchLocale}
          className="flex-1 h-12 flex items-center justify-center border-r text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer text-sm"
        >
          <Globe2 className="h-4 w-4 mr-1.5" />
          {localeLabels[locale] ?? locale}
        </button>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          className="flex-1 h-12 flex items-center justify-center border-r text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer text-sm"
        >
          <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
        </button>

        {/* User avatar initial */}
        <Link
          href={`/${locale}/app/settings`}
          onClick={() => setMobileOpen(false)}
          className="flex-1 h-12 flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer text-sm"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-def-200 text-xs font-semibold text-foreground">
            {userInitial}
          </span>
        </Link>
      </div>
    </aside>
  );

  return (
    <>
      {/* Desktop sidebar - always visible */}
      <div className="hidden md:block">
        {sidebarContent}
      </div>

      {/* Mobile sidebar - overlay pattern */}
      <div
        className={cn(
          "fixed inset-0 z-50 md:hidden transition-opacity duration-300",
          mobileOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        )}
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/50"
          onClick={() => setMobileOpen(false)}
        />

        {/* Sliding sidebar */}
        <div
          className={cn(
            "absolute top-0 left-0 h-full transition-transform duration-300 ease-in-out",
            mobileOpen ? "translate-x-0" : "-translate-x-64",
          )}
        >
          {sidebarContent}
        </div>
      </div>
    </>
  );
}
