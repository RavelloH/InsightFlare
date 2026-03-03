"use client";

import Link from "next/link";
import {
  RiCheckLine,
  RiComputerLine,
  RiGlobalLine,
  RiLogoutBoxRLine,
  RiMoonLine,
  RiSunLine,
} from "@remixicon/react";
import { useTheme } from "next-themes";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface SidebarFooterMenusProps {
  locale: Locale;
  switchToEn: string;
  switchToZh: string;
  user: {
    username: string;
    name: string;
    email: string;
    systemRole: "admin" | "user";
  };
  messages: AppMessages;
}

function getText(locale: Locale) {
  if (locale === "zh") {
    return {
      theme: "主题",
      language: "语言",
      account: "账户",
      system: "系统",
      role: "角色",
      admin: "管理员",
      member: "成员",
    };
  }

  return {
    theme: "Theme",
    language: "Language",
    account: "Account",
    system: "System",
    role: "Role",
    admin: "Admin",
    member: "Member",
  };
}

function pickThemeIcon(theme: string) {
  if (theme === "dark") return RiMoonLine;
  if (theme === "light") return RiSunLine;
  return RiComputerLine;
}

function userInitial(name: string, username: string): string {
  const raw = String(name || username || "").trim();
  if (!raw) return "?";
  const first = Array.from(raw)[0];
  return first ? first.toUpperCase() : "?";
}

const triggerBaseClass =
  "flex h-10 w-full items-center justify-center bg-transparent text-sidebar-foreground outline-hidden transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-1 focus-visible:ring-sidebar-ring";

export function SidebarFooterMenus({
  locale,
  switchToEn,
  switchToZh,
  user,
  messages,
}: SidebarFooterMenusProps) {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const text = getText(locale);
  const themeValue =
    theme === "light" || theme === "dark" || theme === "system"
      ? theme
      : "system";
  const currentTheme = resolvedTheme === "dark" ? "dark" : "light";
  const ThemeIcon = pickThemeIcon(
    themeValue === "system" ? currentTheme : themeValue,
  );
  const initial = userInitial(user.name, user.username);
  const displayName = String(user.name || user.username);
  const roleLabel = user.systemRole === "admin" ? text.admin : text.member;

  return (
    <div className="m-0 grid w-full grid-cols-3 p-0 group-data-[collapsible=icon]:grid-cols-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            triggerBaseClass,
            "border-r border-sidebar-border group-data-[collapsible=icon]:border-r-0 group-data-[collapsible=icon]:border-b",
          )}
          aria-label={text.theme}
        >
          <ThemeIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={8} className="!w-44 !min-w-44">
          <DropdownMenuLabel>{text.theme}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={themeValue}
            onValueChange={(nextTheme) => {
              if (
                nextTheme === "light" ||
                nextTheme === "dark" ||
                nextTheme === "system"
              ) {
                setTheme(nextTheme);
              }
            }}
          >
            <DropdownMenuRadioItem value="light">
              <RiSunLine />
              <span>{messages.actions.switchToLight}</span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <RiMoonLine />
              <span>{messages.actions.switchToDark}</span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <RiComputerLine />
              <span>{text.system}</span>
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            triggerBaseClass,
            "border-r border-sidebar-border group-data-[collapsible=icon]:border-r-0 group-data-[collapsible=icon]:border-b",
          )}
          aria-label={text.language}
        >
          <RiGlobalLine className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={8} className="!w-44 !min-w-44">
          <DropdownMenuLabel>{text.language}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={switchToEn}>
              <span className="inline-flex w-4 justify-center">
                {locale === "en" ? <RiCheckLine className="size-4" /> : null}
              </span>
              <span>{messages.actions.switchToEnglish}</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={switchToZh}>
              <span className="inline-flex w-4 justify-center">
                {locale === "zh" ? <RiCheckLine className="size-4" /> : null}
              </span>
              <span>{messages.actions.switchToChinese}</span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          className={triggerBaseClass}
          aria-label={text.account}
        >
          <span className="inline-flex size-6 items-center justify-center rounded-full border border-sidebar-border bg-transparent text-xs">
            {initial}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={8} className="!w-64 !min-w-64">
          <DropdownMenuLabel className="space-y-1">
            <div className="text-sm font-semibold text-foreground">
              {displayName}
            </div>
            <div className="text-xs text-muted-foreground">
              @{user.username}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="space-y-1 font-normal">
            <div className="text-xs text-muted-foreground">{user.email}</div>
            <div className="text-xs text-muted-foreground">
              {text.role}: {roleLabel}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <form action="/api/auth/logout" method="post">
            <DropdownMenuItem asChild variant="destructive">
              <button type="submit" className="w-full cursor-pointer">
                <RiLogoutBoxRLine />
                <span>{messages.actions.logout}</span>
              </button>
            </DropdownMenuItem>
          </form>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
