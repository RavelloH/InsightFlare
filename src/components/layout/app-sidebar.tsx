"use client";

import { useEffect } from "react";
import type { ComponentType } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RiArrowLeftLine as ArrowLeft, RiBookOpenLine as BookOpen, RiFileTextLine as FileText, RiFireLine as Flame, RiBarChartGroupedLine as GanttChart, RiGlobalLine as Globe2, RiDashboardLine as LayoutDashboard, RiPulseLine as Activity, RiSettings3Line as Settings, RiTeamLine as Users, RiAccountCircle2Line as UserCircle2, RiComputerLine as Monitor, RiMoonLine as Moon, RiSunLine as Sun } from "@remixicon/react";
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
  session: {
    userId: string;
    username: string;
    displayName: string;
    systemRole: string;
  };
  teams: TeamData[];
}

type SidebarMode = "root" | "team" | "site";

interface SidebarContext {
  mode: SidebarMode;
  teamId: string | null;
  siteId: string | null;
}

type ThemeMode = "light" | "dark" | "system";

function parseSidebarContext(pathname: string, locale: string): SidebarContext {
  const appPrefix = `/${locale}/app`;
  const rest = pathname.startsWith(appPrefix)
    ? pathname.slice(appPrefix.length)
    : "";
  const segments = rest.split("/").filter(Boolean);

  if (segments.length === 0 || segments[0] === "settings") {
    return { mode: "root", teamId: null, siteId: null };
  }

  const teamId = segments[0];

  if (
    segments.length === 1 ||
    segments[1] === "settings" ||
    segments[1] === "members"
  ) {
    return { mode: "team", teamId, siteId: null };
  }

  return { mode: "site", teamId, siteId: segments[1] };
}

const sectionLabels: Record<string, Record<string, string>> = {
  analytics: { en: "Analytics", zh: "分析" },
  manage: { en: "Manage", zh: "管理" },
  workspace: { en: "Workspace", zh: "工作区" },
};

const navLabels: Record<string, Record<string, string>> = {
  sites: { en: "Sites", zh: "站点" },
  teamSettings: { en: "Team Settings", zh: "团队设置" },
  siteSettings: { en: "Site Settings", zh: "站点设置" },
  members: { en: "Members", zh: "成员" },
  personalSettings: { en: "Personal Settings", zh: "个人设置" },
  backToTeam: { en: "Back to workspace", zh: "返回工作区" },
  overview: { en: "Overview", zh: "总览" },
  pages: { en: "Pages", zh: "页面" },
  realtime: { en: "Realtime", zh: "实时" },
  sessions: { en: "Sessions", zh: "会话" },
  precision: { en: "Precision", zh: "精准查询" },
  events: { en: "Events", zh: "事件" },
  profiles: { en: "Profiles", zh: "访客" },
};

const localeLabels: Record<string, string> = {
  en: "EN",
  zh: "中文",
};

interface SidebarLinkItem {
  id: string;
  icon: ComponentType<{ className?: string }>;
  path: string;
  exact?: boolean;
}

function SidebarNavLink({
  locale,
  pathname,
  item,
  onNavigate,
}: {
  locale: string;
  pathname: string;
  item: SidebarLinkItem;
  onNavigate: () => void;
}) {
  const fullPath = `/${locale}${item.path}`;
  const active = item.exact
    ? pathname === fullPath
    : pathname === fullPath || pathname.startsWith(`${fullPath}/`);

  return (
    <Link
      href={fullPath}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium transition-colors",
        active
          ? "bg-def-200 text-foreground"
          : "text-muted-foreground hover:bg-def-200 hover:text-foreground",
      )}
    >
      <item.icon className="h-5 w-5 shrink-0" />
      <span className="flex-1 truncate">
        {navLabels[item.id]?.[locale] ?? item.id}
      </span>
    </Link>
  );
}

