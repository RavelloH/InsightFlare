"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  BarChart3,
  Users,
  Settings,
  Beaker,
  Moon,
  Sun,
  Languages,
  LogOut,
} from "lucide-react";
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

export function CommandPalette({ locale, dictionary }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { setTheme, theme } = useTheme();

  const t = (key: string) => dictionary[key] ?? key;

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
          <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app`))}>
            <BarChart3 className="mr-2 h-4 w-4" />
            {t("command.goDashboard")}
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/teams`))}>
            <Users className="mr-2 h-4 w-4" />
            {t("command.goTeams")}
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/settings`))}>
            <Settings className="mr-2 h-4 w-4" />
            {t("command.goSettings")}
          </CommandItem>
          <CommandItem onSelect={() => runCommand(() => router.push(`/${locale}/app/precision`))}>
            <Beaker className="mr-2 h-4 w-4" />
            {t("command.goPrecision")}
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("command.actions")}>
          <CommandItem onSelect={() => runCommand(() => setTheme(theme === "dark" ? "light" : "dark"))}>
            {theme === "dark" ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
            {t("command.toggleTheme")}
          </CommandItem>
          <CommandItem
            onSelect={() =>
              runCommand(() => {
                const newLocale = locale === "en" ? "zh" : "en";
                document.cookie = `if_locale=${newLocale};path=/;max-age=31536000`;
                window.location.href = window.location.pathname.replace(`/${locale}`, `/${newLocale}`);
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
