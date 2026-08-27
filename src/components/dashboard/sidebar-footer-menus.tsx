import { memo, useState } from "react";
import {
  RiCheckLine,
  RiComputerLine,
  RiGlobalLine,
  RiLogoutBoxRLine,
  RiMoonLine,
  RiNotification3Line,
  RiSettings3Line,
  RiSunLine,
} from "@remixicon/react";
import { toast } from "sonner";

import { useTheme } from "@/components/theme-provider";
import { AutoTransition } from "@/components/ui/auto-transition";
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
import { Spinner } from "@/components/ui/spinner";
import type { Locale } from "@/lib/i18n/config";
import type { AppMessages } from "@/lib/i18n/messages";
import { navigateWithTransition } from "@/lib/page-transition";
import Link from "@/lib/router";
import { useRouter } from "@/lib/router";
import { cn } from "@/lib/utils";

interface SidebarFooterMenusProps {
  locale: Locale;
  switchToEn: string;
  switchToZh: string;
  switchToJa: string;
  accountHref: string;
  notificationsHref: string;
  unreadAttentionCount?: number;
  user: {
    username: string;
    name: string;
    email: string;
    systemRole: "admin" | "user";
  };
  messages: AppMessages;
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
  "flex h-10 w-full items-center justify-center bg-transparent text-sidebar-foreground outline-hidden transition-[background-color,color,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none hover:bg-sidebar-accent/60 focus-visible:ring-1 focus-visible:ring-sidebar-ring";
const footerGridClass =
  "m-0 grid w-full grid-cols-3 p-0 transition-[grid-template-columns] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none group-data-[collapsible=icon]:grid-cols-1";

export const SidebarFooterMenus = memo(function SidebarFooterMenus({
  locale,
  switchToEn,
  switchToZh,
  switchToJa,
  accountHref,
  notificationsHref,
  unreadAttentionCount = 0,
  user,
  messages,
}: SidebarFooterMenusProps) {
  const router = useRouter();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [loggingOut, setLoggingOut] = useState(false);
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
  const roleLabel =
    user.systemRole === "admin" ? messages.common.admin : messages.common.user;
  const languageOptions: ReadonlyArray<{
    locale: Locale;
    href: string;
    label: string;
  }> = [
    { locale: "en", href: switchToEn, label: messages.actions.switchToEnglish },
    { locale: "zh", href: switchToZh, label: messages.actions.switchToChinese },
    {
      locale: "ja",
      href: switchToJa,
      label: messages.actions.switchToJapanese,
    },
  ];

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      const response = await fetch("/api/public/session", {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) throw new Error(messages.sidebarFooter.logoutFailed);
      toast.success(messages.sidebarFooter.logoutSuccess);
      navigateWithTransition(router, `/${locale}/login`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : messages.sidebarFooter.logoutFailed;
      toast.error(message || messages.sidebarFooter.logoutFailed);
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className={footerGridClass}>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            triggerBaseClass,
            "border-r border-sidebar-border group-data-[collapsible=icon]:border-r-0 group-data-[collapsible=icon]:border-b",
          )}
          aria-label={messages.common.theme}
        >
          <ThemeIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={8} className="!w-44 !min-w-44">
          <DropdownMenuLabel>{messages.common.theme}</DropdownMenuLabel>
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
              <span>{messages.common.system}</span>
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
          aria-label={messages.common.language}
        >
          <RiGlobalLine className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent sideOffset={8} className="!w-44 !min-w-44">
          <DropdownMenuLabel>{messages.common.language}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {languageOptions.map((item) => (
            <DropdownMenuItem key={item.locale} asChild>
              <Link href={item.href}>
                <span className="inline-flex w-4 justify-center">
                  {locale === item.locale ? (
                    <RiCheckLine className="size-4" />
                  ) : null}
                </span>
                <span>{item.label}</span>
              </Link>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(triggerBaseClass, "relative")}
          aria-label={messages.common.account}
        >
          <span className="relative inline-flex size-6 items-center justify-center">
            <span className="inline-flex size-6 items-center justify-center rounded-full border border-sidebar-border bg-transparent text-xs">
              {initial}
            </span>
            {unreadAttentionCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-destructive ring-2 ring-sidebar" />
            ) : null}
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
              {messages.common.role}: {roleLabel}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href={notificationsHref}>
              <RiNotification3Line />
              <span>{messages.notificationCenter.title}</span>
              {unreadAttentionCount > 0 ? (
                <span className="ml-auto font-mono text-xs text-destructive tabular-nums pr-2">
                  {unreadAttentionCount > 99 ? "99+" : unreadAttentionCount}
                </span>
              ) : null}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={accountHref}>
              <RiSettings3Line />
              <span>{messages.accountSettings.title}</span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={loggingOut}
            onSelect={(event) => {
              event.preventDefault();
              void handleLogout();
            }}
          >
            <RiLogoutBoxRLine />
            <AutoTransition className="inline-flex items-center gap-2">
              {loggingOut ? (
                <span
                  key="logging-out"
                  className="inline-flex items-center gap-2"
                >
                  <Spinner className="size-4" />
                  {messages.sidebarFooter.loggingOut}
                </span>
              ) : (
                <span key="logout">{messages.actions.logout}</span>
              )}
            </AutoTransition>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
});
