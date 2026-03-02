"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Flame,
  Wallpaper,
  Beaker,
  Users,
  Settings,
  Globe2,
  Sun,
  Moon,
  FileText,
  Activity,
  Clock,
  ArrowLeft,
  User,
} from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { useSidebar } from "./sidebar-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TeamData } from "@/lib/edge-client";

interface AppSidebarProps {
  locale: string;
  session: { userId: string; username: string; displayName: string; systemRole: string };
  teams: TeamData[];
}

type SidebarMode = "root" | "team" | "site";

interface SidebarContext {
  mode: SidebarMode;
  teamId: string | null;
  siteId: string | null;
}

function parseSidebarContext(pathname: string, locale: string): SidebarContext {
  const appPrefix = `/${locale}/app`;
  const rest = pathname.startsWith(appPrefix) ? pathname.slice(appPrefix.length) : "";
  const segments = rest.split("/").filter(Boolean);

  // /app or /app/settings → root/personal mode
  if (segments.length === 0 || segments[0] === "settings") {
    return { mode: "root", teamId: null, siteId: null };
  }

  const teamId = segments[0];

  // /app/[teamId] or /app/[teamId]/settings or /app/[teamId]/members → team mode
  if (segments.length === 1 || segments[1] === "settings" || segments[1] === "members") {
    return { mode: "team", teamId, siteId: null };
  }

  // /app/[teamId]/[siteId]/... → site mode
  const siteId = segments[1];
  return { mode: "site", teamId, siteId };
}

const sectionLabels: Record<string, Record<string, string>> = {
  team: { en: "Team", zh: "团队" },
  analytics: { en: "Analytics", zh: "分析" },
};

const navLabels: Record<string, Record<string, string>> = {
  sites: { en: "Sites", zh: "站点" },
  teamSettings: { en: "Team Settings", zh: "团队设置" },
  members: { en: "Members", zh: "成员" },
  personalSettings: { en: "Personal Settings", zh: "个人设置" },
  backToTeam: { en: "Back to team", zh: "返回团队" },
  overview: { en: "Overview", zh: "总览" },
  pages: { en: "Pages", zh: "页面" },
  realtime: { en: "Realtime", zh: "实时" },
  sessions: { en: "Sessions", zh: "会话" },
  precision: { en: "Precision", zh: "精准查询" },
};

const localeLabels: Record<string, string> = {
  en: "EN",
  zh: "中文",
};

export function AppSidebar({ locale, session, teams }: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { mobileOpen, setMobileOpen } = useSidebar();
  const { theme, setTheme } = useTheme();

  const ctx = parseSidebarContext(pathname, locale);
  const label = (key: string) => navLabels[key]?.[locale] ?? key;

  function isActive(path: string): boolean {
    const fullPath = `/${locale}${path}`;
    return pathname === fullPath || (path !== `/app/${ctx.teamId}` && pathname.startsWith(fullPath));
  }

  function isExactActive(path: string): boolean {
    return pathname === `/${locale}${path}`;
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

  function handleTeamSwitch(newTeamId: string) {
    setMobileOpen(false);
    router.push(`/${locale}/app/${newTeamId}`);
  }

  const userInitial = (session.displayName || session.username || "U").charAt(0).toUpperCase();

  // Team-level nav items
  const teamNavItems = ctx.teamId
    ? [
        { id: "sites", icon: Globe2, path: `/app/${ctx.teamId}`, exact: true },
        { id: "teamSettings", icon: Settings, path: `/app/${ctx.teamId}/settings` },
        { id: "members", icon: Users, path: `/app/${ctx.teamId}/members` },
        { id: "personalSettings", icon: User, path: "/app/settings" },
      ]
    : [{ id: "personalSettings", icon: User, path: "/app/settings" }];

  // Site-level nav items
  const siteNavItems =
    ctx.teamId && ctx.siteId
      ? [
          { id: "overview", icon: Wallpaper, path: `/app/${ctx.teamId}/${ctx.siteId}`, exact: true },
          { id: "pages", icon: FileText, path: `/app/${ctx.teamId}/${ctx.siteId}/pages` },
          { id: "realtime", icon: Activity, path: `/app/${ctx.teamId}/${ctx.siteId}/realtime` },
          { id: "sessions", icon: Clock, path: `/app/${ctx.teamId}/${ctx.siteId}/sessions` },
          { id: "precision", icon: Beaker, path: `/app/${ctx.teamId}/${ctx.siteId}/precision` },
        ]
      : [];

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
          {ctx.mode === "site" ? (
            <>
              {/* Back to team link */}
              <Link
                href={`/${locale}/app/${ctx.teamId}`}
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 rounded-md px-3 py-2 mt-3 mb-1 text-[13px] font-medium text-muted-foreground hover:bg-def-200 hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-4 w-4 shrink-0" />
                {label("backToTeam")}
              </Link>

              {/* Analytics section */}
              <p className="text-xs font-medium text-muted-foreground mb-2 mt-3 px-3">
                {sectionLabels.analytics[locale] ?? "Analytics"}
              </p>
              <div className="flex flex-col gap-0.5">
                {siteNavItems.map((item) => {
                  const active = item.exact ? isExactActive(item.path) : isActive(item.path);
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
                      {label(item.id)}
                    </Link>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {/* Team switcher */}
              {teams.length > 0 && (
                <div className="mt-3 px-1">
                  <Select
                    value={ctx.teamId || teams[0]?.id || ""}
                    onValueChange={handleTeamSwitch}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={locale === "zh" ? "选择团队" : "Select team"} />
                    </SelectTrigger>
                    <SelectContent>
                      {teams.map((team) => (
                        <SelectItem key={team.id} value={team.id}>
                          {team.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Team section */}
              <p className="text-xs font-medium text-muted-foreground mb-2 mt-4 px-3">
                {sectionLabels.team[locale] ?? "Team"}
              </p>
              <div className="flex flex-col gap-0.5">
                {teamNavItems.map((item) => {
                  const active = item.exact ? isExactActive(item.path) : isActive(item.path);
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
                      {label(item.id)}
                    </Link>
                  );
                })}
              </div>
            </>
          )}
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