export function AppSidebar({ locale, session, teams }: AppSidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { mobileOpen, setMobileOpen } = useSidebar();
  const { theme, setTheme } = useTheme();

  const ctx = parseSidebarContext(pathname, locale);
  const navTeamId = ctx.teamId ?? teams[0]?.id ?? null;
  const currentTeamId = navTeamId ?? "";
  const currentTeam = teams.find((team) => team.id === currentTeamId);
  const userInitial = (session.displayName || session.username || "U")
    .charAt(0)
    .toUpperCase();
  const themeMode: ThemeMode =
    theme === "dark" || theme === "light" || theme === "system"
      ? theme
      : "system";
  const themeLabels: Record<ThemeMode, string> =
    locale === "zh"
      ? { system: "跟随系统", light: "浅色", dark: "深色" }
      : { system: "System", light: "Light", dark: "Dark" };
  const themeIcons: Record<ThemeMode, ComponentType<{ className?: string }>> = {
    system: Monitor,
    light: Sun,
    dark: Moon,
  };
  const CurrentThemeIcon = themeIcons[themeMode];

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname, setMobileOpen]);

  function switchLocale() {
    const newLocale = locale === "en" ? "zh" : "en";
    const newPath = pathname.replace(
      new RegExp(`^/${locale}(?=/|$)`),
      `/${newLocale}`,
    );
    const query = searchParams.toString();
    document.cookie = `if_locale=${newLocale};path=/;max-age=31536000`;
    router.replace(query ? `${newPath}?${query}` : newPath);
  }

  function handleTeamSwitch(newTeamId: string) {
    setMobileOpen(false);
    router.push(`/${locale}/app/${newTeamId}`);
  }

  const teamNavItems: SidebarLinkItem[] = navTeamId
    ? [
        { id: "sites", icon: Globe2, path: `/app/${navTeamId}`, exact: true },
        {
          id: "teamSettings",
          icon: Settings,
          path: `/app/${navTeamId}/settings`,
        },
        { id: "personalSettings", icon: UserCircle2, path: "/app/settings" },
      ]
    : [{ id: "personalSettings", icon: UserCircle2, path: "/app/settings" }];

  const siteAnalyticsItems: SidebarLinkItem[] =
    ctx.teamId && ctx.siteId
      ? [
          {
            id: "overview",
            icon: LayoutDashboard,
            path: `/app/${ctx.teamId}/${ctx.siteId}`,
            exact: true,
          },
          {
            id: "pages",
            icon: FileText,
            path: `/app/${ctx.teamId}/${ctx.siteId}/pages`,
          },
          {
            id: "realtime",
            icon: Activity,
            path: `/app/${ctx.teamId}/${ctx.siteId}/realtime`,
          },
          {
            id: "events",
            icon: GanttChart,
            path: `/app/${ctx.teamId}/${ctx.siteId}/events`,
          },
          {
            id: "sessions",
            icon: Users,
            path: `/app/${ctx.teamId}/${ctx.siteId}/sessions`,
          },
          {
            id: "profiles",
            icon: UserCircle2,
            path: `/app/${ctx.teamId}/${ctx.siteId}/profiles`,
          },
        ]
      : [];

  const siteManageItems: SidebarLinkItem[] =
    ctx.teamId && ctx.siteId
      ? [
          {
            id: "precision",
            icon: BookOpen,
            path: `/app/${ctx.teamId}/${ctx.siteId}/precision`,
          },
          {
            id: "siteSettings",
            icon: Settings,
            path: `/app/${ctx.teamId}/${ctx.siteId}/settings`,
          },
        ]
      : [];

  const sidebarContent = (
    <aside className="flex h-full w-72 flex-col border-r border-border bg-card">
      <div className="flex h-16 items-center gap-2 border-b border-border px-4">
        <Flame className="h-6 w-6 text-primary shrink-0" />
        <span className="truncate text-base font-semibold">InsightFlare</span>
      </div>

      <div className="border-b border-border px-4 py-3">
        {teams.length > 0 ? (
          <Select value={currentTeamId} onValueChange={handleTeamSwitch}>
            <SelectTrigger className="h-9 w-full justify-start text-left">
              <SelectValue
                placeholder={locale === "zh" ? "选择团队" : "Select team"}
              />
            </SelectTrigger>
            <SelectContent>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="text-xs text-muted-foreground">
            {locale === "zh" ? "尚未创建团队" : "No team yet"}
          </div>
        )}
      </div>

      <div className="relative flex-1 overflow-hidden">
        <nav className="hide-scrollbar h-full space-y-4 overflow-y-auto px-4 py-4 pb-10">
          {ctx.mode === "site" ? (
            <>
              <Link
                href={`/${locale}/app/${ctx.teamId}`}
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-def-200 hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4 shrink-0" />
                {navLabels.backToTeam[locale]}
              </Link>

              <div className="space-y-1">
                <p className="px-3 text-xs font-medium text-muted-foreground">
                  {sectionLabels.analytics[locale] ?? "Analytics"}
                </p>
                {siteAnalyticsItems.map((item) => (
                  <SidebarNavLink
                    key={item.id}
                    locale={locale}
                    pathname={pathname}
                    item={item}
                    onNavigate={() => setMobileOpen(false)}
                  />
                ))}
              </div>

              <div className="space-y-1">
                <p className="px-3 text-xs font-medium text-muted-foreground">
                  {sectionLabels.manage[locale] ?? "Manage"}
                </p>
                {siteManageItems.map((item) => (
                  <SidebarNavLink
                    key={item.id}
                    locale={locale}
                    pathname={pathname}
                    item={item}
                    onNavigate={() => setMobileOpen(false)}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="space-y-1">
              <p className="px-3 text-xs font-medium text-muted-foreground">
                {sectionLabels.workspace[locale] ?? "Workspace"}
              </p>
              {teamNavItems.map((item) => (
                <SidebarNavLink
                  key={item.id}
                  locale={locale}
                  pathname={pathname}
                  item={item}
                  onNavigate={() => setMobileOpen(false)}
                />
              ))}
            </div>
          )}
        </nav>
        <div className="pointer-events-none absolute right-0 bottom-0 left-0 h-8 bg-gradient-to-t from-card to-card/0" />
      </div>

      <div className="border-t border-border bg-card">
        <div className="flex h-12 items-center border-b border-border px-4 text-xs text-muted-foreground">
          <Link
            href="https://github.com/RavelloH/InsightFlare"
            className="truncate hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Powered by InsightFlare
          </Link>
        </div>
        <div className="flex">
          <button
            type="button"
            onClick={switchLocale}
            className="flex h-12 flex-1 items-center justify-center border-r border-border text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <Globe2 className="mr-1.5 h-4 w-4" />
            {localeLabels[locale] ?? locale}
          </button>
          <Select
            value={themeMode}
            onValueChange={(value) => setTheme(value as ThemeMode)}
          >
            <SelectTrigger
              hideChevron
              aria-label={themeLabels[themeMode]}
              title={themeLabels[themeMode]}
              className="h-12 flex-1 justify-center rounded-none border-0 border-r border-border bg-transparent px-0 text-sm text-muted-foreground focus:ring-0 focus:ring-offset-0"
            >
              <div className="flex w-full items-center justify-center">
                <CurrentThemeIcon className="h-4 w-4" />
                <span className="sr-only">{themeLabels[themeMode]}</span>
              </div>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(themeLabels) as ThemeMode[]).map((mode) => {
                const Icon = themeIcons[mode];
                return (
                  <SelectItem key={mode} value={mode}>
                    <span className="flex items-center gap-2">
                      <Icon className="h-4 w-4" />
                      <span>{themeLabels[mode]}</span>
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
          <Link
            href={`/${locale}/app/settings`}
            onClick={() => setMobileOpen(false)}
            className="flex h-12 flex-1 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-def-200 text-xs font-semibold text-foreground">
              {userInitial}
            </span>
          </Link>
        </div>
      </div>
    </aside>
  );

  return (
    <>
      <div className="hidden lg:block">
        <div className="fixed inset-y-0 left-0 z-40">{sidebarContent}</div>
      </div>

      <div
        className={cn(
          "fixed inset-0 z-50 transition-opacity duration-200 lg:hidden",
          mobileOpen
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="absolute inset-0 bg-black/30 backdrop-blur-sm"
          aria-label="Close sidebar overlay"
        />
        <div
          className={cn(
            "absolute inset-y-0 left-0 transition-transform duration-200",
            mobileOpen ? "translate-x-0" : "-translate-x-72",
          )}
        >
          {sidebarContent}
        </div>
      </div>
    </>
  );
}
