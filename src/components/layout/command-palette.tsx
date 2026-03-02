"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { RiBarChartBoxLine as BarChart3, RiSettings3Line as Settings, RiTestTubeLine as Beaker, RiComputerLine as Monitor, RiMoonLine as Moon, RiSunLine as Sun, RiTranslate2 as Languages, RiFileTextLine as FileText, RiPulseLine as Activity, RiTimeLine as Clock, RiBarChartGroupedLine as GanttChart, RiGlobalLine as Globe2, RiAccountCircle2Line as UserCircle2 } from "@remixicon/react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import type { Dictionary } from "@/lib/i18n/dictionaries";

interface CommandPaletteProps {
  locale: string;
  dictionary: Dictionary;
}

function parseContext(pathname: string, locale: string) {
  const appPrefix = `/${locale}/app`;
  const rest = pathname.startsWith(appPrefix) ? pathname.slice(appPrefix.length) : "";
  const segments = rest.split("/").filter(Boolean);

  if (segments.length === 0 || segments[0] === "settings") {
    return { teamId: null, siteId: null };
  }

  const teamId = segments[0];
  if (segments.length === 1 || segments[1] === "settings" || segments[1] === "members") {
    return { teamId, siteId: null };
  }

  return { teamId, siteId: segments[1] };
}

export function CommandPalette({ locale, dictionary }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { setTheme } = useTheme();

  const t = (key: string) => dictionary[key] ?? key;
  const ctx = parseContext(pathname, locale);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  function runCommand(command: () => void) {
    setOpen(false);
    command();
  }

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder={t("command.placeholder")} />
      <CommandList>
        <CommandEmpty>{t("common.noData")}</CommandEmpty>
        <CommandGroup heading={t("command.navigation")}>
          {/* Site-level navigation (when in a site context) */}
          {ctx.teamId && ctx.siteId && (
            <>
              <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}/${ctx.siteId}`))}>
                <BarChart3 className="mr-2 h-4 w-4" />
                {t("command.goDashboard")}
              </CommandItem>
              <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}/${ctx.siteId}/pages`))}>
                <FileText className="mr-2 h-4 w-4" />
                {t("command.goPages")}
              </CommandItem>
              <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}/${ctx.siteId}/realtime`))}>
                <Activity className="mr-2 h-4 w-4" />
                {t("command.goRealtime")}
              </CommandItem>
              <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}/${ctx.siteId}/events`))}>
                <GanttChart className="mr-2 h-4 w-4" />
                {t("command.goEvents")}
              </CommandItem>
              <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}/${ctx.siteId}/sessions`))}>
                <Clock className="mr-2 h-4 w-4" />
                {t("command.goSessions")}
              </CommandItem>
              <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}/${ctx.siteId}/profiles`))}>
                <UserCircle2 className="mr-2 h-4 w-4" />
                {t("command.goProfiles")}
              </CommandItem>
              <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}/${ctx.siteId}/precision`))}>
                <Beaker className="mr-2 h-4 w-4" />
                {t("command.goPrecision")}
              </CommandItem>
              <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}/${ctx.siteId}/settings`))}>
                <Settings className="mr-2 h-4 w-4" />
                {t("command.goSiteSettings")}
              </CommandItem>
            </>
          )}
          {/* Team-level navigation */}
          {ctx.teamId && (
            <>
              <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}`))}>
                <Globe2 className="mr-2 h-4 w-4" />
                {t("command.goTeams")}
              </CommandItem>
              {!ctx.siteId && (
                <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/${ctx.teamId}/settings`))}>
                  <Settings className="mr-2 h-4 w-4" />
                  {t("command.goTeamSettings")}
                </CommandItem>
              )}
            </>
          )}
          {/* Always available */}
          <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/settings`))}>
            <Settings className="mr-2 h-4 w-4" />
            {t("command.goSettings")}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("command.actions")}>
          <CommandItem onSelect={() => runCommand(() => setTheme("system"))}>
            <Monitor className="mr-2 h-4 w-4" />
            {t("theme.system")}
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => setTheme("light"))}>
            <Sun className="mr-2 h-4 w-4" />
            {t("theme.light")}
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => setTheme("dark"))}>
            <Moon className="mr-2 h-4 w-4" />
            {t("theme.dark")}
          </CommandItem>
          <CommandItem
            onSelect={() =>
              runCommand(() => {
                const newLocale = locale === "en" ? "zh" : "en";
                const newPath = pathname.replace(new RegExp(`^/${locale}(?=/|$)`), `/${newLocale}`);
                const query = searchParams.toString();
                document.cookie = `if_locale=${newLocale};path=/;max-age=31536000`;
                router.replace(query ? `${newPath}?${query}` : newPath);
              })
            }
          >
            <Languages className="mr-2 h-4 w-4" />
            {t("command.switchLanguage")}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
